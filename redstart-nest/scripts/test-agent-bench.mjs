// =============================================================================
// The agent benchmark harness, against a fake Nest with a scripted model
// =============================================================================
// Agent-runtime plan Phase 0.2. The real benchmark needs a GPU and a loaded
// model and is run by hand. This suite tests everything around the model, so
// a number in docs/notes/agent-bench-results.md can be trusted to mean what
// it says:
//
//   - the harness drives a Nest only through client routes: a conversation
//     per run, fixtures uploaded into ITS workspace, tools/call carrying ITS
//     id in _meta, the API key on every request, the conversation deleted after
//   - the model receives the tool list and every tool result, and the final
//     answer reaches the check
//   - approval policy: a write under `approve: "reads"` is denied and counted
//   - metrics: invalid arguments, retries, turns, tokens, both limits
//   - the fallback parser recovers a narrated call, as chat-ui's would
//   - a check that throws, or a missing check, fails the run instead of the
//     whole bench
//   - task-file validation fails loudly before any run
//   - the output files (runs.jsonl, summary.json, summary.md)
//
// The fake Nest is in-process: a gateway on a free port, MCP on port + 2 as
// in the real daemon. Its "model" picks a script from a [script:<name>]
// marker in the prompt.
//
// Run:  node scripts/test-agent-bench.mjs
// =============================================================================

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main, parseArgs, labelWarning, fallbackWarning } from './agent-bench/run.mjs'
import { approves } from './agent-bench/lib/bench.mjs'
import { argumentProblem, computeMetrics } from './agent-bench/lib/metrics.mjs'
import { findTaskFiles, loadTask } from './agent-bench/lib/task-file.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(here, 'fixtures', 'agent-bench')
const API_KEY = 'rsk_bench_test_key'
const FAKE_TEMPLATE = '{% for m in messages %}<|im_start|>{{ m.role }}{% endfor %}'

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

// ---------------------------------------------------------------------------
// The fake Nest
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file from the conversation workspace.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    _meta: { 'redstart/class': 'read' },
  },
  {
    name: 'make_doc',
    description: 'Create a document in the documents root (like create_document).',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' } }, required: ['title', 'content'] },
    _meta: { 'redstart/class': 'write' },
  },
  {
    name: 'write_file',
    description: 'Write a file into the conversation workspace.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    _meta: { 'redstart/class': 'write' },
  },
]

const chunk = (delta, extra = {}) => ({ choices: [{ index: 0, delta }], ...extra })
const toolCallChunk = (id, name, args) => chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] })
const lastToolResult = (messages) => [...messages].reverse().find((m) => m.role === 'tool')?.content ?? ''

/** turn index (0-based), messages → SSE chunk list, or 'hang'. */
const SCRIPTS = {
  write: (turn) => (turn === 0
    ? [toolCallChunk('c1', 'write_file', JSON.stringify({ path: 'out/answer.txt', content: '42' }))]
    : [chunk({ content: 'Done.' })]),
  read: (turn, messages) => (turn === 0
    ? [chunk({ content: 'Let me look. ' }), toolCallChunk('c1', 'read_file', '{"path": "data.txt"}')]
    : [chunk({ content: `The secret is ${/secret: (\d+)/.exec(lastToolResult(messages))?.[1] ?? 'unknown'}.` })]),
  badargs: (turn, messages) => {
    if (turn === 0) return [toolCallChunk('c1', 'read_file', '{"path": "data.txt"')] // truncated JSON
    if (turn === 1) return [toolCallChunk('c2', 'read_file', '{"file": "data.txt"}')] // wrong key: schema-invalid
    if (turn === 2) return [toolCallChunk('c3', 'read_file', '{"path": "data.txt"}')]
    return [chunk({ content: `It says ${/secret: (\d+)/.exec(lastToolResult(messages))?.[1]}.` })]
  },
  narrated: (turn, messages) => (turn === 0
    ? [chunk({ content: 'Calling read_file({"path": "data.txt"}) now.' })]
    : [chunk({ content: `Found ${/secret: (\d+)/.exec(lastToolResult(messages))?.[1]}.` })]),
  makedoc: (turn) => (turn === 0
    ? [toolCallChunk('c1', 'make_doc', JSON.stringify({ title: 'brief', content: '# Brief\n\nShort.' }))]
    : [chunk({ content: 'Saved the brief.' })]),
  forever: () => [toolCallChunk(`c${Math.random().toString(36).slice(2, 8)}`, 'read_file', '{"path": "data.txt"}')],
  hang: () => 'hang',
}

async function freePortPair() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await new Promise((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
    })
    const plus2Free = await new Promise((resolve) => {
      const s = net.createServer().once('error', () => resolve(false)).listen(port + 2, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (plus2Free) return port
  }
  throw new Error('no free port pair')
}

async function readBody(req) {
  const parts = []
  for await (const c of req) parts.push(c)
  return Buffer.concat(parts)
}

function startFakeNest(gatewayPort) {
  const state = {
    files: new Map(), // 'chats/<id>/<path>' -> Buffer
    conversations: new Set(),
    deleted: [],
    docDeletes: [],
    authSeen: new Set(),
    completionBodies: [],
    toolCalls: [],
  }
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(body === undefined ? '' : JSON.stringify(body))
  }
  const authed = (req) => {
    state.authSeen.add(req.headers.authorization ?? '(none)')
    return req.headers.authorization === `Bearer ${API_KEY}`
  }

  const gateway = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    if (!authed(req)) return json(res, 401, { error: { message: 'Unauthorized' } })

    if (req.method === 'POST' && url.pathname === '/conversations') {
      const body = JSON.parse((await readBody(req)).toString())
      state.conversations.add(body.id)
      return json(res, 201, { id: body.id, name: body.name })
    }
    const del = /^\/conversations\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'DELETE' && del) {
      state.conversations.delete(decodeURIComponent(del[1]))
      state.deleted.push(decodeURIComponent(del[1]))
      for (const k of [...state.files.keys()]) if (k.startsWith(`chats/${decodeURIComponent(del[1])}/`)) state.files.delete(k)
      return json(res, 204)
    }
    if (req.method === 'POST' && url.pathname === '/files/mkdir') {
      await readBody(req)
      return json(res, 201, {})
    }
    if (req.method === 'POST' && url.pathname === '/files/upload') {
      assert(url.searchParams.get('space') === 'documents', 'upload space')
      const key = `${url.searchParams.get('path')}/${url.searchParams.get('name')}`
      state.files.set(key, await readBody(req))
      return json(res, 201, {})
    }
    if (req.method === 'POST' && url.pathname === '/files/delete') {
      const body = JSON.parse((await readBody(req)).toString())
      state.docDeletes.push(body)
      state.files.delete(body.path)
      return json(res, 200, {})
    }
    if (req.method === 'GET' && url.pathname === '/files/list') {
      const dir = url.searchParams.get('path')
      const entries = new Map()
      for (const [k, v] of state.files) {
        if (!k.startsWith(`${dir}/`)) continue
        const rest = k.slice(dir.length + 1)
        const first = rest.split('/')[0]
        if (rest.includes('/')) entries.set(first, { name: first, path: `${dir}/${first}`, type: 'folder', size: null })
        else entries.set(first, { name: first, path: k, type: 'file', size: v.length })
      }
      return json(res, 200, { space: 'documents', path: dir, entries: [...entries.values()] })
    }
    if (req.method === 'GET' && url.pathname === '/files/download') {
      const buf = state.files.get(url.searchParams.get('path'))
      if (!buf) return json(res, 404, {})
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      return res.end(buf)
    }
    // llama-server's /props, passed through by the gateway. Fields as
    // chat-ui's api.d.ts types them.
    if (req.method === 'GET' && url.pathname === '/props') {
      return json(res, 200, { model_path: 'C:\\models\\fake-model.gguf', chat_template: FAKE_TEMPLATE })
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const body = JSON.parse((await readBody(req)).toString())
      state.completionBodies.push(body)
      // As llama-server does (common/chat.cpp, func_args_not_string): every
      // earlier tool call's arguments must parse, or the whole request fails.
      for (const m of body.messages) {
        for (const tc of m.tool_calls ?? []) {
          try { JSON.parse(tc.function.arguments) } catch (e) {
            return json(res, 500, { error: { code: 500, message: `Failed to parse tool call arguments as JSON: ${e.message}`, type: 'server_error' } })
          }
        }
      }
      const prompt = body.messages.find((m) => m.role === 'user')?.content ?? ''
      const scriptName = /\[script:(\w+)\]/.exec(prompt)?.[1]
      // The turn is how many assistant messages the request already carries:
      // stateless, so two tasks with the same prompt cannot share a counter.
      const turn = body.messages.filter((m) => m.role === 'assistant').length
      const out = SCRIPTS[scriptName](turn, body.messages)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (out === 'hang') {
        res.write(`data: ${JSON.stringify(chunk({ reasoning_content: 'hmm' }))}\n\n`)
        req.on('close', () => res.end())
        return
      }
      for (const c of out) res.write(`data: ${JSON.stringify(c)}\n\n`)
      res.write(`data: ${JSON.stringify(chunk({}, { timings: { prompt_n: 100, predicted_n: 10 } }))}\n\n`)
      res.write('data: [DONE]\n\n')
      return res.end()
    }
    json(res, 404, { error: { message: `fake nest: no route ${req.method} ${url.pathname}` } })
  })

  const mcp = http.createServer(async (req, res) => {
    if (!authed(req)) return json(res, 401, {})
    const msg = JSON.parse((await readBody(req)).toString())
    const reply = (result) => json(res, 200, { jsonrpc: '2.0', id: msg.id, result })
    if (msg.method === 'initialize') return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} } })
    if (msg.method === 'tools/list') return reply({ tools: TOOLS })
    if (msg.method === 'tools/call') {
      const { name, arguments: args, _meta } = msg.params
      const conv = _meta?.['redstart/conversationId']
      state.toolCalls.push({ name, args, conv })
      if (!state.conversations.has(conv)) return reply({ isError: true, content: [{ type: 'text', text: 'unknown conversation' }] })
      if (name === 'read_file') {
        if (typeof args.path !== 'string') return reply({ isError: true, content: [{ type: 'text', text: 'path is required' }] })
        const buf = state.files.get(`chats/${conv}/${args.path}`)
        return buf
          ? reply({ content: [{ type: 'text', text: buf.toString() }] })
          : reply({ isError: true, content: [{ type: 'text', text: `No such file: ${args.path}` }] })
      }
      if (name === 'make_doc') {
        const rel = `notes/${args.title}.md`
        state.files.set(rel, Buffer.from(args.content))
        return reply({ content: [
          { type: 'text', text: `[FILE: ${rel}]
Created "${rel}" in the documents folder.` },
          { type: 'resource_link', uri: `/files/download?path=${encodeURIComponent(rel)}`, name: rel, mimeType: 'text/markdown', size: args.content.length },
        ] })
      }
      if (name === 'write_file') {
        state.files.set(`chats/${conv}/${args.path}`, Buffer.from(args.content))
        return reply({ content: [{ type: 'resource_link', uri: `/files/download?path=${encodeURIComponent(`chats/${conv}/${args.path}`)}`, name: args.path, mimeType: 'text/plain', size: args.content.length }] })
      }
    }
    json(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no such method' } })
  })

  return new Promise((resolve) => {
    gateway.listen(gatewayPort, '127.0.0.1', () => mcp.listen(gatewayPort + 2, '127.0.0.1', () => resolve({
      state,
      close: async () => {
        gateway.closeAllConnections(); mcp.closeAllConnections()
        await Promise.all([new Promise((r) => gateway.close(r)), new Promise((r) => mcp.close(r))])
      },
    })))
  })
}

// ---------------------------------------------------------------------------

console.log('\n-- pure parts --')

await test('argument problems: bad JSON, missing required, wrong type, unknown key, fine', async () => {
  const schema = { type: 'object', properties: { path: { type: 'string' }, n: { type: 'number' } }, required: ['path'], additionalProperties: false }
  eq(argumentProblem('{"path": ', schema), 'arguments are not valid JSON', 'bad JSON')
  eq(argumentProblem('{}', schema), 'missing required "path"', 'missing')
  eq(argumentProblem('{"path": 3}', schema), '"path" should be string, got integer', 'type')
  eq(argumentProblem('{"path": "a", "n": 2}', schema), null, 'integer counts as number')
  eq(argumentProblem('{"path": "a", "x": 1}', schema), 'unknown key "x"', 'unknown key')
  eq(argumentProblem('[1]', schema), 'arguments are not an object', 'array')
  eq(argumentProblem('', { type: 'object', properties: {} }), null, 'empty means {}')
})

await test('approval policy: all, reads, a named list', async () => {
  eq([approves('all', 'w', 'write'), approves('reads', 'r', 'read'), approves('reads', 'w', 'write'),
    approves(['w'], 'w', 'write'), approves(['w'], 'x', 'read')], [true, true, false, true, false], 'decisions')
})

await test('retries count a call to a tool whose previous call errored', async () => {
  const ev = (type, name, isError) => ({ t: 0, type, name, isError })
  const m = computeMetrics([
    { t: 0, type: 'start' },
    ev('tool_call', 'a'), ev('tool_result', 'a', true),
    ev('tool_call', 'b'), ev('tool_result', 'b', false),
    ev('tool_call', 'a'), ev('tool_result', 'a', false),
    ev('tool_call', 'a'), ev('tool_result', 'a', false),
    { t: 5, type: 'end' },
  ], { pass: true })
  eq([m.toolCalls, m.toolErrors, m.retries, m.wallMs], [4, 1, 1, 5], 'calls, errors, retries, wall')
})

await test('a task file with a problem fails at load, naming the file and the field', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bench-'))
  try {
    const cases = [
      [{ prompt: 'x', check: 'c.mjs#f' }, /id must match/],
      [{ id: 'a', check: 'c.mjs#f' }, /prompt is required/],
      [{ id: 'a', prompt: 'x', fixtures: [{ path: '../up.txt', content: '' }], check: 'c.mjs#f' }, /must not contain/],
      [{ id: 'a', prompt: 'x', fixtures: [{ path: 'a.txt' }], check: 'c.mjs#f' }, /exactly one of content or from/],
      [{ id: 'a', prompt: 'x', approve: 'writes', check: 'c.mjs#f' }, /approve must be/],
      [{ id: 'a', prompt: 'x', limits: { maxTurns: 0 }, check: 'c.mjs#f' }, /limits.maxTurns/],
      [{ id: 'a', prompt: 'x', check: 'c.mjs#nope' }, /does not name an exported function/],
    ]
    fs.writeFileSync(path.join(dir, 'c.mjs'), 'export const f = () => ({ pass: true })\n')
    for (const [body, re] of cases) {
      const f = path.join(dir, 't.json')
      fs.writeFileSync(f, JSON.stringify(body))
      let err = null
      try { await loadTask(f) } catch (e) { err = e }
      assert(err && re.test(err.message) && err.message.includes('t.json'), `expected ${re}, got ${err?.message}`)
    }
    return `${cases.length} cases`
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await test('task patterns: a folder, a glob, a single file', async () => {
  eq(findTaskFiles(FIXTURES).map((f) => path.basename(f)).length, 8, 'folder')
  eq(findTaskFiles(path.join(FIXTURES, '*-limit.json')).map((f) => path.basename(f)), ['time-limit.json', 'turn-limit.json'], 'glob')
  eq(findTaskFiles(path.join(FIXTURES, 'denied.json')).length, 1, 'file')
})

await test('a label that does not name the loaded file is warned about', async () => {
  // The 2026-11-11 case: labelled Q4_K_M, the file was UD-Q4_K_XL.
  assert(labelWarning('Qwen3-4B-Instruct-2507-Q4_K_M', 'Qwen3-4B-Instruct-2507-UD-Q4_K_XL.gguf'), 'wrong quant not flagged')
  eq(labelWarning('Qwen3-4B-Instruct-2507-UD-Q4_K_XL, embedded template', 'Qwen3-4B-Instruct-2507-UD-Q4_K_XL.gguf'), null, 'label containing the file name')
  eq(labelWarning('anything', null), null, 'no /props, no warning')
})

await test('a high fallback rate is warned about, with where to look', async () => {
  assert(/chat template/.test(fallbackWarning({ fallbackRate: 0.69 }) ?? ''), '69% not flagged')
  eq([fallbackWarning({ fallbackRate: 0 }), fallbackWarning({ fallbackRate: 0.2 }), fallbackWarning({ fallbackRate: null })], [null, null, null], 'at or under the threshold')
})

await test('arguments: --model-label required, MCP defaults to the gateway port + 2', async () => {
  let err = null
  try { parseArgs([]) } catch (e) { err = e }
  assert(/--model-label is required/.test(err?.message ?? ''), 'no label accepted')
  eq(parseArgs(['--model-label', 'm', '--gateway', 'http://127.0.0.1:19080']).mcp, 'http://127.0.0.1:19082', 'mcp default')
})

console.log('\n-- the harness against a fake Nest --')

const port = await freePortPair()
const nest = await startFakeNest(port)
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bench-out-'))
process.env.REDSTART_BENCH_API_KEY = API_KEY
const logged = []
let bench
try {
  bench = await main(['--model-label', 'fake model', '--tasks', FIXTURES, '--gateway', `http://127.0.0.1:${port}`, '--out', outDir, '--quiet'],
    { log: (s) => logged.push(s) })
} catch (err) {
  console.log(`FAIL  - the bench ran\n        ${err.stack}`)
  results.push({ name: 'the bench ran', pass: false })
}

const run = (id) => bench.runs.find((r) => r.taskId === id)

if (bench) {
  await test('every request carried the API key, and only that', async () => {
    eq([...nest.state.authSeen], [`Bearer ${API_KEY}`], 'authorization headers seen')
  })

  await test('each run had its own conversation, deleted afterwards', async () => {
    const ids = bench.runs.map((r) => r.conversationId)
    eq(new Set(ids).size, bench.runs.length, 'distinct conversations')
    eq([...nest.state.deleted].sort(), [...ids].sort(), 'all deleted')
    eq(nest.state.conversations.size, 0, 'none left')
  })

  await test('fixtures were seeded into that conversation\'s workspace, nested paths included', async () => {
    const r = run('read-fixture')
    eq(r.workspaceFiles, ['data.txt', 'nested/inline.txt'], 'workspace after the run')
  })

  await test('tools/call carried the run\'s conversation id', async () => {
    const convs = new Set(bench.runs.map((r) => r.conversationId))
    assert(nest.state.toolCalls.length > 0, 'no tool calls reached MCP')
    for (const c of nest.state.toolCalls) assert(convs.has(c.conv), `tools/call with conversation ${c.conv}`)
  })

  await test('the model got the tool list and its tool results; thinking off, streaming on', async () => {
    const body = nest.state.completionBodies.find((b) => b.messages.some((m) => m.role === 'tool'))
    eq(body.tools.map((t) => t.function.name), ['read_file', 'make_doc', 'write_file'], 'tools')
    eq([body.stream, body.chat_template_kwargs.enable_thinking, body.reasoning_format], [true, false, 'auto'], 'flags')
    const asst = body.messages.find((m) => m.role === 'assistant' && m.tool_calls)
    assert(asst && body.messages.some((m) => m.role === 'tool' && m.tool_call_id === asst.tool_calls[0].id), 'tool result paired with its call')
  })

  await test("fixtures are announced with chat-ui's attachment note; no note without fixtures", async () => {
    const withFx = nest.state.completionBodies.find((b) => b.messages[0].content.startsWith('[script:read]'))
    eq(withFx.messages[0].content,
      // The core's note, for the tools this fake offers (read_file and
      // write_file are File System names; no run_python, no read_document).
      "[script:read] What is the secret in data.txt?\n\n[Attached files saved to this chat's workspace: data.txt, nested/inline.txt\n- The File System tools (read_file, write_file) work on a different folder and cannot see these files.]",
      'user message')
    const without = nest.state.completionBodies.find((b) => b.messages[0].content.startsWith('[script:write]'))
    eq(without.messages[0].content, '[script:write] Put 42 in out/answer.txt.', 'no note')
  })

  await test('a file made outside the workspace reaches the check through ctx, then is deleted', async () => {
    const r = run('created-doc')
    eq([r.verdict.pass, r.createdFiles], [true, ['notes/brief.md']], 'pass, created')
    eq(nest.state.docDeletes, [{ space: 'documents', path: 'notes/brief.md' }], 'deleted once, in the documents space')
    assert(!nest.state.files.has('notes/brief.md'), 'still there')
  })

  await test('a write task passes: the file is in the workspace and the check saw it', async () => {
    const r = run('write-answer')
    eq([r.verdict.pass, r.metrics.toolCalls, r.metrics.toolErrors, r.metrics.turns], [true, 1, 0, 2], 'pass, calls, errors, turns')
    eq(r.workspaceFiles, ['out/answer.txt'], 'workspace')
  })

  await test('a resource_link result reaches the model as chat-ui\'s [file: ...] line', async () => {
    const r = run('write-answer')
    const result = r.events.find((e) => e.type === 'tool_result')
    assert(/^\[file: chats\/bench-write-answer-[0-9a-f]+\/out\/answer\.txt, text\/plain, 2 B\]$/.test(result.text), result.text)
  })

  await test('a read task passes on the final answer text', async () => {
    const r = run('read-fixture')
    eq([r.verdict.pass, r.finalText], [true, 'The secret is 7.'], 'pass and answer')
  })

  await test('approve "reads" denies a write; the denial is a failed call and the task fails', async () => {
    const r = run('denied')
    eq([r.verdict.pass, r.metrics.toolCalls, r.metrics.toolErrors], [false, 1, 1], 'fail, 1 call, 1 error')
    assert(!nest.state.toolCalls.some((c) => c.conv === r.conversationId), 'a denied call reached MCP')
    assert(r.events.some((e) => e.type === 'tool_result' && e.denied), 'denial not in the log')
  })

  await test('bad arguments: two invalid calls, two retries, then success', async () => {
    const r = run('bad-args')
    eq([r.verdict.pass, r.metrics.toolCalls, r.metrics.invalidArgs, r.metrics.retries, r.metrics.toolErrors],
      [true, 3, 2, 2, 2], 'pass, calls, invalid, retries, errors')
    const first = r.events.find((e) => e.type === 'tool_result')
    assert(/^Error: Failed to parse tool arguments as JSON/.test(first.text), `chat-ui's message, got ${first.text}`)
  })

  await test('a narrated call is recovered by the fallback parser and run', async () => {
    const r = run('narrated')
    eq([r.verdict.pass, r.metrics.toolCalls, r.metrics.fallbackCalls], [true, 1, 1], 'pass, calls, fallback calls')
    eq(run('read-fixture').metrics.fallbackCalls, 0, 'a structured call is not counted as fallback')
  })

  await test('the summary records the loaded model file and template hash, and the fallback rate', async () => {
    const { meta, summary } = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'))
    eq(meta.model.modelFile, 'fake-model.gguf', 'model file from /props, not the label')
    eq(meta.model.chatTemplateSha, crypto.createHash('sha256').update(FAKE_TEMPLATE).digest('hex').slice(0, 12), 'template hash')
    eq(meta.warnings, [], 'label names the file, and fallback is under the threshold')
    const totalCalls = bench.runs.reduce((a, r) => a + r.metrics.toolCalls, 0)
    eq(summary.fallbackRate, 1 / totalCalls, 'one fallback call over all calls')
    const md = fs.readFileSync(path.join(outDir, 'summary.md'), 'utf8')
    assert(md.includes('| invalid args | fallback |') && md.includes('Model file: fake-model.gguf'), 'summary.md columns and model line')
  })

  await test('the turn limit ends the run and is recorded', async () => {
    const r = run('turn-limit')
    eq([r.metrics.hitLimit, r.metrics.turns, r.verdict.pass], ['turns', 2, false], 'limit, turns, pass')
  })

  await test('the time limit aborts a hung stream and is recorded; a throwing check fails only its run', async () => {
    const r = run('time-limit')
    eq(r.metrics.hitLimit, 'seconds', 'limit')
    eq([r.verdict.pass, r.verdict.reason], [false, 'check threw: check exploded'], 'verdict')
    assert(r.metrics.wallMs >= 900 && r.metrics.wallMs < 10000, `wall ${r.metrics.wallMs}`)
  })

  await test('tokens are summed from the turns\' timings', async () => {
    const r = run('write-answer')
    eq([r.metrics.promptTokens, r.metrics.predictedTokens], [200, 20], 'two turns of 100/10')
  })

  await test('summary: pass rate and per-task passes', async () => {
    const s = bench.summary
    eq([s.runs, s.tasks.reduce((a, t) => a + t.passes, 0)], [8, 5], 'runs, passes')
    eq(s.passRate, 5 / 8, 'pass rate')
    eq(s.hitLimitRuns, 2, 'limit runs')
  })

  await test('output files: runs.jsonl (one line per run), summary.json, summary.md with the results row', async () => {
    const lines = fs.readFileSync(path.join(outDir, 'runs.jsonl'), 'utf8').trim().split('\n')
    eq(lines.length, 8, 'runs.jsonl lines')
    assert(JSON.parse(lines[0]).events.length > 0, 'events saved')
    const sj = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'))
    eq([sj.meta.modelLabel, sj.meta.toolCount, sj.meta.tools], ['fake model', 3, ['read_file', 'make_doc', 'write_file']], 'meta')
    const md = fs.readFileSync(path.join(outDir, 'summary.md'), 'utf8')
    assert(/\| \d{4}-\d{2}-\d{2} \| fake model \| [0-9a-f]+(\+dirty)? \| 8×1 \| 63% \|/.test(md), md)
  })
}

console.log('\n-- first-run failures say what to fix --')

await test('a wrong API key: the error names the key and where to get a real one', async () => {
  process.env.REDSTART_BENCH_API_KEY = '<bench account API key>'
  let err = null
  try {
    await main(['--model-label', 'm', '--tasks', path.join(FIXTURES, 'write-answer.json'), '--gateway', `http://127.0.0.1:${port}`, '--out', outDir, '--quiet'], { log: () => {} })
  } catch (e) { err = e }
  process.env.REDSTART_BENCH_API_KEY = API_KEY
  assert(/rejected the API key \(HTTP 401\)/.test(err?.message ?? '') && /Generate key/.test(err.message), `got ${err?.message}`)
})

await nest.close()

await test('nothing listening: the error says Nest is not reachable and why that usually is', async () => {
  let err = null
  try {
    await main(['--model-label', 'm', '--tasks', path.join(FIXTURES, 'write-answer.json'), '--gateway', `http://127.0.0.1:${port}`, '--out', outDir, '--quiet'], { log: () => {} })
  } catch (e) { err = e }
  assert(/could not reach Nest at/.test(err?.message ?? '') && /model loaded/.test(err.message), `got ${err?.message}`)
})

fs.rmSync(outDir, { recursive: true, force: true })

const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed\n`)
if (passed !== results.length) process.exit(1)
