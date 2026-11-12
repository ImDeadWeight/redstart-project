/**
 * Writes Redstart Yellowscript's icons from its mascot drawing
 * (../assets/mascot/redstart-yellowscript.txt: the bird on a yellow pencil).
 * Yellowscript is a separate repository; run this, then commit the files in
 * that repository's media/ folder:
 *
 *   node redstart-nest/scripts/make-yellowscript-icons.mjs ../redstart-yellowscript/media
 *
 * - icon.png             256px, the extension's icon (Marketplace, Extensions view)
 * - yellowscript.svg     full colour: the editor tab, the login screen
 * - yellowscript-mono.svg a 24-cell silhouette in currentColor: the activity
 *                        bar, which VS Code draws as a mask
 */

import * as fs from 'fs'
import * as path from 'path'
import { loadMascot, rasterize, contentSquare, encodePng, toSvg, toSilhouetteSvg } from './mascot.mjs'

const out = process.argv[2]
if (!out) {
  console.error('usage: make-yellowscript-icons.mjs <yellowscript media folder>')
  process.exit(2)
}
fs.mkdirSync(out, { recursive: true })
const write = (name, data) => {
  fs.writeFileSync(path.join(out, name), data)
  console.log(`✓ ${name}  (${(Buffer.byteLength(data) / 1024).toFixed(1)} KB)`)
}

const grid = loadMascot('yellowscript')

// Cropped to the drawing, so the bird fills the extension tile.
write('icon.png', encodePng(rasterize(grid, 256, { pad: 8, crop: contentSquare(grid, 2) }), 256))
write('yellowscript.svg', toSvg(grid))

// The eye (its white and grey ring, inside the head) is a hole, so the head
// reads as the bird rather than a blob at 24px.
const eye = (x, y, ch) => y >= 20 && y < 45 && x >= 75 && x < 105 && (ch === 'W' || ch === 'g')
write('yellowscript-mono.svg', toSilhouetteSvg(grid, 24, { hole: eye }))
