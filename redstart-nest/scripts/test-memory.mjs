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

await test('the capability off: no tools, and a call is refused', async () => {
  assert(tool.toolDefs({ memory: { enabled: false } }).length === 0, 'advertised while off')
  const r = await tool.callTool('memory_save', { text: 'x y z' }, { memory: { enabled: false } }, { account: ALICE })
  assert(r.isError, 'saved while off')
})

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
process.exit(failed.length ? 1 : 0)
