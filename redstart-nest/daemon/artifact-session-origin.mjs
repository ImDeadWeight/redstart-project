'use strict'

// =============================================================================
// Redstart Nest — the chat app's origin, as an MCP client reached Nest
// =============================================================================
// Nest builds every artifact link (artifacts plan D13), including the "Open"
// link in a tool result, which has no HTTP request of its own to read. So the
// MCP session records, at initialize, the origin the chat app is on:
//
//   through a proxy (X-Forwarded-Proto/Host, Nest's Caddy routes /mcp on the
//   app's own origin)       → that origin, as the proxy says
//   direct                  → the Host the client used, with the GATEWAY's
//                             port: the MCP server listens on gateway + 2
//                             (ports.mjs serverPortFamily), and the app is
//                             on the gateway
//
// The same exception builtInMcpUrl documents: the value only decides what the
// caller's own client is told. Validated, never echoed: a malformed header
// gives no link rather than a URL that is not one.
// =============================================================================

const HOST = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/
const first = (raw) => typeof raw === 'string' ? raw.split(',')[0].trim() || null : null
const hostOnly = (h) => h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0]

/**
 * @param {Record<string, string | string[] | undefined>} headers  the initialize request's
 * @param {number | null} mcpPort  the port the MCP server listens on
 * @returns {string | null}
 */
export function mcpAppOrigin(headers, mcpPort) {
  const proto = first(headers?.['x-forwarded-proto'])?.toLowerCase()
  if (proto === 'http' || proto === 'https') {
    const host = first(headers['x-forwarded-host']) ?? (typeof headers.host === 'string' ? headers.host : null)
    return host && HOST.test(host) ? `${proto}://${host}` : null
  }
  const host = typeof headers?.host === 'string' && HOST.test(headers.host) ? hostOnly(headers.host) : null
  if (!host || !Number.isInteger(mcpPort) || mcpPort < 3) return null
  return `http://${host}:${mcpPort - 2}`
}

/** What a tool reads back: the origin recorded on its MCP session, or null (no session: a task). */
export function appOriginFromSession(session) {
  return typeof session?.appOrigin === 'string' ? session.appOrigin : null
}
