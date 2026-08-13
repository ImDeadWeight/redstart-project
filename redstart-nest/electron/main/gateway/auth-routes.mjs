'use strict'

// =============================================================================
// Redstart Nest — Gateway /auth/* routes
// =============================================================================
// The whole account surface the gateway exposes over HTTP: session login and
// logout, the self-service routes a user may run against their own account
// (identity, per-connector client keys, key rotation), and the admin-tier
// account management below the gate at the middle of handleAuthRoute().
//
// These routes handle their own responses INCLUDING their own authentication,
// which is why tools-gateway.mjs branches here before its own auth gate: the
// client needs /auth/config and /auth/login before it holds any credential.
//
// This module knows nothing about llama-server, the proxy, the system-prompt
// injector, or activeConfig. It talks only to auth.mjs.
// =============================================================================

import { authenticate, login, logout, listAccounts, getAuthRequired, createAccount, deleteAccount, resetPassword, regenerateApiKey, regenerateOwnApiKey, hasAdminAccess, issueClientKey, revokeClientKey, getOwnClientKeys } from '../auth.mjs'
import { logEvent } from '../logger.mjs'
import { SURFACE_IDS } from '../system-prompt.mjs'
import { sendJson, readJsonBody } from './http-json.mjs'

export async function handleAuthRoute(req, res, urlPath) {
  // Public — no auth required (chicken-and-egg: the client needs this
  // before it can even attempt to log in).
  if (req.method === 'GET' && urlPath === '/auth/config') {
    return sendJson(res, 200, { authRequired: getAuthRequired() })
  }

  if (req.method === 'POST' && urlPath === '/auth/login') {
    const body = await readJsonBody(req)
    if (!body?.username || !body?.password) return sendJson(res, 400, { error: 'Username and password required' })
    const result = login(body.username, body.password)
    if (!result.ok) {
      // Log the outcome + role, never the password or token.
      logEvent('auth', 'login_failed', { username: String(body.username).slice(0, 64) })
      return sendJson(res, 401, { error: result.error })
    }
    logEvent('auth', 'login_ok', { username: result.user?.username, role: result.user?.role })
    return sendJson(res, 200, { token: result.token, user: result.user })
  }

  if (req.method === 'POST' && urlPath === '/auth/logout') {
    logout(req)
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
    return res.end()
  }

  if (req.method === 'GET' && urlPath === '/auth/me') {
    const authResult = authenticate(req)
    if (!authResult.ok) return sendJson(res, 401, { error: 'Unauthorized' })
    return sendJson(res, 200, { authRequired: getAuthRequired(), user: authResult.account })
  }

  // Per-connector credentials (spec §8). Self-service only: a user issues keys
  // for their own account, because issuing one for another account would be an
  // impersonation primitive. Placed with the other self-service routes, before
  // the admin gate below.
  if (req.method === 'GET' && urlPath === '/auth/me/client-keys') {
    const authResult = authenticate(req)
    if (!authResult.ok || !authResult.account) return sendJson(res, 401, { error: 'Unauthorized' })
    return sendJson(res, 200, {
      clientKeys: getOwnClientKeys(authResult.account),
      surfaces: SURFACE_IDS,
    })
  }

  if (req.method === 'POST' && urlPath === '/auth/me/client-keys') {
    const authResult = authenticate(req)
    if (!authResult.ok || !authResult.account) return sendJson(res, 401, { error: 'Unauthorized' })
    const body = await readJsonBody(req)
    const result = issueClientKey(authResult.account, {
      surface: body?.surface,
      label: body?.label,
    })
    if (!result.ok) return sendJson(res, 400, { error: result.error })
    logEvent('auth', 'client_key_issued', {
      username: authResult.account.username,
      surface: body?.surface,
    })
    // The raw key is returned exactly once and never stored.
    return sendJson(res, 200, { apiKey: result.apiKey, clientKey: result.clientKey })
  }

  if (req.method === 'DELETE' && urlPath.startsWith('/auth/me/client-keys/')) {
    const authResult = authenticate(req)
    if (!authResult.ok || !authResult.account) return sendJson(res, 401, { error: 'Unauthorized' })
    const keyId = urlPath.slice('/auth/me/client-keys/'.length)
    const result = revokeClientKey(authResult.account, keyId)
    if (!result.ok) return sendJson(res, 404, { error: result.error })
    logEvent('auth', 'client_key_revoked', { username: authResult.account.username })
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
    return res.end()
  }

  // Self-service key rotation — any logged-in user, acting on their own
  // account. Placed before the admin gate below because it is NOT an
  // account-management action. Requires a real authenticated account (an
  // anonymous localhost/auth-off request has account: null → 401).
  if (req.method === 'POST' && urlPath === '/auth/me/regenerate-key') {
    const authResult = authenticate(req)
    if (!authResult.ok || !authResult.account) return sendJson(res, 401, { error: 'Unauthorized' })
    const result = regenerateOwnApiKey(authResult.account)
    if (!result.ok) return sendJson(res, 400, { error: result.error })
    return sendJson(res, 200, { account: result.account, apiKey: result.apiKey })
  }

  // Everything below manages accounts — admin-tier (Admin or Owner) only,
  // regardless of the authRequired toggle (an unauthenticated/bypassed
  // request has no account attached, so it can never satisfy this check).
  // Actor-vs-target checks (e.g. an Admin trying to touch another Admin or
  // the Owner) happen inside auth.mjs's functions, not here.
  const authResult = authenticate(req)
  if (!authResult.ok) return sendJson(res, 401, { error: 'Unauthorized' })
  if (!hasAdminAccess(authResult.account)) return sendJson(res, 403, { error: 'Admin role required' })

  if (req.method === 'GET' && urlPath === '/auth/accounts') {
    return sendJson(res, 200, { accounts: listAccounts(authResult.account) })
  }

  if (req.method === 'POST' && urlPath === '/auth/accounts') {
    const body = await readJsonBody(req)
    if (!body?.username || !body?.password) return sendJson(res, 400, { error: 'Username and password required' })
    const result = createAccount(authResult.account, { username: body.username, password: body.password, role: body.role })
    if (!result.ok) return sendJson(res, result.error?.startsWith('Not permitted') ? 403 : 400, { error: result.error })
    return sendJson(res, 200, { account: result.account, apiKey: result.apiKey })
  }

  const idMatch = /^\/auth\/accounts\/([^/]+)(?:\/(reset-password|regenerate-key))?$/.exec(urlPath)
  if (idMatch) {
    const [, id, action] = idMatch

    if (req.method === 'DELETE' && !action) {
      const result = deleteAccount(authResult.account, id)
      if (!result.ok) return sendJson(res, result.error === 'Account not found' ? 404 : 403, { error: result.error })
      return sendJson(res, 200, { ok: true })
    }

    if (req.method === 'POST' && action === 'reset-password') {
      const body = await readJsonBody(req)
      if (!body?.password) return sendJson(res, 400, { error: 'Password required' })
      const result = resetPassword(authResult.account, id, body.password)
      if (!result.ok) return sendJson(res, result.error === 'Account not found' ? 404 : 403, { error: result.error })
      return sendJson(res, 200, { account: result.account })
    }

    if (req.method === 'POST' && action === 'regenerate-key') {
      const result = regenerateApiKey(authResult.account, id)
      if (!result.ok) return sendJson(res, result.error === 'Account not found' ? 404 : 403, { error: result.error })
      return sendJson(res, 200, { account: result.account, apiKey: result.apiKey })
    }
  }

  return sendJson(res, 404, { error: 'Not found' })
}
