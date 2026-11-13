// =============================================================================
// Tool retrieval eval — the frozen subset, the metrics, the catalog snapshot
// =============================================================================
// Tool retrieval second pass, 0.4. The full eval (retrieval-eval/run.mjs)
// needs a real embedding server and is run by hand. This runs in CI:
//
//   - every case frozen as right (frozen.json) is still right, scored through
//     the production scorer with the stored bge vectors. A ranking change that
//     drops a known case fails the build; one that fixes a miss does not (it
//     is a reason to refreeze)
//   - the metrics' arithmetic, on cases small enough to check by hand
//   - case validation refuses what it should
//   - catalog.json still matches what the providers serve, so the eval is not
//     scoring descriptions the code no longer has
//
// Run:  node scripts/test-retrieval-eval.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { registerElectronStub } from './electron-stub-hooks.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-retrieval-eval-test-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmp
registerElectronStub()
await import('./electron-stub.mjs')

const lib = await import('./retrieval-eval/lib.mjs')

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

const catalog = lib.loadCatalog()
const names = new Set(catalog.map((t) => t.name))
const wire = lib.toWireTools(catalog)
const frozen = JSON.parse(fs.readFileSync(lib.FROZEN_FILE, 'utf8'))

console.log('\n-- the frozen subset --')

await test('🔍 the freeze was made against this catalog', async () => {
  eq(frozen.catalogHash, lib.catalogHash(catalog), 'catalog.json changed since the freeze: run retrieval-eval/run.mjs --freeze')
})

await test('🔍 every case frozen as right is still right, through the production scorer', async () => {
  const cases = new Map(lib.loadCases(names).map((c) => [c.id, c]))
  const embed = lib.frozenEmbedder(frozen.vectors)
  const broken = []
  for (const id of frozen.cases) {
    const c = cases.get(id)
    assert(c, `frozen case ${id} is no longer in the case set: refreeze`)
    const scored = await lib.scoreCase(c, { wire, embed })
    if (!lib.frozenCaseOk(c, scored)) {
      broken.push(`${id}: wants ${c.expected.join('|')}; top 3 ${scored.ranking.slice(0, 3).join(' ')}${scored.selected ? `; sent ${scored.selected.join(' ')}` : ''}`)
    }
  }
  assert(broken.length === 0, `a change dropped ${broken.length} known case(s):\n        ${broken.join('\n        ')}`)
  return `${frozen.cases.length} cases`
})

console.log('\n-- the metrics --')

await test('recall@K, precision@K and the reciprocal rank, need any and all', async () => {
  const scored = { ranking: ['a', 'b', 'c', 'd', 'e'], selected: ['a', 'c'] }
  const any = lib.caseMetrics(['c', 'e'], scored)
  eq([any.ranks, any.reciprocalRank, any.at[1].recall, any.at[3].recall, any.at[3].precision, any.at[5].precision], [[3, 5], 1 / 3, 0, 1, 1 / 3, 2 / 5], 'any')
  eq(any.selectedRecall, 1, 'any: one of them was sent')
  const all = lib.caseMetrics(['c', 'e'], scored, 'all')
  eq([all.at[3].recall, all.at[5].recall, all.selectedRecall], [0.5, 1, 0.5], 'all: shares')
  eq(lib.caseMetrics(['zz'], scored).ranks, [6], 'a tool missing from the ranking ranks after everything')
  eq(lib.caseMetrics(['a'], { ranking: ['a'], selected: null }).selectedSize, null, 'a search case has no selection')
})

await test('aggregate: means overall and per source, selections only where there are some', async () => {
  const row = (source, rr, sel) => ({
    case: { source }, ms: 2,
    metrics: { reciprocalRank: rr, at: Object.fromEntries(lib.KS.map((k) => [k, { recall: rr, precision: rr / k }])), selectedRecall: sel, selectedSize: sel === null ? null : 4 },
  })
  const a = lib.aggregate([row('x', 1, 1), row('x', 0.5, null), row('y', 0, 0)])
  eq([a.all.cases, a.all.mrr, a.all.selectedRecall, a.bySource.x.mrr, a.bySource.y.cases], [3, 0.5, 0.5, 0.75, 1], 'means')
})

await test('frozenCaseOk: top 3 for a search case, the needed tools sent for a selection case', async () => {
  const s = (ranking, selected = null) => ({ ranking, selected })
  assert(lib.frozenCaseOk({ kind: 'search', expected: ['c'] }, s(['a', 'b', 'c'])), 'third is in')
  assert(!lib.frozenCaseOk({ kind: 'search', expected: ['d'] }, s(['a', 'b', 'c', 'd'])), 'fourth is out')
  assert(!lib.frozenCaseOk({ kind: 'search', expected: ['a', 'd'], need: 'all' }, s(['a', 'b', 'c', 'd'])), 'all needs every one')
  assert(lib.frozenCaseOk({ kind: 'selection', expected: ['x', 'y'] }, s(['x'], ['y'])), 'any: one sent is enough')
  assert(!lib.frozenCaseOk({ kind: 'selection', expected: ['x', 'y'], need: 'all' }, s(['x'], ['y'])), 'all: both must be sent')
})

await test('the frozen embedder names a missing text and says how to fix it', async () => {
  let e = null
  try { await lib.frozenEmbedder({})(['an unseen query']) } catch (err) { e = err }
  assert(/no stored vector for "an unseen query".*--freeze/.test(e?.message ?? ''), e?.message)
  const rec = lib.recordingEmbedder(async (texts) => texts.map(() => Float32Array.from([1, 2, 3])))
  await rec.embed(['t'])
  eq([...(await lib.frozenEmbedder(rec.seen)(['t']))[0]], [1, 2, 3], 'a recorded vector round-trips')
})

console.log('\n-- the cases --')

await test('the case set loads, bench tasks included, and each source is there', async () => {
  const cases = lib.loadCases(names)
  const sources = [...new Set(cases.map((c) => c.source))].sort()
  eq(sources, ['attachment', 'bench', 'bench-attachment', 'small-model', 'transcript', 'user-phrasing'], 'sources')
  // run_command does not exist yet (agent-runtime Phase 4): its tasks keep run_python.
  assert(cases.filter((c) => c.id.startsWith('bench:')).length === 32, 'every bench task became a case')
  const att = cases.find((c) => c.id === 'a-read-file')
  assert(/Attached file saved to this chat's workspace: letter\.txt/.test(lib.caseMessages(att)[0].content), 'the attachment note was appended')
  return `${cases.length} cases`
})

await test('validation refuses an unknown tool, a missing query, a bad need, a duplicate id', async () => {
  const ok = { id: 'x', kind: 'search', query: 'q', expected: ['run_python'], source: 's' }
  const bad = [
    [{ ...ok, expected: ['no_such_tool'] }, /does not have: no_such_tool/],
    [{ ...ok, query: ' ' }, /needs a query/],
    [{ ...ok, need: 'some' }, /need must be any or all/],
    [{ ...ok, attachments: ['a.csv'] }, /attachments/],
    [{ ...ok, source: '' }, /source is required/],
  ]
  for (const [c, re] of bad) {
    let e = null
    try { lib.validateCases([c], names) } catch (err) { e = err }
    assert(re.test(e?.message ?? ''), `${JSON.stringify(c)}: ${e?.message}`)
  }
  let dup = null
  try { lib.validateCases([ok, ok], names) } catch (err) { dup = err }
  assert(/duplicate id/.test(dup?.message ?? ''), 'a duplicate id was accepted')
})

console.log('\n-- the catalog snapshot --')

await test('🔍 catalog.json matches what the providers serve (the File System tools by name)', async () => {
  // The File System tools need their child process (build-catalog.mjs starts
  // it). Here they are checked by name against the allowlist the provider
  // serves from; every other tool is compared field for field.
  const { activeToolCatalog } = await import('../daemon/mcp-server.mjs')
  const { FILESYSTEM_TOOL_NAMES } = await import('../daemon/filesystem-mcp-provider.mjs')
  const fsNames = new Set(FILESYSTEM_TOOL_NAMES)
  const live = activeToolCatalog(lib.fullCatalogConfig(tmp), lib.catalogContext()).map(lib.toCatalogEntry)
  const snapshot = catalog.filter((t) => !fsNames.has(t.name))
  eq(live.map((t) => t.name), snapshot.map((t) => t.name), 'tool names (rebuild with retrieval-eval/build-catalog.mjs)')
  for (const t of live) {
    eq(t, snapshot.find((s) => s.name === t.name), `${t.name} changed (rebuild with retrieval-eval/build-catalog.mjs, then --freeze)`)
  }
  const fsInSnapshot = catalog.filter((t) => fsNames.has(t.name)).map((t) => t.name).sort()
  eq(fsInSnapshot, [...fsNames].filter((n) => catalog.some((t) => t.name === n)).sort(), 'File System names')
  assert(fsInSnapshot.length >= 10, `only ${fsInSnapshot.length} File System tools in the snapshot`)
  return `${live.length} in-process tools, ${fsInSnapshot.length} File System tools`
})

fs.rmSync(tmp, { recursive: true, force: true })
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
