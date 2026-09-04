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
} from '../electron/main/tool-retrieval.mjs'

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

await test('an empty request selects nothing without throwing', () => {
  const { selected, dropped, reason } = selectTools({ scored: [] })
  assert(selected.length === 0 && dropped.length === 0 && reason === 'all-selected', 'an empty tool list should be a no-op')
})

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
