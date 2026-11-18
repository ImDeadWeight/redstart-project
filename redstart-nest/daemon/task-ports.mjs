'use strict'

// =============================================================================
// Redstart Nest — a task pass's state, ports and callbacks (task-runner.mjs)
// =============================================================================
// One pass of shared/agent-core's loop over a stored conversation needs a
// handful of things to talk through: the ports (model, tools, gate, ask,
// plan, limit, steering) and the callbacks that write each message the loop
// adds. They used to be one ~380-line runOnce; master plan Phase 4 split them
// out, one builder per port, so each can be read and tested alone. The run
// itself (the outer loop, finishing, resuming) stays in task-runner.mjs.
//
// Every builder takes the pass (createPass) and nothing else. The pass holds
// the per-pass state the ports share: who and which tools this turn
// (`turnCtx`), the approvals granted for calls, the plan, the message the
// current turn writes, and the tip new messages hang under. `seams` is the
// runner's, read when the pass is made, so a test's overrides apply.
// =============================================================================

import * as crypto from 'node:crypto'
import { readChatStream } from '../../shared/agent-core/chat-stream.mjs'
import { wireSafeToolCalls } from '../../shared/agent-core/tool-calls.mjs'
import { formatMcpToolResult } from '../../shared/agent-core/tool-result.mjs'
import { currentBranch, branchToWire } from '../../shared/agent-core/stored-messages.mjs'
import {
  PER_MESSAGE_OVERHEAD_TOKENS, SUMMARY_MAX_TOKENS, compactionBudget, countsFromTotal, finishCompaction, messageText,
  planCompaction, summaryPrompt,
} from '../../shared/agent-core/compaction.mjs'
import { ASK_USER_TOOL } from '../../shared/agent-core/ask-user.mjs'
import { callToolTarget } from '../../shared/agent-core/approval.mjs'
import { UPDATE_PLAN_TOOL, NUDGE_PREFIX } from '../../shared/agent-core/update-plan.mjs'
import * as store from './task-store.mjs'
import * as conversations from './conversations-storage.mjs'
import { accountForTask, surfacePermitted } from './auth.mjs'
import { approvalRule, isApprovalEnforced } from './tools-definitions.mjs'
import { covers as grantCovers } from './approval-grants.mjs'
import * as ledger from './approval-ledger.mjs'
import { beginCompletion } from './completion-activity.mjs'
import { logEvent } from './logger.mjs'
import { CLIENT_CALL_TIMEOUT_MS, clientUnavailable } from './client-tools.mjs'

/** chat-ui's DEFAULT parser patterns (the bench uses the same). */
export const FALLBACK_PARSER_PATTERNS = ['braces', 'xml', 'fn', 'json']
/** The host-resolved tools this host answers itself. */
export const TASK_HOST_TOOLS = [ASK_USER_TOOL, UPDATE_PLAN_TOOL]
const HOST_TOOL_NAMES = new Set(TASK_HOST_TOOLS)
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
// What the ports and the run both use
// ---------------------------------------------------------------------------

export class TaskEnded extends Error {
  /** @param {'failed' | 'cancelled'} status */
  constructor(status, message) { super(message); this.status = status }
}

export class ModelGone extends Error {}

/** A connection that never got a response, or one cut mid-stream: the model is not there (any more). */
export function isModelGoneError(err) {
  if (err instanceof ModelGone) return true
  const text = `${err?.message ?? ''} ${err?.cause?.code ?? ''} ${err?.cause?.message ?? ''}`
  return /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|terminated|other side closed|UND_ERR/i.test(text)
}

export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve() }
    signal?.addEventListener('abort', done, { once: true })
  })
}

export function preview(text) {
  const s = typeof text === 'string' ? text : ''
  return s.length > PREVIEW_CHARS ? `${s.slice(0, PREVIEW_CHARS)}…` : s
}

/** chat-ui's parseToolArguments, message for message (as the bench). */
export function parseArgs(text) {
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

/** One generation at a time across tasks. */
let modelChain = Promise.resolve()
function withModelTurn(fn) {
  const run = modelChain.then(fn, fn)
  modelChain = run.catch(() => undefined)
  return run
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

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' })

/** How long tokens gather before they go out as one live event. */
export const DELTA_BATCH_MS = 50

/**
 * The tokens of the reply being written, as live events (master plan 7.1):
 * `{ type: 'delta', messageId, content?, reasoning? }`, batched so a fast
 * model is tens of events a second, not hundreds. Nothing is stored: the
 * message itself is, once the turn is complete. `flush` sends what is left.
 */
function liveDeltas(taskId, messageId) {
  let content = ''
  let reasoning = ''
  let timer = null
  const send = () => {
    timer = null
    if (!content && !reasoning) return
    store.emitLive(taskId, { type: 'delta', messageId, ...(content ? { content } : {}), ...(reasoning ? { reasoning } : {}) })
    content = ''
    reasoning = ''
  }
  const schedule = () => { if (!timer) timer = setTimeout(send, DELTA_BATCH_MS) }
  return {
    onContent: (t) => { content += t; schedule() },
    onReasoning: (t) => { reasoning += t; schedule() },
    flush: () => { if (timer) clearTimeout(timer); send() },
  }
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/**
 * The state one pass shares across its ports and callbacks, and the small
 * operations on it every port needs (write a message, look up who and which
 * tools, park for an answer).
 *
 * @param {{ task: any, l: any, conv: any, generation: any, seams: any }} args
 */
export function createPass({ task, l, conv, generation, seams }) {
  const branch = currentBranch(conv)
  const wireOpts = { vision: generation.vision !== false, excludeReasoning: generation.excludeReasoning === true }
  const tipId = branch.length ? branch[branch.length - 1].id : null
  if (!tipId) throw new TaskEnded('failed', 'The conversation is empty.')

  const pass = {
    task, l, conv, generation, seams, branch, wireOpts,
    signal: l.controller.signal,
    /** The loop's messages, from the branch as stored. */
    messages: branchToWire(branch, wireOpts),
    /** The id the next message hangs under. */
    tip: tipId,
    /** Per pass: who, which tools, set at the start of every turn. */
    turnCtx: { account: null, toolNames: new Set(), mcpTools: [], model: null, clientToolNames: new Set(), config: null, switchedOff: () => false },
    /** call id → approval id the person granted for it */
    approved: new Map(),
    planSteps: Array.isArray(conv.plan?.steps) ? conv.plan.steps : null,
    /** The assistant message the current turn writes. */
    current: { id: crypto.randomUUID(), parent: tipId },
    /** Assistant messages already stored this pass (patched, not re-added). */
    appended: new Set(),

    write(message) {
      const t = store.getTask(task.id)
      const m = conversations.appendMessage(t.storeAccountId, t.conversationId, message)
      if (!m) throw new TaskEnded('cancelled', 'The conversation was deleted.')
      pass.tip = m.id
      store.appendEvent(task.id, { type: 'message', id: m.id, role: m.role })
      return m
    },

    /** A new assistant message, under the tip. */
    newTurn() {
      pass.current = { id: crypto.randomUUID(), parent: pass.tip }
    },

    /**
     * Before every turn: who, what config, which tools (D22). With
     * `needModel: false` (re-asking a restart's open calls), the account and
     * the tools only: a question or an approval needs no model.
     */
    async refresh({ needModel = true } = {}) {
      const t = store.getTask(task.id)
      const who = accountForTask(t.accountId)
      if (!who.ok) throw new TaskEnded('failed', who.reason)
      if (who.account && t.surface && !surfacePermitted(who.account, t.surface)) {
        throw new TaskEnded('failed', 'This account may no longer connect from the app that started the task.')
      }
      pass.turnCtx.account = who.account
      if (!needModel) {
        await loadTools(who.account)
        return null
      }
      // No model, or the gateway is down: wait for one.
      let config = await seams.effectiveConfigFor(who.account)
      let port = seams.upstreamPort()
      while (!config || !port) {
        if (pass.signal.aborted) return null
        if (store.getTask(task.id).status !== 'waiting_model') store.updateTask(task.id, { status: 'waiting_model', waiting: { kind: 'model' } })
        await sleep(seams.modelPollMs, pass.signal)
        config = await seams.effectiveConfigFor(who.account)
        port = seams.upstreamPort()
      }
      pass.turnCtx.config = config
      await loadTools(who.account)
      return { config, port }
    },

    setRunning() {
      const t = store.getTask(task.id)
      if (t.status !== 'running') store.updateTask(task.id, { status: 'running' })
    },

    /** Park until `l.answer` is called, or the task is cancelled (→ fallback). */
    waitForAnswer(kind, waiting, fallback) {
      return new Promise((resolve) => {
        if (pass.signal.aborted) return resolve(fallback)
        const onAbort = () => { l.answer = null; resolve(fallback) }
        pass.signal.addEventListener('abort', onAbort, { once: true })
        l.waitingKind = kind
        l.answer = (value) => {
          pass.signal.removeEventListener('abort', onAbort)
          l.answer = null
          l.waitingKind = null
          pass.setRunning()
          resolve(value)
        }
        store.updateTask(task.id, { status: 'waiting_user', waiting })
      })
    },
  }

  async function loadTools(account) {
    const catalog = await seams.toolCatalogFor(account, { hostTools: TASK_HOST_TOOLS })
    const nest = new Set(catalog.map((x) => x.name))
    // Nest tools the client switched off for this chat, as its own loop
    // would leave them out (cleanToolLimits). The task's own two stay.
    const limits = store.getTask(task.id)?.toolLimits
    const excluded = new Set(limits?.exclude ?? [])
    const switchedOff = (name) => nest.has(name) && !HOST_TOOL_NAMES.has(name) && (limits?.nest === false || excluded.has(name))
    const tools = catalog.filter((x) => !switchedOff(x.name))
    // The client's own tools (master plan 7.1), after Nest's: a name that is
    // one of Nest's is dropped, never a replacement for it.
    const client = (l.clientTools ?? []).filter((t) => !nest.has(t.name))
    pass.turnCtx.switchedOff = switchedOff
    pass.turnCtx.mcpTools = [...tools, ...client]
    pass.turnCtx.clientToolNames = new Set(client.map((t) => t.name))
    pass.turnCtx.toolNames = new Set([...tools.map((x) => x.name), ...pass.turnCtx.clientToolNames])
  }

  return pass
}

// ---------------------------------------------------------------------------
// model
// ---------------------------------------------------------------------------

/**
 * One request's messages, built as chat-ui builds them: the conversation's
 * current branch AS STORED, compacted (shared/agent-core/compaction.mjs,
 * D32), converted (stored-messages.mjs), then the loop's tail note when it
 * added one this turn. Every message the loop adds is also written by the
 * callbacks, so storage holds the same history the loop does, with the ids a
 * stored summary is keyed to.
 */
async function payloadFor(pass, msgs, ready, t, overheadTokens) {
  const tail = msgs.length > pass.messages.length ? msgs[msgs.length - 1] : null
  const current = conversations.getConversation(t.storeAccountId, t.conversationId)
  if (!current) throw new TaskEnded('cancelled', 'The conversation was deleted.')
  const stored = currentBranch(current).filter((m) => m.type !== 'root')
  const compacted = await compact(pass, stored, current, ready, t, overheadTokens)
  const wire = branchToWire(compacted, pass.wireOpts)
  return toWire(tail ? [...wire, tail] : wire)
}

/**
 * Tokens the request carries besides the conversation: the system prompt the
 * gateway composes and the tool list after bans and the catalog (2026-11-18).
 * compact() counts the stored messages only, so without this the trigger
 * ignored ~5,150 tokens on Ornith and a request overflowed long before it
 * compacted (agent-runtime-implementation, Phase 3 gaps).
 *
 * Measured by running the turn's own request, with no messages, through
 * prepareCompletion (bans, catalog, prompt; it touches no model and its one
 * side effect, the last-wire-cost record, is overwritten by the real call
 * straight after), then /tokenize. Cached for the pass while the context
 * size and the tool names stay the same: the catalog keeps the list fixed
 * for a conversation. The memory block can change by a few tokens within a
 * pass; that is inside the trigger's margin. A failure measures 0, which is
 * the behaviour before the fix, never a refusal to send.
 */
async function overheadFor(pass, head, facts, ready) {
  const names = (head.tools ?? []).map((tool) => tool?.function?.name ?? '').join(',')
  const key = `${ready.config?.ctxSize ?? ''}|${names}`
  if (pass.overhead?.key === key) return pass.overhead.tokens
  let tokens = 0
  try {
    const { parsed } = await pass.seams.prepareCompletion(structuredClone({ ...head, messages: [] }), facts)
    const sent = parsed.messages ?? []
    const text = [...sent.map((m) => messageText(m)), JSON.stringify(parsed.tools ?? [])].join('\n')
    const n = await pass.seams.tokenize(ready.port, text)
    tokens = (n ?? Math.ceil(text.length / 3)) + PER_MESSAGE_OVERHEAD_TOKENS * sent.length
  } catch {
    tokens = 0
  }
  pass.overhead = { key, tokens }
  return tokens
}

/** chat-ui's maybeCompact, with the daemon's I/O. Never blocks a send. */
async function compact(pass, stored, current, ready, t, overheadTokens = 0) {
  if (pass.generation.contextCompaction === false) return stored
  const budget = compactionBudget(ready.config?.ctxSize, pass.generation.max_tokens, overheadTokens)
  if (!budget) return stored
  try {
    const texts = stored.map((m) => messageText(m))
    const counts = countsFromTotal(texts, await pass.seams.tokenize(ready.port, texts.join('\n')))
    const plan = planCompaction({ messages: stored, counts, usable: budget.usable, stored: current.contextSummary })
    if (plan.action === 'send') return plan.messages
    let summary = plan.existingSummary
    if (plan.toSummarize.length) {
      try {
        summary = await summarize(pass, summaryPrompt(plan.existingSummary, plan.toSummarize), ready, t)
      } catch {
        summary = null
      }
    }
    const done = finishCompaction(plan, summary)
    if (done.contextSummary) {
      conversations.updateConversation(t.storeAccountId, t.conversationId, { contextSummary: done.contextSummary })
    }
    store.appendEvent(pass.task.id, { type: 'compacted', folded: plan.pruned.length, summarized: !!done.contextSummary })
    return done.messages
  } catch {
    return stored
  }
}

/** The one non-streamed summarizer call, through the gateway's path like chat-ui's. */
async function summarize(pass, prompt, ready, t) {
  const { parsed } = await pass.seams.prepareCompletion({
    messages: [{ role: 'user', content: prompt }],
    stream: false,
    temperature: 0.2,
    max_tokens: SUMMARY_MAX_TOKENS,
    reasoning_format: 'auto',
    chat_template_kwargs: { enable_thinking: false },
  }, { account: pass.turnCtx.account, surface: t.surface, effectiveConfig: ready.config, accountId: t.storeAccountId, timeZone: t.timeZone })
  const done = beginCompletion()
  try {
    const res = await pass.seams.fetchCompletion(ready.port, parsed, pass.signal)
    if (!res.ok) return null
    const data = await res.json()
    const text = data?.choices?.[0]?.message?.content
    return typeof text === 'string' && text.trim() ? text.trim() : null
  } finally {
    done()
  }
}

/** The model port: prepareCompletion, then llama-server, one task at a time and after any chat. */
export function modelPort(pass) {
  const { task, seams, generation, conv, turnCtx } = pass
  return {
    streamTurn: async ({ acc, messages: msgs, signal: sig }) => {
      const ready = await pass.refresh()
      if (!ready) throw abortError()
      await withModelTurn(async () => {
        // A chat waiting on its reply goes first (D29).
        while (seams.completionsInFlight() > 0 && !sig?.aborted) await sleep(seams.busyPollMs, sig)
        if (sig?.aborted) throw abortError()
        pass.setRunning()
        const t = store.getTask(task.id)
        const head = {
          stream: true,
          tools: turnCtx.mcpTools.length > 0 ? toLlmTools(turnCtx.mcpTools) : undefined,
          reasoning_format: 'auto',
          chat_template_kwargs: { enable_thinking: generation.enableThinking ?? conv.thinkingEnabled === true },
          ...Object.fromEntries(GENERATION_KEYS.filter((k) => generation[k] !== undefined).map((k) => [k, generation[k]])),
          ...(conv.promptMode ? { redstart_mode: conv.promptMode } : {}),
          ...(conv.projectId ? { redstart_project: conv.projectId } : {}),
          // As chat-ui sends it. The gateway ignores it since master plan
          // 3.3 (it keyed per-turn selection), and consumes it.
          ...(t.conversationId ? { redstart_conversation_id: t.conversationId } : {}),
          // A task's tools are Nest's own list whoever started it, so
          // retrieval applies as on chat-ui, with or without a surface
          // (master plan Phase 1).
          redstart_retrieval: true,
        }
        const facts = {
          account: turnCtx.account,
          surface: t.surface,
          effectiveConfig: ready.config,
          accountId: t.storeAccountId,
          timeZone: t.timeZone,
        }
        // The overhead first: compaction's budget is what is left of the
        // context once the prompt and the tools are in (overheadFor).
        const overhead = pass.generation.contextCompaction === false ? 0 : await overheadFor(pass, head, facts, ready)
        const body = { messages: await payloadFor(pass, msgs, ready, t, overhead), ...head }
        const { parsed } = await seams.prepareCompletion(body, facts)
        store.appendEvent(task.id, { type: 'turn' })
        // This turn exists because the model answered with plan steps still
        // open (the core's completion check): the bench's --runtime counts it.
        const tail = msgs.at(-1)
        if (typeof tail?.content === 'string' && tail.content.startsWith(NUDGE_PREFIX)) store.appendEvent(task.id, { type: 'plan_nudge' })
        const done = beginCompletion()
        const live = liveDeltas(task.id, pass.current.id)
        try {
          let res
          try {
            res = await seams.fetchCompletion(ready.port, parsed, sig)
          } catch (err) {
            if (sig?.aborted) throw err
            throw new ModelGone(err?.message ?? 'The model could not be reached.')
          }
          const r = await readChatStream(res, acc, { signal: sig, onContent: live.onContent, onReasoning: live.onReasoning })
          turnCtx.model = r?.model ?? turnCtx.model
        } finally {
          live.flush()
          done()
        }
      })
    },
  }
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

/** The tools port: callToolAs, as the account, with the approval granted for the call. */
export function toolsPort(pass) {
  const { task, seams, turnCtx, approved } = pass
  return {
    execute: async (call) => {
      const name = call.function.name
      if (turnCtx.clientToolNames.has(name)) return runOnClient(pass, call)
      // Switched off in this chat, by name or through call_tool: not offered,
      // so not run either.
      const target = name === 'call_tool' ? callToolTargetOf(call) : null
      const off = turnCtx.switchedOff(name) ? name : target && turnCtx.switchedOff(target.name) ? target.name : null
      if (off) return { text: `Error: ${off} is switched off in this chat, so it was not run.`, isError: true }
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
  }
}

/**
 * A call to a tool the client runs (master plan 7.1): sent over the event
 * stream as `client_call`, answered by POST /tasks/:id/client-result. With
 * no client connected, or when the client leaves or takes longer than
 * CLIENT_CALL_TIMEOUT_MS, the model is told it was not run. A banned name
 * is refused here too: bans apply to client tools as to any.
 */
async function runOnClient(pass, call) {
  const { task, l, turnCtx } = pass
  const name = call.function.name
  if ((turnCtx.config?.disabledTools ?? []).includes(name)) {
    return { text: `Error: ${name} is not allowed on this server.`, isError: true }
  }
  const sink = l.clientSinks.at(-1)
  if (!sink) {
    store.appendEvent(task.id, { type: 'tool_result', callId: call.id, name, isError: true, preview: 'client not connected' })
    return { text: clientUnavailable(name), isError: true }
  }
  store.updateTask(task.id, { inFlight: { callId: call.id, name }, status: 'waiting_client', waiting: { kind: 'client', callId: call.id, tool: name } })
  // Stored for the record; the request itself goes to one client only (a
  // live event on its stream), so a second tab never runs it too.
  store.appendEvent(task.id, { type: 'client_call', callId: call.id, name })
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => { l.clientWaits.delete(call.id); resolve(null) }, CLIENT_CALL_TIMEOUT_MS)
    timer.unref?.()
    const onAbort = () => { clearTimeout(timer); l.clientWaits.delete(call.id); resolve(null) }
    pass.signal.addEventListener('abort', onAbort, { once: true })
    l.clientWaits.set(call.id, { sinkId: sink.id, resolve: (r) => { clearTimeout(timer); pass.signal.removeEventListener('abort', onAbort); resolve(r) } })
    try {
      sink.send({ type: 'client_request', callId: call.id, name, arguments: call.function.arguments ?? '' })
    } catch {
      l.clientWaits.delete(call.id)
      resolve(null)
    }
  })
  if (pass.signal.aborted) throw abortError()
  pass.setRunning()
  const out = result ?? { text: clientUnavailable(name), isError: true }
  store.appendEvent(task.id, { type: 'tool_result', callId: call.id, name, isError: out.isError, preview: preview(out.text) })
  return out
}

// ---------------------------------------------------------------------------
// gate
// ---------------------------------------------------------------------------

/** call_tool's target, or null when it is unreadable or names nothing. */
function callToolTargetOf(call) {
  try {
    return callToolTarget(call.function.name, parseArgs(call.function.arguments))
  } catch {
    return null
  }
}

/** Park on a ledger approval this task holds until it is decided, or the call is aborted (null). */
function awaitDecision(pass, pending, call, name, rule, sig) {
  return new Promise((resolve) => {
    if (sig?.aborted) return resolve(null)
    const off = ledger.onDecided((approvalId, d) => {
      if (approvalId !== pending.id) return
      off(); sig?.removeEventListener('abort', onAbort)
      resolve(d)
    })
    const onAbort = () => { off(); resolve(null) }
    sig?.addEventListener('abort', onAbort, { once: true })
    store.updateTask(pass.task.id, { status: 'waiting_approval', waiting: { kind: 'approval', callId: call.id, tool: name, rule, approval: pending } })
  })
}

/**
 * The gate: rule 'none' runs; 'prompt' with a standing grant runs; anything
 * else parks in waiting_approval until POST /approvals/:id decides it.
 */
export function gatePort(pass) {
  const { task, l, turnCtx, approved } = pass
  return {
    approve: async (call, sig) => {
      let name = call.function.name
      let args
      // call_tool is decided as the call it carries (U-S6): the approval is
      // for that tool and those arguments, which is what Nest enforces when
      // call_tool passes it on. Unreadable or naming nothing: call_tool
      // itself, and Nest answers it.
      // A client tool's approval is the client's own card (D48), shown
      // before it runs the call; Nest's ledger has no say over it.
      if (turnCtx.clientToolNames.has(name)) return true
      const target = name === 'call_tool' ? callToolTargetOf(call) : null
      if (target) ({ name, args } = target)
      const rule = approvalRule(name)
      if (rule === 'none') return true
      // Not offered this turn (banned, withdrawn, made up): nothing to ask
      // about. callToolAs refuses it with the reason.
      if (!turnCtx.toolNames.has(name)) return true
      const t = store.getTask(task.id)
      if (rule === 'prompt' && grantCovers(t.accountKey, name)) return true
      if (!target) {
        try { args = parseArgs(call.function.arguments) } catch { return true } // execute reports the bad arguments
      }
      const pending = ledger.requestApproval({ accountKey: t.accountKey, tool: name, args, holder: task.id })
      l.heldApprovals.add(pending.id)
      const decision = await awaitDecision(pass, pending, call, name, rule, sig)
      l.heldApprovals.delete(pending.id)
      if (decision === 'once' || decision === 'always') {
        approved.set(call.id, pending.id)
        // A tool Nest does not enforce never spends the approval: clear it.
        // Through call_tool it does enforce (U-S6), so the id is passed on.
        if (!isApprovalEnforced(name) && !target) ledger.consume(pending.id, { accountKey: t.accountKey, tool: name, args })
        pass.setRunning()
        return true
      }
      ledger.withdraw(pending.id)
      if (decision === 'deny') pass.setRunning()
      return false
    },
  }
}

// ---------------------------------------------------------------------------
// ask, plan, limit, steering
// ---------------------------------------------------------------------------

/** ask_user parks in waiting_user until POST /tasks/:id/answer. */
export function askPort(pass) {
  return {
    user: async (request, _sig, call) => pass.waitForAnswer('question', {
      kind: 'question', callId: call?.id, questions: request.questions,
    }, null),
  }
}

/** The conversation's `plan` field, as chat-ui keeps it. */
export function planPort(pass) {
  return {
    get: () => pass.planSteps,
    save: (steps) => {
      pass.planSteps = steps
      const t = store.getTask(pass.task.id)
      conversations.updateConversation(t.storeAccountId, t.conversationId, { plan: { steps, updatedAt: Date.now() } })
      store.appendEvent(pass.task.id, { type: 'plan', steps })
    },
  }
}

/** The turn limit parks in waiting_user with the continue question (D30). */
export function limitPort(pass) {
  return {
    askContinue: async () => pass.waitForAnswer('continue', { kind: 'continue', turns: pass.task.limits.maxTurns }, false),
  }
}

/** Every port the loop takes, for this pass. */
export function buildPorts(pass) {
  return {
    model: modelPort(pass),
    tools: toolsPort(pass),
    gate: gatePort(pass),
    ask: askPort(pass),
    plan: planPort(pass),
    limit: limitPort(pass),
    steering: { pending: () => pass.l.steering.length > 0 },
    fallbackParser: () => ({ patterns: FALLBACK_PARSER_PATTERNS, availableTools: pass.turnCtx.mcpTools.map((t) => ({ name: t.name })) }),
    log: (m) => logEvent('task', 'loop', { note: preview(m) }),
  }
}

// ---------------------------------------------------------------------------
// callbacks: every message the loop adds is written here
// ---------------------------------------------------------------------------

export function buildCallbacks(pass) {
  const { task, appended, turnCtx } = pass
  return {
    onAssistantTurnComplete: async (content, reasoning, timings, toolCalls) => {
      const current = pass.current
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
      pass.write({ id: current.id, parent: current.parent, type: 'text', role: 'assistant', timestamp: Date.now(), ...fields })
      appended.add(current.id)
    },
    createAssistantMessage: async () => {
      pass.newTurn()
    },
    createToolResultMessage: async (toolCallId, content) => {
      const m = pass.write({ id: crypto.randomUUID(), parent: pass.tip, type: 'text', role: 'tool', content, toolCallId, timestamp: Date.now(), toolCalls: '', model: null })
      if (store.getTask(task.id)?.inFlight?.callId === toolCallId) store.updateTask(task.id, { inFlight: null })
      return { id: m.id }
    },
  }
}
