'use strict'

import * as crypto from 'node:crypto'
import * as net from 'node:net'

// =============================================================================
// Redstart Nest — trusting the bundled Caddy, and nothing else (TLS plan C6)
// =============================================================================
// When Nest's own Caddy fronts the data plane, every LAN request reaches the
// gateway from 127.0.0.1. Keyed on the socket, every household member would
// then share one rate-limit bucket, and one guesser could lock everyone out
// of login. So the gateway needs the real client address, and Caddy has it.
//
// What makes that safe is a per-launch secret. Caddy SETS X-Redstart-Proxy
// on every proxied request (caddy-config.mjs; test-caddy-live proves a
// client's forged copy is overwritten), and Caddy REPLACES a client-sent
// X-Forwarded-For with the real peer (no trusted_proxies; also proven live).
// A request is "from our proxy" only when ALL of these hold:
//   - the secret is set: Nest's Caddy is running in this process's lifetime;
//   - the header equals it, compared in constant time;
//   - the socket peer is loopback, which is where Caddy connects from.
// Then, and only then, the first X-Forwarded-For hop is the client.
//
// The secret is 32 CSPRNG bytes made at each Caddy start, held in memory,
// passed to Caddy by environment, and never written to disk.
//
// Without Nest's Caddy (network mode off, HTTPS off, or a bring-your-own
// proxy) there is no secret, nothing is trusted, and clientAddress() is
// exactly req.socket.remoteAddress: today's behaviour. A BYO proxy's callers
// still share one bucket. rate-limit.mjs records why that is accepted.
//
// The control plane never sees this (Caddy never routes it, D6), so
// admin/http.mjs's remoteAddress() stays socket-only.
// =============================================================================

export const PROXY_HEADER_NAME = 'x-redstart-proxy'

/** @type {Buffer|null} */
let secret = null

/** Make and remember a new secret; returns it (hex) for Caddy's environment. */
export function newProxySecret() {
  const bytes = crypto.randomBytes(32)
  secret = Buffer.from(bytes.toString('hex'), 'utf8')
  return secret.toString('utf8')
}

/** Forget the secret: Caddy stopped, so nothing proxied is trusted any more. */
export function clearProxySecret() {
  secret = null
}

/** Test seam. */
export function hasProxySecret() {
  return secret !== null
}

function isLoopback(address) {
  if (typeof address !== 'string') return false
  const a = address.startsWith('::ffff:') ? address.slice(7) : address
  return a === '::1' || (net.isIPv4(a) && a.startsWith('127.'))
}

/** Did this request come through Nest's own Caddy? */
export function isFromOwnProxy(req) {
  if (!secret) return false
  const raw = req?.headers?.[PROXY_HEADER_NAME]
  if (typeof raw !== 'string') return false
  const given = Buffer.from(raw, 'utf8')
  if (given.length !== secret.length || !crypto.timingSafeEqual(given, secret)) return false
  return isLoopback(req?.socket?.remoteAddress)
}

/**
 * The client's address: the first X-Forwarded-For hop for a request through
 * Nest's own Caddy, the socket peer otherwise. A forwarded value that is not
 * an IP address falls back to the socket rather than becoming a key.
 */
export function clientAddress(req) {
  const socketAddress = req?.socket?.remoteAddress || 'unknown'
  if (!isFromOwnProxy(req)) return socketAddress
  const first = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
  return net.isIP(first) ? first : socketAddress
}
