// =============================================================================
// The conversation workspace — where a chat's files live, and when they go
// =============================================================================
// chat-tooling plan §2. What is pinned here:
//
//   - the layout: <documents>/user_files/<scope>/chats/<id>/, scratch when no id
//   - an id is one safe path segment or it is refused (never joined raw)
//   - two accounts with the same conversation id get two folders
//   - the conversation id a tool call claims is honoured only if it is the
//     caller's (mcp-server.mjs verifiedConversationId)
//   - caps: over the workspace or account limit refuses, with what to do
//   - DELETE /conversations/:id trashes that conversation's workspace, and
//     only the caller's — a fork owned by someone else keeps its files
//   - the startup sweep trashes workspaces whose conversation is gone, and
//     nothing else; trash, never delete
//   - changedFiles never reports through a link
//
// Run:  node scripts/test-conversation-workspace.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Readable } from 'node:stream'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-workspace-test-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir
register('./auth-test-loader.mjs', import.meta.url)
await import('./electron-stub.mjs')

const ws = await import('../daemon/conversation-workspace.mjs')
const store = await import('../daemon/conversations-storage.mjs')
const { setCapabilityConfig } = await import('../daemon/tools-storage.mjs')
const { handleConversationRoute } = await import('../daemon/gateway/conversation-routes.mjs')
const { verifiedConversationId } = await import('../daemon/mcp-server.mjs')
const { setAuthRequired, getAuthRequired } = await import('../daemon/auth.mjs')

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

const docs = fs.mkdtempSync(path.join(tmpDir, 'docs-'))
setCapabilityConfig('documents', { outputDir: docs })
const ALICE = { id: 'alice-0001', username: 'alice' }
const BOB = { id: 'bob-0002', username: 'bob' }

await test('layout: user_files/<scope>/chats/<id>, and _scratch with no id', () => {
  const a = ws.workspaceDir(docs, ALICE, 'c1', { create: true })
  const s = ws.workspaceDir(docs, ALICE, null, { create: true })
  assert(a === path.join(docs, 'user_files', 'alice-alice000', 'chats', 'c1') || /user_files[\\/]alice-[a-z0-9]+[\\/]chats[\\/]c1$/.test(a), a)
  assert(s.endsWith(path.join('chats', '_scratch')), s)
  assert(fs.existsSync(a) && fs.existsSync(s), 'not created')
})

await test('two accounts, the same conversation id, two folders', () => {
  const a = ws.workspaceDir(docs, ALICE, 'same')
  const b = ws.workspaceDir(docs, BOB, 'same')
  assert(a !== b && !a.startsWith(path.dirname(b)), `${a} vs ${b}`)
})

await test('a malformed id is refused, never joined', () => {
  for (const bad of ['../x', 'a/b', 'a\\b', '..', '.', '', 'x'.repeat(65), 'c:', 'id with space', '_scratch']) {
    assert(!ws.isWellFormedConversationId(bad), `accepted ${JSON.stringify(bad)}`)
  }
  let threw = false
  try { ws.workspaceDir(docs, ALICE, '../../escape') } catch { threw = true }
  assert(threw, 'workspaceDir accepted a traversal id')
  assert(ws.isWellFormedConversationId('0b7c1e2a-9f3d-4c1a-8e2b-1234567890ab'), 'a uuid was refused')
})

await test('verifiedConversationId: only the caller\'s own conversation', () => {
  store.createConversation(ALICE.id, { id: 'alice-conv', name: 'a' })
  assert(verifiedConversationId(ALICE, 'alice-conv') === 'alice-conv', 'owner refused')
  assert(verifiedConversationId(BOB, 'alice-conv') === null, 'another account\'s id was honoured')
  assert(verifiedConversationId(ALICE, 'no-such-conv') === null, 'an unknown id was honoured')
  assert(verifiedConversationId(ALICE, '../alice-conv') === null, 'a malformed id was honoured')
  assert(verifiedConversationId(ALICE, undefined) === null, 'absent id became something')
})

await test('verifiedConversationId with auth off: a well-formed id is taken (shared _local scope)', () => {
  const was = getAuthRequired()
  setAuthRequired(false)
  try {
    assert(verifiedConversationId(null, 'whatever-1') === 'whatever-1', 'refused with auth off')
    assert(verifiedConversationId(null, '../x') === null, 'malformed accepted with auth off')
  } finally { setAuthRequired(was) }
  // With auth ON, a null account is a broken invariant, never a pass.
  setAuthRequired(true)
  try { assert(verifiedConversationId(null, 'whatever-1') === null, 'null account honoured with auth on') } finally { setAuthRequired(was) }
})

await test('caps: over the workspace limit, then over the account limit, each says what to do', () => {
  const dir = ws.workspaceDir(docs, BOB, 'capped', { create: true })
  fs.writeFileSync(path.join(dir, 'a.bin'), Buffer.alloc(3000))
  const w = ws.checkCaps(docs, BOB, 'capped', { workspaceCapBytes: 1000, accountCapBytes: 1e9 })
  assert(!w.ok && /chats\/capped/.test(w.reason), JSON.stringify(w))
  const a = ws.checkCaps(docs, BOB, 'other', { workspaceCapBytes: 1e9, accountCapBytes: 1000 })
  assert(!a.ok && /in total/.test(a.reason), JSON.stringify(a))
  const ok = ws.checkCaps(docs, BOB, 'capped', { workspaceCapBytes: 1e9, accountCapBytes: 1e9 })
  assert(ok.ok && ok.workspaceBytes === 3000, JSON.stringify(ok))
})

await test('changedFiles reports new files, relative, and never through a link', () => {
  const dir = ws.workspaceDir(docs, ALICE, 'changes', { create: true })
  const since = Date.now() - 5
  fs.mkdirSync(path.join(dir, 'sub'))
  fs.writeFileSync(path.join(dir, 'sub', 'b.csv'), 'x')
  fs.writeFileSync(path.join(dir, 'a.png'), 'x')
  const outside = fs.mkdtempSync(path.join(tmpDir, 'out-'))
  fs.writeFileSync(path.join(outside, 'secret.txt'), 's')
  try { fs.symlinkSync(outside, path.join(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir') } catch {}
  const list = ws.changedFiles(dir, since).map((f) => f.path).join(',')
  assert(list === 'a.png,sub/b.csv', list)
})

// A tiny request/response pair for the route, which reads only method/url and
// writes status + body.
function fakeRes() {
  const res = { status: 0, headersSent: false, writeHead(s) { this.status = s; this.headersSent = true; return this }, setHeader() {}, end() {} }
  return res
}
function fakeReq(method, url) {
  const req = Readable.from([])
  req.method = method; req.url = url; req.headers = {}
  return req
}

await test('DELETE /conversations/:id trashes that workspace, and spares another account\'s fork', async () => {
  store.createConversation(ALICE.id, { id: 'root-1', name: 'r' })
  store.createConversation(ALICE.id, { id: 'fork-a', name: 'f', forkedFromConversationId: 'root-1' })
  store.createConversation(BOB.id, { id: 'fork-b', name: 'g', forkedFromConversationId: 'root-1' })
  for (const [acct, id] of [[ALICE, 'root-1'], [ALICE, 'fork-a'], [BOB, 'fork-b']]) {
    fs.writeFileSync(path.join(ws.workspaceDir(docs, acct, id, { create: true }), 'f.txt'), id)
  }
  const res = fakeRes()
  const handled = await handleConversationRoute(fakeReq('DELETE', '/conversations/root-1?deleteWithForks=true'), res, '/conversations/root-1', ALICE.id, { account: ALICE })
  assert(handled && res.status === 204, `status ${res.status}`)
  assert(!fs.existsSync(ws.workspaceDir(docs, ALICE, 'root-1')), 'root workspace still there')
  assert(!fs.existsSync(ws.workspaceDir(docs, ALICE, 'fork-a')), 'own fork workspace still there')
  assert(fs.existsSync(path.join(ws.workspaceDir(docs, BOB, 'fork-b'), 'f.txt')), 'Bob\'s fork lost its files')
  // Trashed, not deleted: it is in the scope's .trash/ (no recycle bin under the test stub).
  const trash = path.join(docs, 'user_files', fs.readdirSync(path.join(docs, 'user_files')).find((s) => s.startsWith('alice-')), '.trash')
  const trashed = fs.existsSync(trash) ? fs.readdirSync(trash, { recursive: true }).map(String).filter((p) => p.endsWith('f.txt')) : []
  return `${trashed.length} file(s) in .trash`
})

await test('the startup sweep trashes orphaned workspaces only', async () => {
  const keep = ws.workspaceDir(docs, ALICE, 'alice-conv', { create: true })
  const orphan = ws.workspaceDir(docs, BOB, 'gone-conv', { create: true })
  fs.writeFileSync(path.join(orphan, 'x.txt'), 'x')
  const scratch = ws.workspaceDir(docs, BOB, null, { create: true })
  const moved = await ws.sweepOrphanWorkspaces(docs, store.allConversationIds())
  assert(fs.existsSync(keep), 'a live workspace was swept')
  assert(fs.existsSync(scratch), 'scratch was swept')
  assert(!fs.existsSync(orphan), 'the orphan survived')
  assert(moved.some((m) => m.endsWith('gone-conv')), JSON.stringify(moved))
})

await test('sweeping with no documents root is a no-op', async () => {
  const moved = await ws.sweepOrphanWorkspaces(null, new Set())
  assert(moved.length === 0, 'moved something')
})

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
process.exit(failed.length ? 1 : 0)
