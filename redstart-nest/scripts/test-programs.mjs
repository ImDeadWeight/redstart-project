// =============================================================================
// Programs: groups of projects (tasks plan Phase 4)
// =============================================================================
// Pinned:
//   - a program gives NO access: a member sees only the projects in it they
//     can already open, and nothing (not even a count) about the others; a
//     project shared with nobody stays closed to the program's members
//   - viewer / editor / owner of the program, and an admin who manages
//     projects
//   - adding a project needs managing the program AND the project; taking one
//     out needs either; a project the caller cannot see is never removed
//   - the program's task list is the tasks of its projects the caller can open
//   - deleting a project, a group or an account leaves no dangling entries
//
// Run:  node scripts/test-programs.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Readable } from 'node:stream'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-programs-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir
register('./auth-test-loader.mjs', import.meta.url)
await import('./electron-stub.mjs')

const auth = await import('../daemon/auth.mjs')
const accounts = await import('../daemon/accounts-storage.mjs')
const projects = await import('../daemon/projects-storage.mjs')
const programs = await import('../daemon/programs-storage.mjs')
const tasks = await import('../daemon/assignments-storage.mjs')
const { handleProgramRoute, isProgramRoute } = await import('../daemon/gateway/program-routes.mjs')
const { handleAssignmentRoute } = await import('../daemon/gateway/assignment-routes.mjs')
const { handleProjectRoute } = await import('../daemon/gateway/project-routes.mjs')
const { handleAuthRoute } = await import('../daemon/gateway/auth-routes.mjs')

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
  return { status: 0, body: '', writeHead(s) { this.status = s; return this }, setHeader() {}, end(b) { this.body = b ?? '' } }
}
const call = (handler) => async (method, url, account, body) => {
  const res = fakeRes()
  await handler(fakeReq(method, body, url), res, url.split('?')[0], account)
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null }
}
const prog = call(handleProgramRoute)
const asg = call(handleAssignmentRoute)
const proj = call(handleProjectRoute)

auth.setAuthRequired(true)
auth.createOwner({ username: 'owner', password: 'owner-pass-1' })
const OWNER = accounts.listAccounts().find((a) => a.tier === 'owner')
const mk = (u) => accounts.findById(auth.createAccount(OWNER, { username: u, password: 'pass-1234', roleIds: ['full-access'] }).account.id)
const MANAGER = mk('manager')   // runs the program
const ANA = mk('ana')           // owns project A
const BEN = mk('ben')           // owns project B, private
const VIC = mk('vic')           // viewer of the program
const OUT = mk('out')           // nothing
const PM = mk('pm')
const pmRole = auth.saveRole(OWNER, { name: 'Project manager', permissions: { capabilities: null, admin: { manageProjects: true } } }).role
auth.assignRoles(OWNER, PM.id, ['full-access', pmRole.id])

const A = projects.createProject(ANA, { name: 'Housing' }).project
const B = projects.createProject(BEN, { name: 'Private casework' }).project
const C = projects.createProject(MANAGER, { name: 'Outreach' }).project
// Ana shares Housing with the manager (editor) and Vic (viewer); Ben shares B with the manager only.
projects.setMembers(ANA, A.id, [{ type: 'account', id: MANAGER.id, role: 'editor' }, { type: 'account', id: VIC.id, role: 'viewer' }])
projects.setMembers(BEN, B.id, [{ type: 'account', id: MANAGER.id, role: 'viewer' }])

let P
await test('the route table', () => {
  const id = '00000000-0000-4000-8000-000000000000'
  assert(['/programs', `/programs/${id}`, `/programs/${id}/members`, `/programs/${id}/projects`].every(isProgramRoute), 'missed one')
  assert(!['/programsx', `/programs/${id}/nope`, '/programs/abc'].some(isProgramRoute), 'claimed one')
})

await test('the manager makes a program and shares it with Vic as a viewer', async () => {
  const r = await prog('POST', '/programs', MANAGER, { name: 'Family services', description: 'Everything for the county contract' })
  assert(r.status === 201 && r.json.access === 'owner', JSON.stringify(r.json))
  P = r.json
  const s = await prog('PUT', `/programs/${P.id}/members`, MANAGER, { members: [{ type: 'account', id: VIC.id, role: 'viewer' }] })
  assert(s.status === 200, JSON.stringify(s.json))
  assert((await prog('GET', `/programs/${P.id}`, VIC)).json.access === 'viewer', 'vic cannot open it')
  assert((await prog('GET', `/programs/${P.id}`, OUT)).status === 404, 'an outsider was told it exists')
  assert(!(await prog('GET', '/programs', OUT)).json.programs.length, 'in an outsider\'s list')
})

await test('adding a project needs managing it too: the manager adds Outreach, not Housing or Private casework', async () => {
  const own = await prog('PUT', `/programs/${P.id}/projects`, MANAGER, { projectIds: [C.id] })
  assert(own.status === 200 && own.json.projects.map((p) => p.name).join() === 'Outreach', JSON.stringify(own.json))
  const housing = await prog('PUT', `/programs/${P.id}/projects`, MANAGER, { projectIds: [C.id, A.id] })
  assert(housing.status === 403 && /owner, or an admin, can add it/.test(housing.json.error.message), JSON.stringify(housing.json))
  // Ana owns Housing but cannot change the program until she is an editor of it.
  assert((await prog('PUT', `/programs/${P.id}/projects`, ANA, { projectIds: [C.id, A.id] })).status === 404, 'ana changed a program she cannot see')
  await prog('PUT', `/programs/${P.id}/members`, MANAGER, { members: [{ type: 'account', id: VIC.id, role: 'viewer' }, { type: 'account', id: ANA.id, role: 'editor' }, { type: 'account', id: BEN.id, role: 'editor' }] })
  const byAna = await prog('PUT', `/programs/${P.id}/projects`, ANA, { projectIds: [C.id, A.id] })
  assert(byAna.status === 200, JSON.stringify(byAna.json))
  const byBen = await prog('PUT', `/programs/${P.id}/projects`, BEN, { projectIds: [B.id] })
  assert(byBen.status === 200, JSON.stringify(byBen.json))
})

await test('🔍 a program gives no access: Vic sees only the projects she can open, and nothing about the rest', async () => {
  const v = (await prog('GET', `/programs/${P.id}`, VIC)).json
  const names = v.projects.map((p) => p.name).sort().join()
  assert(names === 'Housing', `vic sees ${names}`)
  assert(!JSON.stringify(v).includes(B.id) && !JSON.stringify(v).includes(C.id), 'a hidden project id leaked')
  assert(!('projectIds' in v) && !('hiddenCount' in v), 'a count or list of hidden projects leaked')
  assert((await proj('GET', `/projects/${B.id}`, VIC)).status === 404, 'the program opened Private casework for vic')
  assert(v.members.every((m) => m.id === VIC.id), 'a viewer was shown the whole member list')
})

await test('🔍 setting the list never removes what the caller cannot see: Ben\'s and the manager\'s projects stay when Ana sends hers', async () => {
  const r = await prog('PUT', `/programs/${P.id}/projects`, ANA, { projectIds: [A.id] })
  assert(r.status === 200, JSON.stringify(r.json))
  const all = programs.readableProgram(OWNER, P.id).projectIds
  // Neither Private casework nor Outreach is shared with Ana: both stay.
  assert(all.includes(B.id) && all.includes(C.id), `a project hidden from ana was removed: ${all}`)
  assert(all.includes(A.id), 'housing went')
})

await test('the program\'s task list: tasks of the projects the caller can open, and only those', async () => {
  await prog('PUT', `/programs/${P.id}/projects`, MANAGER, { projectIds: [A.id, B.id, C.id] })
  tasks.createAssignment(ANA, { title: 'Housing task', projectId: A.id })
  tasks.createAssignment(BEN, { title: 'Private task', projectId: B.id })
  tasks.createAssignment(MANAGER, { title: 'Outreach task', projectId: C.id })
  const forVic = (await asg('GET', `/assignments?programId=${P.id}`, VIC)).json.items.map((t) => t.title).sort()
  assert(forVic.join() === 'Housing task', `vic sees ${forVic}`)
  const forManager = (await asg('GET', `/assignments?programId=${P.id}`, MANAGER)).json.items.map((t) => t.title).sort()
  assert(forManager.join() === 'Housing task,Outreach task,Private task', `manager sees ${forManager}`)
  assert((await asg('GET', `/assignments?programId=${P.id}`, OUT)).status === 404, 'an outsider read the program\'s tasks')
})

await test('roles: a viewer changes nothing; an editor renames; only the owner or an admin shares and deletes', async () => {
  assert((await prog('PUT', `/programs/${P.id}`, VIC, { name: 'x' })).status === 403, 'a viewer renamed it')
  assert((await prog('PUT', `/programs/${P.id}/projects`, VIC, { projectIds: [] })).status === 403, 'a viewer took a project out')
  assert((await prog('PUT', `/programs/${P.id}`, ANA, { description: 'Updated' })).status === 200, 'an editor could not edit')
  assert((await prog('PUT', `/programs/${P.id}/members`, ANA, { members: [] })).status === 403, 'an editor changed the members')
  assert((await prog('DELETE', `/programs/${P.id}`, ANA)).status === 403, 'an editor deleted it')
  assert((await prog('GET', `/programs/${P.id}`, PM)).json.access === 'admin', 'the admin who manages projects cannot open it')
})

await test('a project owner who only views the program can still take their project out', async () => {
  await prog('PUT', `/programs/${P.id}/members`, MANAGER, { members: [{ type: 'account', id: BEN.id, role: 'viewer' }] })
  const r = await prog('PUT', `/programs/${P.id}/projects`, BEN, { projectIds: [] })
  assert(r.status === 200 && !programs.readableProgram(OWNER, P.id).projectIds.includes(B.id), JSON.stringify(r.json))
})

await test('nothing dangles when a project, a group or an account goes', async () => {
  const D = projects.createProject(MANAGER, { name: 'Short-lived' }).project
  await prog('PUT', `/programs/${P.id}/projects`, MANAGER, { projectIds: [A.id, C.id, D.id] })
  assert((await proj('DELETE', `/projects/${D.id}`, MANAGER)).status === 200, 'delete refused')
  assert(!programs.readableProgram(OWNER, P.id).projectIds.includes(D.id), 'the deleted project is still listed')
  const g = auth.saveGroup(OWNER, { name: 'Temp', memberIds: [], roleIds: [] }).group
  await prog('PUT', `/programs/${P.id}/members`, MANAGER, { members: [{ type: 'group', id: g.id, role: 'viewer' }] })
  const token = auth.login('owner', 'owner-pass-1').token
  const admin = async (method, url) => { const req = fakeReq(method, null, url); req.headers = { authorization: `Bearer ${token}` }; const res = fakeRes(); await handleAuthRoute(req, res, url.split('?')[0]); return res.status }
  assert(await admin('DELETE', `/auth/groups/${g.id}`) === 200, 'group delete refused')
  assert(!programs.readableProgram(OWNER, P.id).members.some((m) => m.id === g.id), 'the deleted group is still a member')
  assert(await admin('DELETE', `/auth/accounts/${MANAGER.id}?transferTo=${OWNER.id}`) === 200, 'account delete refused')
  assert(programs.readableProgram(OWNER, P.id).ownerKey === OWNER.id, 'the program was not handed over')
})

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
fs.rmSync(tmpDir, { recursive: true, force: true })
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
