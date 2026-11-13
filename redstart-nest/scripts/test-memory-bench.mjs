// =============================================================================
// The memory bench harness, with no model (agent-runtime Phase 8.0)
// =============================================================================
// The real bench needs a loaded model and is run by hand. This suite tests
// everything around the model, so a number in the "Memory bench" table means
// what it says:
//
//   - every case loads, and its expectations pass its written right answer
//     and fail its written wrong one (a case that cannot tell them apart
//     measures nothing)
//   - a malformed case fails at load, naming the file and the field
//   - the scorer: term groups, targets, scope, kind (checked only when the op
//     carries one), forbid, strict, extra ops
//   - the frozen v1 reviewer builds the same request the daemon builds today
//     (until 8.2 replaces the daemon's; then this check retires itself)
//   - the runner end to end against a scripted model: files written, raw and
//     filtered scored apart, think on raises the budget, v2 refused before 8.2
//
// Run:  node scripts/test-memory-bench.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findCaseFiles, loadCase, caseWorld, GROUPS } from './memory-bench/lib/case-file.mjs'
import { opsFromRaw, opsFromFiltered, scoreCase, termsMatch } from './memory-bench/lib/score.mjs'
import { variant as v1 } from './memory-bench/lib/v1.mjs'
import { main, parseArgs, runCase, withThinking, loadVariant, THINK_MAX_TOKENS } from './memory-bench/run.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const CASES = path.join(here, 'memory-bench', 'cases')

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

const cases = findCaseFiles(CASES).map(loadCase)

console.log('\n-- the cases --')

await test('every case loads; the groups have the plan\'s sizes', () => {
  const by = Object.fromEntries(GROUPS.map((g) => [g, cases.filter((c) => c.group === g).length]))
  eq(by, { facts: 5, corrections: 6, confirmations: 3, state: 5, retractions: 3, injection: 5, secrets: 2, nothing: 3 }, 'group sizes')
  return `${cases.length} cases`
})

await test('every case: its right answer passes and its wrong answer fails', () => {
  const bad = []
  for (const c of cases) {
    const right = scoreCase(c, opsFromRaw({ ops: c.answers.right }))
    const wrong = scoreCase(c, opsFromRaw({ ops: c.answers.wrong }))
    if (!right.pass) bad.push(`${c.id}: right failed (${right.reason})`)
    if (wrong.pass) bad.push(`${c.id}: wrong passed`)
  }
  assert(bad.length === 0, bad.join('\n        '))
  return `${cases.length} × 2`
})

await test('every injection case has a forbid that the wrong answer trips', () => {
  for (const c of cases.filter((x) => x.group === 'injection')) {
    assert(c.forbid.length > 0, `${c.id} has no forbid`)
    assert(scoreCase(c, opsFromRaw({ ops: c.answers.wrong })).forbidHits > 0, `${c.id}: the wrong answer trips no forbid`)
  }
})

await test('a malformed case fails at load, naming the file and the field', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bench-bad-'))
  const write = (name, obj) => { const p = path.join(dir, `${name}.json`); fs.writeFileSync(p, JSON.stringify(obj)); return p }
  const base = { group: 'facts', messages: [{ role: 'user', content: 'hi' }], expect: [{ op: 'add', terms: [['x']] }], answers: { right: [], wrong: [] } }
  const cases = [
    [write('a', { ...base, id: 'b' }), /does not match the file name/],
    [write('c', { ...base, id: 'c', group: 'misc' }), /group must be one of/],
    [write('d', { ...base, id: 'd', expect: [{ op: 'update', terms: [['x']] }] }), /needs target/],
    [write('e', { ...base, id: 'e', expect: [{ op: 'add', terms: [] }] }), /terms must be a non-empty list/],
    [write('f', { ...base, id: 'f', answers: undefined }), /answers\.right and answers\.wrong/],
    [write('g', { ...base, id: 'g', strict: true }), /a strict case expects nothing/],
    [write('h', { ...base, id: 'h', expect: [{ op: 'update', target: 'nope', terms: [['x']] }] }), /not an existing memory/],
  ]
  for (const [file, re] of cases) {
    let err = null
    try { loadCase(file) } catch (e) { err = e }
    assert(err && re.test(err.message) && err.message.startsWith(path.basename(file)), `${path.basename(file)}: ${err?.message}`)
  }
  fs.rmSync(dir, { recursive: true, force: true })
  return `${cases.length} cases`
})

await test('a case\'s world: one branch in order, tool calls as stored, memories with ages, the project', () => {
  const c = cases.find((x) => x.id === 'corr-ask-before-delete')
  const w = caseWorld(c)
  const roles = w.conversation.messages.slice(1).map((m) => m.role)
  eq(roles, ['user', 'assistant', 'tool', 'tool', 'assistant', 'user'], 'roles')
  eq(JSON.parse(w.conversation.messages[2].toolCalls).map((t) => t.function.name), ['delete_file', 'delete_file'], 'tool calls')
  eq(w.conversation.currNode, 'm6', 'tip')
  const k = caseWorld(cases.find((x) => x.id === 'state-update-kitchen'))
  eq([k.project.name, k.projectMemories[0].kind, typeof k.projectMemories[0].asOf], ['Kitchen renovation', 'state', 'string'], 'project memory')
})

console.log('\n-- the scorer --')

await test('term groups: every group needs one alternative, in text or why, any case', () => {
  assert(termsMatch([['Alpha', 'beta'], ['gamma']], { text: 'BETA and', why: 'Gamma' }), 'matches across text and why')
  assert(!termsMatch([['alpha'], ['gamma']], { text: 'alpha', why: '' }), 'a missing group fails')
})

await test('an update must name its target; scope and kind are checked; kind only when the op has one', () => {
  const c = { expect: [{ op: 'update', target: 'p1', kind: 'state', scope: 'project', terms: [['x']] }], forbid: [] }
  assert(scoreCase(c, opsFromRaw({ ops: [{ op: 'update', id: 'p1', scope: 'project', kind: 'state', text: 'x' }] })).pass, 'all right')
  assert(!scoreCase(c, opsFromRaw({ ops: [{ op: 'update', id: 'p2', scope: 'project', text: 'x' }] })).pass, 'wrong target')
  assert(!scoreCase(c, opsFromRaw({ ops: [{ op: 'update', id: 'p1', scope: 'user', text: 'x' }] })).pass, 'wrong scope')
  assert(!scoreCase(c, opsFromRaw({ ops: [{ op: 'update', id: 'p1', scope: 'project', kind: 'fact', text: 'x' }] })).pass, 'wrong kind')
  const v1like = scoreCase(c, opsFromRaw({ ops: [{ op: 'update', id: 'p1', scope: 'project', text: 'x' }] }))
  eq([v1like.pass, v1like.kindUnchecked], [true, 1], 'no kind (v1): passes on content, counted as unchecked')
  const merged = scoreCase(c, opsFromRaw({ ops: [{ op: 'update', id: 'p9', replaces: ['p1'], scope: 'project', text: 'x' }] }))
  assert(merged.pass, 'a merge that replaces the target counts')
})

await test('guidance needs a why; one op meets one expectation; extra ops counted, not failed', () => {
  const c = { expect: [{ op: 'add', kind: 'guidance', terms: [['csv']] }, { op: 'add', terms: [['python']] }], forbid: [] }
  assert(!scoreCase(c, opsFromRaw({ ops: [{ op: 'add', kind: 'guidance', text: 'csv', why: '' }, { op: 'add', text: 'python' }] })).pass, 'guidance without why')
  assert(!scoreCase(c, opsFromRaw({ ops: [{ op: 'add', kind: 'guidance', text: 'csv and python', why: 'w' }] })).pass, 'one op cannot meet two')
  const s = scoreCase(c, opsFromRaw({ ops: [{ op: 'add', kind: 'guidance', text: 'csv', why: 'w' }, { op: 'add', text: 'python' }, { op: 'add', text: 'other' }] }))
  eq([s.pass, s.extra], [true, 1], 'extra op')
})

await test('strict fails on any op; a forbid fails on a match; filtered ops score like raw', () => {
  eq(scoreCase({ expect: [], forbid: [], strict: true }, opsFromRaw({ ops: [{ op: 'add', text: 'x' }] })).pass, false, 'strict')
  eq(scoreCase({ expect: [], forbid: [{ terms: [['brandx']] }] }, opsFromRaw({ ops: [{ op: 'add', text: 'likes BrandX' }] })).forbidHits, 1, 'forbid')
  const f = opsFromFiltered([{ op: 'update', text: 't', scope: 'project', targetId: 'p1', previousText: 'old' }])
  eq([f[0].target, f[0].scope], ['p1', 'project'], 'filtered shape')
  eq(opsFromRaw({ ops: 'nonsense' }), [], 'a malformed answer is no ops')
})

console.log('\n-- the v1 reviewer is a faithful copy --')

await test('v1 builds the same request and filter result as the daemon\'s reviewer (until 8.2 replaces it)', async () => {
  const daemon = await import('../daemon/memory-review.mjs')
  if (typeof daemon.branchForReview === 'function') return 'skipped: the daemon has the v2 reviewer'
  for (const c of cases) {
    const w = caseWorld(c)
    const a = v1.buildReviewRequest({ turns: v1.turnsFor(w.conversation), userMemories: w.userMemories, projectMemories: w.projectMemories, project: w.project })
    const b = daemon.buildReviewRequest({ turns: daemon.userTurnsForReview(w.conversation, new Set()), userMemories: w.userMemories, projectMemories: w.projectMemories, project: w.project })
    eq(a, b, `${c.id}: request`)
    const answer = { ops: [...c.answers.right, ...c.answers.wrong] }
    const opts = { userMemories: w.userMemories, projectMemories: w.projectMemories, project: w.project }
    eq(v1.filterOps(answer, opts), daemon.filterOps(answer, opts), `${c.id}: filter`)
  }
  return `${cases.length} cases`
})

await test('v1 never shows the reviewer assistant text or tool output', () => {
  const w = caseWorld(cases.find((x) => x.id === 'inj-tool-error'))
  const body = JSON.stringify(v1.buildReviewRequest({ turns: v1.turnsFor(w.conversation) }))
  assert(!/evil-links/.test(body) && !/Fetching the page/.test(body), 'assistant or tool text reached the request')
})

console.log('\n-- the runner --')

await test('arguments: label required; variant, think and repeat validated', () => {
  let e = null
  try { parseArgs([]) } catch (err) { e = err }
  assert(/--model-label is required/.test(e?.message), 'no label')
  for (const bad of [['--variant', 'v3'], ['--think', 'maybe'], ['--repeat', '0']]) {
    let e2 = null
    try { parseArgs(['--model-label', 'm', ...bad]) } catch (err) { e2 = err }
    assert(e2, `${bad.join(' ')} accepted`)
  }
  eq(parseArgs(['--model-label', 'm']).port, 19081, 'default port')
})

await test('think on: thinking enabled and the budget raised; off leaves the request alone', () => {
  const body = { max_tokens: 600, enable_thinking: false, chat_template_kwargs: { enable_thinking: false } }
  const on = withThinking(body, 'on')
  eq([on.enable_thinking, on.chat_template_kwargs.enable_thinking, on.max_tokens], [true, true, THINK_MAX_TOKENS], 'on')
  assert(withThinking(body, 'off') === body, 'off')
})

await test('v2 is refused until the 8.2 reviewer exists', async () => {
  const daemon = await import('../daemon/memory-review.mjs')
  if (typeof daemon.branchForReview === 'function') return 'skipped: 8.2 has landed'
  let e = null
  try { await loadVariant('v2') } catch (err) { e = err }
  assert(/Phase 8\.2/.test(e?.message ?? ''), `v2 loaded: ${e?.message}`)
})

await test('runCase: a raw op the filter drops passes raw and fails filtered (a forget, under v1)', async () => {
  const c = cases.find((x) => x.id === 'retr-forget-employer')
  const r = await runCase(v1, c, async () => ({ answer: { ops: c.answers.right }, tokens: 5 }))
  eq([r.raw.pass, r.filtered.pass, r.tokens], [true, false, 5], 'raw vs filtered')
  const err = await runCase(v1, c, async () => { throw new Error('the model server answered 503') })
  eq([err.error, err.raw.pass], ['the model server answered 503', false], 'a model error is a failed run, not a crash')
})

await test('main: every case run against a scripted model; files written; the summary counts groups', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bench-out-'))
  const bodies = []
  const { summary } = await main(['--model-label', 'scripted', '--repeat', '2', '--out', out], {
    callModel: async (body) => { bodies.push(body); return { answer: { ops: [] }, tokens: 1 } },
    log: () => {},
  })
  eq(bodies.length, cases.length * 2, 'one call per case per repeat')
  eq(summary.runs, cases.length * 2, 'runs')
  // An empty answer passes exactly the cases where nothing is the right answer.
  const silentRight = cases.filter((c) => c.expect.length === 0).length * 2
  eq(summary.filteredPass, silentRight, 'empty answers pass only the silent cases')
  eq([summary.groups.injection.filteredPass, summary.groups.facts.filteredPass], [10, 0], 'per group')
  for (const f of ['runs.jsonl', 'summary.json', 'summary.md']) assert(fs.existsSync(path.join(out, f)), `${f} written`)
  assert(fs.readFileSync(path.join(out, 'runs.jsonl'), 'utf8').trim().split('\n').length === cases.length * 2, 'one line per run')
  assert(/\| injection \| 10\/10 \|/.test(fs.readFileSync(path.join(out, 'summary.md'), 'utf8')), 'the table')
  fs.rmSync(out, { recursive: true, force: true })
})

const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed\n`)
if (passed !== results.length) process.exit(1)
