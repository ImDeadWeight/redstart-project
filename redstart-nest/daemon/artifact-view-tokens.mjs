'use strict'

// =============================================================================
// Redstart Nest — artifact view tokens (artifacts plan D10, §8)
// =============================================================================
// A sandboxed iframe has an opaque origin: it cannot send the bearer token,
// and must never have it. So the viewer asks the gateway (authenticated) for
// a short-lived, read-only token for ONE artifact at ONE revision (or the
// caller's live draft), and the frame loads
//
//   <content origin>/a/<token>/<path>
//
// The token is base64url(JSON payload) + "." + base64url(HMAC-SHA256):
//
//   a  artifact id           r  revision number, or 'draft'
//   k  account key (whose draft; whose access is re-checked per request)
//   o  the embedding page's origin (becomes frame-ancestors), or null
//   x  1: inject the artifact_check reporter into HTML (§9)
//   e  expiry, unix seconds
//
// The key is random PER PROCESS and never written anywhere: a token dies with
// the daemon that issued it, and the viewer asks for a new one. Nothing a
// token says is trusted without its MAC, and the content listener re-checks
// the account's access on every request, so revoking access stops an issued
// token too (stricter than the plan's "lives at most its hour").
// =============================================================================

import * as crypto from 'crypto'

export const VIEW_TOKEN_TTL_S = 60 * 60
const KEY = crypto.randomBytes(32)

/**
 * An origin that may go into a CSP frame-ancestors list: scheme://host[:port]
 * and nothing else, so no space, semicolon or quote can smuggle a directive.
 * http(s) for browsers and Twig on Windows (http://twig.localhost); twig: and
 * capacitor: for the apps' own schemes.
 */
const ORIGIN = /^(?:https?:\/\/(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?|(?:twig|tauri|capacitor):\/\/localhost)$/

export function isEmbedderOrigin(origin) {
  return typeof origin === 'string' && origin.length <= 255 && ORIGIN.test(origin)
}

const b64 = (buf) => Buffer.from(buf).toString('base64url')
const mac = (body) => crypto.createHmac('sha256', KEY).update(body).digest()

/**
 * @param {{ artifactId: string, revision: number | 'draft', accountKey: string,
 *           origin?: string | null, report?: boolean, now?: number, ttlS?: number }} p
 * @returns {{ token: string, expiresAt: number }}  expiresAt in ms
 */
export function issueViewToken({ artifactId, revision, accountKey, origin = null, report = false, now = Date.now(), ttlS = VIEW_TOKEN_TTL_S }) {
  const exp = Math.floor(now / 1000) + ttlS
  const payload = { a: artifactId, r: revision, k: accountKey, o: isEmbedderOrigin(origin) ? origin : null, x: report ? 1 : 0, e: exp }
  const body = b64(JSON.stringify(payload))
  return { token: `${body}.${b64(mac(body))}`, expiresAt: exp * 1000 }
}

/**
 * The payload, when the MAC is right and it has not expired; otherwise null.
 * @returns {{ artifactId: string, revision: number | 'draft', accountKey: string, origin: string | null, report: boolean, expiresAt: number } | null}
 */
export function verifyViewToken(token, { now = Date.now() } = {}) {
  if (typeof token !== 'string' || token.length > 1024) return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null
  const body = token.slice(0, dot)
  let given
  try { given = Buffer.from(token.slice(dot + 1), 'base64url') } catch { return null }
  const want = mac(body)
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null
  let p
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch { return null }
  if (!p || typeof p !== 'object' || typeof p.a !== 'string' || typeof p.k !== 'string') return null
  if (!(p.r === 'draft' || (Number.isInteger(p.r) && p.r >= 1))) return null
  if (!Number.isInteger(p.e) || p.e * 1000 <= now) return null
  return { artifactId: p.a, revision: p.r, accountKey: p.k, origin: isEmbedderOrigin(p.o) ? p.o : null, report: p.x === 1, expiresAt: p.e * 1000 }
}
