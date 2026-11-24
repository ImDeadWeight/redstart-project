// =============================================================================
// Shared projects (projects-plan D7, built 2026-11-24)
// =============================================================================
// A project's owner shares it with people and groups as Viewers or Editors.
// Its instructions, memory and files are shared; each person's chats are not.
// An admin with manageProjects manages every project. Pinned here:
//
//   - viewer: opens it, chats in it, reads memory and files; changes nothing
//   - editor: also changes name, instructions, memory and files; cannot
//     share, hand over or delete
//   - a group's members get the group's role; leaving the group ends it
//   - an admin who manages projects sees and manages every project, without
//     it crowding their own list
//   - chats stay private: a member's chat in the project is theirs alone
//   - handing over: the old owner stays as an editor; a deleted account's
//     projects go to whoever deletes it
//   - the files folder is the project's, reachable as a file-explorer space
//     by members only, read-only to viewers
//   - upgrades: version-1 projects.json, owner-keyed project memory, and the
//     old folder inside the owner's files all move to the new shape
//
// Run:  node scripts/test-project-sharing.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Readable } from 'node:stream'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-project-sharing-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir
register('./auth-test-loader.mjs', import.meta.url)
await import('./electron-stub.mjs')

const auth = await import('../daemon/auth.mjs')
const accounts = await import('../daemon/accounts-storage.mjs')
const store = await import('../daemon/projects-storage.mjs')
const memory = await import('../daemon/memory-storage.mjs')
const convs = await import('../daemon/conversations-storage.mjs')
const memoryTool = await import('../daemon/memory-tool.mjs')
const { handleProjectRoute } = await import('../daemon/gateway/project-routes.mjs')
const { handleMemoryRoute } = await import('../daemon/gateway/memory-routes.mjs')
const { handleFilesRequest } = await import('../daemon/files-api.mjs')
const { resolveUserRoot } = await import('../daemon/user-scope.mjs')

const results = []
async function test(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false, detail: err.message })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}
function assert(cond, message) { if (!cond) throw new Error(message) }

function fakeReq(method, body, url = '/') {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [])
  req.method = method; req.headers = {}; req.url = url
  return req
}
function fakeRes() {
  return { status: 0, body: '', headersSent: false, writeHead(s) { this.status = s; return this }, setHeader() {}, end(b) { this.body = b ?? '' } }
}
async function projectRoute(method, urlPath, account, body) {
  const res = fakeRes()
  const [p, q] = urlPath.split('?')
  await handleProjectRoute(fakeReq(method, body, urlPath), res, p, account)
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null, q }
}
async function memoryRoute(method, urlPath, account, body) {
  const res = fakeRes()
  await handleMemoryRoute(fakeReq(method, body, urlPath), res, urlPath.split('?')[0], account, { config: { memory: { enabled: true } } })
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null }
}
const DOCS = fs.mkdtempSync(path.join(tmpDir, 'docs-'))
async function filesRoute(method, urlPath, account, body) {
  const res = fakeRes()
  await handleFilesRequest(fakeReq(method, body, urlPath), res, urlPath.split('?')[0], { config: { documents: { outputDir: DOCS } }, account })
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null }
}

// --- People ----------------------------------------------------------------

auth.setAuthRequired(true)
auth.createOwner({ username: 'owner', password: 'owner-pass-1' })
const OWNER = accounts.listAccounts().find((a) => a.tier === 'owner')
const mk = (username, roleIds = ['full-access']) => accounts.findById(auth.createAccount(OWNER, { username, password: 'pass-1234', roleIds }).account.id)
const ALICE = mk('alice')
const BOB = mk('bob')
const CAROL = mk('carol')
const DAVE = mk('dave')
const PM = mk('pm', ['full-access'])
const pmRole = auth.saveRole(OWNER, { name: 'Project manager', permissions: { capabilities: null, admin: { manageProjects: true } } }).role
auth.assignRoles(OWNER, PM.id, ['full-access', pmRole.id])

const project = store.createProject(ALICE, { name: 'Billing', instructions: 'Use TypeScript.' }).project

console.log('\n-- members and what each may do --')

await test('the owner shares it: bob views, carol edits; dave is not in it', async () => {
  const r = await projectRoute('PUT', `/projects/${project.id}/members`, ALICE, { members: [
    { type: 'account', id: BOB.id, role: 'viewer' },
    { type: 'account', id: CAROL.id, role: 'editor' },
  ] })
  assert(r.status === 200, JSON.stringify(r.json))
  const now = store.getProject(ALICE, project.id)
  assert(store.accessFor(now, BOB) === 'viewer' && store.accessFor(now, CAROL) === 'editor', 'roles not applied')
  assert(store.accessFor(now, DAVE) === null, 'dave reached it')
  assert((await projectRoute('GET', `/projects/${project.id}`, DAVE)).status === 404, 'dave was told it exists')
  const bobs = await projectRoute('GET', '/projects', BOB)
  assert(bobs.json.projects.some((p) => p.id === project.id && p.access === 'viewer' && p.ownerName === 'alice'), 'not in bob\'s list as shared')
})

await test('🔍 a viewer opens and chats in it, and changes nothing', async () => {
  assert(store.getProject(BOB, project.id)?.instructions === 'Use TypeScript.', 'bob cannot read the instructions')
  assert((await projectRoute('PUT', `/projects/${project.id}`, BOB, { instructions: 'hacked' })).status === 403, 'viewer edited the instructions')
  assert((await projectRoute('PUT', `/projects/${project.id}/members`, BOB, { members: [] })).status === 403, 'viewer changed the members')
  assert((await projectRoute('DELETE', `/projects/${project.id}`, BOB)).status === 403, 'viewer deleted it')
  assert((await projectRoute('POST', `/projects/${project.id}/transfer`, BOB, { accountId: BOB.id })).status === 403, 'viewer took it')
  assert((await memoryRoute('POST', `/memories?projectId=${project.id}`, BOB, { text: 'viewer note' })).status === 403, 'viewer wrote project memory')
  assert((await memoryRoute('GET', `/memories?projectId=${project.id}`, BOB)).status === 200, 'viewer cannot read project memory')
  convs.createConversation(BOB.id, { id: 'bob-chat', name: 'bob in billing', projectId: project.id, messages: [] })
  const saved = await memoryTool.callTool('memory_save', { text: 'secret', scope: 'project' }, { memory: { enabled: true } }, { account: BOB, conversationId: 'bob-chat' })
  assert(saved.isError && /view the project/.test(saved.content[0].text), `the tool saved into the project for a viewer: ${JSON.stringify(saved)}`)
})

await test('an editor changes name, instructions and memory, and cannot share, hand over or delete', async () => {
  assert((await projectRoute('PUT', `/projects/${project.id}`, CAROL, { instructions: 'Use TypeScript 5.' })).status === 200, 'editor could not edit')
  assert((await memoryRoute('POST', `/memories?projectId=${project.id}`, CAROL, { text: 'Deploys on Fridays are banned' })).status === 201, 'editor could not save memory')
  assert((await projectRoute('PUT', `/projects/${project.id}/members`, CAROL, { members: [] })).status === 403, 'editor changed the members')
  assert((await projectRoute('DELETE', `/projects/${project.id}`, CAROL)).status === 403, 'editor deleted it')
})

await test('🔍 project memory is shared: what the editor saved, the owner and the viewer read', async () => {
  for (const who of [ALICE, BOB]) {
    const list = (await memoryRoute('GET', `/memories?projectId=${project.id}`, who)).json.memories
    assert(list.some((m) => m.text === 'Deploys on Fridays are banned'), `${who.username} cannot see the shared memory`)
  }
  assert(!memory.listMemories(CAROL).some((m) => m.text === 'Deploys on Fridays are banned'), 'it went into carol\'s own memory too')
})

await test('🔍 chats stay private: bob\'s chat in the project is not alice\'s', async () => {
  assert(convs.getConversation(BOB.id, 'bob-chat'), 'bob lost his chat')
  assert(!convs.getConversation(ALICE.id, 'bob-chat'), 'the owner reached a member\'s chat')
  assert(!convs.getConversations(ALICE.id).some((c) => c.id === 'bob-chat'), 'the owner listed a member\'s chat')
})

await test('a group\'s members get its role; leaving the group ends it', async () => {
  const g = auth.saveGroup(OWNER, { name: 'Finance', memberIds: [DAVE.id], roleIds: [] }).group
  await projectRoute('PUT', `/projects/${project.id}/members`, ALICE, { members: [
    { type: 'account', id: BOB.id, role: 'viewer' }, { type: 'account', id: CAROL.id, role: 'editor' }, { type: 'group', id: g.id, role: 'editor' },
  ] })
  const now = store.getProject(ALICE, project.id)
  assert(store.accessFor(now, DAVE) === 'editor', `dave via the group: ${store.accessFor(now, DAVE)}`)
  auth.saveGroup(OWNER, { id: g.id, name: 'Finance', memberIds: [], roleIds: [] })
  assert(store.accessFor(now, DAVE) === null, 'dave kept access after leaving the group')
})

await test('the higher of a direct role and a group role wins', async () => {
  const g = auth.saveGroup(OWNER, { name: 'Viewers', memberIds: [CAROL.id], roleIds: [] }).group
  const p2 = store.createProject(ALICE, { name: 'Two ways in' }).project
  store.setMembers(ALICE, p2.id, [{ type: 'account', id: CAROL.id, role: 'editor' }, { type: 'group', id: g.id, role: 'viewer' }])
  assert(store.accessFor(store.getProject(ALICE, p2.id), CAROL) === 'editor', 'the lower role won')
})

await test('members must exist, roles must be viewer or editor, and the owner is never their own member', async () => {
  assert(!store.setMembers(ALICE, project.id, [{ type: 'account', id: 'ghost', role: 'viewer' }]).ok, 'a ghost was added')
  assert(!store.setMembers(ALICE, project.id, [{ type: 'account', id: BOB.id, role: 'owner' }]).ok, 'an owner role was handed out')
  const r = store.setMembers(ALICE, project.id, [{ type: 'account', id: ALICE.id, role: 'viewer' }, { type: 'account', id: BOB.id, role: 'viewer' }])
  assert(r.ok && !r.project.members.some((m) => m.id === ALICE.id), 'the owner became a viewer of their own project')
})

console.log('\n-- admins --')

await test('🔍 an admin with manageProjects sees and manages every project, without crowding their own list', async () => {
  const all = await projectRoute('GET', '/projects?all=1', PM)
  assert(all.status === 200 && all.json.projects.some((p) => p.id === project.id && p.access === 'admin'), JSON.stringify(all.json))
  const own = await projectRoute('GET', '/projects', PM)
  assert(!own.json.projects.some((p) => p.id === project.id), 'every project landed in the admin\'s own list')
  assert((await projectRoute('PUT', `/projects/${project.id}`, PM, { instructions: 'Admin fix.' })).status === 200, 'admin could not edit')
  assert((await projectRoute('GET', '/projects?all=1', DAVE)).status === 403, 'a member listed every project')
})

console.log('\n-- ownership --')

await test('handing over: the new owner owns it, the old owner stays on as an editor, a clashing name is renamed', async () => {
  store.createProject(BOB, { name: 'Billing' })
  const r = await projectRoute('POST', `/projects/${project.id}/transfer`, ALICE, { accountId: BOB.id })
  assert(r.status === 200, JSON.stringify(r.json))
  const now = store.getProject(BOB, project.id)
  assert(now.access === 'owner' && now.name === 'Billing (2)', JSON.stringify(now))
  assert(store.accessFor(now, ALICE) === 'editor', `alice is now ${store.accessFor(now, ALICE)}`)
  assert(!now.members.some((m) => m.id === BOB.id), 'the new owner is still listed as a member')
})

await test('🔍 deleting an account hands its projects to whoever deletes it, and takes it off every project', async () => {
  const ed = mk('ed')
  const edsProject = store.createProject(ed, { name: 'Ed\'s notes' }).project
  store.setMembers(BOB, project.id, [...store.getProject(BOB, project.id).members, { type: 'account', id: ed.id, role: 'viewer' }])
  assert(auth.deleteAccount(OWNER, ed.id).ok, 'delete failed')
  const { transferred } = store.handOverAccount(ed.id, OWNER.id)
  assert(transferred === 1, `transferred ${transferred}`)
  assert(store.getProject(OWNER, edsProject.id)?.access === 'owner', 'the deleter does not own it')
  assert(!store.getProject(BOB, project.id).members.some((m) => m.id === ed.id), 'the deleted account is still a member')
  assert(!store.getProject(OWNER, edsProject.id).members.some((m) => m.id === ed.id), 'the deleted owner lingers as an editor')
})

console.log('\n-- files --')

await test('🔍 the files folder is the project\'s: members reach it, viewers read-only, others not at all', async () => {
  const space = `project-${project.id}`
  // bob owns it now; carol edits; dave is nobody.
  store.setMembers(BOB, project.id, [{ type: 'account', id: CAROL.id, role: 'editor' }, { type: 'account', id: ALICE.id, role: 'editor' }])
  assert((await filesRoute('POST', '/files/mkdir', CAROL, { space, path: 'specs' })).status === 201, 'editor could not make a folder')
  store.setMembers(BOB, project.id, [{ type: 'account', id: CAROL.id, role: 'viewer' }, { type: 'account', id: ALICE.id, role: 'editor' }])
  const list = await filesRoute('GET', `/files/list?space=${space}&path=.`, CAROL)
  assert(list.status === 200 && JSON.stringify(list.json).includes('specs'), `viewer cannot list: ${JSON.stringify(list.json)}`)
  assert((await filesRoute('POST', '/files/mkdir', CAROL, { space, path: 'mine' })).status === 403, 'viewer wrote to the project files')
  assert((await filesRoute('GET', `/files/list?space=${space}&path=.`, DAVE)).status === 404, 'a non-member listed the project files')
  const dir = store.projectFilesDir(DOCS, project)
  assert(fs.existsSync(path.join(dir, 'specs')) && !dir.includes('user_files'), `not in the project's own folder: ${dir}`)
  assert((await filesRoute('GET', `/files/list?space=${space}&path=../../user_files`, ALICE)).status === 403, 'the project space escaped its folder')
})

console.log('\n-- upgrades --')

await test('version-1 projects.json is flattened, keeping owners', async () => {
  const file = path.join(tmpDir, 'projects.json')
  const saved = fs.readFileSync(file, 'utf8')
  fs.writeFileSync(file, JSON.stringify({ accounts: { [ALICE.id]: [{ id: 'old-1', ownerKey: ALICE.id, members: [], name: 'Old one', instructions: '', slug: 'old-one', createdAt: 1, updatedAt: 1 }] } }))
  const p = store.getProject(ALICE, 'old-1')
  assert(p?.access === 'owner', 'the old project was lost')
  assert(JSON.parse(fs.readFileSync(file, 'utf8')).version === 2, 'not rewritten as version 2')
  fs.writeFileSync(file, saved)
})

await test('owner-keyed project memory moves to the project\'s key', async () => {
  const file = path.join(tmpDir, 'memories.json')
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { accounts: {} }
  data.accounts[`${ALICE.id}#project:legacy-1`] = [{ id: 'm-old', text: 'Kept from before', createdAt: 1 }]
  fs.writeFileSync(file, JSON.stringify(data))
  assert(memory.listMemories(BOB, { projectId: 'legacy-1' }).some((m) => m.text === 'Kept from before'), 'legacy project memory lost')
  assert(!Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).accounts).some((k) => k.endsWith('#project:legacy-1') && !k.startsWith('#')), 'old key left behind')
})

await test('the old folder inside the owner\'s files moves to the project\'s own folder, contents and all', async () => {
  const p = store.createProject(DAVE, { name: 'Moved' }).project
  const old = path.join(resolveUserRoot(DOCS, DAVE, { create: true }), 'Projects', p.slug)
  fs.mkdirSync(old, { recursive: true })
  fs.writeFileSync(path.join(old, 'plan.md'), 'kept')
  const dir = store.ensureProjectFiles(DOCS, p)
  assert(fs.readFileSync(path.join(dir, 'plan.md'), 'utf8') === 'kept', 'the file did not move')
  assert(!fs.existsSync(old), 'the old folder is still there')
})

await test('the directory gives names only, and nothing with sign-in off', async () => {
  const r = await projectRoute('GET', '/directory', BOB)
  assert(r.json.accounts.every((a) => Object.keys(a).sort().join() === 'id,username'), JSON.stringify(r.json.accounts[0]))
  assert((await projectRoute('GET', '/directory', null)).json.accounts.length === 0, 'the directory answered with sign-in off')
})

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
fs.rmSync(tmpDir, { recursive: true, force: true })
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
