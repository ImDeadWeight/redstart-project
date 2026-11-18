// =============================================================================
// Resource grants — a shared root narrowed to folders (master plan Phase 6)
// =============================================================================
// Pinned here:
//   - a grant is a folder RELATIVE to the root: absolute paths, "..", dot
//     folders and backslashes are refused when a role is saved
//   - inherit (absent) is the whole root; [] is nothing; a list is those
//     folders, and the same access is always the same list
//   - a path inside the root but outside every granted folder is refused
//     with the SAME message as an escape, and is marked as a denial
//   - a symlink inside a granted folder that points elsewhere in the root is
//     judged by where it points
//
// The restrict-only and idempotence properties are test-roles.mjs's.
//
// Run:  node scripts/test-grants.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const g = await import('../daemon/grant-scope.mjs')

const results = []
async function test(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false })
    console.log(`FAIL  - ${name}\n        ${err.stack ?? err.message}`)
  }
}
function assert(cond, message) { if (!cond) throw new Error(message) }
function eq(a, e, m) { const x = JSON.stringify(a), y = JSON.stringify(e); if (x !== y) throw new Error(`${m}\n        expected ${y}\n        got      ${x}`) }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-grants-'))
for (const d of ['finance/q1', 'finance/q2', 'hr', 'eng/repo1', '.hidden']) fs.mkdirSync(path.join(root, d), { recursive: true })
fs.writeFileSync(path.join(root, 'finance', 'q1', 'a.db'), 'x')
fs.writeFileSync(path.join(root, 'hr', 'salaries.db'), 'x')
fs.writeFileSync(path.join(root, 'top.db'), 'x')

console.log('\n-- what a grant may name --')

await test('🔒 a grant is a folder relative to the root; anything that could name another directory is refused', async () => {
  for (const ok of ['finance', 'finance/q1', 'a b/c']) assert(g.validGrantPath(ok), `${ok} refused`)
  for (const bad of ['', '/etc', 'C:/x', '..', 'a/../b', '.hidden', 'a/.git', 'a\\b', 'a//b', 'x\0']) {
    assert(!g.validGrantPath(bad), `${JSON.stringify(bad)} accepted`)
  }
  const v = g.validateGrants({ sqlite: ['finance/', 'finance/q1', 'hr'], git: [] })
  assert(v.ok, v.error)
  eq(v.grants, { sqlite: ['finance', 'hr'], git: [] }, 'trailing slash off, a covered folder dropped, [] kept')
  assert(!g.validateGrants({ sqlite: ['../outside'] }).ok, '".." accepted')
  assert(!g.validateGrants({ postgres: ['x'] }).ok, 'postgres has no folders to grant')
  assert(!g.validateGrants({ sqlite: 'finance' }).ok, 'a string, not a list')
  assert(!g.validateGrants({ sqlite: Array.from({ length: 33 }, (_, i) => `f${i}`) }).ok, 'over the limit')
  eq(g.validateGrants(undefined), { ok: true, grants: undefined }, 'absent stays absent')
})

console.log('\n-- intersection --')

await test('inherit, nothing, and narrowing: the narrower of each pair survives, in one form', async () => {
  eq(g.intersectGrants(null, undefined), null, 'both inherit')
  eq(g.intersectGrants(['a'], null), ['a'], 'role inherits')
  eq(g.intersectGrants(null, ['b', 'a', 'a/x']), ['a', 'b'], 'config inherits; one form')
  eq(g.intersectGrants(['a', 'b'], []), [], 'nothing')
  eq(g.intersectGrants(['a'], ['a/x', 'c']), ['a/x'], 'narrower kept, outside dropped')
  eq(g.intersectGrants(['a/x'], ['a']), ['a/x'], 'the other way round')
  eq(g.intersectGrants(['ab'], ['a']), [], '"ab" is not inside "a"')
})

console.log('\n-- resolution and enumeration --')

await test('🔒 a path outside every granted folder is refused like an escape, and marked as a denial', async () => {
  const grants = ['finance']
  assert(g.resolveGrantedPath(root, grants, 'finance/q1/a.db').endsWith(path.join('q1', 'a.db')), 'inside')
  let e = null
  try { g.resolveGrantedPath(root, grants, 'hr/salaries.db') } catch (err) { e = err }
  assert(e?.denied === true && e.message === 'Path escapes the configured root directory', `outside a grant: ${e?.message}`)
  let esc = null
  try { g.resolveGrantedPath(root, grants, '../../etc/passwd') } catch (err) { esc = err }
  assert(esc && !esc.denied && esc.message === e.message, 'an escape reads differently from a denial')
  let none = null
  try { g.resolveGrantedPath(root, [], 'finance/q1/a.db') } catch (err) { none = err }
  assert(none?.denied, '[] let a path through')
  assert(g.resolveGrantedPath(root, null, 'hr/salaries.db'), 'inherit refused a path')
  let prefix = null
  try { g.resolveGrantedPath(root, ['fin'], 'finance/q1/a.db') } catch (err) { prefix = err }
  assert(prefix?.denied, '"fin" granted "finance"')
})

await test('grantedRoots and grantedPrefixes: the root for inherit, existing folders otherwise, nothing for []', async () => {
  eq(g.grantedRoots(root, null).length, 1, 'inherit')
  eq(g.grantedRoots(root, ['finance', 'gone', 'hr']).map((p) => path.basename(p)), ['finance', 'hr'], 'a missing folder dropped')
  eq(g.grantedRoots(root, []), [], 'nothing')
  eq(g.grantedPrefixes(null), [''], 'inherit walks the root')
  eq(g.grantedPrefixes(['finance']), ['finance'], 'a list walks its folders')
})

await test('🔒 a symlink inside a granted folder is judged by where it points', async () => {
  const link = path.join(root, 'finance', 'to-hr')
  try {
    fs.symlinkSync(path.join(root, 'hr'), link, 'junction')
  } catch {
    return 'skipped: no symlink permission here'
  }
  let e = null
  try { g.resolveGrantedPath(root, ['finance'], 'finance/to-hr/salaries.db') } catch (err) { e = err }
  assert(e?.denied, 'a link out of the granted folder was followed')
  fs.rmSync(link, { force: true, recursive: false })
})

fs.rmSync(root, { recursive: true, force: true })
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
