'use strict'

// =============================================================================
// Redstart Nest — Auth
// =============================================================================
// Central place for password hashing, API keys, and session tokens. Both
// tools-gateway.mjs and mcp-server.mjs call authenticate(req) here rather
// than touching accounts-storage.mjs directly, so there is exactly one
// resolution path from "incoming request" to "account" in each process.
//
// Auth is ON by default (accounts-storage defaults authRequired: true) and
// there is deliberately NO localhost exemption — every HTTP client, including
// a browser on the host machine, must authenticate. The launcher itself talks
// to the main process over IPC, not HTTP, so owner bootstrap never needs a
// token. Toggling authRequired off opens the gateway to everyone, matching
// plain llama.cpp behavior for home setups that don't want accounts.
// =============================================================================

import * as crypto from 'crypto'
import * as accounts from './accounts-storage.mjs'
import * as roles from './roles-storage.mjs'
import * as groups from './groups-storage.mjs'
import { can, allowsSurface, restrictsSurfaces, combineRoles, permissionsWithin, holdsAnyAdmin } from './permissions.mjs'
import { validateGrants } from './grant-scope.mjs'
import { isKnownSurface } from './system-prompt.mjs'
import * as sessionStore from './sessions-storage.mjs'

// TWO PLANES, TWO SESSION LIFETIMES. 30 days was chosen for a chat client and
// is right for one. Thirty days of standing access to something that starts and
// stops processes is not, and it is exactly the kind of number nobody revisits
// once shipped, so the control plane gets its own from the start. Both slide,
// so an admin who works on the box daily is never logged out mid-task; what
// the shorter one bounds is a
// FORGOTTEN session — a browser tab left open on a laptop that then leaves the
// building.
const SESSION_TTL_MS = {
  data: 30 * 24 * 60 * 60 * 1000, // 30 days, sliding — unchanged
  control: 12 * 60 * 60 * 1000,   // 12 hours, sliding
}

export const DATA_PLANE = 'data'
export const CONTROL_PLANE = 'control'

// ---------------------------------------------------------------------------
// Password hashing (scrypt — no native deps, no Electron ABI rebuild)
// ---------------------------------------------------------------------------

export function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, 64)
  return { passwordHash: hash.toString('hex'), passwordSalt: salt.toString('hex') }
}

export function verifyPassword(password, passwordHash, passwordSalt) {
  const salt = Buffer.from(passwordSalt, 'hex')
  const candidate = crypto.scryptSync(password, salt, 64)
  const stored = Buffer.from(passwordHash, 'hex')
  if (candidate.length !== stored.length) return false
  return crypto.timingSafeEqual(candidate, stored)
}

// ---------------------------------------------------------------------------
// API keys — long-lived bearer credentials for OpenAI-compatible tool clients
// (Kilo Code, Continue, etc.). Stored only as a hash, like a password.
// ---------------------------------------------------------------------------

export function generateApiKey() {
  return 'rst_' + crypto.randomBytes(24).toString('hex')
}

// Plain SHA-256, deliberately NOT scrypt: API keys are 24 CSPRNG bytes (192 bits
// of entropy), not human-chosen passwords, so offline brute force of the hash is
// infeasible and a slow KDF adds nothing. The hash must also stay deterministic
// and salt-free so findByApiKeyHash() can resolve a presented key with one hash
// and a scan of string comparisons; a salted KDF would force an scrypt run per
// stored account per request — a DoS vector, not a hardening. Passwords — the
// low-entropy secret — go through scrypt with a per-record salt above.
//
// CodeQL: js/insufficient-password-hash — flagged here, dismissed as "won't fix".
// The rule is correct about passwords and this is not one; it cannot distinguish
// a 192-bit machine-generated token from a user-chosen secret. Storing
// high-entropy API tokens under a fast hash is standard practice (GitHub,
// Stripe, AWS). Do NOT "fix" this by switching to scrypt: it would satisfy the
// scanner while making the system materially worse. See docs/security.md
// (Static analysis) for the full triage note.
//
// The available real upgrade is HMAC-SHA256 under a DPAPI-protected pepper (the
// secrets.mjs machinery already exists), which keeps determinism and lookup cost
// but makes a stolen accounts.json useless on its own. It would not silence the
// alert either — HMAC-SHA256 is still a fast hash — so it is worth doing on its
// own merits or not at all.
export function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex')
}

// ---------------------------------------------------------------------------
// Sessions — persisted and hashed. See sessions-storage.mjs for the storage
// contract; what lives here is the policy.
// ---------------------------------------------------------------------------
// A session is BOUND TO ITS PLANE at creation, and each plane accepts only its
// own. This is what makes plane separation structural rather than remembered:
// the gateway issues data-plane sessions, the admin listener issues
// control-plane ones, and an owner who logs into the chat UI therefore does NOT
// thereby hold a credential that can start and stop processes. Only the
// control-plane listener can mint control-plane access.
//
// The token is stored only as a hash. Clients must handle a 401 from /auth/me by
// clearing their stored token and re-showing the login form, not by looping.
//
// NOTE: the session deliberately stores NO authority — no tier, no roleId.
// It used to cache `role`, which nothing authorised off (authenticate() re-reads
// the record by id), but a stale authority field sitting in a session record is
// exactly the thing a later change reaches for. Every permission decision reads
// the account and its role fresh, which is also what makes a role edit take
// effect on the very next request instead of at next login. Persisting sessions
// makes that rule matter MORE, not less: a stale authority field would now
// outlive a restart.
function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function createSession(account, plane) {
  const token = crypto.randomBytes(32).toString('hex')
  sessionStore.insertSession({
    tokenHash: hashSessionToken(token),
    accountId: account.id,
    username: account.username,
    plane,
    expiresAt: Date.now() + SESSION_TTL_MS[plane],
  })
  return token
}

/**
 * Resolve a token to its session, if it is live AND belongs to this plane.
 *
 * The plane check is not a second gate bolted on: a token for the other plane is
 * not a valid credential HERE at all, and reporting it as invalid is both true
 * and the only answer that does not leak which planes a token opens.
 */
function validateSession(token, plane) {
  const tokenHash = hashSessionToken(token)
  const session = sessionStore.findByTokenHash(tokenHash)
  if (!session) return null
  if (session.plane !== plane) return null
  sessionStore.touchSession(tokenHash, Date.now() + SESSION_TTL_MS[plane]) // sliding
  return session
}

export function revokeSession(token) {
  sessionStore.deleteByTokenHash(hashSessionToken(token))
}

export function revokeSessionsForAccount(accountId) {
  sessionStore.deleteForAccount(accountId)
}

// ---------------------------------------------------------------------------
// Request authentication
// ---------------------------------------------------------------------------

function bearerToken(req) {
  const header = req.headers['authorization'] || ''
  if (!/^bearer /i.test(header)) return null
  const token = header.slice(7).trim()
  return token || null
}

function toPublicAccount(record) {
  if (!record) return null
  const tier = record.tier === 'owner' ? 'owner' : 'member'
  const isAdmin = tier === 'owner' || holdsAnyAdmin(roleFor(record)?.permissions)
  return {
    id: record.id,
    username: record.username,
    tier,
    // The old three-tier name, derived: Twig, Blueprints and Yellowscript read
    // `role` to decide whether to show admin screens, and "admin" there means
    // "holds some administration", which is what this says.
    role: tier === 'owner' ? 'owner' : isAdmin ? 'admin' : 'user',
    isAdmin,
    roleIds: Array.isArray(record.roleIds) ? record.roleIds : [],
    groupIds: groups.groupsForAccount(record.id).map(g => g.id),
    apiKeyPrefix: record.apiKeyPrefix,
    createdAt: record.createdAt,
    lastLoginAt: record.lastLoginAt ?? null,
    status: record.status === 'disabled' ? 'disabled' : 'active',
  }
}

// ---------------------------------------------------------------------------
// Who may manage whom
// ---------------------------------------------------------------------------
// Nobody manages the owner (recovery is the launcher's re-bootstrap). The owner
// manages everyone else. Anyone else needs manageAccounts AND may only manage
// an account with LESS access than their own: every right it holds they hold,
// and they hold something it does not. That is the general form of the old
// "an admin manages users, not other admins" — two Administrators cannot
// delete each other, and only the owner makes a peer of an admin — and it is
// the same rule as putting someone in a role (resolveRoleAssignment).

function strictlyWithin(inner, outer) {
  return permissionsWithin(inner, outer) && !permissionsWithin(outer, inner)
}

function canManage(actor, target) {
  if (!target || target.tier === 'owner') return false
  if (actor?.tier === 'owner') return true
  if (!canDo(actor, 'manageAccounts')) return false
  return strictlyWithin(roleFor(target)?.permissions, roleFor(actor)?.permissions)
}

/** Gateway route-level gate: does this account hold any administration? */
export function hasAdminAccess(account) {
  if (!account) return false
  return account.tier === 'owner' || holdsAnyAdmin(roleFor(account)?.permissions)
}

// ---------------------------------------------------------------------------
// Roles an account holds, combined — the entry points routes call.
// ---------------------------------------------------------------------------

/** The role records an account holds: its own, then its groups'. */
export function rolesFor(account) {
  if (!account) return []
  // The stored record wins over whatever object the caller holds, so a role
  // change applies even to an account object read before it. An object with
  // no stored record (a test fixture) is read as given.
  const record = accounts.findById(account.id) ?? account
  const own = Array.isArray(record?.roleIds) ? record.roleIds : []
  const viaGroups = groups.groupsForAccount(account.id).flatMap(g => g.roleIds)
  return roles.resolveRoles([...own, ...viaGroups])
}

/**
 * The account's roles combined into one role-shaped object, which is what
 * permissions.mjs reads (resolveEffectiveConfig, can, allowsSurface). Looked
 * up on every call: a role, group or membership edit applies to the very next
 * request.
 */
export function roleFor(account) {
  if (!account) return null
  const held = rolesFor(account)
  return {
    id: 'combined',
    name: held.map(r => r.name).join(', ') || 'No roles',
    roles: held,
    permissions: combineRoles(held),
  }
}

/** May this account perform an admin action? See ADMIN_PERMISSIONS. */
export function canDo(account, permission) {
  return can(account, roleFor(account), permission)
}

/** May this account reach the server through this client surface? */
export function surfacePermitted(account, surface) {
  return allowsSurface(account, roleFor(account), surface)
}

/**
 * Who a background task runs as, now (agent-runtime Phase 3, D22): looked up
 * again before every turn, so a disabled account or a deleted one stops its
 * task at the next turn, the way the next request from it would be refused.
 * Mirrors authenticate(): with auth off every caller is the null account.
 *
 * @param {string | null} accountId the account that started the task
 * @returns {{ ok: true, account: object | null } | { ok: false, reason: string }}
 */
export function accountForTask(accountId) {
  if (!accounts.getAuthRequired()) return { ok: true, account: null }
  if (!accountId) return { ok: false, reason: 'Login was turned on after this task started, and it has no account.' }
  const record = accounts.findById(accountId)
  if (!record) return { ok: false, reason: 'The account that started this task no longer exists.' }
  if (record.status === 'disabled') return { ok: false, reason: 'The account that started this task is disabled.' }
  return { ok: true, account: toPublicAccount(record) }
}

export function authenticate(req) {
  if (!accounts.getAuthRequired()) return { ok: true, account: null }

  const token = bearerToken(req)
  if (token) {
    const session = validateSession(token, DATA_PLANE)
    if (session) {
      const record = accounts.findById(session.accountId)
      // A session is tagged 'nest-chat' because the chat UI is what logs in
      // with a password; nothing else in the product does. It is a weaker claim
      // than a per-connector key's bound surface — any client that posts
      // credentials gets a session too — which is why surface restriction is
      // documented as hard for client keys and soft for passwords.
      if (record && record.status !== 'disabled') {
        return { ok: true, account: toPublicAccount(record), surface: 'nest-chat' }
      }
    }

    const record = accounts.findByApiKeyHash(hashApiKey(token))
    if (record && record.status !== 'disabled') {
      return { ok: true, account: toPublicAccount(record) }
    }

    // Per-connector credential (spec §8). The surface travels with the key, so
    // the server knows which app is calling without trusting a header. Checked
    // after the account-wide key so an existing key keeps its exact behaviour.
    const bound = accounts.findByClientKeyHash(hashApiKey(token))
    if (bound && bound.account.status !== 'disabled') {
      return {
        ok: true,
        account: toPublicAccount(bound.account),
        surface: bound.clientKey.surface,
        clientKeyId: bound.clientKey.id,
      }
    }
  }

  // No (valid) token — require authentication from every client, localhost
  // included ("authenticate or don't get in"; see the module header).
  return { ok: false, reason: 'unauthorized' }
}

// ---------------------------------------------------------------------------
// Control-plane authentication
// ---------------------------------------------------------------------------
// A SECOND, deliberately narrower door. Not a variant of authenticate() with a
// flag, because the two differ on both of the things authenticate() decides,
// and each difference is load-bearing:
//
//   1. It never reads getAuthRequired(). `authRequired` governs the data plane
//      only; control-plane auth is mandatory regardless. Note this is not
//      merely "auth off must not let anyone in" — routing the
//      control plane through authenticate() would ALSO lock the owner OUT with
//      auth off, since that function short-circuits to account: null before it
//      ever looks at the token. Both halves are wrong, and one function that
//      ignores the toggle entirely fixes both.
//
//   2. CONTROL-PLANE SESSIONS ONLY, which is two refusals in one. An
//      account-wide API key resolves to the same account and the same tier, but
//      it is a credential users paste into third-party tool clients (Kilo Code,
//      Continue, a Twig install on someone's laptop); if it opened the control
//      plane, every one of those config files would hold a process-spawning
//      admin credential. Per-connector keys are refused for the same reason. And
//      a session minted by the GATEWAY is refused too — the owner logging into
//      the chat UI must not thereby hold process control. Only a session issued
//      by this listener's own login route gets in, and it carries a 12-hour
//      life rather than the data plane's 30 days.
//
// Authorization is NOT decided here: the caller pairs this with
// mayAccessControlPlane(). Authentication answers "who is this", the
// permissions module answers "may they" — same split as the gateway.
//
// No `surface` is returned. Surfaces exist so a role can narrow which apps an
// account may connect from, and the control plane never narrows. A
// 'nest-admin' entry in SURFACE_IDS would be assignable in a role's surface
// list like any other, which is precisely the quiet collapse of plane
// separation this design warns against.
export function authenticateControlPlane(req) {
  const token = bearerToken(req)
  if (!token) return { ok: false, reason: 'unauthorized' }

  const session = validateSession(token, CONTROL_PLANE)
  if (!session) return { ok: false, reason: 'unauthorized' }

  const record = accounts.findById(session.accountId)
  if (!record || record.status === 'disabled') return { ok: false, reason: 'unauthorized' }

  return { ok: true, account: toPublicAccount(record) }
}

// ---------------------------------------------------------------------------
// Account actions — one place both gateway routes and IPC handlers call
// through, so nothing bypasses session revocation on delete/reset.
// ---------------------------------------------------------------------------

/**
 * Exchange a username and password for a session on ONE plane.
 *
 * `plane` defaults to the data plane so every existing caller (the gateway's
 * /auth/login) keeps its exact behaviour. The control plane asks for its own
 * explicitly, which is the point: a credential minted here for the chat UI must
 * never open process control.
 */
export function login(username, password, plane = DATA_PLANE) {
  const record = accounts.findByUsername(username)
  if (!record || !verifyPassword(password, record.passwordHash, record.passwordSalt)) {
    return { ok: false, error: 'Invalid username or password' }
  }
  if (record.status === 'disabled') {
    return { ok: false, error: 'This account has been disabled' }
  }
  accounts.updateAccount(record.id, { lastLoginAt: new Date().toISOString() })
  const token = createSession(record, plane)
  return { ok: true, token, user: toPublicAccount(record) }
}

export function logout(req) {
  const token = bearerToken(req)
  if (token) revokeSession(token)
}

// Every account, each saying whether the actor may change it. Admins see
// everyone now (not only user-tier accounts): with groups and shared projects
// they pick people by name, and "who are the other admins" is no longer a
// secret worth the confusion of half a list. What they may CHANGE is still
// canManage().
export function listAccounts(actor) {
  return accounts.listAccounts().map(a => ({ ...toPublicAccount(a), canEdit: canManage(actor, a) }))
}

export function getAuthRequired() {
  return accounts.getAuthRequired()
}

export function setAuthRequired(required) {
  return accounts.setAuthRequired(required)
}

export function hasOwner() {
  return accounts.hasOwner()
}

/**
 * Normalise what a caller asks an account to hold. `roleIds` is the new shape;
 * `roleId` and `tier: 'admin'` are what older clients send.
 */
function requestedRoleIds({ roleIds, roleId, tier, role }) {
  if (Array.isArray(roleIds)) return [...new Set(roleIds.filter(x => typeof x === 'string' && x))]
  const out = []
  if ((tier ?? role) === 'admin') out.push('administrator')
  if (typeof roleId === 'string' && roleId) out.push(roleId)
  return out.length ? out : [roles.DEFAULT_ROLE_ID]
}

export function createAccount(actor, { username, password, roleIds, roleId, tier, role }) {
  if (!actor || (actor.tier !== 'owner' && !canDo(actor, 'manageAccounts'))) {
    return { ok: false, error: 'Not permitted to create accounts' }
  }
  if (accounts.findByUsername(username)) {
    return { ok: false, error: 'Username already exists' }
  }
  const assignment = resolveRoleAssignment(actor, requestedRoleIds({ roleIds, roleId, tier, role }))
  if (!assignment.ok) return assignment
  // The third door onto the same rule the regenerate paths already guard: an
  // account-wide key names no app, so issuing one to a surface-restricted
  // account hands out the bypass at creation time.
  if (restrictsSurfaces({ permissions: combineRoles(roles.resolveRoles(assignment.roleIds)) })) {
    return { ok: false, error: 'These roles limit which apps the account may connect from, and an account-wide API key carries no app identity. Create the account without them and add them after the user has issued a per-connector key.' }
  }
  const apiKey = generateApiKey()
  const now = new Date().toISOString()
  const record = {
    id: crypto.randomUUID(),
    username,
    tier: 'member',
    role: 'member',
    roleIds: assignment.roleIds,
    ...hashPassword(password),
    apiKeyHash: hashApiKey(apiKey),
    apiKeyPrefix: apiKey.slice(0, 8),
    createdAt: now,
    updatedAt: now,
    createdBy: actor?.id ?? null,
  }
  const account = accounts.insertAccount(record)
  return { ok: true, account: toPublicAccount(account), apiKey }
}

// Bootstrap flow only — called from Redstart Nest's own launcher (physical
// access to the host machine), not from any HTTP route. Deliberately
// separate from createAccount() rather than an "allow owner" escape hatch
// there, so the owner-creation path can't be reached any other way.
export function createOwner({ username, password }) {
  if (accounts.hasOwner()) return { ok: false, error: 'An owner account already exists' }
  if (accounts.findByUsername(username)) return { ok: false, error: 'Username already exists' }
  const apiKey = generateApiKey()
  const now = new Date().toISOString()
  const record = {
    id: crypto.randomUUID(),
    username,
    tier: 'owner',
    role: 'owner',
    // The owner is never narrowed (permissions.mjs FAIL POSTURE) and holds no
    // roles, so nothing can be assigned to it later either.
    roleIds: [],
    ...hashPassword(password),
    apiKeyHash: hashApiKey(apiKey),
    apiKeyPrefix: apiKey.slice(0, 8),
    createdAt: now,
    updatedAt: now,
    createdBy: null,
  }
  const account = accounts.insertAccount(record)
  return { ok: true, account, apiKey }
}

/**
 * Re-key the owner: set its username and password to a new pair.
 *
 * The other half of ONE DOOR. POST /admin/bootstrap creates the first owner if
 * there is none and lands here if there is one, because "nobody can get in" and
 * "nobody has been created yet" are the same question asked at different times,
 * and giving them two routes means one of them is a recovery path that has to be
 * argued about separately.
 *
 * PRESERVES EVERYTHING BUT THE CREDENTIAL — accounts, roles, per-connector keys
 * and tools config all survive. That is the entire gain over the last-resort
 * wipe (stop the daemon, delete accounts.json, start again), which is still the
 * documented answer when the goal is to invalidate everything rather than to get
 * back in. Note that the owner's account-wide API key survives too, so a reset
 * performed because the box changed hands is not by itself a revocation.
 *
 * No `actor`: the authority here is the bootstrap token, checked at the route.
 * Taking an actor would imply someone is logged in, and the case this exists for
 * is precisely that nobody can be.
 */
export function resetOwner({ username, password }) {
  const owner = accounts.listAccounts().find(a => a.tier === 'owner')
  if (!owner) return { ok: false, error: 'No owner account exists' }

  const clash = accounts.findByUsername(username)
  if (clash && clash.id !== owner.id) return { ok: false, error: 'Username already exists' }

  const account = accounts.updateAccount(owner.id, { username, ...hashPassword(password) })
  if (!account) return { ok: false, error: 'Account not found' }

  // Whoever held a session under the old password does not keep one under the
  // new. This is the point of the reset, not a side effect of it.
  revokeSessionsForAccount(owner.id)
  return { ok: true, account }
}

export function deleteAccount(actor, id) {
  const target = accounts.findById(id)
  if (!target) return { ok: false, error: 'Account not found' }
  if (!canManage(actor, target)) return { ok: false, error: 'Not permitted to delete this account' }
  const removed = accounts.deleteAccount(id)
  if (removed) {
    revokeSessionsForAccount(id)
    groups.removeMemberEverywhere(id)
  }
  return { ok: removed }
}

export function resetPassword(actor, id, newPassword) {
  const target = accounts.findById(id)
  if (!target) return { ok: false, error: 'Account not found' }
  if (!canManage(actor, target)) return { ok: false, error: 'Not permitted to reset this account' }
  const account = accounts.updateAccount(id, hashPassword(newPassword))
  if (account) revokeSessionsForAccount(id)
  return { ok: true, account }
}

// An account-wide API key carries NO surface. That is fine in general — it is
// how the OpenAI-compatible tool clients authenticate — but it is a hole in one
// specific case: if the account's role restricts which client surfaces it may
// connect from, a credential that names no surface would be a way straight
// around that setting. So the two features are made mutually exclusive at the
// point of issue, in both the admin and self-service paths, rather than left as
// a caveat in the docs. Such an account uses per-connector keys, which bind a
// surface at issue time.
function apiKeyBlockedBySurfaceRule(account) {
  const role = roleFor(account)
  if (!restrictsSurfaces(role)) return null
  return `This account's roles (${role?.name}) limit which apps it may connect from, and an account-wide API key carries no app identity. Issue a per-connector key instead.`
}

export function regenerateApiKey(actor, id) {
  const target = accounts.findById(id)
  if (!target) return { ok: false, error: 'Account not found' }
  if (!canManage(actor, target)) return { ok: false, error: 'Not permitted to modify this account' }
  const blocked = apiKeyBlockedBySurfaceRule(target)
  if (blocked) return { ok: false, error: blocked }
  const apiKey = generateApiKey()
  const account = accounts.updateAccount(id, { apiKeyHash: hashApiKey(apiKey), apiKeyPrefix: apiKey.slice(0, 8) })
  return { ok: true, account, apiKey }
}

// ---------------------------------------------------------------------------
// Roles — the admin-defined capability layer (roles-storage.mjs).
//
// Every one of these is gated on 'manageRoles' at the route, but the
// escalation check lives HERE because it is about the actor's own authority
// rather than about reaching the route.
// ---------------------------------------------------------------------------

/**
 * Refuse an actor handing out anything they do not hold themselves.
 *
 * With additive roles this covers every field, not only administration: an
 * admin with manageRoles could otherwise mint a role granting Postgres, assign
 * it to an account they control, and log in as it. `permissions` is in the
 * combined (restriction) shape. The owner holds everything.
 */
function assertNoEscalation(actor, permissions, verb) {
  if (actor?.tier === 'owner') return { ok: true }
  if (!actor) return { ok: false, error: 'Not authenticated' }
  if (!permissionsWithin(permissions, roleFor(actor)?.permissions)) {
    return { ok: false, error: `Not permitted to ${verb} something you do not hold yourself` }
  }
  return { ok: true }
}

/**
 * Check the roles an actor wants to put on an account (or a group). The
 * result must be LESS than the actor holds, not equal — the canManage() rule,
 * so an admin can never create a peer they then cannot manage.
 */
function resolveRoleAssignment(actor, roleIds) {
  const held = roles.resolveRoles(roleIds)
  if (held.length !== new Set(roleIds).size) return { ok: false, error: 'Role not found' }
  if (actor?.tier !== 'owner') {
    if (!actor) return { ok: false, error: 'Not authenticated' }
    if (!strictlyWithin(combineRoles(held), roleFor(actor)?.permissions)) {
      return { ok: false, error: 'Not permitted to give someone as much access as you have, or more. Only the owner can.' }
    }
  }
  return { ok: true, roleIds: held.map(r => r.id) }
}

export function listRoles() {
  return roles.listRoles()
}

const ADDITIVE_LISTS = ['capabilities', 'webSourceIds', 'surfaces']

/** A role's permissions as the client sent them, reduced to known fields. */
function cleanPermissions(p) {
  const src = p && typeof p === 'object' ? p : {}
  const out = {}
  for (const key of ADDITIVE_LISTS) {
    if (src[key] === null) out[key] = null
    else if (Array.isArray(src[key])) out[key] = [...new Set(src[key].filter(x => typeof x === 'string'))]
  }
  for (const key of ['allowWebSearchEngine', 'allowWhitelistBypass']) if (src[key] === true) out[key] = true
  out.fileSystem = { allowWrite: src.fileSystem?.allowWrite === true, allowDestructive: src.fileSystem?.allowDestructive === true }
  if (typeof src.maxFetchTokens === 'number' && src.maxFetchTokens > 0) out.maxFetchTokens = Math.floor(src.maxFetchTokens)
  if (src.grants && typeof src.grants === 'object') out.grants = src.grants
  const admin = {}
  for (const k of Object.keys(src.admin || {})) if (src.admin[k] === true) admin[k] = true
  out.admin = admin
  return out
}

export function saveRole(actor, role) {
  if (!role?.name?.trim()) return { ok: false, error: 'Role name required' }
  const id = role.id || crypto.randomUUID()
  if (roles.isBuiltInRole(id)) return { ok: false, error: 'Built-in roles cannot be modified' }
  const candidate = {
    id,
    name: role.name.trim().slice(0, 64),
    description: typeof role.description === 'string' ? role.description.trim().slice(0, 280) : '',
    permissions: cleanPermissions(role.permissions),
  }
  // Resource grants (master plan 6.1): folders relative to each shared root,
  // checked here so a stored role can never name a path outside one.
  const grants = validateGrants(candidate.permissions.grants)
  if (!grants.ok) return { ok: false, error: grants.error }
  if (grants.grants) candidate.permissions.grants = grants.grants
  else delete candidate.permissions.grants
  // Same escalation rule as assignment: defining a role that grants more than
  // the actor holds is the same act as assigning one, one step removed. An
  // edit is checked too: it changes what every holder of the role can do.
  const check = assertNoEscalation(actor, combineRoles([candidate]), 'create a role granting')
  if (!check.ok) return check
  const existing = roles.findRoleById(id)
  if (existing) {
    const before = assertNoEscalation(actor, combineRoles([existing]), 'change a role granting')
    if (!before.ok) return before
  }
  return roles.upsertRole(candidate)
}

/**
 * Delete a role, taking it off every account and group that held it.
 *
 * Nothing needs signing out: sessions carry no authority, every request
 * re-reads the account's roles, and the route closes live MCP sessions so
 * clients re-list their tools (gateway/auth-routes.mjs policyChanged).
 */
export function deleteRole(actor, id) {
  const existing = roles.findRoleById(id)
  if (!existing) return { ok: false, error: 'Role not found' }
  const check = assertNoEscalation(actor, combineRoles([existing]), 'delete a role granting')
  if (!check.ok) return check
  const result = roles.deleteRole(id)
  if (!result.ok) return result
  const reassigned = accounts.removeRoleEverywhere(id)
  groups.removeRoleEverywhere(id)
  return { ok: true, reassigned }
}

/**
 * Set the roles an account holds directly.
 *
 * If the new roles limit which apps it may connect from, its account-wide API
 * key is revoked, because a key that names no app would be the way around that
 * limit. (Before 2026-11-24 this path forgot to, while creation and key
 * regeneration refused.) The result says so, so the admin can tell the person.
 */
export function assignRoles(actor, accountId, roleIds) {
  const target = accounts.findById(accountId)
  if (!target) return { ok: false, error: 'Account not found' }
  if (target.tier === 'owner') return { ok: false, error: 'The owner account holds every permission and cannot be given roles' }
  if (!canManage(actor, target)) return { ok: false, error: 'Not permitted to modify this account' }
  const assignment = resolveRoleAssignment(actor, Array.isArray(roleIds) ? roleIds : [])
  if (!assignment.ok) return assignment
  let account = accounts.updateAccount(accountId, { roleIds: assignment.roleIds })
  if (!account) return { ok: false, error: 'Account not found' }
  let apiKeyRevoked = false
  if (target.apiKeyHash && apiKeyBlockedBySurfaceRule(accounts.findById(accountId))) {
    account = accounts.updateAccount(accountId, { apiKeyHash: null, apiKeyPrefix: null })
    apiKeyRevoked = true
  }
  return { ok: true, account: toPublicAccount(accounts.findById(accountId)), apiKeyRevoked }
}

/** Back-compat: one role, as the old clients send it. */
export function assignRole(actor, accountId, roleId) {
  return assignRoles(actor, accountId, roleId ? [roleId] : [roles.DEFAULT_ROLE_ID])
}

// ---------------------------------------------------------------------------
// Groups (groups-storage.mjs)
// ---------------------------------------------------------------------------
// Gated on manageAccounts at the route: a group is a way of giving people
// roles. The escalation rules follow from that:
//   - the group's roles must be within the actor's own rights;
//   - every account the edit adds or removes must be one the actor may manage;
//   - changing the roles of a group, or deleting it, changes what every member
//     can do, so the actor must be able to manage all of them (the owner can be
//     in groups — for shared projects — and is unaffected by their roles).

export function listGroups() {
  return groups.listGroups()
}

function manageableMembers(actor, memberIds) {
  for (const id of memberIds) {
    const member = accounts.findById(id)
    if (!member || member.tier === 'owner') continue
    if (!canManage(actor, member)) return { ok: false, error: `Not permitted to change ${member.username}'s access` }
  }
  return { ok: true }
}

export function saveGroup(actor, group) {
  const id = typeof group?.id === 'string' && group.id ? group.id : crypto.randomUUID()
  const existing = groups.findGroupById(id)
  const memberIds = [...new Set((group?.memberIds || []).filter(x => typeof x === 'string'))]
  for (const m of memberIds) if (!accounts.findById(m)) return { ok: false, error: 'Account not found' }
  const roleIds = [...new Set((group?.roleIds || []).filter(x => typeof x === 'string'))]
  const assignment = resolveRoleAssignment(actor, roleIds)
  if (!assignment.ok) return assignment
  const before = existing?.memberIds ?? []
  const rolesChanged = !existing || JSON.stringify([...existing.roleIds].sort()) !== JSON.stringify([...assignment.roleIds].sort())
  const touched = rolesChanged
    ? [...new Set([...before, ...memberIds])]
    : [...memberIds.filter(m => !before.includes(m)), ...before.filter(m => !memberIds.includes(m))]
  const check = manageableMembers(actor, touched)
  if (!check.ok) return check
  return groups.upsertGroup({ id, name: group?.name, description: group?.description, memberIds, roleIds: assignment.roleIds })
}

export function deleteGroup(actor, id) {
  const existing = groups.findGroupById(id)
  if (!existing) return { ok: false, error: 'Group not found' }
  const check = manageableMembers(actor, existing.memberIds)
  if (!check.ok) return check
  return groups.deleteGroup(id)
}

/**
 * What an account can reach, for the admin page's preview: its roles (direct
 * and through which group) and the combined permission set.
 */
export function describeAccess(actor, accountId) {
  const target = accounts.findById(accountId)
  if (!target) return { ok: false, error: 'Account not found' }
  if (target.tier === 'owner') return { ok: true, owner: true, roles: [], permissions: null }
  const direct = roles.resolveRoles(target.roleIds).map(r => ({ id: r.id, name: r.name, via: null }))
  const viaGroups = groups.groupsForAccount(target.id).flatMap(g =>
    roles.resolveRoles(g.roleIds).map(r => ({ id: r.id, name: r.name, via: { id: g.id, name: g.name } })))
  return { ok: true, owner: false, roles: [...direct, ...viaGroups], permissions: roleFor(target).permissions, canEdit: canManage(actor, target) }
}

// Self-service: a logged-in user rotating their OWN key. No canManage() check
// because the target is always the caller's own account — the route passes the
// authenticated account straight through as the actor, so there's no id to
// spoof. Deliberately separate from regenerateApiKey() (admin-managing-others).
// ---------------------------------------------------------------------------
// Per-connector credentials (system-prompt spec §8)
// ---------------------------------------------------------------------------
// Self-service, like regenerateOwnApiKey: a user issues keys for their OWN
// account and no one else's. Issuing keys for another account would be an
// impersonation primitive, so it is deliberately not offered — an admin who
// needs a connector key for someone else resets that account instead.
//
// The raw key is returned exactly once. Only its hash is stored.

/**
 * The actor's own connector keys, minus hashes.
 *
 * Deliberately NOT built on listAccounts(), which filters by role — an admin
 * listing accounts sees only 'user' records and so would not find themselves.
 * Self-service reads must not depend on a management-visibility rule.
 */
export function getOwnClientKeys(actor) {
  if (!actor) return []
  const record = accounts.findById(actor.id)
  return (record?.clientKeys || []).map(({ keyHash, ...publicFields }) => publicFields)
}

export function issueClientKey(actor, { surface, label } = {}) {
  if (!actor) return { ok: false, error: 'Not authenticated' }
  if (!isKnownSurface(surface)) {
    return { ok: false, error: `Unknown surface: ${String(surface)}` }
  }

  // Self-service issuance has to obey the caller's own role, or the restriction
  // is bypassable by its target: a user confined to one app could simply mint
  // themselves a key naming a different one. The admin paths already refuse this
  // (apiKeyBlockedBySurfaceRule); this is the same rule on the self-service door.
  const role = roleFor(actor)
  if (!allowsSurface(actor, role, surface)) {
    return { ok: false, error: `Your roles (${role?.name ?? 'none'}) do not permit connecting from this app.` }
  }

  const record = accounts.findById(actor.id)
  if (!record) return { ok: false, error: 'Account not found' }

  const apiKey = generateApiKey()
  const entry = {
    id: crypto.randomUUID(),
    surface,
    label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 64) : surface,
    keyHash: hashApiKey(apiKey),
    keyPrefix: apiKey.slice(0, 8),
    createdAt: new Date().toISOString(),
  }

  const account = accounts.updateAccount(actor.id, {
    clientKeys: [...(record.clientKeys || []), entry],
  })
  if (!account) return { ok: false, error: 'Account not found' }

  return { ok: true, account, apiKey, clientKey: { ...entry, keyHash: undefined } }
}

export function revokeClientKey(actor, keyId) {
  if (!actor) return { ok: false, error: 'Not authenticated' }

  const record = accounts.findById(actor.id)
  if (!record) return { ok: false, error: 'Account not found' }

  const remaining = (record.clientKeys || []).filter(k => k.id !== keyId)
  if (remaining.length === (record.clientKeys || []).length) {
    return { ok: false, error: 'Key not found' }
  }

  const account = accounts.updateAccount(actor.id, { clientKeys: remaining })
  return { ok: true, account }
}

export function regenerateOwnApiKey(actor) {
  if (!actor) return { ok: false, error: 'Not authenticated' }
  const blocked = apiKeyBlockedBySurfaceRule(actor)
  if (blocked) return { ok: false, error: blocked }
  const apiKey = generateApiKey()
  const account = accounts.updateAccount(actor.id, { apiKeyHash: hashApiKey(apiKey), apiKeyPrefix: apiKey.slice(0, 8) })
  if (!account) return { ok: false, error: 'Account not found' }
  return { ok: true, account, apiKey }
}
