/**
 * Generates an app's icons from its Redstart mascot drawing (see mascot.mjs).
 *
 *   node make-icon.mjs                   Nest's icons → redstart-nest/build/
 *   node make-icon.mjs --variant twig    Twig's icons → redstart-twig/windows/build/
 *
 * Output: icon.ico (Windows), icon.icns (macOS) and icon.png (1024px), which
 * the app's Tauri config embeds at compile time. build/ is gitignored.
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { loadMascot, rasterize, smallIcon, encodePng } from './mascot.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(__dirname, '..', '..')

const flag = process.argv.indexOf('--variant')
const variant = flag === -1 ? 'nest' : process.argv[flag + 1]
const OUT_DIRS = {
  nest: path.join(repo, 'redstart-nest', 'build'),
  twig: path.join(repo, 'redstart-twig', 'windows', 'build'),
}
if (!OUT_DIRS[variant]) {
  console.error(`make-icon: unknown --variant "${variant}" (expected nest or twig)`)
  process.exit(1)
}

const grid = loadMascot(variant)
const pngCache = new Map()
const makePng = size => {
  if (!pngCache.has(size)) pngCache.set(size, encodePng(rasterize(grid, size), size))
  return pngCache.get(size)
}

const outDir = OUT_DIRS[variant]
fs.mkdirSync(outDir, { recursive: true })

// ── ICO assembler (PNG-in-ICO, Windows Vista+) ───────────────────────────────
// Format: 6-byte ICONDIR header, N×16-byte ICONDIRENTRY, then raw PNG blobs.

//
// Windows picks the frame nearest the size it draws at rather than shrinking a
// large one: the taskbar draws at 24px (100% scaling), the window icon Tauri
// loads from this resource is SM_CXICON (32px at 100%, 40 at 125%, 48 at
// 150%), and the title bar uses 16/20. So those sizes all get a frame of their
// own, and up to 48px each is the small-icon rendering (smallIcon in
// mascot.mjs: cropped, crisp-edged, the black bird ringed so it reads on a
// dark taskbar). 64px and up are Explorer's larger views, where the full
// drawing reads as it is.
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const SMALL_MAX = 48
const pngs = SIZES.map(size => (size <= SMALL_MAX ? encodePng(smallIcon(grid, size), size) : makePng(size)))

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)           // reserved
header.writeUInt16LE(1, 2)           // type: 1 = icon
header.writeUInt16LE(SIZES.length, 4)

let offset = 6 + SIZES.length * 16
const entries = SIZES.map((size, i) => {
  const e = Buffer.alloc(16)
  e.writeUInt8(size === 256 ? 0 : size, 0) // 0 encodes 256 in ICO spec
  e.writeUInt8(size === 256 ? 0 : size, 1)
  e.writeUInt8(0, 2)      // color count (0 = truecolor)
  e.writeUInt8(0, 3)      // reserved
  e.writeUInt16LE(1, 4)   // planes
  e.writeUInt16LE(32, 6)  // bits per pixel
  e.writeUInt32LE(pngs[i].length, 8)
  e.writeUInt32LE(offset, 12)
  offset += pngs[i].length
  return e
})

const ico = Buffer.concat([header, ...entries, ...pngs])
const icoPath = path.join(outDir, 'icon.ico')
fs.writeFileSync(icoPath, ico)
console.log(`✓ icon.ico → ${icoPath}  (${variant}; ${SIZES.join(', ')}px, ${(ico.length / 1024).toFixed(1)} KB)`)

// 1024 is an exact multiple of the 128px drawing, so every source pixel stays
// a crisp square rather than being resampled.
const pngPath = path.join(outDir, 'icon.png')
fs.writeFileSync(pngPath, makePng(1024))
console.log(`✓ icon.png → ${pngPath}  (1024px)`)

// ── ICNS assembler (PNG-in-ICNS, macOS 10.7+) ────────────────────────────────
// Given only icon.png, tauri-bundler builds an .icns itself and maps each PNG
// to an icns type by pixel size AND density, taking density from an "@2x" file
// name. A plain 1024px PNG is 512@2x in icns terms, so it matched no type and
// every macOS bundle failed with "No matching IconType" (the alpha.7 and
// alpha.8 releases). Handed a real .icns, the bundler copies it as-is.
//
// Format: 'icns' + total length (big-endian), then per entry a 4-char type,
// its length including the 8-byte header, and the PNG bytes.
const ICNS_TYPES = [
  ['icp4', 16], ['icp5', 32], ['ic11', 32],   // 16, 32, 16@2x
  ['icp6', 64], ['ic12', 64],                 // 64, 32@2x
  ['ic07', 128], ['ic08', 256], ['ic13', 256], // 128, 256, 128@2x
  ['ic09', 512], ['ic14', 512],                // 512, 256@2x
  ['ic10', 1024],                              // 512@2x
]
const icnsBody = Buffer.concat(ICNS_TYPES.map(([type, size]) => {
  const png = makePng(size)
  const head = Buffer.alloc(8)
  head.write(type, 0, 'ascii')
  head.writeUInt32BE(png.length + 8, 4)
  return Buffer.concat([head, png])
}))
const icnsHead = Buffer.alloc(8)
icnsHead.write('icns', 0, 'ascii')
icnsHead.writeUInt32BE(icnsBody.length + 8, 4)
const icnsPath = path.join(outDir, 'icon.icns')
fs.writeFileSync(icnsPath, Buffer.concat([icnsHead, icnsBody]))
console.log(`✓ icon.icns → ${icnsPath}  (${ICNS_TYPES.map(([t, s]) => `${t}:${s}`).join(', ')})`)
