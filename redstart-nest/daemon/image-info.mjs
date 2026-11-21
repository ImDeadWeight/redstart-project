'use strict'

// =============================================================================
// Redstart Nest — what an image file is, from its bytes
// =============================================================================
// The type by magic bytes (never by extension alone), and the pixel size from
// the header, for the four formats Redstart shows a model: PNG, JPEG, WebP,
// GIF. No decoding, no dependency — headers only. Shared by view_image
// (documents-tool.mjs) and image generation, whose output is checked to be the
// PNG it claims before it is linked.
//
// Same rule as Dungeon Books' image_file.rs: a name says what a file should
// be, its first bytes say what it is, and both must agree.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'

export const IMAGE_EXTENSIONS = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** The image type the bytes start like, or null. */
export function sniffImageType(buf) {
  if (!buf || buf.length < 12) return null
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 8) === 'PNG\r\n\x1a\n') return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.toString('latin1', 0, 6) === 'GIF87a' || buf.toString('latin1', 0, 6) === 'GIF89a') return 'image/gif'
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

function jpegSize(buf) {
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue }
    const marker = buf[i + 1]
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue }
    const len = buf.readUInt16BE(i + 2)
    // SOF0..SOF15, minus DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
    }
    if (len < 2) return null
    i += 2 + len
  }
  return null
}

function webpSize(buf) {
  const chunk = buf.toString('latin1', 12, 16)
  if (chunk === 'VP8 ' && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
  if (chunk === 'VP8L' && buf.length >= 25) {
    const b = buf.readUInt32LE(21)
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X' && buf.length >= 30) {
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 }
  }
  return null
}

/** Pixel size from the header, or null when the header does not say. */
export function imageSize(buf, type = sniffImageType(buf)) {
  try {
    if (type === 'image/png' && buf.length >= 24) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    if (type === 'image/gif' && buf.length >= 10) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
    if (type === 'image/jpeg') return jpegSize(buf)
    if (type === 'image/webp') return webpSize(buf)
  } catch { /* a truncated header has no size */ }
  return null
}

// A JPEG's SOF can sit after a large EXIF block; 256 KB covers real cameras.
const HEADER_BYTES = 256 * 1024

/**
 * What the file at `filePath` is, read from its first bytes. `ok` only when
 * the extension is an image extension AND the bytes agree with it.
 *
 * @returns {{ ok: true, mimeType: string, bytes: number, width: number|null, height: number|null }
 *         | { ok: false, reason: string }}
 */
export function inspectImageFile(filePath) {
  const expected = IMAGE_EXTENSIONS[path.extname(filePath).toLowerCase()]
  if (!expected) return { ok: false, reason: `Only ${Object.keys(IMAGE_EXTENSIONS).join(', ')} files are images here.` }
  let fd
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return { ok: false, reason: 'Not a file.' }
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(Math.min(HEADER_BYTES, stat.size))
    fs.readSync(fd, buf, 0, buf.length, 0)
    const actual = sniffImageType(buf)
    if (!actual) return { ok: false, reason: 'The file is not a PNG, JPEG, WebP or GIF image, whatever its name says.' }
    // .jpg holding a PNG is still an image, and still safe to show; what is
    // refused is a name that hides a non-image.
    const size = imageSize(buf, actual)
    return { ok: true, mimeType: actual, bytes: stat.size, width: size?.width ?? null, height: size?.height ?? null }
  } catch (err) {
    return { ok: false, reason: err.code === 'ENOENT' ? 'File not found.' : err.message }
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}
