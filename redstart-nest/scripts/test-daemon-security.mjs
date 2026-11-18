// =============================================================================
// Daemon security basics — accounts, auth, beacon, the File System gate,
// the /files/download endpoint
// =============================================================================
// Moved from chat-ui's tests/unit/security.test.ts (master plan Phase 7b,
// app-boundaries step 2). Those cases imported daemon/*.mjs from inside the
// chat app; they are Nest's, so they live with Nest's suites now. Every case
// keeps its name and its assertions; only the harness changed (vitest →
// this file's test()/assert, vi.mock('electron') → auth-test-loader.mjs).
//
// Pinned here:
//   - accounts-storage: authRequired defaults to true and survives a read
//   - authenticate(): no exemption for localhost or the LAN; bearer tokens
//     and API keys both work; a bad token does not
//   - the beacon discloses only { app, running, port }
//   - sessions, logout, revocation, the owner > admin > user hierarchy,
//     scrypt hashing, rst_ API keys, one owner only
//   - containmentError(): the File System capability's path gate
//   - /files/download: auth, path checks, both roots, 404
//
// Run:  node scripts/test-daemon-security.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import { randomUUID } from 'node:crypto'
import { deepStrictEqual } from 'node:assert/strict'

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-daemon-security-'))
process.env.REDSTART_TEST_USERDATA_DIR = TEST_DIR
register('./auth-test-loader.mjs', import.meta.url)
await import('./electron-stub.mjs')

const accounts = await import('../daemon/accounts-storage.mjs')
const auth = await import('../daemon/auth.mjs')
const { startBeaconServer, stopBeaconServer } = await import('../daemon/beacon.mjs')
const { containmentError } = await import('../daemon/filesystem-mcp-provider.mjs')
const gw = await import('../daemon/tools-gateway.mjs')
const { resolveUserRoot } = await import('../daemon/user-scope.mjs')

const results = []
// Every case starts from an empty config folder, as the vitest file's
// top-level beforeEach did. `before` is a describe-level beforeEach.
async function test(name, fn, before) {
  try {
    reset()
    if (before) await before()
    const detail = await fn()
    results.push({ name, pass: true })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}
function assert(cond, message) { if (!cond) throw new Error(message) }
function eq(actual, expected, what) {
  try { deepStrictEqual(actual, expected) } catch {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function reset() {
  for (const entry of fs.readdirSync(TEST_DIR)) {
    fs.rmSync(path.join(TEST_DIR, entry), { recursive: true, force: true })
  }
}

const ACCOUNTS_PATH = path.join(TEST_DIR, 'accounts.json')
function writeAccounts(data) {
  fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(data, null, 2), 'utf8')
}
const now = () => new Date().toISOString()

// ---------------------------------------------------------------------------
console.log('\n-- accounts-storage --')

await test('defaults authRequired to true', () => {
  eq(accounts.defaults(), { authRequired: true, accounts: [] }, 'defaults()')
})

await test('normalizes missing authRequired to true on read', () => {
  writeAccounts({ accounts: [] })
  eq(accounts.read().authRequired, true, 'authRequired')
})

await test('preserves existing authRequired value', () => {
  writeAccounts({ authRequired: false, accounts: [] })
  eq(accounts.read().authRequired, false, 'authRequired')
})

await test('setAuthRequired persists true', () => {
  accounts.setAuthRequired(true)
  eq(accounts.getAuthRequired(), true, 'getAuthRequired()')
})

// ---------------------------------------------------------------------------
console.log('\n-- auth.mjs --')

async function setupAccounts(overrides = {}) {
  accounts.setAuthRequired(true)
  if (overrides.account) await accounts.insertAccount(overrides.account)
}

await test('rejects unauthenticated requests when auth is required', async () => {
  await setupAccounts()
  const result = auth.authenticate({ socket: { remoteAddress: '127.0.0.1' }, headers: {} })
  eq(result.ok, false, 'ok')
  eq(result.reason, 'unauthorized', 'reason')
})

await test('rejects unauthenticated requests from LAN addresses', async () => {
  await setupAccounts()
  const result = auth.authenticate({ socket: { remoteAddress: '192.168.1.50' }, headers: {} })
  eq(result.ok, false, 'ok')
})

await test('accepts valid bearer token', async () => {
  const pw = auth.hashPassword('testpass')
  await setupAccounts({
    account: {
      id: 'acc-1', username: 'admin', role: 'owner',
      passwordHash: pw.passwordHash, passwordSalt: pw.passwordSalt,
      apiKeyHash: 'abc123', apiKeyPrefix: 'abc12345',
      createdAt: now(), updatedAt: now(), createdBy: null, status: 'active',
    },
  })
  const loginResult = auth.login('admin', 'testpass')
  eq(loginResult.ok, true, 'login ok')
  assert(loginResult.token !== undefined, 'login returned no token')

  const authResult = auth.authenticate({
    socket: { remoteAddress: '192.168.1.50' },
    headers: { authorization: `Bearer ${loginResult.token}` },
  })
  eq(authResult.ok, true, 'authenticate ok')
  eq(authResult.account?.username, 'admin', 'username')
})

await test('accepts valid API key as bearer token', async () => {
  const pw = auth.hashPassword('testpass')
  const apiKey = auth.generateApiKey()
  await setupAccounts({
    account: {
      id: 'acc-2', username: 'apiuser', role: 'user',
      passwordHash: pw.passwordHash, passwordSalt: pw.passwordSalt,
      apiKeyHash: auth.hashApiKey(apiKey), apiKeyPrefix: apiKey.slice(0, 8),
      createdAt: now(), updatedAt: now(), createdBy: null, status: 'active',
    },
  })
  const authResult = auth.authenticate({
    socket: { remoteAddress: '10.0.0.5' },
    headers: { authorization: `Bearer ${apiKey}` },
  })
  eq(authResult.ok, true, 'ok')
  eq(authResult.account?.username, 'apiuser', 'username')
})

await test('rejects invalid bearer token', async () => {
  await setupAccounts()
  const result = auth.authenticate({
    socket: { remoteAddress: '192.168.1.50' },
    headers: { authorization: 'Bearer invalid-token' },
  })
  eq(result.ok, false, 'ok')
})

await test('localhost is NOT exempt from authentication', async () => {
  await setupAccounts()
  const result = auth.authenticate({ socket: { remoteAddress: '127.0.0.1' }, headers: {} })
  eq(result.ok, false, 'ok')
  eq(result.reason, 'unauthorized', 'reason')
})

await test('IPv6 localhost is NOT exempt from authentication', async () => {
  await setupAccounts()
  const result = auth.authenticate({ socket: { remoteAddress: '::1' }, headers: {} })
  eq(result.ok, false, 'ok')
})

// ---------------------------------------------------------------------------
console.log('\n-- beacon payload --')

await test('returns only the app identity marker, running, and port — no version, auth, or server URLs', async () => {
  // Bind an ephemeral port (0) so this test never collides with a running
  // Redstart instance already holding the real beacon port 8765.
  const server = await startBeaconServer(() => true, () => 19080, 0)
  const boundPort = server.address().port
  try {
    const result = await new Promise((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${boundPort}`, (res) => {
          let data = ''
          res.on('data', (chunk) => (data += chunk))
          res.on('end', () => {
            try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
          })
        })
        .on('error', reject)
    })
    // The `app` marker is an intentional identity string so clients can
    // positively identify a Redstart Nest; it is NOT a config leak. The
    // security contract is that nothing beyond these three fields — no
    // version, auth state, MCP URLs, or LAN IP — is disclosed.
    eq(result, { app: 'redstart-nest', running: true, port: 19080 }, 'payload')
    eq(Object.keys(result).length, 3, 'field count')
  } finally {
    stopBeaconServer(server)
  }
})

// ---------------------------------------------------------------------------
console.log('\n-- auth.mjs — sessions and roles --')

async function createTestAccount(username = 'testuser', role = 'user') {
  accounts.setAuthRequired(true)
  const pw = auth.hashPassword('testpass')
  return accounts.insertAccount({
    id: randomUUID(), username, role,
    passwordHash: pw.passwordHash, passwordSalt: pw.passwordSalt,
    apiKeyHash: 'abc123', apiKeyPrefix: 'abc12345',
    createdAt: now(), updatedAt: now(), createdBy: null, status: 'active',
  })
}

await test('login returns token and user on valid credentials', async () => {
  await createTestAccount('alice', 'owner')
  const result = auth.login('alice', 'testpass')
  eq(result.ok, true, 'ok')
  assert(result.token !== undefined, 'no token')
  eq(result.user?.username, 'alice', 'username')
  eq(result.user?.role, 'owner', 'role')

  const a = auth.authenticate({
    socket: { remoteAddress: '10.0.0.1' },
    headers: { authorization: `Bearer ${result.token}` },
  })
  eq(a.ok, true, 'authenticate ok')
  eq(a.account?.role, 'owner', 'account role')
})

await test('login rejects wrong password', async () => {
  await createTestAccount('bob')
  const result = auth.login('bob', 'wrongpass')
  eq(result.ok, false, 'ok')
  eq(result.error, 'Invalid username or password', 'error')
})

await test('login rejects disabled account', async () => {
  accounts.setAuthRequired(true)
  const pw = auth.hashPassword('testpass')
  await accounts.insertAccount({
    id: randomUUID(), username: 'charlie', role: 'user',
    passwordHash: pw.passwordHash, passwordSalt: pw.passwordSalt,
    apiKeyHash: 'def456', apiKeyPrefix: 'def45678',
    createdAt: now(), updatedAt: now(), createdBy: null, status: 'disabled',
  })
  const result = auth.login('charlie', 'testpass')
  eq(result.ok, false, 'ok')
  eq(result.error, 'This account has been disabled', 'error')
})

await test('logout revokes session', async () => {
  await createTestAccount('dave')
  const { token } = auth.login('dave', 'testpass')
  const req = { socket: { remoteAddress: '10.0.0.1' }, headers: { authorization: `Bearer ${token}` } }
  eq(auth.authenticate(req).ok, true, 'before logout')
  auth.logout({ headers: { authorization: `Bearer ${token}` } })
  eq(auth.authenticate(req).ok, false, 'after logout')
})

await test('revokeSessionsForAccount invalidates all sessions', async () => {
  await createTestAccount('user1', 'user')
  const user1Token = auth.login('user1', 'testpass').token
  const user1Record = await accounts.findByUsername('user1')
  auth.revokeSessionsForAccount(user1Record.id)
  const after = auth.authenticate({
    socket: { remoteAddress: '10.0.0.1' },
    headers: { authorization: `Bearer ${user1Token}` },
  })
  eq(after.ok, false, 'ok')
})

await test('role hierarchy: owner can create admin and user', async () => {
  await createTestAccount('owner', 'owner')
  const ownerLogin = auth.login('owner', 'testpass')
  const caller = { id: ownerLogin.user.id, tier: 'owner' }
  eq(auth.createAccount(caller, { username: 'admin1', password: 'adminpass', role: 'admin' }).ok, true, 'admin')
  eq(auth.createAccount(caller, { username: 'user1', password: 'userpass', role: 'user' }).ok, true, 'user')
})

await test('role hierarchy: admin can create user but not admin', async () => {
  await createTestAccount('owner', 'owner')
  await createTestAccount('admin', 'admin')
  const adminLogin = auth.login('admin', 'testpass')
  const caller = { id: adminLogin.user.id, tier: 'admin' }
  eq(auth.createAccount(caller, { username: 'user1', password: 'userpass', role: 'user' }).ok, true, 'user')
  eq(auth.createAccount(caller, { username: 'admin2', password: 'adminpass', role: 'admin' }).ok, false, 'admin')
})

await test('role hierarchy: user cannot create any account', async () => {
  await createTestAccount('regular', 'user')
  const userLogin = auth.login('regular', 'testpass')
  const result = auth.createAccount(
    { id: userLogin.user.id, tier: 'user' },
    { username: 'newuser', password: 'pass', role: 'user' }
  )
  eq(result.ok, false, 'ok')
})

await test('password hashing uses scrypt and verification is timing-safe', () => {
  const pw = auth.hashPassword('secret')
  assert(pw.passwordHash !== undefined, 'no hash')
  assert(pw.passwordSalt !== undefined, 'no salt')
  eq(pw.passwordHash.length, 128, 'hash length (64 bytes = 128 hex chars)')
  eq(auth.verifyPassword('secret', pw.passwordHash, pw.passwordSalt), true, 'right password')
  eq(auth.verifyPassword('wrong', pw.passwordHash, pw.passwordSalt), false, 'wrong password')
})

await test('API key generation produces unique keys with rst_ prefix', () => {
  const key1 = auth.generateApiKey()
  const key2 = auth.generateApiKey()
  eq(key1.startsWith('rst_'), true, 'rst_ prefix')
  assert(key1 !== key2, 'two keys were equal')
  assert(auth.hashApiKey(key1) !== undefined, 'no hash')
  assert(auth.hashApiKey(key1) !== auth.hashApiKey(key2), 'two hashes were equal')
})

await test('createOwner rejects duplicate owners', async () => {
  await createTestAccount('existing', 'owner')
  const result = auth.createOwner({ username: 'newowner', password: 'pass' })
  eq(result.ok, false, 'ok')
  eq(result.error, 'An owner account already exists', 'error')
})

// ---------------------------------------------------------------------------
// The File System capability is served by @modelcontextprotocol/server-filesystem
// as a stdio child; tool behavior is covered end-to-end at the service boundary
// by test-mcp-capabilities.mjs + test-provider-conformance.mjs. What is tested
// here is OUR half of the defense-in-depth: containmentError, the gate every
// path argument passes through before a call reaches the child.
console.log('\n-- filesystem provider containment gate --')

const rootDir = path.join(TEST_DIR, 'workspace')
function makeWorkspace() {
  fs.mkdirSync(path.join(rootDir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(rootDir, 'README.md'), '# Hello\n')
}
const gate = (args, root = rootDir) => containmentError(root, args)
const gateTest = (name, fn) => test(name, fn, makeWorkspace)

console.log('   contained paths pass')
await gateTest('allows a relative path inside the root', async () => {
  eq(await gate({ path: 'README.md' }), null, 'gate')
})
await gateTest('allows nested relative paths', async () => {
  eq(await gate({ path: 'src/index.ts' }), null, 'gate')
})
await gateTest('allows an absolute path inside the root', async () => {
  eq(await gate({ path: path.join(rootDir, 'README.md') }), null, 'gate')
})
await gateTest('allows a paths array where every entry is contained', async () => {
  eq(await gate({ paths: ['README.md', 'src/index.ts'] }), null, 'gate')
})
await gateTest('ignores non-path arguments entirely', async () => {
  eq(await gate({ content: '../../etc/passwd', pattern: 'C:/Windows', dryRun: true }), null, 'gate')
})
await gateTest('ignores non-string values under path keys', async () => {
  eq(await gate({ path: 42, source: null, paths: [7, true] }), null, 'gate')
})
await gateTest('returns null for missing or non-object args', async () => {
  eq(await gate(null), null, 'null args')
  eq(await gate(undefined), null, 'undefined args')
})

console.log('   escapes are blocked')
async function expectBlocked(args) {
  const result = await gate(args)
  assert(result !== null, `not blocked: ${JSON.stringify(args)}`)
  eq(result.isError, true, 'isError')
  assert(result.content[0].text.includes('outside'), `error text lacks "outside": ${result.content[0].text}`)
}
await gateTest('blocks ../ traversal in path', () => expectBlocked({ path: '../../etc/passwd' }))
await gateTest('blocks traversal hidden mid-path', () => expectBlocked({ path: 'src/../../outside.txt' }))
await gateTest('blocks absolute paths outside the root', () =>
  expectBlocked({ path: path.join(TEST_DIR, 'outside-root', 'file.txt') }))
// Drive-qualification is a Windows concept. path.resolve treats "C:/..." as
// absolute there, so it escapes the root and must be refused. On POSIX a
// colon is an ordinary filename character, so the identical string is a
// relative path that genuinely lives inside the root — asserting a block
// there would be asserting a bug. Production is Windows and CI is Linux, so
// both halves are pinned rather than skipping one platform.
await gateTest('refuses a drive-qualified path on win32, treats it as contained on posix', async () => {
  const args = { path: 'C:/Windows/system.ini' }
  if (process.platform === 'win32') await expectBlocked(args)
  else eq(await gate(args), null, 'gate')
})
await gateTest('blocks escapes via move_file source and destination', async () => {
  await expectBlocked({ source: '../../etc/passwd', destination: 'copy.txt' })
  await expectBlocked({ source: 'README.md', destination: '../../exfil.txt' })
})
await gateTest('blocks a paths array where any one entry escapes', () =>
  expectBlocked({ paths: ['README.md', '../../etc/passwd'] }))
await gateTest('reports every offending path in the error text', async () => {
  const result = await gate({ source: '../a.txt', destination: '../b.txt' })
  assert(result !== null, 'not blocked')
  eq(result.isError, true, 'isError')
  assert(result.content[0].text.includes('../a.txt'), 'error text lacks ../a.txt')
  assert(result.content[0].text.includes('../b.txt'), 'error text lacks ../b.txt')
})
await gateTest('blocks symlink escape (if symlink exists)', async () => {
  fs.mkdirSync(path.join(TEST_DIR, 'outside-symlink'), { recursive: true })
  try {
    fs.symlinkSync(path.join(TEST_DIR, 'outside-symlink'), path.join(rootDir, 'symlink-out'))
  } catch {
    return 'skipped: symlink creation needs privileges here'
  }
  await expectBlocked({ path: 'symlink-out/README.md' })
})

console.log('   config faults throw (setup error, not treated as attack)')
await gateTest('throws when no root is configured', async () => {
  let threw = false
  try { await gate({ path: 'README.md' }, null) } catch { threw = true }
  assert(threw, 'no throw with a null root')
})

// ---------------------------------------------------------------------------
console.log('\n-- gateway /files/download endpoint --')

// The port the vitest file used. test:security runs suites one at a time, so
// it no longer collides with anything (it used to clash when this case ran
// in chat-ui's vitest at the same time as the chain).
const TEST_PORT = 19999
await gw.startGateway(TEST_PORT, {
  fileSystem: { enabled: true, rootDir: path.join(TEST_DIR, 'workspace') },
  // Documents has its own root: create_document writes here, and a browser
  // client must be able to download what it produced.
  documents: { enabled: true, outputDir: path.join(TEST_DIR, 'docs-out') },
  webFetch: { enabled: false },
})
const gatewayPort = gw.getGatewayPort(TEST_PORT)
let authToken

async function downloadSetup() {
  const owner = auth.createOwner({ username: 'dladmin', password: 'dlpass' })
  eq(owner.ok, true, 'createOwner ok')
  const login = auth.login('dladmin', 'dlpass')
  eq(login.ok, true, 'login ok')
  authToken = login.token

  // The endpoint serves each account its OWN folder inside the configured
  // roots rather than the roots themselves, so fixtures go where the tools
  // write. The folder name is derived from the account, so ask the same helper
  // the endpoint uses instead of hardcoding the slug.
  const account = { id: owner.account.id, username: 'dladmin' }

  // The capability roots themselves still have to exist — containment is
  // resolved against the real path of the root, so a missing one is a config
  // error rather than an empty folder.
  fs.mkdirSync(path.join(TEST_DIR, 'workspace'), { recursive: true })
  fs.mkdirSync(path.join(TEST_DIR, 'docs-out'), { recursive: true })

  const workspace = resolveUserRoot(path.join(TEST_DIR, 'workspace'), account, { create: true })
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Hello\n\nThis is a test file.\n')
  const docsOut = resolveUserRoot(path.join(TEST_DIR, 'docs-out'), account, { create: true })
  fs.writeFileSync(path.join(docsOut, 'purchase-log.md'), '# Purchase Log\n\nCreated by create_document.\n')
}
const dlTest = (name, fn) => test(name, fn, downloadSetup)
const authFetch = (p) =>
  fetch(`http://127.0.0.1:${gatewayPort}${p}`, { headers: { Authorization: `Bearer ${authToken}` } })

try {
  await test('the gateway binds the requested port', () => eq(gatewayPort, TEST_PORT, 'port'))

  await dlTest('requires authentication', async () => {
    const res = await fetch(`http://127.0.0.1:${gatewayPort}/files/download?path=README.md`)
    eq(res.status, 401, 'status')
  })
  await dlTest('rejects missing path parameter', async () => {
    eq((await authFetch('/files/download')).status, 400, 'status')
  })
  await dlTest('blocks paths outside the root', async () => {
    eq((await authFetch('/files/download?path=../../etc/passwd')).status, 403, 'status')
  })
  await dlTest('streams an existing file with auth', async () => {
    const res = await authFetch('/files/download?path=README.md')
    eq(res.status, 200, 'status')
    eq(res.headers.get('content-type'), 'application/octet-stream', 'content-type')
    assert(res.headers.get('content-disposition').includes('README.md'), 'content-disposition lacks README.md')
    assert((await res.text()).includes('# Hello'), 'body lacks # Hello')
  })
  // A document created by create_document lives under the documents root, not
  // the file-system root. Serving only the latter made every created document
  // undownloadable from a browser client.
  await dlTest('streams a file from the documents folder', async () => {
    const res = await authFetch('/files/download?path=purchase-log.md')
    eq(res.status, 200, 'status')
    assert(res.headers.get('content-disposition').includes('purchase-log.md'), 'content-disposition')
    assert((await res.text()).includes('Created by create_document'), 'body')
  })
  await dlTest('404s a contained path with no file behind it', async () => {
    eq((await authFetch('/files/download?path=no-such-file.md')).status, 404, 'status')
  })
} finally {
  gw.stopGateway()
}

fs.rmSync(TEST_DIR, { recursive: true, force: true })
fs.rmSync(TEST_DIR + '-capabilities', { recursive: true, force: true })

const passed = results.filter(r => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
