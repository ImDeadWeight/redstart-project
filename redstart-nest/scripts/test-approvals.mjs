#!/usr/bin/env node
// =============================================================================
// Approvals: the rule, the ledger, standing grants (agent-runtime plan Phase 2)
// =============================================================================
// The approval rule each tool gets from its class (tools-definitions.mjs),
// the ledger's binding of a decision to one exact call (approval-ledger.mjs),
// and standing grants per account (approval-grants.mjs). Enforcement at
// tools/call and the gateway routes have their own section below once they
// exist.
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-approvals-test-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir
register('./auth-test-loader.mjs', import.meta.url)
await import('./electron-stub.mjs')

const defs = await import('../daemon/tools-definitions.mjs')
const ledger = await import('../daemon/approval-ledger.mjs')
const grants = await import('../daemon/approval-grants.mjs')
const { memoryKey } = await import('../daemon/memory-storage.mjs')
const shared = await import('../../shared/agent-core/approval.mjs')
const { configDir } = await import('../daemon/platform-paths.mjs')

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
function eq(a, b, what) { assert(JSON.stringify(a) === JSON.stringify(b), `${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`) }

const ALICE = memoryKey({ id: 'alice-1', username: 'alice' })
const BOB = memoryKey({ id: 'bob-2', username: 'bob' })
const ANON = memoryKey(null)

console.log('\n-- the approval rule (D10) --')

await test('the rule follows the class: read/network none, write prompt, destructive always', () => {
  const rows = ['read_document', 'web_fetch', 'create_document', 'run_python', 'memory_save', 'delete_file', 'memory_forget']
    .map((n) => `${n}:${defs.approvalRule(n)}`)
  eq(rows, ['read_document:none', 'web_fetch:none', 'create_document:prompt', 'run_python:prompt', 'memory_save:prompt', 'delete_file:always', 'memory_forget:always'], 'rules')
})

await test('the host-resolved tools need no approval and are never enforced', () => {
  for (const n of defs.HOST_RESOLVED_TOOL_NAMES) {
    assert(defs.approvalRule(n) === 'none' && !defs.isApprovalEnforced(n), `${n} needs approval`)
  }
})

await test('Phase 2 enforces exactly the destructive tools (D11; decided 2026-11-12)', () => {
  eq(['delete_file', 'memory_forget', 'create_document', 'run_python', 'read_document'].map(defs.isApprovalEnforced), [true, true, false, false, false], 'enforced')
  assert(defs.ENFORCED_TOOLS.size === 0, 'ENFORCED_TOOLS should be empty until run_command')
})

await test('an override can only tighten a rule, never loosen one', () => {
  defs.APPROVAL_OVERRIDES.delete_file = 'prompt'
  defs.APPROVAL_OVERRIDES.create_document = 'always'
  try {
    assert(defs.approvalRule('delete_file') === 'always', 'an override loosened delete_file')
    assert(defs.approvalRule('create_document') === 'always', 'an override did not tighten create_document')
    assert(defs.isApprovalEnforced('create_document'), 'a tightened tool is not enforced')
  } finally {
    delete defs.APPROVAL_OVERRIDES.delete_file
    delete defs.APPROVAL_OVERRIDES.create_document
  }
})

console.log('\n-- the ledger: one decision, one exact call (D12) --')

const call = (args, accountKey = ALICE, tool = 'delete_file') => ({ accountKey, tool, args })

await test('canonical JSON: key order does not change the digest, values and array order do', () => {
  assert(ledger.argsDigest({ a: 1, b: { c: 2, d: 3 } }) === ledger.argsDigest({ b: { d: 3, c: 2 }, a: 1 }), 'key order changed the digest')
  assert(ledger.argsDigest({ path: 'a.md' }) !== ledger.argsDigest({ path: 'b.md' }), 'a different path digests the same')
  assert(ledger.argsDigest({ xs: [1, 2] }) !== ledger.argsDigest({ xs: [2, 1] }), 'array order ignored')
  assert(ledger.argsDigest(undefined) === ledger.argsDigest({}), 'no arguments and {} differ')
})

await test('decided once, consumed once, for the same call', () => {
  ledger._reset()
  const a = ledger.requestApproval(call({ path: 'notes/a.md' }))
  assert(ledger.consume(a.id, call({ path: 'notes/a.md' })) === false, 'consumed before any decision')
  const b = ledger.requestApproval(call({ path: 'notes/a.md' }))
  eq(ledger.decide(b.id, ALICE, 'once'), { ok: true, tool: 'delete_file' }, 'decide')
  eq(ledger.decide(b.id, ALICE, 'once'), { ok: false, error: 'already decided' }, 'second decision')
  assert(ledger.consume(b.id, call({ path: 'notes/a.md' })) === true, 'the approved call was refused')
  assert(ledger.consume(b.id, call({ path: 'notes/a.md' })) === false, 'an approval was used twice')
})

await test('the digest binding: an approval for one argument set refuses another, and is then spent', () => {
  ledger._reset()
  const a = ledger.requestApproval(call({ path: 'notes/a.md' }))
  ledger.decide(a.id, ALICE, 'once')
  assert(ledger.consume(a.id, call({ path: 'notes/b.md' })) === false, 'another path got through')
  assert(ledger.consume(a.id, call({ path: 'notes/a.md' })) === false, 'a refused approval could be retried')
  const c = ledger.requestApproval(call({ path: 'notes/a.md' }))
  ledger.decide(c.id, ALICE, 'once')
  assert(ledger.consume(c.id, call({ path: 'notes/a.md' }, ALICE, 'memory_forget')) === false, 'another tool got through')
})

await test('another account can neither decide nor spend nor burn the approval', () => {
  ledger._reset()
  const a = ledger.requestApproval(call({ path: 'notes/a.md' }))
  eq(ledger.decide(a.id, BOB, 'once'), { ok: false, error: 'not found' }, "bob deciding alice's")
  ledger.decide(a.id, ALICE, 'once')
  assert(ledger.consume(a.id, call({ path: 'notes/a.md' }, BOB)) === false, "bob spent alice's approval")
  assert(ledger.consume(a.id, call({ path: 'notes/a.md' })) === true, "bob's attempt burned alice's approval")
})

await test('a deny is final, and expiry removes an undecided approval', () => {
  ledger._reset()
  const a = ledger.requestApproval(call({}))
  ledger.decide(a.id, ALICE, 'deny')
  assert(ledger.consume(a.id, call({})) === false, 'a denied call went through')
  let t = 1_000_000
  ledger._setClock(() => t)
  try {
    const b = ledger.requestApproval(call({}))
    assert(b.expiresAt === t + ledger.APPROVAL_TTL_MS, 'expiresAt')
    t += ledger.APPROVAL_TTL_MS
    eq(ledger.decide(b.id, ALICE, 'once'), { ok: false, error: 'not found' }, 'decided after expiry')
    const c = ledger.requestApproval(call({}))
    ledger.decide(c.id, ALICE, 'once')
    t += ledger.APPROVAL_TTL_MS + 1
    assert(ledger.consume(c.id, call({})) === false, 'an expired approval was spent')
  } finally {
    ledger._setClock(null)
  }
})

await test('bounded per account: the oldest pending goes first, other accounts are untouched', () => {
  ledger._reset()
  const bobs = ledger.requestApproval(call({}, BOB))
  const first = ledger.requestApproval(call({ n: 0 }))
  for (let i = 1; i < ledger.MAX_PENDING_PER_ACCOUNT; i++) ledger.requestApproval(call({ n: i }))
  ledger.requestApproval(call({ n: 'one more' }))
  eq(ledger.decide(first.id, ALICE, 'once'), { ok: false, error: 'not found' }, "alice's oldest is still there")
  eq(ledger.decide(bobs.id, BOB, 'once'), { ok: true, tool: 'delete_file' }, "bob's was evicted by alice")
  assert(ledger.pendingCount() === ledger.MAX_PENDING_PER_ACCOUNT + 1, `pending ${ledger.pendingCount()}`)
})

await test('the summary a card may show is cut short, and the arguments themselves are not kept', () => {
  ledger._reset()
  const a = ledger.requestApproval(call({ path: 'x'.repeat(1000) }))
  assert(a.summary.length <= ledger.MAX_SUMMARY_CHARS && a.summary.startsWith('delete_file {"path":"xxx'), a.summary)
  assert(!('args' in a), 'the arguments are returned')
})

console.log('\n-- standing grants (D13) --')

await test('per account, idempotent, newest first, and a revoke is the owner\'s alone', () => {
  const a = grants.addGrant(ALICE, 'create_document')
  assert(a.ok && a.created, a.error)
  const again = grants.addGrant(ALICE, 'create_document')
  assert(again.ok && !again.created && again.grant.id === a.grant.id, 'a second grant was made')
  grants.addGrant(ALICE, 'run_python', { source: 'import' })
  eq(grants.listGrants(ALICE).map((g) => g.tool).sort(), ['create_document', 'run_python'], "alice's grants")
  eq(grants.listGrants(BOB), [], "bob sees alice's grants")
  assert(grants.covers(ALICE, 'create_document') && !grants.covers(BOB, 'create_document'), 'covers')
  assert(grants.revokeGrant(BOB, a.grant.id) === null, "bob revoked alice's grant")
  assert(grants.revokeGrant(ALICE, a.grant.id)?.tool === 'create_document', 'alice could not revoke')
  assert(!grants.covers(ALICE, 'create_document'), 'a revoked grant still covers')
})

await test('a destructive tool can never be always allowed; a read can (the chat card asks for reads too)', () => {
  const del = grants.addGrant(ALICE, 'delete_file')
  assert(!del.ok && /every call/.test(del.error), `delete_file granted: ${JSON.stringify(del)}`)
  assert(!grants.addGrant(ALICE, 'memory_forget', { source: 'import' }).ok, 'memory_forget imported')
  // Allowed from 2026-11-12: "Allow all tools from redstart-fetch" did not stick.
  assert(grants.addGrant(ALICE, 'read_document').ok && grants.addGrant(ALICE, 'web_fetch').ok, 'a read or network tool was refused')
  assert(!grants.covers(ALICE, 'web_fetch'), 'a grant for a tool Nest never asks about changed what Nest enforces')
  assert(!grants.addGrant(ALICE, '../../etc').ok, 'a path accepted as a tool name')
})

await test('a grant stops covering the moment its tool becomes "always" (written before a reclassification)', () => {
  const g = grants.addGrant(ALICE, 'edit_file')
  assert(g.ok && grants.covers(ALICE, 'edit_file'), 'not covered')
  defs.APPROVAL_OVERRIDES.edit_file = 'always'
  try {
    assert(!grants.covers(ALICE, 'edit_file'), 'a stale grant covers an "always" tool')
  } finally {
    delete defs.APPROVAL_OVERRIDES.edit_file
  }
})

await test('auth off: one shared anonymous set, as memories are', () => {
  assert(ANON === '_local', `anonymous key ${ANON}`)
  grants.addGrant(ANON, 'create_document')
  assert(grants.covers(memoryKey(null), 'create_document'), 'the anonymous scope did not see its grant')
  assert(!grants.covers(ALICE, 'create_document'), 'the anonymous grant leaked to an account')
})

await test('an admin revokes anyone\'s grant by id; an unknown id is null', () => {
  const g = grants.addGrant(BOB, 'write_file')
  eq(grants.revokeAnyGrant(g.grant.id)?.accountKey, BOB, 'revoked from')
  assert(grants.revokeAnyGrant(g.grant.id) === null, 'revoked twice')
})

await test('a torn or hand-edited approvals.json reads as no grants, and the next write repairs it', () => {
  const f = path.join(configDir(), 'approvals.json')
  fs.writeFileSync(f, '{"accounts": [')
  eq(grants.listGrants(ALICE), [], 'a torn file')
  fs.writeFileSync(f, JSON.stringify({ accounts: ['not', 'an', 'object'] }))
  eq(grants.listGrants(ALICE), [], 'accounts as an array')
  assert(grants.addGrant(ALICE, 'create_document').ok, 'could not write after a bad file')
  assert(JSON.parse(fs.readFileSync(f, 'utf8')).accounts[ALICE].length === 1, 'not repaired')
})

console.log('\n-- the shared wire names (shared/agent-core/approval.mjs) --')

await test('approvalRequired reads a pending approval off an error result, and nothing else', () => {
  const p = { id: 'a1', tool: 'delete_file', summary: 's', argsDigest: 'd', expiresAt: 5 }
  eq(shared.approvalRequired({ isError: true, content: [], _meta: { [shared.APPROVAL_META_KEY]: p } }), p, 'pending')
  for (const bad of [null, 'x', { isError: false, _meta: { [shared.APPROVAL_META_KEY]: p } }, { isError: true }, { isError: true, _meta: { [shared.APPROVAL_META_KEY]: { tool: 'x' } } }]) {
    assert(shared.approvalRequired(bad) === null, `read as an approval: ${JSON.stringify(bad)}`)
  }
  eq(shared.APPROVAL_DECISIONS, ['once', 'always', 'deny'], 'decisions')
})

console.log('\n-- the decision log (D14) and the owner\'s view --')

const logger = await import('../daemon/logger.mjs')
const adminApprovals = await import('../daemon/ipc/approvals.mjs')
const logDir = path.join(tmpDir, 'logs')
logger.initLogger(logDir)
const policyLines = () => fs.readFileSync(path.join(logDir, 'policy.jsonl'), 'utf8').trim().split('\n')
  .flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })

await test('logPolicy keeps only its allowlist: never arguments, a path or a summary', () => {
  logger.logPolicy('approval.denied', {
    account: 'alice', tool: 'delete_file', decision: 'deny',
    args: { path: 'secret/plans.md' }, path: 'secret/plans.md', summary: 'delete_file {"path":"secret/plans.md"}', nested: { a: 1 },
  })
  const last = policyLines().at(-1)
  eq(Object.keys(last).sort(), ['account', 'decision', 'event', 't', 'tool'], 'fields written')
  assert(!JSON.stringify(last).includes('secret'), 'the path reached the log')
})

await test('an unknown event is a programming error, not a silent line', () => {
  let threw = false
  try { logger.logPolicy('tool.called', { tool: 'x' }) } catch { threw = true }
  assert(threw, 'an unknown event was written')
})

await test('readPolicyLog: newest first, paged by the last t, more when there is more', async () => {
  for (let i = 0; i < 5; i++) {
    logger.logPolicy('grant.added', { account: 'alice', tool: `t${i}`, grantId: `g${i}` })
    await new Promise((r) => setTimeout(r, 2))
  }
  const page1 = logger.readPolicyLog({ limit: 2 })
  eq(page1.records.map((r) => r.tool), ['t4', 't3'], 'page 1')
  assert(page1.more, 'more not set')
  const page2 = logger.readPolicyLog({ limit: 2, before: page1.records.at(-1).t })
  eq(page2.records.map((r) => r.tool), ['t2', 't1'], 'page 2')
  fs.appendFileSync(path.join(logDir, 'policy.jsonl'), 'not json\n{"t":"x","event":"made.up"}\n')
  assert(logger.readPolicyLog({ limit: 1 }).records[0].tool === 't4', 'a bad line was returned')
})

await test('the owner lists an account\'s grants by username, and revokes one, which is logged as by: owner', () => {
  const store = path.join(configDir(), 'accounts.json')
  const before = fs.existsSync(store) ? fs.readFileSync(store, 'utf8') : null
  const accounts = JSON.parse(before ?? '{"accounts":[]}')
  accounts.accounts = [...(accounts.accounts ?? []), { id: 'carol-3', username: 'carol', tier: 'user' }]
  fs.writeFileSync(store, JSON.stringify(accounts))
  try {
    const carol = memoryKey({ id: 'carol-3', username: 'carol' })
    const g = grants.addGrant(carol, 'run_python')
    const listed = adminApprovals.listAccountGrants('Carol')
    assert(listed.ok && listed.grants.some((x) => x.id === g.grant.id), `listing: ${JSON.stringify(listed)}`)
    eq(adminApprovals.listAccountGrants('nobody'), { ok: false, error: 'no such account' }, 'unknown user')
    eq(adminApprovals.revokeAccountGrant(g.grant.id), { ok: true, tool: 'run_python' }, 'revoke')
    const last = policyLines().at(-1)
    eq([last.event, last.account, last.tool, last.by], ['grant.revoked', 'carol', 'run_python', 'owner'], 'logged')
    eq(adminApprovals.revokeAccountGrant(g.grant.id), { ok: false, error: 'no such grant' }, 'second revoke')
  } finally {
    if (before === null) fs.rmSync(store, { force: true }); else fs.writeFileSync(store, before)
  }
})

await test('the three owner methods are in the control-plane table', async () => {
  const { buildAdminApi } = await import('../daemon/admin/api-table.mjs')
  const api = buildAdminApi({})
  for (const c of ['audit:list', 'approvals:list-grants', 'approvals:revoke-grant']) assert(typeof api[c] === 'function', `${c} missing`)
})

console.log('\n-- enforcement at tools/call (D11/D12) --')

const { approvalGate } = await import('../daemon/mcp-server.mjs')
const { handleApprovalRoute, isApprovalRoute } = await import('../daemon/gateway/approval-routes.mjs')
const { Readable } = await import('node:stream')
const ALICE_ACCOUNT = { id: 'alice-1', username: 'alice' }
const BOB_ACCOUNT = { id: 'bob-2', username: 'bob' }

await test('no approval: the gate refuses and opens a pending approval for exactly that call', () => {
  ledger._reset()
  const g = approvalGate('delete_file', { path: 'a.md' }, undefined, { account: ALICE_ACCOUNT })
  assert(!g.ok && g.pending.tool === 'delete_file' && g.pending.argsDigest === ledger.argsDigest({ path: 'a.md' }), JSON.stringify(g))
})

await test('a decided approval passes once; a standing grant never covers an "always" tool', () => {
  ledger._reset()
  const g = approvalGate('delete_file', { path: 'a.md' }, undefined, { account: ALICE_ACCOUNT })
  ledger.decide(g.pending.id, ALICE, 'once')
  assert(approvalGate('delete_file', { path: 'a.md' }, g.pending.id, { account: ALICE_ACCOUNT }).ok, 'the approved call was refused')
  assert(!approvalGate('delete_file', { path: 'a.md' }, g.pending.id, { account: ALICE_ACCOUNT }).ok, 'the approval was used twice')
  // A grant written straight into the file (it cannot be made through addGrant).
  const f = path.join(configDir(), 'approvals.json')
  const data = JSON.parse(fs.readFileSync(f, 'utf8'))
  data.accounts[ALICE] = [...(data.accounts[ALICE] ?? []), { id: 'forged', tool: 'delete_file', scope: null, createdAt: 1, source: 'card' }]
  fs.writeFileSync(f, JSON.stringify(data))
  assert(!approvalGate('delete_file', { path: 'a.md' }, undefined, { account: ALICE_ACCOUNT }).ok, 'a forged grant let a delete through')
})

await test('an approval presented by another account, or for other arguments, is refused and logged as refused', () => {
  ledger._reset()
  const g = approvalGate('delete_file', { path: 'a.md' }, undefined, { account: ALICE_ACCOUNT })
  ledger.decide(g.pending.id, ALICE, 'once')
  assert(!approvalGate('delete_file', { path: 'a.md' }, g.pending.id, { account: BOB_ACCOUNT }).ok, "bob used alice's approval")
  const last = policyLines().at(-1)
  eq([last.event, last.account, last.tool], ['approval.refused', 'bob', 'delete_file'], 'logged')
  assert(!JSON.stringify(last).includes('a.md'), 'the path reached the log')
  assert(approvalGate('delete_file', { path: 'a.md' }, g.pending.id, { account: ALICE_ACCOUNT }).ok, "bob's attempt burned alice's approval")
})

await test('auth off: the gate uses the shared anonymous scope', () => {
  ledger._reset()
  const g = approvalGate('memory_forget', { id: 'm1' }, undefined, { account: null })
  eq(ledger.decide(g.pending.id, '_local', 'once'), { ok: true, tool: 'memory_forget' }, 'decided in _local')
  assert(approvalGate('memory_forget', { id: 'm1' }, g.pending.id, { account: null }).ok, 'refused')
})

console.log('\n-- the gateway routes (2.5) --')

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
  const handled = await handleApprovalRoute(fakeReq(method, body), res, urlPath, account)
  return { handled, status: res.status, json: res.body ? JSON.parse(res.body) : null }
}

await test('which paths are ours', () => {
  eq(['/approvals/grants', '/approvals/grants/import', '/approvals/grants/abc-1', '/approvals/abc-1', '/approvals', '/approvals/a/b'].map(isApprovalRoute),
    [true, true, true, true, false, false], 'isApprovalRoute')
})

await test('POST /approvals/:id decides for its own account only; deny is logged; a bad decision is 400', async () => {
  ledger._reset()
  const g = approvalGate('delete_file', { path: 'x' }, undefined, { account: ALICE_ACCOUNT })
  eq((await route('POST', `/approvals/${g.pending.id}`, BOB_ACCOUNT, { decision: 'once' })).status, 404, "bob deciding alice's")
  eq((await route('POST', `/approvals/${g.pending.id}`, ALICE_ACCOUNT, { decision: 'maybe' })).status, 400, 'bad decision')
  const ok = await route('POST', `/approvals/${g.pending.id}`, ALICE_ACCOUNT, { decision: 'deny' })
  eq([ok.status, ok.json.tool, ok.json.grant], [200, 'delete_file', null], 'deny')
  eq(policyLines().at(-1).event, 'approval.denied', 'logged')
  eq((await route('POST', `/approvals/${g.pending.id}`, ALICE_ACCOUNT, { decision: 'once' })).status, 404, 'decided after a deny')
})

await test('"always" on a delete counts as once: it passes this call and grants nothing', async () => {
  ledger._reset()
  const g = approvalGate('delete_file', { path: 'x' }, undefined, { account: ALICE_ACCOUNT })
  const r = await route('POST', `/approvals/${g.pending.id}`, ALICE_ACCOUNT, { decision: 'always' })
  eq([r.status, r.json.grant], [200, null], 'always on delete')
  assert(approvalGate('delete_file', { path: 'x' }, g.pending.id, { account: ALICE_ACCOUNT }).ok, 'this call was refused')
  assert(!grants.listGrants(ALICE).some((x) => x.tool === 'delete_file' && x.id !== 'forged'), 'a grant for delete_file was made')
})

await test('grants routes: list, add (logged), revoke own only, and the import drops destructive tools', async () => {
  const add = await route('POST', '/approvals/grants', BOB_ACCOUNT, { tool: 'create_document' })
  eq([add.status, add.json.tool], [201, 'create_document'], 'add')
  eq(policyLines().at(-1).event, 'grant.added', 'logged')
  eq((await route('POST', '/approvals/grants', BOB_ACCOUNT, { tool: 'create_document' })).status, 200, 'add again')
  eq((await route('POST', '/approvals/grants', BOB_ACCOUNT, { tool: 'delete_file' })).status, 400, 'add a delete')
  const list = await route('GET', '/approvals/grants', BOB_ACCOUNT)
  assert(list.json.grants.some((x) => x.tool === 'create_document'), 'not listed')
  eq((await route('DELETE', `/approvals/grants/${add.json.id}`, ALICE_ACCOUNT)).status, 404, "alice revoking bob's")
  eq((await route('DELETE', `/approvals/grants/${add.json.id}`, BOB_ACCOUNT)).status, 204, 'bob revoking his own')
  const imp = await route('POST', '/approvals/grants/import', BOB_ACCOUNT, { tools: ['write_file', 'delete_file', 'memory_forget', 'read_document', 'write_file', 42] })
  eq([imp.json.imported.sort(), imp.json.dropped.sort()], [['read_document', 'write_file'], ['delete_file', 'memory_forget']], 'import keeps reads, drops destructive')
  eq((await route('POST', '/approvals/grants/import', BOB_ACCOUNT, { nope: 1 })).status, 400, 'a malformed import')
})

await test('POST /approvals/denied logs a card denial for an enforced tool only, and runs nothing', async () => {
  const r = await route('POST', '/approvals/denied', ALICE_ACCOUNT, { tool: 'delete_file' })
  eq(r.status, 204, 'denied delete_file')
  const last = policyLines().at(-1)
  eq([last.event, last.account, last.tool, last.decision, last.source], ['approval.denied', 'alice', 'delete_file', 'deny', 'card'], 'logged')
  eq((await route('POST', '/approvals/denied', ALICE_ACCOUNT, { tool: 'create_document' })).status, 400, 'a tool Nest does not enforce')
  eq((await route('POST', '/approvals/denied', ALICE_ACCOUNT, {})).status, 400, 'no tool')
  eq((await route('GET', '/approvals/denied', ALICE_ACCOUNT)).handled, false, 'GET is not ours')
})

logger.closeLogger()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
process.exit(failed.length ? 1 : 0)
