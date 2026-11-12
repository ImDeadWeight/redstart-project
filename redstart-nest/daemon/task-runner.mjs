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
import { readChatStream } from '../../shared/agent-core/chat-stream.mjs'
import { runToolCalls, wireSafeToolCalls, isAbortError } from '../../shared/agent-core/tool-calls.mjs'
import { createAgenticTimings, createTurnStats } from '../../shared/agent-core/timings.mjs'
import { formatMcpToolResult } from '../../shared/agent-core/tool-result.mjs'
import { currentBranch, branchToWire } from '../../shared/agent-core/stored-messages.mjs'
import {
  SUMMARY_MAX_TOKENS, compactionBudget, countsFromTotal, finishCompaction, messageText, planCompaction, summaryPrompt,
} from '../../shared/agent-core/compaction.mjs'
import { ASK_USER_TOOL } from '../../shared/agent-core/ask-user.mjs'
import { UPDATE_PLAN_TOOL } from '../../shared/agent-core/update-plan.mjs'
import * as store from './task-store.mjs'
import * as conversations from './conversations-storage.mjs'
import { accountForTask, surfacePermitted } from './auth.mjs'
import { memoryKey } from './memory-storage.mjs'
import { approvalRule, isApprovalEnforced } from './tools-definitions.mjs'
import { covers as grantCovers } from './approval-grants.mjs'
import * as ledger from './approval-ledger.mjs'
import { beginCompletion, completionsInFlight, getUpstreamPort } from './completion-activity.mjs'
import { logEvent } from './logger.mjs'

export const INTERRUPTED_BY_RESTART = 'Interrupted by a restart. Its effect is unknown: check before repeating it.'
/** chat-ui's DEFAULT parser patterns (the bench uses the same). */
export const FALLBACK_PARSER_PATTERNS = ['braces', 'xml', 'fn', 'json']
/** The host-resolved tools this host answers itself. */
export const TASK_HOST_TOOLS = [ASK_USER_TOOL, UPDATE_PLAN_TOOL]
const MODEL_POLL_MS = 2000
const BUSY_POLL_MS = 250
const MAX_CONTENT_CHARS = 100_000
const PREVIEW_CHARS = 400

/**
 * Sampling settings a client may hand a task (chat-ui's own, sent with the
 * request that starts it). Anything else in `generation` is dropped: a task
 * is not a way to set fields the gateway would refuse.
 */
export const GENERATION_KEYS = Object.freeze([
  'temperature', 'max_tokens', 'top_k', 'top_p', 'min_p', 'typ_p', 'xtc_probability', 'xtc_threshold',
  'dynatemp_range', 'dynatemp_exponent', 'repeat_last_n', 'repeat_penalty', 'presence_penalty',
  'frequency_penalty', 'dry_multiplier', 'dry_base', 'dry_allowed_length', 'dry_penalty_last_n', 'samplers',
])

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

/** One generation at a time across tasks. */
let modelChain = Promise.resolve()
function withModelTurn(fn) {
  const run = modelChain.then(fn, fn)
  modelChain = run.catch(() => undefined)
  return run
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve() }
    signal?.addEventListener('abort', done, { once: true })
  })
}

class TaskEnded extends Error {
  /** @param {'failed' | 'cancelled'} status */
  constructor(status, message) { super(message); this.status = status }
}

class ModelGone extends Error {}

/** A connection that never got a response, or one cut mid-stream: the model is not there (any more). */
function isModelGoneError(err) {
  if (err instanceof ModelGone) return true
  const text = `${err?.message ?? ''} ${err?.cause?.code ?? ''} ${err?.cause?.message ?? ''}`
  return /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|terminated|other side closed|UND_ERR/i.test(text)
}

function preview(text) {
  const s = typeof text === 'string' ? text : ''
  return s.length > PREVIEW_CHARS ? `${s.slice(0, PREVIEW_CHARS)}…` : s
}

/** chat-ui's parseToolArguments, message for message (as the bench). */
function parseArgs(text) {
  const trimmed = (text ?? '').trim()
  if (trimmed === '') return {}
  let parsed
  try {
    parsed = JSON.parse(trimmed)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Tool arguments must be an object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`)
    }
  } catch (err) {
    throw new Error(`Failed to parse tool arguments as JSON: ${err.message}`)
  }
  return parsed
}

/** MCP tools → the OpenAI tool list (as chat-ui and the bench send it). */
function toLlmTools(mcpTools) {
  return mcpTools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema ?? { type: 'object', properties: {}, required: [] } },
  }))
}

/** Loop messages → the wire (malformed earlier calls made safe, as chat-ui does). */
function toWire(messages) {
  return messages.map((m) => {
    const out = { role: m.role, content: m.content ?? '' }
    if (m.tool_calls) out.tool_calls = wireSafeToolCalls(m.tool_calls)
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id
    if (m.reasoning_content) out.reasoning_content = m.reasoning_content
    return out
  })
}

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
  launch(task.id)
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
 * Answer what the task is waiting on: a question ({ chosen?, text? } or
 * { dismissed: true }) or the continue prompt ({ continue: boolean }).
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
    } else {
      const chosen = Array.isArray(body?.chosen) ? body.chosen.filter((c) => typeof c === 'string').slice(0, 4) : undefined
      const text = typeof body?.text === 'string' ? body.text.slice(0, 4000) : undefined
      if (!chosen?.length && !text) return { ok: false, status: 400, error: 'Expected { chosen?: string[], text?: string } or { dismissed: true }' }
      l.answer({ ...(chosen?.length ? { chosen } : {}), ...(text ? { text } : {}) })
    }
  }
  store.appendEvent(id, { type: 'answered', kind: l.waitingKind })
  return { ok: true }
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

function launch(id, { recovered = false } = {}) {
  if (live.has(id)) return
  /** @type {Live} */
  const l = { controller: new AbortController(), steering: [], answer: null, waitingKind: null, heldApprovals: new Set(), done: Promise.resolve(), cancelledBy: null, suspended: false }
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
 * (the partial turn is already saved).
 */
async function runOnce(task, l, conv, generation, { resume }) {
  const signal = l.controller.signal
  const branch = currentBranch(conv)
  const wireOpts = { vision: generation.vision !== false, excludeReasoning: generation.excludeReasoning === true }
  const messages = branchToWire(branch, wireOpts)
  /** The id the next message hangs under. */
  let tip = branch.length ? branch[branch.length - 1].id : null
  if (!tip) throw new TaskEnded('failed', 'The conversation is empty.')

  // The loop's last word was an answer: the task had finished; only its
  // status was not written (a crash between the two).
  const last = branch[branch.length - 1]
  if (resume === 'restart' && last.role === 'assistant' && !last.toolCalls) return 'done'

  /** Per pass: who, which tools, set at the start of every turn. */
  const turnCtx = { account: null, toolNames: new Set(), mcpTools: [], model: null }
  /** call id → approval id the person granted for it */
  const approved = new Map()
  let planSteps = Array.isArray(conv.plan?.steps) ? conv.plan.steps : null
  /** The assistant message the current turn writes. */
  let current = { id: crypto.randomUUID(), parent: tip }
  const appended = new Set()

  const write = (message) => {
    const t = store.getTask(task.id)
    const m = conversations.appendMessage(t.storeAccountId, t.conversationId, message)
    if (!m) throw new TaskEnded('cancelled', 'The conversation was deleted.')
    tip = m.id
    store.appendEvent(task.id, { type: 'message', id: m.id, role: m.role })
    return m
  }

  /**
   * Before every turn: who, what config, which tools (D22). With
   * `needModel: false` (re-asking a restart's open calls), the account and
   * the tools only: a question or an approval needs no model.
   */
  async function refresh({ needModel = true } = {}) {
    const t = store.getTask(task.id)
    const who = accountForTask(t.accountId)
    if (!who.ok) throw new TaskEnded('failed', who.reason)
    if (who.account && t.surface && !surfacePermitted(who.account, t.surface)) {
      throw new TaskEnded('failed', 'This account may no longer connect from the app that started the task.')
    }
    turnCtx.account = who.account
    if (!needModel) {
      await loadTools(who.account)
      return null
    }
    // No model, or the gateway is down: wait for one.
    let config = await seams.effectiveConfigFor(who.account)
    let port = seams.upstreamPort()
    while (!config || !port) {
      if (signal.aborted) return null
      if (store.getTask(task.id).status !== 'waiting_model') store.updateTask(task.id, { status: 'waiting_model', waiting: { kind: 'model' } })
      await sleep(seams.modelPollMs, signal)
      config = await seams.effectiveConfigFor(who.account)
      port = seams.upstreamPort()
    }
    await loadTools(who.account)
    return { config, port }
  }

  async function loadTools(account) {
    const tools = await seams.toolCatalogFor(account, { hostTools: TASK_HOST_TOOLS })
    turnCtx.mcpTools = tools
    turnCtx.toolNames = new Set(tools.map((x) => x.name))
  }

  function setRunning() {
    const t = store.getTask(task.id)
    if (t.status !== 'running') store.updateTask(task.id, { status: 'running' })
  }

  /** Park until `l.answer` is called, or the task is cancelled (→ fallback). */
  function waitForAnswer(kind, waiting, fallback) {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve(fallback)
      const onAbort = () => { l.answer = null; resolve(fallback) }
      signal.addEventListener('abort', onAbort, { once: true })
      l.waitingKind = kind
      l.answer = (value) => {
        signal.removeEventListener('abort', onAbort)
        l.answer = null
        l.waitingKind = null
        setRunning()
        resolve(value)
      }
      store.updateTask(task.id, { status: 'waiting_user', waiting })
    })
  }

  /**
   * One request's messages, built as chat-ui builds them: the conversation's
   * current branch AS STORED, compacted (shared/agent-core/compaction.mjs,
   * D32), converted (stored-messages.mjs), then the loop's tail note when it
   * added one this turn. Every message the loop adds is also written by the
   * callbacks below, so storage holds the same history the loop does, with the
   * ids a stored summary is keyed to.
   */
  async function payloadFor(msgs, ready, t) {
    const tail = msgs.length > messages.length ? msgs[msgs.length - 1] : null
    const current = conversations.getConversation(t.storeAccountId, t.conversationId)
    if (!current) throw new TaskEnded('cancelled', 'The conversation was deleted.')
    const stored = currentBranch(current).filter((m) => m.type !== 'root')
    const compacted = await compact(stored, current, ready, t)
    const wire = branchToWire(compacted, wireOpts)
    return toWire(tail ? [...wire, tail] : wire)
  }

  /** chat-ui's maybeCompact, with the daemon's I/O. Never blocks a send. */
  async function compact(stored, current, ready, t) {
    if (generation.contextCompaction === false) return stored
    const budget = compactionBudget(ready.config?.ctxSize, generation.max_tokens)
    if (!budget) return stored
    try {
      const texts = stored.map((m) => messageText(m))
      const counts = countsFromTotal(texts, await seams.tokenize(ready.port, texts.join('\n')))
      const plan = planCompaction({ messages: stored, counts, usable: budget.usable, stored: current.contextSummary })
      if (plan.action === 'send') return plan.messages
      let summary = plan.existingSummary
      if (plan.toSummarize.length) {
        try {
          summary = await summarize(summaryPrompt(plan.existingSummary, plan.toSummarize), ready, t)
        } catch {
          summary = null
        }
      }
      const done = finishCompaction(plan, summary)
      if (done.contextSummary) {
        conversations.updateConversation(t.storeAccountId, t.conversationId, { contextSummary: done.contextSummary })
      }
      store.appendEvent(task.id, { type: 'compacted', folded: plan.pruned.length, summarized: !!done.contextSummary })
      return done.messages
    } catch {
      return stored
    }
  }

  /** The one non-streamed summarizer call, through the gateway's path like chat-ui's. */
  async function summarize(prompt, ready, t) {
    const { parsed } = await seams.prepareCompletion({
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      temperature: 0.2,
      max_tokens: SUMMARY_MAX_TOKENS,
      reasoning_format: 'auto',
      chat_template_kwargs: { enable_thinking: false },
    }, { account: turnCtx.account, surface: t.surface, effectiveConfig: ready.config, accountId: t.storeAccountId, timeZone: t.timeZone })
    const done = beginCompletion()
    try {
      const res = await seams.fetchCompletion(ready.port, parsed, signal)
      if (!res.ok) return null
      const data = await res.json()
      const text = data?.choices?.[0]?.message?.content
      return typeof text === 'string' && text.trim() ? text.trim() : null
    } finally {
      done()
    }
  }

  const ports = {
    model: {
      streamTurn: async ({ acc, messages: msgs, signal: sig }) => {
        const ready = await refresh()
        if (!ready) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
        await withModelTurn(async () => {
          // A chat waiting on its reply goes first (D29).
          while (seams.completionsInFlight() > 0 && !sig?.aborted) await sleep(seams.busyPollMs, sig)
          if (sig?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
          setRunning()
          const t = store.getTask(task.id)
          const body = {
            messages: await payloadFor(msgs, ready, t),
            stream: true,
            tools: turnCtx.mcpTools.length > 0 ? toLlmTools(turnCtx.mcpTools) : undefined,
            reasoning_format: 'auto',
            chat_template_kwargs: { enable_thinking: generation.enableThinking ?? conv.thinkingEnabled === true },
            ...Object.fromEntries(GENERATION_KEYS.filter((k) => generation[k] !== undefined).map((k) => [k, generation[k]])),
            ...(conv.promptMode ? { redstart_mode: conv.promptMode } : {}),
            ...(conv.projectId ? { redstart_project: conv.projectId } : {}),
          }
          const { parsed } = await seams.prepareCompletion(body, {
            account: turnCtx.account,
            surface: t.surface,
            effectiveConfig: ready.config,
            accountId: t.storeAccountId,
            timeZone: t.timeZone,
          })
          store.appendEvent(task.id, { type: 'turn' })
          const done = beginCompletion()
          try {
            let res
            try {
              res = await seams.fetchCompletion(ready.port, parsed, sig)
            } catch (err) {
              if (sig?.aborted) throw err
              throw new ModelGone(err?.message ?? 'The model could not be reached.')
            }
            const r = await readChatStream(res, acc, { signal: sig })
            turnCtx.model = r?.model ?? turnCtx.model
          } finally {
            done()
          }
        })
      },
    },
    tools: {
      execute: async (call) => {
        const name = call.function.name
        const args = parseArgs(call.function.arguments)
        store.updateTask(task.id, { inFlight: { callId: call.id, name } })
        store.appendEvent(task.id, { type: 'tool_call', callId: call.id, name })
        // inFlight stays set until the RESULT is stored (createToolResultMessage
        // clears it), not merely until the tool returns: a stop or crash in
        // between would otherwise leave a call with no result and no marker,
        // and the restart would run it a second time.
        const t = store.getTask(task.id)
        const result = await seams.callToolAs(turnCtx.account, name, args, { conversationId: t.conversationId, approvalId: approved.get(call.id) })
        const out = result === null || result === undefined
          ? { text: `Error: Unknown tool: ${name}`, isError: true }
          : { text: formatMcpToolResult(result), isError: !!result.isError }
        store.appendEvent(task.id, { type: 'tool_result', callId: call.id, name, isError: out.isError, preview: preview(out.text) })
        return out
      },
    },
    gate: {
      approve: async (call, sig) => {
        const name = call.function.name
        const rule = approvalRule(name)
        if (rule === 'none') return true
        // Not offered this turn (banned, withdrawn, made up): nothing to ask
        // about. callToolAs refuses it with the reason.
        if (!turnCtx.toolNames.has(name)) return true
        const t = store.getTask(task.id)
        if (rule === 'prompt' && grantCovers(t.accountKey, name)) return true
        let args
        try { args = parseArgs(call.function.arguments) } catch { return true } // execute reports the bad arguments
        const pending = ledger.requestApproval({ accountKey: t.accountKey, tool: name, args, holder: task.id })
        l.heldApprovals.add(pending.id)
        const decision = await new Promise((resolve) => {
          if (sig?.aborted) return resolve(null)
          const off = ledger.onDecided((approvalId, d) => {
            if (approvalId !== pending.id) return
            off(); sig?.removeEventListener('abort', onAbort)
            resolve(d)
          })
          const onAbort = () => { off(); resolve(null) }
          sig?.addEventListener('abort', onAbort, { once: true })
          store.updateTask(task.id, { status: 'waiting_approval', waiting: { kind: 'approval', callId: call.id, tool: name, rule, approval: pending } })
        })
        l.heldApprovals.delete(pending.id)
        if (decision === 'once' || decision === 'always') {
          approved.set(call.id, pending.id)
          // A tool Nest does not enforce never spends the approval: clear it.
          if (!isApprovalEnforced(name)) ledger.consume(pending.id, { accountKey: t.accountKey, tool: name, args })
          setRunning()
          return true
        }
        ledger.withdraw(pending.id)
        if (decision === 'deny') setRunning()
        return false
      },
    },
    ask: {
      user: async (request, _sig, call) => waitForAnswer('question', {
        kind: 'question', callId: call?.id, question: request.question, options: request.options, multiSelect: request.multiSelect,
      }, null),
    },
    plan: {
      get: () => planSteps,
      save: (steps) => {
        planSteps = steps
        const t = store.getTask(task.id)
        conversations.updateConversation(t.storeAccountId, t.conversationId, { plan: { steps, updatedAt: Date.now() } })
        store.appendEvent(task.id, { type: 'plan', steps })
      },
    },
    limit: {
      askContinue: async () => waitForAnswer('continue', { kind: 'continue', turns: task.limits.maxTurns }, false),
    },
    steering: { pending: () => l.steering.length > 0 },
    fallbackParser: () => ({ patterns: FALLBACK_PARSER_PATTERNS, availableTools: turnCtx.mcpTools.map((t) => ({ name: t.name })) }),
    log: (m) => logEvent('task', 'loop', { note: preview(m) }),
  }

  const callbacks = {
    onAssistantTurnComplete: async (content, reasoning, timings, toolCalls) => {
      // An aborted turn that produced nothing leaves no empty message behind.
      if (!content && !reasoning && !toolCalls && !appended.has(current.id)) return
      const fields = {
        content: content ?? '',
        reasoningContent: reasoning || undefined,
        toolCalls: toolCalls ? JSON.stringify(toolCalls) : '',
        timings,
        model: turnCtx.model ?? undefined,
      }
      if (appended.has(current.id)) {
        const t = store.getTask(task.id)
        conversations.patchMessage(t.storeAccountId, t.conversationId, current.id, fields)
        store.appendEvent(task.id, { type: 'message', id: current.id, role: 'assistant' })
        return
      }
      write({ id: current.id, parent: current.parent, type: 'text', role: 'assistant', timestamp: Date.now(), ...fields })
      appended.add(current.id)
    },
    createAssistantMessage: async () => {
      current = { id: crypto.randomUUID(), parent: tip }
    },
    createToolResultMessage: async (toolCallId, content) => {
      const m = write({ id: crypto.randomUUID(), parent: tip, type: 'text', role: 'tool', content, toolCallId, timestamp: Date.now(), toolCalls: '', model: null })
      if (store.getTask(task.id)?.inFlight?.callId === toolCallId) store.updateTask(task.id, { inFlight: null })
      return { id: m.id }
    },
  }

  // Resuming: calls the last assistant message asked for that have no
  // result yet. The one that was running when the daemon went down is closed
  // as interrupted; the rest run now, through the same ports, so an open
  // question or approval is put again.
  if (resume === 'restart' && last.role === 'assistant' && last.toolCalls) {
    let calls = []
    try { calls = JSON.parse(last.toolCalls) } catch { calls = [] }
    const answered = new Set(branch.filter((m) => m.role === 'tool').map((m) => m.toolCallId))
    const open = calls.filter((c) => c?.id && !answered.has(c.id))
    if (open.length > 0) {
      const t = store.getTask(task.id)
      const inFlightId = t.inFlight?.callId
      const toRun = []
      for (const c of open) {
        if (c.id === inFlightId) {
          await callbacks.createToolResultMessage(c.id, INTERRUPTED_BY_RESTART)
          messages.push({ role: 'tool', tool_call_id: c.id, content: INTERRUPTED_BY_RESTART })
        } else {
          toRun.push(c)
        }
      }
      store.updateTask(task.id, { inFlight: null })
      if (toRun.length > 0) {
        await refresh({ needModel: false })
        const outcome = await runToolCalls({
          calls: toRun, messages, agenticTimings: createAgenticTimings(), turnStats: createTurnStats(0), capturedTimings: undefined,
          ports, callbacks, signal,
        })
        if (outcome === 'stopped') return 'done'
      }
      current = { id: crypto.randomUUID(), parent: tip }
    }
  }

  try {
    await runAgentLoop({ messages, maxTurns: task.limits.maxTurns, ports, callbacks, signal })
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
    if (t.status === 'waiting_user' || t.status === 'waiting_approval') store.updateTask(t.id, { status: 'queued', waiting: null })
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
