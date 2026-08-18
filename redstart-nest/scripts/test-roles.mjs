// =============================================================================
// Invariant tests for electron/main/permissions.mjs — the per-account role layer.
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
} from '../electron/main/permissions.mjs'
import { CAPABILITY_TOOL_NAMES, setPluginCapabilityProvider } from '../electron/main/tools-definitions.mjs'

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
  const cap = () => ({ enabled: chance(0.6) })
  return {
    disabledTools: chance(0.3) ? ['delete_file'] : [],
    webFetch: {
      enabled: true,
      whitelistEnabled: chance(0.7),
      allowedBaseUrls: activeTools.map(t => t.baseUrl),
      activeTools,
      maxFetchTokens: pick([500, 2000, 8000]),
    },
    postgres: cap(),
    documents: cap(),
    sqlite: cap(),
    vault: cap(),
    git: cap(),
    scholar: cap(),
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
  if (chance(0.4)) p.maxFetchTokens = pick([100, 1000, 99999])
  if (chance(0.5)) p.fileSystem = { allowWrite: chance(0.5), allowDestructive: chance(0.5) }
  if (chance(0.3)) p.surfaces = ['nest-chat']
  if (chance(0.3)) p.admin = {}
  return p
}

/**
 * The whole law in one function: is `narrowed` no more permissive than `base`
 * on any field roles can touch? Returns a reason string, or null when fine.
 */
function widenedAnywhere(base, narrowed) {
  const capKeys = ['postgres', 'documents', 'sqlite', 'vault', 'git', 'scholar', 'fileSystem']
  for (const key of capKeys) {
    if (!base[key]) continue
    if (narrowed[key].enabled === true && base[key].enabled !== true) {
      return `${key}.enabled went from ${base[key].enabled} to true`
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
    const key = id === 'file_system' ? 'fileSystem' : id
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
    const key = id === 'file_system' ? 'fileSystem' : id
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
const admin = { id: 'a', tier: 'admin' }
const user = { id: 'u', tier: 'user' }

await test('🔍 tier is the ceiling — no role can make a user-tier account an admin', async () => {
  const godRole = { permissions: { admin: Object.fromEntries(ADMIN_PERMISSIONS.map(p => [p, true])) } }
  for (const permission of ADMIN_PERMISSIONS) {
    assert(!can(user, godRole, permission), `a role granted "${permission}" to a user-tier account`)
  }
})

await test('the owner holds every admin permission regardless of role', async () => {
  const nothingRole = { permissions: { admin: {} } }
  for (const permission of ADMIN_PERMISSIONS) {
    assert(can(owner, nothingRole, permission), `the owner lost "${permission}" to a role`)
  }
})

await test('an admin with no role holds every admin permission (today\'s behaviour)', async () => {
  for (const permission of ADMIN_PERMISSIONS) {
    assert(can(admin, null, permission), `an unroled admin lost "${permission}"`)
    assert(can(admin, { permissions: {} }, permission), `a Full Access admin lost "${permission}"`)
  }
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
