// Auth IPC namespace — auth-required flag and first-owner creation.
//
// Collaborators come straight from auth.mjs / mcp-server.mjs, so this namespace
// needs no deps from index.mjs.
import { handle } from './guard.mjs'
import { getAuthRequired, setAuthRequired, hasOwner, createOwner } from '../auth.mjs'
import { closeAllMcpSessions } from '../mcp-server.mjs'
import { logEvent } from '../logger.mjs'

export function registerAuthHandlers() {
  // --- Auth ---

  handle('auth:get-config', () => ({
    authRequired: getAuthRequired(),
    hasOwner: hasOwner(),
  }))

  // Strict boolean, not truthiness. This flag decides whether every LAN client
  // has to log in, so a stray '' or 0 must not read as "turn auth off" — an
  // argument that is not literally true or false is a bug, and the safe
  // response to a bug here is to change nothing.
  handle('auth:set-required', (_, required) => {
    if (typeof required !== 'boolean') {
      logEvent('security', 'ipc_argument_rejected', {
        channel: 'auth:set-required', reason: 'not a boolean',
      })
      return false
    }
    setAuthRequired(required)
    if (required) closeAllMcpSessions()
    return true
  })

  handle('auth:create-first-admin', (_, username, password) => {
    if (hasOwner()) return { success: false, error: 'An owner account already exists' }
    const result = createOwner({ username, password })
    if (!result.ok) return { success: false, error: result.error }
    return { success: true, apiKey: result.apiKey, id: result.account.id }
  })
}
