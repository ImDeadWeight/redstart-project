'use strict'

// =============================================================================
// Redstart Nest — gateway routes for background tasks (agent-runtime plan
// Phase 3, D31)
// =============================================================================
// The account's own tasks. Every route acts on the caller's scope only: the
// task's owner (memoryKey) and its conversations scope must both be the
// caller's, or the answer is 404, so ids cannot be probed.
//
//   POST /tasks                  { conversationId, content, generation?, maxTurns? }
//                                start one (task-runner.mjs startTask)
//   GET  /tasks[?conversationId=]  the caller's tasks, newest first
//   GET  /tasks/:id              one task
//   GET  /tasks/:id/events       Server-Sent Events: the log from after
//                                Last-Event-ID (or ?after=), then live; ends
//                                once the task has ended. Read with fetch, not
//                                EventSource, which cannot send Authorization.
//   POST /tasks/:id/steer        { content }  a message typed while it runs
//   POST /tasks/:id/answer       { chosen?, text? } | { dismissed: true } | { continue }
//   POST /tasks/:id/cancel
//
// An approval a task waits on is decided where every approval is: POST
// /approvals/:id (approval-routes.mjs). Its id is in the task's `waiting`.
// =============================================================================

import { sendJson, readJsonBody } from './http-json.mjs'
import * as store from '../task-store.mjs'
import { startTask, answerTask, steerTask, cancelTask, publicTask } from '../task-runner.mjs'
import { memoryKey } from '../memory-storage.mjs'

const NOT_FOUND = { error: { message: 'Not found', type: 'not_found' } }
const bad = (message) => ({ error: { message, type: 'invalid_request_error' } })
const ONE = /^\/tasks\/([0-9a-f-]{36})$/
const SUB = /^\/tasks\/([0-9a-f-]{36})\/(events|steer|answer|cancel)$/
/** A comment line this often keeps a proxy from closing an idle stream. */
export const SSE_HEARTBEAT_MS = 25_000

export function isTaskRoute(urlPath) {
  return urlPath === '/tasks' || ONE.test(urlPath) || SUB.test(urlPath)
}

function owned(id, account, storeAccountId) {
  const t = store.getTask(id)
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
 * @param {string} urlPath
 * @param {{ account: object | null, storeAccountId: string, surface?: string | null, timeZone?: string | null }} who
 *   storeAccountId: the conversations scope the gateway resolved (account id, or device id with auth off)
 * @returns {Promise<boolean>} false: not ours
 */
export async function handleTaskRoute(req, res, urlPath, who) {
  const { account, storeAccountId } = who
  try {
    if (urlPath === '/tasks') {
      if (req.method === 'GET') {
        const url = new URL(req.url, 'http://x')
        const conversationId = url.searchParams.get('conversationId')
        const mine = store.listTasks(memoryKey(account))
          .filter((t) => t.storeAccountId === storeAccountId && (!conversationId || t.conversationId === conversationId))
        sendJson(res, 200, { tasks: mine.map(publicTask) })
        return true
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        if (typeof body?.conversationId !== 'string' || !body.conversationId) { sendJson(res, 400, bad('conversationId is required')); return true }
        const r = startTask({
          account,
          surface: who.surface ?? null,
          storeAccountId,
          conversationId: body.conversationId,
          content: body.content,
          generation: body.generation,
          maxTurns: Number.isInteger(body.maxTurns) ? body.maxTurns : undefined,
          timeZone: who.timeZone ?? null,
        })
        if (!r.ok) { sendJson(res, r.status, r.status === 404 ? NOT_FOUND : bad(r.error)); return true }
        sendJson(res, 201, publicTask(r.task))
        return true
      }
      return false
    }

    const one = ONE.exec(urlPath)
    if (one) {
      if (req.method !== 'GET') return false
      const t = owned(one[1], account, storeAccountId)
      if (!t) { sendJson(res, 404, NOT_FOUND); return true }
      sendJson(res, 200, publicTask(t))
      return true
    }

    const sub = SUB.exec(urlPath)
    if (!sub) return false
    const [, id, action] = sub
    if (action === 'events' ? req.method !== 'GET' : req.method !== 'POST') return false
    const t = owned(id, account, storeAccountId)
    if (!t) { sendJson(res, 404, NOT_FOUND); return true }

    if (action === 'events') return streamEvents(req, res, t)
    if (action === 'cancel') { sendResult(res, cancelTask(id)); return true }
    const body = await readJsonBody(req)
    if (action === 'steer') { sendResult(res, steerTask(id, body?.content)); return true }
    if (action === 'answer') { sendResult(res, answerTask(id, body ?? {})); return true }
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
    if (e.seq <= sent || res.writableEnded) return
    sent = e.seq
    res.write(frame(e))
  }
  // Subscribe before replaying, so nothing appended in between is missed;
  // `sent` drops anything delivered twice.
  const buffered = []
  let replaying = true
  const off = store.subscribe(task.id, (e) => {
    if (replaying) { buffered.push(e); return }
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
  req.on('close', end)

  for (const e of store.readEvents(task.id, sent)) write(e)
  replaying = false
  for (const e of buffered) write(e)
  const now = store.getTask(task.id)
  if (!now || store.TERMINAL_STATES.includes(now.status)) end()
  return true
}
