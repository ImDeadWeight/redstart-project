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

await test('a destructive tool can never be always allowed, and a read needs no grant', () => {
  const del = grants.addGrant(ALICE, 'delete_file')
  assert(!del.ok && /every call/.test(del.error), `delete_file granted: ${JSON.stringify(del)}`)
  assert(!grants.addGrant(ALICE, 'memory_forget', { source: 'import' }).ok, 'memory_forget imported')
  assert(!grants.addGrant(ALICE, 'read_document').ok, 'a read tool granted')
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

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
process.exit(failed.length ? 1 : 0)
