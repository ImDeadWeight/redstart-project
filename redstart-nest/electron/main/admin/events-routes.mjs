'use strict'

// =============================================================================
// Redstart Nest — GET /admin/events, the control plane's live feed
// =============================================================================
// Server-Sent Events over the SAME bearer-token auth as every other admin
// route. Deliberately not the browser's native EventSource — it cannot attach
// an Authorization header, and this listener sends no cookie for it to ride on
// instead (admin-listener.mjs's header explains why: no CSRF token needed
// because there is no cookie). The client (src/api/http.ts) reads the stream
// with `fetch()` + a `ReadableStream` reader instead, which can carry the
// header, and gets ordinary text/event-stream framing back.
//
// One route, not one per channel — a client that wants only server:log still
// has to filter client-side, but that keeps this a single always-open
// connection per session rather than five, and matches how the preload's
// separate on/off methods were always really "subscribe to the one event
// firehose and pick out what you asked for" already (ipcRenderer.on is a
// per-channel firehose subscription with the exact same shape).
//
// GATING: this route is checked the same way admin/api-routes.mjs is —
// admin-listener.mjs authenticates and authorises BEFORE dispatch reaches
// here, so there is no separate check to forget.
// =============================================================================

import { subscribeToEvents } from '../event-broker.mjs'
import { ringBuffer } from '../process-log.mjs'

const PATH = '/admin/events'
const KEEPALIVE_MS = 20_000

export function isAdminEventsRoute(urlPath) {
  return urlPath === PATH
}

function writeEvent(res, data) {
  // One JSON object per SSE "data:" field. Every event this daemon emits is
  // small (a log line, a percentage, a status delta) — nothing here streams
  // large binary content, so one JSON.stringify per event is not a concern.
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

export function handleAdminEventsRoute(req, res) {
  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET' })
    return res.end()
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Connection: 'keep-alive',
  })

  // Catch-up for a reconnecting client — the ring buffer, replayed as one
  // batch so a crash the admin reopens the page to look at is on screen
  // immediately rather than trickling in as if it just happened.
  writeEvent(res, { type: 'replay', channel: 'server:log', lines: ringBuffer() })

  const unsubscribe = subscribeToEvents((channel, payload) => {
    writeEvent(res, { type: 'event', channel, payload })
  })

  // Idle SSE connections get silently dropped by some proxies/browsers well
  // under a minute; a comment line (ignored by any SSE parser, including
  // ours) is enough to keep the socket looking alive without being a real
  // event a subscriber has to filter out.
  const keepalive = setInterval(() => {
    try { res.write(': keep-alive\n\n') } catch { /* the close handler below cleans up */ }
  }, KEEPALIVE_MS)

  const cleanup = () => {
    clearInterval(keepalive)
    unsubscribe()
  }
  req.on('close', cleanup)
  res.on('error', cleanup)
}
