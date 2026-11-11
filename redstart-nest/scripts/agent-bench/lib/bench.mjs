// =============================================================================
// Agent bench — the Node host of the loop core
// =============================================================================
// Agent-runtime plan Phase 0.2 (D1's second host). Runs shared/agent-core's
// loop against a running Nest, one task at a time, with ports built the way
// chat-ui builds its own so the numbers describe what a chat user gets:
//
//   model.streamTurn   POST /v1/chat/completions through the gateway (real
//                      system prompt, bans, tool retrieval), read with the
//                      core's readChatStream; thinking off, reasoning sent
//                      back, as chat-ui's defaults are
//   tools.execute      MCP tools/call with the run's conversation id, result
//                      formatted by the core as chat-ui formats it; argument
//                      errors thrown with chat-ui's messages
//   gate.approve       the task's `approve` policy, decided without asking
//   limit.askContinue  "no": reaching maxTurns ends the run, recorded
//   steering           never
//   fallbackParser     on, chat-ui's default patterns, Nest's tool names
//
// Each run gets a fresh conversation (so a fresh workspace), its fixtures
// uploaded first, and an event log the metrics are computed from.
// =============================================================================

import * as crypto from 'node:crypto'
import { runAgentLoop } from '../../../../shared/agent-core/loop.mjs'
import { readChatStream } from '../../../../shared/agent-core/chat-stream.mjs'
import { argumentProblem, computeMetrics } from './metrics.mjs'
import { META_CLASS_KEY } from './nest-client.mjs'

export const DEFAULT_PARSER_PATTERNS = ['braces', 'xml', 'fn', 'json']
const MAX_LOGGED_RESULT_CHARS = 4000

/** MCP tools → the OpenAI tool list chat-ui sends. */
export function toLlmTools(mcpTools) {
  return mcpTools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema ?? { type: 'object', properties: {}, required: [] },
    },
  }))
}

/** The task's approval policy as a decision for one tool. */
export function approves(policy, toolName, toolClass) {
  if (policy === 'all') return true
  if (policy === 'reads') return toolClass === 'read'
  return Array.isArray(policy) && policy.includes(toolName)
}

/** Loop messages → the wire shape ChatService sends (undefined fields dropped). */
function toWire(messages) {
  return messages.map((m) => {
    const out = { role: m.role, content: m.content ?? '' }
    if (m.tool_calls) out.tool_calls = m.tool_calls
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id
    if (m.reasoning_content) out.reasoning_content = m.reasoning_content
    return out
  })
}

/** chat-ui's parseToolArguments, message for message. */
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

const clip = (s) => (typeof s === 'string' && s.length > MAX_LOGGED_RESULT_CHARS
  ? `${s.slice(0, MAX_LOGGED_RESULT_CHARS)}… [${s.length - MAX_LOGGED_RESULT_CHARS} more chars]`
  : s)

/**
 * Run one task once.
 *
 * @param {Awaited<ReturnType<import('./nest-client.mjs').connectNest>>} nest
 * @param {Awaited<ReturnType<import('./task-file.mjs').loadTask>>} task
 * @param {{ mcpTools: any[], thinking?: boolean, temperature?: number, model?: string,
 *           keep?: boolean, now?: () => number, runIndex?: number }} opts
 */
export async function runTask(nest, task, opts) {
  const now = opts.now ?? Date.now
  const events = []
  const log = (e) => events.push({ t: now(), ...e })

  const toolsByName = new Map(opts.mcpTools.map((t) => [t.name, t]))
  const llmTools = toLlmTools(opts.mcpTools)
  const conversationId = `bench-${task.id}-${crypto.randomBytes(4).toString('hex')}`

  log({ type: 'start', taskId: task.id, conversationId, tools: llmTools.length })
  await nest.createConversation(conversationId, `agent-bench ${task.id}`)
  let finalText = ''
  let error = null
  let workspace = {}

  try {
    await nest.ensureWorkspace(conversationId)
    for (const fx of task.fixtures) await nest.seedFile(conversationId, fx.path, fx.content)

    const controller = new AbortController()
    const timer = setTimeout(() => {
      log({ type: 'limit', which: 'seconds' })
      controller.abort()
    }, task.limits.maxSeconds * 1000)

    const messages = [{ role: 'user', content: task.prompt }]
    let turn = 0

    try {
      await runAgentLoop({
        messages,
        maxTurns: task.limits.maxTurns,
        signal: controller.signal,
        callbacks: {
          onAssistantTurnComplete: async (content, reasoning, timings, toolCalls) => {
            log({
              type: 'assistant',
              content,
              reasoningChars: reasoning?.length ?? 0,
              toolCalls: toolCalls?.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })),
              timings: timings ? { prompt_n: timings.prompt_n, predicted_n: timings.predicted_n } : undefined,
            })
            if (!toolCalls) finalText = content
          },
        },
        ports: {
          model: {
            streamTurn: async ({ acc, messages: msgs, signal }) => {
              log({ type: 'turn', turn: ++turn })
              const body = {
                messages: toWire(msgs),
                stream: true,
                tools: llmTools.length > 0 ? llmTools : undefined,
                reasoning_format: 'auto',
                chat_template_kwargs: { enable_thinking: !!opts.thinking },
                ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
                ...(opts.model ? { model: opts.model } : {}),
              }
              const res = await nest.completion(body, signal)
              await readChatStream(res, acc, { signal })
            },
          },
          tools: {
            execute: async (call) => {
              const name = call.function.name
              const tool = toolsByName.get(name)
              log({
                type: 'tool_call',
                id: call.id,
                name,
                arguments: call.function.arguments,
                argsProblem: tool ? argumentProblem(call.function.arguments, tool.inputSchema) : 'unknown tool',
              })
              const started = now()
              let result
              try {
                if (!tool) throw new Error(`Unknown tool: ${name}`)
                result = await nest.callTool(name, parseArgs(call.function.arguments), conversationId)
              } catch (err) {
                log({ type: 'tool_result', id: call.id, name, isError: true, text: `Error: ${err.message}`, ms: now() - started })
                throw err
              }
              log({ type: 'tool_result', id: call.id, name, isError: result.isError, text: clip(result.text), ms: now() - started })
              return result
            },
          },
          gate: {
            approve: async (call) => {
              const name = call.function.name
              const cls = toolsByName.get(name)?._meta?.[META_CLASS_KEY]
              const ok = approves(task.approve, name, cls)
              if (!ok) {
                // The core answers a denial itself; record it as the call and
                // the error result it is, so the metrics count it.
                log({ type: 'tool_call', id: call.id, name, arguments: call.function.arguments, argsProblem: null, denied: true })
                log({ type: 'tool_result', id: call.id, name, isError: true, denied: true, text: 'Tool execution was denied by the user.', ms: 0 })
              }
              return ok
            },
          },
          limit: {
            askContinue: async () => {
              log({ type: 'limit', which: 'turns' })
              return false
            },
          },
          steering: { pending: () => false },
          fallbackParser: () => ({
            patterns: DEFAULT_PARSER_PATTERNS,
            availableTools: opts.mcpTools.map((t) => ({ name: t.name })),
          }),
        },
      })
    } catch (err) {
      error = err.message
      log({ type: 'error', message: err.message })
    } finally {
      clearTimeout(timer)
    }

    workspace = await nest.readWorkspace(conversationId)
  } finally {
    if (!opts.keep) await nest.deleteConversation(conversationId).catch(() => {})
  }

  log({ type: 'end', finalText })

  let verdict
  try {
    verdict = await task.check(finalText, workspace, events)
    if (!verdict || typeof verdict.pass !== 'boolean') {
      verdict = { pass: false, reason: `check ${task.checkName} returned no { pass, reason }` }
    }
  } catch (err) {
    verdict = { pass: false, reason: `check threw: ${err.message}` }
  }

  return {
    taskId: task.id,
    group: task.group,
    phase: task.phase,
    run: opts.runIndex ?? 0,
    conversationId,
    verdict,
    error,
    metrics: computeMetrics(events, verdict),
    finalText,
    workspaceFiles: Object.keys(workspace).sort(),
    events,
  }
}
