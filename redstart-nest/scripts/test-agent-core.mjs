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
// and that the core imports nothing a host would have to provide.
//
// Run:  node scripts/test-agent-core.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAgentLoop } from '../../shared/agent-core/loop.mjs'
import { buildFinalTimings } from '../../shared/agent-core/timings.mjs'
import {
  DENIED_RESULT,
  INTERRUPTED_RESULT,
  normalizeToolCalls,
} from '../../shared/agent-core/tool-calls.mjs'

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

console.log('\n-- the core is host-agnostic --')

await test('the core imports only its own files: no Svelte, no DOM, no node: built-ins', async () => {
  const files = fs.readdirSync(coreDir).filter((f) => f.endsWith('.mjs'))
  assert(files.length >= 3, `expected loop, tool-calls, timings; found ${files}`)
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
