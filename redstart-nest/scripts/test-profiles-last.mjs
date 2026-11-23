// =============================================================================
// The working settings survive closing Nest (profiles.json `last`)
// =============================================================================
// The launcher writes whatever is on screen, and the profile it came from, a
// moment after every change, and reads it back when it opens. These cover the
// daemon half: what is stored, what a bad body cannot store, and that deleting
// the profile in use drops only the claim, never the settings.
//
// In-memory store: no files, no daemon.
//
// Run:  node scripts/test-profiles-last.mjs
// =============================================================================

import { profilesHandlers } from '../daemon/ipc/profiles.mjs'

let store = { profiles: {} }
const deps = {
  readProfiles: () => structuredClone(store),
  writeProfiles: (d) => { store = structuredClone(d) },
}
const h = profilesHandlers(deps)

let failed = 0
function test(name, fn) {
  store = { profiles: {} }
  try { fn(); console.log(`  ok  - ${name}`) } catch (err) { failed++; console.log(`FAIL  - ${name}\n        ${err.message}`) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }

const cfg = { modelPath: '/m/a.gguf', ctxSize: 8192, batchSize: 256, threads: 8, port: 19080, host: '0.0.0.0' }

test('nothing stored reads as a first run', () => {
  assert(h['profiles:get-last']() === null, 'expected null')
})

test('the settings and their profile round-trip', () => {
  h['profiles:save']('Long docs', cfg)
  assert(h['profiles:set-last']('Long docs', { ...cfg, ctxSize: 16384 }) === true, 'set-last refused')
  const last = h['profiles:get-last']()
  assert(last.profile === 'Long docs' && last.config.ctxSize === 16384, JSON.stringify(last))
  assert(store.profiles['Long docs'].ctxSize === 8192, 'the working settings were written into the profile')
})

test('no profile is stored as null', () => {
  h['profiles:set-last']('', cfg)
  assert(h['profiles:get-last']().profile === null, 'empty name should be null')
  h['profiles:set-last'](null, cfg)
  assert(h['profiles:get-last']().profile === null, 'null should stay null')
})

test('a body that is not a config stores nothing', () => {
  for (const bad of [null, 'x', 7, [cfg]]) {
    assert(h['profiles:set-last']('P', bad) === false, `accepted ${JSON.stringify(bad)}`)
  }
  assert(store.last === undefined, 'something was written')
})

test('a malformed stored entry reads as a first run', () => {
  for (const last of ['x', { profile: 'P' }, { profile: 'P', config: 'x' }]) {
    store = { profiles: {}, last }
    assert(h['profiles:get-last']() === null, `read ${JSON.stringify(last)}`)
  }
})

test('deleting the profile in use keeps the settings and drops the name', () => {
  h['profiles:save']('Gone', cfg)
  h['profiles:set-last']('Gone', cfg)
  h['profiles:delete']('Gone')
  const last = h['profiles:get-last']()
  assert(last && last.profile === null && last.config.modelPath === cfg.modelPath, JSON.stringify(last))
})

test('deleting another profile leaves the name alone', () => {
  h['profiles:save']('Keep', cfg)
  h['profiles:save']('Other', cfg)
  h['profiles:set-last']('Keep', cfg)
  h['profiles:delete']('Other')
  assert(h['profiles:get-last']().profile === 'Keep', 'name was cleared')
})

test('generating default profiles keeps the working settings', () => {
  h['profiles:set-last']('Assistant', cfg)
  h['profiles:generate-defaults']({ cpu: { cores: 8, threads: 16 } })
  assert(h['profiles:get-last']().config.ctxSize === 8192, 'last was touched')
})

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
