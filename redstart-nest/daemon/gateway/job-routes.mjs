'use strict'

// =============================================================================
// Redstart Nest — gateway routes for background jobs (agent-runtime plan
// Phase 3, D31)
// =============================================================================
// The account's own tasks. Every route acts on the caller's scope only: the
// task's owner (memoryKey) and its conversations scope must both be the
// caller's, or the answer is 404, so ids cannot be probed.
//
//   POST /jobs                   { conversationId, content, generation?, maxTurns?,
//                                  clientTools?, toolLimits?, origin? }
//                                origin: 'chat' (a plain Send) | 'background' (default)
//                                start one (job-runner.mjs startJob)
//   GET  /jobs[?conversationId=]   the caller's jobs, newest first
//   GET  /jobs/:id               one job
//   GET  /jobs/:id/events        Server-Sent Events: the log from after
//                                Last-Event-ID (or ?after=), then live; ends
//                                once the task has ended. Read with fetch, not
//                                EventSource, which cannot send Authorization.
//   POST /jobs/:id/steer         { content }  a message typed while it runs
//   POST /jobs/:id/answer        { chosen?, text? } | { dismissed: true } | { continue }
//   POST /jobs/:id/cancel
//
// An approval a task waits on is decided where every approval is: POST
// /approvals/:id (approval-routes.mjs). Its id is in the task's `waiting`.
// =============================================================================

import { sendJson, readJsonBody } from './http-json.mjs'
import * as store from '../job-store.mjs'
import { startJob, answerJob, steerJob, cancelJob, publicJob, registerClientTools, attachClient, clientResult } from '../job-runner.mjs'
import { memoryKey } from '../memory-storage.mjs'
import { logEvent } from '../logger.mjs'

const NOT_FOUND = { error: { message: 'Not found', type: 'not_found' } }
const bad = (message) => ({ error: { message, type: 'invalid_request_error' } })
const ONE = /^\/jobs\/([0-9a-f-]{36})$/
const SUB = /^\/jobs\/([0-9a-f-]{36})\/(events|steer|answer|cancel|client|client-result)$/

// THE OLD PATH (tasks plan Phase 0). These were /tasks until "task" became the
// work people give each other (/work-items). /tasks still reaches the same
// handler, for an Android build or a cached page that has not updated, and
// each use is logged (at most once a minute) so we know when it can go. It is
// never reused for anything else: an old client's job calls must not land on
// another API.
const LEGACY = /^\/tasks(?=\/|$)/
const LEGACY_LOG_MS = 60_000
let legacyLoggedAt = 0

/** The /jobs path for a /tasks one; any other path unchanged. */
export function jobPath(urlPath) {
  return LEGACY.test(urlPath) ? urlPath.replace(LEGACY, '/jobs') : urlPath
}
/** A comment line this often keeps a proxy from closing an idle stream. */
export const SSE_HEARTBEAT_MS = 25_000

export function isJobRoute(urlPath) {
  const p = jobPath(urlPath)
  return p === '/jobs' || ONE.test(p) || SUB.test(p)
}

function owned(id, account, storeAccountId) {
  const t = store.getJob(id)
  if (!t) return null
  if (t.accountKey !== memoryKey(account) || t.storeAccountId !== storeAccountId) return null
  return t
}

function sendResult(res, r, okStatus = 200, body = { ok: true }) {
  if (r.ok) sendJson(res, okStatus, { ...body, ...(r.as ? { as: r.as } : {}) })
  else sendJson(res, r.status, r.status === 404 ? NOT_FOUND : bad(r.error))
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} rawPath  /jobs/..., or the old /tasks/... (see jobPath)
 * @param {{ account: object | null, storeAccountId: string, surface?: string | null, timeZone?: string | null }} who
 *   storeAccountId: the conversations scope the gateway resolved (account id, or device id with auth off)
 * @returns {Promise<boolean>} false: not ours
 */
export async function handleJobRoute(req, res, rawPath, who) {
  const { account, storeAccountId } = who
  const urlPath = jobPath(rawPath)
  if (urlPath !== rawPath && Date.now() - legacyLoggedAt > LEGACY_LOG_MS) {
    legacyLoggedAt = Date.now()
    logEvent('task', 'legacy_route', { method: req.method, surface: who.surface ?? undefined })
  }
  try {
    if (urlPath === '/jobs') {
      if (req.method === 'GET') {
        const url = new URL(req.url, 'http://x')
        const conversationId = url.searchParams.get('conversationId')
        const mine = store.listJobs(memoryKey(account))
          .filter((t) => t.storeAccountId === storeAccountId && (!conversationId || t.conversationId === conversationId))
        sendJson(res, 200, { tasks: mine.map(publicJob) })
        return true
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        if (typeof body?.conversationId !== 'string' || !body.conversationId) { sendJson(res, 400, bad('conversationId is required')); return true }
        const r = startJob({
          account,
          surface: who.surface ?? null,
          storeAccountId,
          conversationId: body.conversationId,
          content: body.content,
          generation: body.generation,
          maxTurns: Number.isInteger(body.maxTurns) ? body.maxTurns : undefined,
          // Tools this client runs itself (master plan 7.1).
          clientTools: body.clientTools,
          // Nest tools the client switched off for this chat.
          toolLimits: body.toolLimits,
          // A plain Send ('chat') or a background task (the default).
          origin: body.origin,
          timeZone: who.timeZone ?? null,
        })
        if (!r.ok) { sendJson(res, r.status, r.status === 404 ? NOT_FOUND : bad(r.error)); return true }
        sendJson(res, 201, publicJob(r.task))
        return true
      }
      return false
    }

    const one = ONE.exec(urlPath)
    if (one) {
      if (req.method !== 'GET') return false
      const t = owned(one[1], account, storeAccountId)
      if (!t) { sendJson(res, 404, NOT_FOUND); return true }
      sendJson(res, 200, publicJob(t))
      return true
    }

    const sub = SUB.exec(urlPath)
    if (!sub) return false
    const [, id, action] = sub
    if (action === 'events' ? req.method !== 'GET' : req.method !== 'POST') return false
    const t = owned(id, account, storeAccountId)
    if (!t) { sendJson(res, 404, NOT_FOUND); return true }

    if (action === 'events') return streamEvents(req, res, t)
    if (action === 'cancel') { sendResult(res, cancelJob(id)); return true }
    const body = await readJsonBody(req)
    if (action === 'steer') { sendResult(res, steerJob(id, body?.content)); return true }
    if (action === 'answer') { sendResult(res, answerJob(id, body ?? {})); return true }
    if (action === 'client') { sendResult(res, registerClientTools(id, body?.tools)); return true }
    if (action === 'client-result') { sendResult(res, clientResult(id, body ?? {})); return true }
    return false
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: { message: err.message, type: 'internal_error' } })
    return true
  }
}

function lastSeen(req) {
  const header = req.headers['last-event-id']
  const fromHeader = typeof header === 'string' ? Number.parseInt(header, 10) : NaN
  if (Number.isFinite(fromHeader) && fromHeader >= 0) return fromHeader
  const after = Number.parseInt(new URL(req.url, 'http://x').searchParams.get('after') ?? '', 10)
  return Number.isFinite(after) && after >= 0 ? after : 0
}

function frame(e) {
  return `id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`
}

/** The log from after the client's last event, then live; closed once the task has ended. */
function streamEvents(req, res, task) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  })
  let sent = lastSeen(req)
  const write = (e) => {
    // A live event (tokens) has no seq and no id: line, so Last-Event-ID
    // still names the last stored event (master plan 7.1).
    if (e.live) {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`)
      return
    }
    if (e.seq <= sent || res.writableEnded) return
    sent = e.seq
    res.write(frame(e))
  }
  // Subscribe before replaying, so nothing appended in between is missed;
  // `sent` drops anything delivered twice.
  const buffered = []
  let replaying = true
  const off = store.subscribe(task.id, (e) => {
    // Tokens from before the replay finished are not worth holding: the
    // message they belong to arrives as a stored event.
    if (replaying) { if (!e.live) buffered.push(e); return }
    write(e)
    if (e.type === 'status' && store.TERMINAL_STATES.includes(e.status)) end()
  })
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': keep-alive\n\n') }, SSE_HEARTBEAT_MS)
  heartbeat.unref?.()
  function end() {
    clearInterval(heartbeat)
    off()
    if (!res.writableEnded) res.end()
  }
  // ?client=1: this stream is the run's executor for the client's tools
  // (master plan 7.1). While one is open, a call to a client tool is sent
  // here; when the last one closes, a waiting call is answered unavailable.
  const detach = new URL(req.url, 'http://x').searchParams.get('client') === '1'
    ? attachClient(task.id, (event) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify({ live: true, at: Date.now(), ...event })}\n\n`) })
    : () => {}
  req.on('close', () => { detach(); end() })

  for (const e of store.readEvents(task.id, sent)) write(e)
  replaying = false
  for (const e of buffered) write(e)
  const now = store.getJob(task.id)
  if (!now || store.TERMINAL_STATES.includes(now.status)) end()
  return true
}
