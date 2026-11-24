'use strict'

// =============================================================================
// Redstart Nest — Per-account permission resolution
// =============================================================================
// ONE LAW GOVERNS THIS FILE: every rule here may only TIGHTEN.
//
// narrowConfig() takes the server's resolved tool config (what the running
// profile enabled, built by gateway-config.mjs) and a role's permission set,
// and returns a config that is never more permissive on any field. There is
// deliberately no branch in this module capable of enabling something the input
// config had disabled, widening a URL whitelist, or raising a budget. That is
// what makes "roles cannot grant, only restrict" a property of the code rather
// than of the reviewer's attention — and scripts/test-roles.mjs asserts it over
// randomised inputs rather than trusting this comment.
//
// The polarity of each rule is the thing to be careful about. Several of them
// look equally plausible written backwards, and every backwards version widens
// access silently:
//
//     whitelistEnabled:  global || role forbids bypass     NOT  role ? … : global
//     allowWrite:        global && role permits            NOT  global || role
//     maxFetchTokens:    min(global, role)                 NOT  role ?? global
//     searchEngine:      role === false ? none : global    NOT  role ?? global
//
// PURITY: this module imports nothing from electron and holds no state, so it
// is directly testable under plain node and cannot accumulate a per-account
// cache that outlives a request. Role LOOKUP lives in roles-storage.mjs; this
// module is handed the role object.
//
// FAIL POSTURE:
//   account === null   → auth is off. No narrowing. The authRequired toggle
//                        keeps meaning exactly what it says.
//   tier === 'owner'   → no narrowing, and the owner cannot be assigned a role.
//                        This is the anti-lockout guarantee.
//   no roles at all    → combineRoles([]) — no capabilities, no web sources,
//                        no administration. Plain chat with the model only.
//
// ROLES ADD UP; THIS FILE STILL ONLY NARROWS (2026-11-24)
//
// Roles used to be restrictions (an absent field inherited everything). They
// are now GRANTS, as in Open WebUI, Grafana and GitLab: an account holds any
// number of roles, directly and through its groups, and may do what ANY of
// them allows. combineRoles() turns that list of grants into ONE permission
// set in the restriction shape narrowConfig() has always read, so the rule
// above — nothing here can enable what the server config has off — still
// holds unchanged, and so does the randomised test that checks it. Roles can
// grant only what the running profile has already enabled.
// =============================================================================

import { capabilityToolNames, expandDisabledToolIds } from './tools-definitions.mjs'
import { GRANTABLE, intersectGrants } from './grant-scope.mjs'

/**
 * Capability ids a role can grant or withhold — built-ins plus installed plugins.
 *
 * A FUNCTION. This was `Object.keys(CAPABILITY_TOOL_NAMES)` evaluated at import,
 * which silently excluded every plugin from narrowConfig — meaning roles could
 * not withhold a plugin at all.
 */
export function capabilityIds() {
  return Object.keys(capabilityToolNames())
}

/**
 * The permission set that permits nothing. Used for the BROKEN-INVARIANT case,
 * not for any real role.
 *
 * `account === null` legitimately means "auth is off" and is not narrowed. But
 * the same null also arrives when identity FAILED TO PLUMB THROUGH while auth is
 * on — which is not a posture, it is a bug, and it must not resolve to the
 * fail-open branch. Callers that can tell the difference (they know whether auth
 * is required) narrow with this instead. It is deliberately a permission set
 * rather than a special case inside resolveEffectiveConfig, so it goes through
 * exactly the same narrowing path as everything else and inherits the
 * restrict-only property test for free.
 */
export const DENY_ALL = Object.freeze({
  capabilities: [],
  webSourceIds: [],
  allowWebSearchEngine: false,
  fileSystem: { allowWrite: false, allowDestructive: false },
  surfaces: [],
  admin: {},
})

/**
 * Admin abilities a role can withhold from an admin-tier account.
 *
 * Deliberately only the ones that exist as HTTP surfaces. Server, model
 * and capability configuration are reachable over IPC from the Nest desktop app
 * only — physical access to the host machine, no account attached — so they are
 * not account-governed and are not listed here. That is also the permanent
 * escape hatch if a role edit goes wrong.
 *
 * manageOrgWorkflows writes the workflows every account sees (workflow-routes
 * .mjs). It is an ADMIN permission rather than one a role hands to a user for
 * the same reason as the rest: roles only tighten. A "workflow editor" is an
 * admin-tier account whose role limits administration to this one.
 */
export const ADMIN_PERMISSIONS = ['manageAccounts', 'manageRoles', 'managePromptBlocks', 'manageOrgWorkflows', 'manageProjects']

// Capability id → the config key its provider reads. file_system is camelCase
// (see the note in gateway-config.mjs — emitting snake_case there once disabled
// the whole capability in production).
export const CAPABILITY_CONFIG_KEY = {
  postgres: 'postgres',
  documents: 'documents',
  sqlite: 'sqlite',
  vault: 'vault',
  git: 'git',
  file_system: 'fileSystem',
  scholar: 'scholar',
  python: 'python',
  memory: 'memory',
  document_search: 'documentSearch',
  image_generation: 'imageGeneration',
}

/**
 * Where each grantable capability keeps its grants in the resolved config.
 * Shared Documents lives on the document_search config, beside the folder
 * it narrows (documentSearch.sharedRootDir), as `sharedGrants`.
 */
export const GRANT_CONFIG = Object.freeze({
  sqlite: { key: 'sqlite', field: 'grants' },
  git: { key: 'git', field: 'grants' },
  vault: { key: 'vault', field: 'grants' },
  shared_documents: { key: 'documentSearch', field: 'sharedGrants' },
})

/**
 * Is this permission field asking for narrowing at all?
 *
 * null/undefined means "inherit" everywhere in a role's permission set — an
 * absent field never restricts. An empty ARRAY is not absent: it means "narrow
 * to nothing", which is a real and useful setting.
 */
function inherits(value) {
  return value === null || value === undefined
}

/**
 * Narrow a resolved tool config by a role's permission set.
 *
 * @param {object} config       from buildGatewayConfig()
 * @param {object} permissions  role.permissions, or {} / null for no narrowing
 * @returns {object} a new config, never more permissive than `config`
 */
export function narrowConfig(config, permissions) {
  if (!config) return config
  const p = permissions || {}

  // --- Capabilities -------------------------------------------------------
  // A role names the capabilities it ALLOWS. Everything else is withheld two
  // ways, deliberately redundantly: the provider's `enabled` flag goes false so
  // no tool is produced, AND the capability's tool names join disabledTools so
  // the policy gate refuses them even if a provider ignores its own flag.
  const allowedCaps = inherits(p.capabilities) ? null : new Set(p.capabilities)
  const withheldCaps = allowedCaps === null ? [] : capabilityIds().filter(id => !allowedCaps.has(id))

  const out = { ...config }

  for (const id of capabilityIds()) {
    // Plugins have no hand-written config-key entry; their capability id IS
    // their config key. Falling back to the id keeps narrowing working for them
    // without a table edit per install.
    const key = CAPABILITY_CONFIG_KEY[id] ?? id
    const current = config[key]
    if (!current) continue
    const permitted = allowedCaps === null || allowedCaps.has(id)
    out[key] = { ...current, enabled: current.enabled === true && permitted }
  }

  out.disabledTools = [
    ...new Set([...(config.disabledTools || []), ...expandDisabledToolIds(withheldCaps)]),
  ]

  // --- Resource grants (master plan 6.1, grant-scope.mjs) -----------------
  // A role narrows a shared root to some of its folders. Intersection with
  // whatever the config already carries, so it only ever removes; an absent
  // entry inherits, and an EMPTY list is narrowed to nothing, never "all".
  // Written only when it narrows, so a role without grants leaves the config
  // exactly as it was.
  const roleGrants = p.grants && typeof p.grants === 'object' ? p.grants : {}
  for (const cap of GRANTABLE) {
    const key = GRANT_CONFIG[cap].key
    const field = GRANT_CONFIG[cap].field
    if (!out[key]) continue
    const next = intersectGrants(out[key][field], roleGrants[cap])
    if (next !== null) out[key] = { ...out[key], [field]: next }
  }

  // --- File system policy -------------------------------------------------
  // `&&` both sides: the role can turn a permission off, never on. `!== false`
  // on the role side is what makes an omitted field inherit rather than deny.
  if (out.fileSystem) {
    const rolePolicy = p.fileSystem || {}
    out.fileSystem = {
      ...out.fileSystem,
      allowWrite: out.fileSystem.allowWrite === true && rolePolicy.allowWrite !== false,
      allowDestructive: out.fileSystem.allowDestructive === true && rolePolicy.allowDestructive !== false,
    }
  }

  // --- Web sources --------------------------------------------------------
  if (config.webFetch) {
    const web = { ...config.webFetch }

    if (!inherits(p.webSourceIds)) {
      const allowedSources = new Set(p.webSourceIds)
      // activeTools carries the source id (added to buildGatewayConfig for this
      // purpose). Anything without an id cannot be matched against the role's
      // list, so it is withheld rather than waved through.
      const activeTools = (web.activeTools || []).filter(t => t?.id && allowedSources.has(t.id))
      web.activeTools = activeTools
      // Derived from the narrowed list, never filtered separately — these two
      // drifting apart is how a source disappears from the model's vocabulary
      // while its URLs stay fetchable.
      web.allowedBaseUrls = activeTools.map(t => t.baseUrl).filter(Boolean)
      // A role that names its sources means them. With the whitelist off,
      // web_fetch takes ANY public URL and the narrowed list would govern
      // nothing at all, so restricting sources implies enforcing the whitelist.
      web.whitelistEnabled = true
    }

    // Tighten-only: the role can force the whitelist back on, never off.
    if (p.allowWhitelistBypass === false) web.whitelistEnabled = true

    // The general web search engine (web_search source "web"). Tighten-only,
    // and there is deliberately no field that NAMES an engine: choosing one
    // would be granting. A role can turn it off under a profile that has it
    // on; it can never turn it on, or swap SearXNG for a hosted engine.
    if (p.allowWebSearchEngine === false) web.searchEngine = { kind: 'none' }

    if (!inherits(p.maxFetchTokens)) {
      const current = typeof web.maxFetchTokens === 'number' ? web.maxFetchTokens : Infinity
      web.maxFetchTokens = Math.min(current, p.maxFetchTokens)
    }

    out.webFetch = web
  }

  return out
}

// ---------------------------------------------------------------------------
// Additive roles
// ---------------------------------------------------------------------------
//
// A ROLE (roles.json version 2) is a set of GRANTS. Field by field:
//
//   capabilities          null = every capability · [ids] = those · absent = none
//   grants[cap]           null/absent = every folder of a granted capability ·
//                         [folders] = those
//   webSourceIds          null = every source · [ids] = those · absent = none
//   allowWebSearchEngine  true grants it · absent/false = not granted
//   allowWhitelistBypass  true grants it · absent/false = not granted
//   fileSystem.allowWrite / allowDestructive   true grants · absent = not
//   maxFetchTokens        a number caps this role's fetches · null/absent = no cap
//   surfaces              null/absent = any app · [ids] = only those
//   admin[perm]           true grants · absent = not
//
// Two fields default open when absent, on purpose: maxFetchTokens and surfaces
// are LIMITS on something granted elsewhere, not grants themselves, so a role
// that does not mention them does not limit them.

// The capability each folder grant belongs to. Shared Documents is read by
// document search, so that is the capability a role must hold for its folder
// list to count (test-access-migration.mjs caught this one).
const GRANT_HOLDER = Object.freeze({ sqlite: 'sqlite', git: 'git', vault: 'vault', shared_documents: 'document_search' })

const isAll = (v) => v === null
const listOf = (v) => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : [])

/**
 * Combine the roles an account holds into one permission set in the
 * RESTRICTION shape narrowConfig(), can() and allowsSurface() read (absent =
 * inherit, [] = nothing). The account may do what any role allows: lists are
 * unioned, flags are OR'd, a cap is the most generous one, and one role saying
 * "all" makes the combination "all".
 *
 * @param {object[]} roleList  role records (or anything with .permissions)
 * @returns {object} a restriction-shaped permission set
 */
export function combineRoles(roleList) {
  const perms = (roleList || []).map(r => r?.permissions || {})
  const out = { admin: {} }

  // Capabilities
  const capsAll = perms.some(p => isAll(p.capabilities))
  const caps = new Set(perms.flatMap(p => listOf(p.capabilities)))
  if (!capsAll) out.capabilities = [...caps].sort()
  const grantsCap = (p, cap) => isAll(p.capabilities) || listOf(p.capabilities).includes(GRANT_HOLDER[cap] ?? cap)

  // Folder grants, per grantable capability: only the roles that grant the
  // capability have a say. One of them leaving folders open opens them all.
  const grants = {}
  for (const cap of GRANTABLE) {
    const holders = perms.filter(p => grantsCap(p, cap))
    if (holders.length === 0) { grants[cap] = []; continue }
    const open = holders.some(p => p.grants?.[cap] === null || p.grants?.[cap] === undefined)
    if (!open) grants[cap] = [...new Set(holders.flatMap(p => listOf(p.grants[cap])))].sort()
  }
  if (Object.keys(grants).length) out.grants = grants

  // Web
  if (!perms.some(p => isAll(p.webSourceIds))) out.webSourceIds = [...new Set(perms.flatMap(p => listOf(p.webSourceIds)))].sort()
  if (!perms.some(p => p.allowWebSearchEngine === true)) out.allowWebSearchEngine = false
  if (!perms.some(p => p.allowWhitelistBypass === true)) out.allowWhitelistBypass = false
  const caps2 = perms.map(p => p.maxFetchTokens)
  if (perms.length && caps2.every(c => typeof c === 'number' && c > 0)) out.maxFetchTokens = Math.max(...caps2)

  // File system
  out.fileSystem = {
    allowWrite: perms.some(p => p.fileSystem?.allowWrite === true),
    allowDestructive: perms.some(p => p.fileSystem?.allowDestructive === true),
  }
  // narrowConfig reads `!== false` as inherit, so a granted flag is left out.
  if (out.fileSystem.allowWrite) delete out.fileSystem.allowWrite
  if (out.fileSystem.allowDestructive) delete out.fileSystem.allowDestructive

  // Surfaces: a limit, open unless every role names its apps.
  if (perms.length && perms.every(p => Array.isArray(p.surfaces))) out.surfaces = [...new Set(perms.flatMap(p => p.surfaces))].sort()

  for (const perm of ADMIN_PERMISSIONS) {
    if (perms.some(p => p.admin?.[perm] === true)) out.admin[perm] = true
  }
  return out
}

/**
 * Is every permission in `inner` also held by `outer`? Both are in the
 * restriction shape (combineRoles output). This is the escalation rule: an
 * admin may only hand out, or manage someone holding, what they hold
 * themselves. Absent in `outer` means "all"; absent in `inner` means it wants
 * all, so `outer` must be absent too.
 */
export function permissionsWithin(inner, outer) {
  const a = inner || {}
  const b = outer || {}
  const listWithin = (x, y) => inherits(y) || (!inherits(x) && x.every(v => y.includes(v)))
  if (!listWithin(a.capabilities, b.capabilities)) return false
  for (const cap of GRANTABLE) {
    if (!listWithin(a.grants?.[cap], b.grants?.[cap])) {
      // A capability the inner set does not hold at all has nothing to compare.
      const innerHolds = inherits(a.capabilities) || a.capabilities.includes(GRANT_HOLDER[cap] ?? cap)
      if (innerHolds) return false
    }
  }
  if (!listWithin(a.webSourceIds, b.webSourceIds)) return false
  if (a.allowWebSearchEngine !== false && b.allowWebSearchEngine === false) return false
  if (a.allowWhitelistBypass !== false && b.allowWhitelistBypass === false) return false
  if (a.fileSystem?.allowWrite !== false && b.fileSystem?.allowWrite === false) return false
  if (a.fileSystem?.allowDestructive !== false && b.fileSystem?.allowDestructive === false) return false
  if (!inherits(b.maxFetchTokens) && (inherits(a.maxFetchTokens) || a.maxFetchTokens > b.maxFetchTokens)) return false
  if (!listWithin(a.surfaces, b.surfaces)) return false
  for (const perm of ADMIN_PERMISSIONS) {
    if (a.admin?.[perm] === true && b.admin?.[perm] !== true) return false
  }
  return true
}

/** Does this combined permission set carry any administration at all? */
export function holdsAnyAdmin(permissions) {
  return ADMIN_PERMISSIONS.some(p => permissions?.admin?.[p] === true)
}

/**
 * The config an account should be served, given the server's config and the
 * account's role. This is the only entry point callers need.
 *
 * @param {object|null} account  from authenticate(); null when auth is off
 * @param {object} config        from buildGatewayConfig()
 * @param {object|null} role     from roles-storage getRoleForAccount()
 */
export function resolveEffectiveConfig(account, config, role) {
  if (!account) return config                  // auth off — see FAIL POSTURE
  if (account.tier === 'owner') return config  // anti-lockout
  return narrowConfig(config, role?.permissions)
}

// ---------------------------------------------------------------------------
// Administration
// ---------------------------------------------------------------------------

/**
 * May this account perform an admin action?
 *
 * Administration is granted by roles, like everything else: the account holds
 * a permission when one of its roles grants it. `role` is the COMBINED role
 * (auth.mjs roleFor), so an absent `admin` block grants nothing — fail-closed.
 * The owner holds every permission and cannot be narrowed.
 */
export function can(account, role, permission) {
  if (!account) return false
  if (account.tier === 'owner') return true
  return role?.permissions?.admin?.[permission] === true
}

/**
 * May this account reach the server through this client surface?
 *
 * HONEST LIMITS. A surface is only trustworthy when it arrives on a
 * per-connector client key, where it was bound at issue time (auth.mjs §8).
 * A session token carries no surface of its own — the chat-ui is what uses
 * sessions, so `authenticate()` tags them 'nest-chat', but any client that
 * posts a username and password gets one too. So this is an organisational
 * control that is HARD for client keys and SOFT for passwords, and the UI says
 * so. The account-wide API key case is closed differently: a surface-restricted
 * account cannot mint one at all (see auth.mjs regenerateApiKey), because a
 * credential carrying no surface would otherwise be a way around the whole
 * setting.
 */
export function allowsSurface(account, role, surface) {
  if (!account) return true
  if (account.tier === 'owner') return true
  const allowed = role?.permissions?.surfaces
  if (inherits(allowed)) return true
  return typeof surface === 'string' && allowed.includes(surface)
}

/** Does this role restrict which surfaces its members may connect from? */
export function restrictsSurfaces(role) {
  return !inherits(role?.permissions?.surfaces)
}

// ---------------------------------------------------------------------------
// The control plane
// ---------------------------------------------------------------------------

/**
 * May this account reach the CONTROL plane at all?
 *
 * One function, called by every admin route, so widening the rule later — a
 * second owner, a delegated admin — is one edit rather than an audit of every
 * route.
 *
 * NOT a role permission, deliberately. Permissions in this file may only ever
 * TIGHTEN a tier, and the owner ignores narrowing entirely (see can() above and
 * the FAIL POSTURE note at the top). A control-plane permission held by the
 * owner would therefore be permanently true and never consulted — machinery
 * that does nothing and can be got wrong. It earns its place the day a
 * non-owner can hold it, and not before.
 *
 * NOTE THE POLARITY AGAINST `authRequired`. Everywhere else in this codebase,
 * `account === null` means "auth is off, do not narrow" — the fail-OPEN branch,
 * and correctly so for the data plane, where the toggle means what it says.
 * Here the same null is a refusal, because control-plane auth is mandatory
 * regardless of that toggle: two switches for two planes, rather
 * than one switch whose "off" position hands out process spawning. `?.` is what
 * makes that fall out rather than being remembered.
 */
export function mayAccessControlPlane(account) {
  return account?.tier === 'owner'
}
