'use strict'

// =============================================================================
// Redstart Nest — the task runner (agent-runtime plan Phase 3, 3.5)
// =============================================================================
// Runs shared/agent-core's loop inside the daemon, against one of the
// account's conversations, with no client attached. The third host of the one
// loop (D1): chat-ui in the browser, the bench under Node, and this. Every
// port goes through the path a chat request takes, so a task can do nothing a
// chat could not:
//
//   model     prepareCompletion (bans, retrieval, prompt: the gateway's own
//             function), then llama-server, read with the core's stream
//             reader and counted as a completion. No model: waiting_model.
//   tools     toolCatalogFor + callToolAs (the MCP server's own functions):
//             Nest's tools only. Twig, the browser sandbox and MCP servers
//             the browser holds are not on the server (D28).
//   gate      rule 'none' runs; 'prompt' with a standing grant runs;
//             anything else parks in waiting_approval on a ledger approval
//             this task holds, until POST /approvals/:id decides it (U-a,
//             decided 2026-11-12: a write waits, like a delete).
//   ask       ask_user parks in waiting_user until POST /tasks/:id/answer.
//   plan      the conversation's `plan` field, as chat-ui keeps it.
//   limit     the turn limit parks in waiting_user with the continue
//             question (D30).
//   steering  POST /tasks/:id/steer: the loop ends its turn, the message is
//             added, the loop goes on.
//
// Writes: the conversation is the task's while it runs (activeTaskId, D25).
// Each message is appended once, complete, with appendMessage; the task's
// event log says which, so a client reloads.
//
// Who it runs as is looked up again before every turn (D22): a disabled
// account fails the task; a ban or a role change lands on the next turn.
//
// One task generates at a time, and a task waits while a chat's completion is
// in flight (D29): a person waiting on a reply goes first.
//
// Restart (3.7): resumeTasks() at daemon start re-enters every task that had
// not ended, from the conversation. A tool call that was running is closed
// with INTERRUPTED_BY_RESTART; calls not yet reached run normally, so an open
// question or approval is asked again, and the task stays waiting.
// =============================================================================

import * as crypto from 'node:crypto'
import { runAgentLoop } from '../../shared/agent-core/loop.mjs'
import { isAbortError } from '../../shared/agent-core/tool-calls.mjs'
import { currentBranch } from '../../shared/agent-core/stored-messages.mjs'
import * as store from './task-store.mjs'
import * as conversations from './conversations-storage.mjs'
import { accountForTask } from './auth.mjs'
import { memoryKey } from './memory-storage.mjs'
import * as ledger from './approval-ledger.mjs'
import { completionsInFlight, getUpstreamPort } from './completion-activity.mjs'
import { logEvent } from './logger.mjs'
import {
  GENERATION_KEYS, TaskEnded, isModelGoneError, sleep, preview, createPass, buildPorts, buildCallbacks,
} from './task-ports.mjs'
import { finishedBeforeRestart, resumeOpenCalls } from './task-resume.mjs'
import { cleanClientTools, MAX_CLIENT_RESULT_CHARS } from './client-tools.mjs'

// Where they lived before master plan Phase 4 split runOnce; importers keep
// reading them from here.
export { FALLBACK_PARSER_PATTERNS, TASK_HOST_TOOLS, GENERATION_KEYS } from './task-ports.mjs'
export { INTERRUPTED_BY_RESTART } from './task-resume.mjs'

const MODEL_POLL_MS = 2000
const BUSY_POLL_MS = 250
const MAX_CONTENT_CHARS = 100_000

// ---------------------------------------------------------------------------
// Seams. The defaults are the daemon's own functions, imported lazily so this
// module does not pull the gateway and the MCP server into everything that
// imports it. Tests replace them (_setTestSeams).
// ---------------------------------------------------------------------------

const defaults = {
  async prepareCompletion(parsed, facts) {
    const gw = await import('./tools-gateway.mjs')
    return gw.prepareCompletion(parsed, facts)
  },
  async effectiveConfigFor(account) {
    const gw = await import('./tools-gateway.mjs')
    return gw.effectiveConfigFor(account)
  },
  async toolCatalogFor(account, opts) {
    const mcp = await import('./mcp-server.mjs')
    return mcp.toolCatalogFor(account, opts)
  },
  async callToolAs(account, name, args, opts) {
    const mcp = await import('./mcp-server.mjs')
    return mcp.callToolAs(account, name, args, opts)
  },
  async reviewConversation(args) {
    const mr = await import('./memory-review.mjs')
    return mr.reviewConversation(args)
  },
  upstreamPort: () => getUpstreamPort(),
  completionsInFlight: () => completionsInFlight(),
  async fetchCompletion(port, body, signal) {
    return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  },
  /** Tokens in `content` by llama-server's own tokenizer, or undefined (the core then estimates). */
  async tokenize(port, content) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/tokenize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      if (!res.ok) return undefined
      const data = await res.json()
      return Array.isArray(data?.tokens) ? data.tokens.length : undefined
    } catch {
      return undefined
    }
  },
  modelPollMs: MODEL_POLL_MS,
  busyPollMs: BUSY_POLL_MS,
}
let seams = { ...defaults }

/** Tests only. */
export function _setTestSeams(overrides) {
  seams = overrides ? { ...defaults, ...overrides } : { ...defaults }
}

// ---------------------------------------------------------------------------
// Live state, per task, in this process
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   controller: AbortController,
 *   steering: string[],
 *   answer: ((value: any) => void) | null,
 *   waitingKind: string | null,
 *   heldApprovals: Set<string>,
 *   done: Promise<void>,
 * }} Live
 */
/** @type {Map<string, Live>} */
const live = new Map()

function pickGeneration(gen) {
  const out = {}
  if (!gen || typeof gen !== 'object') return out
  for (const k of GENERATION_KEYS) if (gen[k] !== undefined) out[k] = gen[k]
  if (typeof gen.enableThinking === 'boolean') out.enableThinking = gen.enableThinking
  if (typeof gen.vision === 'boolean') out.vision = gen.vision
  if (typeof gen.excludeReasoning === 'boolean') out.excludeReasoning = gen.excludeReasoning
  // chat-ui's "context compaction" setting (D32): off means the task never folds history.
  if (typeof gen.contextCompaction === 'boolean') out.contextCompaction = gen.contextCompaction
  return out
}

// ---------------------------------------------------------------------------
// Starting a task
// ---------------------------------------------------------------------------

/**
 * Start a task on one of the account's conversations: its message is added
 * (by the daemon, as the task's first write) and the loop starts. Resolves
 * once the task exists; the run goes on without the caller.
 *
 * @param {{ account: object | null, surface?: string | null, storeAccountId: string, conversationId: string,
 *   content: string, generation?: object, timeZone?: string | null, maxTurns?: number }} req
 * @returns {{ ok: true, task: object } | { ok: false, status: number, error: string }}
 */
export function startTask(req) {
  const content = typeof req.content === 'string' ? req.content.trim() : ''
  if (!content) return { ok: false, status: 400, error: 'content is required' }
  // Tools the client runs itself (master plan 7.1), held in memory for this
  // run only: a restart has no client, so they are not stored.
  const client = cleanClientTools(req.clientTools)
  if (!client.ok) return { ok: false, status: 400, error: client.error }
  if (content.length > MAX_CONTENT_CHARS) return { ok: false, status: 400, error: `content is over ${MAX_CONTENT_CHARS} characters` }
  const conv = conversations.getConversation(req.storeAccountId, req.conversationId)
  if (!conv) return { ok: false, status: 404, error: 'Not found' }
  if (conv.activeTaskId) {
    const holder = store.getTask(conv.activeTaskId)
    if (holder && !store.TERMINAL_STATES.includes(holder.status)) {
      return { ok: false, status: 409, error: 'A task is already running in this conversation.' }
    }
  }

  const task = store.createTask({
    accountKey: memoryKey(req.account ?? null),
    accountId: req.account?.id ?? null,
    storeAccountId: req.storeAccountId,
    conversationId: req.conversationId,
    surface: req.surface ?? null,
    limits: { maxTurns: req.maxTurns },
    timeZone: req.timeZone ?? null,
  })
  // The record carries the sampling settings for every later turn and for a
  // restart: the client that sent them may never be back.
  store.appendEvent(task.id, { type: 'generation', generation: pickGeneration(req.generation) })
  conversations.setActiveTask(req.storeAccountId, req.conversationId, task.id)

  const userMessage = appendUserMessage(task, content)
  if (!userMessage) {
    store.updateTask(task.id, { status: 'failed', error: 'The conversation could not be written.' })
    conversations.setActiveTask(req.storeAccountId, req.conversationId, null)
    return { ok: false, status: 500, error: 'The conversation could not be written.' }
  }
  logEvent('task', 'started', { account: req.account?.username ?? undefined })
  launch(task.id, { clientTools: client.tools })
  return { ok: true, task: store.getTask(task.id) }
}

/** The tip of the current branch, creating the root record a new chat lacks. */
function tipOf(task) {
  const conv = conversations.getConversation(task.storeAccountId, task.conversationId)
  if (!conv) return null
  const branch = currentBranch(conv)
  if (branch.length > 0) return branch[branch.length - 1].id
  const root = (conv.messages ?? []).find((m) => m.type === 'root' && m.parent === null)
  if (root) return root.id
  const made = conversations.appendMessage(task.storeAccountId, task.conversationId, {
    id: crypto.randomUUID(), type: 'root', role: 'system', content: '', parent: null, timestamp: Date.now(), toolCalls: '',
  })
  return made?.id ?? null
}

function appendUserMessage(task, content) {
  const parent = tipOf(task)
  if (!parent) return null
  const m = conversations.appendMessage(task.storeAccountId, task.conversationId, {
    id: crypto.randomUUID(), type: 'text', role: 'user', content, parent, timestamp: Date.now(), toolCalls: '', model: null,
  })
  if (m) store.appendEvent(task.id, { type: 'message', id: m.id, role: 'user' })
  return m
}

// ---------------------------------------------------------------------------
// Talking to a running task
// ---------------------------------------------------------------------------

/**
 * Answer what the task is waiting on: a question ({ chosen?, text? }, one
 * reply per question as { answers: [...] }, or { dismissed: true }) or the
 * continue prompt ({ continue: boolean }).
 *
 * @returns {{ ok: true } | { ok: false, status: number, error: string }}
 */
export function answerTask(id, body) {
  const l = live.get(id)
  const t = store.getTask(id)
  if (!t || !l) return { ok: false, status: t ? 409 : 404, error: t ? 'This task is not running.' : 'Not found' }
  if (t.status !== 'waiting_user' || !l.answer) return { ok: false, status: 409, error: 'This task is not waiting for an answer.' }
  if (l.waitingKind === 'continue') {
    if (typeof body?.continue !== 'boolean') return { ok: false, status: 400, error: 'Expected { continue: true | false }' }
    l.answer(body.continue)
  } else {
    if (body?.dismissed === true) {
      l.answer(null)
    } else if (Array.isArray(body?.answers)) {
      // One reply per question, in order (D43); null: that one not answered.
      const count = t.waiting?.questions?.length ?? 1
      const answers = Array.from({ length: count }, (_, i) => cleanReply(body.answers[i]))
      if (answers.every((a) => a === null)) return { ok: false, status: 400, error: 'Expected at least one answer in { answers: [...] }, or { dismissed: true }' }
      l.answer({ answers })
    } else {
      const reply = cleanReply(body)
      if (!reply) return { ok: false, status: 400, error: 'Expected { chosen?: string[], text?: string }, { answers: [...] } or { dismissed: true }' }
      l.answer(reply)
    }
  }
  store.appendEvent(id, { type: 'answered', kind: l.waitingKind })
  return { ok: true }
}

/** One question's reply from a request body, bounded, or null when it says nothing. */
function cleanReply(value) {
  if (typeof value !== 'object' || value === null) return null
  const chosen = Array.isArray(value.chosen) ? value.chosen.filter((c) => typeof c === 'string' && c.trim()).slice(0, 4) : []
  const text = typeof value.text === 'string' && value.text.trim() ? value.text.slice(0, 4000) : ''
  if (!chosen.length && !text) return null
  return { ...(chosen.length ? { chosen } : {}), ...(text ? { text } : {}) }
}

/**
 * A message typed while the task runs. While a question is open it is the
 * answer (the ask port's contract); otherwise the loop ends its turn and the
 * message is added before it goes on.
 */
export function steerTask(id, content) {
  const text = typeof content === 'string' ? content.trim() : ''
  if (!text) return { ok: false, status: 400, error: 'content is required' }
  const l = live.get(id)
  const t = store.getTask(id)
  if (!t || !l) return { ok: false, status: t ? 409 : 404, error: t ? 'This task is not running.' : 'Not found' }
  if (t.status === 'waiting_user' && l.waitingKind === 'question' && l.answer) {
    l.answer({ text: text.slice(0, 4000) })
    store.appendEvent(id, { type: 'answered', kind: 'question', via: 'steer' })
    return { ok: true, as: 'answer' }
  }
  l.steering.push(text.slice(0, MAX_CONTENT_CHARS))
  store.appendEvent(id, { type: 'steer_queued' })
  return { ok: true, as: 'steer' }
}

/** Stop a task. Its partial turn is kept; it ends as cancelled. */
export function cancelTask(id, by = 'user') {
  const t = store.getTask(id)
  if (!t) return { ok: false, status: 404, error: 'Not found' }
  if (store.TERMINAL_STATES.includes(t.status)) return { ok: true, already: true }
  const l = live.get(id)
  if (l) {
    l.cancelledBy = by
    l.controller.abort()
  } else {
    finish(t, 'cancelled', null)
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// The client-executor port (master plan 7.1)
// ---------------------------------------------------------------------------

/** Replace the tools a task's client runs (a reconnect, or a new client). */
export function registerClientTools(id, tools) {
  const l = live.get(id)
  if (!l) return { ok: false, status: store.getTask(id) ? 409 : 404, error: 'This task is not running.' }
  const clean = cleanClientTools(tools)
  if (!clean.ok) return { ok: false, status: 400, error: clean.error }
  l.clientTools = clean.tools
  return { ok: true }
}

/**
 * A client opened the task's event stream as its executor. Returns the
 * function to call when it closes; when the last one goes, every call
 * waiting on a client is answered as unavailable.
 */
export function attachClient(id) {
  const l = live.get(id)
  if (!l) return () => {}
  l.clientConnections++
  let closed = false
  return () => {
    if (closed) return
    closed = true
    l.clientConnections = Math.max(0, l.clientConnections - 1)
    if (l.clientConnections === 0) {
      for (const resolve of l.clientWaits.values()) resolve(null)
      l.clientWaits.clear()
    }
  }
}

/** A client's result for one of its calls: { callId, text, isError? }. */
export function clientResult(id, body) {
  const l = live.get(id)
  if (!l) return { ok: false, status: store.getTask(id) ? 409 : 404, error: 'This task is not running.' }
  const callId = typeof body?.callId === 'string' ? body.callId : ''
  const resolve = l.clientWaits.get(callId)
  if (!resolve) return { ok: false, status: 409, error: 'No call with that id is waiting for a result.' }
  l.clientWaits.delete(callId)
  const text = typeof body.text === 'string' ? body.text.slice(0, MAX_CLIENT_RESULT_CHARS) : ''
  resolve({ text, isError: body.isError === true })
  store.appendEvent(id, { type: 'client_result', callId, isError: body.isError === true })
  return { ok: true }
}

/** Every live task's run, for tests and for an orderly stop. */
export function _liveRuns() {
  return [...live.values()].map((l) => l.done)
}

/**
 * The daemon is stopping (stopDaemon): stop every run where it is WITHOUT
 * ending it. Records keep their state and the conversation stays claimed, so
 * the next start resumes each one (resumeTasks), as after a crash. A call
 * that was running when this landed has no stored result, and is closed as
 * interrupted at resume.
 *
 * @returns {Promise<void>} once every run has stopped
 */
export function suspendAllTasks() {
  const runs = []
  for (const l of live.values()) {
    l.suspended = true
    l.controller.abort()
    runs.push(l.done)
  }
  return Promise.allSettled(runs).then(() => undefined)
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function launch(id, { recovered = false, clientTools = [] } = {}) {
  if (live.has(id)) return
  /** @type {Live} */
  const l = {
    controller: new AbortController(), steering: [], answer: null, waitingKind: null, heldApprovals: new Set(),
    done: Promise.resolve(), cancelledBy: null, suspended: false,
    // The client-executor port (master plan 7.1): what the client runs, how
    // many of its streams are open, and the calls waiting on it.
    clientTools, clientConnections: 0, clientWaits: new Map(),
  }
  live.set(id, l)
  l.done = run(id, l, { recovered }).catch((err) => {
    // run() handles its own failures; this is a bug in it, and the task must still end.
    console.error('Task runner:', err)
    const t = store.getTask(id)
    if (t) finish(t, 'failed', `Internal error: ${err?.message ?? err}`)
  }).finally(() => live.delete(id))
}

function finish(task, status, error) {
  // Suspended by an orderly daemon stop: leave the record as it is, so the
  // next start resumes it (resumeTasks).
  if (live.get(task.id)?.suspended) return
  store.updateTask(task.id, { status, error, inFlight: null })
  conversations.setActiveTask(task.storeAccountId, task.conversationId, null)
  const l = live.get(task.id)
  if (l) for (const approvalId of l.heldApprovals) ledger.withdraw(approvalId)
  logEvent('task', status, error ? { reason: preview(error) } : {})
  // D41: the daemon reviews what the daemon ran. Not awaited: the task has
  // ended whatever the review does. Kept so tests (and a stop) can wait on it.
  const p = reviewEndedTask(task).catch((err) => logEvent('memory', 'review_failed', { reason: preview(err?.message ?? String(err)), task: true }))
  reviewRuns.add(p)
  p.finally(() => reviewRuns.delete(p))
}

// ---------------------------------------------------------------------------
// The memory review of an ended task (agent-runtime 8.5, D41)
// ---------------------------------------------------------------------------
// A browser chat is reviewed by the client once it goes quiet; a background
// task has no client watching it, so nothing reviewed it and an hour of the
// user steering a task taught the memory nothing. On done, failed or
// cancelled, the runner asks for the same review a client would, as the
// task's account (re-resolved, as every turn is) with its narrowed config, so
// memory off, a role without memory, or the account's mode "off" all mean no
// review (reviewConversation's own checks). "busy" (a reply being generated,
// or this account already in a review) is retried once, when no completion is
// in flight; a second busy is left to the next trigger, as a client's is.

const reviewRuns = new Set()
const REVIEW_BUSY_WAIT_MS = 10 * 60 * 1000

async function reviewEndedTask(task) {
  const who = accountForTask(task.accountId)
  if (!who.ok) return
  const config = await seams.effectiveConfigFor(who.account)
  if (!config) return // no model: the next trigger (or the client) reviews it
  const args = { account: who.account, conversationId: task.conversationId, config }
  let r = await seams.reviewConversation(args)
  if (r?.status === 'busy') {
    const until = Date.now() + REVIEW_BUSY_WAIT_MS
    // At least one pause: "busy" can be this account's own review running,
    // which no completion count shows.
    do await sleep(seams.busyPollMs)
    while (seams.completionsInFlight() > 0 && Date.now() < until)
    r = await seams.reviewConversation(args)
  }
  logEvent('memory', 'task_reviewed', { status: r?.status ?? 'none' })
}

/** Tests: wait until every review an ended task queued has finished. */
export async function _settleReviews() {
  while (reviewRuns.size > 0) await Promise.allSettled([...reviewRuns])
}

function generationOf(taskId) {
  const ev = store.readEvents(taskId, 0).find((e) => e.type === 'generation')
  return ev?.generation ?? {}
}

async function run(id, l, { recovered }) {
  let task = store.getTask(id)
  if (!task || store.TERMINAL_STATES.includes(task.status)) return
  const signal = l.controller.signal
  const generation = generationOf(id)
  /**
   * 'restart': the daemon went down mid-task; a turn is saved only once it
   * is complete, so a trailing answer means the task had finished, and a
   * call with no result was running or not yet reached.
   * 'model': the model went away mid-turn; the partial turn was saved, and
   * the task goes on from it with a fresh turn.
   * @type {'restart' | 'model' | null}
   */
  let resume = recovered ? 'restart' : null

  try {
    while (true) {
      if (signal.aborted) throw new TaskEnded('cancelled', null)
      task = store.getTask(id)
      const conv = conversations.getConversation(task.storeAccountId, task.conversationId)
      if (!conv) throw new TaskEnded('cancelled', 'The conversation was deleted.')

      const outcome = await runOnce(task, l, conv, generation, { resume })
      resume = outcome === 'again' ? 'model' : null
      if (outcome === 'again') continue
      if (signal.aborted) throw new TaskEnded('cancelled', null)

      // Messages typed while it ran: add them and go on, as chat-ui sends a
      // steering message once the flow has stopped.
      if (l.steering.length > 0) {
        const queued = l.steering.splice(0)
        for (const text of queued) {
          if (!appendUserMessage(store.getTask(id), text)) throw new TaskEnded('cancelled', 'The conversation was deleted.')
        }
        continue
      }
      finish(store.getTask(id), 'done', null)
      return
    }
  } catch (err) {
    const t = store.getTask(id)
    if (!t || store.TERMINAL_STATES.includes(t.status)) return
    if (err instanceof TaskEnded) return finish(t, err.status, err.message)
    if (signal.aborted) return finish(t, 'cancelled', null)
    return finish(t, 'failed', err?.message ?? String(err))
  }
}

/**
 * One pass of the loop over the conversation as stored. Returns 'again' when
 * the model went away mid-turn and the pass must be re-entered once it is back
 * (the partial turn is already saved). The pass's state, ports and callbacks
 * are task-ports.mjs's; a restart's open calls, task-resume.mjs's.
 */
async function runOnce(task, l, conv, generation, { resume }) {
  const pass = createPass({ task, l, conv, generation, seams })
  if (resume === 'restart' && finishedBeforeRestart(pass)) return 'done'
  const ports = buildPorts(pass)
  const callbacks = buildCallbacks(pass)

  if (resume === 'restart' && await resumeOpenCalls(pass, { ports, callbacks }) === 'stopped') return 'done'

  const signal = pass.signal
  try {
    await runAgentLoop({ messages: pass.messages, maxTurns: task.limits.maxTurns, ports, callbacks, signal })
  } catch (err) {
    if (err instanceof TaskEnded) throw err
    if (signal.aborted || isAbortError(err)) return 'done'
    if (isModelGoneError(err) || !seams.upstreamPort()) {
      store.updateTask(store.getTask(task.id).id, { status: 'waiting_model', waiting: { kind: 'model' } })
      await sleep(seams.modelPollMs, signal)
      return 'again'
    }
    throw err
  }
  return 'done'
}

// ---------------------------------------------------------------------------
// Daemon start (3.7)
// ---------------------------------------------------------------------------

/**
 * Re-enter every task that had not ended when the daemon last stopped.
 * Called once at start. A task whose conversation is gone is cancelled.
 *
 * @returns {number} how many were resumed
 */
export function resumeTasks() {
  let n = 0
  for (const t of store.listTasks()) {
    if (store.TERMINAL_STATES.includes(t.status)) continue
    const conv = conversations.getConversation(t.storeAccountId, t.conversationId)
    if (!conv) {
      store.updateTask(t.id, { status: 'cancelled', error: 'The conversation was deleted.' })
      continue
    }
    if (conv.activeTaskId !== t.id) conversations.setActiveTask(t.storeAccountId, t.conversationId, t.id)
    // What a waiting task waited on died with the process: an approval id the
    // fresh ledger has never heard of, a question no run is holding. Cleared,
    // so no client acts on it; the resumed run asks again within moments.
    if (t.status === 'waiting_user' || t.status === 'waiting_approval' || t.status === 'waiting_client') store.updateTask(t.id, { status: 'queued', waiting: null })
    store.appendEvent(t.id, { type: 'resumed' })
    launch(t.id, { recovered: true })
    n++
  }
  if (n > 0) logEvent('task', 'resumed', { count: n })
  return n
}

/** A task as a client may see it: the record without its storage scope. */
export function publicTask(t) {
  if (!t) return null
  const { storeAccountId: _s, accountKey: _k, ...rest } = t
  return rest
}
