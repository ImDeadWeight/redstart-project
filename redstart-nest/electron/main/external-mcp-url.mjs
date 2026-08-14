'use strict'

// =============================================================================
// Redstart Nest — External MCP endpoint validation
// =============================================================================
// An external MCP server is a SEPARATE TRUST BOUNDARY from the built-in
// providers, and a weaker one:
//
//   - its tools are executed by CLIENTS, not by our MCP server, so the
//     MCP-side permission gate never sees them (the completions-proxy tool
//     ban still applies — that is the only server-side lever)
//   - it is trusted to describe its own tools, and those descriptions reach
//     the model
//   - if it is remote, it is network egress, and gets reported as such at
//     GET /egress and in the prompt's data-handling block
//
// Registration is IPC-only — there is no HTTP route — so adding one already
// requires physical access to the host machine. That is the real control, and
// it is why this module REFUSES only what is incoherent or self-defeating and
// merely WARNS about the rest: an admin standing at the machine is allowed to
// point Nest at a plaintext LAN appliance, because that is a documented use
// case. What they should not be able to do by accident is aim it at Nest's own
// ports and create a loop with an auth boundary in the middle.
//
// Split out of ipc/mcp.mjs so the security suite can drive it without Electron.
// =============================================================================

/** Ports Nest itself listens on, relative to the configured gateway port. */
function ownPorts(gatewayPort) {
  if (!Number.isInteger(gatewayPort)) return []
  return [gatewayPort, gatewayPort + 1, gatewayPort + 2]
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])

function isLoopbackHost(hostname) {
  const h = String(hostname).toLowerCase().replace(/^\[|\]$/g, '')
  return LOOPBACK_HOSTS.has(h) || h === '::1' || /^127\./.test(h)
}

function isPrivateHost(hostname) {
  const h = String(hostname).toLowerCase()
  if (isLoopbackHost(h)) return true
  if (h.endsWith('.local')) return true
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
}

/**
 * Validate a proposed external MCP server URL.
 *
 * @param {string} url                 the candidate endpoint
 * @param {number} [gatewayPort]       the configured gateway port, so the
 *                                     self-reference check knows our own ports
 * @returns {{ ok: boolean, error?: string, warnings: string[], isRemote?: boolean }}
 */
export function validateExternalMcpUrl(url, gatewayPort) {
  if (typeof url !== 'string' || !url.trim()) {
    return { ok: false, error: 'Enter a server URL.', warnings: [] }
  }

  let parsed
  try {
    parsed = new URL(url.trim())
  } catch {
    return { ok: false, error: 'That is not a valid URL. Expected something like http://10.0.0.5:9000/path', warnings: [] }
  }

  // Scheme: anything else is either meaningless for an SSE endpoint or an
  // attempt to make the app open a local resource.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      error: `Unsupported scheme "${parsed.protocol.replace(':', '')}". An MCP server URL must be http or https.`,
      warnings: [],
    }
  }

  if (!parsed.hostname) {
    return { ok: false, error: 'That URL has no host.', warnings: [] }
  }

  // Self-reference. Registering Nest's own gateway or MCP port makes the server
  // its own tool source: clients would connect back through the auth boundary,
  // and the built-in tool list would try to include itself. Neither is useful
  // and both fail confusingly, so refuse rather than warn.
  const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80)
  if (isLoopbackHost(parsed.hostname) && ownPorts(gatewayPort).includes(port)) {
    return {
      ok: false,
      error: `Port ${port} is Redstart Nest's own (gateway, llama-server or the built-in MCP server). Pointing an external server at it would make Nest its own tool source.`,
      warnings: [],
    }
  }

  const isRemote = !isPrivateHost(parsed.hostname)
  const warnings = []

  // Warnings, not errors: each of these is a legitimate configuration for an
  // admin at the console, and refusing them would block documented use cases.
  if (parsed.protocol === 'http:' && isRemote) {
    warnings.push('This is a plaintext HTTP connection to a host outside your local network. Tool calls and their results — including anything the model sends — travel unencrypted.')
  }
  if (isRemote) {
    warnings.push('This server is outside your local network. Its tools become network egress and will be reported as such in the system prompt and at /egress.')
  }
  if (!/\/mcp\/?$/.test(parsed.pathname) && parsed.pathname !== '/') {
    warnings.push(`The path "${parsed.pathname}" does not look like a typical MCP endpoint.`)
  }

  return { ok: true, warnings, isRemote }
}

/**
 * Parse the body of an MCP `initialize` response for the connection test.
 *
 * A server on the streamable-HTTP transport is allowed to answer a JSON-RPC
 * POST with `Content-Type: text/event-stream` instead of plain JSON — several
 * real servers (e.g. DeepWiki's) do this unconditionally, regardless of which
 * of the two the client's Accept header offered first. A caller that only
 * tries `JSON.parse`/`res.json()` on the raw body sees SSE framing
 * ("event: message\ndata: {...}\n\n") and fails with a misleading "not JSON"
 * error even though the server answered correctly.
 *
 * @param {string} contentType
 * @param {string} bodyText
 * @returns {any | null} the parsed JSON-RPC message, or null if none was found
 */
export function parseMcpResponseBody(contentType, bodyText) {
  const ct = contentType || ''
  if (!ct.includes('text/event-stream')) {
    try { return JSON.parse(bodyText) } catch { return null }
  }
  // SSE framing: events are separated by a blank line; a payload is carried on
  // one or more `data:` lines, joined with "\n" if there are several. Take the
  // first event whose data parses as JSON.
  for (const block of bodyText.split(/\r?\n\r?\n/)) {
    const dataLines = block
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, ''))
    if (!dataLines.length) continue
    try { return JSON.parse(dataLines.join('\n')) } catch { /* try the next event */ }
  }
  return null
}
