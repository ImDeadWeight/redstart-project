// =============================================================================
// Workflows — personal for anyone, org behind manageOrgWorkflows
// =============================================================================
// Pinned here:
//   - validation: a slug name, required instructions, every {{placeholder}}
//     names a declared input, a half example is refused, a personal name cannot
//     take the org prefix
//   - composition: values fill placeholders in ONE pass (a value containing
//     "{{x}}" is not expanded), unreferenced inputs are appended, a missing
//     required input is refused
//   - isolation: one account never lists, edits, deletes or RUNS another's
//     personal workflow — through the store, the routes or MCP prompts/get
//   - the permission: org writes need manageOrgWorkflows; admin tier has it,
//     a role can withhold it, user tier can never hold it, and auth-off (null
//     account) cannot write org at all. Org reads are open to everyone.
//   - MCP: the real server advertises `prompts`, lists personal then org
//     (org under the org- prefix), composes on prompts/get, and an auth-on
//     request with no identity gets nothing
//
// Run:  node scripts/test-workflows.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Readable } from 'node:stream'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-workflows-test-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir
register('./auth-test-loader.mjs', import.meta.url)
await import('./electron-stub.mjs')

const store = await import('../daemon/workflows-storage.mjs')
const { handleWorkflowRoute, isWorkflowRoute } = await import('../daemon/gateway/workflow-routes.mjs')
const { can, ADMIN_PERMISSIONS } = await import('../daemon/permissions.mjs')
const auth = await import('../daemon/auth.mjs')
const { startMcpServer, stopMcpServer } = await import('../daemon/mcp-server.mjs')
const { connectMcpClient } = await import('./lib/mcp-test-client.mjs')

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

const ALICE = { id: 'alice-1', username: 'alice', tier: 'user' }
const BOB = { id: 'bob-2', username: 'bob', tier: 'user' }
const ADMIN = { id: 'admin-3', username: 'ada', tier: 'admin' }

const NOTES = {
  name: 'work-notes',
  title: 'Work notes',
  description: 'Shorthand to the weekly format',
  instructions: 'Rewrite these notes for {{client}} as a status report:\n{{notes}}',
  inputs: [
    { name: 'notes', description: 'Your shorthand', required: true },
    { name: 'client', description: 'Who it is for', required: false },
  ],
  example: { input: 'mtg w/ ops, db slow', output: '## Status\n- Met with Operations: database latency is high.' },
}

function fakeReq(method, body) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [])
  req.method = method; req.headers = {}
  return req
}
function fakeRes() {
  return { status: 0, body: '', writeHead(s) { this.status = s; return this }, setHeader() {}, end(b) { this.body = b ?? '' } }
}
async function route(method, urlPath, account, body) {
  const res = fakeRes()
  const handled = await handleWorkflowRoute(fakeReq(method, body), res, urlPath, account)
  assert(handled, `${method} ${urlPath} was not handled`)
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null }
}

// ---------------------------------------------------------------------------
// Validation and composition (pure)
// ---------------------------------------------------------------------------

await test('validation refuses what a workflow is not', () => {
  const v = (body, scope = 'personal') => store.validateWorkflow(body, { scope })
  assert(v(NOTES).ok, v(NOTES).error)
  assert(!v({ ...NOTES, name: 'Work Notes!' }).ok, 'non-slug name accepted')
  assert(v({ ...NOTES, name: 'WORK-notes' }).fields?.name === 'work-notes', 'name not lowercased')
  assert(!v({ ...NOTES, name: '-x' }).ok, 'leading hyphen accepted')
  assert(!v({ ...NOTES, instructions: '   ' }).ok, 'empty instructions accepted')
  assert(!v({ ...NOTES, instructions: 'Use {{missing}}' }).ok, 'undeclared placeholder accepted')
  assert(!v({ ...NOTES, inputs: [NOTES.inputs[0], NOTES.inputs[0]] }).ok, 'duplicate input accepted')
  assert(!v({ ...NOTES, example: { input: 'x', output: '' } }).ok, 'half example accepted')
  assert(v({ ...NOTES, example: { input: '', output: '' } }).fields?.example === null, 'empty example not dropped')
  assert(!v({ ...NOTES, name: 'org-sneaky' }).ok, 'personal name took the org prefix')
  assert(v({ ...NOTES, name: 'org-fine' }, 'org').ok, 'org scope refused its own prefix')
  assert(!v({ ...NOTES, inputs: Array.from({ length: 9 }, (_, i) => ({ name: `i${i}` })) }).ok, 'nine inputs accepted')
  assert(!v({ ...NOTES, instructions: 'x'.repeat(store.MAX_INSTRUCTIONS_CHARS + 1) }).ok, 'oversized instructions accepted')
})

await test('composition: one-pass substitution, appended inputs, required inputs', () => {
  const wf = store.validateWorkflow(NOTES, { scope: 'personal' }).fields
  const r = store.composeWorkflowMessage(wf, { notes: 'call {{client}} back', client: 'Acme' })
  assert(r.ok, r.error)
  assert(r.text.includes('for Acme as a status report'), 'placeholder not filled')
  assert(r.text.includes('call {{client}} back'), 'a value was re-read as template')
  assert(r.text.includes('Example input:') && r.text.includes('Example output:'), 'example missing')
  assert(r.text.startsWith('Workflow: Work notes'), 'title header missing')
  const missing = store.composeWorkflowMessage(wf, { client: 'Acme' })
  assert(!missing.ok && /notes/.test(missing.error), 'missing required input accepted')
  const optionalBlank = store.composeWorkflowMessage(wf, { notes: 'n' })
  assert(optionalBlank.ok && optionalBlank.text.includes('for  as'), 'optional input not blanked')
  const plain = store.validateWorkflow({ name: 'tidy', instructions: 'Tidy this up.', inputs: [{ name: 'text' }] }, { scope: 'personal' }).fields
  const appended = store.composeWorkflowMessage(plain, { text: 'hello wrld' })
  assert(appended.ok && appended.text.endsWith('text:\nhello wrld'), 'unreferenced input not appended')
})

// ---------------------------------------------------------------------------
// The permission
// ---------------------------------------------------------------------------

await test('manageOrgWorkflows: admin by default, withholdable, never user tier', () => {
  assert(ADMIN_PERMISSIONS.includes('manageOrgWorkflows'), 'not an admin permission')
  assert(can(ADMIN, null, 'manageOrgWorkflows'), 'admin without a role lacks it')
  assert(!can(ADMIN, { permissions: { admin: { manageAccounts: true } } }, 'manageOrgWorkflows'), 'a narrowing role did not withhold it')
  assert(can(ADMIN, { permissions: { admin: { manageOrgWorkflows: true } } }, 'manageOrgWorkflows'), 'a workflow-editor role lost it')
  assert(!can(ALICE, { permissions: { admin: { manageOrgWorkflows: true } } }, 'manageOrgWorkflows'), 'a role granted it to a user')
  assert(!can(null, null, 'manageOrgWorkflows'), 'auth-off null account holds it')
  assert(can({ id: 'o', tier: 'owner' }, null, 'manageOrgWorkflows'), 'owner lacks it')
})

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

let aliceId
let orgId

await test('personal routes: anyone may create; each account sees only its own', async () => {
  assert(isWorkflowRoute('/workflows') && isWorkflowRoute('/workflows/personal') && isWorkflowRoute('/workflows/org/abc-1'), 'route matcher')
  assert(!isWorkflowRoute('/workflows/other') && !isWorkflowRoute('/workflows/personal/../x'), 'route matcher too loose')
  const made = await route('POST', '/workflows/personal', ALICE, NOTES)
  assert(made.status === 201, `create got ${made.status}: ${JSON.stringify(made.json)}`)
  aliceId = made.json.id
  assert(made.json.createdBy === 'alice', 'authorship not recorded')
  const dup = await route('POST', '/workflows/personal', ALICE, NOTES)
  assert(dup.status === 409, `duplicate name got ${dup.status}`)
  const bad = await route('POST', '/workflows/personal', ALICE, { ...NOTES, instructions: '' })
  assert(bad.status === 400, `invalid body got ${bad.status}`)
  // Bob may use the same name: personal names are per account.
  const bobs = await route('POST', '/workflows/personal', BOB, NOTES)
  assert(bobs.status === 201, `bob's same-named workflow got ${bobs.status}`)

  const bobList = await route('GET', '/workflows', BOB)
  assert(bobList.json.personal.length === 1 && bobList.json.personal[0].id !== aliceId, 'bob listed alice\'s workflow')
  assert(bobList.json.canEditOrg === false, 'user offered org edit')
  const edit = await route('PUT', `/workflows/personal/${aliceId}`, BOB, { ...NOTES, title: 'hacked' })
  assert(edit.status === 404, `bob edit got ${edit.status}`)
  const del = await route('DELETE', `/workflows/personal/${aliceId}`, BOB)
  assert(del.status === 404, `bob delete got ${del.status}`)
  assert(store.getWorkflow(ALICE, 'personal', aliceId)?.title === 'Work notes', 'alice\'s workflow changed')

  const own = await route('PUT', `/workflows/personal/${aliceId}`, ALICE, { ...NOTES, title: 'Weekly notes' })
  assert(own.status === 200 && own.json.title === 'Weekly notes' && own.json.id === aliceId, `own edit got ${own.status}`)
})

await test('org routes: writes need manageOrgWorkflows, reads are open', async () => {
  const body = { ...NOTES, name: 'incident-report', title: 'Incident report' }
  for (const [who, account] of [['user', ALICE], ['auth-off', null]]) {
    const r = await route('POST', '/workflows/org', account, body)
    assert(r.status === 403, `${who} org create got ${r.status}`)
  }
  const made = await route('POST', '/workflows/org', ADMIN, body)
  assert(made.status === 201, `admin org create got ${made.status}: ${JSON.stringify(made.json)}`)
  orgId = made.json.id
  const userPut = await route('PUT', `/workflows/org/${orgId}`, ALICE, { ...body, title: 'x' })
  const userDel = await route('DELETE', `/workflows/org/${orgId}`, ALICE)
  assert(userPut.status === 403 && userDel.status === 403, `user org edit/delete got ${userPut.status}/${userDel.status}`)
  const list = await route('GET', '/workflows', ALICE)
  assert(list.json.org.some((w) => w.id === orgId), 'user cannot see org workflows')
  const adminList = await route('GET', '/workflows', ADMIN)
  assert(adminList.json.canEditOrg === true, 'admin not offered org edit')
})

await test('a role withholding manageOrgWorkflows blocks an admin at the route', async () => {
  // Persist a narrowing role and an admin account that holds it, then ask the
  // route as that account — canDo() resolves the role from storage, so this
  // proves the route consults the role and not just the tier.
  const owner = auth.createOwner({ username: 'owner', password: 'owner-password-1' })
  assert(owner.ok, owner.error)
  const ownerAcct = { ...owner.account, tier: 'owner' }
  const role = auth.saveRole(ownerAcct, { name: 'Accounts only', permissions: { admin: { manageAccounts: true } } })
  assert(role.ok, role.error)
  const admin = auth.createAccount(ownerAcct, { username: 'narrowed', password: 'narrowed-password-1', tier: 'admin', roleId: role.role.id })
  assert(admin.ok, admin.error)
  const r = await route('POST', '/workflows/org', admin.account, { ...NOTES, name: 'blocked' })
  assert(r.status === 403, `narrowed admin org create got ${r.status}`)
  const personal = await route('POST', '/workflows/personal', admin.account, { ...NOTES, name: 'mine' })
  assert(personal.status === 201, `narrowed admin personal create got ${personal.status}`)
})

// ---------------------------------------------------------------------------
// MCP prompts
// ---------------------------------------------------------------------------

await test('MCP view: personal then org, org prefixed, runs resolve within reach', () => {
  const prompts = store.promptsFor(ALICE)
  const names = prompts.map((p) => p.name)
  assert(names[0] === 'work-notes', `personal not first: ${names}`)
  assert(names.includes('org-incident-report'), `org not listed under prefix: ${names}`)
  assert(prompts.find((p) => p.name === 'org-incident-report').title.endsWith('(organization)'), 'org title unmarked')
  assert(prompts[0].arguments.length === 2 && prompts[0].arguments[0].required === true, 'arguments not exposed')

  const run = store.getPromptFor(ALICE, 'work-notes', { notes: 'db slow', client: 'Acme' })
  assert(run.ok && run.result.messages[0].role === 'user', 'run did not produce a user message')
  assert(run.result.messages[0].content.text.includes('Weekly notes'), 'ran a different account\'s workflow')
  const unknown = store.getPromptFor(ALICE, 'nope', {})
  assert(!unknown.ok && unknown.code === 'not_found', 'unknown name resolved')
  // A personal name never resolves against org, and an org name never against personal.
  const crossed = store.getPromptFor(ALICE, 'incident-report', { notes: 'x' })
  assert(!crossed.ok, 'an org workflow resolved without its prefix')
})

await test('MCP server: advertises prompts, scopes by bearer, refuses lost identity', async () => {
  const PORT = 48107
  auth.setAuthRequired(true)
  await startMcpServer(PORT, {})
  try {
    const owner = { id: 'x', tier: 'owner' }
    const made = auth.createAccount(owner, { username: 'carol', password: 'carol-password-1', tier: 'user' })
    assert(made.ok, made.error)
    store.createWorkflow(made.account, 'personal', { ...NOTES, name: 'carols', title: 'Carol only' })
    const login = auth.login('carol', 'carol-password-1')
    assert(login.ok, login.error)

    const client = await connectMcpClient(`http://127.0.0.1:${PORT}`, { headers: { Authorization: `Bearer ${login.token}` } })
    assert(client.initResult?.capabilities?.prompts, 'prompts capability not advertised')
    const list = await client.call('prompts/list', {})
    const names = list.result.prompts.map((p) => p.name)
    assert(names.includes('carols') && names.includes('org-incident-report'), `carol's list: ${names}`)
    assert(!names.includes('work-notes'), 'carol listed alice\'s personal workflow')
    const got = await client.call('prompts/get', { name: 'carols', arguments: { notes: 'hello' } })
    assert(got.result?.messages?.[0]?.content?.text.includes('hello'), `prompts/get: ${JSON.stringify(got)}`)
    const refused = await client.call('prompts/get', { name: 'carols', arguments: {} })
    assert(refused.error?.code === -32602, 'missing required input not refused')
    const foreign = await client.call('prompts/get', { name: 'work-notes', arguments: { notes: 'x' } })
    assert(foreign.error, 'carol ran alice\'s workflow by name')

    let anonymousRefused = false
    try {
      await connectMcpClient(`http://127.0.0.1:${PORT}`)
    } catch { anonymousRefused = true }
    assert(anonymousRefused, 'an unauthenticated client connected with auth on')
  } finally {
    await stopMcpServer()
    auth.setAuthRequired(false)
  }
})

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
// exitCode, not process.exit(): exiting mid-close of the fetch client's sockets
// trips a libuv assertion on Windows (UV_HANDLE_CLOSING) and exits 127.
process.exitCode = failed.length ? 1 : 0
