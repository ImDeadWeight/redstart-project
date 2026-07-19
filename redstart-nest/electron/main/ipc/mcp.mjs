// MCP IPC namespace — external MCP server registry (list/add/remove) and a
// connectivity probe.
//
// All collaborators come from tools-storage / node:crypto, so no deps needed.
import { ipcMain } from 'electron'
import * as crypto from 'crypto'
import { getExternalServers, addExternalServer, deleteExternalServer } from '../tools-storage.mjs'

export function registerMcpHandlers() {
  // --- MCP ---

  ipcMain.handle('mcp:list-external', () => getExternalServers())

  ipcMain.handle('mcp:add-external', (_, server) => {
    const id = server.id || crypto.randomUUID()
    const s = { ...server, id, enabled: server.enabled ?? true }
    addExternalServer(s)
    return s
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
