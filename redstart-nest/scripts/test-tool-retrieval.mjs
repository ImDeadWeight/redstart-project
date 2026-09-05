// =============================================================================
// Invariant tests for electron/main/tool-retrieval.mjs
// =============================================================================
// Three things this suite exists to catch, all of which are easy to lose to an
// innocent-looking edit:
//
//  1. selectTools() is a SUBSET function. It can only ever remove from the list
//     it is given, because the list it is given is the post-ban one. A change
//     that let a pin or a carried-forward name conjure a tool that was not
//     offered would turn an optimization into a hole in the ban filter.
//  2. An unchanged selection serializes identically. The result is ordered by
//     name, never by score — sorting by score is the obvious thing to write and
//     it silently costs a full KV-cache re-prefill on every turn.
//  3. Nothing here throws. A degenerate vector scores 0; it does not produce a
//     NaN that poisons a sort.
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
  selectTools,
  conversationQueryText,
  conversationKey,
  pinsFromMessages,
  createSelectionMemory,
  truncateForEmbedding,
  CHARS_PER_TOKEN,
} from '../electron/main/tool-retrieval.mjs'
import * as searchProvider from '../electron/main/search-tools-provider.mjs'
const { retrievalStatus, syncRetrieval, applyToolsConfig, resetRetrievalState } = await import('../electron/main/ipc/tools.mjs')
import { EMBED_PORT } from '../electron/main/ports.mjs'
import { EMBED_MODEL } from '../electron/main/embed-model.mjs'
import {
  filterRequestTools,
  searchTools,
  toolBudget,
  resetToolFilterState,
  CONTEXT_BUDGET_FRACTION,
} from '../electron/main/tool-filter.mjs'
import {
  EMBED_PID_FILE,
  startEmbedServer,
  stopEmbedServer,
  embedServerStatus,
  embedTexts,
  resetEmbedFailureLog,
} from '../electron/main/embed-server.mjs'
import { LLAMA_PID_FILE } from '../electron/main/process-supervision.mjs'
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

console.log('\n-- selection --')

// A scored list built by hand, so selection is tested against exact scores
// rather than against whatever the vector math happened to produce.
function scoredList(pairs) {
  return pairs.map(([name, score]) => ({ tool: fnTool(name, `desc of ${name}`), name, score }))
}

await test('pins survive an empty score list', () => {
  const { selected } = selectTools({ scored: [], pins: ['ghost'], floor: 0.5 })
  assert(selected.length === 0, 'a pin conjured a tool that was never offered — retrieval must only ever remove')
})

await test('🔒 selected is always a subset of the tools offered', () => {
  const scored = scoredList([['a', 0.9], ['b', 0.8]])
  const { selected } = selectTools({ scored, pins: ['banned_tool'], previous: ['also_banned'], floor: 0 })
  const offered = new Set(scored.map(s => s.name))
  for (const t of selected) {
    assert(offered.has(toolName(t)), `${toolName(t)} was selected but never offered`)
  }
})

await test('a pin below the floor is still included', () => {
  const scored = scoredList([['high', 0.9], ['pinned', 0.01]])
  const names = selectTools({ scored, pins: ['pinned'], floor: 0.5 }).selected.map(toolName)
  assert(names.includes('pinned'), `a pin was dropped by the floor: ${names.join(',')}`)
})

await test('🔍 previous is always a subset of selected — the set never shrinks', () => {
  const scored = scoredList([['a', 0.9], ['b', 0.2], ['c', 0.1]])
  const previous = ['b', 'c']
  const names = new Set(selectTools({ scored, previous, floor: 0.5, budgetTokens: 10 }).selected.map(toolName))
  for (const p of previous) assert(names.has(p), `${p} was applied last turn and vanished this turn`)
})

await test('a tool below the floor is never added even with budget to spare', () => {
  const scored = scoredList([['good', 0.9], ['junk', 0.05]])
  const { selected, reason } = selectTools({ scored, floor: 0.5, budgetTokens: 1e6 })
  const names = selected.map(toolName)
  assert(names.length === 1 && names[0] === 'good', `floor ignored: ${names.join(',')}`)
  assert(reason === 'floor', `expected reason 'floor', got '${reason}'`)
})

await test('budget exhaustion drops the lowest scorer, never a pin', () => {
  const scored = scoredList([['pinned', 0.01], ['high', 0.9], ['mid', 0.8], ['low', 0.7]])
  const perTool = estimateToolTokens(scored[0].tool)
  // Room for the pin plus exactly one more.
  const { selected, reason } = selectTools({ scored, pins: ['pinned'], floor: 0, budgetTokens: perTool * 2 })
  const names = selected.map(toolName)
  assert(names.includes('pinned'), `the pin was evicted by the budget: ${names.join(',')}`)
  assert(names.includes('high'), `the best scorer was dropped before the worst: ${names.join(',')}`)
  assert(!names.includes('low'), `the budget was exceeded: ${names.join(',')}`)
  assert(reason === 'budget', `expected reason 'budget', got '${reason}'`)
})

await test('a budget smaller than the pins alone still keeps the pins', () => {
  const scored = scoredList([['pinned', 0.01], ['high', 0.9]])
  const names = selectTools({ scored, pins: ['pinned'], floor: 0, budgetTokens: 1 }).selected.map(toolName)
  assert(names.join(',') === 'pinned', `a pin is a promise, not a budget line: ${names.join(',')}`)
})

await test('🔍 hysteresis suppresses a marginal add', () => {
  const scored = scoredList([['strong', 0.9], ['carried', 0.50], ['marginal', 0.52]])
  const withoutMargin = selectTools({ scored, previous: ['carried'], floor: 0, margin: 0 }).selected.map(toolName)
  assert(withoutMargin.includes('marginal'), 'setup wrong: the marginal tool should qualify with no margin')
  const withMargin = selectTools({ scored, previous: ['carried'], floor: 0, margin: 0.1 }).selected.map(toolName)
  assert(!withMargin.includes('marginal'), `a hair-width score change toggled the set: ${withMargin.join(',')}`)
  assert(withMargin.includes('strong'), `the margin blocked a clear winner too: ${withMargin.join(',')}`)
})

await test('the margin is measured against the WEAKEST included tool, not the strongest', () => {
  // If it were measured against the strongest, 'candidate' could never clear it.
  const scored = scoredList([['strong', 0.99], ['weak', 0.30], ['candidate', 0.45]])
  const names = selectTools({ scored, previous: ['strong', 'weak'], floor: 0, margin: 0.1 }).selected.map(toolName)
  assert(names.includes('candidate'), `a tool clearly better than the worst included was blocked: ${names.join(',')}`)
})

await test('🔒 two calls with re-ordered inputs and the same set serialize identically', () => {
  const a = selectTools({ scored: scoredList([['a', 0.9], ['b', 0.8], ['c', 0.7]]), floor: 0 })
  const b = selectTools({ scored: scoredList([['c', 0.7], ['a', 0.9], ['b', 0.8]]), floor: 0 })
  assert(
    JSON.stringify(a.selected) === JSON.stringify(b.selected),
    'the same set serialized two ways — this invalidates the KV cache on every turn',
  )
})

await test('🔒 the result is ordered by name, not by score', () => {
  const names = selectTools({ scored: scoredList([['zeta', 0.99], ['alpha', 0.10]]), floor: 0 }).selected.map(toolName)
  assert(names.join(',') === 'alpha,zeta', `ordered by score instead of name: ${names.join(',')}`)
})

await test('selected and dropped partition the offered set exactly once', () => {
  const scored = scoredList([['a', 0.9], ['b', 0.4], ['c', 0.1]])
  const { selected, dropped } = selectTools({ scored, floor: 0.5 })
  const all = [...selected, ...dropped].map(toolName).sort()
  assert(all.join(',') === 'a,b,c', `partition lost or duplicated a tool: ${all.join(',')}`)
})

await test('nothing dropped reports all-selected', () => {
  const { reason, dropped } = selectTools({ scored: scoredList([['a', 0.9], ['b', 0.8]]), floor: 0 })
  assert(dropped.length === 0 && reason === 'all-selected', `expected a clean pass, got '${reason}' with ${dropped.length} dropped`)
})

await test('🔍 a relative floor cuts where an absolute one cannot', () => {
  // The band bge actually produces on this tree's tools: everything between
  // 0.57 and 0.82. An absolute floor is either a no-op or an arbitrary cut.
  const scored = scoredList([['best', 0.82], ['good', 0.74], ['weak', 0.58], ['weaker', 0.57]])
  const absolute = selectTools({ scored, floor: 0.5 }).selected.map(toolName)
  assert(absolute.length === 4, `an absolute floor of 0.5 cut nothing, as expected: ${absolute.length}`)
  const relative = selectTools({ scored, relativeFloor: 0.9 }).selected.map(toolName)
  assert(relative.join(',') === 'best,good', `expected the top band only, got: ${relative.join(',')}`)
})

await test('the absolute and relative floors both apply — a tool must clear each', () => {
  const scored = scoredList([['best', 0.9], ['mid', 0.5]])
  // relativeFloor alone would admit 'mid' (0.5 >= 0.9 * 0.5); the absolute one
  // must still be able to refuse it.
  const names = selectTools({ scored, floor: 0.6, relativeFloor: 0.5 }).selected.map(toolName)
  assert(names.join(',') === 'best', `the absolute floor was ignored: ${names.join(',')}`)
})

await test('a relative floor is inert when every score is zero', () => {
  // A cold cache scores everything 0. That is not a licence to widen or to
  // admit the whole registry on a division that never happened.
  const scored = scoredList([['a', 0], ['b', 0]])
  const names = selectTools({ scored, relativeFloor: 0.9 }).selected.map(toolName)
  assert(names.length === 2, `a zero best score changed the outcome: ${names.join(',')}`)
})

await test('the relative floor is read off the scored field, and a pin still overrides it', () => {
  // The bar is a fraction of the best score anything got this turn, pins
  // included — "within x% of the best match" is a claim about the query, not
  // about the selection. What must hold is that the pin itself is never
  // measured against it.
  const scored = scoredList([['pinned', 0.99], ['a', 0.60]])
  const names = selectTools({ scored, pins: ['pinned'], relativeFloor: 0.9 }).selected.map(toolName)
  assert(names.includes('pinned'), 'a pin was cut by the floor it set')
  assert(!names.includes('a'), `0.60 is well under 0.9 x 0.99 and should not have survived: ${names.join(',')}`)
})

await test('an empty request selects nothing without throwing', () => {
  const { selected, dropped, reason } = selectTools({ scored: [] })
  assert(selected.length === 0 && dropped.length === 0 && reason === 'all-selected', 'an empty tool list should be a no-op')
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

console.log('\n-- reading the request --')

await test('the query is the WHOLE conversation, not the last turn', () => {
  const text = conversationQueryText([
    { role: 'user', content: 'find my tax notes' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'vault_search' } }] },
    { role: 'tool', name: 'vault_search', content: '[]' },
    { role: 'user', content: 'now check the repo' },
  ])
  assert(/tax notes/.test(text), 'an earlier user message was dropped — the query would churn every turn')
  assert(/check the repo/.test(text), 'the latest message was dropped')
  assert(/vault_search/.test(text), 'the name of a tool already called is part of the query')
})

await test('tool RESULTS are not part of the query', () => {
  // A search result or a file read can be tens of kilobytes and says nothing
  // about what the user wants next; it would swamp the sentence that does.
  const text = conversationQueryText([
    { role: 'user', content: 'hi' },
    { role: 'tool', name: 'read_document', content: 'CHAPTER ONE. It was a dark and stormy night.' },
  ])
  assert(!/stormy/.test(text), `a tool result leaked into the query: ${text}`)
})

await test('multimodal content contributes its text and not its image data', () => {
  const text = conversationQueryText([{
    role: 'user',
    content: [{ type: 'text', text: 'what is in this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
  }])
  assert(text === 'what is in this', `unexpected query text: ${text}`)
})

await test('🔍 the conversation key is stable as the conversation grows', () => {
  const opening = { role: 'user', content: 'what changed in the repo' }
  const early = conversationKey([opening], 'acct-1')
  const later = conversationKey([opening, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'and now?' }], 'acct-1')
  assert(early === later, 'the key changed as messages were added — every turn would be a cache miss')
})

await test('🔒 two accounts opening with the same sentence get different keys', () => {
  const messages = [{ role: 'user', content: 'hello' }]
  assert(conversationKey(messages, 'a') !== conversationKey(messages, 'b'), 'the applied set would be shared across accounts')
})

await test('a conversation with no user message still keys without throwing', () => {
  assert(/^[0-9a-f]{64}$/.test(conversationKey([{ role: 'system', content: 'x' }], null)), 'no key produced')
})

await test('🔍 every tool already called is pinned', () => {
  const pins = pinsFromMessages([
    { role: 'assistant', tool_calls: [{ function: { name: 'git_log' } }, { function: { name: 'git_diff' } }] },
    { role: 'assistant', tool_calls: [{ function: { name: 'read_document' } }] },
  ])
  assert(pins.has('git_log') && pins.has('git_diff') && pins.has('read_document'),
    `a tool used mid-task was not pinned: ${[...pins].join(',')}`)
})

await test('🔍 names a search_tools result surfaced become pins', () => {
  const pins = pinsFromMessages([
    { role: 'assistant', tool_calls: [{ function: { name: 'search_tools' } }] },
    { role: 'tool', name: 'search_tools', content: JSON.stringify([{ name: 'vault_search', description: 'x' }]) },
  ])
  assert(pins.has('vault_search'), 'a searched-for tool was not pinned on the next turn')
})

await test('an unparseable search result pins nothing rather than guessing', () => {
  const pins = pinsFromMessages([
    { role: 'tool', name: 'search_tools', content: 'I found vault_search for you' },
  ])
  assert(!pins.has('vault_search'), 'a name was parsed out of prose')
})

await test('a tool result from something OTHER than search_tools pins nothing', () => {
  const pins = pinsFromMessages([
    { role: 'tool', name: 'read_document', content: JSON.stringify([{ name: 'delete_everything' }]) },
  ])
  assert(!pins.has('delete_everything'), 'a tool result could name its own pins — content is not authority')
})

console.log('\n-- the selection memory --')

await test('the memory returns what was applied, and an empty list for a miss', () => {
  const mem = createSelectionMemory({ max: 3 })
  assert(mem.get('nope').length === 0, 'a miss should be an empty list, not undefined')
  mem.set('k', ['a', 'b'])
  assert(mem.get('k').join(',') === 'a,b', 'the applied set did not round-trip')
})

await test('🔍 the memory is bounded, and evicts least-recently-used', () => {
  const mem = createSelectionMemory({ max: 2 })
  mem.set('a', ['1'])
  mem.set('b', ['2'])
  mem.get('a')            // 'a' is now the most recently used
  mem.set('c', ['3'])     // evicts 'b', not 'a'
  assert(mem.size() === 2, `memory grew to ${mem.size()}`)
  assert(mem.get('a').length === 1, 'the recently used entry was evicted')
  assert(mem.get('b').length === 0, 'the stale entry survived')
})

console.log('\n-- the filter, end to end --')

const t = {
  git: fnTool('git_status', 'Show the working-tree status of a git repository'),
  doc: fnTool('read_document', 'Read the text content of a document'),
  web: fnTool('web_fetch', 'Fetch a web page and return its article text'),
}
const allTools = [t.git, t.doc, t.web]
const ask = [{ role: 'user', content: 'what changed in the repo' }]

// A stand-in embedder: each text gets a vector along the axis of whichever
// keyword it contains, so relevance is exact and the assertions are about the
// filter's decisions rather than about a model's judgement.
function keywordEmbed(axes) {
  return async (texts) => texts.map(text => {
    const v = new Float32Array(axes.length)
    axes.forEach((word, i) => { if (text.toLowerCase().includes(word)) v[i] = 1 })
    // Never hand back an all-zero vector for a text that matched nothing: that
    // is a legitimate score of 0, but it would make every miss identical.
    if (v.every(x => x === 0)) v[axes.length - 1] = 0.01
    return v
  })
}
const embed = keywordEmbed(['repo', 'document', 'web'])

await test('🔒 with the setting off, the very same array comes back', async () => {
  resetToolFilterState()
  const out = await filterRequestTools({ tools: allTools, messages: ask, settings: { enabled: false }, embed })
  assert(out === allTools, 'the array was rebuilt with retrieval off — callers rely on identity to know nothing happened')
})

await test('🔒 a null from the embedder returns the same array', async () => {
  resetToolFilterState()
  const out = await filterRequestTools({ tools: allTools, messages: ask, settings: { enabled: true }, embed: async () => null })
  assert(out === allTools, 'a dead embedding server changed the tool list')
})

await test('🔒 an embedder that throws returns the same array', async () => {
  resetToolFilterState()
  const out = await filterRequestTools({
    tools: allTools, messages: ask, settings: { enabled: true },
    embed: async () => { throw new Error('kaboom') },
  })
  assert(out === allTools, 'an exception escaped the filter')
})

await test('🔍 an on-topic ask keeps the matching tool and drops the rest', async () => {
  resetToolFilterState()
  const out = await filterRequestTools({ tools: allTools, messages: ask, settings: { enabled: true }, embed })
  const names = out.map(toolName)
  assert(names.includes('git_status'), `the relevant tool was dropped: ${names.join(',')}`)
  assert(!names.includes('web_fetch'), `an unrelated tool survived: ${names.join(',')}`)
})

await test('🔒 the result is always a subset of what was offered', async () => {
  resetToolFilterState()
  const out = await filterRequestTools({ tools: [t.git], messages: ask, settings: { enabled: true }, embed })
  assert(out.every(x => allTools.includes(x)), 'the filter returned a tool that was not offered')
  assert(out.length <= 1, `the filter grew the list to ${out.length}`)
})

await test('🔍 the applied set never shrinks across turns in one conversation', async () => {
  resetToolFilterState()
  const first = await filterRequestTools({ tools: allTools, messages: ask, settings: { enabled: true }, embed })
  const firstNames = first.map(toolName)
  // The topic moves on. Monotonicity says nothing already applied may leave.
  const turn2 = [...ask, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'now read a document' }]
  const second = await filterRequestTools({ tools: allTools, messages: turn2, settings: { enabled: true, margin: 0 }, embed })
  const secondNames = second.map(toolName)
  for (const name of firstNames) {
    assert(secondNames.includes(name), `${name} was applied last turn and vanished — that is a re-prefill and a broken task`)
  }
  assert(secondNames.includes('read_document'), `the new topic's tool was not added: ${secondNames.join(',')}`)
})

await test('🔍 hysteresis suppresses a tie, which is the point of it', () => {
  // The turn above with the default margin instead of 0. The new topic scores
  // EXACTLY what the carried tool scores, and the margin refuses it — a set
  // that reshuffles on a tie costs a full re-prefill every turn, and because
  // the query is the whole conversation the tie breaks on its own as the
  // conversation moves rather than staying stuck. Pinned here because it is
  // surprising, not because it is incidental.
  const scored = scoredList([['carried', 0.707], ['newcomer', 0.707]])
  const withDefault = selectTools({ scored, previous: ['carried'], floor: 0, margin: 0.02 }).selected.map(toolName)
  assert(!withDefault.includes('newcomer'), `a tie was admitted: ${withDefault.join(',')}`)
  const withNone = selectTools({ scored, previous: ['carried'], floor: 0, margin: 0 }).selected.map(toolName)
  assert(withNone.includes('newcomer'), 'setup: with no margin the tie should be admitted')
})

await test('🔒 a tool the model has already called is never dropped', async () => {
  resetToolFilterState()
  const messages = [
    { role: 'user', content: 'read a document' },
    { role: 'assistant', tool_calls: [{ function: { name: 'web_fetch' } }] },
    { role: 'tool', name: 'web_fetch', content: 'ok' },
    { role: 'user', content: 'read a document' },
  ]
  const out = await filterRequestTools({ tools: allTools, messages, settings: { enabled: true }, embed })
  assert(out.map(toolName).includes('web_fetch'), 'a tool already called mid-task was filtered away')
})

await test('🔒 an empty selection falls back to the full list rather than stripping everything', async () => {
  resetToolFilterState()
  // An embedder that answers with vectors of the wrong length: every cosine is
  // 0, so nothing clears a floor. Sending no tools at all would strip a
  // capability the prompt is about to claim.
  const out = await filterRequestTools({
    tools: allTools, messages: ask, settings: { enabled: true, floor: 0.5 },
    embed: async (texts) => texts.map(() => new Float32Array([0, 0, 0, 0, 0])),
  })
  assert(out === allTools, 'a scorer that matched nothing emptied the request')
})

await test('a conversation with no user text is left alone', async () => {
  resetToolFilterState()
  const out = await filterRequestTools({
    tools: allTools, messages: [{ role: 'system', content: 'you are a bot' }],
    settings: { enabled: true }, embed,
  })
  assert(out === allTools, 'a request with nothing to score was filtered anyway')
})

await test('🔒 the gateway budget and the Tools tab agree on what is too much', () => {
  // Two numbers in one product deciding "too much context spent on tools"
  // independently is how a filter comes to report success while sending a
  // request the UI would have warned about. The tab's amber threshold has
  // always been a quarter of the window; the budget matches it, and this reads
  // the tab to say so rather than trusting a comment.
  const tab = fs.readFileSync(new URL('../src/tabs/ToolsTab.tsx', import.meta.url), 'utf8')
  const thresholds = [...tab.matchAll(/ctxSize \* ([\d.]+)|ctx \* ([\d.]+)/g)].map(m => Number(m[1] ?? m[2]))
  assert(thresholds.length > 0, 'no context threshold found in ToolsTab.tsx — has it changed shape?')
  for (const t of thresholds) {
    assert(t === CONTEXT_BUDGET_FRACTION,
      `the Tools tab warns at ${t} of the window but the gateway budgets ${CONTEXT_BUDGET_FRACTION}`)
  }
  return `both ${CONTEXT_BUDGET_FRACTION}, across ${thresholds.length} site(s)`
})

await test('🔍 the budget leaves room for the conversation and the answer', () => {
  assert(toolBudget(4096, 0) === Math.floor(4096 * CONTEXT_BUDGET_FRACTION),
    `an empty conversation should get the whole tool share: ${toolBudget(4096, 0)}`)
  assert(toolBudget(4096, 1000) === Math.floor(4096 * CONTEXT_BUDGET_FRACTION) - 1000,
    'the reserved prompt was not subtracted')
  assert(toolBudget(4096, 999999) === 0, 'a conversation larger than the window produced a negative budget')
})

await test('an unknown context size budgets nothing rather than guessing', () => {
  for (const bad of [undefined, null, 0, -1, NaN, 'big']) {
    assert(toolBudget(bad, 0) === Infinity, `${JSON.stringify(bad)} produced an invented budget`)
  }
  return 'the floors still decide'
})

await test('🔍 the budget is enforced end to end', async () => {
  resetToolFilterState()
  // A window small enough that one tool fits and three do not.
  const perTool = estimateToolTokens(t.git)
  const out = await filterRequestTools({
    tools: allTools, messages: ask, settings: { enabled: true, relativeFloor: 0, floor: -1 },
    ctxSize: Math.ceil((perTool * 2) / CONTEXT_BUDGET_FRACTION), embed,
  })
  assert(out.length < allTools.length, `the budget did not bind: kept ${out.length} of ${allTools.length}`)
  assert(out.map(toolName).includes('git_status'), 'the budget dropped the best match first')
})


console.log('\n-- the embedding model cannot see more than 512 tokens --')

// The bug this section exists for. The query is the whole conversation by
// design, bge-small stops at 512 positions, and llama-server answers an
// over-long input with a 500 that fails the ENTIRE batch — so one long
// conversation cost every tool its vector and the request went out unfiltered.
// The Phase 2.4 evaluation used one-sentence queries, so the two decisions
// never met until a real conversation put them together.

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

await test('🔍 a bounded query stays inside the budget, however long the conversation', () => {
  const messages = [
    { role: 'user', content: 'x'.repeat(20000) },
    { role: 'assistant', tool_calls: [{ function: { name: 'git_status' } }] },
    { role: 'user', content: 'now check the repo' },
  ]
  const q = conversationQueryText(messages, { maxTokens: 512 })
  assert(q.length <= 512 * CHARS_PER_TOKEN, `query was ${q.length} chars — this is the 500`)
})

await test('🔒 tool names survive a tight budget; the oldest prose does not', () => {
  const messages = [
    { role: 'user', content: 'the opening question, long ago '.repeat(200) },
    { role: 'assistant', tool_calls: [{ function: { name: 'vault_search' } }] },
    { role: 'user', content: 'and what about now' },
  ]
  const q = conversationQueryText(messages, { maxTokens: 64 })
  assert(q.length <= 64 * CHARS_PER_TOKEN, `over budget at ${q.length} chars`)
  assert(q.includes('vault_search'), `a tool already called was dropped from the query: ${JSON.stringify(q)}`)
  assert(q.includes('and what about now'), 'the most recent question was dropped in favour of the oldest')
  // The opening message is 6,200 characters; whatever survives of it is a tail
  // fragment, never the message.
  assert(q.length < messages[0].content.length, 'the whole opening survived a 64-token budget')
})

await test('an unbounded call is still the whole conversation', () => {
  const messages = [
    { role: 'user', content: 'first' },
    { role: 'assistant', tool_calls: [{ function: { name: 'git_log' } }] },
    { role: 'user', content: 'second' },
  ]
  const q = conversationQueryText(messages)
  assert(/first/.test(q) && /second/.test(q) && /git_log/.test(q), `something was lost with no budget: ${q}`)
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

// A stub embedding server on the real EMBED_PORT, so callTool() runs the whole
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
// EMBED_PORT specifically, because these drive the provider's real callTool()
// and it embeds through the production client, which knows one port. A running
// Redstart owns that port, so this section skips rather than failing — the same
// bargain test-daemon-smoke.mjs makes, and CI always has the port to itself.
const embedPortFree = await new Promise(resolve => {
  embedStub.once('error', () => resolve(false))
  embedStub.listen(EMBED_PORT, '127.0.0.1', () => resolve(true))
})
resetEmbedFailureLog()
if (!embedPortFree) {
  console.log(`  SKIP - port ${EMBED_PORT} is in use; is a Redstart embedding server running?`)
}

const catalog = [
  { name: 'git_status', description: 'Show the working-tree status of a git repository' },
  { name: 'read_document', description: 'Read the text content of a document' },
  { name: 'web_fetch', description: 'Fetch a web page and return its article text' },
]

function catalogConfig(extra = {}) {
  return { toolRetrieval: { enabled: true }, ...extra }
}

if (embedPortFree) await test('search_tools is advertised only while retrieval is on', () => {
  assert(searchProvider.toolDefs({}).length === 0, 'a server with retrieval off advertised search_tools')
  assert(searchProvider.toolDefs({ toolRetrieval: { enabled: false } }).length === 0, 'an explicit off still advertised it')
  const defs = searchProvider.toolDefs(catalogConfig())
  assert(defs.length === 1 && defs[0].name === 'search_tools', 'retrieval on did not advertise it')
  assert(defs[0].inputSchema.required.includes('query'), 'query is not required')
})

if (embedPortFree) await test('🔒 a result carries names and descriptions, never schemas', async () => {
  searchProvider.setToolCatalogProvider(() => catalog.map(t => ({
    ...t,
    inputSchema: { type: 'object', properties: { secret_parameter: { type: 'string' } } },
  })))
  const result = await searchProvider.callTool('search_tools', { query: 'read a document' }, catalogConfig())
  const text = result.content[0].text
  assert(!/secret_parameter/.test(text), `a schema was returned: ${text}`)
  assert(!/inputSchema/.test(text), `a schema field was returned: ${text}`)
  const rows = JSON.parse(text)
  assert(rows.every(r => Object.keys(r).sort().join(',') === 'description,name'), `unexpected row shape: ${text}`)
})

if (embedPortFree) await test('🔒 the catalog it searches is the one the policy gate produced', async () => {
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

if (embedPortFree) await test('🔍 search_tools never returns itself', async () => {
  searchProvider.setToolCatalogProvider(() => [
    ...catalog,
    { name: 'search_tools', description: 'Find tools that are available but not currently listed' },
  ])
  const result = await searchProvider.callTool('search_tools', { query: 'find a tool' }, catalogConfig())
  assert(!/search_tools/.test(result.content[0].text), 'search_tools offered itself as a result')
})

if (embedPortFree) await test('🔍 a scorer that is down is reported as such, not as "no matches"', async () => {
  // Different answers. A model told nothing matched stops looking; one told the
  // search is unavailable keeps using what it can already see.
  searchProvider.setToolCatalogProvider(() => catalog)
  const down = await searchTools({ tools: catalog, query: 'anything', embed: async () => null })
  assert(down === null, 'a dead embedding server returned a list')
  const empty = await searchTools({ tools: [], query: 'anything', embed: async () => null })
  assert(Array.isArray(empty) && empty.length === 0, 'an empty catalog is an empty result, not a failure')
})

if (embedPortFree) await test('a blank query is refused rather than scored', async () => {
  searchProvider.setToolCatalogProvider(() => catalog)
  for (const bad of [{}, { query: '' }, { query: '   ' }, { query: 42 }]) {
    const result = await searchProvider.callTool('search_tools', bad, catalogConfig())
    assert(result.isError === true, `${JSON.stringify(bad)} was accepted as a query`)
  }
})

if (embedPortFree) await test('🔒 search_tools refuses to run when retrieval is off', async () => {
  searchProvider.setToolCatalogProvider(() => catalog)
  const result = await searchProvider.callTool('search_tools', { query: 'read a document' }, { toolRetrieval: { enabled: false } })
  assert(result.isError === true, 'a call succeeded on a server where retrieval is off')
})

if (embedPortFree) await test('search_tools declines a call that is not its own', async () => {
  const result = await searchProvider.callTool('git_status', {}, catalogConfig())
  assert(result === null, 'the provider answered for a tool it does not own')
})

if (embedPortFree) await test('🔍 results are ranked, best first', async () => {
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

if (embedPortFree) await new Promise(resolve => embedStub.close(resolve))

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
