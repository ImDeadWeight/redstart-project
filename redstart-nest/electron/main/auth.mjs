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
import { can, allowsSurface, restrictsSurfaces, ADMIN_PERMISSIONS } from './permissions.mjs'
import { isKnownSurface } from './system-prompt.mjs'

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days, sliding

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
// Sessions — in-memory only. Does not survive an Electron restart; clients
// must handle a 401 from /auth/me by clearing their stored token and
// re-showing the login form, not by looping.
// ---------------------------------------------------------------------------

const sessions = new Map() // token -> { accountId, username, expiresAt }

// NOTE: the session deliberately stores NO authority — no tier, no roleId.
// It used to cache `role`, which nothing authorised off (authenticate() re-reads
// the record by id), but a stale authority field sitting in a session map is
// exactly the thing a later change reaches for. Every permission decision reads
// the account and its role fresh, which is also what makes a role edit take
// effect on the very next request instead of at next login.
function createSession(account) {
  const token = crypto.randomBytes(32).toString('hex')
  sessions.set(token, {
    accountId: account.id,
    username: account.username,
    expiresAt: Date.now() + SESSION_TTL_MS,
  })
  return token
}

function validateSession(token) {
  const session = sessions.get(token)
  if (!session) return null
  if (session.expiresAt < Date.now()) { sessions.delete(token); return null }
  session.expiresAt = Date.now() + SESSION_TTL_MS // sliding expiry
  return session
}

export function revokeSession(token) {
  sessions.delete(token)
}

export function revokeSessionsForAccount(accountId) {
  for (const [token, session] of sessions) {
    if (session.accountId === accountId) sessions.delete(token)
  }
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
  const tier = record.tier ?? record.role ?? 'user'
  return {
    id: record.id,
    username: record.username,
    tier,
    // Mirror of `tier` under its old name — see normalizeAccount in
    // accounts-storage.mjs for why it is still emitted.
    role: tier,
    roleId: record.roleId ?? null,
    apiKeyPrefix: record.apiKeyPrefix,
    createdAt: record.createdAt,
    lastLoginAt: record.lastLoginAt ?? null,
  }
}

// ---------------------------------------------------------------------------
// Role hierarchy — Owner manages Admins and Users; Admin manages Users only;
// nobody manages the Owner (no transfer-ownership flow yet — the recovery
// path, if ever needed, is the physical re-bootstrap in Redstart Nest's own
// launcher, same as the original bootstrap).
// ---------------------------------------------------------------------------

function canManage(actor, targetTier) {
  if (targetTier === 'owner') return false
  if (actor?.tier === 'owner') return true
  if (actor?.tier === 'admin') return targetTier === 'user'
  return false
}

// Gateway route-level gate: is this account admin-tier or above at all?
// Fine-grained actor-vs-target checks (e.g. an Admin trying to touch another
// Admin) happen inside the functions below via canManage(), not here.
export function hasAdminAccess(account) {
  return account?.tier === 'admin' || account?.tier === 'owner'
}

// ---------------------------------------------------------------------------
// Role-aware authorization — the entry points routes call.
//
// Tier is the ceiling and the role can only lower it (permissions.mjs can()).
// Kept here rather than at the routes so there is one place that pairs an
// account with its role; a route that looked the role up itself could forget.
// ---------------------------------------------------------------------------

/** The role object governing an account, or null. */
export function roleFor(account) {
  return account ? roles.getRoleForAccount(account) : null
}

/** May this account perform an admin action? See ADMIN_PERMISSIONS. */
export function canDo(account, permission) {
  return can(account, roleFor(account), permission)
}

/** May this account reach the server through this client surface? */
export function surfacePermitted(account, surface) {
  return allowsSurface(account, roleFor(account), surface)
}

export function authenticate(req) {
  if (!accounts.getAuthRequired()) return { ok: true, account: null }

  const token = bearerToken(req)
  if (token) {
    const session = validateSession(token)
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
// Account actions — one place both gateway routes and IPC handlers call
// through, so nothing bypasses session revocation on delete/reset.
// ---------------------------------------------------------------------------

export function login(username, password) {
  const record = accounts.findByUsername(username)
  if (!record || !verifyPassword(password, record.passwordHash, record.passwordSalt)) {
    return { ok: false, error: 'Invalid username or password' }
  }
  if (record.status === 'disabled') {
    return { ok: false, error: 'This account has been disabled' }
  }
  accounts.updateAccount(record.id, { lastLoginAt: new Date().toISOString() })
  const token = createSession(record)
  return { ok: true, token, user: toPublicAccount(record) }
}

export function logout(req) {
  const token = bearerToken(req)
  if (token) revokeSession(token)
}

// actor is the caller's own account (from authenticate()) — Owner sees
// everyone, Admin's view is filtered to User-tier accounts only (principle
// of least visibility: sub-admins don't need to know who the other admins are).
export function listAccounts(actor) {
  const all = accounts.listAccounts()
  return actor?.tier === 'owner' ? all : all.filter(a => a.tier === 'user')
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

// `tier` defaults to `role`, which is both the back-compat rule (older clients
// send the tier under its old name) and what keeps these two parameters
// optional for callers that predate them.
export function createAccount(actor, { username, password, role, tier = role, roleId = null }) {
  const targetTier = tier === 'admin' ? 'admin' : 'user'
  if (!canManage(actor, targetTier)) {
    return { ok: false, error: 'Not permitted to create an account with this role' }
  }
  if (accounts.findByUsername(username)) {
    return { ok: false, error: 'Username already exists' }
  }
  const assignment = resolveRoleAssignment(actor, roleId)
  if (!assignment.ok) return assignment
  // The third door onto the same rule the regenerate paths already guard: an
  // account-wide key names no app, so issuing one to a surface-restricted role
  // hands out the bypass at creation time. Checked against the role directly —
  // the account does not exist yet, so apiKeyBlockedBySurfaceRule has nothing to
  // read.
  if (restrictsSurfaces(roles.findRoleById(assignment.roleId))) {
    return { ok: false, error: 'This role limits which apps the account may connect from, and an account-wide API key carries no app identity. Create the account without this role and assign it after the user has issued a per-connector key.' }
  }
  const apiKey = generateApiKey()
  const now = new Date().toISOString()
  const record = {
    id: crypto.randomUUID(),
    username,
    tier: targetTier,
    role: targetTier,
    roleId: assignment.roleId,
    ...hashPassword(password),
    apiKeyHash: hashApiKey(apiKey),
    apiKeyPrefix: apiKey.slice(0, 8),
    createdAt: now,
    updatedAt: now,
    createdBy: actor?.id ?? null,
  }
  const account = accounts.insertAccount(record)
  return { ok: true, account, apiKey }
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
    // The owner is never narrowed (permissions.mjs FAIL POSTURE) — this stays
    // null so nothing can be assigned to it later either.
    roleId: null,
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

export function deleteAccount(actor, id) {
  const target = accounts.findById(id)
  if (!target) return { ok: false, error: 'Account not found' }
  if (!canManage(actor, target.tier)) return { ok: false, error: 'Not permitted to delete this account' }
  const removed = accounts.deleteAccount(id)
  if (removed) revokeSessionsForAccount(id)
  return { ok: removed }
}

export function resetPassword(actor, id, newPassword) {
  const target = accounts.findById(id)
  if (!target) return { ok: false, error: 'Account not found' }
  if (!canManage(actor, target.tier)) return { ok: false, error: 'Not permitted to reset this account' }
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
  return `The "${role?.name}" role limits which apps this account may connect from, and an account-wide API key carries no app identity. Issue a per-connector key instead.`
}

export function regenerateApiKey(actor, id) {
  const target = accounts.findById(id)
  if (!target) return { ok: false, error: 'Account not found' }
  if (!canManage(actor, target.tier)) return { ok: false, error: 'Not permitted to modify this account' }
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
 * Validate a roleId an actor wants to put on an account.
 *
 * The escalation rule: an admin may not hand out an admin permission they do
 * not themselves hold. Without it, an admin with manageRoles could mint a role
 * carrying managePromptBlocks, assign it to an account they control, and log in
 * as it. The Owner holds everything, so this only ever binds admins.
 */
/**
 * Refuse an actor handing out an admin permission they do not hold themselves.
 *
 * Shared by role ASSIGNMENT and role DEFINITION because they are the same act one
 * step apart: minting a role that grants managePromptBlocks and assigning it to an
 * account you control is the escalation this stops. An absent `admin` block
 * inherits (grants everything), so it is treated as granting each permission.
 */
function assertNoEscalation(actor, permissions, verb) {
  for (const permission of ADMIN_PERMISSIONS) {
    const grants = permissions?.admin
    const granted = grants === null || grants === undefined || grants[permission] === true
    if (granted && !canDo(actor, permission)) {
      return { ok: false, error: `Not permitted to ${verb} "${permission}" — you do not hold it yourself` }
    }
  }
  return { ok: true }
}

function resolveRoleAssignment(actor, roleId) {
  if (roleId === undefined || roleId === null) return { ok: true, roleId: null }
  const role = roles.findRoleById(roleId)
  if (!role) return { ok: false, error: 'Role not found' }
  const check = assertNoEscalation(actor, role.permissions, 'grant')
  if (!check.ok) return check
  return { ok: true, roleId }
}

export function listRoles() {
  return roles.listRoles()
}

export function saveRole(actor, role) {
  if (!role?.name?.trim()) return { ok: false, error: 'Role name required' }
  const id = role.id || crypto.randomUUID()
  if (roles.isBuiltInRole(id)) return { ok: false, error: 'Built-in roles cannot be modified' }
  const candidate = {
    id,
    name: role.name.trim().slice(0, 64),
    description: typeof role.description === 'string' ? role.description.trim().slice(0, 280) : '',
    permissions: role.permissions && typeof role.permissions === 'object' ? role.permissions : {},
  }
  // Same escalation rule as assignment: creating a role that grants more than
  // the actor holds is the same act as assigning one, one step removed.
  const check = assertNoEscalation(actor, candidate.permissions, 'create a role granting')
  if (!check.ok) return check
  return roles.upsertRole(candidate)
}

/**
 * Delete a role, reassigning its members to Full Access.
 *
 * Sessions of affected accounts are revoked so nobody keeps operating under a
 * policy that no longer exists — cheap, and the alternative is a window where
 * the effective config depends on when a client last reconnected.
 */
export function deleteRole(actor, id) {
  const result = roles.deleteRole(id)
  if (!result.ok) return result
  const reassigned = accounts.reassignRole(id, null)
  return { ok: true, reassigned }
}

export function assignRole(actor, accountId, roleId) {
  const target = accounts.findById(accountId)
  if (!target) return { ok: false, error: 'Account not found' }
  if (!canManage(actor, target.tier)) return { ok: false, error: 'Not permitted to modify this account' }
  if (target.tier === 'owner') return { ok: false, error: 'The owner account cannot be assigned a role' }
  const assignment = resolveRoleAssignment(actor, roleId)
  if (!assignment.ok) return assignment
  const account = accounts.updateAccount(accountId, { roleId: assignment.roleId })
  if (!account) return { ok: false, error: 'Account not found' }
  return { ok: true, account }
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
    return { ok: false, error: `The "${role?.name ?? 'assigned'}" role does not permit connecting from this app.` }
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
