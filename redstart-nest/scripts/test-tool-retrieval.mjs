// =============================================================================
// Invariant tests for daemon/tool-retrieval.mjs
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
  tokenize,
  createBm25Index,
  rescore,
  RRF_K,
  withheldToolNames,
  MAX_WITHHELD,
} from '../daemon/tool-retrieval.mjs'
import * as searchProvider from '../daemon/search-tools-provider.mjs'
const { retrievalStatus, syncRetrieval, applyToolsConfig, resetRetrievalState } = await import('../daemon/ipc/tools.mjs')
import { EMBED_MODEL } from '../daemon/embed-model.mjs'
import {
  filterRequestTools,
  searchTools,
  toolBudget,
  resetToolFilterState,
  setEmbedPortForTests,
  CONTEXT_BUDGET_FRACTION,
  resolveRetrievalSettings,
  RETRIEVAL_DEFAULTS,
  SCORER_DEFAULTS,
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
  const fused = rescore({ scored, keyword: new Map([['a', 5], ['c', 9]]), scorer: 'fused' })
  assert(fused.length === 3, 'a tool went missing')
  assert(fused.every((e, i) => i === 0 || fused[i - 1].score >= e.score), 'not sorted')
  const a = fused.find((e) => e.name === 'a').score
  const expectA = (1 / (RRF_K + 1) + 1 / (RRF_K + 2)) / (2 / (RRF_K + 1))
  assert(Math.abs(a - expectA) < 1e-12, `a scored ${a}, expected ${expectA}`)
  const top = rescore({ scored, keyword: new Map([['a', 5]]), scorer: 'fused' })[0]
  assert(top.name === 'a' && Math.abs(top.score - 1) < 1e-12, 'first by both is not 1')
})

await test('🔍 a keyword match lifts a tool the embedding ranked low', () => {
  const scored = scoredList([['web', 0.9], ['git', 0.85], ['vault', 0.3]])
  const fused = rescore({ scored, keyword: new Map([['vault', 4]]), scorer: 'fused' }).map((e) => e.name)
  assert(fused[0] === 'vault', `vault did not rise: ${fused}`)
})

await test('ties share a rank, so the alphabet does not decide between equal scores', () => {
  const scored = scoredList([['b', 1], ['z', 1], ['c', 0]])
  const fused = rescore({ scored, keyword: new Map(), scorer: 'fused' })
  assert(fused.find((e) => e.name === 'b').score === fused.find((e) => e.name === 'z').score, 'a tie was split')
})

await test('🔒 with no usable cosine score, fused leaves everything at 0, so the filter fails open', () => {
  const scored = scoredList([['a', 0], ['b', 0]])
  const fused = rescore({ scored, keyword: new Map([['a', 3]]), scorer: 'fused' })
  assert(fused.every((e) => e.score === 0), JSON.stringify(fused.map((e) => [e.name, e.score])))
})

await test('bm25 alone scores a non-match 0 and the best match 1; cosine is untouched', () => {
  const scored = scoredList([['a', 0.9], ['b', 0.1]])
  const kw = rescore({ scored, keyword: new Map([['b', 2]]), scorer: 'bm25' })
  assert(kw[0].name === 'b' && kw[0].score === 1 && kw[1].score === 0, JSON.stringify(kw.map((e) => [e.name, e.score])))
  assert(rescore({ scored, keyword: new Map([['b', 2]]), scorer: 'cosine' }) === scored, 'cosine was rescored')
})

await test('settings: the scorer brings its floors, an admin floor wins, an unknown scorer is the default', () => {
  const fused = resolveRetrievalSettings({ scorer: 'bm25' })
  assert(fused.relativeFloor === SCORER_DEFAULTS.bm25.relativeFloor, 'the scorer floors were not applied')
  assert(resolveRetrievalSettings({ scorer: 'bm25', relativeFloor: 0.5 }).relativeFloor === 0.5, 'an admin floor was overridden')
  assert(resolveRetrievalSettings({ scorer: 'nonsense' }).scorer === RETRIEVAL_DEFAULTS.scorer, 'an unknown scorer survived')
  assert(resolveRetrievalSettings(undefined).enabled === false, 'retrieval came on by default')
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

await test('a family comes together: one member selected brings the rest past the floor (memory, 2026-11-12)', () => {
  const MEM = ['memory_save', 'memory_search', 'memory_forget']
  const scored = scoredList([['memory_save', 0.9], ['read_document', 0.8], ['memory_search', 0.2], ['memory_forget', 0.1]])
  const names = selectTools({ scored, floor: 0.5, families: [MEM] }).selected.map(toolName)
  assert(MEM.every((n) => names.includes(n)), `the family was split: ${names}`)
  const none = selectTools({ scored: scoredList([['read_document', 0.9], ['memory_forget', 0.1]]), floor: 0.5, families: [MEM] }).selected.map(toolName)
  assert(!none.includes('memory_forget'), 'a family member came in with no member selected')
  const partial = selectTools({ scored: scoredList([['memory_save', 0.9]]), floor: 0.5, families: [MEM] }).selected.map(toolName)
  assert(partial.join() === 'memory_save', `a family member that was never offered appeared: ${partial}`)
})

await test('🔒 the tool filter keeps the memory tools together', async () => {
  const { TOOL_FAMILIES } = await import('../daemon/tool-filter.mjs')
  assert(TOOL_FAMILIES.some((f) => ['memory_save', 'memory_search', 'memory_forget'].every((n) => f.includes(n))), JSON.stringify(TOOL_FAMILIES))
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

await test('🔍 with dropAttachmentNote, a message with a note queries like the message without it (1.2, P3)', async () => {
  const { attachmentNote } = await import('../../shared/agent-core/attachment-note.mjs')
  const note = attachmentNote({ saved: ['sales.csv'], failed: ['big.zip (too large)'], conversationId: 'c1', hasTool: () => true })
  assert(note && note.includes('read_text_file'), 'setup: the note should name the File System tools')
  const bare = [{ role: 'user', content: 'total the sales by region' }]
  const withNote = [{ role: 'user', content: `total the sales by region\n\n${note}` }]
  const a = conversationQueryText(bare, { dropAttachmentNote: true })
  const b = conversationQueryText(withNote, { dropAttachmentNote: true })
  assert(a === b, `the note leaked into the query: ${JSON.stringify(b)}`)
  // Off (text version 1), the query is what it always was.
  assert(conversationQueryText(withNote).includes('read_text_file'), 'version 1 changed the query')
  // A message that is only the note queries as nothing at all.
  assert(conversationQueryText([{ role: 'user', content: note }], { dropAttachmentNote: true }) === '', 'a note-only message left text')
})

await test('stripAttachmentNote leaves the user\'s own words alone', async () => {
  const { stripAttachmentNote } = await import('../../shared/agent-core/attachment-note.mjs')
  const inline = 'I typed [Attached file saved to this chat\'s workspace: x] in the middle and kept going'
  assert(stripAttachmentNote(inline) === inline, 'a marker mid-line was cut')
  const unclosed = "hello\n[Attached file saved to this chat's workspace: x and then more words"
  assert(stripAttachmentNote(unclosed) === unclosed, 'an unclosed marker was cut')
  assert(stripAttachmentNote('plain') === 'plain', 'plain text changed')
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

console.log('\n-- freezing and the minimum (second pass 4.1, 4.2) --')

await test('🔒 a frozen set stays byte-identical while the query drifts, and counts what it left out', () => {
  const previous = ['a', 'b']
  const turn1 = scoredList([['a', 0.9], ['b', 0.8], ['c', 0.1], ['d', 0.1]])
  const turn2 = scoredList([['c', 0.95], ['d', 0.9], ['a', 0.2], ['b', 0.1]])
  const one = selectTools({ scored: turn1, previous, growth: 'pins-only', relativeFloor: 0.85 })
  const two = selectTools({ scored: turn2, previous, growth: 'pins-only', relativeFloor: 0.85 })
  assert(JSON.stringify(one.selected) === JSON.stringify(two.selected), 'the frozen set changed with the query')
  assert(two.selected.map(toolName).join() === 'a,b', `got ${two.selected.map(toolName)}`)
  assert(two.wouldAdd === 2 && two.reason === 'frozen', `wouldAdd ${two.wouldAdd}, reason ${two.reason}`)
  const scoredGrowth = selectTools({ scored: turn2, previous, relativeFloor: 0.85 })
  assert(scoredGrowth.selected.length === 4 && scoredGrowth.wouldAdd === 0, 'setup: scored growth should add c and d')
})

await test('🔍 a frozen set still takes a pin (a search hit, a call) and its family', () => {
  const scored = scoredList([['a', 0.9], ['found', 0.1], ['memory_save', 0.1], ['memory_forget', 0.1]])
  const out = selectTools({ scored, previous: ['a'], pins: ['found', 'memory_save'], growth: 'pins-only', families: [['memory_save', 'memory_forget']] })
  assert(out.selected.map(toolName).join() === 'a,found,memory_forget,memory_save', `got ${out.selected.map(toolName)}`)
})

await test('🔒 a frozen set loses a tool the request no longer carries', () => {
  const out = selectTools({ scored: scoredList([['a', 0.9]]), previous: ['a', 'banned_since'], growth: 'pins-only' })
  assert(out.selected.map(toolName).join() === 'a', `a tool not offered survived: ${out.selected.map(toolName)}`)
})

await test('a first selection is never frozen: pins-only with no previous selects by score', () => {
  const out = selectTools({ scored: scoredList([['a', 0.9], ['b', 0.85], ['c', 0.1]]), growth: 'pins-only', relativeFloor: 0.85 })
  assert(out.selected.map(toolName).join() === 'a,b', `got ${out.selected.map(toolName)}`)
})

await test('🔍 minTools tops up a first selection by score, pins not counted, inside the budget', () => {
  const scored = scoredList([['a', 0.9], ['b', 0.5], ['c', 0.4], ['d', 0.3], ['p', 0.0]])
  const out = selectTools({ scored, pins: ['p'], relativeFloor: 0.85, minTools: 3 })
  assert(out.selected.map(toolName).join() === 'a,b,c,p', `got ${out.selected.map(toolName)}`)
  const cost = estimateToolTokens(scored[0].tool)
  const tight = selectTools({ scored, relativeFloor: 0.85, minTools: 3, budgetTokens: cost * 2 })
  assert(tight.selected.length === 2 && tight.reason === 'budget', `the minimum broke the budget: ${tight.selected.map(toolName)}`)
  const later = selectTools({ scored, previous: ['a'], relativeFloor: 0.85, minTools: 3 })
  assert(later.selected.map(toolName).join() === 'a', `the minimum applied to a later turn: ${later.selected.map(toolName)}`)
})

await test('🔍 a withheld tool is never chosen by score, by the minimum or by a family (benchmarks H2)', () => {
  const scored = scoredList([['a', 0.9], ['b', 0.89], ['c', 0.4], ['d', 0.3]])
  const byScore = selectTools({ scored, relativeFloor: 0.85, withhold: ['a'] })
  assert(byScore.selected.map(toolName).join() === 'b', `by score: ${byScore.selected.map(toolName)}`)
  const byMinimum = selectTools({ scored, relativeFloor: 0.85, minTools: 3, withhold: ['c'] })
  assert(byMinimum.selected.map(toolName).join() === 'a,b,d', `by the minimum: ${byMinimum.selected.map(toolName)}`)
  const byFamily = selectTools({ scored, relativeFloor: 0.85, families: [['a', 'c']], withhold: ['c'] })
  assert(!byFamily.selected.map(toolName).includes('c'), `by a family: ${byFamily.selected.map(toolName)}`)
  const none = selectTools({ scored, relativeFloor: 0.85 })
  assert(none.selected.map(toolName).join() === 'a,b', 'an empty withhold changes nothing')
})

await test('🔍 a pinned or carried tool is not withheld: once found, it stays (benchmarks H2)', () => {
  const scored = scoredList([['a', 0.9], ['b', 0.89], ['found', 0.1]])
  const pinned = selectTools({ scored, pins: ['found'], relativeFloor: 0.85, withhold: ['found'] })
  assert(pinned.selected.map(toolName).includes('found'), `a search hit was withheld: ${pinned.selected.map(toolName)}`)
  const carried = selectTools({ scored, previous: ['a', 'found'], relativeFloor: 0.85, withhold: ['found'] })
  assert(carried.selected.map(toolName).includes('found'), `a carried tool was withheld: ${carried.selected.map(toolName)}`)
})

await test('withheldToolNames keeps short strings from a short array, and nothing from anything else', () => {
  assert(withheldToolNames(['a', 7, '', 'b']).join() === 'a,b', 'filtering')
  for (const bad of ['a', null, { a: 1 }, Array.from({ length: MAX_WITHHELD + 1 }, () => 'x')]) {
    assert(withheldToolNames(bad).length === 0, `accepted ${JSON.stringify(bad).slice(0, 40)}`)
  }
  assert(withheldToolNames(['x'.repeat(129)]).length === 0, 'a 129-character name')
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

await test('🔒 ask_user is never dropped, though it matches no task', async () => {
  // Host-resolved tools score against nothing in particular. Dropped, the
  // model reads its absence as "you may not ask" (agent-runtime plan §4, 1.1).
  resetToolFilterState()
  const ask_user = fnTool('ask_user', 'Ask the user a question and wait for the answer')
  const out = await filterRequestTools({ tools: [...allTools, ask_user], messages: ask, settings: { enabled: true }, embed })
  const names = out.map(toolName)
  assert(names.includes('ask_user'), `ask_user was filtered away: ${names.join(',')}`)
  assert(!names.includes('web_fetch'), `the pin widened the selection: ${names.join(',')}`)
})

await test('🔒 the ask_user pin adds nothing the request did not carry', async () => {
  resetToolFilterState()
  const out = await filterRequestTools({ tools: allTools, messages: ask, settings: { enabled: true }, embed })
  assert(!out.map(toolName).includes('ask_user'), 'a pin invented a tool the client never sent')
})

await test('🔒 the memory tools are kept on a turn whose query scores them low (second pass 1.1, P1)', async () => {
  resetToolFilterState()
  const mem = ['memory_save', 'memory_search', 'memory_forget'].map((n) => fnTool(n, 'zzz'))
  const out = await filterRequestTools({ tools: [...allTools, ...mem], messages: ask, settings: { enabled: true }, embed })
  const names = out.map(toolName)
  for (const n of ['memory_save', 'memory_search', 'memory_forget']) assert(names.includes(n), `${n} was dropped: ${names.join(',')}`)
  assert(!names.includes('web_fetch'), `the pin widened the selection: ${names.join(',')}`)
})

await test('🔒 a request with no memory tools gets none, and a banned (absent) memory_forget stays out', async () => {
  resetToolFilterState()
  const none = await filterRequestTools({ tools: allTools, messages: ask, settings: { enabled: true }, embed })
  assert(!none.map(toolName).some((n) => n.startsWith('memory_')), 'a pin invented a memory tool')
  resetToolFilterState()
  // A ban runs before retrieval, so a banned tool is simply not in the list.
  const two = ['memory_save', 'memory_search'].map((n) => fnTool(n, 'zzz'))
  const out = (await filterRequestTools({ tools: [...allTools, ...two], messages: ask, settings: { enabled: true }, embed })).map(toolName)
  assert(out.includes('memory_save') && !out.includes('memory_forget'), `got ${out.join(',')}`)
})

await test('🔍 text version 2 scores the request without its attachment note; version 1 as before', async () => {
  const messages = [{ role: 'user', content: "what changed in the repo\n\n[Attached file saved to this chat's workspace: web.txt]" }]
  resetToolFilterState()
  const v1 = (await filterRequestTools({ tools: allTools, messages, settings: { enabled: true }, embed })).map(toolName)
  resetToolFilterState()
  const v2 = (await filterRequestTools({ tools: allTools, messages, settings: { enabled: true, textVersion: 2 }, embed })).map(toolName)
  assert(v1.includes('web_fetch'), `setup: version 1 should read the note: ${v1}`)
  assert(!v2.includes('web_fetch') && v2.includes('git_status'), `version 2 read the note: ${v2}`)
})

await test('🔍 the fused scorer, end to end: a keyword the embedding misses still selects its tool', async () => {
  // The query embeds along "repo" alone; "document" is a keyword match only.
  // Three axes, as the tools' cached vectors have (the store is shared).
  const messages = [{ role: 'user', content: 'what changed in the repo, and read the document' }]
  const onlyRepo = keywordEmbed(['repo', 'zzz', 'yyy'])
  resetToolFilterState()
  const cos = (await filterRequestTools({ tools: allTools, messages, settings: { enabled: true, scorer: 'cosine' }, embed: onlyRepo })).map(toolName)
  resetToolFilterState()
  const fused = (await filterRequestTools({ tools: allTools, messages, settings: { enabled: true, scorer: 'fused', relativeFloor: 0.7 }, embed: onlyRepo })).map(toolName)
  assert(!cos.includes('read_document'), `setup: cosine should miss it: ${cos}`)
  assert(fused.includes('read_document') && fused.includes('git_status'), `fused missed it: ${fused}`)
})

await test('🔒 search_tools is pinned when the request carries it', async () => {
  resetToolFilterState()
  const st = fnTool('search_tools', 'zzz')
  const out = (await filterRequestTools({ tools: [...allTools, st], messages: ask, settings: { enabled: true }, embed })).map(toolName)
  assert(out.includes('search_tools'), `search_tools was dropped: ${out}`)
})

await test('the filter freezes with growth pins-only and passes minTools through', async () => {
  resetToolFilterState()
  const settings = { enabled: true, growth: 'pins-only', scorer: 'cosine' }
  const first = (await filterRequestTools({ tools: allTools, messages: ask, settings, embed })).map(toolName)
  const turn2 = [...ask, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'now read a document' }]
  const second = (await filterRequestTools({ tools: allTools, messages: turn2, settings: { ...settings, margin: 0 }, embed })).map(toolName)
  assert(first.join() === second.join(), `the frozen set moved: ${first} -> ${second}`)
  resetToolFilterState()
  const min = (await filterRequestTools({ tools: allTools, messages: ask, settings: { enabled: true, minTools: 3, scorer: 'cosine' }, embed })).map(toolName)
  assert(min.length === 3, `minTools did not top up: ${min}`)
})

await test('🔍 with a conversation id, the set survives the first message being compacted away (4.3)', async () => {
  resetToolFilterState()
  const settings = { enabled: true, growth: 'pins-only', scorer: 'cosine' }
  const first = (await filterRequestTools({ tools: allTools, messages: ask, conversationId: 'conv-1', settings, embed })).map(toolName)
  const compacted = [{ role: 'system', content: '[Conversation summary] the repo' }, { role: 'user', content: 'now read a document' }]
  const kept = (await filterRequestTools({ tools: allTools, messages: compacted, conversationId: 'conv-1', settings: { ...settings, margin: 0 }, embed })).map(toolName)
  assert(kept.join() === first.join(), `the id did not carry the set: ${first} -> ${kept}`)
  const lost = (await filterRequestTools({ tools: allTools, messages: compacted, settings: { ...settings, margin: 0 }, embed })).map(toolName)
  assert(lost.join() !== first.join(), 'setup: without the id the compacted conversation should select afresh')
})

await test('🔒 conversation ids are per account, and a malformed id falls back to the hash', () => {
  assert(conversationKey(ask, 'alice', 'c1') !== conversationKey(ask, 'bob', 'c1'), 'two accounts shared an id key')
  assert(conversationKey(ask, 'alice', 'c1') !== conversationKey(ask, 'alice'), 'the id was ignored')
  for (const bad of ['', 'x'.repeat(129), 'has space', 'tab\t', 42, null, { id: 1 }]) {
    assert(conversationKey(ask, 'alice', bad) === conversationKey(ask, 'alice'), `${JSON.stringify(bad)} was used as an id`)
  }
})

await test('🔍 the record says when and why each tool came in, and keeps a tool\'s first reason (6.1)', async () => {
  resetToolFilterState()
  const tools = [...allTools, fnTool('search_tools', 'find tools')]
  const settings = { enabled: true, scorer: 'cosine', margin: 0 }
  const r1 = {}
  await filterRequestTools({ tools, messages: ask, conversationId: 'rec', settings, embed, record: r1 })
  assert(r1.origins.git_status.why === 'first' && r1.origins.git_status.turn === 1, JSON.stringify(r1.origins))
  assert(r1.origins.search_tools.why === 'always', JSON.stringify(r1.origins))
  const turn2 = [...ask,
    { role: 'assistant', tool_calls: [{ id: 's1', function: { name: 'search_tools', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 's1', content: JSON.stringify({ match: 'close', tools: [{ name: 'web_fetch' }] }) },
    { role: 'user', content: 'now read a document' }]
  const r2 = {}
  await filterRequestTools({ tools, messages: turn2, conversationId: 'rec', settings, embed, record: r2 })
  assert(r2.origins.git_status.why === 'first' && r2.origins.git_status.turn === 1, `the first reason was lost: ${JSON.stringify(r2.origins)}`)
  assert(r2.origins.web_fetch?.why === 'search' && r2.origins.web_fetch.turn === 2, JSON.stringify(r2.origins))
  assert(r2.origins.read_document?.why === 'scored', JSON.stringify(r2.origins))
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

await test('search_tools is advertised only while retrieval is on', () => {
  assert(searchProvider.toolDefs({}).length === 0, 'a server with retrieval off advertised search_tools')
  assert(searchProvider.toolDefs({ toolRetrieval: { enabled: false } }).length === 0, 'an explicit off still advertised it')
  const defs = searchProvider.toolDefs(catalogConfig())
  assert(defs.map((d) => d.name).join() === 'search_tools,describe_tool', `retrieval on advertised ${defs.map((d) => d.name)}`)
  assert(defs[0].inputSchema.required.includes('query'), 'query is not required')
  // call_tool only when an admin turns it on (5.5, U4).
  const withCall = searchProvider.toolDefs(catalogConfig({ toolRetrieval: { enabled: true, callTool: true } }))
  assert(withCall.map((d) => d.name).includes('call_tool'), 'callTool on did not advertise call_tool')
})

await test('🔒 a result carries names, descriptions, category and store, never schemas', async () => {
  searchProvider.setToolCatalogProvider(() => catalog.map(t => ({
    ...t,
    inputSchema: { type: 'object', properties: { secret_parameter: { type: 'string' } } },
  })))
  const result = await searchProvider.callTool('search_tools', { query: 'read a document' }, catalogConfig())
  const text = result.content[0].text
  assert(!/secret_parameter/.test(text), `a schema was returned: ${text}`)
  assert(!/inputSchema/.test(text), `a schema field was returned: ${text}`)
  const rows = JSON.parse(text).tools
  assert(rows.every(r => Object.keys(r).sort().join(',') === 'category,description,name,store'), `unexpected row shape: ${text}`)
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

console.log('\n-- discovery: widening, describe_tool, call_tool (second pass 5.x) --')

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
  searchProvider.setToolCatalogProvider(() => catalog)
  // The stub gives a query with no keyword a vector along the web axis at
  // 0.01; with an absolute floor above every score, nothing is close.
  const cfg = { toolRetrieval: { enabled: true, scorer: 'cosine', floor: 2 } }
  const body = searchJson(await searchProvider.callTool('search_tools', { query: 'zzz' }, cfg))
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
  searchProvider.setToolCatalogProvider(() => [...catalog, { name: 'describe_tool', description: 'describe a tool' }, { name: 'call_tool', description: 'call a tool' }])
  const text = (await searchProvider.callTool('search_tools', { query: 'describe a tool, call a tool' }, catalogConfig())).content[0].text
  assert(!/describe_tool|call_tool|search_tools/.test(text), text)
})

await test('🔒 describe_tool returns the schema of a catalog tool, and the same words for banned and unknown', async () => {
  searchProvider.setToolCatalogProvider(() => catalog.map((t) => ({ ...t, inputSchema: { type: 'object', properties: { path: { type: 'string' } } } })))
  const ok = searchJson(await searchProvider.callTool('describe_tool', { name: 'read_document' }, catalogConfig()))
  assert(ok.name === 'read_document' && ok.inputSchema.properties.path && ok.category === 'documents', JSON.stringify(ok))
  // A ban is absence from the post-policy catalog.
  searchProvider.setToolCatalogProvider(() => catalog.filter((t) => t.name !== 'read_document'))
  const banned = await searchProvider.callTool('describe_tool', { name: 'read_document' }, catalogConfig())
  const unknown = await searchProvider.callTool('describe_tool', { name: 'no_such_tool' }, catalogConfig())
  assert(banned.isError && unknown.isError, 'not refused')
  assert(banned.content[0].text.replace('read_document', 'X') === unknown.content[0].text.replace('no_such_tool', 'X'), 'a ban reads differently from absence')
  const self = await searchProvider.callTool('describe_tool', { name: 'search_tools' }, catalogConfig())
  assert(self.isError, 'a discovery tool was describable')
})

await test('🔍 a described tool, and search hits, become pins through tool_call_id (no name on the message)', () => {
  const pins = pinsFromMessages([
    { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'describe_tool' } }, { id: 'c2', function: { name: 'search_tools' } }] },
    { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ name: 'vault_get', inputSchema: {} }) },
    { role: 'tool', tool_call_id: 'c2', content: JSON.stringify({ match: 'close', tools: [{ name: 'git_log' }] }) },
  ])
  assert(pins.has('vault_get') && pins.has('git_log'), `pins: ${[...pins]}`)
  const forged = pinsFromMessages([
    { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'web_fetch' } }] },
    { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ name: 'delete_everything' }) },
  ])
  assert(!forged.has('delete_everything'), 'a result from another tool named a pin')
})

await test('🔒 call_tool is off by default, and then not even answered', async () => {
  searchProvider.setToolCatalogProvider(() => catalog)
  assert(!searchProvider.toolDefs(catalogConfig()).some((d) => d.name === 'call_tool'), 'advertised while off')
  assert(await searchProvider.callTool('call_tool', { name: 'git_status' }, catalogConfig()) === null, 'answered while off')
})

await test('🔒 call_tool proxies a read through the policy-checked caller, and refuses what needs approval', async () => {
  const cfg = { toolRetrieval: { enabled: true, callTool: true } }
  const writes = [{ name: 'create_document', description: 'Create a document' }, { name: 'memory_forget', description: 'Forget' }, { name: 'ask_user', description: 'Ask' }]
  searchProvider.setToolCatalogProvider(() => [...catalog, ...writes])
  const calls = []
  searchProvider.setToolCaller(async (account, name, args, opts) => { calls.push({ account, name, args, opts }); return { content: [{ type: 'text', text: 'ok' }] } })
  const ok = await searchProvider.callTool('call_tool', { name: 'git_status', arguments: { repo: 'x' } }, cfg, { account: { username: 'u' }, conversationId: 'conv' })
  assert(ok.content[0].text === 'ok' && calls.length === 1 && calls[0].name === 'git_status' && calls[0].args.repo === 'x', JSON.stringify(calls))
  assert(calls[0].account.username === 'u' && calls[0].opts.conversationId === 'conv', 'the caller identity was not passed')
  for (const name of ['create_document', 'memory_forget', 'ask_user', 'call_tool', 'search_tools']) {
    const r = await searchProvider.callTool('call_tool', { name }, cfg, {})
    assert(r.isError, `${name} went through call_tool`)
  }
  assert(calls.length === 1, `a refused call reached the caller: ${calls.map((c) => c.name)}`)
  searchProvider.setToolCatalogProvider(() => catalog.filter((t) => t.name !== 'git_status'))
  const banned = await searchProvider.callTool('call_tool', { name: 'git_status' }, cfg, {})
  assert(banned.isError && calls.length === 1, 'a banned tool was called by name')
})

await test('🔒 the discovery tools are never embedded', async () => {
  resetToolFilterState()
  const seen = []
  const watching = async (texts) => { seen.push(...texts); return embed(texts) }
  const tools = [...allTools, fnTool('search_tools', 'find tools'), fnTool('describe_tool', 'describe one')]
  const out = (await filterRequestTools({ tools, messages: ask, settings: { enabled: true }, embed: watching })).map(toolName)
  assert(!seen.some((t) => /^(search_tools|describe_tool):/.test(t)), `embedded: ${seen.filter((t) => /_tool/.test(t))}`)
  assert(out.includes('search_tools') && out.includes('describe_tool'), `the discovery tools were not pinned: ${out}`)
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
