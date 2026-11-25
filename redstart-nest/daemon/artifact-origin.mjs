'use strict'

// =============================================================================
// Redstart Nest — where the viewer finds artifact content (artifacts plan D9)
// =============================================================================
// A pure function: how the chat app reached Nest (the request's headers) and
// the LAN state (lan.mjs artifactContentTarget) in, the content origin out,
// or null with a sentence when there is none the caller can reach.
//
//   through Caddy, HTTPS, the device name:
//       Automatic name, art.<name> published   → https://art.<name>
//       otherwise                              → https://<name>:8444
//   through Caddy, plain HTTP (HTTPS not serving yet): none. The content
//       listener is on loopback then, and Caddy never serves artifact pages in
//       plain text (caddy-config.mjs).
//   direct (no proxy): the Host the app used, on the content port. The
//       content listener binds where the gateway does, so whoever reached the
//       gateway reaches it: loopback in local and lan-https, the LAN in
//       lan-http and lan-https-fallback.
//   a proxy that is not Nest's own (HTTPS on another name): none; Nest
//       cannot promise that proxy routes a second origin.
//
// The forwarded headers decide only which URL the caller's own viewer is
// told, the same exception builtInMcpUrl (tools-gateway.mjs) documents: a
// spoofed one misdirects nobody but the spoofer, and the URL still needs a
// view token to serve anything.
// =============================================================================

import { CONTENT_HTTPS_PORT, contentHostnameFor } from './caddy-config.mjs'

const HOST = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/

const first = (raw) => typeof raw === 'string' ? raw.split(',')[0].trim() || null : null
/** "name:port" → "name"; "[::1]:80" → "[::1]". */
const hostOnly = (h) => h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0]

/**
 * @param {Record<string, string | string[] | undefined>} headers
 * @param {{ state: string, hostname: string | null, automatic: boolean, serving: boolean, contentNamePublished: boolean }} target
 * @param {number} contentPort
 * @returns {{ origin: string } | { origin: null, reason: string }}
 */
export function contentOriginFor(headers, target, contentPort) {
  const proto = first(headers['x-forwarded-proto'])?.toLowerCase()
  const fwdHost = first(headers['x-forwarded-host']) ?? (typeof headers.host === 'string' ? headers.host : null)

  if (proto === 'https') {
    if (!fwdHost || !HOST.test(fwdHost) || !target.hostname || hostOnly(fwdHost).toLowerCase() !== target.hostname.toLowerCase()) {
      return { origin: null, reason: 'Artifacts cannot be shown through this proxy. Open Redstart by its own address, or through Nest\'s own HTTPS name.' }
    }
    if (target.automatic && target.contentNamePublished) return { origin: `https://${contentHostnameFor(target.hostname)}` }
    return { origin: `https://${target.hostname}:${CONTENT_HTTPS_PORT}` }
  }
  if (proto === 'http' && target.state === 'lan-https') {
    return { origin: null, reason: 'Artifacts open once HTTPS is working on this Nest.' }
  }
  const host = typeof headers.host === 'string' && HOST.test(headers.host) ? hostOnly(headers.host) : '127.0.0.1'
  return { origin: `http://${host}:${contentPort}` }
}
