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
    return { ok: false, error: 'That is not a valid URL. Expected something like http://10.0.0.5:9000/sse', warnings: [] }
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
  if (!/\/sse\/?$/.test(parsed.pathname) && parsed.pathname !== '/') {
    warnings.push(`The MCP SSE transport usually ends in /sse — "${parsed.pathname}" may not be the endpoint you want.`)
  }

  return { ok: true, warnings, isRemote }
}
