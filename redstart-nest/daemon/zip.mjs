'use strict'

// =============================================================================
// Redstart Nest — a small .zip reader and writer (master plan Phase 5)
// =============================================================================
// Skills import and export as a .zip of their folder. Node has DEFLATE
// (zlib) but no zip container, and the format is small enough that a
// dependency for it is more surface than code: this writes and reads
// "store" (0) and "deflate" (8) entries, with the central directory, and
// nothing else.
//
// READING IS THE ATTACK SURFACE. An import is a file from anywhere, so:
//   - sizes come from the central directory and are checked against the
//     caller's limits BEFORE anything is inflated, and inflation itself is
//     capped at the declared size (a lying header cannot bomb past it);
//   - encrypted entries, ZIP64, multi-disk archives and unknown methods are
//     refused, not skipped;
//   - entry names are returned as written; the caller decides which paths it
//     accepts (skills-storage.mjs validSkillFilePath). Directory entries are
//     dropped.
// =============================================================================

import * as zlib from 'zlib'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/** @param {Buffer} buf */
export function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// A fixed timestamp (1980-01-01, the format's epoch): an export of the same
// skill is the same bytes, and no clock leaks into a shared file.
const DOS_TIME = 0
const DOS_DATE = (0 << 9) | (1 << 5) | 1

/**
 * @param {Record<string, Buffer | string>} files path → content, forward slashes
 * @returns {Buffer}
 */
export function createZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content)
    const nameBuf = Buffer.from(name, 'utf8')
    const deflated = zlib.deflateRawSync(data)
    const useDeflate = deflated.length < data.length
    const body = useDeflate ? deflated : data
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // flags: UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBuf, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(useDeflate ? 8 : 0, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    // extra, comment, disk, internal attrs, external attrs: 0
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)

    offset += local.length + nameBuf.length + body.length
  }
  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  const count = Object.keys(files).length
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, end])
}

/** Does this look like a zip (a local file header first)? */
export function isZip(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50
}

/**
 * Read a zip's files.
 *
 * @param {Buffer} buf
 * @param {{ maxEntries: number, maxEntryBytes: number, maxTotalBytes: number }} limits
 * @returns {{ ok: true, files: Record<string, Buffer> } | { ok: false, error: string }}
 */
export function readZip(buf, { maxEntries, maxEntryBytes, maxTotalBytes }) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) return { ok: false, error: 'not a zip file' }
  // The end-of-central-directory record: within the last 64 KB + 22 bytes.
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return { ok: false, error: 'not a zip file (no central directory)' }
  const disk = buf.readUInt16LE(eocd + 4)
  const cdDisk = buf.readUInt16LE(eocd + 6)
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (disk !== 0 || cdDisk !== 0) return { ok: false, error: 'multi-part zip files are not read' }
  if (count === 0xffff || cdOffset === 0xffffffff) return { ok: false, error: 'ZIP64 files are not read' }
  if (cdOffset + cdSize > eocd) return { ok: false, error: 'a damaged zip file' }

  /** @type {{ name: string, method: number, flags: number, crc: number, csize: number, usize: number, localOffset: number }[]} */
  const entries = []
  let p = cdOffset
  let declaredTotal = 0
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) return { ok: false, error: 'a damaged zip file (central directory)' }
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const csize = buf.readUInt32LE(p + 20)
    const usize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    p += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue // a directory entry
    if (flags & 0x1) return { ok: false, error: `${name} is encrypted` }
    if (method !== 0 && method !== 8) return { ok: false, error: `${name} uses a compression method this cannot read` }
    if (csize === 0xffffffff || usize === 0xffffffff) return { ok: false, error: 'ZIP64 files are not read' }
    if (usize > maxEntryBytes) return { ok: false, error: `${name} is over ${Math.round(maxEntryBytes / 1024)} KB` }
    declaredTotal += usize
    if (declaredTotal > maxTotalBytes) return { ok: false, error: `the files are over ${Math.round(maxTotalBytes / 1024)} KB together` }
    entries.push({ name, method, flags, crc, csize, usize, localOffset })
    if (entries.length > maxEntries) return { ok: false, error: `more than ${maxEntries} files` }
  }

  /** @type {Record<string, Buffer>} */
  const files = {}
  for (const e of entries) {
    const lo = e.localOffset
    if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) return { ok: false, error: `a damaged zip file (${e.name})` }
    const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28)
    if (start + e.csize > buf.length) return { ok: false, error: `a damaged zip file (${e.name})` }
    const raw = buf.subarray(start, start + e.csize)
    let data
    try {
      data = e.method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, e.usize) })
    } catch {
      return { ok: false, error: `${e.name} could not be decompressed (damaged, or larger than it says)` }
    }
    if (data.length !== e.usize || crc32(data) !== e.crc) return { ok: false, error: `${e.name} is damaged (size or checksum)` }
    if (Object.prototype.hasOwnProperty.call(files, e.name)) return { ok: false, error: `${e.name} is in the zip twice` }
    files[e.name] = data
  }
  return { ok: true, files }
}
