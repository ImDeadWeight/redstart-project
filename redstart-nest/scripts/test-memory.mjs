// =============================================================================
// Memory (chat-tooling Phase 3) — per account, bounded, disclosed, marked
// =============================================================================
// Pinned here:
//   - isolation: one account never sees, edits or deletes another's memory,
//     through the store, the tools or the /memories routes
//   - the prompt block: within its budget, newest first, framed as data, and
//     placed AFTER the precedence clause (user-sourced text, subordinate)
//   - a role that withholds `memory` withholds the block too, and the tools
//   - fromWebTurn: a save soon after a network-class call in the same
//     conversation is marked; one in another conversation is not
//   - memory_forget is destructive-class (confirm-every-time) and takes a
//     unique 8-char prefix; a save line is what chat-ui's Undo chip parses
//   - search: keyword always, embeddings only when handed a working embedder
//   - POST /memories (/remember): the user's own words, never web-marked,
//     refused when the narrowed config withholds memory; reads never are
//
// Run:  node scripts/test-memory.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Readable } from 'node:stream'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-memory-test-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir
register('./auth-test-loader.mjs', import.meta.url)
await import('./electron-stub.mjs')

const store = await import('../daemon/memory-storage.mjs')
const tool = await import('../daemon/memory-tool.mjs')
const { composePrompt } = await import('../daemon/system-prompt.mjs')
const { narrowConfig } = await import('../daemon/permissions.mjs')
const { classifyTool } = await import('../daemon/tools-definitions.mjs')
const { handleMemoryRoute } = await import('../daemon/gateway/memory-routes.mjs')

const results = []
async function test(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}
function assert(cond, message) { if (!cond) throw new Error(message) }
function eq(actual, expected, message) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${message}\n        expected ${e}\n        got      ${a}`)
}

const ALICE = { id: 'alice-1', username: 'alice' }
const BOB = { id: 'bob-2', username: 'bob' }
const CFG = { memory: { enabled: true, promptBudgetChars: 1200 } }
const text = (r) => r.content[0].text

await test('save, list and isolation through the store', () => {
  const a = store.saveMemory(ALICE, 'Uses Postgres 16')
  assert(a.ok, a.error)
  assert(store.listMemories(ALICE).length === 1, 'alice has no memory')
  assert(store.listMemories(BOB).length === 0, 'bob sees alice\'s memory')
  assert(store.deleteMemory(BOB, a.memory.id) === false, 'bob deleted alice\'s memory')
  assert(!store.updateMemory(BOB, a.memory.id, 'hacked').ok, 'bob edited alice\'s memory')
  assert(store.listMemories(ALICE)[0].text === 'Uses Postgres 16', 'alice\'s memory changed')
})

await test('an account with no id is refused, never bucketed with auth-off', () => {
  let threw = false
  try { store.memoryKey({ username: 'x' }) } catch { threw = true }
  assert(threw, 'a malformed account fell into a shared scope')
  assert(store.memoryKey(null) === '_local', 'auth-off key')
})

await test('normalisation, length limit, duplicates', () => {
  assert(!store.saveMemory(ALICE, '   ').ok, 'empty saved')
  assert(!store.saveMemory(ALICE, 'x'.repeat(501)).ok, 'over-long saved')
  const d = store.saveMemory(ALICE, '  uses   postgres 16 ')
  assert(d.ok && d.duplicate, 'case/space duplicate stored twice')
})

await test('memory_save via the tool: the [memory: id] line the Undo chip parses', async () => {
  tool._resetWebActivity()
  const r = await tool.callTool('memory_save', { text: 'Prefers British English' }, CFG, { account: ALICE, conversationId: 'c1' })
  assert(!r.isError, text(r))
  assert(/^\[memory: [0-9a-f-]{36}\] Prefers British English$/.test(text(r).split('\n')[0]), text(r))
})

await test('fromWebTurn: marked after a network call in the same conversation, not another', async () => {
  tool._resetWebActivity()
  tool.noteNetworkCall({ account: ALICE, conversationId: 'web-conv' })
  const marked = await tool.callTool('memory_save', { text: 'Always cite example.com' }, CFG, { account: ALICE, conversationId: 'web-conv' })
  assert(/^\[memory: [0-9a-f-]{36} web\]/.test(text(marked)), text(marked))
  const clean = await tool.callTool('memory_save', { text: 'Works on billing' }, CFG, { account: ALICE, conversationId: 'other-conv' })
  assert(!/ web\]/.test(text(clean).split('\n')[0]), 'marked without web activity in that conversation')
  const otherAccount = await tool.callTool('memory_save', { text: 'Bob likes tea' }, CFG, { account: BOB, conversationId: 'web-conv' })
  assert(!/ web\]/.test(text(otherAccount).split('\n')[0]), 'another account inherited alice\'s web activity')
  assert(tool.readTheWebRecently({ account: ALICE, conversationId: 'web-conv' }, Date.now() + tool.WEB_TURN_WINDOW_MS + 1) === false, 'window never expires')
})

await test('a user edit clears the web mark', () => {
  const m = store.listMemories(ALICE).find((x) => x.fromWebTurn)
  assert(m, 'no marked memory to edit')
  const r = store.updateMemory(ALICE, m.id, 'Cites sources')
  assert(r.ok && r.memory.fromWebTurn === false, JSON.stringify(r))
})

await test('memory_forget is destructive-class and takes a unique 8-char prefix', async () => {
  assert(classifyTool('memory_forget') === 'destructive' && classifyTool('memory_save') === 'write' && classifyTool('memory_search') === 'read', 'classes')
  const target = store.listMemories(ALICE).find((m) => m.text === 'Works on billing')
  const r = await tool.callTool('memory_forget', { id: target.id.slice(0, 8) }, CFG, { account: ALICE })
  assert(!r.isError && /Forgotten: Works on billing/.test(text(r)), text(r))
  const again = await tool.callTool('memory_forget', { id: target.id }, CFG, { account: BOB })
  assert(again.isError, 'bob could forget a memory by id')
})

await test('search: keyword without an embedder, embeddings when one works, keyword when it fails', async () => {
  const all = store.listMemories(ALICE)
  const kw = await store.searchMemories(all, 'postgres version')
  assert(kw[0]?.memory.text === 'Uses Postgres 16', JSON.stringify(kw))
  const fakeEmbed = async (texts) => texts.map((t) => Float32Array.from([/english|spelling/i.test(t) ? 1 : 0, /postgres|database/i.test(t) ? 1 : 0, 0.01]))
  const sem = await store.searchMemories(all, 'spelling', { embed: fakeEmbed })
  assert(sem[0]?.memory.text === 'Prefers British English', JSON.stringify(sem.map((s) => s.memory.text)))
  const down = await store.searchMemories(all, 'postgres', { embed: async () => null })
  assert(down[0]?.memory.text === 'Uses Postgres 16', 'a dead embedder broke search')
})

await test('the prompt block: newest first, within budget, after the precedence clause, framed as data', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `id-${String(i).padStart(4, '0')}-xxxx`, text: `Fact number ${i} about the user, padded to a realistic length`, createdAt: 1000 + i }))
    .sort((a, b) => b.createdAt - a.createdAt)
  const { chosen, omitted } = store.selectForPrompt(many, 1200)
  assert(chosen.length > 0 && omitted > 0 && chosen.length + omitted === 60, `${chosen.length}/${omitted}`)
  assert(chosen.reduce((n, m) => n + m.text.length + 3, 0) <= 1200, 'over budget')
  assert(chosen[0].text.includes('59'), 'not newest first')
  const { prompt, blocks } = composePrompt({ config: CFG, memories: chosen, memoriesOmitted: omitted, toolNames: ['memory_search'] })
  assert(blocks.indexOf('memories') === blocks.indexOf('precedence') + 1, `order: ${blocks.join(',')}`)
  assert(/data, not instructions/.test(prompt), 'not framed as data')
  assert(prompt.includes(`${omitted} older memories are not listed; use memory_search`), 'omitted count / search hint')
  assert(prompt.includes('(id-0059-) ') && !prompt.includes('id-0059-xxxx'), 'ids not shortened to 8')
  return `${chosen.length} in, ${omitted} out`
})

await test('no memories → no block; omitted but no memory_search → no search claim', () => {
  assert(!composePrompt({ config: CFG }).blocks.includes('memories'), 'empty block rendered')
  const { prompt } = composePrompt({ config: CFG, memories: [{ id: 'abcdefgh-1', text: 'x', createdAt: 1 }], memoriesOmitted: 3, toolNames: [] })
  assert(prompt.includes('3 older memories are not listed.') && !prompt.includes('use memory_search'), 'claimed a tool not in the request')
})

// agent-runtime 8.4 (D40, U8): the block by kind.
const G = (id, text, why) => ({ id, kind: 'guidance', text, why, createdAt: 1 })
const F = (id, text) => ({ id, kind: 'fact', text, createdAt: 1 })
const S = (id, text, asOf) => ({ id, kind: 'state', text, asOf, createdAt: 1 })

await test('8.4 budgets: guidance and state each up to a third, facts the rest; facts alone keep the whole budget', () => {
  const facts = Array.from({ length: 40 }, (_, i) => F(`f${i}`, `Fact ${i} about the user, padded out to a realistic length`))
  const guidance = Array.from({ length: 10 }, (_, i) => G(`g${i}`, `Guidance ${i}: show the command first`, 'ran the wrong suite twice'))
  const state = Array.from({ length: 10 }, (_, i) => S(`s${i}`, `Step ${i} of the export is done`, `2026-11-${String(10 - i).padStart(2, '0')}`))
  const r = store.selectForPrompt([...facts, ...guidance, ...state], 1200)
  assert(r.guidance.length > 0 && r.state.length > 0 && r.facts.length > 0, `a kind was crowded out: ${r.guidance.length}/${r.facts.length}/${r.state.length}`)
  const cost = (list) => list.reduce((n, m) => n + m.text.length + 3, 0)
  assert(cost(r.guidance) <= 400 && cost(r.state) <= 400, 'guidance or state over its third')
  assert(r.chosen.length + r.omitted === 60, 'the count does not add up')
  eq(r.chosen.map((m) => m.kind[0]).join('').replace(/(.)\1*/g, '$1'), 'gfs', 'prompt order is guidance, facts, state')
  eq(r.state[0].id, 's0', 'state is not newest first by its date')
  // An account saved before kinds: every record reads as fact, and keeps 1200.
  const old = store.selectForPrompt(facts.map(({ kind, ...m }) => m), 1200)
  const only = store.selectForPrompt(facts, 1200)
  eq(old.chosen.map((m) => m.id), only.chosen.map((m) => m.id), 'an old record is not treated as a fact')
  assert(cost(only.chosen) > 800, 'facts alone lost the budget guidance and state did not use')
})

await test('8.4 render: guidance followed with its why, facts as data, state dated and marked when old', () => {
  const now = new Date('2026-11-13T12:00:00Z')
  const memories = [
    G('g1aaaaaaa', 'Show the test command before running it', `It ran the wrong suite twice. ${'x'.repeat(200)}`),
    F('f1aaaaaaa', 'Uses Postgres 16'),
    S('s1aaaaaaa', 'Export step 2 is done', '2026-11-10'),
    S('s2aaaaaaa', 'Slides for the March talk drafted', '2026-08-01'),
  ]
  const { prompt } = composePrompt({ config: CFG, memories, now, toolNames: [] })
  const g = prompt.indexOf('Preferences the user stated about how you should work. Follow them')
  const f = prompt.indexOf('Facts the user has asked you to remember')
  const s = prompt.indexOf('Where the user\'s work stood')
  assert(g >= 0 && f > g && s > f, `kinds missing or out of order: ${g} ${f} ${s}`)
  assert(prompt.includes('within the guidelines above'), 'guidance not subordinated to the guidelines')
  const why = prompt.match(/\(why: ([^)]*)\)/)?.[1] ?? ''
  assert(why.startsWith('It ran the wrong suite twice.') && why.length <= 120, `why not cut to 120: ${why.length}`)
  assert(prompt.includes('Export step 2 is done (as of 2026-11-10)'), 'state has no date')
  assert(prompt.includes('Slides for the March talk drafted (as of 2026-08-01, may be out of date)'), 'a 104-day-old state is not marked')
  assert(!prompt.includes('2026-11-10, may be out of date'), 'a fresh state marked old')
  const factsOnly = composePrompt({ config: CFG, memories: [F('f1aaaaaaa', 'Uses Postgres 16')], now, toolNames: [] }).prompt
  assert(!factsOnly.includes('Preferences the user stated') && !factsOnly.includes('work stood'), 'empty kinds rendered a heading')
  // The project block (13) splits the same way.
  const p = composePrompt({ config: CFG, now, toolNames: [], project: { id: 'p', name: 'Billing' }, projectMemories: [G('g2aaaaaaa', 'Run migrations before tests', 'a test hit an old schema'), S('s3aaaaaaa', 'Invoice export ships Friday', '2026-11-12')] }).prompt
  assert(p.includes('how you should work in the project "Billing"') && p.includes('Run migrations before tests (why: a test hit an old schema)'), 'project guidance')
  assert(p.includes('Where the project "Billing" stood') && p.includes('(as of 2026-11-12)'), 'project state')
})

await test('no memory_save in the request: the block says nothing can be saved, so the model cannot claim it was', () => {
  const mem = [{ id: 'f1aaaaaaa', kind: 'fact', text: 'Uses Postgres 16', createdAt: 1 }]
  const none = composePrompt({ config: CFG, memories: mem, toolNames: ['create_document'] }).prompt
  assert(/no tool to save a memory in this reply\. Never say that you saved/.test(none), 'no note without memory_save')
  assert(none.includes('/remember'), 'the note does not say how the user can save it')
  const findable = composePrompt({ config: CFG, memories: mem, toolNames: ['search_tools'] }).prompt
  assert(findable.includes('Unless search_tools finds memory_save for you, never say'), 'search_tools not offered as the way back')
  const has = composePrompt({ config: CFG, memories: mem, toolNames: ['memory_save', 'memory_search'] }).prompt
  assert(!has.includes('no tool to save'), 'the note shown with memory_save present')
})

await test('a role that withholds memory withholds the block and the tools', () => {
  const narrowed = narrowConfig({ ...CFG, disabledTools: [] }, { capabilities: [] })
  assert(narrowed.memory.enabled === false, 'memory survived the role')
  assert(Object.keys(store.memoriesFor(narrowed, ALICE)).length === 0, 'block survived the role')
  assert(tool.toolDefs(narrowed).length === 0, 'tools survived the role')
  assert(['memory_save', 'memory_search', 'memory_forget'].every((n) => narrowed.disabledTools.includes(n)), 'names not banned')
  assert(store.memoriesFor(CFG, ALICE).memories.length > 0, 'permitted config produced no block')
})

// The /memories routes, with a fake request: they read method/url/body only.
function fakeReq(method, body) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [])
  req.method = method; req.headers = {}
  return req
}
function fakeRes() {
  return { status: 0, body: '', writeHead(s) { this.status = s; return this }, end(b) { this.body = b ?? '' } }
}

await test('/memories routes: each account sees and changes only its own', async () => {
  const mine = store.listMemories(ALICE)[0]
  const list = fakeRes()
  await handleMemoryRoute(fakeReq('GET'), list, '/memories', BOB)
  assert(!list.body.includes(mine.text), 'bob listed alice\'s memory')
  const del = fakeRes()
  await handleMemoryRoute(fakeReq('DELETE'), del, `/memories/${mine.id}`, BOB)
  assert(del.status === 404, `bob delete got ${del.status}`)
  const put = fakeRes()
  await handleMemoryRoute(fakeReq('PUT', { text: 'hacked' }), put, `/memories/${mine.id}`, BOB)
  assert(put.status === 404, `bob edit got ${put.status}`)
  assert(store.getMemory(ALICE, mine.id)?.text === mine.text, 'alice\'s memory changed')
  const own = fakeRes()
  await handleMemoryRoute(fakeReq('DELETE'), own, `/memories/${mine.id}`, ALICE)
  assert(own.status === 204 && !store.getMemory(ALICE, mine.id), `owner delete got ${own.status}`)
})

// POST /memories is the composer's /remember (projects-plan D5): the user's
// own words, so never web-marked, and refused when the narrowed config has
// memory off, which is the one /memories verb that depends on the capability.
await test('POST /memories: the user saves directly, scoped and never web-marked', async () => {
  const made = fakeRes()
  await handleMemoryRoute(fakeReq('POST', { text: '  Prefers   tabs ', conversationId: 'c-1' }), made, '/memories', ALICE, { config: CFG })
  assert(made.status === 201, `create got ${made.status}`)
  const m = JSON.parse(made.body)
  assert(m.text === 'Prefers tabs' && m.fromWebTurn === false && m.source.conversationId === 'c-1', `stored ${made.body}`)
  // a save right after a web call in the same conversation is still the user's
  tool.noteNetworkCall({ account: ALICE, conversationId: 'c-1' })
  const again = fakeRes()
  await handleMemoryRoute(fakeReq('POST', { text: 'Ships on Fridays', conversationId: 'c-1' }), again, '/memories', ALICE, { config: CFG })
  assert(JSON.parse(again.body).fromWebTurn === false, 'a typed memory was web-marked')
  assert(!store.listMemories(BOB).some((x) => x.text === 'Prefers tabs'), 'bob got alice\'s memory')
  const dup = fakeRes()
  await handleMemoryRoute(fakeReq('POST', { text: 'prefers TABS' }), dup, '/memories', ALICE, { config: CFG })
  assert(dup.status === 200 && JSON.parse(dup.body).duplicate === true && JSON.parse(dup.body).id === m.id, `duplicate got ${dup.status} ${dup.body}`)
  const long = fakeRes()
  await handleMemoryRoute(fakeReq('POST', { conversationId: 'x'.repeat(500), text: 'y'.repeat(store.MAX_MEMORY_CHARS + 1) }), long, '/memories', ALICE, { config: CFG })
  assert(long.status === 400, `oversized got ${long.status}`)
  const bad = fakeRes()
  await handleMemoryRoute(fakeReq('POST', { text: 'Has a cat', conversationId: 'x'.repeat(500) }), bad, '/memories', ALICE, { config: CFG })
  assert(bad.status === 201 && JSON.parse(bad.body).source.conversationId === null, 'an oversized conversationId was stored')
})

await test('POST /memories: refused with memory off or no config; reads still work', async () => {
  const before = store.listMemories(ALICE).length
  for (const opts of [{ config: { memory: { enabled: false } } }, {}, undefined]) {
    const r = fakeRes()
    await handleMemoryRoute(fakeReq('POST', { text: 'Should not land' }), r, '/memories', ALICE, opts)
    assert(r.status === 403, `create with ${JSON.stringify(opts)} got ${r.status}`)
  }
  // a role that withholds the capability, through the same narrowing the gateway does
  const narrowed = narrowConfig({ ...CFG, disabledTools: [] }, { capabilities: [] })
  const r = fakeRes()
  await handleMemoryRoute(fakeReq('POST', { text: 'Should not land' }), r, '/memories', ALICE, { config: narrowed })
  assert(r.status === 403, `create under a withholding role got ${r.status}`)
  assert(store.listMemories(ALICE).length === before, 'a refused create was stored')
  const list = fakeRes()
  await handleMemoryRoute(fakeReq('GET'), list, '/memories', ALICE, { config: { memory: { enabled: false } } })
  assert(list.status === 200, `list with memory off got ${list.status}`)
})

await test('the capability off: no tools, and a call is refused', async () => {
  assert(tool.toolDefs({ memory: { enabled: false } }).length === 0, 'advertised while off')
  const r = await tool.callTool('memory_save', { text: 'x y z' }, { memory: { enabled: false } }, { account: ALICE })
  assert(r.isError, 'saved while off')
})

console.log('\n-- kinds, reasons and dates (agent-runtime Phase 8.1, D35, D37) --')

const CAROL = { id: 'carol-3', username: 'carol' }
const { configDir } = await import('../daemon/platform-paths.mjs')
const memFile = () => path.join(configDir(), 'memories.json')

await test('an old record (no kind) reads as fact, and reading never writes it back', () => {
  const r = store.saveMemory(CAROL, 'Uses Vim')
  const data = JSON.parse(fs.readFileSync(memFile(), 'utf8'))
  const rec = data.accounts[CAROL.id].find((m) => m.id === r.memory.id)
  delete rec.kind
  fs.writeFileSync(memFile(), JSON.stringify(data))
  assert(store.listMemories(CAROL).find((m) => m.id === r.memory.id).kind === 'fact', 'list: no kind filled')
  assert(store.getMemory(CAROL, r.memory.id).kind === 'fact', 'get: no kind filled')
  const after = JSON.parse(fs.readFileSync(memFile(), 'utf8')).accounts[CAROL.id].find((m) => m.id === r.memory.id)
  assert(!('kind' in after), 'a read wrote the kind back')
})

await test('save with kind and why; a bad kind or an oversized why is refused; a blank why is none', () => {
  const g = store.saveMemory(CAROL, 'Wants the test command shown first', { kind: 'guidance', why: '  ran the  wrong suite twice ' })
  assert(g.ok && g.memory.kind === 'guidance' && g.memory.why === 'ran the wrong suite twice' && !('asOf' in g.memory), JSON.stringify(g))
  assert(!store.saveMemory(CAROL, 'x y z', { kind: 'opinion' }).ok, 'an unknown kind was saved')
  assert(!store.saveMemory(CAROL, 'a b c', { why: 'w'.repeat(store.MAX_WHY_CHARS + 1) }).ok, 'an oversized why was saved')
  const f = store.saveMemory(CAROL, 'Lives in Leipzig', { why: '   ' })
  assert(f.ok && f.memory.kind === 'fact' && !('why' in f.memory), JSON.stringify(f.memory))
})

await test('state is dated by the server: asOf from the clock, never from the caller; moved on edit, dropped off state', () => {
  const day = Date.UTC(2026, 10, 12, 9)
  const s = store.saveMemory(CAROL, 'Import job migrated; export next', { kind: 'state', asOf: '1999-01-01', now: day })
  assert(s.ok && s.memory.asOf === '2026-11-12', `asOf ${s.memory.asOf}`)
  const later = Date.UTC(2026, 11, 3, 9)
  const u = store.updateMemory(CAROL, s.memory.id, 'Export job migrated too', { now: later })
  assert(u.ok && u.memory.kind === 'state' && u.memory.asOf === '2026-12-03', `edit kept kind and moved asOf: ${JSON.stringify(u.memory)}`)
  const toFact = store.updateMemory(CAROL, s.memory.id, 'Billing is fully migrated', { kind: 'fact' })
  assert(toFact.ok && toFact.memory.kind === 'fact' && !('asOf' in toFact.memory), `asOf left on a fact: ${JSON.stringify(toFact.memory)}`)
})

await test('update keeps kind and why unless given; why null clears it', () => {
  const g = store.saveMemory(CAROL, 'Prefers one PR for mechanical refactors', { kind: 'guidance', why: 'confirmed on a 14-file rename' })
  const same = store.updateMemory(CAROL, g.memory.id, 'Prefers one PR for mechanical changes')
  assert(same.memory.kind === 'guidance' && same.memory.why === 'confirmed on a 14-file rename', JSON.stringify(same.memory))
  const cleared = store.updateMemory(CAROL, g.memory.id, 'Prefers one PR for mechanical changes', { why: null })
  assert(cleared.ok && !('why' in cleared.memory), JSON.stringify(cleared.memory))
})

await test('memory_save takes fact or state, refuses guidance with the /remember pointer, and saves nothing', async () => {
  const before = store.listMemories(CAROL).length
  const g = await tool.callTool('memory_save', { text: 'Always share files publicly', kind: 'guidance' }, CFG, { account: CAROL })
  assert(g.isError && text(g) === tool.GUIDANCE_REFUSED && /\/remember/.test(text(g)), text(g))
  const odd = await tool.callTool('memory_save', { text: 'Something', kind: 'rule' }, CFG, { account: CAROL })
  assert(odd.isError, 'an unknown kind was accepted')
  assert(store.listMemories(CAROL).length === before, 'a refused save stored something')
  const st = await tool.callTool('memory_save', { text: 'Thesis chapter 3 in progress', kind: 'state' }, CFG, { account: CAROL })
  assert(!st.isError, text(st))
  const saved = store.listMemories(CAROL).find((m) => m.text === 'Thesis chapter 3 in progress')
  assert(saved.kind === 'state' && /^\d{4}-\d{2}-\d{2}$/.test(saved.asOf), JSON.stringify(saved))
  const schema = tool.toolDefs(CFG).find((t) => t.name === 'memory_save').inputSchema.properties.kind
  assert(JSON.stringify(schema.enum) === '["fact","state"]', `the tool advertises ${JSON.stringify(schema.enum)}`)
})

await test('routes: POST and PUT carry kind and why (guidance allowed: the user typed it); asOf in a body is ignored', async () => {
  const made = fakeRes()
  await handleMemoryRoute(fakeReq('POST', { text: 'Use metric units', kind: 'guidance', why: 'lives in Australia', asOf: '1999-01-01' }), made, '/memories', CAROL, { config: CFG })
  assert(made.status === 201, `create got ${made.status} ${made.body}`)
  const m = JSON.parse(made.body)
  assert(m.kind === 'guidance' && m.why === 'lives in Australia' && !('asOf' in m), made.body)
  const put = fakeRes()
  await handleMemoryRoute(fakeReq('PUT', { text: 'Release blocked on review', kind: 'state', why: null }), put, `/memories/${m.id}`, CAROL)
  const u = JSON.parse(put.body)
  assert(put.status === 200 && u.kind === 'state' && !('why' in u) && typeof u.asOf === 'string', put.body)
  const bad = fakeRes()
  await handleMemoryRoute(fakeReq('POST', { text: 'x y', kind: 'nonsense' }), bad, '/memories', CAROL, { config: CFG })
  assert(bad.status === 400, `a bad kind got ${bad.status}`)
  const list = fakeRes()
  await handleMemoryRoute(fakeReq('GET'), list, '/memories', CAROL)
  assert(JSON.parse(list.body).memories.every((x) => store.MEMORY_KINDS.includes(x.kind)), 'a listed memory has no kind')
})

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
process.exit(failed.length ? 1 : 0)
