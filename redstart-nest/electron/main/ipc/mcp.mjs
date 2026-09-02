// MCP IPC namespace — external MCP server registry (list/add/remove) and a
// connectivity probe.
//
// All collaborators come from tools-storage / node:crypto, so no deps needed.
//
// Handler bodies are exported as plain functions (Phase 1, §1.3 of the
// headless-admin-plane implementation plan) so an HTTP route can call them
// directly without dragging IPC registration in — importing this module never
// registers anything; only registerMcpHandlers() does that.
import * as crypto from 'crypto'
import { getExternalServers, addExternalServer, deleteExternalServer } from '../tools-storage.mjs'
import { validateExternalMcpUrl, parseMcpResponseBody } from '../external-mcp-url.mjs'
import { encryptSecret, decryptSecret } from '../secrets.mjs'
import { isPlainObject } from './validate.mjs'

// Never send apiKeyEnc (ciphertext) or a plaintext apiKey to the renderer —
// only whether one is set. Same shape rule capabilities:get follows for the
// Postgres connection string (hasConnectionString, never the string itself).
function projectExternalServer(s) {
  const { apiKeyEnc, ...rest } = s
  return { ...rest, hasApiKey: !!apiKeyEnc }
}

export function listExternalMcpServers() {
  return getExternalServers().map(projectExternalServer)
}

// Validation lives here rather than in the renderer: this is the only entry
// point that can write to the registry, so a check anywhere else would be
// advisory. Refusals are limited to what is incoherent (bad scheme, no host)
// or self-defeating (Nest's own ports); everything else is returned as a
// warning for the UI to show, because an admin at the console is allowed to
// point Nest at a plaintext LAN appliance. See external-mcp-url.mjs.
export function validateExternalMcp(url, { getConfiguredPort } = {}) {
  return validateExternalMcpUrl(url, getConfiguredPort?.())
}

// Doubles as edit: passing an existing id upserts (addExternalServer filters
// out any row with that id before pushing), same pattern as the tool/group
// registries. The renderer's Edit flow relies on this — it is not a
// separate code path.
//
// apiKey travels in on the wire as plaintext (same as Postgres's
// connectionString) but is encrypted before it touches disk and stripped
// before the response goes back out. A blank/absent apiKey on an edit KEEPS
// the existing key rather than clearing it — same "leave blank to keep
// current" convention as capabilities:set-postgres, so re-saving a server's
// name without retyping its key doesn't silently drop the key.
export function addExternalMcp(server, { getConfiguredPort } = {}) {
  if (!isPlainObject(server)) return { ok: false, error: 'An external server must be an object.' }
  const verdict = validateExternalMcpUrl(server.url, getConfiguredPort?.())
  if (!verdict.ok) return { ok: false, error: verdict.error }
  const id = server.id || crypto.randomUUID()
  const existing = id ? getExternalServers().find(s => s.id === id) : null
  const { apiKey, ...rest } = server
  let apiKeyEnc = existing?.apiKeyEnc ?? null
  if (apiKey) {
    try {
      apiKeyEnc = encryptSecret(apiKey)
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }
  const s = { ...rest, id, enabled: server.enabled ?? true, apiKeyEnc }
  addExternalServer(s)
  return { ok: true, server: projectExternalServer(s), warnings: verdict.warnings }
}

export function removeExternalMcp(id) {
  return deleteExternalServer(id)
}

// This probe fetches a renderer-supplied URL FROM THE MAIN PROCESS, which
// makes it exactly as much of an egress primitive as mcp:add-external — and
// it was the one entry point that skipped validateExternalMcpUrl entirely,
// so it bypassed the external-mcp-url.mjs control outright. It also called
// .endsWith() on an unchecked value, so a non-string argument threw.
export async function testExternalMcp(arg, { getConfiguredPort } = {}) {
  // `arg` may be null (not just the default-triggering undefined) or any
  // other junk a caller passes — destructuring null throws, so this must be
  // ?? rather than a default parameter, which only catches undefined.
  const { url, id } = arg ?? {}
  let { apiKey } = arg ?? {}
  // The renderer never holds a saved server's plaintext key (see
  // projectExternalServer), so testing an existing entry passes its id and
  // the key is decrypted here instead. `apiKey` inline is still honoured —
  // it is how the add/edit form could test a not-yet-saved key in future.
  if (!apiKey && id) {
    const existing = getExternalServers().find(s => s.id === id)
    if (existing?.apiKeyEnc) {
      try {
        apiKey = decryptSecret(existing.apiKeyEnc)
      } catch (err) {
        return { ok: false, message: `Could not decrypt the stored API key: ${err.message}` }
      }
    }
  }
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
        // Opt-in only — most external MCP servers need no auth at all, and a
        // blank/absent key must never send a literal "Bearer " header.
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
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
    const bodyText = await res.text()
    // The streamable-HTTP transport permits an SSE-framed response to a
    // JSON-RPC POST (DeepWiki's server always answers this way) — a plain
    // JSON.parse/res.json() on that body fails and misreports it as "not
    // JSON", so both framings go through one parser. See
    // external-mcp-url.mjs for why.
    const data = parseMcpResponseBody(ct, bodyText)
    if (data === null) {
      return { ok: false, message: `Unexpected response: ${res.status} (${ct || 'no content-type'}, not parseable)` }
    }
    if (res.ok && data?.jsonrpc === '2.0' && data?.result?.protocolVersion && data?.result?.serverInfo) {
      return { ok: true, message: `Connected to ${data.result.serverInfo.name || 'unknown'} (${data.result.protocolVersion})` }
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: `Unexpected response: ${res.status} — authentication required or rejected${apiKey ? ' (check the API key)' : ' (this server may need an API key)'}` }
    }
    const errMsg = data?.error?.message || data?.message || 'unexpected response shape'
    return { ok: false, message: `Unexpected response: ${res.status} — ${errMsg}` }
  } catch (err) {
    return { ok: false, message: err.message }
  }
}

export function mcpHandlers(deps = {}) {
  return {
    'mcp:list-external': () => listExternalMcpServers(),
    'mcp:validate-external': (url) => validateExternalMcp(url, deps),
    'mcp:add-external': (server) => addExternalMcp(server, deps),
    'mcp:remove-external': (id) => removeExternalMcp(id),
    'mcp:test-external': async (arg) => testExternalMcp(arg, deps),
  }
}
