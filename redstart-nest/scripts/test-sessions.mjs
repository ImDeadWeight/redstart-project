// =============================================================================
// Sessions — persisted, hashed at rest, and bound to one plane.
// =============================================================================
// Sessions were an in-memory Map, which is invisible while the window and the
// runtime die together and stops being invisible the moment Phase 7 splits them
// (headless-admin-plane-plan.md §3.7). Three properties come out of moving them
// to disk, and all three are the kind that fail silently:
//
//   1. A session SURVIVES A RESTART. Checked by dropping the in-memory cache and
//      reading the file back, which is the only way to tell "persisted" from
//      "still in the same Map I just wrote to".
//
//   2. sessions.json NEVER CONTAINS A USABLE TOKEN. A session string is being
//      logged in for its lifetime, so a readable file would mean anyone who
//      reads it becomes every logged-in user. Checked against the raw bytes on
//      disk, not against the shape of a record.
//
//   3. A SESSION OPENS ONE PLANE. The gateway issues data-plane sessions and the
//      admin listener issues control-plane ones; an owner logging into the chat
//      UI must not thereby hold process control (§3.6). Checked in both
//      directions, because the interesting failure is the permissive one.
//
// Plus the revocation paths, which persistence makes newly capable of being
// wrong: a session that outlives the account it belongs to is now a file on
// disk rather than a value that vanishes at exit.
//
// Run:  node scripts/test-sessions.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-sessions-test-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir

register('./auth-test-loader.mjs', import.meta.url)

// Explicit, main-thread trigger for the stub's platform-paths.mjs
// initialization — module.register() hooks run in a separate worker thread.
await import('./electron-stub.mjs')

const {
  login, authenticate, authenticateControlPlane, createOwner, createAccount,
  revokeSession, resetPassword, deleteAccount, DATA_PLANE, CONTROL_PLANE,
} = await import('../electron/main/auth.mjs')
const {
  listSessions, reloadSessions, findByTokenHash,
} = await import('../electron/main/sessions-storage.mjs')

const sessionsFile = path.join(tmpDir, 'sessions.json')

// ---------------------------------------------------------------------------
// Tiny test harness (same shape as the sibling suites)
// ---------------------------------------------------------------------------

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

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const reqWith = token => ({ headers: token ? { authorization: `Bearer ${token}` } : {} })

const owner = createOwner({ username: 'owner', password: 'owner-pw-1234' })
if (!owner.ok) throw new Error(`could not create the owner: ${owner.error}`)

const user = createAccount(owner.account, { username: 'user', password: 'user-pw-1234', tier: 'user' })
if (!user.ok) throw new Error(`could not create the user: ${user.error}`)

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

console.log('\n-- persistence --')

await test('🔍 a session survives the process that created it', () => {
  const { token } = login('owner', 'owner-pw-1234', CONTROL_PLANE)
  // Everything the daemon knows in memory, gone. Only the file remains — which
  // is exactly the state a restarted daemon starts in.
  reloadSessions()
  const result = authenticateControlPlane(reqWith(token))
  assert(result.ok && result.account?.username === 'owner', `the session did not survive: ${JSON.stringify(result)}`)
  return 'read back off disk, not out of the Map that wrote it'
})

await test('🔍 the file on disk holds no usable token', () => {
  const { token } = login('owner', 'owner-pw-1234', CONTROL_PLANE)
  const raw = fs.readFileSync(sessionsFile, 'utf8')
  assert(!raw.includes(token), 'the session token is sitting in sessions.json in the clear')
  // And the hash that IS there does not work as a token — a file reader must
  // not be able to replay what they found.
  const parsed = JSON.parse(raw)
  const record = parsed.sessions.find(s => s.accountId === owner.account.id)
  assert(record && typeof record.tokenHash === 'string', 'no session record was written at all')
  assert(!authenticateControlPlane(reqWith(record.tokenHash)).ok, 'the stored hash works as a bearer token')
  return 'hashed at rest, and the hash is not a credential'
})

await test('a token that was never issued resolves to nothing', () => {
  assert(findByTokenHash('0'.repeat(64)) === null, 'an unissued hash resolved to a session')
  assert(!authenticateControlPlane(reqWith('not-a-token')).ok, 'a junk token authenticated')
})

await test('the record carries no authority — only an account to look up', () => {
  const stored = listSessions()
  assert(stored.length > 0, 'no sessions stored')
  for (const record of stored) {
    for (const field of ['tier', 'role', 'roleId', 'permissions']) {
      assert(!(field in record), `the session record caches ${field}, which would now outlive a restart`)
    }
  }
  return 'a role edit still takes effect on the next request'
})

// ---------------------------------------------------------------------------
// Plane binding
// ---------------------------------------------------------------------------

console.log('\n-- one session, one plane --')

await test('🔍 a chat session does not open the control plane', () => {
  const { token } = login('owner', 'owner-pw-1234', DATA_PLANE)
  assert(authenticate(reqWith(token)).ok, 'a data-plane session was refused by the data plane')
  assert(!authenticateControlPlane(reqWith(token)).ok, "the owner's chat login opened process control")
  return 'the gateway cannot mint admin access'
})

await test('🔍 a control-plane session does not open the data plane', () => {
  const { token } = login('owner', 'owner-pw-1234', CONTROL_PLANE)
  assert(authenticateControlPlane(reqWith(token)).ok, 'a control-plane session was refused by the control plane')
  assert(!authenticate(reqWith(token)).ok, 'an admin session authenticated against the gateway')
  return 'symmetric — each plane accepts only its own'
})

await test('the default plane is the data plane, so existing callers are unchanged', () => {
  const { token } = login('owner', 'owner-pw-1234')
  assert(authenticate(reqWith(token)).ok, 'the gateway login stopped working')
  assert(!authenticateControlPlane(reqWith(token)).ok, 'an unqualified login opened the control plane')
})

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

console.log('\n-- revocation outlives nothing --')

await test('logging out revokes the token, on disk too', () => {
  const { token } = login('user', 'user-pw-1234', DATA_PLANE)
  revokeSession(token)
  reloadSessions()
  assert(!authenticate(reqWith(token)).ok, 'a revoked session came back after a restart')
})

await test('🔍 a password reset kills every session the account held', () => {
  const a = login('user', 'user-pw-1234', DATA_PLANE).token
  const b = login('user', 'user-pw-1234', CONTROL_PLANE).token
  resetPassword(owner.account, user.account.id, 'user-pw-5678')
  reloadSessions()
  assert(!authenticate(reqWith(a)).ok, 'a data-plane session survived a password reset')
  assert(!authenticateControlPlane(reqWith(b)).ok, 'a control-plane session survived a password reset')
  return 'both planes, and after a restart'
})

await test("🔍 a deleted account's sessions do not outlive it", () => {
  const victim = createAccount(owner.account, { username: 'victim', password: 'victim-pw-1234', tier: 'user' })
  assert(victim.ok, `could not create the account: ${victim.error}`)
  const token = login('victim', 'victim-pw-1234', DATA_PLANE).token
  assert(authenticate(reqWith(token)).ok, 'the session did not work before the delete')
  deleteAccount(owner.account, victim.account.id)
  reloadSessions()
  assert(!authenticate(reqWith(token)).ok, 'a deleted account kept a working session on disk')
  return 'the case persistence newly makes possible'
})

await test('another account\'s sessions are untouched by a revocation', () => {
  const kept = login('owner', 'owner-pw-1234', CONTROL_PLANE).token
  const doomed = createAccount(owner.account, { username: 'doomed', password: 'doomed-pw-1234', tier: 'user' })
  deleteAccount(owner.account, doomed.account.id)
  reloadSessions()
  assert(authenticateControlPlane(reqWith(kept)).ok, "deleting one account revoked another account's session")
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}`)
  process.exit(1)
}
