// =============================================================================
// Artifact access: who sees and edits what (artifacts plan §5, D4-D6, D8)
// =============================================================================
// Most specific wins, first match:
//
//   1. owner  2. the project's owner, or a manager of every project → admin
//   3. the artifact's account entry (none = no access)
//   4. its group entries, highest ('none' only when every one is none)
//   5. through the project: inherit (editor→editor, viewer→viewer),
//      view (every member → viewer), none (nothing)
//   6. nothing; an unreadable id is not_found (404), never forbidden (403)
//
// Pinned here: every row and every example in §5; groups; that only the
// owner and admins share, hand over and delete; that a project viewer's
// create lands in their own space (D6); and what happens when a project,
// an account or a group is deleted.
//
// Run:  node scripts/test-artifacts-access.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-artifacts-access-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir
register('./auth-test-loader.mjs', import.meta.url)
await import('./electron-stub.mjs')

const auth = await import('../daemon/auth.mjs')
const accounts = await import('../daemon/accounts-storage.mjs')
const projects = await import('../daemon/projects-storage.mjs')
const store = await import('../daemon/artifacts-storage.mjs')

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
const ok = (r) => { if (!r.ok) throw new Error(JSON.stringify(r)); return r }

auth.setAuthRequired(true)
auth.createOwner({ username: 'owner', password: 'owner-pass-1' })
const OWNER = accounts.listAccounts().find((a) => a.tier === 'owner')
const mk = (username) => accounts.findById(auth.createAccount(OWNER, { username, password: 'pass-1234', roleIds: ['full-access'] }).account.id)
const PAT = mk('pat')     // owns the project
const SAM = mk('sam')     // project editor
const VIC = mk('vic')     // project viewer
const OUT = mk('out')     // not in the project
const GIL = mk('gil')     // in the project only through a group
const PM = mk('pm')       // manages every project
const pmRole = auth.saveRole(OWNER, { name: 'Project manager', permissions: { capabilities: null, admin: { manageProjects: true } } }).role
auth.assignRoles(OWNER, PM.id, ['full-access', pmRole.id])
const TEAM = auth.saveGroup(OWNER, { name: 'Team', memberIds: [GIL.id], roleIds: [] }).group

const project = projects.createProject(PAT, { name: 'Billing' }).project
projects.setMembers(PAT, project.id, [
  { type: 'account', id: SAM.id, role: 'editor' },
  { type: 'account', id: VIC.id, role: 'viewer' },
  { type: 'group', id: TEAM.id, role: 'viewer' },
])

/** A project artifact made by sam (an editor), so pat's admin role is the project's, not ownership. */
function made(title = 'Mockup') {
  return ok(store.createArtifact(SAM, { title, files: [{ path: 'index.html', content: '<p>hi</p>' }] }, { projectId: project.id, sealNow: true })).artifact
}
const role = (a, who) => store.accessFor(store.getArtifact(OWNER, a.id) ?? a, who)
const setAccess = (a, body, by = SAM) => ok(store.setArtifactAccess(by, a.id, body))

console.log('\n-- §5 rows --')

await test('1. the owner is owner; 2. the project owner and a manager are admin', async () => {
  const a = made()
  assert(role(a, SAM) === 'owner', `sam ${role(a, SAM)}`)
  assert(role(a, PAT) === 'admin', `pat ${role(a, PAT)}`)
  assert(role(a, PM) === 'admin', `pm ${role(a, PM)}`)
  assert(role(a, OWNER) === 'admin', 'the Nest owner is not admin')
})

await test('5. inherit: project editor edits, project viewer views, a group\'s viewer views, an outsider has nothing', async () => {
  const a = ok(store.createArtifact(PAT, { title: 'Pat\'s', files: [{ path: 'a.txt', content: '1' }] }, { projectId: project.id, sealNow: true })).artifact
  assert(role(a, SAM) === 'editor' && role(a, VIC) === 'viewer' && role(a, GIL) === 'viewer', `${role(a, SAM)} ${role(a, VIC)} ${role(a, GIL)}`)
  assert(role(a, OUT) === null, 'outsider reached it')
})

await test('5. view: every project member views, editors included', async () => {
  const a = made()
  const p = ok(store.createArtifact(PAT, { title: 'Viewonly', files: [{ path: 'a.txt', content: '1' }] }, { projectId: project.id, sealNow: true })).artifact
  setAccess(p, { projectAccess: 'view' }, PAT)
  assert(role(p, SAM) === 'viewer' && role(p, VIC) === 'viewer', `${role(p, SAM)} ${role(p, VIC)}`)
  assert(role(a, SAM) === 'owner', 'the owner lost it under view')
})

await test('5. none: nothing from the project, but the project owner keeps admin (D5)', async () => {
  const a = made('Private draft')
  setAccess(a, { projectAccess: 'none' })
  assert(role(a, VIC) === null && role(a, GIL) === null, 'members still see it')
  assert(role(a, PAT) === 'admin', 'the project owner lost it')
  assert(store.getArtifact(VIC, a.id) === null, 'getArtifact answered a hidden one')
})

await test('3. an account entry beats the project; none hides it from one member', async () => {
  const a = made()
  setAccess(a, { members: [{ type: 'account', id: VIC.id, role: 'none' }] })
  assert(role(a, VIC) === null, 'vic still sees it')
  assert(store.listArtifacts(VIC).every((x) => x.id !== a.id), 'in vic\'s list')
  setAccess(a, { members: [{ type: 'account', id: VIC.id, role: 'editor' }] })
  assert(role(a, VIC) === 'editor', 'vic not editor')
})

await test('3 over 4: the account entry wins over a group entry, either way', async () => {
  const a = made()
  setAccess(a, { members: [{ type: 'group', id: TEAM.id, role: 'editor' }, { type: 'account', id: GIL.id, role: 'viewer' }] })
  assert(role(a, GIL) === 'viewer', `gil ${role(a, GIL)}`)
  setAccess(a, { members: [{ type: 'group', id: TEAM.id, role: 'none' }, { type: 'account', id: GIL.id, role: 'editor' }] })
  assert(role(a, GIL) === 'editor', `gil ${role(a, GIL)}`)
})

await test('4. groups: the highest wins; none only when every matching entry is none', async () => {
  const other = auth.saveGroup(OWNER, { name: 'Other', memberIds: [GIL.id], roleIds: [] }).group
  const a = made()
  setAccess(a, { members: [{ type: 'group', id: TEAM.id, role: 'none' }, { type: 'group', id: other.id, role: 'editor' }] })
  assert(role(a, GIL) === 'editor', `gil ${role(a, GIL)}`)
  setAccess(a, { members: [{ type: 'group', id: TEAM.id, role: 'none' }, { type: 'group', id: other.id, role: 'none' }] })
  assert(role(a, GIL) === null, 'gil sees it through the project despite every group saying none')
})

await test('6. unreadable answers not_found everywhere; readable-but-not-editable answers forbidden', async () => {
  const a = made()
  setAccess(a, { projectAccess: 'none' })
  for (const r of [
    store.getManifest(OUT, a.id), store.readArtifactFile(OUT, a.id, 'index.html'),
    store.writeArtifactFile(OUT, a.id, 'x.html', 'x'), store.editArtifactFile(OUT, a.id, 'index.html', 'hi', 'yo'),
    store.renameArtifact(OUT, a.id, { title: 'x' }), store.setArtifactAccess(OUT, a.id, { projectAccess: 'inherit' }),
    store.sealArtifact(OUT, a.id), store.listRevisions(OUT, a.id), store.createArtifact(OUT, { from: a.id }),
  ]) assert(r.code === 'not_found', `not 404: ${JSON.stringify(r)}`)
  const b = made()
  const w = store.writeArtifactFile(VIC, b.id, 'x.html', 'x')
  assert(w.code === 'forbidden' && /artifact_create with "from"/.test(w.error), JSON.stringify(w))
  assert(store.editArtifactFile(VIC, b.id, 'index.html', 'hi', 'yo').code === 'forbidden', 'viewer edited')
  assert(store.renameArtifact(VIC, b.id, { title: 'x' }).code === 'forbidden', 'viewer renamed')
  assert(store.restoreRevision(VIC, b.id, 1).code === 'forbidden', 'viewer restored')
})

console.log('\n-- the role table --')

await test('viewers fork; editors edit and rename but do not share, hand over or delete', async () => {
  const a = ok(store.createArtifact(PAT, { title: 'Table', files: [{ path: 'index.html', content: '<p>hi</p>' }] }, { projectId: project.id, sealNow: true })).artifact
  const fork = ok(store.createArtifact(VIC, { from: a.id }))
  assert(fork.artifact.ownerKey === VIC.id && fork.artifact.projectId === null, 'viewer\'s fork is not their own')
  ok(store.editArtifactFile(SAM, a.id, 'index.html', 'hi', 'hello', { conversationId: 's1' }))
  ok(store.renameArtifact(SAM, a.id, { title: 'Table 2' }))
  assert(store.setArtifactAccess(SAM, a.id, { projectAccess: 'none' }).code === 'forbidden', 'editor shared')
  assert(store.transferArtifact(SAM, a.id, SAM.id).code === 'forbidden', 'editor took it over')
  assert((await store.deleteArtifact(SAM, a.id)).code === 'forbidden', 'editor deleted')
})

await test('§5 examples: everyone sees it, only Sam edits; let a non-member review it', async () => {
  const a = ok(store.createArtifact(PAT, { title: 'Example', files: [{ path: 'a.txt', content: '1' }] }, { projectId: project.id, sealNow: true })).artifact
  setAccess(a, { projectAccess: 'view', members: [{ type: 'account', id: SAM.id, role: 'editor' }, { type: 'account', id: OUT.id, role: 'viewer' }] }, PAT)
  assert(role(a, SAM) === 'editor' && role(a, VIC) === 'viewer' && role(a, GIL) === 'viewer', 'view + Sam editor')
  assert(role(a, OUT) === 'viewer', 'the reviewer cannot see it')
  assert(store.listArtifacts(OUT, { scope: 'shared' }).some((x) => x.id === a.id), 'not under Shared with me for a non-member reviewer')
  assert(!store.listArtifacts(VIC, { scope: 'shared' }).some((x) => x.id === a.id), 'a project member sees a project artifact as shared')
  assert(store.listArtifacts(OUT).some((x) => x.id === a.id), 'not in the reviewer\'s list')
})

await test('the owner and an admin share and hand over; the old owner stays as editor', async () => {
  const a = made('Handed')
  ok(store.transferArtifact(PAT, a.id, VIC.id))
  assert(role(a, VIC) === 'owner' && role(a, SAM) === 'editor', `${role(a, VIC)} ${role(a, SAM)}`)
})

console.log('\n-- D6: where a create lands --')

await test('a project editor\'s create lands in the project; a viewer\'s in their own space, and says so', async () => {
  const e = ok(store.createArtifact(SAM, { title: 'In' }, { projectId: project.id }))
  assert(e.placedIn === 'project' && e.artifact.projectId === project.id, JSON.stringify(e))
  const v = ok(store.createArtifact(VIC, { title: 'Out' }, { projectId: project.id }))
  assert(v.placedIn === 'own' && v.artifact.projectId === null && v.projectRefused === 'Billing', JSON.stringify(v))
  const o = ok(store.createArtifact(OUT, { title: 'Nowhere' }, { projectId: project.id }))
  assert(o.placedIn === 'own' && o.projectRefused === null, 'an outsider learned the project\'s name')
})

console.log('\n-- listings --')

await test('scopes: mine, shared, project; a manager\'s list is not every artifact', async () => {
  const solo = ok(store.createArtifact(OUT, { title: 'Solo' }, { sealNow: true })).artifact
  setAccess(solo, { members: [{ type: 'account', id: VIC.id, role: 'viewer' }] }, OUT)
  assert(store.listArtifacts(VIC, { scope: 'shared' }).some((x) => x.id === solo.id), 'not shared with vic')
  assert(!store.listArtifacts(VIC, { scope: 'mine' }).some((x) => x.id === solo.id), 'in vic\'s own')
  assert(store.listArtifacts(VIC, { scope: 'project', projectId: project.id }).every((x) => x.projectId === project.id), 'project scope leaked')
  assert(store.listArtifacts(PM).length === 0, `the manager's list has ${store.listArtifacts(PM).length}`)
  assert(store.getArtifact(PM, solo.id)?.role === 'admin', 'the manager cannot open one directly')
  assert(store.listArtifacts(VIC, { query: 'sOlO' }).length === 1, 'search')
})

console.log('\n-- when things are deleted --')

await test('a deleted project\'s artifacts move out to their owners and keep their own members', async () => {
  const p2 = projects.createProject(PAT, { name: 'Short-lived' }).project
  projects.setMembers(PAT, p2.id, [{ type: 'account', id: SAM.id, role: 'editor' }])
  const a = ok(store.createArtifact(SAM, { title: 'Survivor' }, { projectId: p2.id, sealNow: true })).artifact
  setAccess(a, { members: [{ type: 'account', id: OUT.id, role: 'viewer' }] })
  projects.deleteProject(PAT, p2.id)
  assert(store.detachProjectArtifacts(p2.id) === 1, 'not detached')
  assert(role(a, SAM) === 'owner' && role(a, OUT) === 'viewer', 'owner or member lost')
  assert(role(a, PAT) === null, 'the old project owner kept it')
})

await test('a deleted account\'s artifacts go to whoever takes over; it leaves every list', async () => {
  const LEAVER = mk('leaver')
  const a = ok(store.createArtifact(LEAVER, { title: 'Theirs' }, { sealNow: true })).artifact
  const b = ok(store.createArtifact(OUT, { title: 'Shared with them' }, { sealNow: true })).artifact
  setAccess(b, { members: [{ type: 'account', id: LEAVER.id, role: 'editor' }] }, OUT)
  assert(store.countArtifactsOwnedBy(LEAVER.id) === 1, 'count')
  const r = store.handOverArtifacts(LEAVER.id, OWNER.id)
  assert(r.transferred === 1 && role(a, OWNER) === 'owner', JSON.stringify(r))
  assert(!store.getArtifact(OUT, b.id).members.some((m) => m.id === LEAVER.id), 'still a member')
})

await test('a deleted group comes off every artifact', async () => {
  const g = auth.saveGroup(OWNER, { name: 'Gone', memberIds: [OUT.id], roleIds: [] }).group
  const a = made()
  setAccess(a, { members: [{ type: 'group', id: g.id, role: 'editor' }] })
  assert(store.removeGroupFromArtifacts(g.id) === 1, 'not removed')
  assert(store.getArtifact(SAM, a.id).members.length === 0, 'still listed')
})

await test('members must exist; the owner is never a member of their own', async () => {
  const a = made()
  assert(!store.setArtifactAccess(SAM, a.id, { members: [{ type: 'account', id: 'nobody', role: 'viewer' }] }).ok, 'a missing account')
  assert(!store.setArtifactAccess(SAM, a.id, { members: [{ type: 'account', id: OUT.id, role: 'admin' }] }).ok, 'role admin')
  assert(!store.setArtifactAccess(SAM, a.id, { projectAccess: 'everyone' }).ok, 'bad projectAccess')
  ok(store.setArtifactAccess(SAM, a.id, { members: [{ type: 'account', id: SAM.id, role: 'none' }] }))
  assert(role(a, SAM) === 'owner', 'the owner locked themselves out')
})

await test('with sign-in off, everyone is the one local owner', async () => {
  auth.setAuthRequired(false)
  const a = ok(store.createArtifact(null, { title: 'Local' }, { sealNow: true })).artifact
  assert(a.ownerKey === '_local' && store.accessFor(store.getArtifact(null, a.id), null) === 'owner', JSON.stringify(a))
  auth.setAuthRequired(true)
})

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
fs.rmSync(tmpDir, { recursive: true, force: true })
if (failed.length) process.exit(1)
