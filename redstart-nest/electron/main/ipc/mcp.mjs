// MCP IPC namespace — external MCP server registry (list/add/remove) and a
// connectivity probe.
//
// All collaborators come from tools-storage / node:crypto, so no deps needed.
import { ipcMain } from 'electron'
import * as crypto from 'crypto'
import { getExternalServers, addExternalServer, deleteExternalServer } from '../tools-storage.mjs'
import { validateExternalMcpUrl } from '../external-mcp-url.mjs'

export function registerMcpHandlers({ getConfiguredPort } = {}) {
  // --- MCP ---

  ipcMain.handle('mcp:list-external', () => getExternalServers())

  // Validation lives here rather than in the renderer: this is the only entry
  // point that can write to the registry, so a check anywhere else would be
  // advisory. Refusals are limited to what is incoherent (bad scheme, no host)
  // or self-defeating (Nest's own ports); everything else is returned as a
  // warning for the UI to show, because an admin at the console is allowed to
  // point Nest at a plaintext LAN appliance. See external-mcp-url.mjs.
  ipcMain.handle('mcp:validate-external', (_, url) =>
    validateExternalMcpUrl(url, getConfiguredPort?.()))

  ipcMain.handle('mcp:add-external', (_, server) => {
    const verdict = validateExternalMcpUrl(server?.url, getConfiguredPort?.())
    if (!verdict.ok) return { ok: false, error: verdict.error }
    const id = server.id || crypto.randomUUID()
    const s = { ...server, id, enabled: server.enabled ?? true }
    addExternalServer(s)
    return { ok: true, server: s, warnings: verdict.warnings }
  })

  ipcMain.handle('mcp:remove-external', (_, id) => deleteExternalServer(id))

  ipcMain.handle('mcp:test-external', async (_, url) => {
    const sseUrl = url.endsWith('/sse') ? url : url.replace(/\/$/, '') + '/sse'
    try {
      const res = await fetch(sseUrl, {
        signal: AbortSignal.timeout(5000),
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
      })
      const ct = res.headers.get('content-type') || ''
      if (res.ok && ct.includes('text/event-stream')) {
        return { ok: true, message: 'Connected' }
      }
      return { ok: false, message: `Unexpected response: ${res.status} (${ct || 'no content-type'})` }
    } catch (err) {
      return { ok: false, message: err.message }
    }
  })
}
