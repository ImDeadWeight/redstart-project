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

import { authenticate, login, logout, listAccounts, getAuthRequired, createAccount, deleteAccount, resetPassword, regenerateApiKey, regenerateOwnApiKey, hasAdminAccess, canDo, issueClientKey, revokeClientKey, getOwnClientKeys, listRoles, saveRole, deleteRole, assignRole } from '../auth.mjs'
import { capabilityIds, ADMIN_PERMISSIONS } from '../permissions.mjs'
import { BUILTIN_TOOLS } from '../tools-definitions.mjs'
import { logEvent } from '../logger.mjs'
import { closeAllMcpSessions } from '../mcp-server.mjs'
import { SURFACE_IDS } from '../system-prompt.mjs'
import { sendJson, readJsonBody } from './http-json.mjs'

// A role edit changes what a live MCP client is allowed to call. Enforcement is
// already correct without this — tools/call re-resolves the policy per request —
// but a connected client holds the tools/list it was given at connect time, so
// it would keep OFFERING the model tools that now get refused. Dropping the SSE
// sessions makes clients reconnect and re-list, so the vocabulary and the policy
// agree again immediately instead of at next page load.
function policyChanged() {
  try { closeAllMcpSessions() } catch { /* server may not be running */ }
}

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

  // Everything below is administration — admin-tier (Admin or Owner) only,
  // regardless of the authRequired toggle (an unauthenticated/bypassed
  // request has no account attached, so it can never satisfy this check).
  //
  // Tier is the COARSE gate; each route then asks canDo() for the specific
  // permission its action needs, because an admin's role may withhold some of
  // them (permissions.mjs ADMIN_PERMISSIONS). The Owner always passes both.
  // Actor-vs-target checks (e.g. an Admin trying to touch another Admin or
  // the Owner) happen inside auth.mjs's functions, not here.
  const authResult = authenticate(req)
  if (!authResult.ok) return sendJson(res, 401, { error: 'Unauthorized' })
  if (!hasAdminAccess(authResult.account)) return sendJson(res, 403, { error: 'Admin role required' })

  const actor = authResult.account
  const deny = permission =>
    canDo(actor, permission) ? null : sendJson(res, 403, { error: `Your role does not permit "${permission}"` })

  // ---------------------------------------------------------------------------
  // Roles — the admin-defined capability layer.
  //
  // Listed BEFORE the /auth/accounts/:id pattern below so a literal path can
  // never be captured as an account id.
  // ---------------------------------------------------------------------------

  if (req.method === 'GET' && urlPath === '/auth/roles') {
    // The vocabulary travels with the list so the UI does not hardcode its own
    // copy of what a capability or an admin permission is — one source of
    // truth, and a capability added server-side shows up in the editor with no
    // client change.
    return sendJson(res, 200, {
      roles: listRoles(),
      capabilityIds: capabilityIds(),
      adminPermissions: ADMIN_PERMISSIONS,
      webSources: BUILTIN_TOOLS.map(({ id, name }) => ({ id, name })),
      surfaces: SURFACE_IDS,
      canEdit: canDo(actor, 'manageRoles'),
    })
  }

  if (req.method === 'POST' && urlPath === '/auth/roles') {
    const denied = deny('manageRoles'); if (denied) return denied
    const body = await readJsonBody(req)
    const result = saveRole(actor, body || {})
    if (!result.ok) return sendJson(res, result.error?.startsWith('Not permitted') ? 403 : 400, { error: result.error })
    logEvent('auth', 'role_saved', { role: result.role.name })
    policyChanged()
    return sendJson(res, 200, { role: result.role })
  }

  const roleMatch = /^\/auth\/roles\/([^/]+)$/.exec(urlPath)
  if (roleMatch && req.method === 'DELETE') {
    const denied = deny('manageRoles'); if (denied) return denied
    const result = deleteRole(actor, roleMatch[1])
    if (!result.ok) return sendJson(res, result.error === 'Role not found' ? 404 : 400, { error: result.error })
    logEvent('auth', 'role_deleted', { reassigned: result.reassigned })
    policyChanged()
    return sendJson(res, 200, { ok: true, reassigned: result.reassigned })
  }

  if (req.method === 'GET' && urlPath === '/auth/accounts') {
    const denied = deny('manageAccounts'); if (denied) return denied
    return sendJson(res, 200, { accounts: listAccounts(actor), canEdit: canDo(actor, 'manageAccounts') })
  }

  if (req.method === 'POST' && urlPath === '/auth/accounts') {
    const denied = deny('manageAccounts'); if (denied) return denied
    const body = await readJsonBody(req)
    if (!body?.username || !body?.password) return sendJson(res, 400, { error: 'Username and password required' })
    const result = createAccount(actor, { username: body.username, password: body.password, tier: body.tier ?? body.role, roleId: body.roleId })
    if (!result.ok) return sendJson(res, result.error?.startsWith('Not permitted') ? 403 : 400, { error: result.error })
    return sendJson(res, 200, { account: result.account, apiKey: result.apiKey })
  }

  const idMatch = /^\/auth\/accounts\/([^/]+)(?:\/(reset-password|regenerate-key|role))?$/.exec(urlPath)
  if (idMatch) {
    const [, id, action] = idMatch
    const denied = deny('manageAccounts'); if (denied) return denied

    if (req.method === 'DELETE' && !action) {
      const result = deleteAccount(actor, id)
      if (!result.ok) return sendJson(res, result.error === 'Account not found' ? 404 : 403, { error: result.error })
      return sendJson(res, 200, { ok: true })
    }

    if (req.method === 'POST' && action === 'reset-password') {
      const body = await readJsonBody(req)
      if (!body?.password) return sendJson(res, 400, { error: 'Password required' })
      const result = resetPassword(actor, id, body.password)
      if (!result.ok) return sendJson(res, result.error === 'Account not found' ? 404 : 403, { error: result.error })
      return sendJson(res, 200, { account: result.account })
    }

    if (req.method === 'POST' && action === 'regenerate-key') {
      const result = regenerateApiKey(actor, id)
      if (!result.ok) return sendJson(res, result.error === 'Account not found' ? 404 : 403, { error: result.error })
      return sendJson(res, 200, { account: result.account, apiKey: result.apiKey })
    }

    // Assigning a role is an ACCOUNT action, so it needs manageAccounts (above)
    // — not manageRoles, which governs what roles may exist. An admin who can
    // place people into roles but not redefine them is a real configuration,
    // and the escalation check in auth.mjs still stops them assigning authority
    // they do not hold themselves.
    if (req.method === 'PUT' && action === 'role') {
      const body = await readJsonBody(req)
      const result = assignRole(actor, id, body?.roleId ?? null)
      if (!result.ok) return sendJson(res, result.error === 'Account not found' ? 404 : 403, { error: result.error })
      logEvent('auth', 'role_assigned', { username: result.account.username, roleId: body?.roleId ?? null })
      policyChanged()
      return sendJson(res, 200, { account: result.account })
    }
  }

  return sendJson(res, 404, { error: 'Not found' })
}
