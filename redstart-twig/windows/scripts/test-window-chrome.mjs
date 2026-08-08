// =============================================================================
// Window-chrome invariants that span two codebases
// =============================================================================
// Twig runs frameless: Windows draws the minimise/maximise/close overlay, and
// the chat-ui draws the draggable strip beside it. They have to be the same
// height or the strip visibly fails to line up with the buttons — and they are
// defined in two different repos' files, in two different units.
//
//   redstart-twig/windows/electron/main.mjs   TITLEBAR_CSS_HEIGHT, UI_ZOOM
//   redstart-nest/.../src/app.css             --twig-titlebar-height
//
// The web content is zoomed (UI_ZOOM); the OS overlay is not. So the native
// height is TITLEBAR_CSS_HEIGHT * UI_ZOOM, while the CSS strip is
// TITLEBAR_CSS_HEIGHT — and the CSS file has to agree with the constant.
//
// This exact shape of bug already shipped once today: the overlay colour was a
// hardcoded hex here that had to match a CSS variable there, and it drifted,
// leaving a visibly lighter band behind the buttons. A comment asking the next
// person to keep two numbers in step is not a mechanism; this is.
//
// Run:  npm test
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MAIN = path.join(__dirname, '..', 'electron', 'main.mjs')
const APP_CSS = path.join(__dirname, '..', '..', '..', 'redstart-nest', 'src', 'chat-ui', 'src', 'app.css')

const results = []

function test(name, fn) {
  try {
    const detail = fn()
    results.push({ name, pass: true, detail })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false, detail: err.message })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const mainSource = fs.readFileSync(MAIN, 'utf8')
const cssSource = fs.readFileSync(APP_CSS, 'utf8')

const numberFrom = (source, pattern, label) => {
  const match = source.match(pattern)
  assert(match, `could not find ${label}`)
  return Number(match[1])
}

console.log('\n-- title bar: the shell and the chat-ui must agree --')

test('the chat-ui app.css is where this test expects it', () => {
  assert(fs.existsSync(APP_CSS), `missing: ${APP_CSS}`)
  return 'found'
})

test('🔍 --twig-titlebar-height equals TITLEBAR_CSS_HEIGHT', () => {
  const fromMain = numberFrom(mainSource, /const TITLEBAR_CSS_HEIGHT = (\d+)/, 'TITLEBAR_CSS_HEIGHT in main.mjs')
  const fromCss = numberFrom(cssSource, /--twig-titlebar-height:\s*(\d+)px/, '--twig-titlebar-height in app.css')
  assert(
    fromMain === fromCss,
    `main.mjs says ${fromMain}px, app.css says ${fromCss}px — the drag strip will not line up with the window buttons`,
  )
  return `${fromMain}px both sides`
})

test('the native overlay height is derived, not written twice', () => {
  // If someone replaces the derivation with a literal, the zoom and the overlay
  // can drift apart again without anything failing.
  assert(
    /const TITLEBAR_HEIGHT = Math\.round\(TITLEBAR_CSS_HEIGHT \* UI_ZOOM\)/.test(mainSource),
    'TITLEBAR_HEIGHT is no longer derived from TITLEBAR_CSS_HEIGHT * UI_ZOOM',
  )
})

test('the zoom factor is plausible and applied to the loaded document', () => {
  const zoom = numberFrom(mainSource, /const UI_ZOOM = ([\d.]+)/, 'UI_ZOOM')
  assert(zoom > 0.4 && zoom <= 1, `UI_ZOOM is ${zoom} — outside a sane range`)
  assert(
    /did-finish-load[\s\S]{0,200}setZoomFactor\(UI_ZOOM\)/.test(mainSource),
    'zoom is not applied after load, so the first navigation discards it',
  )
  return `${zoom * 100}%`
})

console.log('\n-- layout offsets clear the strip --')

test('the fixed-position chrome is offset by the title bar height', () => {
  // Both the sidebar toggle and the collapsed icon rail are position:fixed, so
  // they ignore the body padding that offsets everything else. Offsetting only
  // one of them put the toggle on top of the rail's first icon (Profile).
  for (const slot of ['sidebar-container', 'sidebar-trigger', 'desktop-icon-strip']) {
    assert(
      new RegExp(`html\\.twig-desktop \\[data-slot='${slot}'\\]`).test(cssSource),
      `no twig-desktop offset for [data-slot='${slot}'] — it will sit under the drag strip`,
    )
  }
  return '3 fixed elements offset'
})

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
