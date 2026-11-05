'use strict'

// =============================================================================
// Redstart Nest — Control-plane /admin/auth/* and /admin/bootstrap
// =============================================================================
// The routes that run BEFORE the admin listener's own gate, because they are how
// a caller comes to hold a credential at all. Each therefore does its own
// authentication, and each is a place where getting the order of checks wrong is
// the whole bug.
//
// FOUR DOORS, AND ONLY FOUR:
//
//   GET  /admin/auth/config    is there an owner yet — the SPA needs to know
//                              which screen to show before it holds anything
//   POST /admin/auth/login     password -> control-plane session
//   POST /admin/auth/logout    revoke this session
//   GET  /admin/auth/me        who am I (authenticated)
//   POST /admin/bootstrap      token -> create OR reset the owner
//
// The two anonymous ones — login and bootstrap — are the only routes on this
// listener that accept a secret from an unauthenticated caller and hand out
// access if it is right, so they are the two that are rate limited, logged on
// every attempt, and written to give the same answer to "wrong password" and "no
// such user".
//
// NO LOCALHOST EXEMPTION anywhere here, matching auth.mjs's stated rule. Nest
// spawns third-party plugin code that runs ON this box, so "requests from this
// machine are trusted" would let any installed plugin seize ownership — and
// behind the documented reverse-proxy deployment, every request arrives from
// loopback anyway, so the exemption would apply to the entire internet.
// =============================================================================

import {
  login, logout, hasOwner, getAuthRequired, createOwner, resetOwner,
  authenticateControlPlane, CONTROL_PLANE,
} from '../auth.mjs'
import { mayAccessControlPlane } from '../permissions.mjs'
import { verifyBootstrapToken, readBootstrapToken } from '../bootstrap-token.mjs'
import { createRateLimiter } from '../rate-limit.mjs'
import { logEvent } from '../logger.mjs'
import { sendJson, readJsonBody, remoteAddress } from './http.mjs'

// Ten attempts a minute is far past a human mistyping a password and far short
// of useful against a 100-bit token or an scrypt-hashed password. It is a brake
// on automated guessing, and the log line each attempt writes is the other half
// of the point — see rate-limit.mjs on why this is not an access control.
const loginLimiter = createRateLimiter({ limit: 10, windowMs: 60 * 1000 })
const bootstrapLimiter = createRateLimiter({ limit: 10, windowMs: 60 * 1000 })

// The owner password now gates a LAN-reachable surface that starts and stops
// processes. Nothing enforced a length before — the launcher's create-owner form
// accepted anything non-empty — and a one-character owner password behind a
// rate-limited network login is not defensible. Deliberately a floor and not a
// composition rule: length is the only requirement that reliably helps, and the
// rest teach people to write passwords down.
const MIN_PASSWORD_LENGTH = 8
const MAX_USERNAME_LENGTH = 64

function credentialRejection(username, password) {
  if (typeof username !== 'string' || !username.trim()) return 'A username is required.'
  if (username.trim().length > MAX_USERNAME_LENGTH) return `A username may be at most ${MAX_USERNAME_LENGTH} characters.`
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `A password must be at least ${MIN_PASSWORD_LENGTH} characters.`
  }
  return null
}

/**
 * Forget every recorded attempt.
 *
 * A test seam, and it earns its place: without it the suite that proves the
 * limiter works and the suite that walks the login and bootstrap routes share
 * one bucket, so whichever runs second stops testing what it says it tests —
 * silently, by getting 429 for everything. Not reachable over HTTP.
 */
export function __resetAdminAuthLimiters() {
  loginLimiter.reset()
  bootstrapLimiter.reset()
}

/** Is this a route this module owns? Asked by the listener before its own gate. */
export function isAdminAuthRoute(urlPath) {
  return urlPath.startsWith('/admin/auth/') || urlPath === '/admin/bootstrap'
}

export async function handleAdminAuthRoute(req, res, urlPath) {
  // --- Public: which screen does the SPA show? -----------------------------
  // Chicken-and-egg, the same one the gateway's /auth/config solves: the client
  // needs this before it can hold any credential. It reports only whether an
  // owner EXISTS, never who, and `authRequired` is echoed purely so the admin UI
  // can say what the data plane is doing — it has no bearing on this listener.
  if (req.method === 'GET' && urlPath === '/admin/auth/config') {
    return sendJson(res, 200, { hasOwner: hasOwner(), dataPlaneAuthRequired: getAuthRequired() })
  }

  if (req.method === 'POST' && urlPath === '/admin/auth/login') {
    return await handleLogin(req, res)
  }

  if (req.method === 'POST' && urlPath === '/admin/auth/logout') {
    logout(req)
    res.writeHead(204, { 'Cache-Control': 'no-store' })
    return res.end()
  }

  if (req.method === 'GET' && urlPath === '/admin/auth/me') {
    const result = authenticateControlPlane(req)
    if (!result.ok) return sendJson(res, 401, { error: 'Unauthorized' })
    return sendJson(res, 200, { user: result.account })
  }

  if (req.method === 'POST' && urlPath === '/admin/bootstrap') {
    return await handleBootstrap(req, res)
  }

  return sendJson(res, 404, { error: 'Not found' })
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

async function handleLogin(req, res) {
  const from = remoteAddress(req)
  const limit = loginLimiter.check(from)
  if (!limit.ok) {
    logEvent('admin', 'login_rate_limited', {})
    return sendJson(res, 429, { error: 'Too many attempts. Try again shortly.' },
      { 'Retry-After': Math.ceil(limit.retryAfterMs / 1000) })
  }

  const body = await readJsonBody(req)
  if (!body?.username || !body?.password) {
    return sendJson(res, 400, { error: 'Username and password required' })
  }

  const result = login(body.username, body.password, CONTROL_PLANE)

  // ONE ANSWER FOR TWO FAILURES, and a third folded in with them. Bad password,
  // no such account, and a real account that simply is not the owner all return
  // the same 401 — otherwise this route tells an anonymous caller which
  // usernames exist and which one owns the box, which is most of what they need
  // before they start guessing. Note the ordering: the session is minted by
  // login() and then thrown away if the account may not be here, rather than the
  // tier being checked first, so the timing of the two paths does not differ by
  // an scrypt hash.
  if (!result.ok || !mayAccessControlPlane(result.user)) {
    if (result.ok) logout({ headers: { authorization: `Bearer ${result.token}` } })
    logEvent('admin', 'login_failed', { username: String(body.username).slice(0, 64) })
    return sendJson(res, 401, { error: 'Invalid username or password' })
  }

  loginLimiter.clear(from)
  logEvent('admin', 'login_ok', { username: result.user.username })
  return sendJson(res, 200, { token: result.token, user: result.user })
}

// ---------------------------------------------------------------------------
// Bootstrap — create the first owner, or reset an existing one
// ---------------------------------------------------------------------------

async function handleBootstrap(req, res) {
  const from = remoteAddress(req)
  const limit = bootstrapLimiter.check(from)
  if (!limit.ok) {
    logEvent('admin', 'bootstrap_rate_limited', {})
    return sendJson(res, 429, { error: 'Too many attempts. Try again shortly.' },
      { 'Retry-After': Math.ceil(limit.retryAfterMs / 1000) })
  }

  const body = await readJsonBody(req)
  if (!body) return sendJson(res, 400, { error: 'Malformed request' })

  // The token is checked FIRST, before the credential shape and before anything
  // touches accounts.json. A caller without the token learns nothing from this
  // route — not whether an owner exists, not whether a username is taken, not
  // whether their password would have been acceptable.
  if (!verifyBootstrapToken(body.token)) {
    logEvent('admin', 'bootstrap_rejected', { reason: 'bad_token', hadToken: !!readBootstrapToken() })
    return sendJson(res, 401, { error: 'Invalid bootstrap token' })
  }

  const rejection = credentialRejection(body.username, body.password)
  if (rejection) {
    logEvent('admin', 'bootstrap_rejected', { reason: 'bad_credential' })
    return sendJson(res, 400, { error: rejection })
  }

  const username = body.username.trim()
  const reset = hasOwner()
  const result = reset
    ? resetOwner({ username, password: body.password })
    : createOwner({ username, password: body.password })

  if (!result.ok) {
    logEvent('admin', 'bootstrap_rejected', { reason: 'refused', reset })
    return sendJson(res, 400, { error: result.error })
  }

  bootstrapLimiter.clear(from)
  logEvent('admin', reset ? 'owner_reset' : 'owner_created', { username })

  // The API key comes back only on CREATE, and only once — createOwner mints
  // one, a reset leaves the existing key alone (see resetOwner). Handing back a
  // key on reset would mean either rotating it, which the plan says not to, or
  // returning a credential the caller did not just establish.
  return sendJson(res, 200, {
    reset,
    user: result.account,
    ...(reset ? {} : { apiKey: result.apiKey }),
  })
}
