'use strict'

// =============================================================================
// Redstart Nest — the control plane's API surface
// =============================================================================
// One route per RedstartAPI method: `POST /admin/api/<namespace>/<method>`, so
// `llama:launch` is /admin/api/llama/launch. The handler behind each is the
// SAME function object the preload bridge is bound to (ipc/transport.mjs), which
// is what makes "every method has a route" true by construction rather than by
// a list somebody maintains: this is the half of that invariant that lives in
// the code, and scripts/test-admin-api.mjs is the half that checks it.
//
// A ROUTE PER METHOD, NOT ONE /rpc ENDPOINT. Both are the same dispatch under
// the skin, and a single endpoint would have been fewer lines. Distinct paths
// are worth it because they make the surface enumerable from the outside: a
// reviewer, a proxy's access log and a firewall rule can all name what they are
// looking at. "Every route is gated" is a statement you can check against a list
// of routes; against one endpoint it is a tautology.
//
// EVERYTHING IS POST, reads included. This is an RPC surface mirroring an IPC
// bridge, not a REST API, and the arguments are positional JSON rather than
// path segments. Uniform POST also means no route on a process-spawning surface
// is reachable by a link, a prefetch, or an <img> tag — a GET that starts a
// server is the kind of thing that ends up in someone's browser history and
// then in a link-preview bot's crawl queue.
//
// NO CSRF TOKEN, and that is a conclusion rather than an omission: the
// credential is a bearer token the page attaches itself, never a cookie, so a
// cross-site request carries no authority. The listener sends no CORS headers
// either, so a foreign page cannot read a response even if it could send one.
//
// THE GATE IS NOT HERE. admin-listener.mjs authenticates and authorises before
// dispatch reaches this module, so there is exactly one place where the
// control-plane rule is applied and no route can be added that forgets it: one
// edit rather than an audit of every route.
// =============================================================================

import { isLocalOnly } from '../ipc/transport.mjs'
import { apiRevisionOf } from '../build-info.mjs'
import { sendJson, readJsonBody } from './http.mjs'

const PREFIX = '/admin/api/'

// Injected rather than imported, so this module — and the listener that calls it
// — stay free of the `electron` import that every ipc/*.mjs carries. See
// admin/api-table.mjs, which is the piece that knows about them.
let api = null

let revision = null

export function setAdminApi(handlers) {
  api = handlers
  revision = null
}

/**
 * The identity a client's expectations are against.
 *
 * Computed from the table that is actually registered, not from a constant
 * someone has to remember to bump, and recomputed whenever the table is
 * replaced. Null before startup has registered one, which is the honest answer
 * at that point rather than a digest of nothing.
 */
export function apiRevision() {
  if (!api) return null
  if (revision === null) revision = apiRevisionOf(Object.keys(api))
  return revision
}

export function getAdminApi() {
  return api
}

export function isAdminApiRoute(urlPath) {
  return urlPath.startsWith(PREFIX)
}

/**
 * `/admin/api/llama/launch` -> `llama:launch`.
 *
 * Exactly two segments, both from a conservative character set. A path with
 * more, fewer, or anything outside that set resolves to null and is a 404 —
 * the channel name is never assembled from arbitrary input, so there is no
 * shape of request that reaches a key the table does not already hold.
 */
export function channelFromPath(urlPath) {
  if (!isAdminApiRoute(urlPath)) return null
  const rest = urlPath.slice(PREFIX.length)
  const parts = rest.split('/')
  if (parts.length !== 2) return null
  if (!parts.every(part => /^[a-z][a-z0-9-]*$/.test(part))) return null
  return `${parts[0]}:${parts[1]}`
}

/** `llama:launch` -> `/admin/api/llama/launch`. The client builds URLs with this. */
export function pathForChannel(channel) {
  return PREFIX + channel.replace(':', '/')
}

export async function handleAdminApiRoute(req, res, urlPath) {
  if (!api) {
    // Only reachable if a request beats startup's handler registration. Not a
    // 404: the route exists, the daemon is not ready to serve it yet.
    return sendJson(res, 503, { error: 'The daemon is still starting' })
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Use POST' }, { Allow: 'POST' })
  }

  // hasOwn, not a plain lookup. The channel is built from request path segments,
  // and `api` is an object literal — so a bare `api[channel]` is a request-driven
  // property read on something with Object.prototype behind it. No key that
  // survives channelFromPath() can name a prototype member today (they all carry
  // a colon), which makes this belt to that braces rather than a fix; the point
  // is that the safety should not depend on the shape of the channel separator.
  const channel = channelFromPath(urlPath)
  const handler = channel && Object.hasOwn(api, channel) ? api[channel] : null
  if (!handler) return sendJson(res, 404, { error: 'No such method' })

  if (isLocalOnly(handler)) {
    // 501, not 403: the caller is permitted, the operation genuinely cannot be
    // carried out over this transport. A native picker browses the disk of
    // whoever is looking at the window, so answering it here would pick a path
    // on the server and hand it back as though the admin had chosen it.
    return sendJson(res, 501, {
      error: 'This action needs the local launcher — it acts on the machine you are sitting at, not on the server.',
    })
  }

  const body = await readJsonBody(req)
  if (!body || !Array.isArray(body.args)) {
    return sendJson(res, 400, { error: 'Expected a JSON body of the form { "args": [...] }' })
  }

  try {
    const result = await handler(...body.args)
    // Wrapped rather than returned bare, because plenty of these legitimately
    // return null, a bare string or a boolean, and a JSON body of `null` is
    // indistinguishable from an empty response.
    return sendJson(res, 200, { result: result ?? null })
  } catch (err) {
    // The message may name a path on the server, a binary, or a database. Logged
    // for the operator, generic for the wire — the caller is the owner, but the
    // owner is also the account an attacker is trying to become.
    // Structured rather than interpolated: console.warn treats its first
    // argument as a format string, and `channel` comes off the request path.
    // Nothing hostile can reach here — channelFromPath()'s character class
    // admits no `%`, and the channel must already be an own key of the table —
    // but a log call whose safety depends on a regex two functions away is one
    // a later edit can quietly break. Passing it as data removes the question.
    console.warn('[admin-api] handler failed', { channel, error: err?.message })
    return sendJson(res, 500, { error: 'The operation failed' })
  }
}
