// =============================================================================
// The control plane — who reaches it, and what it serves without auth.
// =============================================================================
// Phase 2 of docs/notes/headless-admin-plane-implementation.md. The admin
// listener is an always-on, LAN-bindable surface that will shortly be able to
// spawn processes, so the four properties below are the ones that must not be
// allowed to rot:
//
//   1. EVERY non-asset route refuses an anonymous caller and a non-owner.
//      Including routes that do not exist — the gate runs before the route
//      table, so a route added later is gated by default.
//
//   2. `authRequired: false` does NOT open the control plane. That toggle
//      governs the data plane only (plan decision 12). Note the check has two
//      halves and both matter: auth-off must not let a stranger IN, and it must
//      not lock the owner OUT either.
//
//   3. The static allowlist serves exactly the files Nest shipped. Not a URL
//      pattern — isPublicAsset() in tools-gateway.mjs is a proxy rule for
//      someone else's namespace and must never be reached for here (trap 5.4).
//      Traversal is checked as a property of the mechanism, not of a filter.
//
//   4. The listener answers BEFORE any llama:launch has happened. This is the
//      whole reason it exists as a separate listener; if it ever regresses to
//      the gateway's lifecycle, everything above becomes moot.
//
// Plus two rules that hang off the same plane: the port reservation that keeps
// a user-settable config.port from taking the control plane's socket, and the
// exposure rule that decides whether this box announces itself on the network
// at all now that discovery starts with the daemon rather than with a launch.
//
// Run:  node scripts/test-admin-listener.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as net from 'node:net'
import * as path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-admin-test-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir

register('./auth-test-loader.mjs', import.meta.url)

// Explicit, main-thread trigger for the stub's platform-paths.mjs
// initialization. module.register() hooks run in a separate worker thread, so a
// side effect inside auth-test-loader.mjs itself can't reach this thread's copy
// of platform-paths.mjs -- only an ordinary import, resolved here in the main
// thread, can.
await import('./electron-stub.mjs')

const {
  startAdminListener,
  stopAdminListener,
  buildStaticAllowlist,
  bindHostRejection,
  isLoopbackBind,
  getAdminListenerState,
  DEFAULT_ADMIN_BIND_HOST,
} = await import('../electron/main/admin-listener.mjs')
const { mayAccessControlPlane } = await import('../electron/main/permissions.mjs')
const { serverPortRejection } = await import('../electron/main/ipc/validate.mjs')
const { ADMIN_PORT, BEACON_PORT, DEFAULT_GATEWAY_PORT } = await import('../electron/main/ports.mjs')
const { discoveryPlan, lastKnownDiscovery, discoveryRecordFor, stopDiscovery } = await import('../electron/main/discovery.mjs')
const { getControlPlane, setControlPlaneBindHost, resolveStartupReconciliation, getStartupSettings, setStartupSettings, reconcileStartupSetting, shutdown } = await import('../electron/main/ipc/admin.mjs')
const { setLoginItems, getLoginItems } = await import('../electron/main/desktop-integration.mjs')
const { app: electronAppStub } = await import('electron')
const { buildAdminApi } = await import('../electron/main/admin/api-table.mjs')
const { setAdminApi, pathForChannel } = await import('../electron/main/admin/api-routes.mjs')
const {
  authenticateControlPlane, login, createOwner, createAccount, setAuthRequired,
  CONTROL_PLANE, DATA_PLANE,
} = await import('../electron/main/auth.mjs')

const ADMIN_TEST_PORT = 48383 // well clear of the real 19083
const admin = `http://127.0.0.1:${ADMIN_TEST_PORT}`

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

const bearer = token => ({ Authorization: `Bearer ${token}` })

// ---------------------------------------------------------------------------
// Accounts. One of each tier, so "owner only" is checked against the tiers that
// are genuinely close to it rather than only against a stranger.
// ---------------------------------------------------------------------------

const ownerResult = createOwner({ username: 'owner', password: 'owner-pw-1234' })
if (!ownerResult.ok) throw new Error(`could not create the owner: ${ownerResult.error}`)
const ownerAccount = ownerResult.account
const ownerApiKey = ownerResult.apiKey

const adminResult = createAccount(ownerAccount, { username: 'admin', password: 'admin-pw-1234', tier: 'admin' })
if (!adminResult.ok) throw new Error(`could not create the admin: ${adminResult.error}`)

const userResult = createAccount(ownerAccount, { username: 'user', password: 'user-pw-1234', tier: 'user' })
if (!userResult.ok) throw new Error(`could not create the user: ${userResult.error}`)

// Sessions are bound to a plane at creation, so a control-plane test needs
// control-plane sessions. The data-plane one below is not a stray: an owner who
// logs into the chat UI must NOT thereby hold process control, and that is a
// property with its own check further down.
function sessionFor(username, password, plane = CONTROL_PLANE) {
  const result = login(username, password, plane)
  if (!result.ok) throw new Error(`login failed for ${username}: ${result.error}`)
  return result.token
}

const ownerToken = sessionFor('owner', 'owner-pw-1234')
const adminToken = sessionFor('admin', 'admin-pw-1234')
const userToken = sessionFor('user', 'user-pw-1234')
const ownerChatToken = sessionFor('owner', 'owner-pw-1234', DATA_PLANE)

// ---------------------------------------------------------------------------
// 1. The authorization rule itself
// ---------------------------------------------------------------------------

console.log('\n-- mayAccessControlPlane --')

await test('🔍 the owner is let in', () => {
  assert(mayAccessControlPlane({ tier: 'owner' }) === true, 'owner refused')
})

await test('🔍 an admin-tier account is NOT the control plane', () => {
  assert(mayAccessControlPlane({ tier: 'admin' }) === false, 'admin tier reached the control plane')
  return 'plane separation, not the admin/user hierarchy'
})

await test('🔍 a user, an unknown tier, null and undefined are all refused', () => {
  for (const account of [{ tier: 'user' }, { tier: 'root' }, { tier: '' }, {}, null, undefined]) {
    assert(mayAccessControlPlane(account) === false, `let in: ${JSON.stringify(account)}`)
  }
  return 'null included — auth-off resolves to null, and must not fail open here'
})

// ---------------------------------------------------------------------------
// 2. The credential the control plane accepts
// ---------------------------------------------------------------------------

console.log('\n-- authenticateControlPlane --')

// Node lowercases incoming header names before a handler ever sees them, so a
// fake request that does not is testing a shape the server can never receive.
const reqWith = (headers = {}) => ({
  headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
})

await test('🔍 an owner SESSION is accepted', () => {
  const result = authenticateControlPlane(reqWith(bearer(ownerToken)))
  assert(result.ok && result.account?.tier === 'owner', `refused the owner's session: ${JSON.stringify(result)}`)
})

await test("🔍 the owner's CHAT session is refused — the gateway cannot mint admin access", () => {
  const result = authenticateControlPlane(reqWith(bearer(ownerChatToken)))
  assert(!result.ok, 'a data-plane session opened the control plane')
  return 'only this listener mints control-plane sessions (plan §3.6)'
})

await test("🔍 the owner's API KEY is refused — it lives in tool-client config files", () => {
  const result = authenticateControlPlane(reqWith(bearer(ownerApiKey)))
  assert(!result.ok, 'an account-wide API key opened the control plane')
  return 'sessions only (plan decision 18)'
})

await test('no token, a junk token and a malformed header are all refused', () => {
  for (const headers of [{}, bearer('nonsense'), { authorization: 'Basic abc' }, { authorization: 'Bearer' }]) {
    assert(!authenticateControlPlane(reqWith(headers)).ok, `accepted: ${JSON.stringify(headers)}`)
  }
})

await test('🔍 authRequired: false neither opens the plane NOR locks the owner out', () => {
  setAuthRequired(false)
  try {
    assert(!authenticateControlPlane(reqWith({})).ok, 'auth-off let an anonymous caller into the control plane')
    const owner = authenticateControlPlane(reqWith(bearer(ownerToken)))
    assert(owner.ok && owner.account?.tier === 'owner', 'auth-off locked the owner out of their own control plane')
    return 'both halves'
  } finally {
    setAuthRequired(true)
  }
})

// ---------------------------------------------------------------------------
// 3. Port reservation
// ---------------------------------------------------------------------------

console.log('\n-- config.port may not take a port Nest already owns --')

await test('🔍 the admin listener\'s own port is refused', () => {
  assert(serverPortRejection(ADMIN_PORT) !== null, `${ADMIN_PORT} was accepted as config.port`)
})

await test('🔍 a port whose +1/+2 family lands on the admin port is refused', () => {
  for (const port of [ADMIN_PORT - 1, ADMIN_PORT - 2]) {
    const rejection = serverPortRejection(port)
    assert(rejection !== null, `${port} was accepted, but its family claims ${ADMIN_PORT}`)
    assert(rejection.includes(String(ADMIN_PORT)), `the message does not name the collision: ${rejection}`)
  }
  return 'the family, not just the base'
})

await test('the beacon port and its family are refused too', () => {
  for (const port of [BEACON_PORT, BEACON_PORT - 1, BEACON_PORT - 2]) {
    assert(serverPortRejection(port) !== null, `${port} was accepted, but its family claims ${BEACON_PORT}`)
  }
})

await test('the default and other ordinary ports are accepted', () => {
  for (const port of [19080, 80, 8080, 3000, 65533]) {
    assert(serverPortRejection(port) === null, `${port} was refused: ${serverPortRejection(port)}`)
  }
})

await test('a non-integer, a negative and an out-of-range port are refused', () => {
  for (const port of [undefined, null, 'x', 1.5, 0, -1, 70000, 65534]) {
    assert(serverPortRejection(port) !== null, `${JSON.stringify(port)} was accepted as config.port`)
  }
  return '65534 too — its MCP port would be 65536'
})

// ---------------------------------------------------------------------------
// 4. Bind address
// ---------------------------------------------------------------------------

console.log('\n-- bind address --')

await test('🔍 the default bind is loopback — exposure is opt-in', () => {
  assert(isLoopbackBind(DEFAULT_ADMIN_BIND_HOST), `default bind ${DEFAULT_ADMIN_BIND_HOST} is not loopback`)
})

await test('loopback, wildcard and a literal LAN address are accepted', () => {
  for (const host of ['127.0.0.1', '::1', 'localhost', '0.0.0.0', '::', '192.168.1.50', 'fe80::1']) {
    assert(bindHostRejection(host) === null, `${host} refused: ${bindHostRejection(host)}`)
  }
})

await test('🔍 a hostname is refused — exposure must be stated, not resolved', () => {
  for (const host of ['redstart.local', 'example.com', '', '   ', null, 42]) {
    assert(bindHostRejection(host) !== null, `${JSON.stringify(host)} was accepted as a bind address`)
  }
})

// ---------------------------------------------------------------------------
// 5. Discovery exposure
// ---------------------------------------------------------------------------
// The port-80 clean URL starts with the DAEMON, not with llama:launch — a box
// that has never launched a model used to advertise nothing, which is the
// cold-start case an appliance ships in. Phase 6.5 retired mDNS and with it
// the union-of-two-planes rule (design decision 17 is now half-void — see
// docs/notes/headless-admin-plane-implementation.md §6.5.3): what decides
// whether it runs is networkMode alone.

console.log('\n-- discovery exposure --')

await test('🔍 network mode on runs the clean-URL proxy', () => {
  const plan = discoveryPlan({ networkMode: true })
  assert(plan.advertise === true, "today's desktop install stopped advertising")
  assert(plan.reason === 'data-plane', `reason was ${plan.reason}`)
})

await test('🔍 network mode off runs nothing', () => {
  const plan = discoveryPlan({ networkMode: false })
  assert(plan.advertise === false, 'a loopback-only box ran the clean-URL proxy')
})

await test('🔍 a machine that has never launched has no reason to advertise', () => {
  const fresh = lastKnownDiscovery({})
  assert(fresh.networkMode === false, 'an unlaunched box inherited networkMode: true from a default nobody chose')
  assert(discoveryPlan(fresh).advertise === false, 'a fresh install advertised itself')
  return 'additive for existing installs'
})

await test('a launch record round-trips through settings.json', () => {
  const record = discoveryRecordFor({ networkMode: true, port: 19080 })
  const read = lastKnownDiscovery({ discovery: record })
  assert(JSON.stringify(read) === JSON.stringify(record), `${JSON.stringify(read)} != ${JSON.stringify(record)}`)
})

await test('a malformed stored record falls back to defaults rather than throwing', () => {
  for (const discovery of [null, 'yes', { networkMode: 'true', gatewayPort: '19080' }]) {
    const read = lastKnownDiscovery({ discovery })
    assert(read.networkMode === false, `${JSON.stringify(discovery)} read as networkMode true`)
    assert(read.gatewayPort === DEFAULT_GATEWAY_PORT, `port read as ${read.gatewayPort}`)
  }
})

// ---------------------------------------------------------------------------
// 6. The static allowlist
// ---------------------------------------------------------------------------

console.log('\n-- static allowlist --')

// A stand-in bundle: the shape of a Vite build, plus the two things that must
// NOT be served — a non-web file the build dropped in, and a file one level up
// that only a traversal could reach.
const bundleParent = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-bundle-'))
const bundleDir = path.join(bundleParent, 'dist')
fs.mkdirSync(path.join(bundleDir, 'assets'), { recursive: true })
fs.writeFileSync(path.join(bundleDir, 'index.html'), '<!doctype html><title>launcher</title>')
fs.writeFileSync(path.join(bundleDir, 'assets', 'index-abc123.js'), 'console.log(1)')
fs.writeFileSync(path.join(bundleDir, 'assets', 'index-abc123.css'), 'body{}')
fs.writeFileSync(path.join(bundleDir, 'favicon.ico'), 'icon')
fs.writeFileSync(path.join(bundleDir, '.env'), 'SECRET=hunter2')
fs.writeFileSync(path.join(bundleParent, 'accounts.json'), '{"owner":"secret"}')

const allowlist = buildStaticAllowlist(bundleDir)

await test('🔍 it is the enumerated bundle, not a URL pattern', () => {
  const served = [...allowlist.keys()].sort()
  const expected = ['/', '/assets/index-abc123.css', '/assets/index-abc123.js', '/favicon.ico', '/index.html']
  assert(
    JSON.stringify(served) === JSON.stringify(expected),
    `allowlist is ${JSON.stringify(served)}, expected ${JSON.stringify(expected)}`,
  )
  return `${served.length} entries, / mapped to index.html`
})

await test('🔍 a non-web file sitting in the bundle is not served', () => {
  assert(!allowlist.has('/.env'), '.env is in the allowlist')
})

await test('🔍 traversal is structurally impossible, not filtered', () => {
  for (const attempt of [
    '/../accounts.json',
    '/assets/../../accounts.json',
    '/..%2Faccounts.json',
    '/index.html/../../accounts.json',
    '//accounts.json',
  ]) {
    assert(!allowlist.has(attempt), `${attempt} resolved to a file`)
  }
  // The real claim: every VALUE in the map is inside the bundle, so there is no
  // key at all — reachable or not — that escapes it.
  for (const abs of allowlist.values()) {
    assert(path.resolve(abs).startsWith(path.resolve(bundleDir)), `${abs} is outside the bundle`)
  }
  return 'every value is inside the bundle root'
})

await test('an unbuilt tree yields an empty allowlist rather than an error', () => {
  const empty = buildStaticAllowlist(path.join(bundleParent, 'no-such-dir'))
  assert(empty.size === 0, `expected 0 entries, got ${empty.size}`)
})

// ---------------------------------------------------------------------------
// 7. The listener, over real sockets
// ---------------------------------------------------------------------------

console.log('\n-- the listener --')

// Nothing has called llama:launch in this process, and nothing will. Every
// check below therefore also asserts property 4: the control plane answers with
// no llama-server, no gateway and no profile in existence.
await startAdminListener({ bindHost: '127.0.0.1', port: ADMIN_TEST_PORT })

async function get(urlPath, headers = {}) {
  return fetch(`${admin}${urlPath}`, { headers })
}

async function post(urlPath, args, headers = {}) {
  return fetch(`${admin}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ args }),
  })
}

await test('🔍 it answers before any llama:launch has happened', async () => {
  const res = await get('/admin/whoami', bearer(ownerToken))
  assert(res.status === 200, `expected 200, got ${res.status}`)
  const body = await res.json()
  assert(body.user?.tier === 'owner', `unexpected body: ${JSON.stringify(body)}`)
  return 'no gateway, no model, no profile'
})

await test('🔍 an anonymous caller is refused', async () => {
  const res = await get('/admin/whoami')
  assert(res.status === 401, `expected 401, got ${res.status}`)
})

await test('🔍 an admin-tier session is refused (403, authenticated but not owner)', async () => {
  const res = await get('/admin/whoami', bearer(adminToken))
  assert(res.status === 403, `expected 403, got ${res.status}`)
})

await test('🔍 a user-tier session is refused', async () => {
  const res = await get('/admin/whoami', bearer(userToken))
  assert(res.status === 403, `expected 403, got ${res.status}`)
})

await test("🔍 the owner's API key does not work over HTTP either", async () => {
  const res = await get('/admin/whoami', bearer(ownerApiKey))
  assert(res.status === 401, `expected 401, got ${res.status}`)
})

await test('🔍 routes that do not exist are gated too — 401 before 404', async () => {
  for (const urlPath of ['/admin/api/launch', '/admin', '/nope', '/admin/api/accounts']) {
    const res = await get(urlPath)
    assert(res.status === 401, `${urlPath} answered ${res.status} to an anonymous caller`)
  }
  // And an authenticated owner gets the honest 404, so the 401 above is the
  // gate talking and not a missing route by accident.
  const owner = await get('/admin/nope', bearer(ownerToken))
  assert(owner.status === 404, `expected 404 for the owner, got ${owner.status}`)
  return 'the route table is not public information'
})

await test('🔍 authRequired: false does not open the listener', async () => {
  setAuthRequired(false)
  try {
    const anon = await get('/admin/whoami')
    assert(anon.status === 401, `auth-off let an anonymous caller in with ${anon.status}`)
    const owner = await get('/admin/whoami', bearer(ownerToken))
    assert(owner.status === 200, `auth-off locked the owner out with ${owner.status}`)
    return 'the data plane toggle does not reach here'
  } finally {
    setAuthRequired(true)
  }
})

await test('\u{1F50D} the served document carries a CSP, and the assets do not need one', async () => {
  const doc = await fetch(`${admin}/`)
  const csp = doc.headers.get('content-security-policy')
  assert(csp, 'the admin page was served with no Content-Security-Policy')
  for (const directive of ["default-src 'self'", "script-src 'self'", "connect-src 'self'", "frame-ancestors 'none'"]) {
    assert(csp.includes(directive), `the policy is missing ${directive}: ${csp}`)
  }
  assert(!/script-src[^;]*unsafe-inline/.test(csp), "script-src allows 'unsafe-inline'")

  // Not on the assets: a policy on a .js response governs nothing, and putting
  // one there invites the two to drift into disagreeing.
  const asset = await fetch(`${admin}/assets/index-abc123.js`)
  assert(asset.headers.get('content-security-policy') === null, 'an asset carried its own policy')
  return 'stricter than the Electron window: no inline script at all'
})

await test('no CORS headers — this listener serves its own origin only', async () => {
  const res = await get('/admin/whoami', bearer(ownerToken))
  const allow = res.headers.get('access-control-allow-origin')
  assert(allow === null, `the control plane sent Access-Control-Allow-Origin: ${allow}`)
})

await test('the exposure state the UI warns from is reported', () => {
  const state = getAdminListenerState()
  assert(state.running === true, 'listener reports itself as not running')
  assert(state.exposed === false, 'a loopback bind reported itself as exposed')
  assert(state.port === ADMIN_TEST_PORT, `reported port ${state.port}`)
})

// ---------------------------------------------------------------------------
// 8. Changing where the control plane is bound
// ---------------------------------------------------------------------------
// An admin changing this may be doing it to recover access, so it rebinds
// immediately rather than at next start. The ordering is the part worth
// pinning: bind first, persist second, and restore the previous address if the
// new one cannot be bound — a setting saved for an unbindable address would be
// read back at every boot and fail every time, leaving the box with no control
// plane and a log line to explain it.

console.log('\n-- rebinding the control plane --')

let storedSettings = {}
const settingsDeps = {
  readSettings: () => JSON.parse(JSON.stringify(storedSettings)),
  writeSettings: (data) => { storedSettings = JSON.parse(JSON.stringify(data)) },
}

// admin:set-bind-host is a one-line wrapper around setControlPlaneBindHost()
// (ipc/admin.mjs), so the function-level tests below cover its real behaviour
// (success, failure-restore, persistence, exposure). What they don't reach is
// the dispatcher in front of it — the same table AccountsPanel.tsx's exposure
// toggle actually calls through. Wired up once, here, rather than in
// scripts/test-admin-api.mjs, which deliberately never invokes a mutating
// handler against the shared listener its own gate tests depend on.
setAdminApi(buildAdminApi(settingsDeps))

await test('🔍 the exposure toggle works end to end, through the real dispatcher', async () => {
  const res = await post(pathForChannel('admin:set-bind-host'), ['0.0.0.0'], bearer(ownerToken))
  assert(res.status === 200, `expected 200, got ${res.status}`)
  const body = await res.json()
  assert(body.result?.ok === true, `rebind via HTTP failed: ${JSON.stringify(body)}`)
  assert(body.result.state.exposed === true, 'rebinding via HTTP did not report itself as exposed')
  assert(getControlPlane().bindHost === '0.0.0.0', `the listener is bound to ${getControlPlane().bindHost}`)
  // Restore before the function-level tests below assume their own starting
  // state — including storedSettings itself, which "an invalid address is
  // refused" (next) asserts starts undefined.
  const restore = await setControlPlaneBindHost('127.0.0.1', settingsDeps)
  assert(restore.ok === true, `could not restore loopback: ${restore.error}`)
  storedSettings = {}
  return 'AccountsPanel.tsx\'s toggle calls exactly this path'
})

await test('an invalid address is refused and nothing is persisted', async () => {
  const result = await setControlPlaneBindHost('redstart.local', settingsDeps)
  assert(result.ok === false, 'a hostname was accepted as a bind address')
  assert(storedSettings.adminBindHost === undefined, 'a rejected address was written to settings')
  assert(getControlPlane().bindHost === '127.0.0.1', `the listener moved to ${getControlPlane().bindHost}`)
})

await test('🔍 a valid address rebinds immediately and is persisted', async () => {
  const result = await setControlPlaneBindHost('0.0.0.0', settingsDeps)
  assert(result.ok === true, `rebind failed: ${result.error}`)
  assert(storedSettings.adminBindHost === '0.0.0.0', `settings hold ${storedSettings.adminBindHost}`)
  assert(result.state.exposed === true, 'a wildcard bind did not report itself as exposed')
  assert(result.state.port === ADMIN_TEST_PORT, `the rebind moved the port to ${result.state.port}`)
  return 'the port travels with the address'
})

await test('🔍 an address this host cannot bind restores the previous one', async () => {
  // TEST-NET-3 (RFC 5737). Not assigned to any interface here, so listen()
  // fails — which is the case that must not leave the box unreachable.
  const result = await setControlPlaneBindHost('203.0.113.1', settingsDeps)
  assert(result.ok === false, 'binding an address this host does not have reported success')
  assert(getControlPlane().running === true, 'a failed rebind left the control plane down')
  assert(getControlPlane().bindHost === '0.0.0.0', `restored to ${getControlPlane().bindHost}, expected the previous 0.0.0.0`)
  assert(storedSettings.adminBindHost === '0.0.0.0', `a failed rebind persisted ${storedSettings.adminBindHost}`)
  return 'bind first, persist second'
})

await test('moving back to loopback clears the exposure', async () => {
  const result = await setControlPlaneBindHost('127.0.0.1', settingsDeps)
  assert(result.ok === true, `rebind failed: ${result.error}`)
  assert(result.state.exposed === false, 'loopback still reported as exposed')
})

console.log('\n-- 🔍 start-at-login, through the real dispatcher --')

await test('🔍 admin:set-startup works end to end, through the real dispatcher', async () => {
  const res = await post(pathForChannel('admin:set-startup'), [true], bearer(ownerToken))
  assert(res.status === 200, `expected 200, got ${res.status}`)
  const body = await res.json()
  assert(body.result?.startAtLogin === true, `unexpected result: ${JSON.stringify(body)}`)
  // The OS side actually changed — not just the returned value.
  assert(electronAppStub.getLoginItemSettings().openAtLogin === true, 'the OS login item was not updated')
  assert(storedSettings.startAtLogin === true, 'settings.json was not updated')
})

await test('🔍 admin:get-startup reads back what the OS says, not a cached value', async () => {
  // Simulate "turned off from Task Manager's Startup tab behind Nest's back" —
  // the OS record changes with nothing going through setStartupSettings().
  electronAppStub.setLoginItemSettings({ openAtLogin: false, args: ['--background'] })
  const res = await post(pathForChannel('admin:get-startup'), [], bearer(ownerToken))
  assert(res.status === 200, `expected 200, got ${res.status}`)
  const body = await res.json()
  assert(body.result?.startAtLogin === false, `expected the OS's current answer (false), got ${JSON.stringify(body)}`)
})

await test('setStartupSettings(false) turns both halves off', async () => {
  const result = await setStartupSettings(true, settingsDeps) // back to a known state first
  assert(result.startAtLogin === true, 'setup step failed')
  const off = await setStartupSettings(false, settingsDeps)
  assert(off.startAtLogin === false, `expected false, got ${off.startAtLogin}`)
  assert(electronAppStub.getLoginItemSettings().openAtLogin === false, 'the OS login item was not turned off')
  assert(storedSettings.startAtLogin === false, 'settings.json was not turned off')
  assert(getStartupSettings().startAtLogin === false, 'getStartupSettings disagrees with what was just set')
})

// ---------------------------------------------------------------------------
// Phase 8A.5 — the same three functions with NO login item to talk to, which
// is what a headless daemon is. The rule they have to follow is the one §4's
// picker work set: a control that cannot do what it says must SAY so, rather
// than fail quietly downstream or report a value it invented.
// ---------------------------------------------------------------------------

await test('🔒 with no login item, get-startup reports unsupported rather than guessing', async () => {
  const restore = getLoginItems()
  setLoginItems(null)
  try {
    const state = getStartupSettings()
    assert(state.supported === false, 'claimed the login item is supported with none registered')
    assert(state.startAtLogin === false, 'invented a startAtLogin value')
  } finally {
    setLoginItems(restore)
  }
})

await test('🔒 with no login item, set-startup refuses and writes nothing', async () => {
  const restore = getLoginItems()
  const before = storedSettings.startAtLogin
  setLoginItems(null)
  try {
    const result = await setStartupSettings(true, settingsDeps)
    assert(result.supported === false, 'reported success with no login item to set')
    assert(typeof result.error === 'string' && result.error, 'refused without saying why')
    // The refusal must not leave a settings.json key behind that nothing will
    // ever act on — and that a later desktop start would read as an explicit
    // choice an admin made (§7.4's resolveStartupReconciliation treats any
    // stored boolean that way, forever after).
    assert(storedSettings.startAtLogin === before, 'settings.json was written despite the refusal')
  } finally {
    setLoginItems(restore)
  }
})

await test('🔒 with no login item, startup reconciliation is a no-op, not a seed', async () => {
  const restore = getLoginItems()
  setLoginItems(null)
  const seen = []
  try {
    const result = reconcileStartupSetting({
      readSettings: () => { seen.push('read'); return {} },
      writeSettings: () => { seen.push('write') },
    })
    assert(result.supported === false, 'reported a supported login item')
    assert(!seen.includes('write'), 'persisted a login-item preference on a platform with no login item')
  } finally {
    setLoginItems(restore)
  }
})

await test('the desktop path still reports supported: true', async () => {
  assert(getStartupSettings().supported === true, 'the wired login item reported unsupported')
})

console.log('\n-- 🔍 Phase 7 §7.5: deliberate shutdown --')

await test('🔍 admin:shutdown responds ok and calls the deliberate-quit path exactly once', async () => {
  // A dedicated table for this one test — quitApp is index.mjs's own
  // closure in production (isQuitting + a deferred app.quit()), stubbed
  // here as a counter so this suite never actually tries to quit a
  // process. Restored to the shared settingsDeps table afterward so the
  // tests below it see the same deps every other test in this section does.
  let quitCalls = 0
  const shutdownDeps = { ...settingsDeps, quitApp: () => { quitCalls++ } }
  setAdminApi(buildAdminApi(shutdownDeps))
  try {
    const res = await post(pathForChannel('admin:shutdown'), [], bearer(ownerToken))
    assert(res.status === 200, `expected 200, got ${res.status}`)
    const body = await res.json()
    assert(body.result?.ok === true, `unexpected result: ${JSON.stringify(body)}`)
    assert(quitCalls === 1, `expected quitApp() called exactly once, got ${quitCalls}`)
  } finally {
    setAdminApi(buildAdminApi(settingsDeps))
  }
})

await test('admin:shutdown is owner-gated like every other route', async () => {
  const res = await post(pathForChannel('admin:shutdown'), [], {})
  assert(res.status === 401, `expected 401 for an anonymous caller, got ${res.status}`)
})

await test('shutdown() does not throw when deps carries no quitApp', async () => {
  const result = await shutdown({})
  assert(result.ok === true, `expected ok:true even with no quitApp, got ${JSON.stringify(result)}`)
})

// Changing the bind address no longer touches discovery at all (Phase 6.5 —
// setControlPlaneBindHost() used to re-run it because an exposed control
// plane was a reason for mDNS to advertise; with mDNS gone there is nothing
// left for a bind change to trigger). Nothing above this line started
// discovery, so this is belt-and-braces against a stray networkMode:true left
// over from another test in the same process, not a teardown of anything the
// rebinds above actually did.
stopDiscovery()

stopAdminListener()

await test('🔍 the socket is released on stop', async () => {
  const outcome = await new Promise((resolve) => {
    const socket = new net.Socket()
    const finish = (result) => { socket.destroy(); resolve(result) }
    socket.setTimeout(2000)
    socket.once('connect', () => finish('open'))
    socket.once('timeout', () => finish('unreachable'))
    socket.once('error', () => finish('closed'))
    socket.connect(ADMIN_TEST_PORT, '127.0.0.1')
  })
  assert(outcome !== 'open', 'the admin port is still accepting connections after stop')
  return outcome
})

// ---------------------------------------------------------------------------
// Phase 7 §7.4 — startup (start-at-login) reconciliation, pure half
// ---------------------------------------------------------------------------
// resolveStartupReconciliation() is deliberately split from
// reconcileStartupSetting() so the DECISION is testable without Electron —
// the one untestable line is app.setLoginItemSettings() itself, per §7.8.

console.log('\n-- 🔍 startup reconciliation (pure decision) --')

await test('🔍 a fresh install (no stored preference) seeds ON', () => {
  const result = resolveStartupReconciliation({})
  assert(result.startAtLogin === true, `expected true, got ${result.startAtLogin}`)
  assert(result.needsPersist === true, 'a fresh install should be persisted so the seed sticks')
})

await test('🔍 an explicit false is reasserted, not overridden by the on-by-default seed', () => {
  const result = resolveStartupReconciliation({ startAtLogin: false })
  assert(result.startAtLogin === false, `expected false, got ${result.startAtLogin}`)
  assert(result.needsPersist === false, 'an already-stored preference needs no re-persisting')
})

await test('🔍 an explicit true is reasserted the same way', () => {
  const result = resolveStartupReconciliation({ startAtLogin: true })
  assert(result.startAtLogin === true, `expected true, got ${result.startAtLogin}`)
  assert(result.needsPersist === false, 'an already-stored preference needs no re-persisting')
})

await test('a missing settings object behaves like a fresh install, not a throw', () => {
  const result = resolveStartupReconciliation(undefined)
  assert(result.startAtLogin === true, `expected true, got ${result.startAtLogin}`)
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
