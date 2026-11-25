'use strict'

// =============================================================================
// Redstart Nest — the artifact content listener (artifacts plan D9, §8)
// =============================================================================
// Artifact pages are model-written HTML and script. They run ONLY here: on a
// port of its own (ARTIFACT_CONTENT_PORT), which makes it an origin of its
// own, never the chat app's, whose login token sits in localStorage where any
// script on that origin could read it. Caddy, when it fronts Nest, reaches
// this listener as art.<hostname> (Automatic names) or <hostname>:8444, and
// nothing else (caddy-config.mjs).
//
//   GET /a/<view token>/<path>   one file of the token's artifact + revision
//   GET /a/<view token>/         → 302 to the entry file
//
// Nothing else is served, no method but GET and HEAD, no cookie set or read,
// no bearer token accepted: the view token in the path is the only key
// (artifact-view-tokens.mjs). The account it names must still be able to read
// the artifact at the moment of each request.
//
// EVERY RESPONSE (errors and redirects too) carries:
//   Content-Security-Policy  `sandbox allow-scripts allow-forms allow-modals`
//       (an opaque origin even when opened directly in a tab), default-src
//       'self' data: blob:, connect-src 'self', form-action 'self' (Phase 0:
//       'self' still matches this listener's URL under sandbox), and
//       frame-ancestors = the origin of the page that asked for the token,
//       or 'none'.
//   Referrer-Policy: no-referrer    the token is in the path
//   X-Content-Type-Options: nosniff
//   Cache-Control: private, no-store
//   Access-Control-Allow-Origin: *  an opaque-origin page's fetch of its own
//       files is a CORS request (Phase 0); there are no credentials here to
//       leak, and the token is the only key
//   Permissions-Policy               camera, microphone, geolocation, … off
// =============================================================================

import * as http from 'http'
import * as path from 'path'
import { verifyViewToken } from './artifact-view-tokens.mjs'
import { getArtifact, readForViewToken, entryForViewToken } from './artifacts-storage.mjs'
import { findById as findAccountById } from './accounts-storage.mjs'
import { getAuthRequired } from './auth.mjs'
import { rebindHttpServer } from './listener-rebind.mjs'
import { ARTIFACT_CONTENT_PORT } from './ports.mjs'
import { injectReporter } from './artifact-reporter.mjs'

const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', svg: 'image/svg+xml', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', ico: 'image/x-icon', woff2: 'font/woff2',
}

/** The headers every content response carries. @param {string | null} embedder */
export function contentHeaders(embedder) {
  const csp = [
    'sandbox allow-scripts allow-forms allow-modals',
    "default-src 'self' data: blob:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
    "style-src 'self' 'unsafe-inline' data:",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'self'",
    `frame-ancestors ${embedder ?? "'none'"}`,
  ].join('; ')
  return {
    'Content-Security-Policy': csp,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    'Access-Control-Allow-Origin': '*',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), payment=(), display-capture=()',
  }
}

const ROUTE = /^\/a\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(\/.*)?$/

function send(res, status, headers, body = '', method = 'GET') {
  res.writeHead(status, { ...headers, 'Content-Length': Buffer.byteLength(body) })
  res.end(method === 'HEAD' ? undefined : body)
}

/** The account a token names, as it stands now; undefined when it is gone or disabled. */
function accountFor(key) {
  if (key === '_local') return getAuthRequired() ? undefined : null
  const a = findAccountById(key)
  return a && a.status !== 'disabled' ? a : undefined
}

/** Handle one request to the content listener. Exported for tests. */
export function handleContentRequest(req, res, { now = Date.now() } = {}) {
  const method = req.method ?? 'GET'
  const bare = contentHeaders(null)
  let urlPath
  try { urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]) } catch { return send(res, 400, bare, 'Bad request', method) }
  if (method !== 'GET' && method !== 'HEAD') return send(res, 405, { ...bare, Allow: 'GET, HEAD' }, 'Method not allowed', method)
  const m = ROUTE.exec(urlPath)
  if (!m) return send(res, 404, bare, 'Not found', method)

  const token = verifyViewToken(m[1], { now })
  if (!token) return send(res, 403, bare, 'This link has expired. Reopen the artifact.', method)
  const headers = contentHeaders(token.origin)
  // Access as it stands now, not as it stood when the token was issued.
  const account = accountFor(token.accountKey)
  if (account === undefined) return send(res, 404, headers, 'Not found', method)
  const art = getArtifact(account, token.artifactId, { now })
  if (!art) return send(res, 404, headers, 'Not found', method)
  if (token.revision !== 'draft' && token.revision > art.head) return send(res, 404, headers, 'Not found', method)

  const at = { revision: token.revision, holderKey: token.accountKey }
  const rel = (m[2] ?? '').replace(/^\/+/, '')
  if (rel === '') {
    const entry = entryForViewToken(token.artifactId, at)
    if (!entry) return send(res, 404, headers, 'This artifact has no page to show yet.', method)
    return send(res, 302, { ...headers, Location: `/a/${m[1]}/${entry.split('/').map(encodeURIComponent).join('/')}` }, '', method)
  }
  let data = readForViewToken(token.artifactId, rel, at)
  if (!data) return send(res, 404, headers, 'Not found', method)
  const ext = path.posix.extname(rel).slice(1).toLowerCase()
  const type = TYPES[ext] ?? 'application/octet-stream'
  if (token.report && type.startsWith('text/html')) data = Buffer.from(injectReporter(data.toString('utf8')), 'utf8')
  res.writeHead(200, { ...headers, 'Content-Type': type, 'Content-Length': data.length })
  res.end(method === 'HEAD' ? undefined : data)
}

let server = null

/**
 * Start the listener. Its bind follows the data plane's (network-mode owner):
 * loopback while Caddy fronts Nest or the network is off, the wildcard for
 * plain-HTTP LAN.
 */
export function startContentListener({ bindHost = '127.0.0.1', port = ARTIFACT_CONTENT_PORT } = {}) {
  stopContentListener()
  return new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => {
      try { handleContentRequest(req, res) } catch (err) {
        if (!res.headersSent) send(res, 500, contentHeaders(null), 'Internal error')
        console.warn('Artifact content request failed:', err.message)
      }
    })
    s.on('error', (err) => { if (server === s) server = null; reject(err) })
    s.listen(port, bindHost, () => { server = s; resolve(port) })
  })
}

/** Move the listener to another bind host (network-mode owner). A no-op when it is not running. */
export async function rebindContentListener(bindHost) {
  if (!server) return false
  const old = server
  server = null
  server = await rebindHttpServer(old, bindHost)
  return true
}

export function stopContentListener() {
  if (server) {
    server.closeAllConnections()
    server.close()
    server = null
  }
}

export function contentListenerRunning() { return server !== null }
