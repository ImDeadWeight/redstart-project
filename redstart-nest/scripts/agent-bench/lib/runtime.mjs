// =============================================================================
// Agent bench — --runtime: the daemon hosts the loop (agent-runtime 3.10)
// =============================================================================
// The default bench hosts shared/agent-core's loop itself (bench.mjs). With
// --runtime it hosts nothing: each run is POSTed to /tasks, so the loop runs
// in the daemon's task runner exactly as a background task started from a
// chat does, and the bench plays the user through the task routes:
//
//   ask_user            waiting_user (question): answered from the task's
//                       `answers` (lib/ask.mjs); no match is a dismissal
//   approvals           waiting_approval: decided by the task's `approve`
//                       policy, POST /approvals/:id once | deny. The daemon
//                       never asks about a read (rule none), so a policy that
//                       refuses reads cannot act here; every task in
//                       tasks/ is "all", so the modes agree.
//   the turn limit      waiting_user (continue): "no", logged as the limit
//   the time limit      the task is cancelled, logged as the limit
//   --text-asks answer  a final reply ending in a question starts another
//                       task in the same conversation with the reply
//
// The run log the checks and metrics read is then rebuilt from the
// conversation the daemon wrote (assistant turns, tool calls, results), plus
// what only the event stream says (turns, plan nudges, which results were
// errors, which questions were dismissed). Same event shapes as bench.mjs.
//
// What the modes cannot share: --plan off|tool (a task always has
// update_plan with its completion check: what chat-ui ships), --model (a
// task uses the loaded model), and compaction (a task compacts as a chat
// does; the hosted bench never does).
// =============================================================================

import { currentBranch } from '../../../../shared/agent-core/stored-messages.mjs'
import { DENIED_RESULT, MAX_TOOL_CALLS_PER_REPLY } from '../../../../shared/agent-core/tool-calls.mjs'
import { openSteps } from '../../../../shared/agent-core/update-plan.mjs'
import { argumentProblem } from './metrics.mjs'
import { answerFromTask } from './ask.mjs'
import { META_CLASS_KEY } from './nest-client.mjs'
import { approves, clip, endsInQuestion, formatTextAskReply, maxReplyTokens, userMessage, MAX_TEXT_ASKS } from './bench.mjs'

const TERMINAL = ['done', 'failed', 'cancelled']
/** After the time limit cancels a task, how long its stream may take to close. */
const CANCEL_GRACE_MS = 30_000

/** The task's sampling settings, in the runner's names, as the hosted bench sends them. */
export function runtimeGeneration(opts) {
  return {
    enableThinking: !!opts.thinking,
    max_tokens: maxReplyTokens(opts),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
  }
}

/**
 * The run log's model-side events, rebuilt from the stored conversation.
 *
 * @param {object} conversation  GET /conversations/:id
 * @param {{ toolsByName: Map<string, any>, maxTokens: number, errorsByCall: Map<string, boolean>,
 *           dismissedByCall: Map<string, boolean> }} ctx
 */
export function eventsFromConversation(conversation, ctx) {
  const out = []
  const callsById = new Map()
  for (const m of currentBranch(conversation)) {
    if (m.role === 'assistant') {
      let calls = null
      if (m.toolCalls) {
        try { calls = JSON.parse(m.toolCalls) } catch { calls = null }
      }
      if (!Array.isArray(calls) || calls.length === 0) calls = null
      for (const c of calls ?? []) callsById.set(c.id, c)
      out.push({
        type: 'assistant',
        content: m.content ?? '',
        reasoningChars: m.reasoningContent?.length ?? 0,
        toolCalls: calls?.map((c) => ({ id: c.id, name: c.function?.name, arguments: c.function?.arguments })),
        timings: m.timings ? { prompt_n: m.timings.prompt_n, predicted_n: m.timings.predicted_n } : undefined,
      })
      if ((m.timings?.predicted_n ?? 0) >= ctx.maxTokens) out.push({ type: 'limit', which: 'reply-length' })
      if ((calls?.length ?? 0) > MAX_TOOL_CALLS_PER_REPLY) out.push({ type: 'limit', which: 'tool-calls', asked: calls.length })
    } else if (m.role === 'tool') {
      const call = callsById.get(m.toolCallId)
      const name = call?.function?.name ?? '(unknown)'
      const args = call?.function?.arguments
      const extra = name === 'ask_user' ? { dismissed: ctx.dismissedByCall.get(m.toolCallId) === true } : {}
      out.push({
        type: 'tool_call', id: m.toolCallId, name, arguments: args,
        argsProblem: ctx.toolsByName.has(name) ? argumentProblem(args, ctx.toolsByName.get(name).inputSchema) : 'unknown tool',
      })
      const text = typeof m.content === 'string' ? m.content : ''
      const clipped = clip(text)
      // A refused call never reaches the runner's tools port (the core
      // answers it), so the stream has no result event for it; the stored
      // text says it. An error, as bench.mjs logs a denial.
      const denied = text === DENIED_RESULT
      out.push({
        type: 'tool_result', id: m.toolCallId, name, isError: denied || ctx.errorsByCall.get(m.toolCallId) === true,
        text: clipped, ...(clipped !== text ? { fullText: text } : {}), ...(denied ? { denied: true } : {}), ...extra, ms: 0,
      })
    }
  }
  return out
}

/** The reply a run ends on: the last assistant turn with no tool calls (bench.mjs's finalText). */
export function finalTextOf(conversation, afterMessageId) {
  const branch = currentBranch(conversation)
  const from = afterMessageId ? branch.findIndex((m) => m.id === afterMessageId) + 1 : 0
  let text = ''
  for (const m of branch.slice(from)) {
    if (m.role === 'assistant' && !m.toolCalls) text = m.content ?? ''
  }
  return text
}

/**
 * Run one task through the daemon. Logs live what only the stream knows;
 * the rest is rebuilt at the end.
 *
 * @returns {Promise<{ finalText: string, error: string | null }>}
 */
export async function runViaRuntime({ nest, task, opts, log, conversationId, toolsByName }) {
  const errorsByCall = new Map()
  const dismissedByCall = new Map()
  const generation = runtimeGeneration(opts)
  let error = null
  let finalText = ''
  let current = null
  let turns = 0
  let timedOut = false
  let waitingModelLogged = false
  const hardStop = new AbortController()

  const timer = setTimeout(() => {
    timedOut = true
    log({ type: 'limit', which: 'seconds' })
    if (current) nest.cancelTask(current).catch(() => {})
    setTimeout(() => hardStop.abort(), CANCEL_GRACE_MS).unref?.()
  }, task.limits.maxSeconds * 1000)

  async function onEvent(taskId, e) {
    if (e.type === 'turn') log({ type: 'turn', turn: ++turns })
    else if (e.type === 'plan_nudge') log({ type: 'plan_nudge' })
    else if (e.type === 'tool_result' && e.callId) errorsByCall.set(e.callId, !!e.isError)
    else if (e.type === 'status') {
      const w = e.waiting
      if (e.status === 'waiting_user' && w?.kind === 'question') {
        const answer = answerFromTask(task.answers, { question: w.question, options: w.options, multiSelect: !!w.multiSelect })
        if (w.callId) dismissedByCall.set(w.callId, answer === null)
        await nest.answerTask(taskId, answer ?? { dismissed: true })
      } else if (e.status === 'waiting_user' && w?.kind === 'continue') {
        log({ type: 'limit', which: 'turns' })
        await nest.answerTask(taskId, { continue: false })
      } else if (e.status === 'waiting_approval' && w?.kind === 'approval') {
        const cls = toolsByName.get(w.tool)?._meta?.[META_CLASS_KEY]
        const ok = approves(task.approve, w.tool, cls)
        const decided = await nest.decideApproval(w.approval.id, ok ? 'once' : 'deny')
        log({ type: 'approval', id: w.callId, name: w.tool, decided: ok && decided, ...(ok ? {} : { denied: true }) })
      } else if (e.status === 'waiting_model' && !waitingModelLogged) {
        waitingModelLogged = true
        log({ type: 'waiting_model' })
      }
    }
  }

  /** Follow one task to its end, reconnecting from the last seq if the stream drops. */
  async function follow(taskId) {
    let after = 0
    for (;;) {
      try {
        await nest.taskEvents(taskId, after, async (e) => {
          after = Math.max(after, e.seq)
          await onEvent(taskId, e)
        }, hardStop.signal)
      } catch (err) {
        if (hardStop.signal.aborted) return { status: 'cancelled', error: 'the task did not stop after the time limit' }
      }
      const t = await nest.getTask(taskId)
      if (TERMINAL.includes(t.status) || hardStop.signal.aborted) return t
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  let prompt = userMessage(task, { conversationId, hasTool: (n) => toolsByName.has(n) })
  let roundStart = null
  try {
    for (let round = 0; ; round++) {
      const before = await nest.getConversation(conversationId)
      roundStart = before.currNode || null
      const record = await nest.startTask(conversationId, prompt, generation, task.limits.maxTurns)
      current = record.id
      log({ type: 'runtime_task', id: record.id })
      const end = await follow(record.id)
      if (end.status === 'failed') {
        error = end.error || 'the task failed'
        log({ type: 'error', message: error })
      }
      finalText = finalTextOf(await nest.getConversation(conversationId), roundStart)
      if (timedOut || end.status !== 'done') break
      if (opts.textAsks !== 'answer' || round >= MAX_TEXT_ASKS || !endsInQuestion(finalText)) break
      const answer = answerFromTask(task.answers, { question: finalText })
      const reply = formatTextAskReply(answer)
      log({ type: 'text_ask', question: finalText.slice(-400), answered: !!answer, reply })
      prompt = reply
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    log({ type: 'error', message: error })
  } finally {
    clearTimeout(timer)
  }

  const conversation = await nest.getConversation(conversationId)
  for (const e of eventsFromConversation(conversation, { toolsByName, maxTokens: generation.max_tokens, errorsByCall, dismissedByCall })) log(e)
  const steps = conversation.plan?.steps
  if (Array.isArray(steps) && steps.length > 0) log({ type: 'plan_final', steps: steps.length, open: openSteps(steps).length })
  return { finalText, error }
}
