// =============================================================================
// One door: POST /admin/bootstrap, and the control-plane login behind it.
// =============================================================================
// `auth:create-first-admin` grants ownership to ANY caller when no owner exists,
// and is safe today only because IPC is its sole door. Two things make that
// unsafe the moment bootstrap speaks HTTP: the route becomes LAN-reachable, and
// "no owner exists" is reachable by CORRUPTION as well as by newness —
// accounts-storage reads a torn accounts.json as no accounts. Without a token,
// first-to-arrive owns the box (headless-admin-plane-plan.md §3.2).
//
// So the properties below are the ones standing between a scanner and ownership:
//
//   1. THE TOKEN IS CHECKED FIRST, before anything else is even looked at. A
//      caller without it learns nothing — not whether an owner exists, not
//      whether a username is taken, not whether their password would have done.
//
//   2. CREATE AND RESET ARE THE SAME DOOR, and a reset preserves everything but
//      the owner's credential. That is the entire gain over the last-resort wipe.
//
//   3. LOGIN REFUSES A NON-OWNER INDISTINGUISHABLY from a bad password. A route
//      that answers differently tells a stranger which usernames exist and which
//      one owns the box.
//
//   4. BOTH ANONYMOUS ROUTES ARE RATE LIMITED. Not an access control — see
//      rate-limit.mjs — but the difference between a slow attack and a free one.
//
// Run:  node scripts/test-admin-bootstrap.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-bootstrap-test-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir

register('./auth-test-loader.mjs', import.meta.url)
await import('./electron-stub.mjs')

const { startAdminListener, stopAdminListener } = await import('../electron/main/admin-listener.mjs')
const { __resetAdminAuthLimiters } = await import('../electron/main/admin/auth-routes.mjs')
const {
  ensureBootstrapToken, readBootstrapToken, rotateBootstrapToken, verifyBootstrapToken,
} = await import('../electron/main/bootstrap-token.mjs')
const { hasOwner, createAccount } = await import('../electron/main/auth.mjs')
// The UNFILTERED list. auth.mjs's listAccounts(actor) applies management
// visibility — an actor that is not the owner sees only user-tier records, and
// no actor at all sees the same — which is right for a route and wrong for a
// test asserting what is on disk.
const { listAccounts } = await import('../electron/main/accounts-storage.mjs')
const { listSessions } = await import('../electron/main/sessions-storage.mjs')

const PORT = 48384
const admin = `http://127.0.0.1:${PORT}`

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

async function post(urlPath, body, headers = {}) {
  const res = await fetch(`${admin}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  let json = null
  try { json = await res.json() } catch { /* 204 and friends */ }
  return { status: res.status, body: json, headers: res.headers }
}

async function get(urlPath, headers = {}) {
  const res = await fetch(`${admin}${urlPath}`, { headers })
  let json = null
  try { json = await res.json() } catch { /* no body */ }
  return { status: res.status, body: json }
}

const bearer = token => ({ Authorization: `Bearer ${token}` })

const bootstrap = (body) => post('/admin/bootstrap', body)
const doLogin = (username, password) => post('/admin/auth/login', { username, password })

await startAdminListener({ bindHost: '127.0.0.1', port: PORT })

// ---------------------------------------------------------------------------
// The token itself
// ---------------------------------------------------------------------------

console.log('\n-- the box token --')

await test('🔍 a token is minted on first run and then reused', () => {
  assert(readBootstrapToken() === null, 'a fresh data directory already had a token')
  const first = ensureBootstrapToken()
  assert(typeof first === 'string' && first.length > 0, 'no token was produced')
  assert(ensureBootstrapToken() === first, 'a second call minted a different token')
  return first.replace(/[^-]/g, 'x')
})

await test('it is readable off the disk, which is the whole point', () => {
  const onDisk = fs.readFileSync(path.join(tmpDir, 'bootstrap-token.txt'), 'utf8').trim()
  assert(onDisk === readBootstrapToken(), 'the file and the reader disagree')
  return 'plaintext, deliberately — the Electron client submits it for the user'
})

await test('🔍 it carries real entropy and no confusable characters', () => {
  const seen = new Set()
  for (let i = 0; i < 200; i++) seen.add(rotateBootstrapToken())
  assert(seen.size === 200, `${200 - seen.size} collisions in 200 tokens`)
  for (const token of seen) {
    assert(!/[ILOU]/.test(token), `${token} contains a character people misread`)
    assert(token.replace(/-/g, '').length === 20, `${token} is the wrong length`)
  }
  return '20 chars over a 32-symbol alphabet — 100 bits'
})

await test('🔍 rotation invalidates the old token', () => {
  const old = readBootstrapToken()
  const fresh = rotateBootstrapToken()
  assert(fresh !== old, 'rotation produced the same token')
  assert(verifyBootstrapToken(fresh), 'the new token does not verify')
  assert(!verifyBootstrapToken(old), 'the old token still verifies after rotation')
  return 'for a box that moved, or a label that was photographed'
})

await test('a token typed by a human matches — case and grouping are forgiven', () => {
  const token = readBootstrapToken()
  assert(verifyBootstrapToken(token.toLowerCase()), 'lowercase was refused')
  assert(verifyBootstrapToken(token.replace(/-/g, '')), 'ungrouped was refused')
  assert(verifyBootstrapToken(` ${token} `), 'surrounding whitespace was refused')
  return 'read off a chassis label, typed into a phone'
})

await test('🔍 a near-miss, an empty string and a non-string are all refused', () => {
  const token = readBootstrapToken()
  const nearMiss = token.slice(0, -1) + (token.endsWith('Z') ? 'Y' : 'Z')
  for (const candidate of [nearMiss, '', null, undefined, 42, {}, token + 'X']) {
    assert(!verifyBootstrapToken(candidate), `${JSON.stringify(candidate)} verified`)
  }
})

// ---------------------------------------------------------------------------
// Creating the first owner
// ---------------------------------------------------------------------------

console.log('\n-- create --')

const TOKEN = readBootstrapToken()

await test('🔍 no token creates no owner', async () => {
  const res = await bootstrap({ username: 'owner', password: 'owner-pw-1234' })
  assert(res.status === 401, `expected 401, got ${res.status}`)
  assert(!hasOwner(), 'an owner was created without the token')
})

await test('🔍 a wrong token is refused before anything else is looked at', async () => {
  // Same request twice, once with a password that would be rejected on its own
  // merits. If the two answers differ, the route is leaking what it checked.
  const a = await bootstrap({ token: 'WRONG-WRONG-WRONG-WRON', username: 'owner', password: 'owner-pw-1234' })
  const b = await bootstrap({ token: 'WRONG-WRONG-WRONG-WRON', username: '', password: 'x' })
  assert(a.status === 401 && b.status === 401, `got ${a.status} and ${b.status}`)
  assert(JSON.stringify(a.body) === JSON.stringify(b.body), `different answers: ${JSON.stringify(a.body)} vs ${JSON.stringify(b.body)}`)
  assert(!hasOwner(), 'an owner was created with a wrong token')
  return 'the token is the first gate, not one of several'
})

await test('🔍 a short password is refused — but only once the token is right', async () => {
  const res = await bootstrap({ token: TOKEN, username: 'owner', password: 'short' })
  assert(res.status === 400, `expected 400, got ${res.status}`)
  assert(!hasOwner(), 'a short password still created an owner')
  return 'the owner password now gates a LAN-reachable process-spawning plane'
})

let ownerAccount = null

await test('🔍 the right token creates the owner and returns the API key once', async () => {
  const res = await bootstrap({ token: TOKEN, username: 'owner', password: 'owner-pw-1234' })
  ownerAccount = res.body?.user
  assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`)
  assert(res.body.reset === false, 'a create reported itself as a reset')
  assert(res.body.user?.tier === 'owner', `created tier ${res.body.user?.tier}`)
  assert(typeof res.body.apiKey === 'string' && res.body.apiKey.startsWith('rst_'), 'no API key came back')
  assert(hasOwner(), 'the owner was not persisted')
})

await test('the config route reports an owner now, without any credential', async () => {
  const res = await get('/admin/auth/config')
  assert(res.status === 200, `expected 200, got ${res.status}`)
  assert(res.body.hasOwner === true, 'the SPA cannot tell there is an owner')
})

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

console.log('\n-- login --')

// Two non-owner accounts, so the refusal is checked against something real and
// not only against a username nobody has. Created through the ordinary path
// with the owner as the actor, exactly as the accounts panel would.
for (const [username, password, tier] of [
  ['sub-admin', 'admin-pw-1234', 'admin'],
  ['regular', 'user-pw-1234', 'user'],
]) {
  const made = createAccount(ownerAccount, { username, password, tier })
  if (!made.ok) throw new Error(`could not create ${username}: ${made.error}`)
}

__resetAdminAuthLimiters()

let ownerToken = null

await test('🔍 the owner gets a session that opens the control plane', async () => {
  const res = await doLogin('owner', 'owner-pw-1234')
  assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`)
  ownerToken = res.body.token
  assert(typeof ownerToken === 'string' && ownerToken.length >= 64, 'no session token returned')
  const me = await get('/admin/auth/me', bearer(ownerToken))
  assert(me.status === 200 && me.body.user?.username === 'owner', `whoami said ${JSON.stringify(me.body)}`)
})

await test('🔍 an admin, a user, a bad password and a ghost are indistinguishable', async () => {
  const answers = []
  for (const [u, p] of [
    ['sub-admin', 'admin-pw-1234'],   // real, correct password, not the owner
    ['regular', 'user-pw-1234'],      // ditto
    ['owner', 'wrong-password-here'], // the owner, wrong password
    ['nobody', 'wrong-password-here'], // no such account
  ]) {
    const res = await doLogin(u, p)
    answers.push(`${res.status}:${JSON.stringify(res.body)}`)
  }
  assert(answers.every(a => a === answers[0]), `the route distinguishes cases:\n        ${answers.join('\n        ')}`)
  assert(answers[0].startsWith('401'), `expected 401, got ${answers[0]}`)
  return 'no username oracle, no owner oracle'
})

await test('🔍 a refused non-owner login leaves no session behind', () => {
  // login() mints the session and the route throws it away — so the check that
  // matters is on the store, not on the response.
  const subAdmin = listAccounts().find(a => a.username === 'sub-admin')
  assert(subAdmin, 'the sub-admin account is missing')
  const stale = listSessions().filter(s => s.accountId === subAdmin.id)
  assert(stale.length === 0, `${stale.length} session(s) survived a refused control-plane login`)
})

await test('logging out revokes the session it was called with', async () => {
  const res = await doLogin('owner', 'owner-pw-1234')
  const token = res.body.token
  const out = await post('/admin/auth/logout', {}, bearer(token))
  assert(out.status === 204, `expected 204, got ${out.status}`)
  const me = await get('/admin/auth/me', bearer(token))
  assert(me.status === 401, `a logged-out token still worked: ${me.status}`)
})

await test('🔍 login is rate limited', async () => {
  __resetAdminAuthLimiters()
  let sawLimit = false
  for (let i = 0; i < 15; i++) {
    const res = await doLogin('owner', 'wrong-password-here')
    if (res.status === 429) { sawLimit = true; break }
  }
  assert(sawLimit, '15 wrong passwords in a row were all answered normally')
  // And a correct password does not get in while the window is closed — the
  // limit is on the route, not on the guess.
  const blocked = await doLogin('owner', 'owner-pw-1234')
  assert(blocked.status === 429, `the limit let a correct password through with ${blocked.status}`)
  return 'a brake on automated guessing'
})

// ---------------------------------------------------------------------------
// Reset — the same door
// ---------------------------------------------------------------------------

console.log('\n-- reset --')

__resetAdminAuthLimiters()

await test('🔍 the same route re-keys an existing owner', async () => {
  const before = listAccounts().length
  const res = await bootstrap({ token: readBootstrapToken(), username: 'owner2', password: 'owner-pw-5678' })
  assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`)
  assert(res.body.reset === true, 'a reset reported itself as a create')
  assert(res.body.user?.username === 'owner2', `username is ${res.body.user?.username}`)
  assert(listAccounts().length === before, 'the reset created a second account instead of re-keying')

  __resetAdminAuthLimiters()
  const fresh = await doLogin('owner2', 'owner-pw-5678')
  assert(fresh.status === 200, `the new credential does not work: ${fresh.status}`)
  const old = await doLogin('owner', 'owner-pw-1234')
  assert(old.status === 401, `the old credential still works: ${old.status}`)
  return 'no separate recovery route'
})

await test('🔍 a reset returns no API key — it did not mint one', async () => {
  __resetAdminAuthLimiters()
  const res = await bootstrap({ token: readBootstrapToken(), username: 'owner2', password: 'owner-pw-9012' })
  assert(res.status === 200, `expected 200, got ${res.status}`)
  assert(!('apiKey' in res.body), 'a reset handed back a credential the caller did not establish')
})

await test('🔍 a reset preserves every other account', () => {
  const usernames = listAccounts().map(a => a.username).sort()
  assert(usernames.includes('sub-admin') && usernames.includes('regular'),
    `other accounts did not survive the reset: ${usernames.join(', ')}`)
  return 'the entire gain over the last-resort wipe'
})

await test("🔍 a reset revokes the owner's sessions", async () => {
  __resetAdminAuthLimiters()
  const live = await doLogin('owner2', 'owner-pw-9012')
  assert(live.status === 200, `could not log in to be revoked: ${live.status}`)

  __resetAdminAuthLimiters()
  await bootstrap({ token: readBootstrapToken(), username: 'owner2', password: 'owner-pw-3456' })
  const me = await get('/admin/auth/me', bearer(live.body.token))
  assert(me.status === 401, `a session survived the reset that was meant to end it: ${me.status}`)
})

await test('a reset cannot take a username another account holds', async () => {
  __resetAdminAuthLimiters()
  const res = await bootstrap({ token: readBootstrapToken(), username: 'sub-admin', password: 'owner-pw-7890' })
  assert(res.status === 400, `expected 400, got ${res.status}`)
  const stillAdmin = listAccounts().find(a => a.username === 'sub-admin')
  assert(stillAdmin?.tier === 'admin', 'the collision promoted an existing account')
})

await test('🔍 bootstrap is rate limited too', async () => {
  __resetAdminAuthLimiters()
  let sawLimit = false
  for (let i = 0; i < 15; i++) {
    const res = await bootstrap({ token: 'WRONG-WRONG-WRONG-WRON', username: 'x', password: 'password-1234' })
    if (res.status === 429) { sawLimit = true; break }
  }
  assert(sawLimit, '15 wrong tokens in a row were all answered normally')
})

stopAdminListener()

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
