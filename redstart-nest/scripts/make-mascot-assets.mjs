/**
 * Regenerates the committed mascot assets from the drawings in
 * ../assets/mascot/ (see mascot.mjs). Run it after editing a drawing and
 * commit what it writes:
 *
 *   node redstart-nest/scripts/make-mascot-assets.mjs
 *
 * - redstart.svg: Nest's admin UI, the chat UI (greeting, login, loading
 *   screen) and electron/assets
 * - favicon.svg / favicon-dark.svg: the chat UI's favicons, which the PWA
 *   asset generator also builds the PWA icons from. The dark one gets a
 *   light outline so the black bird shows on a dark tab strip.
 * - Android: launcher icons (legacy, round and adaptive foreground) and the
 *   splash screens.
 *
 * All of these show the nest drawing: the chat UI is one build shared by both
 * apps. Twig's own app icons come from make-icon.mjs --variant twig.
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { SIZE, PALETTE, loadMascot, withOutline, rasterize, flatten, blit, encodePng, toSvg } from './mascot.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const nestDir = path.join(__dirname, '..')
const write = (rel, data) => {
  const file = path.join(nestDir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, data)
  console.log(`✓ ${rel}  (${(Buffer.byteLength(data) / 1024).toFixed(1)} KB)`)
}

const nest = loadMascot('nest')

// ── SVGs ─────────────────────────────────────────────────────────────────────
const svg = toSvg(nest)
for (const rel of ['public/redstart.svg', 'electron/assets/redstart.svg', 'src/chat-ui/static/redstart.svg', 'src/chat-ui/static/favicon.svg']) write(rel, svg)
write('src/chat-ui/static/favicon-dark.svg', toSvg(withOutline(nest, 'W')))

// ── Android ──────────────────────────────────────────────────────────────────
const res = 'src/chat-ui/android/app/src/main/res'
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
const LAUNCHER_BG = PALETTE.W // also values/ic_launcher_background.xml

for (const [name, d] of Object.entries(DENSITIES)) {
  // Legacy launcher icons (pre-Android 8): the bird on its own, 48dp with a
  // little breathing room.
  const icon = Math.round(48 * d)
  const iconPx = rasterize(nest, icon, { pad: Math.round(icon * 0.04) })
  write(`${res}/mipmap-${name}/ic_launcher.png`, encodePng(iconPx, icon))
  write(`${res}/mipmap-${name}/ic_launcher_round.png`, encodePng(iconPx, icon))
  // Adaptive foreground: 108dp canvas, art inside the 66dp safe zone that
  // every launcher mask keeps.
  const fg = Math.round(108 * d)
  write(`${res}/mipmap-${name}/ic_launcher_foreground.png`, encodePng(rasterize(nest, fg, { pad: Math.round(fg * 0.2) }), fg))
}

// Splash screens: the bird centred on white at a whole-number scale, so it
// stays crisp.
const SPLASHES = {
  drawable: [480, 320],
  ...Object.fromEntries(Object.entries(DENSITIES).flatMap(([name, d]) => [
    [`drawable-port-${name}`, [320 * d, 480 * d]],
    [`drawable-land-${name}`, [480 * d, 320 * d]],
  ])),
}
for (const [dir, [w, h]] of Object.entries(SPLASHES)) {
  const art = SIZE * Math.max(1, Math.floor(Math.min(w, h) * 0.4 / SIZE))
  const canvas = Buffer.alloc(w * h * 4)
  blit(canvas, w, rasterize(nest, art), art, art, Math.floor((w - art) / 2), Math.floor((h - art) / 2))
  write(`${res}/${dir}/splash.png`, encodePng(flatten(canvas, '#ffffff'), w, h))
}

console.log(`\nAdaptive icon background: ${LAUNCHER_BG} (${res}/values/ic_launcher_background.xml)`)
