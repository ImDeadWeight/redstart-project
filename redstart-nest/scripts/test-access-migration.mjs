// =============================================================================
// The move to additive roles keeps everyone's access exactly as it was.
// =============================================================================
// daemon/access-migration.mjs rewrites accounts.json and roles.json once: tiers
// become roles, restriction roles become grant roles, one role per account
// becomes a list. The promise is that nobody can reach more, or less, than
// before. This checks it the only way that is convincing: over randomised
// version-1 installs, the config each account was served under the OLD rules
// (re-implemented here from the pre-2026-11-24 permissions.mjs) is compared
// with what it is served under the new ones, along with every admin permission
// and every app it may connect from.
//
// The one deliberate difference: an admin with no role (or Full Access and
// every admin permission) becomes an Administrator, which also carries the new
// manageProjects permission.
//
// Run:  node scripts/test-access-migration.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ensureAccessModel, forgetMigration } from '../daemon/access-migration.mjs'
import { narrowConfig, combineRoles, capabilityIds, ADMIN_PERMISSIONS } from '../daemon/permissions.mjs'
import { BUILTIN_ROLES } from '../daemon/roles-storage.mjs'

const results = []
async function test(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false, detail: err.message })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}
function assert(cond, message) { if (!cond) throw new Error(message) }

let seed = 0x2545f491
function rand() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000 }
const chance = (p) => rand() < p
const pick = (a) => a[Math.floor(rand() * a.length)]
const subset = (a) => a.filter(() => chance(0.5))

const OLD_ADMIN = ['manageAccounts', 'manageRoles', 'managePromptBlocks', 'manageOrgWorkflows']
const WEB = ['wikipedia', 'github', 'arxiv', 'mdn']
const FOLDERS = ['a', 'a/x', 'b', 'c']

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-access-migration-')) }
function writeJson(dir, name, data) { fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2)) }
function readJson(dir, name) { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) }

// --- A version-1 install ------------------------------------------------------

function randomV1Permissions() {
  const p = {}
  if (chance(0.6)) p.capabilities = subset(capabilityIds())
  if (chance(0.5)) p.webSourceIds = subset(WEB)
  if (chance(0.4)) p.allowWhitelistBypass = chance(0.5)
  if (chance(0.4)) p.allowWebSearchEngine = chance(0.5)
  if (chance(0.3)) p.maxFetchTokens = pick([200, 4000])
  if (chance(0.5)) p.fileSystem = { allowWrite: chance(0.5), allowDestructive: chance(0.5) }
  if (chance(0.3)) p.surfaces = subset(['nest-chat', 'twig'])
  if (chance(0.5)) p.admin = Object.fromEntries(subset(OLD_ADMIN).map(k => [k, true]))
  if (chance(0.5)) { p.grants = {}; for (const c of ['sqlite', 'git', 'vault']) if (chance(0.6)) p.grants[c] = subset(FOLDERS) }
  return p
}

function randomInstall() {
  const roles = Array.from({ length: Math.floor(rand() * 4) }, (_, i) => ({ id: `r${i}`, name: `Role ${i}`, description: '', permissions: randomV1Permissions(), builtIn: false }))
  const roleChoices = [null, null, 'full-access', 'restricted', 'deleted-role', ...roles.map(r => r.id)]
  const accounts = [{ id: 'owner', username: 'owner', tier: 'owner', role: 'owner', roleId: null }]
  for (let i = 0; i < 6; i++) {
    const tier = chance(0.4) ? 'admin' : 'user'
    accounts.push({ id: `a${i}`, username: `u${i}`, tier, role: tier, roleId: pick(roleChoices) })
  }
  return { roles, accounts }
}

// --- The old rules, as they were ------------------------------------------------

const V1_BUILTIN = {
  'full-access': { permissions: {} },
  restricted: { permissions: { capabilities: [], fileSystem: { allowWrite: false, allowDestructive: false }, allowWhitelistBypass: false, allowWebSearchEngine: false, admin: {} } },
}
function oldRole(install, roleId) {
  return install.roles.find(r => r.id === roleId) ?? V1_BUILTIN[roleId] ?? V1_BUILTIN['full-access']
}
function oldEffective(install, a, config) {
  if (a.tier === 'owner') return config
  return narrowConfig(config, oldRole(install, a.roleId).permissions)
}
function oldCan(install, a, perm) {
  if (a.tier === 'owner') return true
  if (a.tier !== 'admin') return false
  const block = oldRole(install, a.roleId).permissions.admin
  if (block === null || block === undefined) return true
  return block[perm] === true
}
function oldSurface(install, a, surface) {
  if (a.tier === 'owner') return true
  const s = oldRole(install, a.roleId).permissions.surfaces
  return s === null || s === undefined || s.includes(surface)
}

// --- The new rules ---------------------------------------------------------------

function newCombined(dir, a) {
  const all = [...BUILTIN_ROLES, ...readJson(dir, 'roles.json').roles]
  return combineRoles(a.roleIds.map(id => all.find(r => r.id === id)).filter(Boolean))
}

// --- Comparison -------------------------------------------------------------------

function randomConfig() {
  const activeTools = subset(WEB).map(id => ({ id, name: id, baseUrl: `https://${id}.example` }))
  const cap = () => ({ enabled: chance(0.7), ...(chance(0.3) ? { grants: subset(FOLDERS) } : {}) })
  return {
    disabledTools: [],
    webFetch: { enabled: true, whitelistEnabled: chance(0.5), allowedBaseUrls: activeTools.map(t => t.baseUrl), activeTools, maxFetchTokens: 8000, searchEngine: pick([{ kind: 'none' }, { kind: 'searxng', url: 'http://s/' }]) },
    postgres: cap(), documents: cap(), sqlite: cap(), vault: cap(), git: cap(), scholar: cap(), python: cap(), memory: cap(), documentSearch: cap(), imageGeneration: cap(),
    fileSystem: { enabled: chance(0.7), rootDir: '/r', allowWrite: chance(0.5), allowDestructive: chance(0.5) },
  }
}

/** What an account can actually reach: drop folder lists of switched-off capabilities, sort lists. */
function reach(config) {
  const c = JSON.parse(JSON.stringify(config))
  for (const [k, v] of Object.entries(c)) {
    if (v && typeof v === 'object' && v.enabled === false) { delete v.grants; delete v.sharedGrants }
  }
  const sortDeep = (x) => Array.isArray(x) ? x.map(sortDeep).sort((p, q) => JSON.stringify(p).localeCompare(JSON.stringify(q)))
    : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, sortDeep(x[k])])) : x
  return JSON.stringify(sortDeep(c))
}

console.log('\n-- every account keeps exactly its access --')

await test('🔍 300 random version-1 installs: same config served, same admin rights, same apps', async () => {
  for (let n = 0; n < 300; n++) {
    const install = randomInstall()
    const dir = tmpDir()
    writeJson(dir, 'roles.json', { roles: install.roles })
    writeJson(dir, 'accounts.json', { authRequired: true, accounts: install.accounts })
    const r = ensureAccessModel(dir)
    assert(r.migrated, `install ${n} was not migrated`)
    const migrated = readJson(dir, 'accounts.json').accounts
    for (const before of install.accounts) {
      const after = migrated.find(a => a.id === before.id)
      if (before.tier === 'owner') { assert(after.tier === 'owner' && after.roleIds.length === 0, 'owner changed'); continue }
      const combined = newCombined(dir, after)
      for (let k = 0; k < 4; k++) {
        const config = randomConfig()
        const a = reach(oldEffective(install, before, config))
        const b = reach(narrowConfig(config, combined))
        if (a !== b) throw new Error(`install ${n}, ${before.username} (${before.tier}, ${before.roleId}) → ${after.roleIds}:\nold ${a}\nnew ${b}`)
      }
      for (const perm of OLD_ADMIN) {
        const was = oldCan(install, before, perm)
        const now = combined.admin[perm] === true
        if (was !== now) throw new Error(`install ${n}, ${before.username}: ${perm} was ${was}, now ${now} (roles ${after.roleIds})`)
      }
      for (const surface of ['nest-chat', 'twig', 'blueprints']) {
        const was = oldSurface(install, before, surface)
        const now = combined.surfaces === undefined || combined.surfaces.includes(surface)
        if (was !== now) throw new Error(`install ${n}, ${before.username}: surface ${surface} was ${was}, now ${now}`)
      }
      if (combined.admin.manageProjects) {
        assert(after.roleIds.includes('administrator'), `${before.username} gained manageProjects without being an Administrator`)
      }
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return '300 installs, 1800 accounts'
})

console.log('\n-- the edges --')

await test('an unrestricted admin becomes an Administrator; a user with no role gets Full Access', async () => {
  const dir = tmpDir()
  writeJson(dir, 'accounts.json', { authRequired: true, accounts: [
    { id: 'o', username: 'o', tier: 'owner' },
    { id: 'a', username: 'a', tier: 'admin', roleId: null },
    { id: 'u', username: 'u', tier: 'user', roleId: null },
  ] })
  ensureAccessModel(dir)
  const by = Object.fromEntries(readJson(dir, 'accounts.json').accounts.map(a => [a.id, a]))
  assert(JSON.stringify(by.a.roleIds) === '["administrator"]', JSON.stringify(by.a))
  assert(JSON.stringify(by.u.roleIds) === '["full-access"]', JSON.stringify(by.u))
  assert(readJson(dir, 'roles.json').version === 2, 'roles.json not stamped')
})

await test('admins sharing a restricted role share one derived "(administration)" role; their users do not get it', async () => {
  const dir = tmpDir()
  writeJson(dir, 'roles.json', { roles: [{ id: 'legal', name: 'Legal', permissions: { capabilities: ['documents'], admin: { manageAccounts: true } } }] })
  writeJson(dir, 'accounts.json', { authRequired: true, accounts: [
    { id: 'o', username: 'o', tier: 'owner' },
    { id: 'a1', username: 'a1', tier: 'admin', roleId: 'legal' },
    { id: 'a2', username: 'a2', tier: 'admin', roleId: 'legal' },
    { id: 'u', username: 'u', tier: 'user', roleId: 'legal' },
  ] })
  ensureAccessModel(dir)
  const roles = readJson(dir, 'roles.json').roles
  const by = Object.fromEntries(readJson(dir, 'accounts.json').accounts.map(a => [a.id, a]))
  assert(by.a1.roleIds[0] === 'legal--admin' && by.a2.roleIds[0] === 'legal--admin', JSON.stringify(by))
  assert(JSON.stringify(by.u.roleIds) === '["legal"]', 'the user got the admin role')
  assert(roles.filter(r => r.id === 'legal--admin').length === 1, 'derived role duplicated')
  assert(!roles.find(r => r.id === 'legal').permissions.admin, 'the plain role still carries admin rights its users would now get')
})

await test('an old install with only admins (no owner) promotes them to owner first', async () => {
  const dir = tmpDir()
  writeJson(dir, 'accounts.json', { authRequired: true, accounts: [{ id: 'x', username: 'x', role: 'admin' }, { id: 'y', username: 'y', role: 'user' }] })
  ensureAccessModel(dir)
  const by = Object.fromEntries(readJson(dir, 'accounts.json').accounts.map(a => [a.id, a]))
  assert(by.x.tier === 'owner', `the lone admin became ${by.x.tier}`)
})

await test('🔍 a crash between the two writes re-runs to the same answer', async () => {
  const dir = tmpDir()
  const v1Roles = { roles: [{ id: 'r', name: 'R', permissions: { capabilities: ['git'], admin: { manageRoles: true } } }] }
  writeJson(dir, 'roles.json', v1Roles)
  writeJson(dir, 'accounts.json', { authRequired: true, accounts: [{ id: 'o', username: 'o', tier: 'owner' }, { id: 'a', username: 'a', tier: 'admin', roleId: 'r' }] })
  ensureAccessModel(dir)
  const first = readJson(dir, 'accounts.json').accounts
  // The crash: accounts.json was written, roles.json was not.
  writeJson(dir, 'roles.json', v1Roles)
  forgetMigration(dir)
  ensureAccessModel(dir)
  const second = readJson(dir, 'accounts.json').accounts
  assert(JSON.stringify(first.map(a => a.roleIds)) === JSON.stringify(second.map(a => a.roleIds)), `${JSON.stringify(first)} vs ${JSON.stringify(second)}`)
  assert(readJson(dir, 'roles.json').roles.some(r => r.id === 'r--admin'), 'derived role missing after the re-run')
})

await test('accounts already in the new shape are never rewritten (fresh install, roles.json never written)', async () => {
  const dir = tmpDir()
  writeJson(dir, 'accounts.json', { authRequired: true, accounts: [{ id: 'o', username: 'o', tier: 'owner', roleIds: [] }, { id: 'n', username: 'n', tier: 'member', roleIds: ['restricted'] }] })
  ensureAccessModel(dir)
  const n = readJson(dir, 'accounts.json').accounts.find(a => a.id === 'n')
  assert(JSON.stringify(n.roleIds) === '["restricted"]', `a new-format account was rewritten: ${JSON.stringify(n)}`)
})

await test('an empty folder is left empty', async () => {
  const dir = tmpDir()
  ensureAccessModel(dir)
  assert(fs.readdirSync(dir).length === 0, `files were created: ${fs.readdirSync(dir)}`)
})

await test('Administrator holds every admin permission, including the new manageProjects', async () => {
  const admin = BUILTIN_ROLES.find(r => r.id === 'administrator')
  for (const p of ADMIN_PERMISSIONS) assert(admin.permissions.admin[p] === true, p)
})

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
