// Auth IPC namespace — auth-required flag and first-owner creation.
//
// Collaborators come straight from auth.mjs / mcp-server.mjs, so this namespace
// needs no deps from index.mjs.
import { ipcMain } from 'electron'
import { getAuthRequired, setAuthRequired, hasOwner, createOwner } from '../auth.mjs'
import { closeAllMcpSessions } from '../mcp-server.mjs'

export function registerAuthHandlers() {
  // --- Auth ---

  ipcMain.handle('auth:get-config', () => ({
    authRequired: getAuthRequired(),
    hasOwner: hasOwner(),
  }))

  ipcMain.handle('auth:set-required', (_, required) => {
    setAuthRequired(required)
    if (required) closeAllMcpSessions()
    return true
  })

  ipcMain.handle('auth:create-first-admin', (_, username, password) => {
    if (hasOwner()) return { success: false, error: 'An owner account already exists' }
    const result = createOwner({ username, password })
    if (!result.ok) return { success: false, error: result.error }
    return { success: true, apiKey: result.apiKey, id: result.account.id }
  })
}
