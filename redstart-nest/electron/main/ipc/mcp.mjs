// MCP IPC namespace — external MCP server registry (list/add/remove) and a
// connectivity probe.
//
// All collaborators come from tools-storage / node:crypto, so no deps needed.
import { handle } from './guard.mjs'
import * as crypto from 'crypto'
import { getExternalServers, addExternalServer, deleteExternalServer } from '../tools-storage.mjs'
import { validateExternalMcpUrl } from '../external-mcp-url.mjs'
import { isPlainObject } from './validate.mjs'

export function registerMcpHandlers({ getConfiguredPort } = {}) {
  // --- MCP ---

  handle('mcp:list-external', () => getExternalServers())

  // Validation lives here rather than in the renderer: this is the only entry
  // point that can write to the registry, so a check anywhere else would be
  // advisory. Refusals are limited to what is incoherent (bad scheme, no host)
  // or self-defeating (Nest's own ports); everything else is returned as a
  // warning for the UI to show, because an admin at the console is allowed to
  // point Nest at a plaintext LAN appliance. See external-mcp-url.mjs.
  handle('mcp:validate-external', (_, url) =>
    validateExternalMcpUrl(url, getConfiguredPort?.()))

  handle('mcp:add-external', (_, server) => {
    if (!isPlainObject(server)) return { ok: false, error: 'An external server must be an object.' }
    const verdict = validateExternalMcpUrl(server.url, getConfiguredPort?.())
    if (!verdict.ok) return { ok: false, error: verdict.error }
    const id = server.id || crypto.randomUUID()
    const s = { ...server, id, enabled: server.enabled ?? true }
    addExternalServer(s)
    return { ok: true, server: s, warnings: verdict.warnings }
  })

  handle('mcp:remove-external', (_, id) => deleteExternalServer(id))

  // This probe fetches a renderer-supplied URL FROM THE MAIN PROCESS, which
  // makes it exactly as much of an egress primitive as mcp:add-external — and
  // it was the one entry point that skipped validateExternalMcpUrl entirely,
  // so it bypassed the external-mcp-url.mjs control outright. It also called
  // .endsWith() on an unchecked value, so a non-string argument threw.
  handle('mcp:test-external', async (_, url) => {
    const verdict = validateExternalMcpUrl(url, getConfiguredPort?.())
    if (!verdict.ok) return { ok: false, message: verdict.error }
    const trimmed = url.trim()
    const endpoint = trimmed.replace(/\/$/, '')
    try {
      const res = await fetch(endpoint, {
        signal: AbortSignal.timeout(5000),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'redstart-test', version: '1.0.0' },
          },
        }),
      })
      const ct = res.headers.get('content-type') || ''
      let data
      try {
        data = await res.json()
      } catch {
        return { ok: false, message: `Unexpected response: ${res.status} (${ct || 'no content-type'}, not JSON)` }
      }
      if (res.ok && data?.jsonrpc === '2.0' && data?.result?.protocolVersion && data?.result?.serverInfo) {
        return { ok: true, message: `Connected to ${data.result.serverInfo.name || 'unknown'} (${data.result.protocolVersion})` }
      }
      const errMsg = data?.error?.message || data?.message || 'unexpected response shape'
      return { ok: false, message: `Unexpected response: ${res.status} — ${errMsg}` }
    } catch (err) {
      return { ok: false, message: err.message }
    }
  })
}
