// Auth IPC namespace — the auth-required flag.
//
// createFirstAdmin() / auth:create-first-admin is retired. Its
// own comment named its own retirement condition: "safe today only because
// IPC is its sole door" — once IPC is gone the route has no safe caller.
// POST /admin/bootstrap (gateway/auth-routes.mjs, token-gated) is the one
// door onto owner creation now, for every caller including the Electron
// launcher — see index.mjs's bootstrap-token query-param handoff.
//
// Collaborators come straight from auth.mjs / mcp-server.mjs, so this
// namespace needs no deps from index.mjs.
import { getAuthRequired, setAuthRequired, hasOwner } from '../auth.mjs'
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

export function authHandlers() {
  return {
    'auth:get-config': () => getAuthConfig(),
    'auth:set-required': (required) => setAuthRequiredFlag(required),
  }
}
