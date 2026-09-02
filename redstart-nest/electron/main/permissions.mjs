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
//
// PURITY: this module imports nothing from electron and holds no state, so it
// is directly testable under plain node and cannot accumulate a per-account
// cache that outlives a request. Role LOOKUP lives in roles-storage.mjs; this
// module is handed the role object.
//
// FAIL POSTURE (agreed, see docs/notes/roles-and-permissions-plan.md):
//   account === null   → auth is off. No narrowing. The authRequired toggle
//                        keeps meaning exactly what it says.
//   tier === 'owner'   → no narrowing, and the owner cannot be assigned a role.
//                        This is the anti-lockout guarantee.
//   no role assigned   → Full Access, whose permission set is {} → no narrowing.
// =============================================================================

import { capabilityToolNames, expandDisabledToolIds } from './tools-definitions.mjs'

/**
 * Capability ids a role can grant or withhold — built-ins plus installed plugins.
 *
 * A FUNCTION. This was `Object.keys(CAPABILITY_TOOL_NAMES)` evaluated at import,
 * which silently excluded every plugin from narrowConfig — meaning roles could
 * not withhold a plugin at all. See docs/notes/mcp-plugin-system-plan.md Trap 3.
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
  fileSystem: { allowWrite: false, allowDestructive: false },
  surfaces: [],
  admin: {},
})

/**
 * Admin abilities a role can withhold from an admin-tier account.
 *
 * Deliberately only the three that exist as HTTP surfaces today. Server, model
 * and capability configuration are reachable over IPC from the Nest desktop app
 * only — physical access to the host machine, no account attached — so they are
 * not account-governed and are not listed here. That is also the permanent
 * escape hatch if a role edit goes wrong.
 */
export const ADMIN_PERMISSIONS = ['manageAccounts', 'manageRoles', 'managePromptBlocks']

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
}

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

    if (!inherits(p.maxFetchTokens)) {
      const current = typeof web.maxFetchTokens === 'number' ? web.maxFetchTokens : Infinity
      web.maxFetchTokens = Math.min(current, p.maxFetchTokens)
    }

    out.webFetch = web
  }

  return out
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
 * Tier is the CEILING and the role can only lower it — the same restrict-only
 * law as tools. A 'user'-tier account cannot be handed manageAccounts by any
 * role, so a mis-written role can widen nothing.
 *
 * An absent `admin` object inherits (full admin-tier authority, today's
 * behaviour). A PRESENT one is an explicit narrowing, so any key it omits reads
 * as false — fail-closed, matching how an explicit array narrows elsewhere.
 */
export function can(account, role, permission) {
  if (!account) return false
  if (account.tier === 'owner') return true
  if (account.tier !== 'admin') return false
  const grants = role?.permissions?.admin
  if (inherits(grants)) return true
  return grants[permission] === true
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
 * route (headless-admin-plane-plan.md decision 18).
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
 * regardless of that toggle (decision 12): two switches for two planes, rather
 * than one switch whose "off" position hands out process spawning. `?.` is what
 * makes that fall out rather than being remembered.
 */
export function mayAccessControlPlane(account) {
  return account?.tier === 'owner'
}
