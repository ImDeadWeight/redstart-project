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
import { wireSafeToolCalls } from '../../../../shared/agent-core/tool-calls.mjs'
import { attachmentNote } from '../../../../shared/agent-core/attachment-note.mjs'
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
    // As chat-ui's ChatService does: a malformed earlier call goes as "{}",
    // or llama-server refuses the whole request (wireSafeToolCalls).
    if (m.tool_calls) out.tool_calls = wireSafeToolCalls(m.tool_calls)
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

/**
 * The most tokens one reply may generate. A model that falls into a loop
 * otherwise runs until the context is full: Qwen3-4B produced 12k tokens on
 * one compute-chart turn (2026-11-11). Across all 664 real turns saved that
 * day the longest reply was 1,308 tokens (median 82, p99 800), so 4,096
 * leaves three times that and still stops a loop early. Thinking counts
 * reasoning against the same budget, hence the larger default. --max-tokens
 * overrides both.
 *
 * Bench only, on purpose: a chat user's own max_tokens setting governs their
 * replies, and since c8ba6b0 their Stop button really stops the model.
 *
 * @param {{ maxTokens?: number, thinking?: boolean }} opts
 */
export function maxReplyTokens(opts) {
  if (opts.maxTokens !== undefined) return opts.maxTokens
  return opts.thinking ? 16384 : 4096
}

/**
 * The prompt as the model receives it: the task's words, then the note
 * chat-ui appends to a message whose attachments it saved to the workspace.
 * The note comes from the core (attachment-note.mjs), the builder chat-ui's
 * utils/workspace-upload.ts also uses, so a fixture task is exactly as hard
 * as attaching the files in the chat.
 *
 * @param {{ prompt: string, fixtures: Array<{ path: string }> }} task
 * @param {{ conversationId: string, hasTool: (name: string) => boolean }} ctx
 */
export function userMessage(task, ctx) {
  const note = attachmentNote({ saved: task.fixtures.map((f) => f.path), ...ctx })
  return note ? `${task.prompt}\n\n${note}` : task.prompt
}

// The documents-relative paths a tool result names: the Phase 2 [file: ...]
// line and create_document's older [FILE: ...] marker.
const FILE_LINE_RES = [/^\[file: ([^,\]]+), [^\]]*\]$/, /^\[FILE: ([^\]]+)\]$/]

/** @param {string} text */
export function filePathsIn(text) {
  const out = []
  // split on LF; trim() below drops a CR
  for (const line of (text ?? '').split('\n')) {
    for (const re of FILE_LINE_RES) {
      const m = re.exec(line.trim())
      if (m) out.push(m[1].trim())
    }
  }
  return out
}

const clip = (s) => (typeof s === 'string' && s.length > MAX_LOGGED_RESULT_CHARS
  ? `${s.slice(0, MAX_LOGGED_RESULT_CHARS)}… [${s.length - MAX_LOGGED_RESULT_CHARS} more chars]`
  : s)

/**
 * Run one task once.
 *
 * @param {Awaited<ReturnType<import('./nest-client.mjs').connectNest>>} nest
 * @param {Awaited<ReturnType<import('./task-file.mjs').loadTask>>} task
 * @param {{ mcpTools: any[], thinking?: boolean, temperature?: number, model?: string, maxTokens?: number,
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
  /** documents-relative path → text, for files the run made outside its workspace */
  const createdFiles = {}
  /** @type {Map<string, string> | null} the File System folder before the run */
  let fsBefore = null
  /** @type {{ created: string[], modified: string[] } | null} */
  let fileSystemWrites = null

  try {
    // The File System tools write to the account's own folder ('files'
    // space), which no conversation owns. Snapshot it so what this run adds
    // there can be removed after (see the finally below).
    fsBefore = opts.fileSystemSnapshot === false ? null : ((await nest.snapshotFiles('files').catch(() => null)) || null)
    await nest.ensureWorkspace(conversationId)
    for (const fx of task.fixtures) await nest.seedFile(conversationId, fx.path, fx.content)

    const controller = new AbortController()
    const timer = setTimeout(() => {
      log({ type: 'limit', which: 'seconds' })
      controller.abort()
    }, task.limits.maxSeconds * 1000)

    const messages = [{ role: 'user', content: userMessage(task, { conversationId, hasTool: (n) => toolsByName.has(n) }) }]
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
                max_tokens: maxReplyTokens(opts),
              }
              const res = await nest.completion(body, signal)
              await readChatStream(res, acc, { signal })
              // Hitting the cap is a limit like the turn and time limits:
              // logged, so it shows in the summary's "hit a limit" count.
              if ((acc.timings?.predicted_n ?? 0) >= body.max_tokens) log({ type: 'limit', which: 'reply-length' })
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
              const clipped = clip(result.text)
              log({ type: 'tool_result', id: call.id, name, isError: result.isError, text: clipped,
                ...(clipped !== result.text ? { fullText: result.text } : {}), ms: now() - started })
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

    // Files the run created OUTSIDE its workspace: create_document writes to
    // the account's documents root, not chats/<id>/. Named by the results'
    // file lines, read back for the check, and removed below like the
    // conversation, so one run's output is never another run's input.
    const ownPrefix = `chats/${conversationId}/`
    const outside = new Set()
    for (const e of events) {
      if (e.type !== 'tool_result') continue
      for (const p of filePathsIn(e.fullText ?? e.text)) if (!p.startsWith(ownPrefix)) outside.add(p)
    }
    for (const p of outside) {
      const text = await nest.readDocument(p).catch(() => null)
      if (text !== null) createdFiles[p] = text
    }
  } finally {
    // Files the run wrote with the File System tools. Before 2026-11-11 they
    // outlived the run: a 4B run left an inventory.csv there, the 35B's
    // p1-stop-and-report later found it with read_file, invented a supplier
    // email next to it, and spent its turns reconciling the two. New files
    // go to the account's trash (recoverable). A file that already existed
    // and changed cannot be put back; it is recorded, and run.mjs warns.
    if (fsBefore) {
      const after = (await nest.snapshotFiles('files').catch(() => null)) || null
      if (after) {
        const created = [...after.keys()].filter((p) => !fsBefore.has(p)).sort()
        const modified = [...after.keys()].filter((p) => fsBefore.has(p) && fsBefore.get(p) !== after.get(p)).sort()
        fileSystemWrites = { created, modified }
        if (created.length || modified.length) log({ type: 'file_system_writes', created, modified, removed: !opts.keep })
        if (!opts.keep) for (const p of created) await nest.deleteFile('files', p).catch(() => {})
      }
    }
    if (!opts.keep) {
      for (const p of Object.keys(createdFiles)) await nest.deleteDocument(p).catch(() => {})
      await nest.deleteConversation(conversationId).catch(() => {})
    }
  }

  log({ type: 'end', finalText })

  let verdict
  try {
    verdict = await task.check(finalText, workspace, events, { createdFiles, conversationId })
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
    createdFiles: Object.keys(createdFiles).sort(),
    fileSystemWrites,
    events,
  }
}
