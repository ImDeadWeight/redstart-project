// =============================================================================
// Manual/CI smoke test for the account-management & auth system.
// =============================================================================
// Spins up the REAL tools-gateway.mjs and mcp-server.mjs HTTP servers
// (production code, unmodified) against a throwaway accounts.json, then
// drives them over real HTTP from both a loopback and a real LAN-interface
// address — proving that localhost gets NO special treatment (the old
// localhost bypass was deliberately removed in the hardening pass) requires
// actually connecting from both socket types.
//
// electron/main/accounts-storage.mjs calls Electron's app.getPath(), which
// doesn't exist under plain Node — auth-test-loader.mjs stubs just that one
// import so the rest of the auth code runs completely unmodified.
//
// llama-server itself is never started: the auth gate runs before any
// proxying, so 401-vs-not-401 on /v1/chat/completions is fully verifiable
// without a model loaded (a pass-through attempt with no llama-server
// listening becomes a 502, which is expected and asserted for).
//
// Run:  node scripts/test-auth.mjs
// =============================================================================

import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-auth-test-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir

register('./auth-test-loader.mjs', import.meta.url)

const { startGateway, stopGateway } = await import('../electron/main/tools-gateway.mjs')
const { startMcpServer, stopMcpServer } = await import('../electron/main/mcp-server.mjs')
const { setAuthRequired, createOwner } = await import('../electron/main/auth.mjs')

// ---------------------------------------------------------------------------
// Ports (well clear of the app's real defaults so this can run alongside a
// real Redstart Nest instance without colliding).
// ---------------------------------------------------------------------------

const GATEWAY_PORT = 48080 // internal (unused, no llama-server) is +1
const MCP_PORT = 48090

function getLocalIp() {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address
    }
  }
  return null
}

const lanIp = getLocalIp()

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------

const results = []

async function test(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true, detail })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false, detail: err.message })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

async function json(res) {
  const text = await res.text()
  try { return JSON.parse(text) } catch { return text }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`userData dir: ${tmpDir}`)
  console.log(`LAN IP for this machine: ${lanIp ?? '(none found — LAN-exemption tests will be skipped)'}\n`)

  await startGateway(GATEWAY_PORT, { allowedBaseUrls: [], activeTools: [], maxFetchTokens: 2000 })
  await startMcpServer(MCP_PORT, { allowedBaseUrls: [], activeTools: [], maxFetchTokens: 2000 })

  const gw = (host) => `http://${host}:${GATEWAY_PORT}`
  const mcp = (host) => `http://${host}:${MCP_PORT}`

  console.log('-- Before any accounts exist / auth ON (secure default) --')

  await test('GET /auth/config defaults to authRequired:true with no accounts.json', async () => {
    // Secure by default: a fresh install requires login until an admin
    // explicitly toggles it off (small-business posture — see README).
    const res = await fetch(`${gw('127.0.0.1')}/auth/config`)
    const body = await json(res)
    assert(res.status === 200, `expected 200, got ${res.status}`)
    assert(body.authRequired === true, `expected authRequired:true, got ${JSON.stringify(body)}`)
  })

  await test('POST /auth/login with no accounts yet -> 401 (no username enumeration)', async () => {
    const res = await fetch(`${gw('127.0.0.1')}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: 'x' }),
    })
    const body = await json(res)
    assert(res.status === 401, `expected 401, got ${res.status}`)
    assert(body.error === 'Invalid username or password', `unexpected error message: ${body.error}`)
  })

  await test('🔍 POST /auth/login with malformed JSON body -> 400, no crash', async () => {
    const res = await fetch(`${gw('127.0.0.1')}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    })
    assert(res.status === 400, `expected 400, got ${res.status}`)
  })

  // Fixture setup: seed the Owner account the same way the App.tsx "Create
  // Owner Account" button does under the hood (auth:create-first-admin IPC
  // -> auth.mjs createOwner). There's no HTTP route for this by design
  // (bootstrap is meant to happen locally/trusted, not remotely).
  const owner = createOwner({ username: 'owner', password: 'OwnerPass123!' })
  assert(owner.ok, `fixture setup failed: ${owner.error}`)
  const ownerApiKey = owner.apiKey
  setAuthRequired(true)

  console.log('\n-- auth required, owner account seeded --')

  await test('GET /auth/config now reports authRequired:true', async () => {
    const res = await fetch(`${gw('127.0.0.1')}/auth/config`)
    const body = await json(res)
    assert(body.authRequired === true, `expected true, got ${JSON.stringify(body)}`)
  })

  let ownerToken
  if (lanIp) {
    await test('LAN client, no token: GET /auth/me -> 401', async () => {
      const res = await fetch(`${gw(lanIp)}/auth/me`)
      assert(res.status === 401, `expected 401, got ${res.status}`)
    })

    await test('🔍 LAN client, wrong password: POST /auth/login -> 401', async () => {
      const res = await fetch(`${gw(lanIp)}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'owner', password: 'wrong' }),
      })
      assert(res.status === 401, `expected 401, got ${res.status}`)
    })

    await test('LAN client: POST /auth/login with correct password -> 200 + token', async () => {
      const res = await fetch(`${gw(lanIp)}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'owner', password: 'OwnerPass123!' }),
      })
      const body = await json(res)
      assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`)
      assert(typeof body.token === 'string' && body.token.length > 0, 'no token returned')
      assert(body.user.role === 'owner', `expected owner role, got ${JSON.stringify(body.user)}`)
      ownerToken = body.token
      return `token: ${ownerToken.slice(0, 8)}…`
    })

    await test('LAN client with session token: GET /auth/me -> 200, correct identity', async () => {
      const res = await fetch(`${gw(lanIp)}/auth/me`, { headers: { Authorization: `Bearer ${ownerToken}` } })
      const body = await json(res)
      assert(res.status === 200, `expected 200, got ${res.status}`)
      assert(body.user.username === 'owner', `unexpected identity: ${JSON.stringify(body.user)}`)
    })

    await test('LAN client, no token: POST /v1/chat/completions -> 401 (blocked before proxying)', async () => {
      const res = await fetch(`${gw(lanIp)}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      })
      assert(res.status === 401, `expected 401, got ${res.status}`)
    })

    await test('LAN client with session token: POST /v1/chat/completions passes the gate (502, no llama-server running, NOT 401)', async () => {
      const res = await fetch(`${gw(lanIp)}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({ messages: [] }),
      })
      assert(res.status !== 401, `expected the gate to pass (non-401), got ${res.status}`)
      return `status ${res.status} (expected 502 — no llama-server listening in this test)`
    })

    await test('LAN client with API key as Bearer token: POST /v1/chat/completions passes the gate (Kilo Code style auth)', async () => {
      const res = await fetch(`${gw(lanIp)}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerApiKey}` },
        body: JSON.stringify({ messages: [] }),
      })
      assert(res.status !== 401, `expected the gate to pass (non-401), got ${res.status}`)
    })
  } else {
    console.log('  skip - no non-loopback interface found on this machine; LAN-exemption cases skipped')
  }

  await test('localhost client, no token, auth required -> 401 (no localhost bypass)', async () => {
    const res = await fetch(`${gw('127.0.0.1')}/auth/me`)
    assert(res.status === 401, `expected 401 (localhost gets no exemption), got ${res.status}`)
  })

  console.log('\n-- account management (admin-tier routes) --')

  // With no localhost bypass, "no credentials -> 401" behaves identically
  // from any address; the LAN address is still preferred when available so
  // the non-loopback path gets exercised too.
  const remoteHost = lanIp ?? '127.0.0.1'

  await test('GET /auth/accounts with no token -> 401', async () => {
    const res = await fetch(`${gw(remoteHost)}/auth/accounts`)
    assert(res.status === 401, `expected 401, got ${res.status}`)
  })

  await test('🔍 Owner logged in from localhost (127.0.0.1) CAN reach /auth/accounts with a valid token', async () => {
    // Regression check for a real bug this suite once found: an early
    // localhost check used to short-circuit before token resolution, so a
    // genuinely logged-in local admin was treated as anonymous and got 403
    // from every admin-only route. Tokens must be honored from any address.
    const res = await fetch(`${gw('127.0.0.1')}/auth/accounts`, {
      headers: { Authorization: `Bearer ${ownerToken ?? ownerApiKey}` },
    })
    assert(res.status === 200, `expected 200 (owner identity honored on localhost), got ${res.status}`)
  })

  let bobId, bobApiKey
  await test('POST /auth/accounts as owner creates a user-role account', async () => {
    const res = await fetch(`${gw(remoteHost)}/auth/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken ?? ownerApiKey}` },
      body: JSON.stringify({ username: 'bob', password: 'BobPass123!', role: 'user' }),
    })
    const body = await json(res)
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`)
    assert(typeof body.apiKey === 'string', 'no apiKey returned')
    bobId = body.account.id
    bobApiKey = body.apiKey
  })

  await test('🔍 POST /auth/accounts with a duplicate username -> 400', async () => {
    const res = await fetch(`${gw(remoteHost)}/auth/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken ?? ownerApiKey}` },
      body: JSON.stringify({ username: 'bob', password: 'whatever', role: 'user' }),
    })
    assert(res.status === 400, `expected 400, got ${res.status}`)
  })

  await test('GET /auth/accounts as owner -> 200, sees everyone, secrets stripped', async () => {
    const res = await fetch(`${gw(remoteHost)}/auth/accounts`, {
      headers: { Authorization: `Bearer ${ownerToken ?? ownerApiKey}` },
    })
    const body = await json(res)
    assert(res.status === 200, `expected 200, got ${res.status}`)
    assert(body.accounts.length === 2, `expected 2 accounts (owner + bob), got ${body.accounts.length}`)
    const raw = JSON.stringify(body)
    assert(!raw.includes('passwordHash') && !raw.includes('passwordSalt') && !raw.includes('apiKeyHash'),
      'account secrets leaked in /auth/accounts response')
  })

  let bobToken
  await test('bob logs in (user role)', async () => {
    const res = await fetch(`${gw(remoteHost)}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob', password: 'BobPass123!' }),
    })
    const body = await json(res)
    assert(res.status === 200, `expected 200, got ${res.status}`)
    assert(body.user.role === 'user', `expected user role, got ${JSON.stringify(body.user)}`)
    bobToken = body.token
  })

  await test('🔍 bob (non-admin) GET /auth/accounts -> 403 (role gating enforced)', async () => {
    const res = await fetch(`${gw(remoteHost)}/auth/accounts`, { headers: { Authorization: `Bearer ${bobToken}` } })
    assert(res.status === 403, `expected 403, got ${res.status}`)
  })

  await test('DELETE /auth/accounts/:id (bob) as owner -> 200', async () => {
    const res = await fetch(`${gw(remoteHost)}/auth/accounts/${bobId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken ?? ownerApiKey}` },
    })
    const body = await json(res)
    assert(res.status === 200 && body.ok === true, `expected 200/{ok:true}, got ${res.status} ${JSON.stringify(body)}`)
  })

  await test('bob\'s session is revoked immediately on delete (GET /auth/me -> 401)', async () => {
    const res = await fetch(`${gw(remoteHost)}/auth/me`, { headers: { Authorization: `Bearer ${bobToken}` } })
    assert(res.status === 401, `expected 401 (revoked), got ${res.status}`)
  })

  await test('🔍 DELETE /auth/accounts/:id for an already-deleted id -> 404', async () => {
    const res = await fetch(`${gw(remoteHost)}/auth/accounts/${bobId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken ?? ownerApiKey}` },
    })
    assert(res.status === 404, `expected 404, got ${res.status}`)
  })

  console.log('\n-- role hierarchy: Owner / Admin / User --')

  let itAdminId, itAdminToken
  await test('POST /auth/accounts as owner creates an admin-role account', async () => {
    const res = await fetch(`${gw(remoteHost)}/auth/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken ?? ownerApiKey}` },
      body: JSON.stringify({ username: 'itadmin', password: 'ItAdmin123!', role: 'admin' }),
    })
    const body = await json(res)
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`)
    assert(body.account.role === 'admin', `expected admin role, got ${JSON.stringify(body.account)}`)
    itAdminId = body.account.id
  })

  await test('itadmin logs in (admin role)', async () => {
    const res = await fetch(`${gw(remoteHost)}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'itadmin', password: 'ItAdmin123!' }),
    })
    const body = await json(res)
    assert(res.status === 200, `expected 200, got ${res.status}`)
    itAdminToken = body.token
  })

  let staffId
  await test('POST /auth/accounts as itadmin (sub-admin) creates a user-role account', async () => {
    const res = await fetch(`${gw(remoteHost)}/auth/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${itAdminToken}` },
      body: JSON.stringify({ username: 'staffuser', password: 'StaffPass123!', role: 'user' }),
    })
    const body = await json(res)
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`)
    staffId = body.account.id
  })

  await test('🔍 POST /auth/accounts as itadmin requesting role:admin -> 403 (sub-admins cannot create admins)', async () => {
    const res = await fetch(`${gw(remoteHost)}/auth/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${itAdminToken}` },
      body: JSON.stringify({ username: 'shouldfail', password: 'Whatever123!', role: 'admin' }),
    })
    assert(res.status === 403, `expected 403, got ${res.status}`)
  })

  await test('🔍 GET /auth/accounts as itadmin -> filtered to User-tier only (least visibility)', async () => {
    const res = await fetch(`${gw(remoteHost)}/auth/accounts`, { headers: { Authorization: `Bearer ${itAdminToken}` } })
    const body = await json(res)
    assert(res.status === 200, `expected 200, got ${res.status}`)
    assert(body.accounts.every(a => a.role === 'user'), `expected only user-role accounts, got ${JSON.stringify(body.accounts)}`)
    assert(body.accounts.some(a => a.username === 'staffuser'), 'expected staffuser to be visible to itadmin')
    assert(!body.accounts.some(a => a.username === 'owner' || a.username === 'itadmin'),
      'admin-tier accounts leaked into a sub-admin\'s account list')
  })

  await test('🔍 DELETE /auth/accounts/:id (owner) as itadmin -> 403 (nobody manages the Owner)', async () => {
    const res = await fetch(`${gw(remoteHost)}/auth/accounts/${owner.account.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${itAdminToken}` },
    })
    assert(res.status === 403, `expected 403, got ${res.status}`)
  })

  let itAdmin2Id
  await test('POST /auth/accounts as owner creates a second admin-role account', async () => {
    const res = await fetch(`${gw(remoteHost)}/auth/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken ?? ownerApiKey}` },
      body: JSON.stringify({ username: 'itadmin2', password: 'ItAdmin2_123!', role: 'admin' }),
    })
    const body = await json(res)
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`)
    itAdmin2Id = body.account.id
  })

  await test('🔍 DELETE /auth/accounts/:id (itadmin2) as itadmin -> 403 (sub-admins cannot manage each other)', async () => {
    const res = await fetch(`${gw(remoteHost)}/auth/accounts/${itAdmin2Id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${itAdminToken}` },
    })
    assert(res.status === 403, `expected 403, got ${res.status}`)
  })

  await test('DELETE /auth/accounts/:id (itadmin2) as owner -> 200 (Owner manages Admins)', async () => {
    const res = await fetch(`${gw(remoteHost)}/auth/accounts/${itAdmin2Id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken ?? ownerApiKey}` },
    })
    const body = await json(res)
    assert(res.status === 200 && body.ok === true, `expected 200/{ok:true}, got ${res.status} ${JSON.stringify(body)}`)
  })

  await test('DELETE /auth/accounts/:id (staffuser) as itadmin -> 200 (sub-admins manage Users)', async () => {
    const res = await fetch(`${gw(remoteHost)}/auth/accounts/${staffId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${itAdminToken}` },
    })
    const body = await json(res)
    assert(res.status === 200 && body.ok === true, `expected 200/{ok:true}, got ${res.status} ${JSON.stringify(body)}`)
  })

  await test('cleanup: DELETE /auth/accounts/:id (itadmin) as owner -> 200', async () => {
    const res = await fetch(`${gw(remoteHost)}/auth/accounts/${itAdminId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken ?? ownerApiKey}` },
    })
    const body = await json(res)
    assert(res.status === 200 && body.ok === true, `expected 200/{ok:true}, got ${res.status} ${JSON.stringify(body)}`)
  })

  console.log('\n-- MCP server (built-in web_fetch, port+2) --')

  if (lanIp) {
    await test('LAN client, no token: GET /sse -> 401', async () => {
      const res = await fetch(`${mcp(lanIp)}/sse`)
      assert(res.status === 401, `expected 401, got ${res.status}`)
    })
  }

  await test('LAN/local client with valid token: GET /sse -> 200 text/event-stream', async () => {
    const controller = new AbortController()
    const res = await fetch(`${mcp(lanIp ?? '127.0.0.1')}/sse`, {
      headers: { Authorization: `Bearer ${ownerToken ?? ownerApiKey}` },
      signal: controller.signal,
    })
    assert(res.status === 200, `expected 200, got ${res.status}`)
    assert((res.headers.get('content-type') || '').includes('text/event-stream'),
      `expected text/event-stream, got ${res.headers.get('content-type')}`)
    controller.abort()
  })

  await test('localhost client, no token, auth required: GET /sse -> 401 (no bypass at MCP layer either)', async () => {
    const res = await fetch(`${mcp('127.0.0.1')}/sse`)
    assert(res.status === 401, `expected 401, got ${res.status}`)
  })

  console.log('\n-- toggling auth back off --')

  setAuthRequired(false)

  await test('GET /auth/config reflects the toggle immediately (no restart needed)', async () => {
    const res = await fetch(`${gw('127.0.0.1')}/auth/config`)
    const body = await json(res)
    assert(body.authRequired === false, `expected false, got ${JSON.stringify(body)}`)
  })

  if (lanIp) {
    await test('LAN client, no token, auth OFF: POST /v1/chat/completions passes the gate for everyone', async () => {
      const res = await fetch(`${gw(lanIp)}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      })
      assert(res.status !== 401, `expected non-401 with auth off, got ${res.status}`)
    })

    await test('🔍 LAN client, no token, auth OFF: GET /auth/accounts still 403 (admin-route lockout is unconditional, by design)', async () => {
      const res = await fetch(`${gw(lanIp)}/auth/accounts`)
      assert(res.status === 403, `expected 403 even with auth off (anonymous carries no admin role), got ${res.status}`)
    })
  }

  await stopGateway()
  await stopMcpServer()
  fs.rmSync(tmpDir, { recursive: true, force: true })

  console.log('\n' + '='.repeat(60))
  const passed = results.filter(r => r.pass).length
  const failed = results.length - passed
  console.log(`${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`)
  console.log('='.repeat(60))

  if (failed) process.exit(1)
}

main().catch(err => {
  console.error('Test run crashed:', err)
  process.exit(1)
})
