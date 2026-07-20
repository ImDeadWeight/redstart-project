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

// Plain SHA-256, deliberately NOT scrypt: API keys are 24 CSPRNG bytes (192 bits of entropy), not human-chosen
// passwords, so offline brute force of the hash is infeasible and a slow KDF
// adds nothing. The hash must also stay deterministic and salt-free so
// findByApiKeyHash() can do an O(1) lookup on every request; a salted KDF
// would force an scrypt run per stored account per request. Passwords —
// the low-entropy secret — go through scrypt above.
export function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex')
}

// ---------------------------------------------------------------------------
// Sessions — in-memory only. Does not survive an Electron restart; clients
// must handle a 401 from /auth/me by clearing their stored token and
// re-showing the login form, not by looping.
// ---------------------------------------------------------------------------

const sessions = new Map() // token -> { accountId, username, role, expiresAt }

function createSession(account) {
  const token = crypto.randomBytes(32).toString('hex')
  sessions.set(token, {
    accountId: account.id,
    username: account.username,
    role: account.role,
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
  return {
    id: record.id,
    username: record.username,
    role: record.role,
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

function canManage(actor, targetRole) {
  if (targetRole === 'owner') return false
  if (actor?.role === 'owner') return true
  if (actor?.role === 'admin') return targetRole === 'user'
  return false
}

// Gateway route-level gate: is this account admin-tier or above at all?
// Fine-grained actor-vs-target checks (e.g. an Admin trying to touch another
// Admin) happen inside the functions below via canManage(), not here.
export function hasAdminAccess(account) {
  return account?.role === 'admin' || account?.role === 'owner'
}

export function authenticate(req) {
  if (!accounts.getAuthRequired()) return { ok: true, account: null }

  const token = bearerToken(req)
  if (token) {
    const session = validateSession(token)
    if (session) {
      const record = accounts.findById(session.accountId)
      if (record) return { ok: true, account: toPublicAccount(record) }
    }

    const record = accounts.findByApiKeyHash(hashApiKey(token))
    if (record) return { ok: true, account: toPublicAccount(record) }
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
  return actor?.role === 'owner' ? all : all.filter(a => a.role === 'user')
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

export function createAccount(actor, { username, password, role }) {
  const targetRole = role === 'admin' ? 'admin' : 'user'
  if (!canManage(actor, targetRole)) {
    return { ok: false, error: 'Not permitted to create an account with this role' }
  }
  if (accounts.findByUsername(username)) {
    return { ok: false, error: 'Username already exists' }
  }
  const apiKey = generateApiKey()
  const now = new Date().toISOString()
  const record = {
    id: crypto.randomUUID(),
    username,
    role: targetRole,
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
    role: 'owner',
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
  if (!canManage(actor, target.role)) return { ok: false, error: 'Not permitted to delete this account' }
  const removed = accounts.deleteAccount(id)
  if (removed) revokeSessionsForAccount(id)
  return { ok: removed }
}

export function resetPassword(actor, id, newPassword) {
  const target = accounts.findById(id)
  if (!target) return { ok: false, error: 'Account not found' }
  if (!canManage(actor, target.role)) return { ok: false, error: 'Not permitted to reset this account' }
  const account = accounts.updateAccount(id, hashPassword(newPassword))
  if (account) revokeSessionsForAccount(id)
  return { ok: true, account }
}

export function regenerateApiKey(actor, id) {
  const target = accounts.findById(id)
  if (!target) return { ok: false, error: 'Account not found' }
  if (!canManage(actor, target.role)) return { ok: false, error: 'Not permitted to modify this account' }
  const apiKey = generateApiKey()
  const account = accounts.updateAccount(id, { apiKeyHash: hashApiKey(apiKey), apiKeyPrefix: apiKey.slice(0, 8) })
  return { ok: true, account, apiKey }
}

// Self-service: a logged-in user rotating their OWN key. No canManage() check
// because the target is always the caller's own account — the route passes the
// authenticated account straight through as the actor, so there's no id to
// spoof. Deliberately separate from regenerateApiKey() (admin-managing-others).
export function regenerateOwnApiKey(actor) {
  if (!actor) return { ok: false, error: 'Not authenticated' }
  const apiKey = generateApiKey()
  const account = accounts.updateAccount(actor.id, { apiKeyHash: hashApiKey(apiKey), apiKeyPrefix: apiKey.slice(0, 8) })
  if (!account) return { ok: false, error: 'Account not found' }
  return { ok: true, account, apiKey }
}
