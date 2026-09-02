// Auth IPC namespace — auth-required flag and first-owner creation.
//
// Collaborators come straight from auth.mjs / mcp-server.mjs, so this namespace
// needs no deps from index.mjs.
//
// Handler bodies are exported as plain functions (Phase 1, §1.3 of the
// headless-admin-plane implementation plan) so an HTTP route can call them
// directly without dragging IPC registration in — importing this module never
// registers anything; only registerAuthHandlers() does that.
import { registerAll } from './guard.mjs'
import { getAuthRequired, setAuthRequired, hasOwner, createOwner } from '../auth.mjs'
import { closeAllMcpSessions } from '../mcp-server.mjs'
import { logEvent } from '../logger.mjs'

export function getAuthConfig() {
  return {
    authRequired: getAuthRequired(),
    hasOwner: hasOwner(),
  }
}

// Strict boolean, not truthiness. This flag decides whether every LAN client
// has to log in, so a stray '' or 0 must not read as "turn auth off" — an
// argument that is not literally true or false is a bug, and the safe
// response to a bug here is to change nothing.
export function setAuthRequiredFlag(required) {
  if (typeof required !== 'boolean') {
    logEvent('security', 'ipc_argument_rejected', {
      channel: 'auth:set-required', reason: 'not a boolean',
    })
    return false
  }
  setAuthRequired(required)
  if (required) closeAllMcpSessions()
  return true
}

export function createFirstAdmin(username, password) {
  if (hasOwner()) return { success: false, error: 'An owner account already exists' }
  const result = createOwner({ username, password })
  if (!result.ok) return { success: false, error: result.error }
  return { success: true, apiKey: result.apiKey, id: result.account.id }
}

export function authHandlers() {
  return {
    'auth:get-config': () => getAuthConfig(),
    'auth:set-required': (required) => setAuthRequiredFlag(required),
    // Still reachable, and still the launcher's create-owner form on Windows.
    // A remote client uses POST /admin/bootstrap instead, which is token-gated;
    // this channel is safe without one because IPC is its only door and that
    // door means physical access to the machine.
    'auth:create-first-admin': (username, password) => createFirstAdmin(username, password),
  }
}

export function registerAuthHandlers() {
  registerAll(authHandlers())
}
