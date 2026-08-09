// =============================================================================
// Durable JSON writes — state must survive an interrupted write.
// =============================================================================
// Redstart keeps its persistent state in JSON files written by the Electron
// main process. A bare fs.writeFileSync truncates the target first, so an
// interruption leaves a PREFIX of the intended content on disk — invalid JSON.
// Every reader in this codebase is `try { parse } catch { return <empty> }`,
// which turns that into a silent reset to defaults rather than an error.
//
// For accounts.json that is the sharpest case: the Owner record disappears,
// and because login is required by default and owner bootstrap is
// launcher-only, the appliance locks everyone out until someone re-bootstraps
// at the physical machine.
//
// These checks therefore do not assert "the file was written". They write a
// truncated file directly — the exact artifact a torn write leaves — and assert
// the reader neither trusts it nor destroys it.
//
// Run:  node scripts/test-json-store.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { writeJsonAtomic, readJsonOr } from '../electron/main/json-store.mjs'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-json-store-'))

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

const filePath = (name) => path.join(tmpDir, name)

console.log('\n-- round trip --')

test('a written file reads back identically', () => {
  const p = filePath('basic.json')
  const data = { accounts: [{ id: 'a1', username: 'pat', role: 'owner' }], authRequired: true }
  writeJsonAtomic(p, data)
  assert(JSON.stringify(readJsonOr(p, null)) === JSON.stringify(data), 'round trip changed the data')
  return 'exact'
})

test('a missing file returns the fallback — the normal first-run case', () => {
  const got = readJsonOr(filePath('never-written.json'), { accounts: [] })
  assert(Array.isArray(got.accounts) && got.accounts.length === 0, 'fallback not returned')
  return 'no throw, no file created'
})

test('the parent directory is created if absent', () => {
  const p = path.join(tmpDir, 'nested', 'deeper', 'state.json')
  writeJsonAtomic(p, { ok: true })
  assert(fs.existsSync(p), 'nested write did not land')
  return 'mkdir -p'
})

console.log('\n-- interrupted writes --')

test('🔍 a torn file does NOT silently read as empty state', () => {
  const p = filePath('torn.json')
  const good = { accounts: [{ id: 'a1', username: 'owner', role: 'owner' }], authRequired: true }
  writeJsonAtomic(p, good)

  // Exactly what an interrupted writeFileSync leaves: a prefix of the payload.
  const full = JSON.stringify(good, null, 2)
  fs.writeFileSync(p, full.slice(0, Math.floor(full.length / 2)), 'utf8')

  const sentinel = { accounts: [], authRequired: true, __fallback: true }
  const got = readJsonOr(p, sentinel)
  assert(got.__fallback === true, 'a truncated file parsed as real data — worse than the fallback')
  return 'fallback returned, not garbage'
})

test('🔍 the corrupt original is preserved, not overwritten into oblivion', () => {
  const p = filePath('rescue.json')
  writeJsonAtomic(p, { accounts: [{ id: 'a1', username: 'owner' }] })
  const torn = '{ "accounts": [ { "id": "a1", "usern'
  fs.writeFileSync(p, torn, 'utf8')

  readJsonOr(p, { accounts: [] })

  const rescue = `${p}.corrupt`
  assert(fs.existsSync(rescue), 'no .corrupt copy — the only record of the lost state is gone')
  assert(fs.readFileSync(rescue, 'utf8') === torn, '.corrupt copy does not match what was on disk')
  return 'recoverable by hand'
})

test('🔍 no temp files are left behind', () => {
  const p = filePath('leftovers.json')
  for (let i = 0; i < 5; i++) writeJsonAtomic(p, { i })
  const strays = fs.readdirSync(tmpDir).filter(f => f.endsWith('.tmp'))
  assert(strays.length === 0, `left ${strays.length} temp file(s): ${strays.join(', ')}`)
  return '5 writes, 0 strays'
})

test('a rewrite fully replaces the previous content — no trailing remnant', () => {
  const p = filePath('shrink.json')
  writeJsonAtomic(p, { note: 'x'.repeat(4000) })
  writeJsonAtomic(p, { note: 'small' })
  const raw = fs.readFileSync(p, 'utf8')
  assert(!raw.includes('xxxx'), 'bytes from the longer previous write survived')
  assert(readJsonOr(p, null).note === 'small', 'the new value did not land')
  return 'rename replaces, not overlays'
})

// ---------------------------------------------------------------------------

fs.rmSync(tmpDir, { recursive: true, force: true })

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
