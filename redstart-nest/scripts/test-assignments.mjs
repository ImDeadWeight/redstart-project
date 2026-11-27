// =============================================================================
// Tasks people give each other (tasks plan Phase 1)
// =============================================================================
// Assignments: a task for a person or a group, in a project or in none. Pinned:
//
//   - isolation: nobody outside a project reaches its tasks, by id, by list or
//     in My Tasks; a task with no project is its creator's and assignee's only
//   - every row of the plan's Access table, for owner, admin, editor, viewer,
//     group member and outsider; a mixed PATCH is refused whole
//   - assigning: only to someone who can open the project; re-checked on move
//   - membership: leaving a project hides its tasks and marks the assignee
//   - groups: a member claims; a second claim loses; hand back returns it
//   - nothing is lost when a project, an account or a group is deleted
//   - soft delete: restorable for 30 days, then gone
//   - limits, validation and the reserved fields
//   - sign-in off: one shared personal list, and no assigning
//
// Run:  node scripts/test-assignments.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Readable } from 'node:stream'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-assignments-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir
register('./auth-test-loader.mjs', import.meta.url)
await import('./electron-stub.mjs')

const auth = await import('../daemon/auth.mjs')
const accounts = await import('../daemon/accounts-storage.mjs')
const projects = await import('../daemon/projects-storage.mjs')
const store = await import('../daemon/assignments-storage.mjs')
const { handleAssignmentRoute, isAssignmentRoute } = await import('../daemon/gateway/assignment-routes.mjs')
const { handleProjectRoute } = await import('../daemon/gateway/project-routes.mjs')
const { handleAuthRoute } = await import('../daemon/gateway/auth-routes.mjs')
const tool = await import('../daemon/assignments-tool.mjs')
const convs = await import('../daemon/conversations-storage.mjs')
const { approvalRule, classifyTool } = await import('../daemon/tools-definitions.mjs')

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
async function route(method, url, account, body) {
  const res = fakeRes()
  const handled = await handleAssignmentRoute(fakeReq(method, body, url), res, url.split('?')[0], account)
  return { handled, status: res.status, json: res.body ? JSON.parse(res.body) : null }
}
async function projectRoute(method, url, account, body) {
  const res = fakeRes()
  await handleProjectRoute(fakeReq(method, body, url), res, url.split('?')[0], account)
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null }
}
const ids = (list) => list.map((t) => t.id)
const create = async (account, body) => {
  const r = await route('POST', '/assignments', account, body)
  assert(r.status === 201, `create refused: ${r.status} ${JSON.stringify(r.json)}`)
  return r.json
}

// --- People ----------------------------------------------------------------

auth.setAuthRequired(true)
auth.createOwner({ username: 'owner', password: 'owner-pass-1' })
const OWNER = accounts.listAccounts().find((a) => a.tier === 'owner')
const mk = (username, roleIds = ['full-access']) => accounts.findById(auth.createAccount(OWNER, { username, password: 'pass-1234', roleIds }).account.id)
const ALICE = mk('alice')   // owns the project
const BOB = mk('bob')       // viewer
const CAROL = mk('carol')   // editor
const DAVE = mk('dave')     // outsider
const ERIN = mk('erin')     // in the intake group
const FRANK = mk('frank')   // in the intake group
const PM = mk('pm')
const pmRole = auth.saveRole(OWNER, { name: 'Project manager', permissions: { capabilities: null, admin: { manageProjects: true } } }).role
auth.assignRoles(OWNER, PM.id, ['full-access', pmRole.id])
const INTAKE = auth.saveGroup(OWNER, { name: 'Intake', memberIds: [ERIN.id, FRANK.id], roleIds: [] }).group
const OUTSIDE_GROUP = auth.saveGroup(OWNER, { name: 'Elsewhere', memberIds: [DAVE.id], roleIds: [] }).group

const project = projects.createProject(ALICE, { name: 'Casework' }).project
projects.setMembers(ALICE, project.id, [
  { type: 'account', id: BOB.id, role: 'viewer' },
  { type: 'account', id: CAROL.id, role: 'editor' },
  { type: 'group', id: INTAKE.id, role: 'viewer' },
])

console.log('\n-- routes and validation --')

await test('the route table claims its paths and nothing of /tasks', () => {
  const ok = ['/assignments', '/assignments/mine', '/assignments/count', '/assignments/created', '/assignments/assignees',
    '/assignments/00000000-0000-4000-8000-000000000000', '/assignments/00000000-0000-4000-8000-000000000000/claim']
  const no = ['/tasks', '/tasks/abc', '/assignments/abc', '/assignments/00000000-0000-4000-8000-000000000000/nope', '/assignmentsx']
  assert(ok.every(isAssignmentRoute), `missed: ${ok.filter((p) => !isAssignmentRoute(p))}`)
  assert(!no.some(isAssignmentRoute), `claimed: ${no.filter(isAssignmentRoute)}`)
})

await test('validation: title, notes, status, date, assignee shape, and the reserved fields', () => {
  const v = store.validateAssignment
  assert(!v({}).ok && !v({ title: '   ' }).ok, 'an empty title passed')
  assert(v({ title: '  Call   the  family ' }).fields.title === 'Call the family', 'whitespace not collapsed')
  assert(!v({ title: 'x'.repeat(store.MAX_TITLE_CHARS + 1) }).ok, 'a long title passed')
  assert(!v({ title: 'x', notes: 'n'.repeat(store.MAX_NOTES_CHARS + 1) }).ok, 'long notes passed')
  assert(!v({ title: 'x', status: 'finished' }).ok, 'an unknown status passed')
  assert(!v({ title: 'x', dueDate: '2026-02-30' }).ok && !v({ title: 'x', dueDate: '26-1-1' }).ok, 'a bad date passed')
  assert(v({ title: 'x', dueDate: '2028-02-29' }).ok && v({ title: 'x', dueDate: null }).ok, 'a good date refused')
  assert(!v({ title: 'x', assignee: { type: 'agent', id: 'a' } }).ok, 'an agent assignee passed')
  assert(!v({ title: 'x', assignee: 'bob' }).ok, 'a bare assignee passed')
  for (const f of store.RESERVED_FIELDS) assert(/not supported yet/.test(v({ title: 'x', [f]: 1 }).error), `${f} was not refused`)
  assert(v({ status: 'done' }, { partial: true }).ok, 'a partial update needed a title')
})

console.log('\n-- project tasks: who may do what --')

let pt
await test('an editor creates a project task and gives it to a viewer', async () => {
  pt = await create(CAROL, { title: 'Book the interpreter', projectId: project.id, assignee: { type: 'account', id: BOB.id }, dueDate: '2026-12-01' })
  assert(pt.projectName === 'Casework' && pt.assigneeName === 'bob' && pt.createdByName === 'carol', JSON.stringify(pt))
  assert(pt.history.map((h) => h.action).join() === 'created,assigned', 'history not started')
})

await test('a viewer cannot create one, and an outsider is told nothing exists', async () => {
  assert((await route('POST', '/assignments', BOB, { title: 'x', projectId: project.id })).status === 403, 'viewer created a task')
  assert((await route('POST', '/assignments', DAVE, { title: 'x', projectId: project.id })).status === 404, 'outsider learned the project exists')
})

await test('🔍 isolation: an outsider reaches the task by no road', async () => {
  assert((await route('GET', `/assignments/${pt.id}`, DAVE)).status === 404, 'by id')
  assert((await route('GET', `/assignments?projectId=${project.id}`, DAVE)).status === 404, 'by project list')
  assert((await route('PATCH', `/assignments/${pt.id}`, DAVE, { status: 'done' })).status === 404, 'by PATCH')
  assert((await route('DELETE', `/assignments/${pt.id}`, DAVE)).status === 404, 'by DELETE')
  assert((await route('POST', `/assignments/${pt.id}/claim`, DAVE)).status === 404, 'by claim')
  assert(!ids((await route('GET', '/assignments/mine', DAVE)).json.items).includes(pt.id), 'in My Tasks')
  assert((await route('GET', `/assignments/assignees?projectId=${project.id}`, DAVE)).status === 404, 'by assignees')
})

await test('the viewer assignee changes status and nothing else; a mixed PATCH changes nothing', async () => {
  const mixed = await route('PATCH', `/assignments/${pt.id}`, BOB, { status: 'in_progress', title: 'renamed' })
  assert(mixed.status === 403, `mixed PATCH: ${mixed.status}`)
  const still = (await route('GET', `/assignments/${pt.id}`, ALICE)).json
  assert(still.status === 'open' && still.title === 'Book the interpreter', 'the mixed PATCH half-applied')
  const ok = await route('PATCH', `/assignments/${pt.id}`, BOB, { status: 'in_progress' })
  assert(ok.status === 200 && ok.json.status === 'in_progress', JSON.stringify(ok.json))
  assert(ok.json.can.status && !ok.json.can.edit && !ok.json.can.assign && !ok.json.can.delete, JSON.stringify(ok.json.can))
  for (const body of [{ dueDate: null }, { notes: 'x' }, { assignee: null }]) {
    assert((await route('PATCH', `/assignments/${pt.id}`, BOB, body)).status === 403, `viewer changed ${Object.keys(body)}`)
  }
  assert((await route('DELETE', `/assignments/${pt.id}`, BOB)).status === 403, 'viewer deleted it')
})

await test('a viewer who is not the assignee can see it but not change its status', async () => {
  const other = await create(CAROL, { title: 'Write the summary', projectId: project.id, assignee: { type: 'account', id: CAROL.id } })
  const seen = await route('GET', `/assignments/${other.id}`, BOB)
  assert(seen.status === 200 && !seen.json.can.status, JSON.stringify(seen.json?.can))
  assert((await route('PATCH', `/assignments/${other.id}`, BOB, { status: 'done' })).status === 403, 'changed status')
})

await test('the owner and an admin who manages projects may do everything', async () => {
  const a = (await route('GET', `/assignments/${pt.id}`, ALICE)).json.can
  const p = (await route('GET', `/assignments/${pt.id}`, PM)).json.can
  for (const can of [a, p]) assert(can.edit && can.assign && can.status && can.delete && can.move, JSON.stringify(can))
  assert((await route('PATCH', `/assignments/${pt.id}`, PM, { notes: 'Spanish' })).status === 200, 'admin could not edit')
})

await test('done sets completedAt; reopening clears it; history records each change', async () => {
  const done = (await route('PATCH', `/assignments/${pt.id}`, CAROL, { status: 'done' })).json
  assert(done.completedAt > 0, 'no completedAt')
  const open = (await route('PATCH', `/assignments/${pt.id}`, CAROL, { status: 'open' })).json
  assert(open.completedAt === null, 'completedAt kept on reopen')
  const actions = open.history.map((h) => h.action)
  assert(actions.filter((a) => a === 'status').length === 3 && actions.includes('edited'), actions.join())
  assert(open.history.at(-1).byName === 'carol' && open.history.at(-1).from === 'done', JSON.stringify(open.history.at(-1)))
})

console.log('\n-- assigning --')

await test('only to someone who can open the project, or a group that is a member', async () => {
  const toDave = await route('PATCH', `/assignments/${pt.id}`, CAROL, { assignee: { type: 'account', id: DAVE.id } })
  assert(toDave.status === 400 && /cannot open this project/.test(toDave.json.error.message), JSON.stringify(toDave.json))
  const toOutsideGroup = await route('PATCH', `/assignments/${pt.id}`, CAROL, { assignee: { type: 'group', id: OUTSIDE_GROUP.id } })
  assert(toOutsideGroup.status === 400 && /not a member/.test(toOutsideGroup.json.error.message), JSON.stringify(toOutsideGroup.json))
  assert((await route('PATCH', `/assignments/${pt.id}`, CAROL, { assignee: { type: 'account', id: 'nope' } })).status === 400, 'a missing account was accepted')
  assert((await route('PATCH', `/assignments/${pt.id}`, CAROL, { assignee: { type: 'account', id: ALICE.id } })).status === 200, 'the owner refused')
  assert((await route('PATCH', `/assignments/${pt.id}`, CAROL, { assignee: { type: 'account', id: ERIN.id } })).status === 200, 'a member through a group refused')
})

await test('the assignee list is the project\'s readers, and the directory outside a project', async () => {
  const inProject = (await route('GET', `/assignments/assignees?projectId=${project.id}`, BOB)).json
  const names = inProject.accounts.map((a) => a.username).sort()
  assert(!names.includes('dave') && ['alice', 'bob', 'carol', 'erin', 'frank'].every((n) => names.includes(n)), names.join())
  assert(inProject.groups.map((g) => g.name).join() === 'Intake', JSON.stringify(inProject.groups))
  assert(inProject.accounts.every((a) => Object.keys(a).sort().join() === 'id,username'), 'more than names')
  const everyone = (await route('GET', '/assignments/assignees', DAVE)).json
  assert(everyone.accounts.some((a) => a.username === 'alice') && everyone.groups.length === 2, JSON.stringify(everyone))
})

await test('leaving the project hides its tasks and marks the assignee; returning clears it', async () => {
  const t = await create(CAROL, { title: 'Visit', projectId: project.id, assignee: { type: 'account', id: BOB.id } })
  projects.setMembers(ALICE, project.id, [{ type: 'account', id: CAROL.id, role: 'editor' }, { type: 'group', id: INTAKE.id, role: 'viewer' }])
  assert(!ids((await route('GET', '/assignments/mine', BOB)).json.items).includes(t.id), 'still in bob\'s list')
  assert((await route('GET', `/assignments/${t.id}`, BOB)).status === 404, 'bob still reaches it')
  assert((await route('GET', `/assignments/${t.id}`, CAROL)).json.assigneeLeft === true, 'not marked')
  projects.setMembers(ALICE, project.id, [
    { type: 'account', id: BOB.id, role: 'viewer' }, { type: 'account', id: CAROL.id, role: 'editor' }, { type: 'group', id: INTAKE.id, role: 'viewer' },
  ])
  assert((await route('GET', `/assignments/${t.id}`, CAROL)).json.assigneeLeft === false, 'still marked')
})

console.log('\n-- groups: claim and hand back --')

let gt
await test('a group task is in every member\'s list until one claims it', async () => {
  gt = await create(CAROL, { title: 'Return the call', projectId: project.id, assignee: { type: 'group', id: INTAKE.id } })
  for (const who of [ERIN, FRANK]) assert(ids((await route('GET', '/assignments/mine', who)).json.items).includes(gt.id), `${who.username} does not see it`)
  const erinView = (await route('GET', `/assignments/${gt.id}`, ERIN)).json
  assert(erinView.can.claim && erinView.can.status, JSON.stringify(erinView.can))
  assert((await route('POST', `/assignments/${gt.id}/claim`, BOB)).status === 403, 'a non-member claimed it')
})

await test('🔍 two claims: the first wins, the second is told it is taken', async () => {
  const [a, b] = await Promise.all([route('POST', `/assignments/${gt.id}/claim`, ERIN), route('POST', `/assignments/${gt.id}/claim`, FRANK)])
  const statuses = [a.status, b.status].sort()
  assert(statuses.join() === '200,409', statuses.join())
  const now = (await route('GET', `/assignments/${gt.id}`, CAROL)).json
  assert(now.assignee.type === 'account' && now.claimedFrom === INTAKE.id && now.claimedFromName === 'Intake', JSON.stringify(now))
  const winner = a.status === 200 ? ERIN : FRANK
  const loser = winner === ERIN ? FRANK : ERIN
  assert(!ids((await route('GET', '/assignments/mine', loser)).json.items).includes(gt.id), 'still in the loser\'s list')
  assert((await route('POST', `/assignments/${gt.id}/release`, loser)).status === 403, 'the loser handed it back')
  const back = await route('POST', `/assignments/${gt.id}/release`, winner)
  assert(back.status === 200 && back.json.assignee.type === 'group' && back.json.claimedFrom === null, JSON.stringify(back.json))
  assert(back.json.history.map((h) => h.action).slice(-2).join() === 'claimed,released', 'history missed it')
})

console.log('\n-- tasks with no project --')

let dt
await test('anyone signed in gives a task to anyone in the directory; only creator and assignee see it', async () => {
  dt = await create(DAVE, { title: 'Send the forms', assignee: { type: 'account', id: ALICE.id } })
  assert(dt.projectId === null && dt.can.edit, JSON.stringify(dt))
  assert(ids((await route('GET', '/assignments/mine', ALICE)).json.items).includes(dt.id), 'not in alice\'s list')
  assert(ids((await route('GET', '/assignments/created', DAVE)).json.items).includes(dt.id), 'not in dave\'s created list')
  for (const who of [BOB, CAROL, PM]) assert((await route('GET', `/assignments/${dt.id}`, who)).status === 404, `${who.username} saw it`)
  const alice = (await route('GET', `/assignments/${dt.id}`, ALICE)).json.can
  assert(alice.status && !alice.edit && !alice.assign && !alice.delete, JSON.stringify(alice))
  assert((await route('PATCH', `/assignments/${dt.id}`, ALICE, { title: 'x' })).status === 403, 'the assignee renamed it')
})

await test('a group task with no project: members see and claim it; the creator hands it back', async () => {
  const t = await create(DAVE, { title: 'Cover the front desk', assignee: { type: 'group', id: INTAKE.id } })
  assert((await route('GET', `/assignments/${t.id}`, FRANK)).status === 200, 'a member cannot see it')
  assert((await route('POST', `/assignments/${t.id}/claim`, FRANK)).status === 200, 'claim refused')
  assert((await route('GET', `/assignments/${t.id}`, ERIN)).status === 404, 'another member still sees the claimed task')
  assert((await route('POST', `/assignments/${t.id}/release`, DAVE)).status === 200, 'the creator could not hand it back')
})

await test('moving into a project needs write there and a valid assignee; moving out keeps it visible to the mover', async () => {
  const t = await create(CAROL, { title: 'Draft letter', assignee: { type: 'account', id: DAVE.id } })
  const refused = await route('PATCH', `/assignments/${t.id}`, CAROL, { projectId: project.id })
  assert(refused.status === 400 && /moving/.test(refused.json.error.message), JSON.stringify(refused.json))
  const moved = await route('PATCH', `/assignments/${t.id}`, CAROL, { projectId: project.id, assignee: null })
  assert(moved.status === 200 && moved.json.projectName === 'Casework', JSON.stringify(moved.json))
  assert(ids((await route('GET', `/assignments?projectId=${project.id}`, BOB)).json.items).includes(t.id), 'not in the project list')
  const bobsOwn = await create(BOB, { title: 'Mine' })
  assert((await route('PATCH', `/assignments/${bobsOwn.id}`, BOB, { projectId: project.id })).status === 403, 'a viewer moved a task into the project')
  const out = await route('PATCH', `/assignments/${t.id}`, ALICE, { projectId: null })
  assert(out.status === 200 && out.json.createdBy === ALICE.id && out.json.can.edit, JSON.stringify(out.json))
})

console.log('\n-- deleting and restoring --')

await test('a delete hides it, restore brings it back, and 30 days later it is gone', async () => {
  const t = await create(CAROL, { title: 'Old task', projectId: project.id })
  assert((await route('DELETE', `/assignments/${t.id}`, CAROL)).status === 200, 'delete refused')
  assert(!ids((await route('GET', `/assignments?projectId=${project.id}`, CAROL)).json.items).includes(t.id), 'still listed')
  assert(ids((await route('GET', `/assignments?projectId=${project.id}&include=deleted`, CAROL)).json.items).includes(t.id), 'not in the deleted list')
  assert((await route('PATCH', `/assignments/${t.id}`, CAROL, { title: 'x' })).status === 409, 'edited while deleted')
  const back = await route('POST', `/assignments/${t.id}/restore`, CAROL)
  assert(back.status === 200 && back.json.deletedAt === null, JSON.stringify(back.json))
  const now = Date.now()
  store.deleteAssignment(CAROL, t.id, { now: now - 29 * 86400000 })
  assert(store.getAssignment(CAROL, t.id, { now }).ok, 'gone after 29 days')
  assert(!store.getAssignment(CAROL, t.id, { now: now + 2 * 86400000 }).ok, 'still there after 31 days')
  store.createAssignment(CAROL, { title: 'a write that purges', projectId: project.id }, { now: now + 2 * 86400000 })
  const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'assignments', `project-${project.id}.json`), 'utf8'))
  assert(!raw.items.some((x) => x.id === t.id), 'not purged from the file')
})

console.log('\n-- nothing lost when people, groups and projects go --')

await test('a deleted group: its tasks are unassigned and say which group had them', async () => {
  const g = auth.saveGroup(OWNER, { name: 'Temp', memberIds: [BOB.id], roleIds: [] }).group
  const t = await create(DAVE, { title: 'Group thing', assignee: { type: 'group', id: g.id } })
  auth.deleteGroup(OWNER, g.id)
  store.unassignGroupAssignments(g.id, 'Temp')
  const now = (await route('GET', `/assignments/${t.id}`, DAVE)).json
  assert(now.assignee === null && now.formerAssignee.name === 'Temp' && now.formerAssignee.type === 'group', JSON.stringify(now))
})

await test('a deleted account: assigned tasks go back to their group or become unassigned; made ones pass on', async () => {
  const gone = mk('gone')
  auth.saveGroup(OWNER, { id: INTAKE.id, name: 'Intake', memberIds: [ERIN.id, FRANK.id, gone.id], roleIds: [] })
  const claimed = await create(DAVE, { title: 'Claimed by gone', assignee: { type: 'group', id: INTAKE.id } })
  await route('POST', `/assignments/${claimed.id}/claim`, gone)
  const direct = await create(DAVE, { title: 'For gone', assignee: { type: 'account', id: gone.id } })
  const made = await create(gone, { title: 'Made by gone', assignee: { type: 'account', id: ALICE.id } })
  auth.deleteAccount(OWNER, gone.id)
  const r = store.handOverAccountAssignments(gone.id, 'gone', OWNER.id)
  assert(r.unassigned === 2 && r.handedOver === 1, JSON.stringify(r))
  const c = (await route('GET', `/assignments/${claimed.id}`, DAVE)).json
  assert(c.assignee?.type === 'group' && c.assignee.id === INTAKE.id, `claimed: ${JSON.stringify(c.assignee)}`)
  const d = (await route('GET', `/assignments/${direct.id}`, DAVE)).json
  assert(d.assignee === null && d.formerAssignee.name === 'gone', JSON.stringify(d))
  const m = (await route('GET', `/assignments/${made.id}`, OWNER)).json
  assert(m.createdBy === OWNER.id && m.can.edit, JSON.stringify(m))
})

await test('a deleted project: its tasks lose the project and keep everything else', async () => {
  const p2 = projects.createProject(ALICE, { name: 'Short-lived' }).project
  const t = await create(ALICE, { title: 'Keep me', projectId: p2.id, assignee: { type: 'account', id: ALICE.id }, dueDate: '2027-01-15' })
  const del = await projectRoute('DELETE', `/projects/${p2.id}`, ALICE)
  assert(del.status === 200 && del.json.tasksMovedOut === 1, JSON.stringify(del.json))
  const now = (await route('GET', `/assignments/${t.id}`, ALICE)).json
  assert(now.projectId === null && now.dueDate === '2027-01-15' && now.assignee.id === ALICE.id, JSON.stringify(now))
  assert(now.history.at(-1).action === 'moved' && now.history.at(-1).reason === 'project deleted', JSON.stringify(now.history.at(-1)))
  assert(!fs.existsSync(path.join(tmpDir, 'assignments', `project-${p2.id}.json`)), 'the project file is still there')
})

await test('🔍 through the real admin routes: deleting a group and an account runs the hooks', async () => {
  const token = auth.login('owner', 'owner-pass-1').token
  const adminRoute = async (method, url) => {
    const req = fakeReq(method, null, url); req.headers = { authorization: `Bearer ${token}` }
    const res = fakeRes()
    await handleAuthRoute(req, res, url.split('?')[0])
    return res.status
  }
  const g = auth.saveGroup(OWNER, { name: 'Via route', memberIds: [], roleIds: [] }).group
  const gTask = await create(DAVE, { title: 'For the group', assignee: { type: 'group', id: g.id } })
  assert(await adminRoute('DELETE', `/auth/groups/${g.id}`) === 200, 'group delete refused')
  const afterGroup = (await route('GET', `/assignments/${gTask.id}`, DAVE)).json
  assert(afterGroup.assignee === null && afterGroup.formerAssignee?.name === 'Via route', JSON.stringify(afterGroup))
  const leaver = mk('leaver')
  const aTask = await create(DAVE, { title: 'For the leaver', assignee: { type: 'account', id: leaver.id } })
  assert(await adminRoute('DELETE', `/auth/accounts/${leaver.id}`) === 200, 'account delete refused')
  const afterAccount = (await route('GET', `/assignments/${aTask.id}`, DAVE)).json
  assert(afterAccount.assignee === null && afterAccount.formerAssignee?.name === 'leaver', JSON.stringify(afterAccount))
})

console.log('\n-- counts and limits --')

await test('counts use the caller\'s date: overdue is before their today, and done tasks do not count', async () => {
  const z = mk('zoe')
  await create(z, { title: 'a', assignee: { type: 'account', id: z.id }, dueDate: '2026-01-01' })
  await create(z, { title: 'b', assignee: { type: 'account', id: z.id }, dueDate: '2026-06-01' })
  const c = await create(z, { title: 'c', assignee: { type: 'account', id: z.id }, dueDate: '2026-01-01' })
  await route('PATCH', `/assignments/${c.id}`, z, { status: 'done' })
  const r = (await route('GET', '/assignments/count?today=2026-03-01', z)).json
  assert(r.open === 2 && r.overdue === 1, JSON.stringify(r))
  const mine = (await route('GET', '/assignments/mine?today=2026-03-01', z)).json
  assert(mine.items.length === 2 && mine.counts.overdue === 1, JSON.stringify(mine.counts))
  assert((await route('GET', '/assignments/mine?include=done', z)).json.items.length === 3, 'include=done missed one')
})

await test('the per-account limit outside projects', async () => {
  const y = mk('yan')
  const now = Date.now()
  const file = path.join(tmpDir, 'assignments', 'direct.json')
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (let i = 0; i < store.MAX_DIRECT_PER_ACCOUNT; i++) data.items.push({ id: crypto.randomUUID(), title: `t${i}`, status: 'open', projectId: null, assignee: null, createdBy: y.id, createdAt: now, updatedAt: now, deletedAt: null, history: [] })
  fs.writeFileSync(file, JSON.stringify(data))
  const r = await route('POST', '/assignments', y, { title: 'one more' })
  assert(r.status === 400 && /limit/.test(r.json.error.message), JSON.stringify(r.json))
})

await test('a body over 64 KB is refused before it is parsed', async () => {
  const r = await route('POST', '/assignments', ALICE, { title: 'x', notes: 'n'.repeat(70 * 1024) })
  assert(r.status === 400, `status ${r.status}`)
})

console.log('\n-- the assistant\'s tools (Phase 2) --')

const ON = { assignments: { enabled: true } }
const call = (name, args, account, conversationId = null) => tool.callTool(name, args, ON, { account, conversationId })
const text = (r) => r.content.map((c) => c.text).join('\n')

await test('the writes ask first and the list does not; the model never sees "task" as a tool name', () => {
  assert(classifyTool('assignment_list') === 'read' && approvalRule('assignment_list') === 'none', 'list')
  for (const n of ['assignment_create', 'assignment_update']) {
    assert(classifyTool(n) === 'write' && approvalRule(n) === 'prompt', `${n}: ${classifyTool(n)} / ${approvalRule(n)}`)
  }
  assert(tool.TOOL_NAMES.every((n) => !/task/.test(n)), tool.TOOL_NAMES.join())
  const defs = tool.toolDefs(ON)
  assert(defs.find((d) => d.name === 'assignment_create').description.includes('update_plan'), 'create does not point at update_plan')
  assert(tool.toolDefs({ assignments: { enabled: false } }).length === 0, 'served while off')
})

await test('a disabled capability refuses, and other tools are not claimed', async () => {
  const off = await tool.callTool('assignment_list', {}, { assignments: { enabled: false } }, { account: CAROL })
  assert(off.isError && /not enabled/.test(text(off)), JSON.stringify(off))
  assert((await tool.callTool('memory_save', {}, ON, { account: CAROL })) === null, 'claimed another tool')
})

await test('action items in one call: by name, into the chat\'s project, marked as the assistant\'s', async () => {
  convs.createConversation(CAROL.id, { id: 'carol-casework', name: 'notes', projectId: project.id, messages: [] })
  const r = await call('assignment_create', { items: [
    { title: 'Call the school', assignee: 'bob', due: '2027-02-01' },
    { title: 'Find a translator', assignee: 'Intake' },
    { title: 'Write it up', assignee: 'me', notes: 'Use the new template' },
  ] }, CAROL, 'carol-casework')
  assert(!r.isError, text(r))
  assert(/Added 3 tasks in the project "Casework"/.test(text(r)), text(r))
  const listed = store.listForProject(CAROL, project.id).items.filter((t) => ['Call the school', 'Find a translator', 'Write it up'].includes(t.title))
  assert(listed.length === 3, `${listed.length} in the project`)
  const call1 = listed.find((t) => t.title === 'Call the school')
  assert(call1.assignee.id === BOB.id && call1.dueDate === '2027-02-01', JSON.stringify(call1))
  assert(listed.find((t) => t.title === 'Find a translator').assignee.type === 'group', 'group by name')
  const h = store.getAssignment(CAROL, call1.id).item.history
  assert(h.every((e) => e.via === 'assistant' && e.byName === 'carol'), JSON.stringify(h))
})

await test('🔍 one bad item adds nothing: an unknown name, an outsider, a bad date', async () => {
  const before = store.listForProject(CAROL, project.id).items.length
  for (const [bad, why] of [[{ title: 'x', assignee: 'nobody-here' }, /No person or group named/], [{ title: 'x', assignee: 'dave' }, /No person or group named "dave" in this project/], [{ title: 'x', due: 'next week' }, /not a date/]]) {
    const r = await call('assignment_create', { items: [{ title: 'fine' }, bad] }, CAROL, 'carol-casework')
    assert(r.isError && why.test(text(r)) && /Nothing added: item 2/.test(text(r)), text(r))
  }
  assert(store.listForProject(CAROL, project.id).items.length === before, 'something was added')
  const many = await call('assignment_create', { items: Array.from({ length: tool.MAX_CREATE + 1 }, (_, i) => ({ title: `t${i}` })) }, CAROL)
  assert(many.isError && /at most/.test(text(many)), text(many))
})

await test('🔍 the model can do no more than the person: a viewer\'s chat cannot add to the project', async () => {
  convs.createConversation(BOB.id, { id: 'bob-casework', name: 'mine', projectId: project.id, messages: [] })
  const r = await call('assignment_create', { items: [{ title: 'sneaky' }] }, BOB, 'bob-casework')
  assert(r.isError && /view this project but not add/.test(text(r)), text(r))
  const outside = await call('assignment_create', { items: [{ title: 'my own note' }], in_project: false }, BOB, 'bob-casework')
  assert(!outside.isError && !/in the project/.test(text(outside)), text(outside))
})

await test('list: mine, the project\'s, overdue and search; update by id', async () => {
  const mine = text(await call('assignment_list', {}, BOB))
  assert(mine.includes('Call the school') && /id [0-9a-f-]{36}/.test(mine), mine)
  const inProject = text(await call('assignment_list', { which: 'project' }, CAROL, 'carol-casework'))
  assert(inProject.includes('Write it up') && inProject.includes('Use the new template'), inProject)
  const noProject = await call('assignment_list', { which: 'project' }, CAROL)
  assert(noProject.isError, 'project list outside a project chat')
  const found = text(await call('assignment_list', { which: 'project', search: 'translator' }, CAROL, 'carol-casework'))
  assert(found.includes('Find a translator') && !found.includes('Call the school'), found)
  const id = /Call the school · id ([0-9a-f-]{36})/.exec(mine)[1]
  const done = await call('assignment_update', { id, status: 'done' }, BOB)
  assert(!done.isError && /done/.test(text(done)), text(done))
  const renamed = await call('assignment_update', { id, title: 'renamed by a viewer' }, BOB)
  assert(renamed.isError && /cannot change/.test(text(renamed)), text(renamed))
  const moved = await call('assignment_update', { id, due: 'none', assignee: 'me' }, CAROL)
  assert(!moved.isError, text(moved))
  const t = store.getAssignment(CAROL, id).item
  assert(t.dueDate === null && t.assignee.id === CAROL.id && t.history.at(-1).via === 'assistant', JSON.stringify(t.history.at(-1)))
  assert((await call('assignment_update', { id: 'nope', status: 'done' }, CAROL)).isError, 'unknown id')
  assert((await call('assignment_update', { id, status: 'done' }, DAVE)).isError, 'an outsider changed it')
})

console.log('\n-- sign-in off --')

await test('with sign-in off it is one personal list, and nobody can be given anything', async () => {
  auth.setAuthRequired(false)
  const t = await create(null, { title: 'Local task' })
  assert(ids((await route('GET', '/assignments/mine', null)).json.items).includes(t.id), 'not in the local list')
  const given = await route('POST', '/assignments', null, { title: 'x', assignee: { type: 'account', id: ALICE.id } })
  assert(given.status === 400, `assigned with sign-in off: ${given.status}`)
  assert((await route('GET', '/assignments/assignees', null)).json.accounts.length === 0, 'the assignee list answered')
  auth.setAuthRequired(true)
})


const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
fs.rmSync(tmpDir, { recursive: true, force: true })
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
