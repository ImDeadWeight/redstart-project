// =============================================================================
// Invariant tests for daemon/tool-retrieval.mjs
// =============================================================================
// What this suite exists to catch, since master plan 3.3 left retrieval as
// the catalog (a fixed list, the deferred tools behind search_tools and
// call_tool):
//
//  1. search_tools searches the POST-POLICY catalog only, so a ban cannot be
//     walked around by describing the tool, and never returns a discovery
//     tool.
//  2. call_tool goes through the policy-checked caller and makes it enforce
//     every approval but a read's (U-S6).
//  3. Nothing here throws, and the embedder fails open. A degenerate vector
//     scores 0; it does not produce a NaN that poisons a sort.
//
// Per-turn selection's tests (subset, name order, pins, families, budget,
// floors, growth, withhold, the selection memory) went with it.
//
// Run:  node scripts/test-tool-retrieval.mjs
// =============================================================================

import {
  toolName,
  toolContentHash,
  toolEmbeddingText,
  estimateToolTokens,
  createVectorStore,
  cosine,
  scoreTools,
  truncateForEmbedding,
  CHARS_PER_TOKEN,
  tokenize,
  createBm25Index,
  fuse,
  RRF_K,
} from '../daemon/tool-retrieval.mjs'
import * as searchProvider from '../daemon/search-tools-provider.mjs'
const { retrievalStatus, syncRetrieval, applyToolsConfig, resetRetrievalState } = await import('../daemon/ipc/tools.mjs')
import { EMBED_MODEL } from '../daemon/embed-model.mjs'
import {
  searchTools,
  rankForSearch,
  setEmbedPortForTests,
  retrievalEnabled,
  retrievalConfigSummary,
  RETRIEVAL_DEFAULTS,
} from '../daemon/tool-filter.mjs'
import {
  EMBED_PID_FILE,
  startEmbedServer,
  stopEmbedServer,
  embedServerStatus,
  embedTexts,
  resetEmbedFailureLog,
} from '../daemon/embed-server.mjs'
import { LLAMA_PID_FILE } from '../daemon/process-supervision.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'
import * as http from 'node:http'

// ---------------------------------------------------------------------------
// Harness (mirrors scripts/test-llama-args.mjs)
// ---------------------------------------------------------------------------

const results = []

async function test(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true, detail })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false, detail: err.message })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

// An OpenAI-shaped tool, the shape that actually arrives on the wire.
function fnTool(name, description, parameters = { type: 'object', properties: {} }) {
  return { type: 'function', function: { name, description, parameters } }
}

// The flat MCP shape, which the provider registry uses.
function mcpTool(name, description, inputSchema = { type: 'object', properties: {} }) {
  return { name, description, inputSchema }
}

// A unit vector pointing along one axis of a small space, so similarities are
// exact rather than approximate and the assertions can be equalities.
function axis(dim, i) {
  const v = new Float32Array(dim)
  v[i] = 1
  return v
}

console.log('\n-- content hashing --')

await test('key order in a schema does not change the hash', () => {
  const a = fnTool('read_file', 'Read a file', { type: 'object', properties: { path: { type: 'string' }, encoding: { type: 'string' } } })
  const b = fnTool('read_file', 'Read a file', { properties: { encoding: { type: 'string' }, path: { type: 'string' } }, type: 'object' })
  assert(toolContentHash(a) === toolContentHash(b), 'reordered keys hashed differently')
})

await test('array order in a schema DOES change the hash', () => {
  const a = fnTool('x', 'd', { type: 'object', required: ['a', 'b'] })
  const b = fnTool('x', 'd', { type: 'object', required: ['b', 'a'] })
  assert(toolContentHash(a) !== toolContentHash(b), 'required-order collapsed — array order is content')
})

await test('a description edit changes the hash', () => {
  const before = toolContentHash(fnTool('read_file', 'Read a file'))
  const after = toolContentHash(fnTool('read_file', 'Read a file from disk'))
  assert(before !== after, 'edited description hashed the same — the cache would serve a stale vector')
})

await test('🔍 two tools with identical text from different sources collide on purpose', () => {
  const a = { ...fnTool('search', 'Search the web'), pluginId: 'acme', source: 'plugin' }
  const b = { ...fnTool('search', 'Search the web'), pluginId: 'other', source: 'builtin' }
  assert(toolContentHash(a) === toolContentHash(b), 'source leaked into the fingerprint — one embed should serve both')
})

await test('the OpenAI and MCP shapes of the same tool hash alike', () => {
  const schema = { type: 'object', properties: { q: { type: 'string' } } }
  assert(
    toolContentHash(fnTool('search', 'Search', schema)) === toolContentHash(mcpTool('search', 'Search', schema)),
    'parameters and inputSchema hashed differently for the same tool',
  )
})

await test('a malformed tool hashes rather than throwing', () => {
  for (const junk of [null, undefined, 42, 'tool', {}, { function: null }]) {
    const hash = toolContentHash(junk)
    assert(/^[0-9a-f]{64}$/.test(hash), `junk input ${JSON.stringify(junk)} produced ${hash}`)
  }
})

await test('toolName and toolEmbeddingText read both shapes', () => {
  assert(toolName(fnTool('a', 'b')) === 'a', 'OpenAI shape name lost')
  assert(toolName(mcpTool('a', 'b')) === 'a', 'MCP shape name lost')
  assert(toolEmbeddingText(fnTool('a', 'b')) === 'a: b', `unexpected embed text: ${toolEmbeddingText(fnTool('a', 'b'))}`)
  assert(toolEmbeddingText({ name: 'a' }) === 'a', 'a description-less tool should embed as its bare name')
})

console.log('\n-- the vector store --')

await test('the miss list shrinks to empty after setMany', () => {
  const store = createVectorStore()
  const tools = [fnTool('a', 'alpha'), fnTool('b', 'beta')]
  const missing = store.missingHashes(tools)
  assert(missing.length === 2, `expected 2 misses, got ${missing.length}`)
  assert(missing.every(m => typeof m.text === 'string' && m.text.length > 0), 'a miss must carry the text to embed')
  store.setMany(missing.map(m => [m.hash, axis(4, 0)]))
  assert(store.missingHashes(tools).length === 0, 'still missing after setMany')
})

await test('a changed description reappears as a miss', () => {
  const store = createVectorStore()
  store.setMany(store.missingHashes([fnTool('a', 'alpha')]).map(m => [m.hash, axis(4, 0)]))
  const misses = store.missingHashes([fnTool('a', 'alpha, revised')])
  assert(misses.length === 1, 'an edited tool was served a stale vector')
})

await test('the store does not grow on a repeated identical tool set', () => {
  const store = createVectorStore()
  const tools = [fnTool('a', 'alpha'), fnTool('b', 'beta')]
  for (let i = 0; i < 3; i++) {
    store.setMany(store.missingHashes(tools).map(m => [m.hash, axis(4, 0)]))
  }
  assert(store.size() === 2, `store held ${store.size()} vectors for 2 distinct tools`)
})

await test('a duplicated tool in one request is embedded once', () => {
  const store = createVectorStore()
  const tool = fnTool('a', 'alpha')
  assert(store.missingHashes([tool, { ...tool }]).length === 1, 'the same tool twice asked for two embeds')
})

await test('setMany ignores entries it cannot use', () => {
  const store = createVectorStore()
  store.setMany([['', axis(4, 0)], ['hash', null], ['hash2', undefined]])
  assert(store.size() === 0, `junk entries were stored: ${store.size()}`)
  store.setMany([['hash3', [1, 0, 0, 0]]])
  assert(store.get('hash3') instanceof Float32Array, 'a plain array was not coerced to Float32Array')
})

console.log('\n-- cosine --')

await test('identical and orthogonal vectors score 1 and 0', () => {
  assert(Math.abs(cosine(axis(4, 0), axis(4, 0)) - 1) < 1e-6, 'identical vectors did not score 1')
  assert(Math.abs(cosine(axis(4, 0), axis(4, 1))) < 1e-6, 'orthogonal vectors did not score 0')
})

await test('an opposed vector scores -1', () => {
  assert(Math.abs(cosine(new Float32Array([1, 0]), new Float32Array([-1, 0])) + 1) < 1e-6, 'opposed vectors did not score -1')
})

await test('🔍 a zero vector scores 0 rather than NaN', () => {
  const score = cosine(new Float32Array(4), axis(4, 0))
  assert(score === 0, `zero vector scored ${score} — a NaN here poisons the whole sort`)
})

await test('a length mismatch, an empty vector and a null score 0 without throwing', () => {
  assert(cosine(axis(4, 0), axis(8, 0)) === 0, 'mismatched lengths did not score 0')
  assert(cosine(new Float32Array(0), new Float32Array(0)) === 0, 'empty vectors did not score 0')
  assert(cosine(null, axis(4, 0)) === 0, 'null did not score 0')
  assert(cosine(axis(4, 0), undefined) === 0, 'undefined did not score 0')
})

console.log('\n-- scoring --')

await test('scoreTools returns every tool, sorted by descending score', () => {
  const store = createVectorStore()
  const near = fnTool('near', 'near')
  const far = fnTool('far', 'far')
  store.setMany([[toolContentHash(near), axis(4, 0)], [toolContentHash(far), axis(4, 1)]])
  const scored = scoreTools({ tools: [far, near], query: axis(4, 0), store })
  assert(scored.length === 2, `scored ${scored.length} of 2 tools`)
  assert(scored[0].name === 'near', `wrong order: ${scored.map(s => s.name).join(',')}`)
})

await test('🔍 a tool with no cached vector scores 0 and is flagged missing', () => {
  const store = createVectorStore()
  const known = fnTool('known', 'known')
  store.setMany([[toolContentHash(known), axis(4, 0)]])
  const scored = scoreTools({ tools: [known, fnTool('cold', 'cold')], query: axis(4, 0), store })
  const cold = scored.find(s => s.name === 'cold')
  assert(cold.score === 0 && cold.missing === true, 'a cold cache entry must rank last, not error')
})

await test('ties are broken by name, so the order is a function of the inputs', () => {
  const store = createVectorStore()
  const tools = ['c', 'a', 'b'].map(n => fnTool(n, 'same'))
  for (const t of tools) store.setMany([[toolContentHash(t), axis(4, 0)]])
  const names = scoreTools({ tools, query: axis(4, 0), store }).map(s => s.name)
  assert(names.join(',') === 'a,b,c', `unstable tie order: ${names.join(',')}`)
})

await test('a null query scores everything 0 instead of throwing', () => {
  const store = createVectorStore()
  const tool = fnTool('a', 'alpha')
  store.setMany([[toolContentHash(tool), axis(4, 0)]])
  const scored = scoreTools({ tools: [tool], query: null, store })
  assert(scored[0].score === 0, `null query scored ${scored[0].score}`)
})

console.log('\n-- keywords and fusion (second pass 3.1, 3.2) --')

// A scored list built by hand, so fusion is tested against exact scores
// rather than against whatever the vector math happened to produce.
function scoredList(pairs) {
  return pairs.map(([name, score]) => ({ tool: fnTool(name, `desc of ${name}`), name, score }))
}

await test('the tokenizer splits names, drops stopwords and numbers, and stems', () => {
  const got = tokenize('Show me the recent commits of read_text_file-configs: 48271 running studies')
  const want = ['recent', 'commit', 'read', 'text', 'file', 'config', 'run', 'study']
  assert(JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got))
  assert(tokenize('').length === 0 && tokenize(null).length === 0, 'empty input')
})

await test('🔍 BM25 finds a tool by a word in its name, and scores only what matches', () => {
  const tools = [fnTool('read_text_file', 'Read a file'), fnTool('web_fetch', 'Fetch a page'), fnTool('git_log', 'Show commits')]
  const index = createBm25Index(tools)
  const s = index.score('text file please')
  assert(s.has('read_text_file') && !s.has('web_fetch'), JSON.stringify([...s]))
  assert(index.score('nothing matches xyzzy').size === 0, 'a miss scored something')
  assert(createBm25Index(tools).key === index.key, 'the same catalog gave a different key')
  assert(createBm25Index([tools[0], fnTool('web_fetch', 'Fetch a web page')]).key !== index.key, 'a changed catalog kept its key')
})

await test('🔍 a rarer term outweighs a common one', () => {
  const tools = [fnTool('a_tool', 'file file vault'), fnTool('b_tool', 'file'), fnTool('c_tool', 'file')]
  const s = createBm25Index(tools).score('file vault')
  assert(s.get('a_tool') > s.get('b_tool'), JSON.stringify([...s]))
})

await test('fusion keeps the shape: every tool, sorted, normalised so 1 is first by both', () => {
  const scored = scoredList([['a', 0.9], ['b', 0.8], ['c', 0.7]])
  const fused = fuse({ scored, keyword: new Map([['a', 5], ['c', 9]]) })
  assert(fused.length === 3, 'a tool went missing')
  assert(fused.every((e, i) => i === 0 || fused[i - 1].score >= e.score), 'not sorted')
  const a = fused.find((e) => e.name === 'a').score
  const expectA = (1 / (RRF_K + 1) + 1 / (RRF_K + 2)) / (2 / (RRF_K + 1))
  assert(Math.abs(a - expectA) < 1e-12, `a scored ${a}, expected ${expectA}`)
  const top = fuse({ scored, keyword: new Map([['a', 5]]) })[0]
  assert(top.name === 'a' && Math.abs(top.score - 1) < 1e-12, 'first by both is not 1')
})

await test('🔍 a keyword match lifts a tool the embedding ranked low', () => {
  const scored = scoredList([['web', 0.9], ['git', 0.85], ['vault', 0.3]])
  const fused = fuse({ scored, keyword: new Map([['vault', 4]]) }).map((e) => e.name)
  assert(fused[0] === 'vault', `vault did not rise: ${fused}`)
})

await test('ties share a rank, so the alphabet does not decide between equal scores', () => {
  const scored = scoredList([['b', 1], ['z', 1], ['c', 0]])
  const fused = fuse({ scored, keyword: new Map() })
  assert(fused.find((e) => e.name === 'b').score === fused.find((e) => e.name === 'z').score, 'a tie was split')
})

await test('🔒 with no usable cosine score, fusion leaves everything at 0, so search_tools falls through to keywords', () => {
  const scored = scoredList([['a', 0], ['b', 0]])
  const fused = fuse({ scored, keyword: new Map([['a', 3]]) })
  assert(fused.every((e) => e.score === 0), JSON.stringify(fused.map((e) => [e.name, e.score])))
})

await test('settings: retrieval is off by default, on is `enabled` alone, and the report says the catalog', () => {
  assert(RETRIEVAL_DEFAULTS.enabled === false, 'retrieval came on by default')
  assert(retrievalEnabled(undefined) === false && retrievalEnabled({ enabled: 'yes' }) === false, 'something other than true turned it on')
  // The old per-turn fields are ignored where they lie (master plan 3.3).
  assert(retrievalEnabled({ enabled: true, mode: 'select', growth: 'scored' }) === true, 'an old mode field turned it off')
  assert(retrievalConfigSummary() === 'mode=catalog', retrievalConfigSummary())
})

console.log('\n-- the embedding server never fails a request --')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-embed-'))
const fakeModel = path.join(tmpDir, 'embed.gguf')
const fakeBinary = path.join(tmpDir, 'llama-server-stub')

// A spawn() stand-in: an EventEmitter with a pid and a kill(), which is the
// whole surface embed-server.mjs uses. Nothing is actually launched.
// startEmbedServer now watches /health in the background to decide when
// 'starting' becomes 'running'. These spawn-shape tests care about neither, so
// they run against a health endpoint that never turns green and a zero-length
// deadline — one probe, no timer left behind, no traffic to the real port.
const NEVER_READY = { fetchImpl: async () => ({ ok: false }), readyTimeoutMs: 0, readyPollMs: 1 }
const startStub = (options) => startEmbedServer({ ...NEVER_READY, ...options })

function stubSpawn(calls) {
  return (binaryPath, args, options) => {
    const child = new EventEmitter()
    child.pid = 34343
    child.kill = () => { child.killed = true }
    calls.push({ binaryPath, args, options, child })
    return child
  }
}

await test('🔍 a missing model file resolves to unavailable, not a throw', async () => {
  const status = await startStub({
    resolveBinary: () => fakeBinary,
    configDir: tmpDir,
    modelPath: path.join(tmpDir, 'not-downloaded.gguf'),
    spawn: stubSpawn([]),
  })
  assert(status.state === 'unavailable', `state was '${status.state}'`)
  assert(/download/i.test(status.reason), `the reason does not say what to do: ${status.reason}`)
  stopEmbedServer({ configDir: tmpDir })
})

await test('a missing binary resolves to unavailable too', async () => {
  fs.writeFileSync(fakeModel, 'not really a gguf')
  const status = await startStub({
    resolveBinary: () => path.join(tmpDir, 'no-such-binary'),
    configDir: tmpDir,
    modelPath: fakeModel,
    spawn: stubSpawn([]),
  })
  assert(status.state === 'unavailable', `state was '${status.state}'`)
  stopEmbedServer({ configDir: tmpDir })
})

await test('a resolveBinary that throws is caught', async () => {
  const status = await startStub({
    resolveBinary: () => { throw new Error('settings.json is unreadable') },
    configDir: tmpDir,
    modelPath: fakeModel,
    spawn: stubSpawn([]),
  })
  assert(status.state === 'unavailable', `state was '${status.state}'`)
  assert(status.reason.includes('unreadable'), `the underlying reason was lost: ${status.reason}`)
  stopEmbedServer({ configDir: tmpDir })
})

await test('a spawn that throws is caught', async () => {
  fs.writeFileSync(fakeBinary, 'stub')
  const status = await startStub({
    resolveBinary: () => fakeBinary,
    configDir: tmpDir,
    modelPath: fakeModel,
    spawn: () => { throw new Error('EACCES') },
  })
  assert(status.state === 'unavailable', `state was '${status.state}'`)
  stopEmbedServer({ configDir: tmpDir })
})

await test('🔒 the pid file is NOT llama-server.pid', async () => {
  assert(EMBED_PID_FILE !== LLAMA_PID_FILE, 'both servers are the same binary — a shared pid file lets one reap the other')
  const calls = []
  const status = await startStub({ resolveBinary: () => fakeBinary, configDir: tmpDir, modelPath: fakeModel, spawn: stubSpawn(calls) })
  // 'starting', not 'running' — see the readiness tests below.
  assert(status.state === 'starting', `state was '${status.state}'`)
  assert(fs.existsSync(path.join(tmpDir, EMBED_PID_FILE)), 'no pid file was written')
  assert(!fs.existsSync(path.join(tmpDir, LLAMA_PID_FILE)), 'the chat server pid file was overwritten')
  stopEmbedServer({ configDir: tmpDir })
  assert(!fs.existsSync(path.join(tmpDir, EMBED_PID_FILE)), 'the pid file outlived the process')
  return EMBED_PID_FILE
})

await test('a second start while running does not spawn twice', async () => {
  const calls = []
  await startStub({ resolveBinary: () => fakeBinary, configDir: tmpDir, modelPath: fakeModel, spawn: stubSpawn(calls) })
  await startStub({ resolveBinary: () => fakeBinary, configDir: tmpDir, modelPath: fakeModel, spawn: stubSpawn(calls) })
  assert(calls.length === 1, `spawned ${calls.length} times`)
  stopEmbedServer({ configDir: tmpDir })
})

await test('stop is idempotent, including before any start', () => {
  stopEmbedServer({ configDir: tmpDir })
  stopEmbedServer({ configDir: tmpDir })
  assert(embedServerStatus().state === 'stopped', `state was '${embedServerStatus().state}'`)
})

await test('🔒 a freshly spawned server reads as starting, not running', async () => {
  // The defect the first real run of this path exposed. The state was set to
  // 'running' the instant spawn() returned, so the Tools tab reported a working
  // sidecar while every embed call was still being refused — measured at ~900ms
  // for bge-small, and llama-server accepts the connection well before that, so
  // no connection check would have caught it either.
  const calls = []
  const status = await startStub({ resolveBinary: () => fakeBinary, configDir: tmpDir, modelPath: fakeModel, spawn: stubSpawn(calls) })
  assert(status.state === 'starting', `a just-spawned server reported '${status.state}'`)
  stopEmbedServer({ configDir: tmpDir })
  return 'spawned is not answering'
})

await test('🔒 starting becomes running once /health answers', async () => {
  const calls = []
  let probes = 0
  await startEmbedServer({
    resolveBinary: () => fakeBinary,
    configDir: tmpDir,
    modelPath: fakeModel,
    spawn: stubSpawn(calls),
    // 503 while loading, then 200 — the shape llama-server actually returns.
    fetchImpl: async () => ({ ok: ++probes >= 3 }),
    readyTimeoutMs: 5000,
    readyPollMs: 1,
  })
  assert(embedServerStatus().state === 'starting', 'flipped to running before /health was healthy')
  const until = Date.now() + 2000
  while (embedServerStatus().state === 'starting' && Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert(embedServerStatus().state === 'running', `never became ready (state '${embedServerStatus().state}', ${probes} probes)`)
  stopEmbedServer({ configDir: tmpDir })
  return `ready after ${probes} probes`
})

await test('🔒 a server that never loads stays starting — it is not a failure', async () => {
  // The process is alive and may still come up. Reporting 'unavailable' would
  // claim a failure that has not happened, and the reason has to say which.
  const calls = []
  await startEmbedServer({
    resolveBinary: () => fakeBinary,
    configDir: tmpDir,
    modelPath: fakeModel,
    spawn: stubSpawn(calls),
    fetchImpl: async () => ({ ok: false }),
    readyTimeoutMs: 0,
    readyPollMs: 1,
  })
  const until = Date.now() + 2000
  while (embedServerStatus().reason === null && Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  const status = embedServerStatus()
  assert(status.state === 'starting', `a slow load reported '${status.state}'`)
  assert(/finished loading/.test(status.reason ?? ''), `the reason does not say what is happening: ${status.reason}`)
  stopEmbedServer({ configDir: tmpDir })
  return status.reason
})

await test('🔒 the readiness watch stops when the server does', async () => {
  // Otherwise a stopped server keeps a timer alive for the whole deadline, and
  // a restart races the old watch into flipping the new process to running.
  const calls = []
  let probes = 0
  await startEmbedServer({
    resolveBinary: () => fakeBinary,
    configDir: tmpDir,
    modelPath: fakeModel,
    spawn: stubSpawn(calls),
    fetchImpl: async () => { probes++; return { ok: false } },
    readyTimeoutMs: 10000,
    readyPollMs: 5,
  })
  stopEmbedServer({ configDir: tmpDir })
  const after = probes
  await new Promise(resolve => setTimeout(resolve, 60))
  assert(probes <= after + 1, `the watch kept polling after the stop (${after} -> ${probes})`)
  assert(embedServerStatus().state === 'stopped', `state was '${embedServerStatus().state}'`)
  return 'watch ended with the process'
})

await test('🔍 a deliberate stop reads as stopped; a crash reads as unavailable', async () => {
  const calls = []
  await startStub({ resolveBinary: () => fakeBinary, configDir: tmpDir, modelPath: fakeModel, spawn: stubSpawn(calls) })
  calls[0].child.emit('exit', 1, null)
  assert(embedServerStatus().state === 'unavailable', 'a crashed embedding server still reported running')
  assert(/exited/.test(embedServerStatus().reason ?? ''), `the reason does not say it exited: ${embedServerStatus().reason}`)

  const calls2 = []
  await startStub({ resolveBinary: () => fakeBinary, configDir: tmpDir, modelPath: fakeModel, spawn: stubSpawn(calls2) })
  stopEmbedServer({ configDir: tmpDir })
  calls2[0].child.emit('exit', 0, 'SIGTERM')
  assert(embedServerStatus().state === 'stopped', `a deliberate stop reported '${embedServerStatus().state}'`)
})

await test('the status is safe to hand to the control plane', () => {
  const status = embedServerStatus()
  assert(JSON.stringify(status).length > 0, 'the status does not serialize')
  assert(!('process' in status), 'the status leaks the child process handle')
})

console.log('\n-- the embed client fails open, always --')

// A stub server per case, so each failure is the real thing over a real socket
// rather than a mocked fetch: the failures that matter here (a connection
// refused, a body that is not JSON, a server that never answers) are properties
// of the transport, not of the client's own control flow.
async function withStubServer(handler, fn) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    return await fn(port)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

function embeddingsBody(vectors) {
  return JSON.stringify({ data: vectors.map((embedding, index) => ({ index, embedding, object: 'embedding' })) })
}

await test('a well-formed response comes back in request order', async () => {
  await withStubServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(embeddingsBody([[1, 0], [0, 1]]))
  }, async (port) => {
    const out = await embedTexts(['a', 'b'], { port })
    assert(out !== null && out.length === 2, `got ${JSON.stringify(out)}`)
    assert(out[0] instanceof Float32Array, 'rows are not Float32Array')
    assert(out[0][0] === 1 && out[1][1] === 1, 'vectors came back scrambled')
  })
})

await test('🔍 an out-of-order response is placed by index, not by position', async () => {
  await withStubServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    // Same two rows, emitted back to front.
    res.end(JSON.stringify({ data: [
      { index: 1, embedding: [0, 1] },
      { index: 0, embedding: [1, 0] },
    ] }))
  }, async (port) => {
    const out = await embedTexts(['a', 'b'], { port })
    assert(out[0][0] === 1 && out[1][1] === 1, 'a reordered batch attached tools to the wrong vectors')
  })
})

await test('🔒 a 500 yields null, not a throw', async () => {
  await withStubServer((req, res) => { res.statusCode = 500; res.end('boom') }, async (port) => {
    assert(await embedTexts(['a'], { port }) === null, 'a 500 did not fail open')
  })
})

await test('🔒 a malformed body yields null', async () => {
  await withStubServer((req, res) => { res.end('not json at all') }, async (port) => {
    assert(await embedTexts(['a'], { port }) === null, 'unparseable JSON did not fail open')
  })
})

await test('🔒 a body with the wrong number of rows yields null', async () => {
  await withStubServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(embeddingsBody([[1, 0]]))
  }, async (port) => {
    assert(await embedTexts(['a', 'b'], { port }) === null, 'a short batch was accepted — tools would take other tools\' vectors')
  })
})

await test('🔒 a row with no usable vector yields null', async () => {
  await withStubServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: [{ index: 0, embedding: [] }] }))
  }, async (port) => {
    assert(await embedTexts(['a'], { port }) === null, 'an empty vector was accepted')
  })
})

await test('🔒 a server that never answers yields null within the timeout', async () => {
  await withStubServer(() => { /* deliberately never responds */ }, async (port) => {
    const started = Date.now()
    const out = await embedTexts(['a'], { port, timeoutMs: 250 })
    const elapsed = Date.now() - started
    assert(out === null, 'a hung server did not fail open')
    assert(elapsed < 3000, `the timeout did not fire: ${elapsed}ms`)
    return `${elapsed}ms`
  })
})

await test('🔒 nothing listening at all yields null', async () => {
  // Port 1 on loopback: nothing binds it, so this is connection-refused.
  assert(await embedTexts(['a'], { port: 1, timeoutMs: 500 }) === null, 'connection refused did not fail open')
})

await test('an empty input is an empty result, with no request made', async () => {
  let called = false
  const out = await embedTexts([], { fetchImpl: () => { called = true; throw new Error('should not be called') } })
  assert(Array.isArray(out) && out.length === 0, 'an empty batch should be an empty array, not null')
  assert(!called, 'an empty batch still hit the network')
})

await test('🔍 a persistent outage logs once, not once per request', async () => {
  resetEmbedFailureLog()
  const lines = []
  const realLog = console.log
  console.log = (...args) => lines.push(args.join(' '))
  try {
    for (let i = 0; i < 3; i++) await embedTexts(['a'], { port: 1, timeoutMs: 300 })
  } finally {
    console.log = realLog
  }
  const failures = lines.filter(l => l.includes('embed_failed'))
  assert(failures.length <= 1, `logged ${failures.length} times for one outage`)
})

fs.rmSync(tmpDir, { recursive: true, force: true })

console.log('\n-- the embedding model cannot see more than 512 tokens --')

// The bug this section exists for. bge-small stops at 512 positions, and
// llama-server answers an over-long input with a 500 that fails the ENTIRE
// batch, so one long text (a whole conversation, when per-turn selection
// embedded one; a long tool description or document chunk now) cost every
// other input its vector.

await test('truncateForEmbedding leaves text that already fits alone', () => {
  assert(truncateForEmbedding('short enough', 512) === 'short enough', 'a short string was cut')
  assert(truncateForEmbedding('anything at all', Infinity) === 'anything at all', 'an unbounded budget cut a string')
})

await test('🔍 truncateForEmbedding cuts to the budget', () => {
  const cut = truncateForEmbedding('x'.repeat(10000), 512)
  assert(cut.length <= 512 * CHARS_PER_TOKEN, `still ${cut.length} chars for a 512-token budget`)
})

await test('it prefers a word boundary, but not at any cost', () => {
  const words = truncateForEmbedding(('word '.repeat(2000)), 10)
  assert(!words.endsWith(' ') && !/\sw?o?r?$/.test(words), `cut mid-word with a boundary available: ${JSON.stringify(words.slice(-8))}`)
  // No boundary anywhere near the end: take the hard cut rather than almost nothing.
  const solid = truncateForEmbedding('a'.repeat(500) + ' ' + 'b'.repeat(500), 100)
  assert(solid.length === 300, `a boundary at 20% of the budget was used anyway: ${solid.length}`)
})

await test('a non-string and a zero budget are handled rather than thrown on', () => {
  assert(truncateForEmbedding(null, 512) === '', 'null did not become an empty string')
  assert(truncateForEmbedding('text', 0) === 'text', 'a zero budget cut everything')
})

await test('🔒 embedTexts truncates before sending, so one long input cannot fail the batch', async () => {
  // A stub that behaves the way llama-server actually does: refuse anything past
  // the model's limit, and fail the whole request when it does.
  const limitChars = EMBED_MODEL.maxTokens * CHARS_PER_TOKEN
  let sawOversized = false
  await withStubServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const input = JSON.parse(raw).input
    if (input.some(t => t.length > limitChars)) {
      sawOversized = true
      res.statusCode = 500
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: { code: 500, message: 'input is too large to process', type: 'server_error' } }))
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [1, 0] })) }))
  }, async (port) => {
    resetEmbedFailureLog()
    const out = await embedTexts(['word '.repeat(20000), 'a short tool description'], { port })
    assert(!sawOversized, 'an over-long input reached the server — the 500 would take the whole batch with it')
    assert(out !== null && out.length === 2, `expected 2 vectors, got ${out && out.length}`)
  })
})


console.log('\n-- search_tools --')

// A stub embedding server on an ephemeral port, so callTool() runs the whole
// production path — embedTexts over a socket, the shared vector store, the
// scorer — rather than through a seam wired in for the test. Keyword axes make
// the ranking exact.
const embedStub = http.createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const input = JSON.parse(raw).input
  const data = input.map((text, index) => {
    const v = [0, 0, 0]
    if (/git|commit|repo|status/i.test(text)) v[0] = 1
    if (/document|text|read/i.test(text)) v[1] = 1
    if (/web|page|fetch/i.test(text)) v[2] = 1
    if (v.every(x => x === 0)) v[2] = 0.01
    return { index, embedding: v, object: 'embedding' }
  })
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ data }))
})
// An ephemeral port, handed to the production client through
// setEmbedPortForTests. It used to be EMBED_PORT itself, which a running
// Redstart owns, so the whole section skipped on a developer's machine (P6).
await new Promise(resolve => embedStub.listen(0, '127.0.0.1', resolve))
setEmbedPortForTests(/** @type {import('net').AddressInfo} */ (embedStub.address()).port)
resetEmbedFailureLog()

const catalog = [
  { name: 'git_status', description: 'Show the working-tree status of a git repository' },
  { name: 'read_document', description: 'Read the text content of a document' },
  { name: 'web_fetch', description: 'Fetch a web page and return its article text' },
]

function catalogConfig(extra = {}) {
  return { toolRetrieval: { enabled: true }, ...extra }
}

const withSchemas = () => catalog.map((t) => ({ ...t, inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }))

await test('search_tools and call_tool are advertised only while retrieval is on, and describe_tool never', () => {
  assert(searchProvider.toolDefs({}).length === 0, 'a server with retrieval off advertised search_tools')
  assert(searchProvider.toolDefs({ toolRetrieval: { enabled: false } }).length === 0, 'an explicit off still advertised it')
  const defs = searchProvider.toolDefs(catalogConfig())
  assert(defs.map((d) => d.name).join() === 'search_tools,call_tool', `retrieval on advertised ${defs.map((d) => d.name)}`)
  assert(defs[0].inputSchema.required.includes('query'), 'query is not required')
  assert(defs[1].inputSchema.required.includes('name'), 'name is not required')
})

await test('🔍 a search row carries its schema and how to call it, at most five rows', async () => {
  searchProvider.setToolCatalogProvider(() => withSchemas())
  const result = await searchProvider.callTool('search_tools', { query: 'read the text of a document' }, catalogConfig())
  const body = JSON.parse(result.content[0].text)
  assert(Array.isArray(body.tools) && body.tools.length > 0 && body.tools.length <= searchProvider.CATALOG_RESULT_LIMIT, `rows: ${result.content[0].text}`)
  assert(body.tools.every((r) => r.inputSchema && r.inputSchema.type === 'object'), 'a row without its schema')
  assert(body.tools.every((r) => Object.keys(r).sort().join(',') === 'category,description,inputSchema,name,store'), `unexpected row shape: ${result.content[0].text}`)
  assert(/call_tool/.test(body.howToCall), 'no howToCall')
})

await test('a search for a tool\'s exact name returns just that tool, with its schema', async () => {
  searchProvider.setToolCatalogProvider(() => withSchemas())
  const body = JSON.parse((await searchProvider.callTool('search_tools', { query: 'git_status' }, catalogConfig())).content[0].text)
  const got = JSON.stringify([body.match, body.tools.map((t) => t.name), !!body.tools[0].inputSchema])
  assert(got === JSON.stringify(['exact', ['git_status'], true]), `exact: ${got}`)
})

await test('🔒 the catalog it searches is the one the policy gate produced', async () => {
  // The provider is handed a catalog rather than assembling one. This asserts
  // the consequence: whatever the gate withheld simply is not there to find, so
  // a ban cannot be walked around by describing the tool.
  // Positive control first: with the tool in the catalog, this query finds it.
  // Without that, the assertion below could pass because the search failed.
  searchProvider.setToolCatalogProvider(() => catalog)
  const found = await searchProvider.callTool('search_tools', { query: 'read the text of a document' }, catalogConfig())
  assert(/read_document/.test(found.content[0].text), `setup: the query should find the tool when it is present: ${found.content[0].text}`)

  searchProvider.setToolCatalogProvider(() => catalog.filter(t => t.name !== 'read_document'))
  const result = await searchProvider.callTool('search_tools', { query: 'read the text of a document' }, catalogConfig())
  assert(!result.isError, `the search failed rather than returning results: ${result.content[0].text}`)
  assert(!/read_document/.test(result.content[0].text), 'a withheld tool was reachable by describing it')
})

await test('🔍 search_tools never returns itself', async () => {
  searchProvider.setToolCatalogProvider(() => [
    ...catalog,
    { name: 'search_tools', description: 'Find tools that are available but not currently listed' },
  ])
  const result = await searchProvider.callTool('search_tools', { query: 'find a tool' }, catalogConfig())
  assert(!/search_tools/.test(result.content[0].text), 'search_tools offered itself as a result')
})

await test('🔍 a scorer that is down is reported as such, not as "no matches"', async () => {
  // Different answers. A model told nothing matched stops looking; one told the
  // search is unavailable keeps using what it can already see.
  searchProvider.setToolCatalogProvider(() => catalog)
  const down = await searchTools({ tools: catalog, query: 'anything', embed: async () => null })
  assert(down === null, 'a dead embedding server returned a list')
  const empty = await searchTools({ tools: [], query: 'anything', embed: async () => null })
  assert(Array.isArray(empty) && empty.length === 0, 'an empty catalog is an empty result, not a failure')
})

await test('a blank query is refused rather than scored', async () => {
  searchProvider.setToolCatalogProvider(() => catalog)
  for (const bad of [{}, { query: '' }, { query: '   ' }, { query: 42 }]) {
    const result = await searchProvider.callTool('search_tools', bad, catalogConfig())
    assert(result.isError === true, `${JSON.stringify(bad)} was accepted as a query`)
  }
})

await test('🔒 search_tools refuses to run when retrieval is off', async () => {
  searchProvider.setToolCatalogProvider(() => catalog)
  const result = await searchProvider.callTool('search_tools', { query: 'read a document' }, { toolRetrieval: { enabled: false } })
  assert(result.isError === true, 'a call succeeded on a server where retrieval is off')
})

await test('search_tools declines a call that is not its own', async () => {
  const result = await searchProvider.callTool('git_status', {}, catalogConfig())
  assert(result === null, 'the provider answered for a tool it does not own')
})

await test('🔍 results are ranked, best first', async () => {
  const embed = async (texts) => texts.map(text => {
    const v = new Float32Array(3)
    if (/git|commit|repo/i.test(text)) v[0] = 1
    if (/document|text/i.test(text)) v[1] = 1
    if (/web|page/i.test(text)) v[2] = 1
    if (v.every(x => x === 0)) v[2] = 0.01
    return v
  })
  const ranked = await searchTools({ tools: catalog, query: 'look at recent commits in the repo', embed })
  assert(ranked[0].name === 'git_status', `wrong first result: ${ranked.map(r => r.name).join(',')}`)
})

console.log('\n-- discovery: widening and call_tool (second pass 5.x) --')

const stubPort = /** @type {import('net').AddressInfo} */ (embedStub.address()).port
const deadPort = await new Promise((resolve) => {
  const probe = http.createServer()
  probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)) })
})
async function withEmbedderDown(fn) {
  setEmbedPortForTests(deadPort)
  resetEmbedFailureLog()
  // A store warmed by the tests above would still rank; a fresh tool text
  // has no vector, so ranking needs the (dead) embedder.
  try { return await fn() } finally { setEmbedPortForTests(stubPort) }
}
const searchJson = (result) => JSON.parse(result.content[0].text)

await test('🔍 step 1: a search that matches answers "close", with rows the scorer ranked', async () => {
  searchProvider.setToolCatalogProvider(() => catalog)
  const body = searchJson(await searchProvider.callTool('search_tools', { query: 'look at recent commits in the repo' }, catalogConfig()))
  assert(body.match === 'close' && body.tools[0].name === 'git_status', JSON.stringify(body))
})

await test('🔍 step 2: nothing above the floors answers "nearest" and says so', async () => {
  // The stub gives a query with no keyword a vector along the web axis at
  // 0.01, which no tool here shares: every cosine is 0, fusion leaves them
  // there, and nothing clears the floor. (The floors are constants since
  // master plan 3.3, so this is the way to reach the step.)
  searchProvider.setToolCatalogProvider(() => catalog.filter((t) => t.name !== 'web_fetch'))
  const body = searchJson(await searchProvider.callTool('search_tools', { query: 'zzz' }, catalogConfig()))
  assert(body.match === 'nearest' && /nearest/.test(body.note) && body.tools.length > 0, JSON.stringify(body))
})

await test('🔍 step 3: with the embedder down, keywords on names and tags still answer', async () => {
  const fresh = [{ name: 'read_text_file', description: 'Read one file (fresh text, never embedded)' }, { name: 'git_log', description: 'Commits (fresh)' }]
  searchProvider.setToolCatalogProvider(() => fresh)
  const body = await withEmbedderDown(async () => searchJson(await searchProvider.callTool('search_tools', { query: 'config' }, catalogConfig())))
  assert(body.match === 'keyword' && body.tools[0].name === 'read_text_file' && /unavailable/.test(body.note), JSON.stringify(body))
})

await test('🔍 step 4: no keyword either lists every tool by category, and names the client-tool gap', async () => {
  const fresh = [{ name: 'read_text_file', description: 'Read one file (fresher)' }, { name: 'git_log', description: 'Commits (fresher)' }]
  searchProvider.setToolCatalogProvider(() => fresh)
  const body = await withEmbedderDown(async () => searchJson(await searchProvider.callTool('search_tools', { query: 'xyzzy plugh' }, catalogConfig())))
  assert(body.match === 'categories', JSON.stringify(body))
  const names = body.categories.flatMap((c) => c.tools)
  assert(names.sort().join() === 'git_log,read_text_file', JSON.stringify(body))
  assert(/application provides itself/.test(body.note), 'the client-tool gap was not named')
})

await test('🔒 the discovery tools are never search results, at any step', async () => {
  searchProvider.setToolCatalogProvider(() => [...catalog, { name: 'search_tools', description: 'find a tool' }, { name: 'call_tool', description: 'call a tool' }])
  const text = (await searchProvider.callTool('search_tools', { query: 'find a tool, call a tool' }, catalogConfig())).content[0].text
  assert(!/call_tool"|search_tools"/.test(text.replace(/"howToCall":"[^"]*"/, '')), text)
})

await test('🔒 call_tool refuses to run when retrieval is off', async () => {
  searchProvider.setToolCatalogProvider(() => catalog)
  const r = await searchProvider.callTool('call_tool', { name: 'git_status' }, { toolRetrieval: { enabled: false } })
  assert(r?.isError === true, 'call_tool ran with retrieval off')
})

await test('🔒 call_tool proxies through the policy-checked caller, and makes it enforce every approval but a read\'s (U-S6)', async () => {
  // Until master plan Phase 3.1 a write or a delete was refused outright;
  // now it goes through with enforceApproval, so Nest's gate holds it until
  // the person decides the INNER call (mcp-server callToolAs).
  const cfg = catalogConfig()
  const writes = [{ name: 'create_document', description: 'Create a document' }, { name: 'memory_forget', description: 'Forget' }, { name: 'ask_user', description: 'Ask' }]
  searchProvider.setToolCatalogProvider(() => [...catalog, ...writes])
  const calls = []
  searchProvider.setToolCaller(async (account, name, args, opts) => { calls.push({ account, name, args, opts }); return { content: [{ type: 'text', text: 'ok' }] } })
  const ok = await searchProvider.callTool('call_tool', { name: 'git_status', arguments: { repo: 'x' } }, cfg, { account: { username: 'u' }, conversationId: 'conv' })
  assert(ok.content[0].text === 'ok' && calls.length === 1 && calls[0].name === 'git_status' && calls[0].args.repo === 'x', JSON.stringify(calls))
  assert(calls[0].account.username === 'u' && calls[0].opts.conversationId === 'conv', 'the caller identity was not passed')
  assert(calls[0].opts.enforceApproval === false, 'a read was made to wait for an approval')
  for (const name of ['create_document', 'memory_forget']) {
    await searchProvider.callTool('call_tool', { name, arguments: { a: 1 } }, cfg, { approvalId: 'appr-1' })
    const c = calls.at(-1)
    assert(c.name === name && c.opts.enforceApproval === true && c.opts.approvalId === 'appr-1', `${name}: ${JSON.stringify(c.opts)}`)
  }
  // Still refused before the caller: a host-resolved tool, and the discovery
  // tools themselves (not in the searchable catalog at all).
  const before = calls.length
  for (const name of ['ask_user', 'call_tool', 'search_tools']) {
    const r = await searchProvider.callTool('call_tool', { name }, cfg, {})
    assert(r.isError, `${name} went through call_tool`)
  }
  assert(calls.length === before, `a refused call reached the caller: ${calls.slice(before).map((c) => c.name)}`)
  calls.length = 1
  searchProvider.setToolCatalogProvider(() => catalog.filter((t) => t.name !== 'git_status'))
  const banned = await searchProvider.callTool('call_tool', { name: 'git_status' }, cfg, {})
  assert(banned.isError && calls.length === 1, 'a banned tool was called by name')
})

await test('🔒 the discovery tools are never embedded', async () => {
  const seen = []
  const watching = async (texts) => { seen.push(...texts); return texts.map(() => Float32Array.from([1, 0, 0])) }
  const tools = [mcpTool('git_status', 'status (never seen)'), mcpTool('search_tools', 'find tools'), mcpTool('call_tool', 'call one')]
  const ranked = await rankForSearch({ tools, query: 'status', embed: watching })
  assert(!seen.some((t) => /^(search_tools|call_tool):/.test(t)), `embedded: ${seen.filter((t) => /_tool/.test(t))}`)
  assert(ranked.map((r) => r.name).join() === 'git_status', `ranked: ${ranked.map((r) => r.name)}`)
})

await new Promise(resolve => embedStub.close(resolve))
setEmbedPortForTests(null)

console.log('\n-- turning retrieval on --')

// The switch has three things behind it that fail separately: a profile field,
// a 67 MB download, and a child process. These pin the two that are easy to get
// wrong — that a settings save is never held up by the download, and that the
// status tells the truth about all three rather than echoing the setting.

const enableDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-enable-'))
// Both seams are stubbed: this suite has no business pulling 67 MB off the
// network or spawning a server to prove that a settings save does not block.
let modelFetches = 0
let serverStarts = 0
const enableDeps = {
  resolveModelsDir: () => enableDir,
  ensureModelsDir: () => fs.mkdirSync(enableDir, { recursive: true }),
  resolveBinary: () => process.execPath,
  userDataDir: enableDir,
  fetchModel: () => { modelFetches++; return new Promise(() => {}) }, // never settles: "still downloading"
  startServer: async () => { serverStarts++ },
}
const profileWith = (retrieval) => ({ tools: { enabled: true, retrieval } })

await test('the status reports the setting, the model and the sidecar separately', () => {
  const status = retrievalStatus(profileWith({ enabled: true }), enableDeps)
  assert(status.enabled === true, 'the profile setting was not read')
  assert(status.model.present === false, 'a model that is not there was reported present')
  assert(status.model.bytes > 0 && typeof status.model.label === 'string', 'the model is not described')
  assert(status.server.state !== 'running', `the sidecar cannot be running: ${status.server.state}`)
})

await test('🔍 the status does not claim retrieval is happening just because the setting is on', () => {
  // The failure this exists to prevent: a switch that reads "on" for a server
  // doing no retrieval at all, which is worse than one that reads "off".
  const status = retrievalStatus(profileWith({ enabled: true }), enableDeps)
  assert(status.enabled && !status.model.present && status.server.state !== 'running',
    'setup: this is the state where the setting is on and nothing is running')
})

await test('🔒 turning it off stops the sidecar and downloads nothing', () => {
  const result = syncRetrieval(profileWith({ enabled: false }), enableDeps)
  assert(result.enabled === false, 'off did not read as off')
  assert(modelFetches === 0, 'switching retrieval off fetched a model')
  assert(serverStarts === 0, 'switching retrieval off started a server')
})

await test('a profile with no retrieval field at all reads as off', () => {
  assert(retrievalStatus({ tools: { enabled: true } }, enableDeps).enabled === false,
    'an older profile with no retrieval key read as on')
  assert(syncRetrieval({ tools: { enabled: true } }, enableDeps).enabled === false, 'an absent setting started something')
})

await test('🔍 turning it on returns immediately rather than waiting on a 67 MB download', () => {
  // A settings save must not block on a transfer. The call returns
  // `downloading: true` and the progress is read back through the status.
  const started = Date.now()
  const result = syncRetrieval(profileWith({ enabled: true }), enableDeps)
  const elapsed = Date.now() - started
  assert(result.enabled === true, 'on did not read as on')
  assert(result.downloading === true, 'a missing model did not start a download')
  assert(elapsed < 1000, `the call blocked for ${elapsed}ms — a settings save would hang`)
})

await test('a second call while the download is running does not start a second one', () => {
  const again = syncRetrieval(profileWith({ enabled: true }), enableDeps)
  assert(again.downloading === true, 'the in-flight download was not reported')
  assert(modelFetches === 1, `the download was started ${modelFetches} times`)
  const status = retrievalStatus(profileWith({ enabled: true }), enableDeps)
  assert(status.model.download.state === 'downloading', `download state was ${status.model.download.state}`)
})

await test('🔍 the sidecar starts with NO chat server running', () => {
  // The bug this pins. The embedding sidecar's lifetime is the DAEMON's, not a
  // chat model's — that is the whole reason it can warm its cache before the
  // first completion. It was wired behind applyToolsConfig's "is the gateway
  // up?" early return, so it started only once a model was already loaded,
  // which in practice meant it never started at all and the switch sat at
  // "Starting…" forever.
  resetRetrievalState()
  modelFetches = 0
  // No gateway is running in this suite, so applyToolsConfig returns false —
  // and retrieval must still have been dealt with on the way past.
  const live = applyToolsConfig(
    { port: 19080, ...profileWith({ enabled: true }) },
    { ...enableDeps, buildGatewayConfig: () => ({}) },
  )
  assert(live === false, 'setup: this suite has no gateway, so the live sync should report false')
  assert(modelFetches === 1, 'retrieval was skipped because no chat server was running')
  syncRetrieval(profileWith({ enabled: false }), enableDeps)
})

await test('🔍 a failed download can be retried by toggling off and on', () => {
  // The advice the switch gives when a download fails. Guarding on the state
  // string rather than the in-flight promise made that advice false: 'failed'
  // was fine, but a download interrupted by the switch going off left
  // 'downloading' behind and swallowed every retry after it.
  resetRetrievalState()
  let fetches = 0
  const failing = { ...enableDeps, fetchModel: async () => { fetches++; return null } }
  syncRetrieval(profileWith({ enabled: true }), failing)
  return new Promise(resolve => setImmediate(() => {
    assert(retrievalStatus(profileWith({ enabled: true }), failing).model.download.state === 'failed',
      'a download that returned nothing did not report as failed')
    syncRetrieval(profileWith({ enabled: false }), failing)
    syncRetrieval(profileWith({ enabled: true }), failing)
    assert(fetches === 2, `the retry was swallowed: ${fetches} attempt(s)`)
    resolve()
  }))
})

await test('🔒 a download that finishes after the switch went off does not start a server', () => {
  resetRetrievalState()
  let started = 0
  let settle
  const slow = {
    ...enableDeps,
    fetchModel: () => new Promise(r => { settle = r }),
    startServer: async () => { started++ },
  }
  syncRetrieval(profileWith({ enabled: true }), slow)
  syncRetrieval(profileWith({ enabled: false }), slow)   // user changed their mind
  settle('/models/embed.gguf')                            // the transfer lands anyway
  return new Promise(resolve => setImmediate(() => {
    assert(started === 0, 'a completed download started a server the user had switched off')
    resolve()
  }))
})

await test('the status distinguishes the profile setting from what the server is doing', () => {
  const status = retrievalStatus(profileWith({ enabled: true }), enableDeps)
  assert(status.enabled === true, 'the profile setting was not read')
  assert(status.applied.gatewayUp === false, 'no gateway is running in this suite')
  assert(status.applied.enabled === false, 'a gateway that was never told reported the filter as on')
})

syncRetrieval(profileWith({ enabled: false }), enableDeps)
fs.rmSync(enableDir, { recursive: true, force: true })


// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
