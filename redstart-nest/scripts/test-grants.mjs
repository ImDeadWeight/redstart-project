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

console.log('\n-- the three capabilities, through their providers --')

const logger = await import('../daemon/logger.mjs')
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-grants-log-'))
logger.initLogger(logDir)
const sqlite = await import('../daemon/sqlite-tool.mjs')
const git = await import('../daemon/git-tool.mjs')
const vault = await import('../daemon/vault-tool.mjs')
const ctx = { account: { username: 'analyst' } }
const textOf = (r) => r.content.map((c) => c.text).join('\n')

// A shared root with three areas: a role is given "finance" only.
const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-grants-shared-'))
const SQLITE_HEADER = Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.alloc(84)])
for (const d of ['finance/q1', 'hr', 'finance/ledger/.git', 'hr/payroll/.git', '.git']) fs.mkdirSync(path.join(shared, d), { recursive: true })
fs.writeFileSync(path.join(shared, 'finance', 'q1', 'sales.db'), SQLITE_HEADER)
fs.writeFileSync(path.join(shared, 'hr', 'salaries.db'), SQLITE_HEADER)
fs.writeFileSync(path.join(shared, 'finance', 'q1', 'plan.md'), '# Plan\nbudget figures #money')
fs.writeFileSync(path.join(shared, 'hr', 'reviews.md'), '# Reviews\nbudget for raises #money')
const cfg = (key, grants) => ({ [key]: { enabled: true, rootDir: shared, ...(grants === undefined ? {} : { grants }) } })

await test('🔒 SQLite: the listing names granted databases only; another folder\'s is refused and logged', async () => {
  const all = textOf(await sqlite.callTool('sqlite_list_databases', {}, cfg('sqlite'), ctx))
  assert(/finance\/q1\/sales\.db/.test(all) && /hr\/salaries\.db/.test(all), `inherit lists both: ${all}`)
  const mine = textOf(await sqlite.callTool('sqlite_list_databases', {}, cfg('sqlite', ['finance']), ctx))
  assert(/finance\/q1\/sales\.db/.test(mine) && !/hr|salaries/.test(mine), `granted: ${mine}`)
  const none = textOf(await sqlite.callTool('sqlite_list_databases', {}, cfg('sqlite', []), ctx))
  assert(/No SQLite databases/.test(none), `[]: ${none}`)
  const refused = await sqlite.callTool('sqlite_list_tables', { database: 'hr/salaries.db' }, cfg('sqlite', ['finance']), ctx)
  assert(refused.isError && /outside the configured SQLite folder/.test(textOf(refused)), textOf(refused))
  const log = logger.readPolicyLog({ limit: 5 }).records
  const last = log.find((r) => r.event === 'access.denied')
  assert(last && last.capability === 'sqlite' && last.account === 'analyst', JSON.stringify(log))
  assert(!JSON.stringify(log).includes('salaries') && !JSON.stringify(log).includes('hr'), 'the log names a path')
})

await test('🔒 Git: no default repo once narrowed; the listing is the granted folders\' repos; another\'s is refused', async () => {
  const all = textOf(await git.callTool('git_list_repos', {}, cfg('git'), ctx))
  assert(/^\.$/m.test(all), `inherit lists the root repo: ${all}`)
  const mine = textOf(await git.callTool('git_list_repos', {}, cfg('git', ['finance']), ctx))
  assert(/finance\/ledger/.test(mine) && !/payroll|^\.$/m.test(mine), `granted: ${mine}`)
  const direct = textOf(await git.callTool('git_list_repos', {}, cfg('git', ['finance/ledger']), ctx))
  assert(/^finance\/ledger$/m.test(direct), `a granted repo itself: ${direct}`)
  const noDefault = await git.callTool('git_status', {}, cfg('git', ['finance']), ctx)
  assert(noDefault.isError && /git_list_repos/.test(textOf(noDefault)), textOf(noDefault))
  const refused = await git.callTool('git_status', { repo: 'hr/payroll' }, cfg('git', ['finance']), ctx)
  assert(refused.isError && /outside the configured git folder/.test(textOf(refused)), textOf(refused))
  assert(logger.readPolicyLog({ limit: 3 }).records.some((r) => r.event === 'access.denied' && r.capability === 'git'), 'git denial not logged')
})

await test('🔒 Vault: search and tags walk the granted folders only; a note elsewhere is refused', async () => {
  const all = textOf(await vault.callTool('vault_search', { query: 'budget' }, cfg('vault'), ctx))
  assert(/plan\.md/.test(all) && /reviews\.md/.test(all), `inherit: ${all}`)
  const mine = textOf(await vault.callTool('vault_search', { query: 'budget' }, cfg('vault', ['finance']), ctx))
  assert(/finance\/q1\/plan\.md/.test(mine) && !/reviews/.test(mine), `granted: ${mine}`)
  const tags = textOf(await vault.callTool('vault_tags', { tag: 'money' }, cfg('vault', ['finance']), ctx))
  assert(/plan\.md/.test(tags) && !/reviews/.test(tags), `tags: ${tags}`)
  const ok = await vault.callTool('vault_get', { path: 'finance/q1/plan.md' }, cfg('vault', ['finance']), ctx)
  assert(!ok.isError && /budget figures/.test(textOf(ok)), textOf(ok))
  const refused = await vault.callTool('vault_get', { path: 'hr/reviews.md' }, cfg('vault', ['finance']), ctx)
  assert(refused.isError && /outside the configured vault folder/.test(textOf(refused)), textOf(refused))
})

logger.closeLogger()
fs.rmSync(shared, { recursive: true, force: true })
fs.rmSync(root, { recursive: true, force: true })
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
