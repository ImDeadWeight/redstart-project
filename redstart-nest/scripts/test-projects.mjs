// =============================================================================
// Projects — personal, owner-only, chats move out on delete (projects-plan)
// =============================================================================
// Pinned here:
//   - validation: a name is required and bounded, instructions are bounded,
//     names are unique per account (case-insensitive), the body never sets
//     id / ownerKey / members / slug
//   - the slug: folder-safe, fixed at creation, unique within the account
//   - isolation: one account never lists, reads, edits or deletes another's
//     project, through the store or the routes; a foreign id answers 404
//   - every record carries ownerKey and members: [] from the start (plan D7)
//   - delete: the chats that pointed at it MOVE OUT (kept, reference
//     cleared, lastModified untouched), its memories go, other projects'
//     chats and memories are untouched
//   - project memory is its own scope: never listed with the account's own
//   - conversations: projectId must name one of the caller's projects (on
//     create and on edit), null moves a chat out, and a PUT can never rewrite
//     a record's accountId or id (plan D11)
//   - the 30-day cleanup keeps chats that are in a project (plan D12)
//
// Run:  node scripts/test-projects.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Readable } from 'node:stream'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-projects-test-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir
register('./auth-test-loader.mjs', import.meta.url)
await import('./electron-stub.mjs')

const store = await import('../daemon/projects-storage.mjs')
const memory = await import('../daemon/memory-storage.mjs')
const convs = await import('../daemon/conversations-storage.mjs')
const { handleProjectRoute, isProjectRoute } = await import('../daemon/gateway/project-routes.mjs')
const { handleConversationRoute } = await import('../daemon/gateway/conversation-routes.mjs')

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

function fakeReq(method, body) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [])
  req.method = method; req.headers = {}
  return req
}
function fakeRes() {
  return { status: 0, body: '', writeHead(s) { this.status = s; return this }, end(b) { this.body = b ?? '' } }
}
async function route(method, urlPath, account, body) {
  const res = fakeRes()
  const handled = await handleProjectRoute(fakeReq(method, body), res, urlPath, account)
  return { handled, status: res.status, json: res.body ? JSON.parse(res.body) : null }
}

await test('validation: name required and bounded, instructions bounded', () => {
  assert(!store.validateProject({}).ok, 'no name accepted')
  assert(!store.validateProject({ name: '   ' }).ok, 'blank name accepted')
  assert(!store.validateProject({ name: 'x'.repeat(store.MAX_NAME_CHARS + 1) }).ok, 'long name accepted')
  assert(!store.validateProject({ name: 'ok', instructions: 'y'.repeat(store.MAX_INSTRUCTIONS_CHARS + 1) }).ok, 'long instructions accepted')
  assert(!store.validateProject({ name: 'ok', instructions: 5 }).ok, 'non-string instructions accepted')
  const v = store.validateProject({ name: '  Q3   launch ', instructions: ' Be brief.\r\n ' })
  assert(v.ok && v.fields.name === 'Q3 launch' && v.fields.instructions === 'Be brief.', JSON.stringify(v))
  const partial = store.validateProject({ instructions: 'only this' }, { partial: true })
  assert(partial.ok && !('name' in partial.fields), 'a partial update set the name')
})

await test('slugify: folder-safe, never empty, never a dot-name', () => {
  assert(store.slugify('Q3 Launch / Plan') === 'q3-launch-plan', store.slugify('Q3 Launch / Plan'))
  assert(store.slugify('Café Menü') === 'cafe-menu', store.slugify('Café Menü'))
  for (const bad of ['..', '.', '///', '', '日本語']) {
    const s = store.slugify(bad)
    assert(s && !s.startsWith('.') && !s.includes('/') && !s.includes('\\'), `"${bad}" → "${s}"`)
  }
  assert(store.slugify('a'.repeat(200)).length <= store.MAX_SLUG_CHARS, 'slug not bounded')
})

let aliceProject
await test('create: owner-only shape from day one, unique name, unique slug', () => {
  const r = store.createProject(ALICE, { name: 'Billing', instructions: 'Use TypeScript.', id: 'forged', ownerKey: 'bob-2', members: ['bob-2'], slug: '../x' })
  assert(r.ok, r.error)
  aliceProject = r.project
  assert(r.project.id !== 'forged' && r.project.ownerKey === 'alice-1', 'body set id or owner')
  assert(Array.isArray(r.project.members) && r.project.members.length === 0, 'members not empty')
  assert(r.project.slug === 'billing', `slug ${r.project.slug}`)
  const dup = store.createProject(ALICE, { name: 'BILLING' })
  assert(!dup.ok && dup.code === 'conflict', 'duplicate name accepted')
  const other = store.createProject(ALICE, { name: 'Billing!' })
  assert(other.ok && other.project.slug === 'billing-2', `second slug ${other.project?.slug}`)
  assert(store.createProject(BOB, { name: 'Billing' }).ok, 'another account cannot reuse a name')
})

await test('update: validated fields only; slug and owner never change', () => {
  const r = store.updateProject(ALICE, aliceProject.id, { name: 'Billing service', ownerKey: 'bob-2', slug: 'evil', members: ['x'] })
  assert(r.ok, r.error)
  assert(r.project.name === 'Billing service' && r.project.ownerKey === 'alice-1' && r.project.slug === 'billing' && r.project.members.length === 0, JSON.stringify(r.project))
  assert(r.project.instructions === 'Use TypeScript.', 'a partial update cleared instructions')
})

await test('isolation through the store: bob never reaches alice\'s project', () => {
  assert(store.getProject(BOB, aliceProject.id) === null, 'bob read it')
  assert(!store.listProjects(BOB).some((p) => p.id === aliceProject.id), 'bob listed it')
  assert(store.updateProject(BOB, aliceProject.id, { name: 'mine' }).code === 'not_found', 'bob edited it')
  assert(store.deleteProject(BOB, aliceProject.id) === null, 'bob deleted it')
  assert(store.getProject(ALICE, aliceProject.id)?.name === 'Billing service', 'alice lost it')
  assert(!store.canRead(aliceProject, BOB) && store.canRead(aliceProject, ALICE), 'canRead')
  assert(!store.canWrite(aliceProject, null), 'auth-off scope may write alice\'s project')
  assert(store.getProject(ALICE, '../../etc') === null, 'malformed id resolved')
})

await test('routes: list, get, edit, and a foreign id answers 404', async () => {
  assert(isProjectRoute('/projects') && isProjectRoute(`/projects/${aliceProject.id}`) && !isProjectRoute('/projects/a/b'), 'matcher')
  const list = await route('GET', '/projects', ALICE)
  assert(list.status === 200 && list.json.projects.some((p) => p.id === aliceProject.id) && list.json.limits.maxProjects === store.MAX_PROJECTS_PER_ACCOUNT, 'list')
  const bobList = await route('GET', '/projects', BOB)
  assert(!bobList.json.projects.some((p) => p.id === aliceProject.id), 'bob listed alice\'s project')
  for (const [method, body] of [['GET'], ['PUT', { name: 'x' }], ['DELETE']]) {
    const r = await route(method, `/projects/${aliceProject.id}`, BOB, body)
    assert(r.status === 404, `bob ${method} got ${r.status}`)
  }
  const put = await route('PUT', `/projects/${aliceProject.id}`, ALICE, { instructions: 'Use TypeScript 5.' })
  assert(put.status === 200 && put.json.instructions === 'Use TypeScript 5.', `edit got ${put.status}`)
  const bad = await route('POST', '/projects', ALICE, { name: '' })
  assert(bad.status === 400, `invalid create got ${bad.status}`)
  const made = await route('POST', '/projects', BOB, { name: 'Bob stuff' })
  assert(made.status === 201 && made.json.ownerKey === 'bob-2', `bob create got ${made.status}`)
})

await test('project memory is its own scope, never mixed with the account\'s', () => {
  assert(memory.saveMemory(ALICE, 'Prefers short answers').ok, 'account save')
  const pm = memory.saveMemory(ALICE, 'The billing service runs on Postgres 16', { projectId: aliceProject.id })
  assert(pm.ok, pm.error)
  assert(!memory.listMemories(ALICE).some((m) => m.id === pm.memory.id), 'project memory listed with the account\'s')
  assert(memory.listMemories(ALICE, { projectId: aliceProject.id }).length === 1, 'project memory missing')
  assert(memory.listMemories(BOB, { projectId: aliceProject.id }).length === 0, 'bob\'s key reached alice\'s project memory')
  assert(memory.deleteMemory(ALICE, pm.memory.id) === false, 'deleted from the wrong scope')
  let threw = false
  try { memory.scopeKey(ALICE, 'a#b') } catch { threw = true }
  assert(threw, 'a malformed project id built a key')
})

await test('delete: chats move out and are kept, memories go, others untouched', async () => {
  const keep = store.createProject(ALICE, { name: 'Keep me' }).project
  memory.saveMemory(ALICE, 'Keep-me fact', { projectId: keep.id })
  convs.createConversation('alice-1', { id: 'c-in', name: 'in project', projectId: aliceProject.id, messages: [] })
  convs.createConversation('alice-1', { id: 'c-other', name: 'other project', projectId: keep.id, messages: [] })
  convs.createConversation('alice-1', { id: 'c-none', name: 'no project', messages: [] })
  const before = convs.getConversation('alice-1', 'c-in').lastModified

  const r = await route('DELETE', `/projects/${aliceProject.id}`, ALICE)
  assert(r.status === 200 && r.json.chatsMovedOut === 1 && r.json.memoriesDeleted === 1, JSON.stringify(r))

  const moved = convs.getConversation('alice-1', 'c-in')
  assert(moved && !('projectId' in moved), 'the chat was deleted or still points at the project')
  assert(moved.lastModified === before, 'moving out reordered the chat')
  assert(convs.getConversation('alice-1', 'c-other').projectId === keep.id, 'another project\'s chat moved out')
  assert(convs.getConversation('alice-1', 'c-none'), 'an unrelated chat was touched')
  assert(store.getProject(ALICE, aliceProject.id) === null, 'project still there')
  assert(memory.listMemories(ALICE, { projectId: aliceProject.id }).length === 0, 'project memory survived')
  assert(memory.listMemories(ALICE, { projectId: keep.id }).length === 1, 'another project\'s memory was deleted')
  assert(memory.listMemories(ALICE).some((m) => m.text === 'Prefers short answers'), 'the account\'s own memory was deleted')
  const again = await route('DELETE', `/projects/${aliceProject.id}`, ALICE)
  assert(again.status === 404, `second delete got ${again.status}`)
})

await test('auth off: the shared scope owns its projects', () => {
  const r = store.createProject(null, { name: 'Shared box' })
  assert(r.ok && r.project.ownerKey === memory.ANONYMOUS_KEY, JSON.stringify(r))
  assert(store.getProject(null, r.project.id) && !store.getProject(ALICE, r.project.id), 'scope crossed')
  let threw = false
  try { store.listProjects({ username: 'no-id' }) } catch { threw = true }
  assert(threw || store.listProjects({ username: 'no-id' }).length === 0, 'an account with no id fell into a scope')
})

async function convRoute(method, urlPath, accountId, account, body) {
  const res = fakeRes()
  await handleConversationRoute(fakeReq(method, body), res, urlPath, accountId, { account })
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null }
}

await test("conversations: projectId names only the caller's own project", async () => {
  const mine = store.createProject(ALICE, { name: 'Mine for chats' }).project
  const bobs = store.createProject(BOB, { name: 'Bob for chats' }).project
  const made = await convRoute('POST', '/conversations', 'alice-1', ALICE, { id: 'p-1', name: 'x', projectId: mine.id })
  assert(made.status === 201 && made.json.projectId === mine.id, `create in own project got ${made.status}`)
  const foreign = await convRoute('POST', '/conversations', 'alice-1', ALICE, { id: 'p-2', name: 'x', projectId: bobs.id })
  const unknown = await convRoute('POST', '/conversations', 'alice-1', ALICE, { id: 'p-3', name: 'x', projectId: 'nope' })
  assert(foreign.status === 400 && unknown.status === 400, `foreign ${foreign.status}, unknown ${unknown.status}`)
  assert(foreign.json.error.message === unknown.json.error.message, 'a foreign id is distinguishable from an unknown one')
  assert(!convs.getConversation('alice-1', 'p-2'), 'refused create was stored')

  const moveForeign = await convRoute('PUT', '/conversations/p-1', 'alice-1', ALICE, { projectId: bobs.id })
  assert(moveForeign.status === 400 && convs.getConversation('alice-1', 'p-1').projectId === mine.id, "moved into bob's project")
  const out = await convRoute('PUT', '/conversations/p-1', 'alice-1', ALICE, { projectId: null })
  assert(out.status === 200 && !('projectId' in convs.getConversation('alice-1', 'p-1')), 'null did not move it out')
  const back = await convRoute('PUT', '/conversations/p-1', 'alice-1', ALICE, { projectId: mine.id })
  assert(back.status === 200 && back.json.projectId === mine.id, 'could not move it back in')
  const rename = await convRoute('PUT', '/conversations/p-1', 'alice-1', ALICE, { name: 'renamed' })
  assert(rename.status === 200 && rename.json.projectId === mine.id, 'an edit without the field changed the project')
})

await test('conversations: a PUT never rewrites accountId or id', async () => {
  convs.createConversation('alice-1', { id: 'own-1', name: "alice's", messages: [] })
  const r = await convRoute('PUT', '/conversations/own-1', 'alice-1', ALICE, { accountId: 'bob-2', id: 'hijack', name: 'pushed' })
  assert(r.status === 200, `put got ${r.status}`)
  assert(convs.getConversation('alice-1', 'own-1')?.name === 'pushed', 'the legitimate field was not applied')
  assert(!convs.getConversations('bob-2').some((c) => c.id === 'own-1' || c.id === 'hijack'), "the chat landed in bob's list")
  assert(!convs.getConversation('alice-1', 'hijack'), 'the id was rewritten')
})

await test('the 30-day cleanup keeps chats in a project', () => {
  const p = store.createProject(ALICE, { name: 'Old but kept' }).project
  const old = Date.now() - 60 * 24 * 60 * 60 * 1000
  convs.createConversation('alice-1', { id: 'old-in', name: 'old', projectId: p.id, messages: [] })
  convs.createConversation('alice-1', { id: 'old-out', name: 'old', messages: [] })
  // createConversation stamps now; age both records directly in the file
  const file = path.join(tmpDir, 'config', 'conversations.json')
  const target = fs.existsSync(file) ? file : findFile(tmpDir, 'conversations.json')
  const data = JSON.parse(fs.readFileSync(target, 'utf8'))
  for (const c of data.conversations) if (c.id === 'old-in' || c.id === 'old-out') c.lastModified = old
  fs.writeFileSync(target, JSON.stringify(data))
  convs.cleanupOldConversations()
  assert(convs.getConversation('alice-1', 'old-in'), 'a project chat was cleaned up')
  assert(!convs.getConversation('alice-1', 'old-out'), 'an ordinary old chat was kept')
})

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isFile() && e.name === name) return p
    if (e.isDirectory()) { const f = findFile(p, name); if (f) return f }
  }
  return null
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
process.exit(failed.length ? 1 : 0)
