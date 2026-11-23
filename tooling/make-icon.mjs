/**
 * Generates an app's icons from its Redstart mascot drawing (see mascot.mjs).
 *
 *   node tooling/make-icon.mjs                   Nest's icons → redstart-nest/build/
 *   node tooling/make-icon.mjs --variant twig    Twig's icons → redstart-twig/desktop/build/
 *
 * Output: icon.ico (Windows), icon.icns (macOS) and icon.png (1024px), which
 * the app's Tauri config embeds at compile time. build/ is gitignored. The
 * .icns frames sit on a dark rounded-square plate (see THE PLATE below); the
 * .ico and .png are the bare bird.
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { loadMascot, rasterize, contentSquare, encodePng, blit } from './mascot.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(__dirname, '..')

const flag = process.argv.indexOf('--variant')
const variant = flag === -1 ? 'nest' : process.argv[flag + 1]
const OUT_DIRS = {
  nest: path.join(repo, 'redstart-nest', 'build'),
  twig: path.join(repo, 'redstart-twig', 'desktop', 'build'),
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
// own. Up to 48px each frame is cropped to the drawing so the bird fills it,
// and keeps its anti-aliased edges. An earlier version snapped the edges to
// solid and ringed the black bird in light grey for dark taskbars; on a real
// taskbar the ring read as a white sticker outline and the snapped edges as
// low resolution, so both went. The orange, beak and nest carry the bird on a
// dark taskbar without it. 64px and up are Explorer's larger views, where the
// full drawing reads as it is. 256 is the largest frame an ICO holds; a
// bigger source would not change the taskbar, which only ever draws 24-48.
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const SMALL_MAX = 48
const smallCrop = contentSquare(grid)
const pngs = SIZES.map(size => (size <= SMALL_MAX
  ? encodePng(rasterize(grid, size, { pad: 1, crop: smallCrop }), size)
  : makePng(size)))

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
//
// THE PLATE. macOS draws an app icon as is, so a transparent bird sat on
// nothing; and since macOS 26 an icon that does not fill Apple's rounded
// square is put on a light plate of the system's choosing, which is the white
// square the first Mac test showed. So every macOS frame carries its own
// plate on Apple's icon grid (an 824px rounded square, radius ~185, centred on
// a 1024 canvas, transparent outside it), a stone-600 → stone-800 gradient
// from the mascot's own palette, with the bird at about two thirds of the
// canvas. Dark enough to read as "dark gray" on a light Dock, light enough
// that the black bird (#1c1917) does not vanish into it. Windows keeps the
// bare bird: its taskbar and Explorer draw icons without a plate.
const PLATE_TOP = '#57534e'
const PLATE_BOTTOM = '#292524'
const BIRD_SCALE = 0.66

const hexRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))

function plate(size) {
  const buf = Buffer.alloc(size * size * 4)
  const inset = size * 100 / 1024, side = size * 824 / 1024, rad = size * 185.4 / 1024
  const top = hexRgb(PLATE_TOP), bottom = hexRgb(PLATE_BOTTOM)
  const SS = 4 // coverage samples per axis, for an anti-aliased edge
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let cov = 0
    for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) {
      const px = x + (i + 0.5) / SS - inset, py = y + (j + 0.5) / SS - inset
      if (px < 0 || py < 0 || px > side || py > side) continue
      const cx = Math.min(Math.max(px, rad), side - rad), cy = Math.min(Math.max(py, rad), side - rad)
      if ((px - cx) ** 2 + (py - cy) ** 2 <= rad * rad) cov++
    }
    if (!cov) continue
    const f = Math.min(Math.max((y - inset) / side, 0), 1)
    buf.set([...top.map((v, k) => Math.round(v + (bottom[k] - v) * f)), Math.round(cov / (SS * SS) * 255)], (y * size + x) * 4)
  }
  return buf
}

// Source-over of the bird (size×size RGBA) onto the plate, in place.
function over(dst, src) {
  for (let i = 0; i < dst.length; i += 4) {
    const a = src[i + 3] / 255
    if (!a) continue
    const da = dst[i + 3] / 255, oa = a + da * (1 - a)
    for (let k = 0; k < 3; k++) dst[i + k] = Math.round((src[i + k] * a + dst[i + k] * da * (1 - a)) / oa)
    dst[i + 3] = Math.round(oa * 255)
  }
  return dst
}

const macCache = new Map()
const makeMacPng = size => {
  if (!macCache.has(size)) {
    const inner = Math.round(size * BIRD_SCALE)
    const bird = Buffer.alloc(size * size * 4)
    const off = Math.round((size - inner) / 2)
    blit(bird, size, rasterize(grid, inner, { crop: smallCrop }), inner, inner, off, off)
    macCache.set(size, encodePng(over(plate(size), bird), size))
  }
  return macCache.get(size)
}

const ICNS_TYPES = [
  ['icp4', 16], ['icp5', 32], ['ic11', 32],   // 16, 32, 16@2x
  ['icp6', 64], ['ic12', 64],                 // 64, 32@2x
  ['ic07', 128], ['ic08', 256], ['ic13', 256], // 128, 256, 128@2x
  ['ic09', 512], ['ic14', 512],                // 512, 256@2x
  ['ic10', 1024],                              // 512@2x
]
const icnsBody = Buffer.concat(ICNS_TYPES.map(([type, size]) => {
  const png = makeMacPng(size)
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
