// =============================================================================
// The agent loop core, under plain Node with fake ports
// =============================================================================
// Agent-runtime plan Phase 0.1. The loop moved out of chat-ui into
// shared/agent-core/ so the browser, the benchmark and (Phase 3) the daemon
// run one loop instead of three that drift. chat-ui's
// tests/unit/agentic-loop.test.ts still pins it through the browser host; this
// suite pins the same contract from the daemon's side of the tree, with no
// Svelte, no DOM and no vitest, which is how the bench and the daemon load it.
//
// The contract is the exit paths:
//   - every way out calls onFlowComplete exactly once
//   - a turn that streamed is saved (onAssistantTurnComplete) BEFORE the flow
//     completes, on abort and stream error too, with the timings measured
//     during that turn
//   - a stream error is rethrown after both; an abort is not
//   - 'stopped' from the tool calls ends the flow there, 'done' starts another
//     turn
// plus what only the core can be asked directly: deny and error results,
// steering mid-tools, the turn limit, attachments, progress, normalisation,
// the fallback parser as the loop applies it, MCP results as text, the SSE
// stream reader, and that the core imports nothing a host would have to
// provide.
//
// Run:  node scripts/test-agent-core.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAgentLoop, createTurnAccumulator } from '../../shared/agent-core/loop.mjs'
import { readChatStream, mergeToolCallDeltas, streamErrorMessage } from '../../shared/agent-core/chat-stream.mjs'
import { parseToolCallsFromTurn } from '../../shared/agent-core/tool-call-parser.mjs'
import { formatMcpToolResult } from '../../shared/agent-core/tool-result.mjs'
import { buildFinalTimings } from '../../shared/agent-core/timings.mjs'
import { attachmentNote } from '../../shared/agent-core/attachment-note.mjs'
import {
  DENIED_RESULT,
  INTERRUPTED_RESULT,
  MAX_TOOL_CALLS_PER_REPLY,
  overLimitResult,
  normalizeToolCalls,
  wireSafeToolCalls,
} from '../../shared/agent-core/tool-calls.mjs'
import { DISMISSED_RESULT, formatAskAnswer, parseAskArguments } from '../../shared/agent-core/ask-user.mjs'
import { formatPlanResult, parsePlanArguments, planTailNote } from '../../shared/agent-core/update-plan.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const coreDir = path.join(here, '..', '..', 'shared', 'agent-core')

const results = []

async function test(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false })
    console.log(`FAIL  - ${name}\n        ${err.stack ?? err.message}`)
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

function eq(actual, expected, message) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${message}\n        expected ${e}\n        got      ${a}`)
}

const call = (id, name = 't', args = '{}') => ({ id, type: 'function', function: { name, arguments: args } })

/**
 * A loop with fake ports. `turns` is one function per model turn, given the
 * accumulator and the messages sent; a turn past the end answers 'done'.
 * Every callback and port call is recorded, in order, in `calls`.
 */
function harness(opts = {}) {
  const {
    turns = [],
    maxTurns = 4,
    approve = () => true,
    askContinue = () => false,
    execute = async (c) => ({ text: `ran ${c.function.name}`, isError: false }),
    steering = () => false,
    extractAttachments,
    extraParts,
    signal,
    createToolResultMessage = async (id) => ({ id: `msg-${id}` }),
    ask,
    // { steps?, completionCheck?, save? }: a plan port over an in-memory list.
    plan,
  } = opts

  const calls = []
  const saved = []
  const flowCompletions = []
  const toolResults = []
  const progress = []
  const sentMessages = []
  let turnIndex = 0
  let clock = 0

  const callbacks = {
    onAssistantTurnComplete: async (content, reasoning, timings, toolCalls) => {
      calls.push('onAssistantTurnComplete')
      saved.push({ content, reasoning, timings, toolCalls })
    },
    createToolResultMessage: async (id, content, extras) => {
      calls.push('createToolResultMessage')
      toolResults.push({ id, content, extras })
      return createToolResultMessage(id)
    },
    createAssistantMessage: async () => {
      calls.push('createAssistantMessage')
    },
    onAttachments: (messageId, extras) => {
      calls.push('onAttachments')
      toolResults.at(-1).attachedTo = { messageId, extras }
    },
    onFlowComplete: (timings) => {
      calls.push('onFlowComplete')
      flowCompletions.push(timings)
    },
    onTurnComplete: () => {
      calls.push('onTurnComplete')
    },
  }

  const ports = {
    model: {
      streamTurn: async ({ acc, messages }) => {
        calls.push('streamTurn')
        sentMessages.push(structuredClone(messages))
        const turn = turns[turnIndex++]
        if (turn) await turn(acc, messages)
        else acc.content += 'done'
      },
    },
    tools: {
      execute: async (c, s) => {
        calls.push(`execute:${c.id}`)
        clock += 10
        return execute(c, s)
      },
      ...(extractAttachments ? { extractAttachments } : {}),
      ...(extraParts ? { extraParts } : {}),
    },
    gate: {
      approve: async (c) => {
        calls.push(`approve:${c.id}`)
        return approve(c)
      },
    },
    limit: {
      askContinue: async () => {
        calls.push('askContinue')
        return askContinue()
      },
    },
    steering: { pending: () => steering() },
    ...(ask ? { ask: {
      user: async (req, s, c) => { calls.push(`ask:${c?.id}`); return ask(req, s) },
      invalid: (c) => { calls.push(`ask-invalid:${c.id}`) },
    } } : {}),
    ...(plan ? { plan: {
      get: () => plan.steps ?? null,
      save: async (steps, c) => {
        calls.push(`plan-save:${c?.id}`)
        if (plan.save) await plan.save(steps)
        plan.steps = steps
      },
      invalid: (c) => { calls.push(`plan-invalid:${c.id}`) },
      ...(plan.completionCheck === false ? { completionCheck: false } : {}),
    } } : {}),
    progress: (patch) => progress.push(patch),
    now: () => clock,
    yield: async () => {},
  }

  const messages = [{ role: 'user', content: 'hello' }]
  const done = runAgentLoop({ messages, maxTurns, ports, callbacks, signal })
  return { done, calls, saved, flowCompletions, toolResults, progress, messages, sentMessages }
}

const before = (calls, a, b) => {
  const i = calls.indexOf(a)
  const j = calls.indexOf(b)
  return i >= 0 && j >= 0 && i < j
}
const count = (calls, name) => calls.filter((c) => c === name).length

console.log('\n-- exit paths (the contract chat-ui\'s agentic-loop.test.ts pins) --')

await test('a prose answer is saved before the flow completes, and completes once', async () => {
  const h = harness({ turns: [async (acc) => { acc.content += 'the answer' }] })
  await h.done
  assert(before(h.calls, 'onAssistantTurnComplete', 'onFlowComplete'), `order: ${h.calls}`)
  eq(count(h.calls, 'onFlowComplete'), 1, 'onFlowComplete count')
  eq(h.saved[0].content, 'the answer', 'saved content')
  eq(h.saved[0].toolCalls, undefined, 'no tool calls on a prose answer')
})

await test('with no tool run, the captured timings pass through untouched (undefined when none)', async () => {
  const h = harness()
  await h.done
  eq(h.flowCompletions, [undefined], 'onFlowComplete argument')
})

await test('a stream error saves the partial turn with its timings, completes, and rethrows', async () => {
  const h = harness({
    turns: [async (acc) => {
      acc.timings = acc.captured = { predicted_n: 7, predicted_ms: 70 }
      acc.content += 'partial '
      throw new Error('stream exploded')
    }],
  })
  let err = null
  try { await h.done } catch (e) { err = e }
  assert(err?.message === 'stream exploded', `expected the stream error, got ${err?.message}`)
  assert(before(h.calls, 'onAssistantTurnComplete', 'onFlowComplete'), `order: ${h.calls}`)
  eq(h.saved[0].content, 'partial ', 'partial content')
  eq(h.saved[0].timings?.predicted_n, 7, 'timings from the failed turn')
  eq(count(h.calls, 'onFlowComplete'), 1, 'onFlowComplete count')
})

await test('a non-Error thrown by the stream is rethrown as an Error', async () => {
  const h = harness({ turns: [async () => { throw 'nope' }] })
  let err = null
  try { await h.done } catch (e) { err = e }
  assert(err instanceof Error && err.message === 'LLM stream error', `got ${err}`)
})

await test('an abort during the stream saves the partial turn and resolves without rethrowing', async () => {
  const controller = new AbortController()
  const h = harness({
    signal: controller.signal,
    turns: [async (acc) => {
      acc.timings = acc.captured = { predicted_n: 5 }
      acc.content += 'half an answer'
      controller.abort()
      throw new Error('aborted')
    }],
  })
  await h.done
  assert(before(h.calls, 'onAssistantTurnComplete', 'onFlowComplete'), `order: ${h.calls}`)
  eq(h.saved[0].content, 'half an answer', 'partial content')
  eq(h.saved[0].timings?.predicted_n, 5, 'timings from the aborted turn')
})

await test('steering after a turn exits before its tools run, keeping the turn and its calls', async () => {
  let queued = false
  const h = harness({
    steering: () => queued,
    turns: [async (acc) => {
      acc.content += 'interrupted answer'
      acc.toolCalls = [call('call_1')]
      queued = true
    }],
  })
  await h.done
  assert(before(h.calls, 'onAssistantTurnComplete', 'onFlowComplete'), `order: ${h.calls}`)
  eq(count(h.calls, 'streamTurn'), 1, 'one model turn')
  assert(!h.calls.some((c) => c.startsWith('approve') || c.startsWith('execute')), `tools ran: ${h.calls}`)
  eq(h.saved[0].toolCalls, [call('call_1')], 'the turn is saved with its normalised calls')
})

await test('an already-aborted signal completes the flow without streaming or saving', async () => {
  const controller = new AbortController()
  controller.abort()
  const h = harness({ signal: controller.signal })
  await h.done
  eq(h.calls, ['onFlowComplete'], 'calls')
})

await test("'done': tools ran, so another turn starts, and it sees the tool result", async () => {
  const h = harness({ turns: [async (acc) => { acc.toolCalls = [call('call_1')] }] })
  await h.done
  eq(count(h.calls, 'streamTurn'), 2, 'model turns')
  eq(count(h.calls, 'onFlowComplete'), 1, 'onFlowComplete count')
  eq(count(h.calls, 'createAssistantMessage'), 1, 'a new assistant message for turn 2 only')
  const second = h.sentMessages[1]
  eq(second.at(-2).tool_calls, [call('call_1')], 'assistant message with the call')
  eq(second.at(-1), { role: 'tool', tool_call_id: 'call_1', content: 'ran t' }, 'tool result message')
})

await test("'stopped': an abort while the gate is open ends the flow with no second turn", async () => {
  const controller = new AbortController()
  const h = harness({
    signal: controller.signal,
    approve: () => { controller.abort(); return true },
    turns: [async (acc) => { acc.toolCalls = [call('call_1')] }],
  })
  await h.done
  eq(count(h.calls, 'streamTurn'), 1, 'model turns')
  eq(count(h.calls, 'onFlowComplete'), 1, 'onFlowComplete count')
  assert(!h.calls.includes('execute:call_1'), 'the tool ran after the abort')
})

await test('timings captured in an earlier turn are carried to the end', async () => {
  const h = harness({
    turns: [async (acc) => {
      acc.timings = acc.captured = { predicted_n: 42, predicted_ms: 100 }
      acc.toolCalls = [call('call_1')]
    }],
  })
  await h.done
  eq(h.flowCompletions.at(-1)?.predicted_n, 42, 'final predicted_n')
})

console.log('\n-- tool calls --')

await test('a denied call is answered with the denial and counted as a failed call', async () => {
  const h = harness({
    approve: () => false,
    turns: [async (acc) => { acc.toolCalls = [call('call_1')] }],
  })
  await h.done
  assert(!h.calls.includes('execute:call_1'), 'a denied tool ran')
  eq(h.toolResults[0].content, DENIED_RESULT, 'result text')
  const t = h.flowCompletions.at(-1).agentic
  eq([t.toolCallsCount, t.toolCalls[0].success], [1, false], 'counted, unsuccessful')
})

await test('a tool that throws becomes an "Error: ..." result and the flow goes on', async () => {
  const h = harness({
    execute: async () => { throw new Error('boom') },
    turns: [async (acc) => { acc.toolCalls = [call('call_1')] }],
  })
  await h.done
  eq(h.toolResults[0].content, 'Error: boom', 'result text')
  eq(count(h.calls, 'streamTurn'), 2, 'the model gets another turn to react')
})

await test('a tool that throws an AbortError stops the flow, completing it once', async () => {
  const h = harness({
    execute: async () => { const e = new Error('cancelled'); e.name = 'AbortError'; throw e },
    turns: [async (acc) => { acc.toolCalls = [call('call_1')] }],
  })
  await h.done
  eq(count(h.calls, 'streamTurn'), 1, 'model turns')
  eq(count(h.calls, 'onFlowComplete'), 1, 'onFlowComplete count')
  eq(h.toolResults.length, 0, 'no result stored for the aborted call')
})

await test('an isError result is stored as-is and timed as a failure', async () => {
  const h = harness({
    execute: async () => ({ text: 'no such file', isError: true }),
    turns: [async (acc) => { acc.toolCalls = [call('call_1')] }],
  })
  await h.done
  eq(h.toolResults[0].content, 'no such file', 'result text')
  eq(h.flowCompletions.at(-1).agentic.toolCalls[0].success, false, 'timed as a failure')
})

await test('a reply with more tool calls than the limit runs the first ones and answers the rest', async () => {
  // Agent bench, 2026-11-11: one Qwen3-4B reply held 58 calls (40 of them
  // create_document, one delete_file) and every one ran.
  const many = Array.from({ length: MAX_TOOL_CALLS_PER_REPLY + 3 }, (_, i) => call(`c${i}`))
  const h = harness({ turns: [async (acc) => { acc.toolCalls = many }] })
  await h.done
  const ran = h.calls.filter((c) => c.startsWith('execute:'))
  eq(ran, many.slice(0, MAX_TOOL_CALLS_PER_REPLY).map((c) => `execute:${c.id}`), 'only the first ones ran, in order')
  eq(h.calls.filter((c) => c.startsWith('approve:')).length, MAX_TOOL_CALLS_PER_REPLY, 'the rest never reached the gate')
  const skipped = h.toolResults.slice(MAX_TOOL_CALLS_PER_REPLY)
  eq(skipped.map((r) => r.id), ['c10', 'c11', 'c12'], 'the rest were answered')
  assert(skipped.every((r) => r.content === overLimitResult(many.length, MAX_TOOL_CALLS_PER_REPLY)), `wording: ${skipped[0]?.content}`)
  assert(/^Not run\./.test(skipped[0].content) && skipped[0].content.includes('13 tool calls'), skipped[0].content)
  eq(h.messages.filter((m) => m.role === 'tool').length, many.length, 'every call has a result in the history')
  // Unlike a steering exit, the flow goes on: the model sees the results.
  eq(count(h.calls, 'streamTurn'), 2, 'the next turn ran')
  eq(h.sentMessages[1].filter((m) => m.role === 'tool').length, many.length, 'and was sent all the results')

  // At the limit exactly, nothing is skipped.
  const exact = harness({ turns: [async (acc) => { acc.toolCalls = many.slice(0, MAX_TOOL_CALLS_PER_REPLY) }] })
  await exact.done
  assert(exact.toolResults.every((r) => r.content === 'ran t'), 'a reply at the limit was cut')
})

console.log('\n-- ask_user (Phase 1.1) --')

const askCall = (id, args) => call(id, 'ask_user', JSON.stringify(args))

await test('ask_user goes to the ask port, not the gate or the executor, and the flow goes on', async () => {
  const seen = []
  const h = harness({
    ask: async (req) => { seen.push(req); return { text: 'Celsius' } },
    turns: [async (acc) => { acc.toolCalls = [askCall('q1', { question: 'Which unit are the readings in?' })] }],
  })
  await h.done
  eq(seen, [{ question: 'Which unit are the readings in?', multiSelect: false }], 'the request the host got')
  eq(h.toolResults.map((r) => [r.id, r.content]), [['q1', 'The user answered: Celsius']], 'result')
  assert(!h.calls.some((c) => c.startsWith('approve:') || c.startsWith('execute:')), `gate or executor ran: ${h.calls}`)
  assert(h.calls.includes('ask:q1'), `the port was not handed the call: ${h.calls}`)
  eq(count(h.calls, 'streamTurn'), 2, 'the model got the answer in a next turn')
  eq(h.sentMessages[1].find((m) => m.role === 'tool')?.content, 'The user answered: Celsius', 'the answer in the next request')
})

await test('ask_user with options: a choice, a choice plus a note, and a dismissal', async () => {
  const answers = [{ chosen: ['draft_b.md'] }, { chosen: ['A', 'B'], text: 'and keep the title' }, null]
  const h = harness({
    ask: async () => answers.shift(),
    turns: [async (acc) => {
      acc.toolCalls = [
        askCall('a', { question: 'Which draft?', options: ['draft_a.md', 'draft_b.md'] }),
        askCall('b', { question: 'Which parts?', options: ['A', 'B', 'C'], multi_select: true }),
        askCall('c', { question: 'Anything else?' }),
      ]
    }],
  })
  await h.done
  eq(h.toolResults.map((r) => r.content), [
    'The user chose: draft_b.md',
    'The user chose: A, B. They added: and keep the title',
    DISMISSED_RESULT,
  ], 'results')
})

await test('a malformed ask_user is answered with how to call it, and never reaches the person', async () => {
  const h = harness({
    ask: async () => ({ text: 'should not be asked' }),
    turns: [async (acc) => {
      acc.toolCalls = [
        call('x1', 'ask_user', '{"question": ""}'),
        askCall('x2', { question: 'Pick', options: ['1', '2', '3', '4', '5'] }),
        call('x3', 'ask_user', 'not json'),
      ]
    }],
  })
  await h.done
  eq(h.calls.filter((c) => c.startsWith('ask:')).length, 0, 'the person was asked')
  // The host still hears of each one (the bench counts them as calls).
  eq(h.calls.filter((c) => c.startsWith('ask-invalid:')), ['ask-invalid:x1', 'ask-invalid:x2', 'ask-invalid:x3'], 'invalid hook')
  for (const r of h.toolResults) assert(/^Error: .*ask_user takes \{"question"/.test(r.content), r.content)
})

await test('aborted while the question is open: the flow stops, completed once, no next turn', async () => {
  const controller = new AbortController()
  const h = harness({
    signal: controller.signal,
    ask: async () => { controller.abort(); return null },
    turns: [async (acc) => { acc.toolCalls = [askCall('q', { question: 'Which?' }), call('after')] }],
  })
  await h.done
  eq(count(h.calls, 'onFlowComplete'), 1, 'completed once')
  eq(count(h.calls, 'streamTurn'), 1, 'no next turn')
  assert(!h.calls.includes('execute:after'), 'a later call ran after the abort')
})

await test('a message typed while the question is open is the answer, not an interruption', async () => {
  // The host resolves the question with the typed message and consumes it
  // (types.d.ts, ask.user), so the next call still runs.
  let queued = false
  const h = harness({
    steering: () => queued,
    ask: async () => { queued = true; const text = 'use Fahrenheit'; queued = false; return { text } },
    turns: [async (acc) => { acc.toolCalls = [askCall('q', { question: 'Which unit?' }), call('next')] }],
  })
  await h.done
  eq(h.toolResults.map((r) => r.content), ['The user answered: use Fahrenheit', 'ran t'], 'results')
  assert(!h.toolResults.some((r) => r.content === INTERRUPTED_RESULT), 'treated as an interruption')
})

await test('with no ask port, ask_user is an ordinary call: gate, then executor', async () => {
  const h = harness({ turns: [async (acc) => { acc.toolCalls = [askCall('q', { question: 'Which?' })] }] })
  await h.done
  assert(h.calls.includes('approve:q') && h.calls.includes('execute:q'), h.calls.join(','))
})

await test('parseAskArguments and formatAskAnswer: trimming, duplicates, multi_select', async () => {
  eq(parseAskArguments('{"question": "  Which?  ", "options": [" a ", "b", "a"]}'),
    { ok: true, request: { question: 'Which?', options: ['a', 'b'], multiSelect: false } }, 'trimmed, deduplicated')
  assert(!parseAskArguments('{"question": "Q", "options": ["only"]}').ok, 'one option accepted')
  assert(!parseAskArguments('{"question": "Q", "multi_select": "yes"}').ok, 'a string multi_select accepted')
  eq(parseAskArguments('{"question": "Q", "options": null}'), { ok: true, request: { question: 'Q', multiSelect: false } }, 'null options = free text')
  eq(formatAskAnswer({ text: '   ' }), DISMISSED_RESULT, 'blank text is a dismissal')
  eq(formatAskAnswer({ chosen: [] }), DISMISSED_RESULT, 'no choice is a dismissal')
})

await test('steering during tools answers the remaining calls as interrupted and ends the flow', async () => {
  let queued = false
  const h = harness({
    steering: () => queued,
    execute: async (c) => { queued = true; return { text: `ran ${c.id}`, isError: false } },
    turns: [async (acc) => { acc.toolCalls = [call('a'), call('b'), call('c')] }],
  })
  await h.done
  eq(h.toolResults.map((r) => [r.id, r.content]),
    [['a', 'ran a'], ['b', INTERRUPTED_RESULT], ['c', INTERRUPTED_RESULT]], 'results')
  eq(count(h.calls, 'streamTurn'), 1, 'no turn after the steering exit')
  eq(count(h.calls, 'onFlowComplete'), 1, 'onFlowComplete count')
  eq(h.messages.filter((m) => m.role === 'tool').length, 3, 'every call answered in the history')
})

await test('calls run in order, each gated before it executes', async () => {
  const h = harness({ turns: [async (acc) => { acc.toolCalls = [call('a'), call('b')] }] })
  await h.done
  const seq = h.calls.filter((c) => /^(approve|execute):/.test(c))
  eq(seq, ['approve:a', 'execute:a', 'approve:b', 'execute:b'], 'sequence')
})

await test('tool timings and per-turn stats are recorded', async () => {
  const h = harness({ turns: [async (acc) => { acc.toolCalls = [call('a'), call('b')] }] })
  await h.done
  const t = h.flowCompletions.at(-1).agentic
  eq([t.turns, t.toolCallsCount, t.toolsMs, t.perTurn.length], [2, 2, 20, 2], 'turns, calls, ms, perTurn')
  eq(t.perTurn[0].toolCalls.map((c) => c.name), ['t', 't'], 'first turn\'s calls')
})

console.log('\n-- update_plan (Phase 1.2) --')

const planCall = (id, steps) => call(id, 'update_plan', JSON.stringify({ steps }))
const S = (text, status, note) => ({ text, status, ...(note ? { note } : {}) })
const lastSent = (h, i) => h.sentMessages[i].at(-1)

await test('update_plan goes to the plan port, not the gate or the executor; the result names the next step', async () => {
  const plan = {}
  const h = harness({
    plan,
    turns: [async (acc) => { acc.toolCalls = [planCall('p1', [S('read the file', 'done'), S('write the summary', 'pending')])] }],
  })
  await h.done
  eq(plan.steps, [S('read the file', 'done'), S('write the summary', 'pending')], 'saved')
  eq(h.toolResults.map((r) => r.content), ['Plan saved. Next open step: write the summary.'], 'result')
  assert(h.calls.includes('plan-save:p1'), 'the port was not handed the call')
  assert(!h.calls.some((c) => c.startsWith('approve:') || c.startsWith('execute:')), `gate or executor ran: ${h.calls}`)
})

await test('a malformed update_plan is answered with how to call it, and nothing is saved', async () => {
  const plan = {}
  const h = harness({
    plan,
    turns: [async (acc) => {
      acc.toolCalls = [
        call('x1', 'update_plan', '{"steps": []}'),
        planCall('x2', [S('a', 'started')]),
        call('x3', 'update_plan', 'nope'),
      ]
    }],
  })
  await h.done
  eq(plan.steps, undefined, 'saved anyway')
  for (const r of h.toolResults) assert(/^Error: .*update_plan takes \{"steps"/.test(r.content), r.content)
  eq(h.calls.filter((c) => c.startsWith('plan-invalid:')), ['plan-invalid:x1', 'plan-invalid:x2', 'plan-invalid:x3'], 'invalid hook')
})

await test('a save that throws becomes an error result and the flow goes on', async () => {
  const h = harness({
    plan: { save: async () => { throw new Error('disk full') } },
    turns: [async (acc) => { acc.toolCalls = [planCall('p1', [S('a', 'done')])] }],
  })
  await h.done
  eq(h.toolResults[0].content, 'Error: the plan could not be saved: disk full', 'result')
  eq(count(h.calls, 'streamTurn'), 2, 'the flow went on')
})

await test('while steps are open, each request ends with the plan note; the history never gets it', async () => {
  const plan = { steps: [S('read', 'done'), S('write', 'in_progress'), S('check', 'pending')], completionCheck: false }
  const h = harness({ plan, turns: [async (acc) => { acc.toolCalls = [call('a')] }] })
  await h.done
  for (const i of [0, 1]) {
    const m = lastSent(h, i)
    eq(m.role, 'user', `request ${i}: the note's role`)
    assert(m.content.startsWith('[Automatic note, not from the user] Current plan'), m.content)
    assert(m.content.includes('1. [x] read\n2. [>] write\n3. [ ] check'), m.content)
  }
  assert(!h.messages.some((m) => typeof m.content === 'string' && m.content.includes('Current plan')), 'the note entered the history')
  // The request before the note is the history as it was, so the cached prefix holds.
  eq(h.sentMessages[1].slice(0, -1), h.messages.slice(0, h.sentMessages[1].length - 1), 'prefix unchanged')
})

await test('no note with no plan, or once every step is done or skipped', async () => {
  const none = harness({ plan: {} })
  await none.done
  eq(lastSent(none, 0), { role: 'user', content: 'hello' }, 'no plan')
  const finished = harness({ plan: { steps: [S('a', 'done'), S('b', 'skipped', 'not needed')] } })
  await finished.done
  eq(lastSent(finished, 0), { role: 'user', content: 'hello' }, 'all done')
  eq(count(finished.calls, 'streamTurn'), 1, 'no nudge with nothing open')
})

await test('the completion check: an answer with steps open gets one more turn, saved first, with the nudge at the tail', async () => {
  const plan = { steps: [S('read', 'done'), S('write', 'pending')] }
  const h = harness({
    plan,
    turns: [
      async (acc) => { acc.content = 'Here is what I found.' },
      async (acc) => { acc.toolCalls = [planCall('p1', [S('read', 'done'), S('write', 'done')])] },
      async (acc) => { acc.content = 'Written.' },
    ],
  })
  await h.done
  eq(count(h.calls, 'streamTurn'), 3, 'turns')
  eq(h.saved.map((s) => s.content), ['Here is what I found.', '', 'Written.'], 'every turn saved, the first before the nudge')
  const nudge = lastSent(h, 1)
  assert(nudge.content.startsWith('[Automatic note, not from the user] These steps are still open:\n- write\n'), nudge.content)
  eq(h.sentMessages[1].at(-2), { role: 'assistant', content: 'Here is what I found.' }, 'the answer is in the history before the nudge')
  eq(count(h.calls, 'onFlowComplete'), 1, 'completed once')
  eq(count(h.calls, 'createAssistantMessage'), 2, 'a new assistant message for each later turn')
})

await test('the completion check fires once per flow, never again', async () => {
  const plan = { steps: [S('write', 'pending')] }
  const h = harness({ plan, turns: [async (acc) => { acc.content = 'first' }, async (acc) => { acc.content = 'still not done' }] })
  await h.done
  eq(count(h.calls, 'streamTurn'), 2, 'one nudge, then the answer stands')
  eq(h.saved.at(-1).content, 'still not done', 'final answer')
  eq(count(h.calls, 'onFlowComplete'), 1, 'completed once')
})

await test('completionCheck: false keeps the note but never nudges', async () => {
  const h = harness({ plan: { steps: [S('write', 'pending')], completionCheck: false } })
  await h.done
  eq(count(h.calls, 'streamTurn'), 1, 'no nudge')
  assert(lastSent(h, 0).content.includes('Current plan'), 'the note is still sent')
})

await test('with no plan port, update_plan is an ordinary call (gate, then executor)', async () => {
  const h = harness({ turns: [async (acc) => { acc.toolCalls = [planCall('p1', [S('a', 'pending')])] }] })
  await h.done
  assert(h.calls.includes('approve:p1') && h.calls.includes('execute:p1'), `${h.calls}`)
})

await test('plan argument checks and result wording', () => {
  eq(parsePlanArguments('{"steps":[{"text":" a ","status":"done","note":" ok "}]}'), { ok: true, steps: [S('a', 'done', 'ok')] }, 'trimmed')
  eq(parsePlanArguments(JSON.stringify({ steps: Array.from({ length: 21 }, () => S('x', 'pending')) })).ok, false, 'too many steps')
  eq(parsePlanArguments('{"steps":[{"text":"a","status":"done","note":3}]}').ok, false, 'a non-text note')
  eq(formatPlanResult([S('a', 'done'), S('b', 'pending'), S('c', 'in_progress')]), 'Plan saved. Next open step: c.', 'in_progress wins')
  eq(formatPlanResult([S('a', 'done'), S('b', 'skipped')]), 'All steps are done or skipped.', 'all closed')
  eq(planTailNote([S('a', 'done')]), null, 'nothing open, no note')
})

console.log('\n-- the turn limit --')

await test('at the limit the loop asks; "no" completes the flow there', async () => {
  const always = async (acc) => { acc.toolCalls = [call(`c${acc.content.length}`)] }
  const h = harness({ maxTurns: 1, turns: [always, always, always] })
  await h.done
  eq(count(h.calls, 'streamTurn'), 1, 'model turns')
  eq(count(h.calls, 'askContinue'), 1, 'asked once')
  eq(count(h.calls, 'onFlowComplete'), 1, 'onFlowComplete count')
})

await test('"yes" grants a fresh allowance of turns', async () => {
  let answers = [true, false]
  const always = async (acc) => { acc.toolCalls = [call('c')] }
  const h = harness({ maxTurns: 2, askContinue: () => answers.shift(), turns: [always, always, always, always, always] })
  await h.done
  eq(count(h.calls, 'streamTurn'), 4, 'two allowances of two turns')
  eq(count(h.calls, 'askContinue'), 2, 'asked at each limit')
})

console.log('\n-- host hooks --')

await test('attachments: lifted out before storing, reported against the stored message, parts appended', async () => {
  const h = harness({
    turns: [async (acc) => { acc.toolCalls = [call('call_1')] }],
    execute: async () => ({ text: 'chart: data:image/png;base64,AAA', isError: false }),
    extractAttachments: (text) => ({ text: text.replace(/data:\S+/, '[saved]'), attachments: [{ name: 'a.png' }] }),
    extraParts: async (_text, attachments) => attachments.map(() => ({ type: 'image_url', image_url: { url: 'data:x' } })),
  })
  await h.done
  eq(h.toolResults[0].content, 'chart: [saved]', 'stored text')
  eq(h.toolResults[0].extras, [{ name: 'a.png' }], 'stored extras')
  eq(h.toolResults[0].attachedTo, { messageId: 'msg-call_1', extras: [{ name: 'a.png' }] }, 'onAttachments')
  eq(h.sentMessages[1].at(-1).content,
    [{ type: 'text', text: 'chart: [saved]' }, { type: 'image_url', image_url: { url: 'data:x' } }],
    'content parts sent to the model')
})

await test('no attachments: extras are undefined and onAttachments is not called', async () => {
  const h = harness({ turns: [async (acc) => { acc.toolCalls = [call('call_1')] }] })
  await h.done
  eq(h.toolResults[0].extras, undefined, 'extras')
  assert(!h.calls.includes('onAttachments'), 'onAttachments fired with nothing to attach')
})

await test('progress reports the turn and the running call count', async () => {
  const h = harness({ turns: [async (acc) => { acc.toolCalls = [call('a'), call('b')] }] })
  await h.done
  eq(h.progress, [{ currentTurn: 1 }, { totalToolCalls: 2 }, { currentTurn: 2 }], 'patches')
})

await test('calls with missing fields are normalised (id, type, name, arguments)', async () => {
  eq(normalizeToolCalls([{ function: { name: 'x' } }, {}]), [
    { id: 'tool_0', type: 'function', function: { name: 'x', arguments: '' } },
    { id: 'tool_1', type: 'function', function: { name: '', arguments: '' } },
  ], 'normalised')
  eq(normalizeToolCalls(undefined), [], 'undefined → []')
})

await test('buildFinalTimings passes captured timings through when no tool ran, and folds them when one did', async () => {
  const captured = { predicted_n: 3, cache_n: 1 }
  const zero = { turns: 1, toolCallsCount: 0, toolsMs: 0, llm: { predicted_n: 0, predicted_ms: 0, prompt_n: 0, prompt_ms: 0 } }
  assert(buildFinalTimings(captured, zero) === captured, 'not passed through')
  const one = { ...zero, toolCallsCount: 1 }
  eq(buildFinalTimings(captured, one), {
    predicted_n: 3, predicted_ms: undefined, prompt_n: undefined, prompt_ms: undefined, cache_n: 1, agentic: one,
  }, 'folded')
})

console.log('\n-- the fallback parser (a call the model wrote out as text) --')

const parserOn = () => ({ patterns: ['braces', 'xml', 'fn', 'json'], availableTools: [{ name: 'run_python' }] })

await test('a narrated call is recovered and run when the port returns a config', async () => {
  // harness() has no fallbackParser port; this loop has one.
  const calls = []
  const ports = {
    model: { streamTurn: async ({ acc }) => { if (calls.length === 0) acc.content += 'run_python({"code": "1+1"})'; else acc.content += 'two' } },
    tools: { execute: async (c) => { calls.push(c.function); return { text: '2', isError: false } } },
    gate: { approve: async () => true },
    limit: { askContinue: async () => false },
    steering: { pending: () => false },
    fallbackParser: parserOn,
    yield: async () => {},
  }
  await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], maxTurns: 4, ports, callbacks: {} })
  eq(calls, [{ name: 'run_python', arguments: '{"code": "1+1"}' }], 'recovered call')
})

await test('the parser is not asked when the turn already has structured calls, or when it is off', async () => {
  let asked = 0
  const mk = (fallbackParser, structured) => ({
    model: { streamTurn: async ({ acc }) => {
      acc.content += 'run_python{"code": "1"}'
      if (structured) acc.toolCalls = [call('s1', 'other')]
    } },
    tools: { execute: async () => ({ text: 'ok', isError: false }) },
    gate: { approve: async () => true },
    limit: { askContinue: async () => false },
    steering: { pending: () => false },
    fallbackParser,
    yield: async () => {},
  })
  const executed = []
  const p1 = mk(() => { asked++; return parserOn() }, true)
  p1.tools.execute = async (c) => { executed.push(c.function.name); return { text: 'ok', isError: false } }
  await runAgentLoop({ messages: [], maxTurns: 1, ports: p1, callbacks: {} })
  eq(executed, ['other'], 'the structured call runs, the narrated one is ignored')
  eq(asked, 0, 'parser asked despite structured calls')
  const saved = []
  const p2 = mk(() => null, false)
  await runAgentLoop({ messages: [], maxTurns: 4, ports: p2, callbacks: { onAssistantTurnComplete: async (c, r, t, tc) => { saved.push(tc) } } })
  eq(saved, [undefined], 'off: the text stays an answer')
})

await test('the parser only recognises tools the config names', async () => {
  eq(parseToolCallsFromTurn('delete_everything{}', undefined, parserOn()), [], 'unknown tool')
  eq(parseToolCallsFromTurn('ok', 'I will call run_python({"code": "2"})', parserOn()),
    [{ name: 'run_python', arguments: '{"code": "2"}' }], 'from reasoning when the answer has none')
})

console.log('\n-- tool results as text --')

await test('an MCP result becomes the text chat-ui gives the model', async () => {
  eq(formatMcpToolResult({ content: [
    { type: 'text', text: 'done' },
    { type: 'resource_link', uri: '/files/download?path=chats%2Fc1%2Ffig.png', name: 'fig.png', mimeType: 'image/png', size: 41984 },
    { type: 'resource_link', uri: 'https://elsewhere/x', name: 'x' },
    { type: 'image', data: 'AAA' },
  ] }), [
    'done',
    '[file: chats/c1/fig.png, image/png, 41 KB]',
    '[resource: x (https://elsewhere/x)]',
    'data:image/png;base64,AAA',
  ].join('\n'), 'formatted')
  eq(formatMcpToolResult({}), '', 'no content')
})

console.log('\n-- reading a completion stream --')

function sse(events) {
  const body = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}
const chunk = (delta, extra = {}) => ({ choices: [{ delta }], ...extra })

await test('content, reasoning, tool-call deltas and timings land in the accumulator', async () => {
  const acc = createTurnAccumulator(undefined)
  const r = await readChatStream(sse([
    chunk({ reasoning_content: 'think' }, { model: 'm1' }),
    chunk({ content: 'Hi ' }),
    chunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'run_python', arguments: '{"co' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: 'de":1}' } }] }),
    chunk({}, { timings: { predicted_n: 9 } }),
    '[DONE]',
  ]), acc)
  eq([acc.content, acc.reasoning, acc.timings?.predicted_n, acc.captured?.predicted_n], ['Hi ', 'think', 9, 9], 'text and timings')
  eq(acc.toolCalls, [{ function: { name: 'run_python', arguments: '{"code":1}' }, id: 'c1', type: 'function' }], 'merged call')
  eq(r, { finished: true, model: 'm1' }, 'result')
})

await test('content between two tool-call batches starts a new call at index 0', async () => {
  const acc = createTurnAccumulator(undefined)
  await readChatStream(sse([
    chunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'x', arguments: '{}' } }] }),
    chunk({ content: 'and then' }),
    chunk({ tool_calls: [{ index: 0, id: 'b', function: { name: 'y', arguments: '{}' } }] }),
    '[DONE]',
  ]), acc)
  eq(acc.toolCalls.map((c) => c.id), ['a', 'b'], 'two calls, not one overwritten')
})

await test('mergeToolCallDeltas does not modify its input', async () => {
  const before = [{ id: 'a', function: { name: 'x', arguments: '{' } }]
  const snapshot = JSON.stringify(before)
  mergeToolCallDeltas(before, [{ index: 0, function: { arguments: '}' } }])
  eq(JSON.stringify(before), snapshot, 'input unchanged')
})

await test('a non-OK response throws with the status; a stream without [DONE] reports unfinished', async () => {
  let err = null
  try { await readChatStream(new Response('nope', { status: 503 }), createTurnAccumulator(undefined)) } catch (e) { err = e }
  assert(/HTTP 503: nope/.test(err?.message ?? ''), `got ${err?.message}`)
  const r = await readChatStream(sse([chunk({ content: 'cut' })]), createTurnAccumulator(undefined))
  eq(r.finished, false, 'finished')
})

await test('an error event mid-stream throws its message, and the partial answer is kept', async () => {
  // llama-server's real shape, from the 2026-11-11 bench run that scored an
  // empty answer instead of an error.
  const acc = createTurnAccumulator(undefined)
  let err = null
  try {
    await readChatStream(sse([
      chunk({ content: 'Partial ' }),
      { error: { code: 500, message: 'Context size has been exceeded.', type: 'server_error' } },
    ]), acc)
  } catch (e) { err = e }
  eq(err?.message, 'The server stopped this reply: Context size has been exceeded.', 'thrown message')
  eq(acc.content, 'Partial ', 'partial answer kept')
  eq([streamErrorMessage({ choices: [] }), streamErrorMessage({ error: 'boom' })], [null, 'The server stopped this reply: boom'], 'helper shapes')
})

await test('through the loop, a mid-stream error ends the flow with the error, not an empty answer', async () => {
  let completed = null
  let err = null
  try {
    await runAgentLoop({
      messages: [{ role: 'user', content: 'hi' }],
      maxTurns: 3,
      ports: {
        model: { streamTurn: async ({ acc }) => { await readChatStream(sse([{ error: { message: 'Context size has been exceeded.' } }]), acc) } },
        gate: { approve: async () => true },
        tools: { execute: async () => ({ text: '', isError: false }) },
        limit: { askContinue: async () => false },
        steering: { pending: () => false },
      },
      callbacks: { onAssistantTurnComplete: async (content) => { completed = content } },
    })
  } catch (e) { err = e }
  assert(/Context size has been exceeded/.test(err?.message ?? ''), `the flow did not fail: ${err?.message}`)
  eq(completed, '', 'the (empty) partial answer is still stored once')
})

console.log('\n-- tool calls as sent back to the model --')

await test('arguments that are not a JSON object go back as "{}"; good ones and other fields untouched', async () => {
  const good = { id: 'a', type: 'function', function: { name: 't', arguments: '{"x": 1}' } }
  const calls = [
    good,
    { id: 'b', function: { name: 't', arguments: '<parameter=code> 1+1 </parameter>' } },
    { id: 'c', function: { name: 't', arguments: '"just a string"' } },
    { id: 'd', function: { name: 't', arguments: '[1, 2]' } },
    { id: 'e', function: { name: 't', arguments: '' } },
    { id: 'f', function: { name: 't', arguments: '{"x": 1' } },
  ]
  const out = wireSafeToolCalls(calls)
  eq(out.map((c) => c.function.arguments), ['{"x": 1}', '{}', '{}', '{}', '{}', '{}'], 'arguments')
  assert(out[0] === good, 'a good call is passed through by identity')
  eq(calls[1].function.arguments, '<parameter=code> 1+1 </parameter>', 'the input is not modified (the UI keeps what the model wrote)')
  eq(out[1].id, 'b', 'id kept')
  eq(wireSafeToolCalls(undefined), undefined, 'undefined passes through')
})

console.log('\n-- the attachment note --')

const offered = (...names) => (n) => names.includes(n)

await test('the note says how each offered tool reaches the files', async () => {
  const note = attachmentNote({
    saved: ['sales.csv', 'notes.txt'],
    conversationId: 'abc123',
    hasTool: offered('run_python', 'read_document', 'read_text_file', 'list_directory', 'move_file', 'write_file'),
  })
  eq(note, [
    "[Attached files saved to this chat's workspace: sales.csv, notes.txt",
    '- run_python runs in that folder: open them by name, e.g. open("sales.csv"), not open("chats/abc123/sales.csv"). To rename, move or delete them, use run_python (os.rename, os.remove).',
    '- read_document opens them by name too: read_document("sales.csv").',
    '- The File System tools (read_text_file, list_directory, move_file, ...) work on a different folder and cannot see these files.]',
  ].join('\n'), 'full note')
})

await test('tools that are not offered are not named', async () => {
  const note = attachmentNote({ saved: ['a.csv'], conversationId: 'c', hasTool: offered('run_python') })
  eq(note, "[Attached file saved to this chat's workspace: a.csv\n- run_python runs in that folder: open it by name, e.g. open(\"a.csv\"), not open(\"chats/c/a.csv\"). To rename, move or delete it, use run_python (os.rename, os.remove).]", 'run_python only')
  assert(!/read_document|File System/.test(note), 'named a tool that is not offered')
  eq(attachmentNote({ saved: ['a.csv'], conversationId: 'c', hasTool: () => false }), "[Attached file saved to this chat's workspace: a.csv]", 'no tools: the bare line')
})

await test('failed uploads are reported, and nothing at all is null', async () => {
  eq(attachmentNote({ saved: [], failed: ['big.bin (too large)'], conversationId: 'c', hasTool: () => true }),
    "[Could not save to this chat's workspace: big.bin (too large)]", 'failure only')
  eq(attachmentNote({ saved: [], conversationId: 'c', hasTool: () => true }), null, 'nothing to say')
  const both = attachmentNote({ saved: ['a.csv'], failed: ['b.csv (quota)'], conversationId: 'c', hasTool: () => false })
  eq(both.split('\n'), ["[Attached file saved to this chat's workspace: a.csv]", "[Could not save to this chat's workspace: b.csv (quota)]"], 'saved then failed')
})

console.log('\n-- the core is host-agnostic --')

await test('the core imports only its own files: no Svelte, no DOM, no node: built-ins', async () => {
  const files = fs.readdirSync(coreDir).filter((f) => f.endsWith('.mjs'))
  assert(files.length >= 6, `expected loop, tool-calls, timings, tool-call-parser, tool-result, chat-stream; found ${files}`)
  for (const f of files) {
    const src = fs.readFileSync(path.join(coreDir, f), 'utf8')
    const specs = [...src.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2])
    for (const s of specs) assert(s.startsWith('./'), `${f} imports ${s}`)
    for (const g of ['window.', 'document.', 'localStorage', 'process.', 'require(']) {
      assert(!src.includes(g), `${f} uses ${g}, which not every host has`)
    }
  }
  return `${files.length} files`
})

const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed\n`)
if (passed !== results.length) process.exit(1)
