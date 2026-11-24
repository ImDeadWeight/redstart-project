// =============================================================================
// Invariant tests for daemon/permissions.mjs — the per-account role layer.
// =============================================================================
// Priority 5/5 (permission escalation). A role is a RESTRICTION: effective
// access is (what the profile enabled) ∩ (what the role permits). Every rule in
// narrowConfig() must therefore tighten, and several of them look equally
// plausible written backwards:
//
//     whitelistEnabled:  global || role forbids bypass     NOT  role ? … : global
//     allowWrite:        global && role permits            NOT  global || role
//     maxFetchTokens:    min(global, role)                 NOT  role ?? global
//
// Each inverted version widens access, throws nothing, and passes any test that
// only checks "the restricted user got fewer tools". So the centrepiece here is
// a PROPERTY test over randomised configs and roles: whatever comes out is
// compared field by field against what went in, and any widening at all fails.
// A hand-written example suite would only ever cover the cases someone thought
// of; this covers the ones nobody did.
//
// permissions.mjs imports nothing from electron, so this runs under plain node
// with no loader stub and no server.
//
// Run:  node scripts/test-roles.mjs
// =============================================================================

import {
  narrowConfig,
  resolveEffectiveConfig,
  can,
  allowsSurface,
  restrictsSurfaces,
  capabilityIds,
  CAPABILITY_CONFIG_KEY,
  ADMIN_PERMISSIONS,
  DENY_ALL,
  combineRoles,
  permissionsWithin,
  holdsAnyAdmin,
} from '../daemon/permissions.mjs'
import { BUILTIN_ROLES } from '../daemon/roles-storage.mjs'
import { CAPABILITY_TOOL_NAMES, setPluginCapabilityProvider } from '../daemon/tools-definitions.mjs'

// ---------------------------------------------------------------------------
// Harness (mirrors scripts/test-tool-policy.mjs)
// ---------------------------------------------------------------------------

const results = []

async function test(name, fn) {
  try {
    const detail = await fn()
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

// ---------------------------------------------------------------------------
// Deterministic PRNG — a failing property test has to be reproducible, and
// Math.random() would make a counterexample vanish on the next run.
// ---------------------------------------------------------------------------

let seed = 0x9e3779b9
function rand() {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 0x100000000
}
function pick(arr) { return arr[Math.floor(rand() * arr.length)] }
function chance(p) { return rand() < p }
function subset(arr) { return arr.filter(() => chance(0.5)) }

const WEB_SOURCES = ['wikipedia', 'github', 'ap_news', 'arxiv', 'pubmed', 'mdn']

function randomConfig() {
  const activeTools = subset(WEB_SOURCES).map(id => ({
    id, name: id, baseUrl: `https://${id}.example`, description: '',
  }))
  // Resource grants (master plan 6.1): sometimes the config already carries
  // a folder list, as it would after one narrowing.
  const FOLDERS = ['a', 'a/x', 'b', 'c', 'c/y/z']
  const cap = () => ({ enabled: chance(0.6), ...(chance(0.3) ? { grants: subset(FOLDERS) } : {}) })
  return {
    disabledTools: chance(0.3) ? ['delete_file'] : [],
    webFetch: {
      enabled: true,
      whitelistEnabled: chance(0.7),
      allowedBaseUrls: activeTools.map(t => t.baseUrl),
      activeTools,
      maxFetchTokens: pick([500, 2000, 8000]),
      searchEngine: pick([{ kind: 'none' }, { kind: 'searxng', url: 'http://searx.lan/' }, { kind: 'brave', apiKey: 'k' }]),
    },
    postgres: cap(),
    documents: cap(),
    sqlite: cap(),
    vault: cap(),
    git: cap(),
    scholar: cap(),
    python: cap(),
    memory: cap(),
    documentSearch: cap(),
    imageGeneration: cap(),
    fileSystem: {
      enabled: chance(0.6),
      rootDir: 'C:/root',
      allowWrite: chance(0.5),
      allowDestructive: chance(0.5),
    },
  }
}

function randomPermissions() {
  const p = {}
  if (chance(0.6)) p.capabilities = subset(capabilityIds())
  if (chance(0.5)) p.webSourceIds = subset(WEB_SOURCES)
  if (chance(0.4)) p.allowWhitelistBypass = chance(0.5)
  if (chance(0.4)) p.allowWebSearchEngine = chance(0.5)
  if (chance(0.4)) p.maxFetchTokens = pick([100, 1000, 99999])
  if (chance(0.5)) p.fileSystem = { allowWrite: chance(0.5), allowDestructive: chance(0.5) }
  if (chance(0.3)) p.surfaces = ['nest-chat']
  if (chance(0.3)) p.admin = {}
  if (chance(0.5)) {
    p.grants = {}
    for (const cap of ['sqlite', 'git', 'vault']) {
      if (chance(0.6)) p.grants[cap] = subset(['a', 'a/x', 'a/w', 'b', 'c/y', 'd'])
    }
  }
  return p
}

/** Is relative folder `f` inside one of `list` (or is `list` absent: everything)? */
function grantCovers(list, f) {
  if (list === null || list === undefined) return true
  return list.some((g) => f === g || f.startsWith(`${g}/`))
}

/**
 * The whole law in one function: is `narrowed` no more permissive than `base`
 * on any field roles can touch? Returns a reason string, or null when fine.
 */
function widenedAnywhere(base, narrowed) {
  const capKeys = ['postgres', 'documents', 'sqlite', 'vault', 'git', 'scholar', 'python', 'memory', 'documentSearch', 'fileSystem']
  for (const key of capKeys) {
    if (!base[key]) continue
    if (narrowed[key].enabled === true && base[key].enabled !== true) {
      return `${key}.enabled went from ${base[key].enabled} to true`
    }
  }

  // A grant list may only narrow: every folder after must be inside one
  // before, and a list may never become "everything" again.
  for (const key of ['sqlite', 'git', 'vault']) {
    if (!base[key]) continue
    const before = base[key].grants
    const after = narrowed[key].grants
    if (before !== undefined && before !== null && (after === undefined || after === null)) return `${key}.grants went from a list to everything`
    for (const f of after ?? []) {
      if (!grantCovers(before, f)) return `${key}.grants gained "${f}"`
    }
  }

  if (base.fileSystem) {
    for (const flag of ['allowWrite', 'allowDestructive']) {
      if (narrowed.fileSystem[flag] === true && base.fileSystem[flag] !== true) {
        return `fileSystem.${flag} went from ${base.fileSystem[flag]} to true`
      }
    }
  }

  const baseBans = new Set(base.disabledTools || [])
  for (const name of baseBans) {
    if (!(narrowed.disabledTools || []).includes(name)) return `ban on "${name}" was lifted`
  }

  const baseUrls = new Set(base.webFetch.allowedBaseUrls || [])
  for (const url of narrowed.webFetch.allowedBaseUrls || []) {
    if (!baseUrls.has(url)) return `base URL "${url}" was added`
  }

  const baseToolIds = new Set((base.webFetch.activeTools || []).map(t => t.id))
  for (const tool of narrowed.webFetch.activeTools || []) {
    if (!baseToolIds.has(tool.id)) return `web source "${tool.id}" was added`
  }

  if (base.webFetch.whitelistEnabled === true && narrowed.webFetch.whitelistEnabled !== true) {
    return 'the URL whitelist was switched off'
  }

  // The engine may go to none; it may never come on, or change to another one.
  const baseEngine = base.webFetch.searchEngine?.kind ?? 'none'
  const narrowedEngine = narrowed.webFetch.searchEngine?.kind ?? 'none'
  if (narrowedEngine !== 'none' && narrowedEngine !== baseEngine) {
    return `web search engine went from ${baseEngine} to ${narrowedEngine}`
  }

  if (narrowed.webFetch.maxFetchTokens > base.webFetch.maxFetchTokens) {
    return `maxFetchTokens rose from ${base.webFetch.maxFetchTokens} to ${narrowed.webFetch.maxFetchTokens}`
  }

  return null
}

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------

console.log('\n-- the restrict-only law --')

await test('🔍 narrowing NEVER widens — 2000 randomised config × role pairs', async () => {
  for (let i = 0; i < 2000; i++) {
    const config = randomConfig()
    const permissions = randomPermissions()
    const narrowed = narrowConfig(config, permissions)
    const reason = widenedAnywhere(config, narrowed)
    assert(
      !reason,
      `case ${i} widened access: ${reason}\n        config=${JSON.stringify(config)}\n        role=${JSON.stringify(permissions)}`,
    )
  }
  return '2000 cases'
})

await test('narrowing is idempotent — applying the same role twice changes nothing further', async () => {
  for (let i = 0; i < 200; i++) {
    const config = randomConfig()
    const permissions = randomPermissions()
    const once = narrowConfig(config, permissions)
    const twice = narrowConfig(once, permissions)
    assert(
      JSON.stringify(once) === JSON.stringify(twice),
      `case ${i} was not idempotent\n        once=${JSON.stringify(once)}\n        twice=${JSON.stringify(twice)}`,
    )
  }
  return '200 cases'
})

await test('🔒 grants: an EMPTY folder list narrows to nothing, never to everything; absent inherits (master plan 6.1)', async () => {
  const base = { sqlite: { enabled: true, rootDir: 'C:/db' }, git: { enabled: true, grants: ['a', 'b'] }, vault: { enabled: true } }
  const none = narrowConfig(base, { grants: { sqlite: [], git: [] } })
  assert(Array.isArray(none.sqlite.grants) && none.sqlite.grants.length === 0, `sqlite: ${JSON.stringify(none.sqlite.grants)}`)
  assert(Array.isArray(none.git.grants) && none.git.grants.length === 0, `git: ${JSON.stringify(none.git.grants)}`)
  assert(!('grants' in none.vault), 'an absent vault entry wrote a grants field')
  const narrowed = narrowConfig(base, { grants: { git: ['a/x', 'c'], sqlite: ['reports'] } })
  assert(JSON.stringify(narrowed.git.grants) === '["a/x"]', `intersection: ${JSON.stringify(narrowed.git.grants)}`)
  assert(JSON.stringify(narrowed.sqlite.grants) === '["reports"]', `sqlite: ${JSON.stringify(narrowed.sqlite.grants)}`)
  const inherit = narrowConfig(base, {})
  assert(!('grants' in inherit.sqlite) && JSON.stringify(inherit.git.grants) === '["a","b"]', 'no role grants changed something')
})

await test('an empty permission set is the identity — this is what makes upgrades inert', async () => {
  // Full Access has permissions {}. Every existing account resolves to it, so
  // if this is not an exact identity, adding roles silently changed behaviour
  // for every account on every install.
  for (let i = 0; i < 200; i++) {
    const config = randomConfig()
    for (const empty of [{}, null, undefined]) {
      const out = narrowConfig(config, empty)
      assert(
        JSON.stringify(out) === JSON.stringify(config),
        `an empty permission set altered the config (${JSON.stringify(empty)})\n        in =${JSON.stringify(config)}\n        out=${JSON.stringify(out)}`,
      )
    }
  }
  return '200 cases × 3 empty forms'
})

// ---------------------------------------------------------------------------
// Fail posture
// ---------------------------------------------------------------------------

console.log('\n-- fail posture --')

const RESTRICTIVE = { permissions: { capabilities: [], webSourceIds: [], fileSystem: { allowWrite: false, allowDestructive: false } } }

await test('🔍 auth off (account null) is never narrowed', async () => {
  const config = randomConfig()
  const out = resolveEffectiveConfig(null, config, RESTRICTIVE)
  assert(out === config, 'a null account was narrowed — the authRequired toggle no longer means what it says')
})

await test('🔍 the owner is never narrowed, even holding a restrictive role', async () => {
  const config = randomConfig()
  const out = resolveEffectiveConfig({ id: 'o', tier: 'owner' }, config, RESTRICTIVE)
  assert(out === config, 'the owner was narrowed — this is the lockout the fail posture exists to prevent')
})

await test('an account with no role is not narrowed', async () => {
  const config = randomConfig()
  const out = resolveEffectiveConfig({ id: 'u', tier: 'user' }, config, null)
  assert(JSON.stringify(out) === JSON.stringify(config), 'a role-less account was narrowed')
})

await test('🔍 DENY_ALL permits nothing — the broken-invariant fallback', async () => {
  // Used when auth is ON but no account reached the tool dispatcher, which is a
  // plumbing bug rather than a posture. Reaching for the auth-off branch there
  // would hand a broken code path the whole tool set — and did, when the
  // Streamable HTTP transport stopped setting req.auth.
  const config = randomConfig()
  const out = narrowConfig(config, DENY_ALL)
  for (const id of capabilityIds()) {
    const key = CAPABILITY_CONFIG_KEY[id] ?? id
    assert(out[key].enabled === false, `${id} survived DENY_ALL`)
  }
  assert(out.fileSystem.allowWrite === false, 'DENY_ALL left writes on')
  assert(out.fileSystem.allowDestructive === false, 'DENY_ALL left deletes on')
  assert(out.webFetch.activeTools.length === 0, 'DENY_ALL left web sources active')
  assert(out.webFetch.allowedBaseUrls.length === 0, 'DENY_ALL left base URLs allowed')
  assert(out.webFetch.whitelistEnabled === true, 'DENY_ALL left the whitelist off')
})

await test('DENY_ALL withholds every admin permission and every surface', async () => {
  const role = { permissions: DENY_ALL }
  for (const permission of ADMIN_PERMISSIONS) {
    assert(!can({ id: 'a', tier: 'admin' }, role, permission), `DENY_ALL granted "${permission}"`)
  }
  assert(!allowsSurface({ id: 'u', tier: 'user' }, role, 'nest-chat'), 'DENY_ALL permitted a surface')
})

await test('a user-tier account IS narrowed by its role', async () => {
  const config = randomConfig()
  const out = resolveEffectiveConfig({ id: 'u', tier: 'user' }, config, RESTRICTIVE)
  for (const id of capabilityIds()) {
    const key = CAPABILITY_CONFIG_KEY[id] ?? id
    assert(out[key].enabled === false, `${id} survived a role that permits no capabilities`)
  }
})

// ---------------------------------------------------------------------------
// Capability withholding
// ---------------------------------------------------------------------------

console.log('\n-- capability withholding --')

await test('🔍 a withheld capability is disabled AND its tool names are banned', async () => {
  // Redundant on purpose: the provider's enabled flag stops tools being
  // produced, and the ban list stops the policy gate executing them. Either
  // alone would be a single point of failure at the boundary that matters most.
  const config = randomConfig()
  config.fileSystem.enabled = true
  const out = narrowConfig(config, { capabilities: ['documents'] })
  assert(out.fileSystem.enabled === false, 'a withheld capability stayed enabled')
  for (const name of CAPABILITY_TOOL_NAMES.file_system) {
    assert(out.disabledTools.includes(name), `withholding file_system did not ban "${name}"`)
  }
})

await test('a permitted capability keeps whatever the server gave it — never more', async () => {
  const config = randomConfig()
  config.documents.enabled = false
  const out = narrowConfig(config, { capabilities: capabilityIds() })
  assert(out.documents.enabled === false, 'permitting a capability the server disabled turned it ON')
})

await test('🔍 client-app tool names are never touched by role narrowing', async () => {
  // The agreed boundary: roles govern what NEST serves. Twig's tools run on the
  // user's own PC, and writing files there is the whole point of Twig — an
  // admin restricting server-side writes must not disable the user's editor.
  // Banning a client app stays an org-wide decision (CLIENT_APPS).
  const config = randomConfig()
  const out = narrowConfig(config, { capabilities: [] })
  for (const name of ['fs_read_file', 'fs_write_file', 'fs_delete_file']) {
    assert(!out.disabledTools.includes(name), `role narrowing banned the client-app tool "${name}"`)
  }
})

// ---------------------------------------------------------------------------
// Web sources
// ---------------------------------------------------------------------------

console.log('\n-- web sources --')

await test('🔍 narrowing sources narrows base URLs in lockstep', async () => {
  // These drifting apart is how a source vanishes from the model's vocabulary
  // while its URLs stay fetchable through a hand-written web_fetch call.
  const config = randomConfig()
  config.webFetch.activeTools = WEB_SOURCES.map(id => ({ id, name: id, baseUrl: `https://${id}.example`, description: '' }))
  config.webFetch.allowedBaseUrls = config.webFetch.activeTools.map(t => t.baseUrl)
  const out = narrowConfig(config, { webSourceIds: ['wikipedia'] })
  assert(out.webFetch.activeTools.length === 1, `expected 1 source, got ${out.webFetch.activeTools.length}`)
  assert(out.webFetch.allowedBaseUrls.length === 1, `expected 1 base URL, got ${out.webFetch.allowedBaseUrls.length}`)
  assert(out.webFetch.allowedBaseUrls[0] === 'https://wikipedia.example', 'the surviving URL is not the surviving source')
})

await test('🔍 naming sources forces the whitelist on, whatever the profile said', async () => {
  // Without this, a role that picks two sources while the profile has the
  // whitelist OFF restricts nothing at all: web_fetch still takes any URL.
  const config = randomConfig()
  config.webFetch.whitelistEnabled = false
  const out = narrowConfig(config, { webSourceIds: ['wikipedia'] })
  assert(out.webFetch.whitelistEnabled === true, 'a source-restricted role left the whitelist off')
})

await test('a role can force the whitelist on but never off', async () => {
  const on = narrowConfig({ ...randomConfig(), webFetch: { ...randomConfig().webFetch, whitelistEnabled: true } }, { allowWhitelistBypass: true })
  assert(on.webFetch.whitelistEnabled === true, 'a role switched the whitelist OFF')
  const config = randomConfig()
  config.webFetch.whitelistEnabled = false
  assert(narrowConfig(config, { allowWhitelistBypass: false }).webFetch.whitelistEnabled === true, 'a role failed to force the whitelist on')
})

await test('maxFetchTokens takes the minimum, in both directions', async () => {
  const config = randomConfig()
  config.webFetch.maxFetchTokens = 2000
  assert(narrowConfig(config, { maxFetchTokens: 500 }).webFetch.maxFetchTokens === 500, 'a lower role budget did not apply')
  assert(narrowConfig(config, { maxFetchTokens: 9000 }).webFetch.maxFetchTokens === 2000, 'a higher role budget RAISED the server budget')
})

// ---------------------------------------------------------------------------
// File-system policy
// ---------------------------------------------------------------------------

console.log('\n-- file-system policy --')

await test('🔍 a role can withdraw write and delete but never grant them', async () => {
  const off = { ...randomConfig(), fileSystem: { enabled: true, allowWrite: false, allowDestructive: false } }
  const widened = narrowConfig(off, { fileSystem: { allowWrite: true, allowDestructive: true } })
  assert(widened.fileSystem.allowWrite === false, 'a role granted writes the server had disabled')
  assert(widened.fileSystem.allowDestructive === false, 'a role granted DELETES the server had disabled')

  const on = { ...randomConfig(), fileSystem: { enabled: true, allowWrite: true, allowDestructive: true } }
  const tightened = narrowConfig(on, { fileSystem: { allowWrite: false, allowDestructive: false } })
  assert(tightened.fileSystem.allowWrite === false, 'a role failed to withdraw writes')
  assert(tightened.fileSystem.allowDestructive === false, 'a role failed to withdraw deletes')
})

await test('an omitted fileSystem flag inherits rather than denying', async () => {
  const on = { ...randomConfig(), fileSystem: { enabled: true, allowWrite: true, allowDestructive: true } }
  const out = narrowConfig(on, { fileSystem: { allowDestructive: false } })
  assert(out.fileSystem.allowWrite === true, 'an omitted allowWrite was treated as a denial')
  assert(out.fileSystem.allowDestructive === false, 'the stated denial did not apply')
})

// ---------------------------------------------------------------------------
// Administration
// ---------------------------------------------------------------------------

console.log('\n-- admin sub-permissions --')

const owner = { id: 'o', tier: 'owner' }
const admin = { id: 'a', tier: 'member' }
const user = { id: 'u', tier: 'member' }

await test('🔍 a member holds no administration unless a role grants it', async () => {
  for (const permission of ADMIN_PERMISSIONS) {
    assert(!can(user, null, permission), `a member with no roles held "${permission}"`)
    assert(!can(user, { permissions: combineRoles([]) }, permission), `an empty combination granted "${permission}"`)
    assert(!can(user, { permissions: combineRoles([{ permissions: { capabilities: null } }]) }, permission), `a role without an admin block granted "${permission}"`)
  }
})

await test('the owner holds every admin permission regardless of role', async () => {
  const nothingRole = { permissions: { admin: {} } }
  for (const permission of ADMIN_PERMISSIONS) {
    assert(can(owner, nothingRole, permission), `the owner lost "${permission}" to a role`)
  }
})

await test('an account holds an admin permission when any of its roles grants it', async () => {
  const combined = { permissions: combineRoles([
    { permissions: { admin: { manageAccounts: true } } },
    { permissions: { admin: { manageProjects: true } } },
  ]) }
  assert(can(user, combined, 'manageAccounts') && can(user, combined, 'manageProjects'), 'a granted permission was refused')
  assert(!can(user, combined, 'manageRoles'), 'a permission no role granted was held')
  assert(holdsAnyAdmin(combined.permissions), 'holdsAnyAdmin missed it')
})

await test('🔍 a present admin block is an explicit narrowing — omitted keys read as false', async () => {
  const role = { permissions: { admin: { manageAccounts: true } } }
  assert(can(admin, role, 'manageAccounts'), 'the granted permission was refused')
  assert(!can(admin, role, 'manageRoles'), 'an omitted permission was granted — the narrowing must fail closed')
  assert(!can(admin, role, 'managePromptBlocks'), 'an omitted permission was granted')
})

await test('an unauthenticated caller holds no admin permission', async () => {
  for (const permission of ADMIN_PERMISSIONS) {
    assert(!can(null, null, permission), `a null account held "${permission}"`)
  }
})

// ---------------------------------------------------------------------------
// Additive roles (2026-11-24): combineRoles
// ---------------------------------------------------------------------------

console.log('\n-- additive roles --')

function randomAdditiveRole() {
  const p = {}
  if (chance(0.8)) p.capabilities = chance(0.15) ? null : subset(capabilityIds())
  if (chance(0.7)) p.webSourceIds = chance(0.2) ? null : subset(WEB_SOURCES)
  if (chance(0.5)) p.allowWhitelistBypass = chance(0.5)
  if (chance(0.5)) p.allowWebSearchEngine = chance(0.5)
  if (chance(0.3)) p.maxFetchTokens = pick([100, 1000, 99999])
  if (chance(0.6)) p.fileSystem = { allowWrite: chance(0.5), allowDestructive: chance(0.5) }
  if (chance(0.3)) p.surfaces = subset(['nest-chat', 'twig', 'blueprints'])
  if (chance(0.4)) p.admin = Object.fromEntries(subset(ADMIN_PERMISSIONS).map(k => [k, true]))
  if (chance(0.5)) {
    p.grants = {}
    for (const cap of ['sqlite', 'git', 'vault']) if (chance(0.6)) p.grants[cap] = chance(0.2) ? null : subset(['a', 'a/x', 'b', 'c/y', 'd'])
  }
  return { permissions: p }
}

await test('🔍 combined roles still NEVER widen the server config — 1500 random role lists', async () => {
  for (let i = 0; i < 1500; i++) {
    const config = randomConfig()
    const held = Array.from({ length: Math.floor(rand() * 4) }, randomAdditiveRole)
    const why = widenedAnywhere(config, narrowConfig(config, combineRoles(held)))
    if (why) throw new Error(`case ${i}: ${why}\nroles: ${JSON.stringify(held)}`)
  }
  return '1500 cases'
})

await test('🔍 adding a role never takes anything away — 1500 random pairs', async () => {
  for (let i = 0; i < 1500; i++) {
    const config = randomConfig()
    const a = Array.from({ length: 1 + Math.floor(rand() * 2) }, randomAdditiveRole)
    const b = randomAdditiveRole()
    const fewer = combineRoles(a)
    const more = combineRoles([...a, b])
    if (!permissionsWithin(fewer, more)) throw new Error(`case ${i}: permissionsWithin says adding a role lost something\n${JSON.stringify({ a, b })}`)
    const why = widenedAnywhere(narrowConfig(config, more), narrowConfig(config, fewer))
    if (why) throw new Error(`case ${i}: with one role fewer the config was wider: ${why}\n${JSON.stringify({ a, b })}`)
  }
  return '1500 cases'
})

await test('no roles: no capabilities, no web sources, no search engine, no writes, no administration', async () => {
  const c = combineRoles([])
  assert(c.capabilities.length === 0 && c.webSourceIds.length === 0, JSON.stringify(c))
  assert(c.allowWebSearchEngine === false && c.fileSystem.allowWrite === false && c.fileSystem.allowDestructive === false, JSON.stringify(c))
  assert(!holdsAnyAdmin(c), 'administration from nothing')
  assert(c.surfaces === undefined, 'no roles must not lock the account out of every app')
})

await test('the built-in Full Access and Administrator roles narrow nothing, as "no role" used to', async () => {
  for (const id of ['full-access', 'administrator']) {
    const role = BUILTIN_ROLES.find(r => r.id === id)
    for (let i = 0; i < 300; i++) {
      const config = randomConfig()
      const a = JSON.stringify(narrowConfig(config, combineRoles([role])))
      const b = JSON.stringify(narrowConfig(config, {}))
      if (a !== b) throw new Error(`${id} narrowed something:\n${a}\n${b}`)
    }
  }
})

await test('lists union, one "all" opens a list, folder grants come only from roles holding the capability', async () => {
  const c = combineRoles([
    { permissions: { capabilities: ['git'], grants: { git: ['a'] }, webSourceIds: ['wikipedia'] } },
    { permissions: { capabilities: ['git', 'sqlite'], grants: { git: ['b'] }, webSourceIds: null } },
    { permissions: { capabilities: [], grants: { vault: ['secret'] } } },
  ])
  assert(JSON.stringify(c.capabilities) === '["git","sqlite"]', JSON.stringify(c.capabilities))
  assert(JSON.stringify(c.grants.git) === '["a","b"]', `git grants: ${JSON.stringify(c.grants.git)}`)
  assert(c.grants.sqlite === undefined, 'sqlite held with no folder list must be every folder')
  assert(JSON.stringify(c.grants.vault) === '[]', 'a folder grant from a role that does not hold Vault leaked through')
  assert(c.webSourceIds === undefined, 'one role with every web source must open the list')
})

await test('limits: the most generous fetch cap wins, and apps are limited only when every role limits them', async () => {
  assert(combineRoles([{ permissions: { maxFetchTokens: 100 } }, { permissions: { maxFetchTokens: 900 } }]).maxFetchTokens === 900, 'max')
  assert(combineRoles([{ permissions: { maxFetchTokens: 100 } }, { permissions: {} }]).maxFetchTokens === undefined, 'an uncapped role must lift the cap')
  assert(JSON.stringify(combineRoles([{ permissions: { surfaces: ['twig'] } }, { permissions: { surfaces: ['nest-chat'] } }]).surfaces) === '["nest-chat","twig"]', 'union')
  assert(combineRoles([{ permissions: { surfaces: ['twig'] } }, { permissions: {} }]).surfaces === undefined, 'a role with no app limit must lift it')
})

await test('🔍 permissionsWithin: equal sets are within each other; more of anything is not', async () => {
  for (let i = 0; i < 500; i++) {
    const c = combineRoles([randomAdditiveRole(), randomAdditiveRole()])
    if (!permissionsWithin(c, c)) throw new Error(`not within itself: ${JSON.stringify(c)}`)
  }
  const base = combineRoles([{ permissions: { capabilities: ['git'] } }])
  assert(!permissionsWithin(combineRoles([{ permissions: { capabilities: ['git', 'sqlite'] } }]), base), 'an extra capability was within')
  assert(!permissionsWithin(combineRoles([{ permissions: { capabilities: ['git'], admin: { manageRoles: true } } }]), base), 'an admin permission was within')
  assert(!permissionsWithin(combineRoles([{ permissions: { capabilities: ['git'], fileSystem: { allowWrite: true } } }]), base), 'file writes were within')
  assert(permissionsWithin(base, combineRoles([BUILTIN_ROLES.find(r => r.id === 'administrator')])), 'git is not within Administrator')
})

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

console.log('\n-- client surfaces --')

await test('an unrestricted role permits every surface, including an unknown one', async () => {
  assert(allowsSurface(user, { permissions: {} }, 'twig'), 'an unrestricted role blocked twig')
  assert(allowsSurface(user, { permissions: {} }, undefined), 'an unrestricted role blocked a surface-less credential')
})

await test('🔍 a surface-restricted role refuses a credential carrying no surface', async () => {
  // An account-wide API key names no app. If that were waved through, the
  // restriction would be trivially bypassable by using one — which is why
  // auth.mjs also refuses to ISSUE one to a surface-restricted account.
  const role = { permissions: { surfaces: ['nest-chat'] } }
  assert(allowsSurface(user, role, 'nest-chat'), 'the permitted surface was refused')
  assert(!allowsSurface(user, role, 'twig'), 'a surface outside the list was permitted')
  assert(!allowsSurface(user, role, undefined), 'a credential with no surface bypassed the restriction')
  assert(!allowsSurface(user, role, null), 'a null surface bypassed the restriction')
})

await test('the owner reaches the server from any surface', async () => {
  assert(allowsSurface(owner, { permissions: { surfaces: [] } }, 'twig'), 'the owner was locked out by a role')
})

await test('restrictsSurfaces detects exactly the roles that name a surface list', async () => {
  assert(restrictsSurfaces({ permissions: { surfaces: ['nest-chat'] } }), 'a restricting role was not detected')
  assert(restrictsSurfaces({ permissions: { surfaces: [] } }), 'an empty list is still a restriction')
  assert(!restrictsSurfaces({ permissions: {} }), 'an unrestricted role was reported as restricting')
  assert(!restrictsSurfaces(null), 'a null role was reported as restricting')
})

// ---------------------------------------------------------------------------
// Plugins (Trap 3) — CAPABILITY_IDS staleness. A registered plugin must be a
// first-class capability to narrowConfig, not merely present somewhere.
// ---------------------------------------------------------------------------

console.log('\n-- installed plugins are narrowable capabilities (Trap 3) --')

await test('🔍 a plugin registered via setPluginCapabilityProvider appears in capabilityIds()', async () => {
  setPluginCapabilityProvider(() => ({
    trapthree: { toolNames: ['trapthree__do_thing'], classes: {} },
  }))
  try {
    assert(capabilityIds().includes('trapthree'), 'a registered plugin is missing from capabilityIds() — narrowConfig would never see it')
  } finally {
    setPluginCapabilityProvider(null)
  }
})

await test('🔍 a role that names only OTHER capabilities withholds a plugin capability, provider flag AND its tools banned', async () => {
  setPluginCapabilityProvider(() => ({
    trapthree: { toolNames: ['trapthree__do_thing', 'trapthree__do_other'], classes: {} },
  }))
  try {
    const config = { fileSystem: { enabled: false }, trapthree: { enabled: true } }
    const narrowed = narrowConfig(config, { capabilities: ['file_system'] }) // trapthree not named
    assert(narrowed.trapthree.enabled === false, 'a plugin capability outside the allowed list stayed enabled — CAPABILITY_CONFIG_KEY fallback (id as its own key) is not wired')
    assert(narrowed.disabledTools.includes('trapthree__do_thing'), 'the withheld plugin\'s tool did not join disabledTools — a provider that ignores its own enabled flag would still serve it')
    assert(narrowed.disabledTools.includes('trapthree__do_other'), 'second tool missing from disabledTools')
  } finally {
    setPluginCapabilityProvider(null)
  }
})

await test('a role that names the plugin capability keeps it enabled', async () => {
  setPluginCapabilityProvider(() => ({
    trapthree: { toolNames: ['trapthree__do_thing'], classes: {} },
  }))
  try {
    const config = { trapthree: { enabled: true } }
    const narrowed = narrowConfig(config, { capabilities: ['trapthree'] })
    assert(narrowed.trapthree.enabled === true, 'a plugin capability explicitly permitted by the role was withheld anyway')
  } finally {
    setPluginCapabilityProvider(null)
  }
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

await test('🔍 every capability id has a config key — a new capability cannot silently skip narrowing', async () => {
  // Built-in capabilities must be in the hand-written table. Plugin ids are
  // exempt: they fall back to the id as their own config key (see narrowConfig).
  for (const id of capabilityIds()) {
    assert(id in CAPABILITY_CONFIG_KEY, `capability "${id}" has no entry in CAPABILITY_CONFIG_KEY`)
  }
  return `${capabilityIds().length} capabilities`
})

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
