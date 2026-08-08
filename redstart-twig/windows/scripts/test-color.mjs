// =============================================================================
// electron/color.mjs — CSS colour parsing for the window-controls overlay
// =============================================================================
// The renderer reports the background it is painting so the title-bar overlay
// can match. If parsing returns something Electron rejects, setTitleBarOverlay
// silently leaves the previous colour in place — which looks exactly like the
// mismatched-band bug this replaced. So the fallback path matters as much as
// the happy path: anything unparseable must return null, so the caller can fall
// back to a known-good constant rather than passing junk through.
//
// Run:  node scripts/test-color.mjs
// =============================================================================

import { toHexColor } from '../electron/color.mjs'

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

const eq = (input, expected) => {
  const got = toHexColor(input)
  assert(got === expected, `${JSON.stringify(input)} -> ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`)
}

console.log('\n-- what getComputedStyle actually returns --')

test('rgb() with commas', () => eq('rgb(6, 6, 6)', '#060606'))
test('rgb() space-separated (modern CSS serialisation)', () => eq('rgb(6 6 6)', '#060606'))
test('rgba() — alpha dropped, since the overlay is opaque', () => eq('rgba(6, 6, 6, 0.5)', '#060606'))
test('the app background specifically', () => {
  // oklch(0.12 0 0), the chat-ui's --background, as Chromium serialises it.
  eq('rgb(6, 6, 6)', '#060606')
})

console.log('\n-- hex passthrough --')

test('#rrggbb is returned as-is', () => eq('#1a2b3c', '#1a2b3c'))
test('#rgb is expanded', () => eq('#abc', '#aabbcc'))
test('case is normalised', () => eq('#AABBCC', '#aabbcc'))

console.log('\n-- values that must NOT be passed to Electron --')

test('🔍 unparseable input returns null so the caller can fall back', () => {
  // Returning a bad string here would leave the overlay on its old colour with
  // no error — the silent failure this whole change exists to remove.
  for (const junk of [undefined, null, 42, {}, '', '   ', 'transparent', 'oklch(0.12 0 0)', 'var(--background)', '#12345', 'rgb(6, 6)']) {
    assert(toHexColor(junk) === null, `${JSON.stringify(junk)} -> ${JSON.stringify(toHexColor(junk))}, expected null`)
  }
})

test('an over-range channel is clamped, not emitted raw', () => eq('rgb(300, 20, 6)', '#ff1406'))

test('a negative channel does not parse, so the caller falls back', () => {
  // Browsers clamp before serialising, so getComputedStyle never produces this.
  // Falling back to a known-good constant beats inventing a colour from input
  // that should not exist.
  eq('rgb(300, -20, 6)', null)
})

test('fractional channels round to a whole byte', () => eq('rgb(5.6, 6.4, 6)', '#060606'))

test('every successful result is a valid #rrggbb', () => {
  for (const input of ['rgb(6 6 6)', 'rgba(1,2,3,0.2)', '#abc', '#AABBCC', 'rgb(300,20,6)']) {
    const out = toHexColor(input)
    assert(/^#[0-9a-f]{6}$/.test(out), `${input} -> ${out} is not #rrggbb`)
  }
})

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
