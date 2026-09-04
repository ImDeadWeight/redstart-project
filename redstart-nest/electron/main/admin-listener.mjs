'use strict'

// =============================================================================
// Redstart Nest — Admin listener (the control plane)
// =============================================================================
// Modelled on beacon.mjs, NOT on the gateway: bound at app start, up for as
// long as Nest is, indifferent to whether a llama-server is running. A
// control plane whose lifetime is tied to the thing it controls is not a
// control plane — that test is why this is a separate listener rather than
// an /admin prefix on the gateway.
//
// THREE WAYS THIS DIFFERS FROM THE GATEWAY, all deliberate:
//
//   AUTH IS MANDATORY. The gateway honours `authRequired`; this listener never
//   reads it. authenticateControlPlane() in auth.mjs is a separate door for
//   exactly that reason, and it accepts sessions only — never an API key that
//   might be sitting in a third-party tool client's config file.
//
//   NO CORS. The gateway sends `Access-Control-Allow-Origin: *` because its
//   clients are other origins by design. This listener serves its own UI from
//   its own origin and has no business being called cross-origin at all, so it
//   sends no CORS headers and answers no preflight — including for the
//   Electron launcher, which reaches it same-origin, either directly
//   (packaged) or through Vite's dev-server proxy (dev; see vite.config.ts)
//   rather than by this listener granting a foreign origin anything.
//
//   THE STATIC LAYER IS AN ALLOWLIST, NOT A PATTERN. isPublicAsset() in
//   tools-gateway.mjs decides what gets forwarded UNAUTHENTICATED to
//   llama-server — a program Nest does not control and whose route table is
//   upstream's to change. It is a proxy rule wearing a file server's clothes,
//   and it must never learn about admin paths. What is below is a different
//   mechanism: the set of files Nest itself shipped, enumerated off disk at
//   start and looked up by exact match. A request path that is not a key in
//   that map is not served, which is what makes `..` traversal structurally
//   impossible here rather than filtered.
//
// The static bundle is served out of `dist/` with fs, which inside a packaged
// build means reading through Electron's asar shim. Fine for as long as the
// daemon lives inside Electron; the day it moves out, the bundle has to be
// unpacked beside it.
// =============================================================================

import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import { isIP } from 'net'
import { fileURLToPath } from 'url'
import { authenticateControlPlane } from './auth.mjs'
import { mayAccessControlPlane } from './permissions.mjs'
import { ADMIN_PORT } from './ports.mjs'
import { isAdminAuthRoute, handleAdminAuthRoute } from './admin/auth-routes.mjs'
import { isAdminApiRoute, handleAdminApiRoute } from './admin/api-routes.mjs'
import { isAdminEventsRoute, handleAdminEventsRoute } from './admin/events-routes.mjs'
import { sendJson } from './admin/http.mjs'
import { parseAllowedOrigins, corsHeaders, isPreflight } from './admin/cors.mjs'
import { logEvent } from './logger.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Where the control plane binds when nothing has said otherwise. Fail closed. */
export const DEFAULT_ADMIN_BIND_HOST = '127.0.0.1'

let adminServer = null
let activeBind = null // { bindHost, port }

// ---------------------------------------------------------------------------
// Exposure — availability and exposure are separate axes
// ---------------------------------------------------------------------------
// Availability is not a toggle: the listener is always up. What IS settable
// is WHERE it binds, and that is a bind ADDRESS rather than a boolean, so
// one setting covers loopback, a VPN interface, a management VLAN and the
// full LAN without inventing a mechanism for each. Deliberately NOT
// `networkMode`, which is data-plane state read once at server launch
// (ipc/server.mjs) — keying the control plane to it would rebuild the
// coupling this design removes.

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

/** Is this bind address reachable only from the machine itself? */
export function isLoopbackBind(host) {
  return LOOPBACK.has(String(host ?? '').trim())
}

/**
 * Reject a bind address that is not something this host can meaningfully bind.
 *
 * Hostnames are refused rather than resolved: "bind to whatever this name
 * resolves to right now" is not a stable exposure decision, and the point of
 * the setting is that an admin can state exposure exactly. Same
 * reason-or-null shape as binaryPathRejection() in ipc/validate.mjs.
 *
 * @returns {string|null} the reason to refuse, or null if acceptable.
 */
export function bindHostRejection(host) {
  if (typeof host !== 'string' || !host.trim()) return 'A bind address must be a non-empty string.'
  const value = host.trim()
  if (value === '0.0.0.0' || value === '::') return null
  if (isLoopbackBind(value)) return null
  if (!isIP(value)) return 'A bind address must be an IP address, not a hostname.'
  return null
}

// ---------------------------------------------------------------------------
// Static bundle — the files Nest shipped, and nothing else
// ---------------------------------------------------------------------------

/** The built launcher bundle. Same directory index.mjs's packaged-build window load points at. */
function bundleRoot() {
  return path.join(__dirname, '..', '..', 'dist')
}

// An extension filter ON TOP OF the enumeration, not instead of it. The
// enumeration is what makes this an allowlist; this set only stops a stray
// non-web file that lands in dist/ (a .env, a .pdb, a stray key) from being
// served merely because the build put it there.
const SERVABLE = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.webmanifest', 'application/manifest+json'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.txt', 'text/plain; charset=utf-8'],
])

const MAX_BUNDLE_DEPTH = 8

function walkBundle(dir, urlPrefix, out, depth) {
  if (depth > MAX_BUNDLE_DEPTH) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return // no dist/ yet (an unbuilt dev tree) — an empty allowlist, not an error
  }
  for (const entry of entries) {
    // Never followed. A symlink inside the bundle is a way to point the
    // allowlist at a file outside it, which would undo the containment the
    // exact-match map is there to give.
    if (entry.isSymbolicLink()) continue
    const abs = path.join(dir, entry.name)
    const url = `${urlPrefix}/${entry.name}`
    if (entry.isDirectory()) walkBundle(abs, url, out, depth + 1)
    else if (entry.isFile() && SERVABLE.has(path.extname(entry.name).toLowerCase())) out.set(url, abs)
  }
}

/**
 * URL path -> absolute file, for every file the shipped bundle contains.
 *
 * A SNAPSHOT, taken when the listener starts. A file dropped into dist/ while
 * Nest is running is not served until it restarts, which is the correct reading
 * of "the files Nest shipped" rather than a caching accident.
 */
export function buildStaticAllowlist(root = bundleRoot()) {
  const files = new Map()
  walkBundle(root, '', files, 0)
  // The SPA entry point, reachable at the bare origin as well as by name.
  const index = files.get('/index.html')
  if (index) files.set('/', index)
  return files
}

let staticFiles = new Map()

// Overridable for tests only, exactly like `port` below — a suite needs a
// bundle whose contents it controls rather than whatever `npm run build`
// last left in dist/, which is nothing at all on a CI runner that never
// built one. Remembered across restarts so a rebind (setControlPlaneBindHost)
// does not swap the bundle out from under a running suite.
let staticRoot = null

// The validated CORS allowlist. Empty means no CORS headers at all, which is
// today's behaviour and the default.
let corsOrigins = []

// Applied to the HTML this listener serves, which is a page that actually
// loads in a browser rather than in an Electron window with a session CSP
// already on it. Stricter than the Electron one (index.mjs), because the
// built bundle needs less: the entry point is an external module script, so
// script-src needs no 'unsafe-inline' at all. Styles do — React writes style
// attributes, which style-src blocks without it.
//
// `connect-src 'self'` is the load-bearing one here. Every call this page makes
// goes to the admin listener it was served by; a script that got onto this
// origin could still act as the admin, but it could not quietly ship what it
// found anywhere else.
const ADMIN_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ')

function serveStatic(req, res, absPath) {
  const type = SERVABLE.get(path.extname(absPath).toLowerCase()) || 'application/octet-stream'
  let body
  try {
    body = fs.readFileSync(absPath)
  } catch {
    // Enumerated at start, gone now. Nothing to fall back to.
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('Not found')
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': body.length,
    // The admin UI is process control. Never cached by anything in between,
    // never sniffed into a different type, never framed by another page.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    // On the document only. A CSP on a .js response governs nothing — the
    // policy that matters is the one on the page that loaded it.
    ...(type.startsWith('text/html') ? { 'Content-Security-Policy': ADMIN_CSP } : {}),
  })
  if (req.method === 'HEAD') return res.end()
  res.end(body)
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
// Gate FIRST, route second. An unknown path gets 401 rather than 404, so the
// listener does not answer "does this route exist?" to anyone who has not
// authenticated, and a route added later is gated by default rather than by
// whoever remembers.
//
// Denials are deliberately NOT logged per request — on a non-loopback bind
// this port joins the population the internet scans continuously, and a log
// line per probe is a disk-filling primitive handed to strangers. The events
// worth having arrive with the auth routes, which are rate-limited and
// logged there.

async function handleAdminRequest(req, res) {
  let urlPath
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0])
  } catch {
    return sendJson(res, 400, { error: 'Malformed request path' })
  }

  // Set on the response ONCE, here, rather than threaded through every
  // route: Node merges setHeader() values into whatever writeHead() later
  // sends, so this reaches every handler without each having to know about
  // CORS. Applied to the 401s too — a browser cannot read a response that
  // lacks CORS headers, reporting it as a network error instead, so a remote
  // admin would otherwise be told "connection failed" when the real answer
  // was "your session expired".
  const cors = corsHeaders(req.headers['origin'], corsOrigins)
  for (const [name, value] of Object.entries(cors)) res.setHeader(name, value)

  // Preflight is answered BEFORE the gate. It carries no credentials by
  // definition, so gating it would 401 every cross-origin request before the
  // real one was ever sent. 204 with no body, and no CORS headers at all if
  // the origin is not on the list — which is itself the correct answer.
  if (isPreflight(req)) {
    res.writeHead(204)
    return res.end()
  }

  // The app shell, anonymous — the login screen cannot appear until it loads,
  // and a browser cannot attach a bearer token to a document navigation anyway.
  // Exact-match lookup: `/../accounts.json` is simply not a key.
  if (req.method === 'GET' || req.method === 'HEAD') {
    const file = staticFiles.get(urlPath)
    if (file) return serveStatic(req, res, file)
  }

  // Login and bootstrap run before the gate and do their own authentication
  // — the same shape the gateway uses for /auth/*. They are also the only
  // two routes here that take a secret from a stranger, which is why they
  // carry the rate limits.
  if (isAdminAuthRoute(urlPath)) {
    return await handleAdminAuthRoute(req, res, urlPath)
  }

  const authResult = authenticateControlPlane(req)
  if (!authResult.ok) return sendJson(res, 401, { error: 'Unauthorized' })
  if (!mayAccessControlPlane(authResult.account)) return sendJson(res, 403, { error: 'Forbidden' })

  // Everything past this line has an owner. The API surface is one route per
  // RedstartAPI method (admin/api-routes.mjs); the gate stays HERE rather than
  // being repeated per route, which is what makes a route added later gated by
  // default instead of by whoever remembers.
  if (isAdminApiRoute(urlPath)) {
    return await handleAdminApiRoute(req, res, urlPath)
  }

  // The live feed — a GET, not a POST/JSON route, so it lives beside the API
  // dispatch rather than in its table: an SSE response is opened and held,
  // not returned once.
  if (isAdminEventsRoute(urlPath)) {
    return handleAdminEventsRoute(req, res)
  }

  // Still earning its place: the cheapest possible probe that the gate above
  // lets the right caller through, with no side effects to reason about when
  // it fails.
  if (req.method === 'GET' && urlPath === '/admin/whoami') {
    return sendJson(res, 200, { user: authResult.account })
  }

  return sendJson(res, 404, { error: 'Not found' })
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Bind the control plane.
 *
 * @param {object} [options]
 * @param {string} [options.bindHost] defaults to loopback — a caller must ASK
 *   for exposure, the same fail-closed contract startGateway() has.
 * @param {number} [options.port] overridable for tests only; fixed in
 *   production so a client can find it without being told.
 * @param {string} [options.bundleRoot] overridable for tests only; production
 *   always serves the bundle Nest shipped.
 * @returns {Promise<{ bindHost: string, port: number }>}
 */
export function startAdminListener({ bindHost = DEFAULT_ADMIN_BIND_HOST, port = ADMIN_PORT, allowedOrigins, bundleRoot: root } = {}) {
  stopAdminListener()

  const rejection = bindHostRejection(bindHost)
  if (rejection) return Promise.reject(new Error(rejection))

  // Empty unless a deployment asked for it, and a bad list is
  // refused wholesale rather than partially applied. Logged, not thrown: a
  // malformed CORS setting must not stop the control plane from binding,
  // because the control plane is what an admin uses to fix the setting.
  const parsed = parseAllowedOrigins(allowedOrigins)
  if (parsed.rejection) {
    console.warn(`[admin-listener] ignoring allowedOrigins: ${parsed.rejection}`)
    logEvent('admin', 'cors_config_rejected', { reason: parsed.rejection })
  }
  corsOrigins = parsed.origins

  if (root !== undefined) staticRoot = root
  staticFiles = buildStaticAllowlist(staticRoot ?? bundleRoot())

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // A rejected promise from an async route must not become an unhandled
      // rejection that takes the daemon down — the control plane is the thing
      // an admin uses to fix a box, so it is the last listener that may crash.
      Promise.resolve()
        .then(() => handleAdminRequest(req, res))
        .catch((err) => {
          if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' })
          else res.end()
          console.warn('[admin-listener] request failed:', err.message)
        })
    })

    server.on('error', (err) => {
      adminServer = null
      activeBind = null
      reject(err)
    })

    server.listen(port, bindHost, () => {
      adminServer = server
      activeBind = { bindHost, port }
      logEvent('admin', 'listener_started', { port, loopback: isLoopbackBind(bindHost) })
      console.log(`Redstart Nest admin listener on ${bindHost}:${port} (${staticFiles.size} bundled files)`)
      resolve({ bindHost, port })
    })
  })
}

export function stopAdminListener() {
  if (!adminServer) return
  try { adminServer.close() } catch {}
  adminServer = null
  activeBind = null
}

/**
 * What the UI needs to render the exposure warning.
 * `exposed` is the fact that matters: forwarding a non-loopback control plane
 * through a router is what turns a low-risk deployment into a scanned one.
 */
export function getAdminListenerState() {
  return {
    running: !!adminServer,
    bindHost: activeBind?.bindHost ?? null,
    port: activeBind?.port ?? ADMIN_PORT,
    exposed: activeBind ? !isLoopbackBind(activeBind.bindHost) : false,
  }
}
