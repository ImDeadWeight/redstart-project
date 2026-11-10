/**
 * The Redstart mascot: two 128×128 pixel-art drawings and the code that turns
 * them into icons. No external dependencies, only Node.js built-ins.
 *
 *   nest  the bird settled in its nest (Redstart Nest)
 *   twig  the bird perched on a twig (Redstart Twig)
 *
 * The drawings live in ../assets/mascot/redstart-<variant>.txt: 128 lines of
 * 128 characters, one character per pixel, keyed by PALETTE below ('_' is
 * transparent). They are the source of truth: edit a drawing there, then run
 * make-icon.mjs (app icons, generated at build time) and
 * make-mascot-assets.mjs (the SVGs and Android assets, which are committed).
 */

import * as fs from 'fs'
import * as path from 'path'
import * as zlib from 'zlib'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const SIZE = 128
export const VARIANTS = ['nest', 'twig']

// The original icon's palette (stone black, warm white, orange, rust, amber)
// plus the in-between tones the larger drawing shades with.
export const PALETTE = {
  K: '#1c1917', // feather black, outlines
  k: '#44403c', // rim light on black
  g: '#57534e', // eye ring, feather lines, legs
  W: '#fafaf9', // belly, eye glints
  w: '#d6d3d1', // belly shadow
  O: '#f97316', // flank, wing bar, tail
  o: '#fdba74', // orange highlight
  R: '#c2410c', // orange shadow
  Y: '#d97706', // beak
  y: '#f59e0b', // beak highlight
  n: '#4a3426', // nest twigs
  m: '#654a36', // nest twigs, lighter strands
  d: '#34241a', // nest twigs, shadow
  e: '#1e150f', // inside of the nest
  h: '#8f765e', // weathered rim highlight
}

const hexRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))

export function loadMascot(variant) {
  if (!VARIANTS.includes(variant)) throw new Error(`unknown mascot variant "${variant}" (expected ${VARIANTS.join(' or ')})`)
  const file = path.join(__dirname, '..', 'assets', 'mascot', `redstart-${variant}.txt`)
  const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(r => r.length)
  if (rows.length !== SIZE || rows.some(r => r.length !== SIZE)) throw new Error(`${file} must be ${SIZE} rows of ${SIZE} characters`)
  for (const r of rows) for (const ch of r) if (ch !== '_' && !PALETTE[ch]) throw new Error(`${file}: "${ch}" is not in the palette`)
  return rows
}

/** Adds a 1px ring of palette colour `ch` around the drawing, for dark backgrounds. */
export function withOutline(grid, ch) {
  const out = grid.map(r => [...r])
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    if (grid[y][x] !== '_') continue
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if ((grid[y + dy]?.[x + dx] ?? '_') !== '_') { out[y][x] = ch; break }
    }
  }
  return out.map(r => r.join(''))
}

/**
 * RGBA pixels of the drawing at `size`×`size`, inset by `pad` pixels per side.
 * When the drawing scales by a whole number every source pixel stays a crisp
 * square; otherwise each output pixel averages the source pixels it covers
 * (premultiplied, so transparent edges don't darken).
 */
export function rasterize(grid, size, { pad = 0, palette = PALETTE, crop = { x: 0, y: 0, side: SIZE } } = {}) {
  const rgb = Object.fromEntries(Object.entries(palette).map(([k, v]) => [k, hexRgb(v)]))
  const inner = size - pad * 2
  const out = Buffer.alloc(size * size * 4)
  // `crop` is the square of the drawing to show; cells outside it read as transparent.
  const cell = (sy, sx) => grid[crop.y + sy]?.[crop.x + sx] ?? '_'
  const whole = inner % crop.side === 0
  const SS = 8 // samples per axis when averaging
  for (let y = 0; y < inner; y++) for (let x = 0; x < inner; x++) {
    let r = 0, g = 0, b = 0, a = 0
    if (whole) {
      const c = rgb[cell(Math.floor(y * crop.side / inner), Math.floor(x * crop.side / inner))]
      if (c) { [r, g, b] = c; a = 1 }
    } else {
      for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) {
        const c = rgb[cell(Math.floor((y + (j + 0.5) / SS) * crop.side / inner), Math.floor((x + (i + 0.5) / SS) * crop.side / inner))]
        if (c) { r += c[0]; g += c[1]; b += c[2]; a++ }
      }
      if (a) { r /= a; g /= a; b /= a; a /= SS * SS }
    }
    out.set([Math.round(r), Math.round(g), Math.round(b), Math.round(a * 255)], ((y + pad) * size + x + pad) * 4)
  }
  return out
}

/** The smallest square around the drawing's pixels, plus `margin`, centred on them. */
export function contentSquare(grid, margin = 0) {
  let x0 = SIZE, y0 = SIZE, x1 = -1, y1 = -1
  grid.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === '_') return
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
  }))
  const side = Math.max(x1 - x0, y1 - y0) + 1 + margin * 2
  return {
    x: Math.round((x0 + x1 + 1) / 2 - side / 2),
    y: Math.round((y0 + y1 + 1) / 2 - side / 2),
    side,
  }
}

/**
 * A small app-icon frame (taskbar, title bar, Alt+Tab) at `size` px. The
 * full-detail rasterize() blurs at these sizes and the black bird all but
 * vanishes against a dark taskbar, so three things change:
 *  - the drawing is cropped to its own pixels, so it fills the frame;
 *  - the silhouette is snapped to fully opaque or fully clear, so its edge is
 *    a crisp pixel edge rather than a grey halo;
 *  - a 1px ring of `outline` (output pixels, not drawing pixels, so it survives
 *    the shrink) is drawn round the BLACK parts only (the `ringed` palette
 *    characters: the bird's feathers, and Twig's branch, drawn in the same
 *    black). Those are what disappear on a dark taskbar. The brown nest stays
 *    visible on its own; ringing it too made the icon look like a sticker, and
 *    the black strokes along the nest's base left broken dashes of ring there.
 *    So no ring pixel is placed next to nest brown (the `unringed` characters).
 *    On a light taskbar the pale ring is all but invisible, which is the intent.
 * One pixel of the frame is kept clear on every side for that ring.
 */
export function smallIcon(grid, size, { outline = PALETTE.w, ringed = 'Kk', unringed = 'nmdeh', palette = PALETTE } = {}) {
  const crop = contentSquare(grid)
  const px = rasterize(grid, size, { pad: 1, palette, crop })
  // How much of each output pixel is a given set of colours: the same sampling
  // with every other colour transparent.
  const coverage = chars => rasterize(grid, size, { pad: 1, crop, palette: Object.fromEntries([...chars].map(ch => [ch, '#000000'])) })
  const black = coverage(ringed)
  const brown = coverage(unringed)
  // 0 = clear, 1 = opaque, 2 = mostly black (gets the ring), 3 = mostly brown (keeps it away).
  const kind = new Uint8Array(size * size)
  for (let i = 0; i < size * size; i++) {
    const a = px[i * 4 + 3]
    if (a >= 128) {
      // Undo the coverage blend on edge pixels: colour comes from the drawing
      // pixels the sample did hit, alpha becomes solid.
      px[i * 4 + 3] = 255
      kind[i] = black[i * 4 + 3] * 2 >= a ? 2 : brown[i * 4 + 3] * 2 >= a ? 3 : 1
    } else {
      px.fill(0, i * 4, i * 4 + 4)
    }
  }
  const at = (x, y) => (x >= 0 && y >= 0 && x < size && y < size ? kind[y * size + x] : 0)
  const [r, g, b] = hexRgb(outline)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (at(x, y)) continue
    const nextToBlack = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => at(x + dx, y + dy) === 2)
    let nextToBrown = false
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (at(x + dx, y + dy) === 3) nextToBrown = true
    if (nextToBlack && !nextToBrown) px.set([r, g, b, 255], (y * size + x) * 4)
  }
  return px
}

/** Paints `rgba` (w×h) over a solid background colour into a w×h RGBA buffer. */
export function flatten(rgba, background) {
  const [br, bg, bb] = hexRgb(background)
  const out = Buffer.alloc(rgba.length)
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] / 255
    out[i] = Math.round(rgba[i] * a + br * (1 - a))
    out[i + 1] = Math.round(rgba[i + 1] * a + bg * (1 - a))
    out[i + 2] = Math.round(rgba[i + 2] * a + bb * (1 - a))
    out[i + 3] = 255
  }
  return out
}

/** Copies `src` (sw×sh RGBA) into `dst` (dw wide) at (dx, dy). */
export function blit(dst, dw, src, sw, sh, dx, dy) {
  for (let y = 0; y < sh; y++) src.copy(dst, ((dy + y) * dw + dx) * 4, y * sw * 4, (y + 1) * sw * 4)
}

const CRC = new Uint32Array(256).map((_, i) => {
  let c = i
  for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
  return c
})
function crc32(buf) {
  let v = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) v = CRC[(v ^ buf[i]) & 0xFF] ^ (v >>> 8)
  return (v ^ 0xFFFFFFFF) >>> 0
}
function chunk(type, data) {
  const tb = Buffer.from(type, 'ascii')
  const lb = Buffer.alloc(4); lb.writeUInt32BE(data.length, 0)
  const cb = Buffer.alloc(4); cb.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0)
  return Buffer.concat([lb, tb, data, cb])
}

/** Encodes w×h RGBA pixels as a PNG. */
export function encodePng(rgba, w, h = w) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6 // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4) // filter byte 0
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * The drawing as an SVG: one path per colour, each pixel run a rectangle.
 * The whole silhouette is laid down in black first, so where two colours meet
 * at a fractional scale, the antialiased seam blends into outline black rather
 * than letting the page show through.
 */
export function toSvg(grid) {
  const runs = new Map()
  const add = (ch, x, y, w) => { if (!runs.has(ch)) runs.set(ch, []); runs.get(ch).push(`M${x} ${y}h${w}v1h-${w}z`) }
  const silhouette = []
  for (let y = 0; y < SIZE; y++) {
    let x = 0
    while (x < SIZE) {
      const ch = grid[y][x]
      let w = 1
      while (x + w < SIZE && grid[y][x + w] === ch) w++
      if (ch !== '_') add(ch, x, y, w)
      x += w
    }
    let s = 0
    while (s < SIZE) {
      if (grid[y][s] === '_') { s++; continue }
      let w = 1
      while (s + w < SIZE && grid[y][s + w] !== '_') w++
      silhouette.push(`M${s} ${y}h${w}v1h-${w}z`)
      s += w
    }
  }
  const paths = [`<path fill="${PALETTE.K}" d="${silhouette.join('')}"/>`]
  for (const [ch, d] of runs) if (ch !== 'K') paths.push(`<path fill="${PALETTE[ch]}" d="${d.join('')}"/>`)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}">\n${paths.join('\n')}\n</svg>\n`
}
