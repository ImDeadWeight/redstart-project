#!/usr/bin/env node
// =============================================================================
// The daemon-side task runtime (agent-runtime plan Phase 3)
// =============================================================================
// The task store (task-store.mjs): records, states, the numbered event log
// and replay. Later sections cover server-owned conversation writes, the
// runner against a fake model and fake tools, and the routes.
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-tasks-test-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir
register('./auth-test-loader.mjs', import.meta.url)
await import('./electron-stub.mjs')

const store = await import('../daemon/task-store.mjs')

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
function assert(cond, message) { if (!cond) throw new Error(message) }
function eq(a, b, what) { assert(JSON.stringify(a) === JSON.stringify(b), `${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`) }

const SPEC = { accountKey: 'alice-1', accountId: 'alice-1', storeAccountId: 'alice-1', conversationId: 'conv-a' }

console.log('\n-- the task store (3.3) --')

await test('a new task is queued, on disk, with one created event', () => {
  const t = store.createTask(SPEC)
  assert(store.isTaskId(t.id), 'id')
  eq(t.status, 'queued', 'status')
  eq(store.getTask(t.id).conversationId, 'conv-a', 'read back')
  eq(store.readEvents(t.id).map((e) => [e.seq, e.type]), [[1, 'created']], 'events')
  eq(t.limits.maxTurns, 100, 'default turn limit (chat-ui DEFAULT_AGENTIC_CONFIG)')
})

await test('createTask refuses a spec with no owner or no conversation', () => {
  for (const bad of [{}, { ...SPEC, accountKey: '' }, { ...SPEC, storeAccountId: undefined }, { ...SPEC, conversationId: null }]) {
    let threw = false
    try { store.createTask(bad) } catch { threw = true }
    assert(threw, `accepted ${JSON.stringify(bad)}`)
  }
})

await test('a status change is logged once; waiting is cleared on leaving a waiting state', () => {
  const t = store.createTask(SPEC)
  store.updateTask(t.id, { status: 'running' })
  store.updateTask(t.id, { status: 'waiting_user', waiting: { kind: 'question', question: 'Which?' } })
  eq(store.getTask(t.id).waiting.kind, 'question', 'waiting kept')
  store.updateTask(t.id, { status: 'running' })
  eq(store.getTask(t.id).waiting, null, 'waiting cleared')
  store.updateTask(t.id, { status: 'running' }) // no change: no event
  eq(store.readEvents(t.id).map((e) => e.status ?? e.type), ['queued', 'running', 'waiting_user', 'running'], 'events')
})

await test('a terminal task never changes again', () => {
  const t = store.createTask(SPEC)
  store.updateTask(t.id, { status: 'cancelled' })
  eq(store.updateTask(t.id, { status: 'running' }), null, 'refused')
  eq(store.getTask(t.id).status, 'cancelled', 'still cancelled')
  assert(store.getTask(t.id).endedAt > 0, 'endedAt')
})

await test('an unknown status throws', () => {
  const t = store.createTask(SPEC)
  let threw = false
  try { store.updateTask(t.id, { status: 'paused' }) } catch { threw = true }
  assert(threw, 'accepted')
})

await test('events replay after a seq, and survive a fresh process (seq read back from disk)', () => {
  const t = store.createTask(SPEC)
  store.appendEvent(t.id, { type: 'message', id: 'm1' })
  store.appendEvent(t.id, { type: 'message', id: 'm2' })
  eq(store.readEvents(t.id, 2).map((e) => e.id), ['m2'], 'after 2')
  store._resetMemory()
  const e = store.appendEvent(t.id, { type: 'message', id: 'm3' })
  eq(e.seq, 4, 'seq continues')
})

await test('a torn last line is skipped, not fatal', () => {
  const t = store.createTask(SPEC)
  fs.appendFileSync(path.join(tmpDir, 'tasks', t.id, 'events.jsonl'), '{"seq":2,"ty')
  eq(store.readEvents(t.id).length, 1, 'one good event')
  // The next process's first append is not glued onto the torn line.
  store._resetMemory()
  store.appendEvent(t.id, { type: 'after' })
  eq(store.readEvents(t.id).map((e) => e.type), ['created', 'after'], 'append after a tear')
})

await test('an oversized event keeps its type and says it was cut', () => {
  const t = store.createTask(SPEC)
  const e = store.appendEvent(t.id, { type: 'tool_result', text: 'x'.repeat(store.MAX_EVENT_CHARS + 10) })
  eq([e.type, e.truncated, e.text], ['tool_result', true, undefined], 'cut')
})

await test('subscribers hear appends; unsubscribe stops them', () => {
  const t = store.createTask(SPEC)
  const heard = []
  const off = store.subscribe(t.id, (e) => heard.push(e.type))
  store.appendEvent(t.id, { type: 'a' })
  off()
  store.appendEvent(t.id, { type: 'b' })
  eq(heard, ['a'], 'heard')
})

await test('listTasks is per account; activeTaskFor ignores finished tasks', () => {
  const bob = store.createTask({ ...SPEC, accountKey: 'bob-2', storeAccountId: 'bob-2', conversationId: 'conv-b' })
  assert(store.listTasks('bob-2').length === 1 && store.listTasks('bob-2')[0].id === bob.id, 'bob sees his')
  assert(!store.listTasks('alice-1').some((t) => t.id === bob.id), 'alice does not')
  eq(store.activeTaskFor('bob-2', 'conv-b')?.id, bob.id, 'active')
  store.updateTask(bob.id, { status: 'done' })
  eq(store.activeTaskFor('bob-2', 'conv-b'), null, 'done is not active')
})

await test('getTask refuses a path-shaped id', () => {
  eq(store.getTask('../accounts'), null, 'traversal')
  eq(store.readEvents('../../x'), [], 'traversal events')
})

await test('finished tasks past the cap are pruned, oldest first; live ones never', () => {
  const key = 'pruner'
  const live = store.createTask({ ...SPEC, accountKey: key })
  const ids = []
  for (let i = 0; i < store.MAX_FINISHED_PER_ACCOUNT + 3; i++) {
    const t = store.createTask({ ...SPEC, accountKey: key })
    store.updateTask(t.id, { status: 'done' })
    ids.push(t.id)
  }
  store.createTask({ ...SPEC, accountKey: key }) // prunes on create
  const left = new Set(store.listTasks(key).map((t) => t.id))
  assert(left.has(live.id), 'live task kept')
  assert(!left.has(ids[0]) && !left.has(ids[1]), 'oldest finished removed')
  eq(store.listTasks(key).filter((t) => t.status === 'done').length, store.MAX_FINISHED_PER_ACCOUNT, 'cap')
})

console.log('\n-- server-owned conversation writes (3.4, D25) --')

const convs = await import('../daemon/conversations-storage.mjs')
const { handleConversationRoute } = await import('../daemon/gateway/conversation-routes.mjs')
const { Readable } = await import('node:stream')

function fakeReq(method, body, url = '/') {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [])
  req.method = method; req.headers = {}; req.url = url
  return req
}
function fakeRes() {
  return { status: 0, body: '', headersSent: false, writeHead(s) { this.status = s; this.headersSent = true; return this }, setHeader() {}, end(b) { this.body = b ?? '' } }
}
async function convRoute(method, urlPath, accountId, body) {
  const res = fakeRes()
  const handled = await handleConversationRoute(fakeReq(method, body, urlPath), res, urlPath, accountId, { account: null })
  return { handled, status: res.status, json: res.body ? JSON.parse(res.body) : null }
}

function seedConversation(accountId, id) {
  convs.createConversation(accountId, { id, name: 'seed', currNode: 'root', messages: [
    { id: 'root', convId: id, type: 'root', role: 'system', content: '', parent: null, children: ['u1'], timestamp: 1 },
    { id: 'u1', convId: id, type: 'text', role: 'user', content: 'hi', parent: 'root', children: [], timestamp: 2 },
  ] })
}

await test('appendMessage links the parent, sets currNode, and ignores a caller-supplied children list', () => {
  seedConversation('alice-1', 'c-append')
  const m = convs.appendMessage('alice-1', 'c-append', { id: 'a1', parent: 'u1', role: 'assistant', content: 'yo', children: ['forged'] })
  eq(m.children, [], 'children set here')
  const c = convs.getConversation('alice-1', 'c-append')
  eq([c.currNode, c.messages.find((x) => x.id === 'u1').children], ['a1', ['a1']], 'linked')
})

await test('appendMessage refuses an unknown parent, a duplicate id, and another account\'s conversation', () => {
  eq(convs.appendMessage('alice-1', 'c-append', { id: 'a2', parent: 'nope' }), null, 'unknown parent')
  eq(convs.appendMessage('alice-1', 'c-append', { id: 'a1', parent: 'u1' }), null, 'duplicate')
  eq(convs.appendMessage('bob-2', 'c-append', { id: 'a3', parent: 'u1' }), null, 'other account')
})

await test('patchMessage changes content but never the tree', () => {
  const m = convs.patchMessage('alice-1', 'c-append', 'a1', { content: 'changed', parent: 'root', children: ['x'] })
  eq([m.content, m.parent, m.children], ['changed', 'u1', []], 'patched')
})

await test('while a task holds it, a PUT with messages or currNode is 409; title and pin still land', async () => {
  seedConversation('alice-1', 'c-lock')
  assert(convs.setActiveTask('alice-1', 'c-lock', 'task-1'), 'claimed')
  const r1 = await convRoute('PUT', '/conversations/c-lock', 'alice-1', { messages: [] })
  eq([r1.status, r1.json.error.code], [409, 'task_active'], 'messages')
  eq((await convRoute('PUT', '/conversations/c-lock', 'alice-1', { currNode: 'root' })).status, 409, 'currNode')
  eq((await convRoute('PUT', '/conversations/c-lock', 'alice-1', { name: 'New title', pinned: true })).status, 200, 'title')
  const c = convs.getConversation('alice-1', 'c-lock')
  eq([c.name, c.pinned, c.messages.length, c.currNode], ['New title', true, 2, 'root'], 'messages untouched')
  convs.setActiveTask('alice-1', 'c-lock', null)
  eq((await convRoute('PUT', '/conversations/c-lock', 'alice-1', { currNode: 'u1' })).status, 200, 'freed')
})

await test('a client can neither set nor clear activeTaskId', async () => {
  seedConversation('alice-1', 'c-protect')
  await convRoute('PUT', '/conversations/c-protect', 'alice-1', { activeTaskId: 'forged' })
  eq(convs.getConversation('alice-1', 'c-protect').activeTaskId, undefined, 'set')
  convs.setActiveTask('alice-1', 'c-protect', 'task-2')
  await convRoute('PUT', '/conversations/c-protect', 'alice-1', { activeTaskId: null, name: 'x' })
  eq(convs.getConversation('alice-1', 'c-protect').activeTaskId, 'task-2', 'cleared')
  const created = await convRoute('POST', '/conversations', 'alice-1', { id: 'c-new', name: 'n', activeTaskId: 'forged' })
  eq(created.json.activeTaskId, undefined, 'on create')
})

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
process.exit(failed.length ? 1 : 0)
