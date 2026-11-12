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

console.log('\n-- the runner, against a fake model and fake tools (3.5) --')

const runner = await import('../daemon/task-runner.mjs')
const ledger = await import('../daemon/approval-ledger.mjs')
const grantsMod = await import('../daemon/approval-grants.mjs')
const { memoryKey } = await import('../daemon/memory-storage.mjs')
const { DENIED_RESULT } = await import('../../shared/agent-core/tool-calls.mjs')

// Auth off for this section (a fresh data folder requires login): every task
// runs as the null account, the auth-off posture. The account checks have
// their own test at the end.
const accountsStore = await import('../daemon/accounts-storage.mjs')
accountsStore.setAuthRequired(false)
const ANON_KEY = memoryKey(null)
const SCOPE = 'device-1' // the conversations scope (a device id, auth off)

function sse(chunks) {
  const lines = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(lines, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}
const say = (text) => [{ choices: [{ delta: { content: text } }], model: 'fake-model' }]
const call = (id, name, args = {}) => [{ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }]

const TOOLS = ['read_document', 'create_document', 'delete_file', 'ask_user', 'update_plan']
  .map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }))

/**
 * A scripted model: each entry answers one completion, given its messages.
 * `calls` records every tool call the runner made; `bodies` every request.
 */
function fakeWorld(script, extra = {}) {
  const world = { bodies: [], calls: [], turn: 0 }
  runner._setTestSeams({
    prepareCompletion: async (parsed) => ({ parsed, wire: {} }),
    effectiveConfigFor: async () => ({}),
    toolCatalogFor: async () => TOOLS,
    callToolAs: async (account, name, args, opts) => {
      world.calls.push({ name, args, opts })
      return { content: [{ type: 'text', text: `${name} ran` }] }
    },
    upstreamPort: () => 9999,
    completionsInFlight: () => 0,
    fetchCompletion: async (_port, body) => {
      world.bodies.push(body)
      const step = script[world.turn++]
      if (!step) return sse(say('(script ran out)'))
      return typeof step === 'function' ? step(body) : sse(step)
    },
    modelPollMs: 20,
    busyPollMs: 10,
    ...extra,
  })
  return world
}

async function waitFor(cond, what, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = cond()
    if (v) return v
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}
const statusOf = (id) => store.getTask(id)?.status
const ended = (id) => store.TERMINAL_STATES.includes(statusOf(id))
let convCounter = 0
function newConversation() {
  const id = `conv-run-${++convCounter}`
  convs.createConversation(SCOPE, { id, name: 'run', currNode: '', messages: [] })
  return id
}
function branchOf(convId) {
  const { currentBranch } = runnerHelpers
  return currentBranch(convs.getConversation(SCOPE, convId))
}
const runnerHelpers = await import('../../shared/agent-core/stored-messages.mjs')
function start(convId, content = 'do it', extra = {}) {
  const r = runner.startTask({ account: null, storeAccountId: SCOPE, conversationId: convId, content, ...extra })
  assert(r.ok, `startTask: ${r.error}`)
  return r.task
}

await test('a task answers: the user message and the reply are written, the task is done, the chat is freed', async () => {
  fakeWorld([say('All done.')])
  const conv = newConversation()
  const t = start(conv, 'hello there')
  eq(convs.getConversation(SCOPE, conv).activeTaskId, t.id, 'claimed while running')
  await waitFor(() => ended(t.id), 'end')
  eq(statusOf(t.id), 'done', 'status')
  const b = branchOf(conv)
  eq(b.map((m) => [m.role, m.content]), [['system', ''], ['user', 'hello there'], ['assistant', 'All done.']], 'branch')
  eq(b.at(-1).model, 'fake-model', 'model recorded')
  eq(convs.getConversation(SCOPE, conv).activeTaskId, undefined, 'freed')
  const types = store.readEvents(t.id).map((e) => e.type)
  assert(types.includes('message') && types.includes('turn'), `events: ${types}`)
})

await test('a read tool runs without asking; results chain under the call; the conversation id travels', async () => {
  const w = fakeWorld([call('c1', 'read_document', { path: 'a.md' }), say('It says hi.')])
  const conv = newConversation()
  const t = start(conv)
  await waitFor(() => ended(t.id), 'end')
  eq(w.calls.map((c) => [c.name, c.args.path, c.opts.conversationId, c.opts.approvalId]), [['read_document', 'a.md', conv, undefined]], 'call')
  eq(branchOf(conv).slice(1).map((m) => m.role), ['user', 'assistant', 'tool', 'assistant'], 'chain')
  eq(branchOf(conv)[3].content, 'read_document ran', 'result text')
  // The second request carried the call and its result back to the model.
  eq(w.bodies[1].messages.slice(-2).map((m) => m.role), ['assistant', 'tool'], 'history sent')
})

await test('a write parks on an approval the task holds; "once" runs it, and the approval is not left behind', async () => {
  ledger._reset()
  const w = fakeWorld([call('c1', 'create_document', { name: 'x.md' }), say('Saved.')])
  const conv = newConversation()
  const t = start(conv)
  await waitFor(() => statusOf(t.id) === 'waiting_approval', 'waiting_approval')
  const waiting = store.getTask(t.id).waiting
  eq([waiting.kind, waiting.tool, waiting.rule], ['approval', 'create_document', 'prompt'], 'waiting')
  eq(w.calls.length, 0, 'nothing ran yet')
  assert(ledger.decide(waiting.approval.id, ANON_KEY, 'once').ok, 'decided')
  await waitFor(() => ended(t.id), 'end')
  eq([statusOf(t.id), w.calls.map((c) => c.name)], ['done', ['create_document']], 'ran')
  eq(ledger.pendingCount(), 0, 'nothing pending')
})

await test('a delete (enforced) carries the approval id to callToolAs, which spends it', async () => {
  ledger._reset()
  const w = fakeWorld([call('c1', 'delete_file', { path: 'old.txt' }), say('Deleted.')])
  const conv = newConversation()
  const t = start(conv)
  await waitFor(() => statusOf(t.id) === 'waiting_approval', 'waiting_approval')
  const id = store.getTask(t.id).waiting.approval.id
  ledger.decide(id, ANON_KEY, 'once')
  await waitFor(() => ended(t.id), 'end')
  eq(w.calls[0].opts.approvalId, id, 'approval id passed')
})

await test('a denied call gets the denial as its result, and the task goes on', async () => {
  ledger._reset()
  const w = fakeWorld([call('c1', 'delete_file', { path: 'x' }), say('OK, I left it.')])
  const conv = newConversation()
  const t = start(conv)
  await waitFor(() => statusOf(t.id) === 'waiting_approval', 'waiting_approval')
  ledger.decide(store.getTask(t.id).waiting.approval.id, ANON_KEY, 'deny')
  await waitFor(() => ended(t.id), 'end')
  eq([statusOf(t.id), w.calls.length], ['done', 0], 'nothing ran')
  eq(branchOf(conv).find((m) => m.role === 'tool').content, DENIED_RESULT, 'denial')
})

await test('a standing grant runs a write without parking; it never covers a delete', async () => {
  ledger._reset()
  grantsMod.addGrant(ANON_KEY, 'create_document')
  const w = fakeWorld([call('c1', 'create_document', {}), call('c2', 'delete_file', {}), say('done')])
  const conv = newConversation()
  const t = start(conv)
  await waitFor(() => statusOf(t.id) === 'waiting_approval', 'delete parks')
  eq(w.calls.map((c) => c.name), ['create_document'], 'the write ran unasked')
  eq(store.getTask(t.id).waiting.tool, 'delete_file', 'the delete waits')
  runner.cancelTask(t.id)
  await waitFor(() => ended(t.id), 'end')
  for (const g of grantsMod.listGrants(ANON_KEY)) grantsMod.revokeGrant(ANON_KEY, g.id)
})

await test('ask_user waits for an answer, which becomes the call\'s result', async () => {
  fakeWorld([call('q1', 'ask_user', { question: 'Which city?', options: ['Oslo', 'Rome'] }), say('Rome it is.')])
  const conv = newConversation()
  const t = start(conv)
  await waitFor(() => statusOf(t.id) === 'waiting_user', 'waiting_user')
  const waiting = store.getTask(t.id).waiting
  eq([waiting.kind, waiting.question, waiting.options], ['question', 'Which city?', ['Oslo', 'Rome']], 'waiting')
  eq(runner.answerTask(t.id, { continue: true }).status, 400, 'a continue answer to a question')
  assert(runner.answerTask(t.id, { chosen: ['Rome'] }).ok, 'answered')
  await waitFor(() => ended(t.id), 'end')
  assert(/Rome/.test(branchOf(conv).find((m) => m.role === 'tool').content), 'answer in the result')
})

await test('a message typed while a question is open is its answer', async () => {
  fakeWorld([call('q1', 'ask_user', { question: 'Name?' }), say('Thanks.')])
  const conv = newConversation()
  const t = start(conv)
  await waitFor(() => statusOf(t.id) === 'waiting_user', 'waiting_user')
  eq(runner.steerTask(t.id, 'Priya').as, 'answer', 'taken as the answer')
  await waitFor(() => ended(t.id), 'end')
  assert(/Priya/.test(branchOf(conv).find((m) => m.role === 'tool').content), 'answer in the result')
})

await test('the turn limit asks whether to go on (D30); "no" ends the task', async () => {
  fakeWorld([call('c1', 'read_document', {}), call('c2', 'read_document', {}), say('never reached')])
  const conv = newConversation()
  const t = start(conv, 'go', { maxTurns: 1 })
  await waitFor(() => statusOf(t.id) === 'waiting_user', 'continue prompt')
  eq(store.getTask(t.id).waiting.kind, 'continue', 'kind')
  assert(runner.answerTask(t.id, { continue: false }).ok, 'answered')
  await waitFor(() => ended(t.id), 'end')
  eq(statusOf(t.id), 'done', 'status')
})

await test('steering: the turn ends, the message is added, the loop goes on', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const w = fakeWorld([async () => { await gate; return sse(say('first answer')) }, say('second answer')])
  const conv = newConversation()
  const t = start(conv)
  await waitFor(() => w.bodies.length === 1, 'first turn started')
  eq(runner.steerTask(t.id, 'also do this').as, 'steer', 'queued')
  release()
  await waitFor(() => ended(t.id), 'end')
  eq(branchOf(conv).slice(1).map((m) => [m.role, m.content]),
    [['user', 'do it'], ['assistant', 'first answer'], ['user', 'also do this'], ['assistant', 'second answer']], 'branch')
})

await test('cancel while parked: cancelled, the approval withdrawn, the chat freed', async () => {
  ledger._reset()
  fakeWorld([call('c1', 'delete_file', {})])
  const conv = newConversation()
  const t = start(conv)
  await waitFor(() => statusOf(t.id) === 'waiting_approval', 'parked')
  assert(runner.cancelTask(t.id).ok, 'cancel')
  await waitFor(() => ended(t.id), 'end')
  eq([statusOf(t.id), ledger.pendingCount(), convs.getConversation(SCOPE, conv).activeTaskId], ['cancelled', 0, undefined], 'after')
})

await test('no model: waiting_model, then it runs once one is loaded', async () => {
  let port = null
  fakeWorld([say('back')], { upstreamPort: () => port })
  const conv = newConversation()
  const t = start(conv)
  await waitFor(() => statusOf(t.id) === 'waiting_model', 'waiting_model')
  port = 9999
  await waitFor(() => ended(t.id), 'end')
  eq(statusOf(t.id), 'done', 'done')
})

await test('the model goes away mid-task: waiting_model, then the task goes on from where it was', async () => {
  let gone = true
  const w = fakeWorld([
    call('c1', 'read_document', {}),
    async () => { if (gone) { gone = false; throw new TypeError('fetch failed') } return sse(say('unused')) },
    say('finished after the restart'),
  ])
  const conv = newConversation()
  const t = start(conv)
  await waitFor(() => ended(t.id), 'end')
  eq(statusOf(t.id), 'done', 'done')
  assert(store.readEvents(t.id).some((e) => e.status === 'waiting_model'), 'was waiting_model')
  eq(branchOf(conv).at(-1).content, 'finished after the restart', 'went on')
  eq(w.calls.length, 1, 'the tool ran once, not again')
})

await test('a chat\'s completion in flight goes first (D29)', async () => {
  let busy = 1
  const w = fakeWorld([say('after the chat')], { completionsInFlight: () => busy })
  const conv = newConversation()
  const t = start(conv)
  await new Promise((r) => setTimeout(r, 80))
  eq(w.bodies.length, 0, 'held while a chat generates')
  busy = 0
  await waitFor(() => ended(t.id), 'end')
})

await test('a second task on a conversation that has one is refused; an unknown conversation is 404', async () => {
  ledger._reset()
  fakeWorld([call('c1', 'delete_file', {})])
  const conv = newConversation()
  const t = start(conv)
  const again = runner.startTask({ account: null, storeAccountId: SCOPE, conversationId: conv, content: 'x' })
  eq([again.ok, again.status], [false, 409], 'second')
  eq(runner.startTask({ account: null, storeAccountId: SCOPE, conversationId: 'nope', content: 'x' }).status, 404, 'unknown')
  eq(runner.startTask({ account: null, storeAccountId: 'other-device', conversationId: conv, content: 'x' }).status, 404, 'another scope')
  runner.cancelTask(t.id)
  await waitFor(() => ended(t.id), 'end')
})

await test('a deleted conversation cancels its task at the next write', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  fakeWorld([async () => { await gate; return sse(say('too late')) }])
  const conv = newConversation()
  const t = start(conv)
  await waitFor(() => statusOf(t.id) === 'running', 'running')
  convs.deleteConversation(SCOPE, conv)
  release()
  await waitFor(() => ended(t.id), 'end')
  eq(statusOf(t.id), 'cancelled', 'cancelled')
})

await test('sampling settings travel; unknown fields are dropped; the project and mode ride as ids', async () => {
  const w = fakeWorld([say('ok')])
  const conv = newConversation()
  convs.updateConversation(SCOPE, conv, { promptMode: 'research', projectId: 'p-1', thinkingEnabled: true })
  const t = start(conv, 'go', { generation: { temperature: 0.3, max_tokens: 512, evil: 'x', model: 'other' } })
  await waitFor(() => ended(t.id), 'end')
  const b = w.bodies[0]
  eq([b.temperature, b.max_tokens, b.evil, b.model, b.redstart_mode, b.redstart_project, b.chat_template_kwargs.enable_thinking],
    [0.3, 512, undefined, undefined, 'research', 'p-1', true], 'body')
})

await test('auth turned on after an auth-off task started: the task fails at its next turn', async () => {
  const accounts = await import('../daemon/accounts-storage.mjs')
  fakeWorld([say('never')])
  const conv = newConversation()
  accounts.setAuthRequired(true)
  try {
    const t = start(conv)
    await waitFor(() => ended(t.id), 'end')
    eq(statusOf(t.id), 'failed', 'failed')
    assert(/Login was turned on/.test(store.getTask(t.id).error), store.getTask(t.id).error)
  } finally {
    accounts.setAuthRequired(false)
  }
})

await test('accountForTask: a disabled or deleted account stops its task; an active one runs as itself', async () => {
  const { accountForTask } = await import('../daemon/auth.mjs')
  accountsStore.setAuthRequired(true)
  try {
    accountsStore.insertAccount({ id: 'acct-on', username: 'onn', tier: 'user', status: 'active' })
    accountsStore.insertAccount({ id: 'acct-off', username: 'offf', tier: 'user', status: 'disabled' })
    const on = accountForTask('acct-on')
    eq([on.ok, on.account?.username], [true, 'onn'], 'active')
    assert(/disabled/.test(accountForTask('acct-off').reason), 'disabled')
    assert(/no longer exists/.test(accountForTask('acct-gone').reason), 'deleted')
  } finally {
    accountsStore.setAuthRequired(false)
  }
})

await test('the real prepareCompletion runs on a task\'s request: the prompt is composed, redstart_* fields stripped', async () => {
  const w = fakeWorld([say('ok')])
  runner._setTestSeams({ ...seamsWithoutPrepare(w) })
  const conv = newConversation()
  convs.updateConversation(SCOPE, conv, { promptMode: 'research' })
  const t = start(conv)
  await waitFor(() => ended(t.id), 'end')
  eq(statusOf(t.id), 'done', `status (${store.getTask(t.id).error})`)
  const b = w.bodies[0]
  eq([b.messages[0].role, 'redstart_mode' in b, 'redstart_project' in b], ['system', false, false], 'body')
  assert(/Redstart/i.test(b.messages[0].content), 'the composed prompt')
})

console.log('\n-- compaction in the core, used by the runner (3.8, D32) --')

await test('a long history is folded into a stored summary, as chat-ui does; the tail stays verbatim', async () => {
  const { SUMMARY_PREFIX } = await import('../../shared/agent-core/compaction.mjs')
  let summaries = 0
  const w = fakeWorld([say('answered with a compacted history')], {
    effectiveConfigFor: async () => ({ ctxSize: 4096 }),
    // Every character a token: the seeded history is far over budget.
    tokenize: async (_port, content) => content.length,
    fetchCompletion: async (_port, body) => {
      if (body.stream === false) {
        summaries++
        assert(/Progressively summarize/.test(body.messages[0].content), 'the summary prompt')
        return new Response(JSON.stringify({ choices: [{ message: { content: 'They discussed the plan.' } }] }))
      }
      w.bodies.push(body)
      return sse(say('answered with a compacted history'))
    },
  })
  const conv = newConversation()
  // Twenty long turns, then the task's own message.
  let parent = convs.appendMessage(SCOPE, conv, { id: 'root-c', parent: null, type: 'root', role: 'system', content: '' }).id
  for (let i = 0; i < 20; i++) {
    parent = convs.appendMessage(SCOPE, conv, { id: `h${i}`, parent, type: 'text', role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ${'x'.repeat(400)}` }).id
  }
  const t = start(conv, 'and now?')
  await waitFor(() => ended(t.id), 'end')
  eq([statusOf(t.id), summaries], ['done', 1], 'one summary')
  const sent = w.bodies[0].messages
  assert(sent[0].role === 'system' && sent[0].content.startsWith(SUMMARY_PREFIX), 'the summary leads')
  eq(sent.at(-1).content, 'and now?', 'the newest message is verbatim')
  assert(sent.length < 22, `history shrank (${sent.length} messages)`)
  const stored = convs.getConversation(SCOPE, conv).contextSummary
  eq(stored.text, 'They discussed the plan.', 'stored on the conversation')
  assert(store.readEvents(t.id).some((e) => e.type === 'compacted' && e.summarized), 'logged')
})

await test('compaction off (the client\'s setting) sends the history whole', async () => {
  const w = fakeWorld([say('ok')], { effectiveConfigFor: async () => ({ ctxSize: 4096 }), tokenize: async (_p, c) => c.length })
  const conv = newConversation()
  let parent = convs.appendMessage(SCOPE, conv, { id: 'root-d', parent: null, type: 'root', role: 'system', content: '' }).id
  for (let i = 0; i < 10; i++) parent = convs.appendMessage(SCOPE, conv, { id: `d${i}`, parent, type: 'text', role: 'user', content: 'y'.repeat(800) }).id
  const t = start(conv, 'go', { generation: { contextCompaction: false } })
  await waitFor(() => ended(t.id), 'end')
  eq(w.bodies[0].messages.length, 11, 'all of it')
})

console.log('\n-- the routes (3.6, D31) --')

const { handleTaskRoute, isTaskRoute } = await import('../daemon/gateway/task-routes.mjs')

/** A response that also records SSE writes and can be told the client left. */
function sseRes() {
  const res = fakeRes()
  res.chunks = []
  res.writableEnded = false
  res.write = (c) => { res.chunks.push(c); return true }
  res.end = (b) => { if (b) res.chunks.push(b); res.body = b ?? res.body; res.writableEnded = true }
  return res
}
async function taskRoute(method, urlPath, body, { scope = SCOPE, headers = {} } = {}) {
  const req = fakeReq(method, body, urlPath)
  req.headers = headers
  const res = sseRes()
  const handled = await handleTaskRoute(req, res, urlPath.split('?')[0], { account: null, storeAccountId: scope, surface: null, timeZone: null })
  let json = null
  try { json = res.body ? JSON.parse(res.body) : null } catch { /* SSE */ }
  return { handled, status: res.status, json, res, req }
}
function sseEvents(res) {
  return res.chunks.join('').split('\n\n').filter((b) => b.startsWith('id: ')).map((b) => JSON.parse(b.split('\ndata: ')[1]))
}

await test('which paths are ours', () => {
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
  eq(['/tasks', `/tasks/${id}`, `/tasks/${id}/events`, `/tasks/${id}/answer`, `/tasks/${id}/nope`, '/tasks/abc', '/tasksx'].map(isTaskRoute),
    [true, true, true, true, false, false, false], 'isTaskRoute')
})

await test('POST /tasks starts one (201, no storage scope in the body); bad input is 400, an unknown chat 404', async () => {
  fakeWorld([say('route answer')])
  const conv = newConversation()
  const r = await taskRoute('POST', '/tasks', { conversationId: conv, content: 'via route' })
  eq(r.status, 201, 'status')
  assert(r.json.id && !('storeAccountId' in r.json) && !('accountKey' in r.json), 'public shape')
  await waitFor(() => ended(r.json.id), 'end')
  eq((await taskRoute('POST', '/tasks', { conversationId: conv })).status, 400, 'no content')
  eq((await taskRoute('POST', '/tasks', { content: 'x' })).status, 400, 'no conversation')
  eq((await taskRoute('POST', '/tasks', { conversationId: 'nope', content: 'x' })).status, 404, 'unknown')
})

await test('another scope sees none of it: GET, events and every action are 404', async () => {
  fakeWorld([say('x')])
  const conv = newConversation()
  const t = start(conv)
  await waitFor(() => ended(t.id), 'end')
  const other = { scope: 'device-2' }
  eq((await taskRoute('GET', `/tasks/${t.id}`, null, other)).status, 404, 'get')
  eq((await taskRoute('GET', `/tasks/${t.id}/events`, null, other)).status, 404, 'events')
  for (const a of ['steer', 'answer', 'cancel']) eq((await taskRoute('POST', `/tasks/${t.id}/${a}`, {}, other)).status, 404, a)
  assert(!(await taskRoute('GET', '/tasks', null, other)).json.tasks.some((x) => x.id === t.id), 'listed')
  assert((await taskRoute('GET', `/tasks?conversationId=${conv}`)).json.tasks.every((x) => x.conversationId === conv), 'filter')
})

await test('events: replay after Last-Event-ID, then live, and the stream ends with the task', async () => {
  ledger._reset()
  fakeWorld([call('c1', 'delete_file', {}), say('finished')])
  const conv = newConversation()
  const t = start(conv)
  await waitFor(() => statusOf(t.id) === 'waiting_approval', 'parked')
  const r = await taskRoute('GET', `/tasks/${t.id}/events`, null, { headers: { 'last-event-id': '2' } })
  eq(r.status, 200, 'status')
  const replayed = sseEvents(r.res)
  assert(replayed.length > 0 && replayed.every((e) => e.seq > 2), `replay starts after 2: ${replayed.map((e) => e.seq)}`)
  assert(!r.res.writableEnded, 'still open while the task waits')
  ledger.decide(store.getTask(t.id).waiting.approval.id, ANON_KEY, 'once')
  await waitFor(() => r.res.writableEnded, 'stream ended')
  const all = sseEvents(r.res)
  eq(all.at(-1).status, 'done', 'last event')
  const seqs = all.map((e) => e.seq)
  eq(seqs, [...new Set(seqs)].sort((a, b) => a - b), 'in order, no duplicates')
})

await test('events for an ended task: the replay, then closed; ?after= works like the header', async () => {
  fakeWorld([say('x')])
  const conv = newConversation()
  const t = start(conv)
  await waitFor(() => ended(t.id), 'end')
  const r = await taskRoute('GET', `/tasks/${t.id}/events?after=1`)
  assert(r.res.writableEnded, 'closed')
  assert(sseEvents(r.res).every((e) => e.seq > 1), 'after 1')
})

await test('answer, steer and cancel through the routes', async () => {
  fakeWorld([call('q1', 'ask_user', { question: 'Go?' }), say('went')])
  const conv = newConversation()
  const t = start(conv)
  await waitFor(() => statusOf(t.id) === 'waiting_user', 'asked')
  eq((await taskRoute('POST', `/tasks/${t.id}/answer`, {})).status, 400, 'empty answer')
  eq((await taskRoute('POST', `/tasks/${t.id}/answer`, { text: 'yes' })).status, 200, 'answered')
  await waitFor(() => ended(t.id), 'end')
  eq((await taskRoute('POST', `/tasks/${t.id}/steer`, { content: 'more' })).status, 409, 'steer an ended task')
  eq((await taskRoute('POST', `/tasks/${t.id}/cancel`)).json.ok, true, 'cancel an ended task is a no-op')

  ledger._reset()
  fakeWorld([call('c1', 'delete_file', {})])
  const conv2 = newConversation()
  const t2 = start(conv2)
  await waitFor(() => statusOf(t2.id) === 'waiting_approval', 'parked')
  eq((await taskRoute('POST', `/tasks/${t2.id}/cancel`)).status, 200, 'cancel')
  await waitFor(() => ended(t2.id), 'end')
  eq(statusOf(t2.id), 'cancelled', 'cancelled')
})

await test('control plane: tasks:list carries the record, never the question or an approval summary; tasks:cancel stops one', async () => {
  const { tasksHandlers } = await import('../daemon/ipc/tasks.mjs')
  const h = tasksHandlers()
  fakeWorld([call('q1', 'ask_user', { question: 'A private question about Priya?' })])
  const conv = newConversation()
  const t = start(conv)
  await waitFor(() => statusOf(t.id) === 'waiting_user', 'asked')
  const row = h['tasks:list']().tasks.find((x) => x.id === t.id)
  eq([row.status, row.waitingFor], ['waiting_user', 'question'], 'row')
  assert(!JSON.stringify(row).includes('Priya') && !('waiting' in row) && !('conversationId' in row), 'no content')
  eq(h['tasks:cancel'](t.id).ok, true, 'cancel')
  await waitFor(() => ended(t.id), 'end')
  eq(statusOf(t.id), 'cancelled', 'cancelled')
  eq(h['tasks:cancel']('').ok, false, 'no id')
})

console.log('\n-- the bench\'s --runtime: the daemon hosts the loop (3.10) --')

// The bench's runtime client (scripts/agent-bench/lib/runtime.mjs) against the
// REAL task routes, runner and approval routes over HTTP; only the model and
// the tools are scripted (fakeWorld). This is the path `run.mjs --runtime`
// takes against a real Nest, minus llama-server.
const http = await import('node:http')
const { handleApprovalRoute, isApprovalRoute } = await import('../daemon/gateway/approval-routes.mjs')
const { runViaRuntime } = await import('./agent-bench/lib/runtime.mjs')
const { makeRequester, taskRoutesClient, parseSseFrames } = await import('./agent-bench/lib/nest-client.mjs')
const { computeMetrics } = await import('./agent-bench/lib/metrics.mjs')

async function benchServer() {
  const server = http.createServer(async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname
    if (isTaskRoute(p) && await handleTaskRoute(req, res, p, { account: null, storeAccountId: SCOPE, surface: null, timeZone: null })) return
    if (isApprovalRoute(p) && await handleApprovalRoute(req, res, p, null)) return
    const m = /^\/conversations\/([^/]+)$/.exec(p)
    if (m && req.method === 'GET') {
      const c = convs.getConversation(SCOPE, decodeURIComponent(m[1]))
      res.writeHead(c ? 200 : 404, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify(c ?? {}))
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const gateway = `http://127.0.0.1:${server.address().port}`
  const req = makeRequester({ gateway, auth: {}, doFetch: fetch, requestTimeoutMs: 10_000 })
  return {
    nest: taskRoutesClient({ gateway, auth: {}, doFetch: fetch, req }),
    close: () => { server.closeAllConnections?.(); server.close() },
  }
}

const BENCH_TOOLS = new Map(TOOLS.map((t) => [t.name, t]))
const benchTask = (over = {}) => ({
  id: 'rt', prompt: 'Do the thing.', fixtures: [], limits: { maxTurns: 8, maxSeconds: 20 }, approve: 'all', answers: {}, ...over,
})
async function runtimeRun(task, opts = {}) {
  const { nest, close } = await benchServer()
  const events = []
  try {
    const conversationId = newConversation()
    const r = await runViaRuntime({ nest, task, opts, log: (e) => events.push({ t: Date.now(), ...e }), conversationId, toolsByName: BENCH_TOOLS })
    return { ...r, events, conversationId }
  } finally {
    close()
  }
}
const named = (events, type) => events.filter((e) => e.type === type)

await test('parseSseFrames: whole frames out, the torn tail kept, heartbeats skipped', () => {
  const { events, rest } = parseSseFrames('id: 1\ndata: {"seq":1,"type":"turn"}\n\n: keep-alive\n\nid: 2\ndata: {"seq":2,')
  eq([events.map((e) => e.seq), rest], [[1], 'id: 2\ndata: {"seq":2,'], 'frames')
})

await test('a question is answered from the task file, an approval decided by its policy; the log matches the hosted bench\'s', async () => {
  ledger._reset()
  fakeWorld([
    call('q1', 'ask_user', { question: 'What name should I sign with?' }),
    call('d1', 'delete_file', { path: 'old.txt' }),
    say('Signed as Priya, and the file is gone.'),
  ])
  const r = await runtimeRun(benchTask({ answers: { name: 'Priya' } }), { thinking: false })
  eq([r.error, r.finalText], [null, 'Signed as Priya, and the file is gone.'], 'ended with the answer')
  eq(named(r.events, 'tool_call').map((e) => e.name), ['ask_user', 'delete_file'], 'calls, in order')
  const ask = named(r.events, 'tool_result').find((e) => e.name === 'ask_user')
  assert(/Priya/.test(ask.text) && ask.dismissed === false, `the answer reached the model: ${ask.text}`)
  eq(named(r.events, 'approval').map((e) => [e.name, e.decided]), [['delete_file', true]], 'approved once')
  eq(named(r.events, 'tool_result').find((e) => e.name === 'delete_file').text, 'delete_file ran', 'it ran')
  eq(named(r.events, 'turn').length, 3, 'turns from the stream')
  eq(named(r.events, 'assistant').length, 3, 'one assistant event per stored turn')
  const m = computeMetrics(r.events, { pass: true })
  assert(m.turns === 3 && m.toolCalls === 2, `metrics read the rebuilt log: ${JSON.stringify(m)}`)
})

await test('a policy that refuses: the approval is denied, the call is logged as a refused error, nothing ran', async () => {
  ledger._reset()
  const w = fakeWorld([call('d2', 'delete_file', { path: 'x' }), say('I could not delete it.')])
  const r = await runtimeRun(benchTask({ approve: ['ask_user'] }))
  eq(named(r.events, 'approval').map((e) => [e.decided, e.denied]), [[false, true]], 'denied')
  const res = named(r.events, 'tool_result')[0]
  eq([res.text, res.isError, res.denied], [DENIED_RESULT, true, true], 'the refusal')
  eq(w.calls.length, 0, 'the tool never ran')
})

await test('an unmatched question is a dismissal; the turn limit is answered no and logged', async () => {
  fakeWorld([
    call('q2', 'ask_user', { question: 'Which colour?' }),
    call('a1', 'read_document', { name: 'a' }),
    call('a2', 'read_document', { name: 'b' }),
  ])
  const r = await runtimeRun(benchTask({ limits: { maxTurns: 3, maxSeconds: 20 } }))
  eq(named(r.events, 'tool_result').find((e) => e.name === 'ask_user').dismissed, true, 'dismissed')
  eq(named(r.events, 'limit').map((e) => e.which), ['turns'], 'the limit')
  eq(r.finalText, '', 'no final answer')
})

await test('--text-asks answer: a reply ending in a question gets the task file\'s answer as a second task', async () => {
  fakeWorld([say('Which colour do you want?'), say('Blue it is.')])
  const r = await runtimeRun(benchTask({ answers: { colour: 'blue' } }), { textAsks: 'answer' })
  eq(named(r.events, 'runtime_task').length, 2, 'two tasks')
  eq(named(r.events, 'text_ask').map((e) => [e.answered, e.reply]), [[true, 'blue']], 'answered')
  eq(r.finalText, 'Blue it is.', 'the second reply is the answer')
})

await test('a plan nudge is a stream event, so the metric counts it', async () => {
  fakeWorld([
    call('p1', 'update_plan', { steps: [{ text: 'one', status: 'in_progress' }, { text: 'two', status: 'pending' }] }),
    say('Done.'),
    call('p2', 'update_plan', { steps: [{ text: 'one', status: 'done' }, { text: 'two', status: 'done' }] }),
    say('Both done.'),
  ])
  const r = await runtimeRun(benchTask())
  eq(named(r.events, 'plan_nudge').length, 1, 'nudged once')
  eq(named(r.events, 'plan_final').map((e) => [e.steps, e.open]), [[2, 0]], 'the stored plan, closed')
  eq(r.finalText, 'Both done.', 'final')
})

console.log('\n-- restart recovery, across a real process kill (3.7) --')

const { spawn } = await import('node:child_process')
const { fileURLToPath } = await import('node:url')
const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib', 'task-restart-child.mjs')

/** Run the child; resolve with the first line tagged with one of `tags`. */
function child(args, dataDir, tags, { kill = false, noModel = false } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, REDSTART_TEST_USERDATA_DIR: dataDir, ...(noModel ? { TASK_CHILD_NO_MODEL: '1' } : {}) }
    const p = spawn(process.execPath, [CHILD, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`child ${args.join(' ')} timed out\n${out}\n${err}`)) }, 20000)
    p.stderr.on('data', (d) => { err += d })
    p.stdout.on('data', (d) => {
      out += d
      for (const line of out.split('\n')) {
        const tag = tags.find((t) => line.startsWith(`${t} `))
        if (!tag) continue
        clearTimeout(timer)
        const rest = line.slice(tag.length + 1)
        if (kill) {
          // No exit handlers, no flush: as a power cut or Task Manager would.
          p.kill('SIGKILL')
          p.on('exit', () => resolve({ tag, rest }))
        } else {
          resolve({ tag, rest: rest.startsWith('{') ? JSON.parse(rest) : rest })
        }
        return
      }
    })
    p.on('exit', (code) => { if (code && code !== 0) { clearTimeout(timer); reject(new Error(`child exited ${code}\n${err}`)) } })
  })
}

await test('killed with a tool running: that call is closed as interrupted, the next one runs once, the task finishes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-restart-'))
  try {
    await child(['start', 'in-flight'], dir, ['READY'], { kill: true })
    const { tag, rest } = await child(['resume', 'in-flight'], dir, ['RESULT', 'WAITING'])
    eq([tag, rest.resumed, rest.status], ['RESULT', 1, 'done'], 'resumed and done')
    const tools = rest.branch.filter((m) => m.role === 'tool')
    eq(tools.map((m) => [m.toolCallId, m.content]), [['c1', runner.INTERRUPTED_BY_RESTART], ['c2', 'read_document two ran']], 'results')
    eq(rest.calls, [{ name: 'read_document', path: 'two' }], 'the interrupted call was NOT run again')
    eq(rest.branch.at(-1).content, 'Finished after the restart.', 'went on')
    eq(rest.activeTaskId, null, 'the chat is freed')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await test('killed while a question was open: after the restart it is asked again, with no model loaded yet', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-restart-'))
  try {
    await child(['start', 'question'], dir, ['READY'], { kill: true })
    // The daemon comes back with no model: the question needs none.
    const waiting = await child(['resume', 'question'], dir, ['RESULT', 'WAITING'], { noModel: true })
    eq([waiting.tag, waiting.rest.status, waiting.rest.waiting?.question], ['WAITING', 'waiting_user', 'Which colour?'], 'waiting again')
    // A second restart, answering this time.
    const done = await child(['resume', 'question', 'Blue'], dir, ['RESULT'])
    eq(done.rest.status, 'done', 'done')
    assert(/Blue/.test(done.rest.branch.find((m) => m.role === 'tool').content), 'the answer is the result')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await test('an orderly stop (suspendAllTasks) leaves the task unended, and a resume finishes it', async () => {
  ledger._reset()
  fakeWorld([call('c1', 'delete_file', {}), say('after resume')])
  const conv = newConversation()
  const t = start(conv)
  await waitFor(() => statusOf(t.id) === 'waiting_approval', 'parked')
  const before = store.getTask(t.id).waiting.approval.id
  await runner.suspendAllTasks()
  eq(statusOf(t.id), 'waiting_approval', 'not ended')
  eq(convs.getConversation(SCOPE, conv).activeTaskId, t.id, 'still claimed')
  ledger._reset() // a restart drops the ledger
  assert(runner.resumeTasks() >= 1, 'resumed')
  // The record shows the old approval until the resumed run asks again.
  await waitFor(() => { const id = store.getTask(t.id).waiting?.approval?.id; return id && id !== before }, 'asked again')
  ledger.decide(store.getTask(t.id).waiting.approval.id, ANON_KEY, 'once')
  await waitFor(() => ended(t.id), 'end')
  eq([statusOf(t.id), branchOf(conv).at(-1).content], ['done', 'after resume'], 'finished')
})

await test('resume cancels a task whose conversation is gone', async () => {
  const t = store.createTask({ accountKey: ANON_KEY, storeAccountId: SCOPE, conversationId: 'gone-conv' })
  store.updateTask(t.id, { status: 'running' })
  runner.resumeTasks()
  eq(statusOf(t.id), 'cancelled', 'cancelled')
})

/** fakeWorld's seams with the gateway's own prepareCompletion left in place. */
function seamsWithoutPrepare(w) {
  return {
    effectiveConfigFor: async () => ({}),
    toolCatalogFor: async () => TOOLS,
    callToolAs: async () => ({ content: [{ type: 'text', text: 'ran' }] }),
    upstreamPort: () => 9999,
    completionsInFlight: () => 0,
    fetchCompletion: async (_port, body) => { w.bodies.push(body); return sse(say('ok')) },
    modelPollMs: 20,
  }
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
process.exit(failed.length ? 1 : 0)
