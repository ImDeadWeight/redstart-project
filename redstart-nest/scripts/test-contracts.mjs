// =============================================================================
// Boundary contract / shape snapshots — the response shapes consuming apps
// depend on.
// =============================================================================
// As Redstart Core becomes shared infrastructure, the shapes it returns over
// the gateway HTTP API and the MCP transport ARE the contract every app (Chat,
// IDE extension, future products) is built against. A Core change that quietly
// alters these shapes would break consumers at a distance. These tests pin the
// shapes so such a change fails loudly here instead.
//
// The highest-stakes one is the public account projection: it must expose a
// fixed field set and NEVER leak a secret (password hash/salt, API-key hash).
//
// Drives the real gateway + mcp-server, same electron-stub setup as
// test-auth.mjs. Ports are clear of the app's real defaults and the other
// suites so this can run alongside a live instance.
//
// Run:  node scripts/test-contracts.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { connectMcpClient } from './lib/mcp-test-client.mjs'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-contracts-test-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir

register('./auth-test-loader.mjs', import.meta.url)

const { startGateway, stopGateway } = await import('../electron/main/tools-gateway.mjs')
const { startMcpServer, stopMcpServer } = await import('../electron/main/mcp-server.mjs')
const { setAuthRequired, createOwner } = await import('../electron/main/auth.mjs')

const GATEWAY_PORT = 48082 // internal (unused) is +1
const MCP_PORT = 48096

// ---------------------------------------------------------------------------
// Harness
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

function sameKeys(obj, expected) {
  const got = Object.keys(obj).sort()
  const want = [...expected].sort()
  return got.length === want.length && got.every((k, i) => k === want[i])
}

const gw = (p = '') => `http://127.0.0.1:${GATEWAY_PORT}${p}`

// The public account projection (auth.mjs toPublicAccount). Consumers rely on
// exactly these fields; none of the secret fields may ever appear.
const PUBLIC_USER_KEYS = ['id', 'username', 'role', 'apiKeyPrefix', 'createdAt', 'lastLoginAt']
const SECRET_KEYS = ['passwordHash', 'passwordSalt', 'apiKeyHash', 'password', 'apiKey']

function assertPublicUser(user, where) {
  assert(user && typeof user === 'object', `${where}: user missing`)
  assert(sameKeys(user, PUBLIC_USER_KEYS), `${where}: user keys drifted -> ${JSON.stringify(Object.keys(user))}`)
  for (const s of SECRET_KEYS) {
    assert(!(s in user), `${where}: SECRET FIELD "${s}" leaked in the public user shape`)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await startGateway(GATEWAY_PORT, { allowedBaseUrls: [], activeTools: [], maxFetchTokens: 2000 })

  // -- Gateway auth contract shapes (auth on) --------------------------------
  console.log('\n-- gateway auth response shapes --')
  setAuthRequired(true)
  createOwner({ username: 'owner', password: 'ownerpass' })

  await test('GET /auth/config returns exactly { authRequired: boolean }', async () => {
    const res = await fetch(gw('/auth/config'))
    const body = await res.json()
    assert(res.status === 200, `status ${res.status}`)
    assert(sameKeys(body, ['authRequired']), `keys drifted -> ${JSON.stringify(Object.keys(body))}`)
    assert(typeof body.authRequired === 'boolean', `authRequired not a boolean: ${typeof body.authRequired}`)
  })

  let token
  await test('🔍 POST /auth/login returns { token, user } and the user leaks no secrets', async () => {
    const res = await fetch(gw('/auth/login'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'ownerpass' }),
    })
    const body = await res.json()
    assert(res.status === 200, `status ${res.status}: ${JSON.stringify(body)}`)
    assert(sameKeys(body, ['token', 'user']), `top-level keys drifted -> ${JSON.stringify(Object.keys(body))}`)
    assert(typeof body.token === 'string' && body.token.length > 0, 'token missing/empty')
    assertPublicUser(body.user, 'login')
    token = body.token
  })

  await test('🔍 GET /auth/me returns { authRequired, user } with the same secret-free user shape', async () => {
    const res = await fetch(gw('/auth/me'), { headers: { Authorization: `Bearer ${token}` } })
    const body = await res.json()
    assert(res.status === 200, `status ${res.status}: ${JSON.stringify(body)}`)
    assert(sameKeys(body, ['authRequired', 'user']), `keys drifted -> ${JSON.stringify(Object.keys(body))}`)
    assertPublicUser(body.user, '/auth/me')
  })

  // -- MCP transport contract shapes (auth off for the provider-facing view) -
  console.log('\n-- MCP transport response shapes --')
  setAuthRequired(false)
  await startMcpServer(MCP_PORT, {
    webFetch: { enabled: true, whitelistEnabled: false, allowedBaseUrls: [], activeTools: [], maxFetchTokens: 2000 },
  })
  const client = await connectMcpClient(`http://127.0.0.1:${MCP_PORT}`)

  await test('initialize returns protocolVersion + capabilities + serverInfo{name,version}', async () => {
    const res = await client.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'contract-test', version: '1.0.0' } })
    const r = res.result
    assert(r && typeof r.protocolVersion === 'string', `protocolVersion missing: ${JSON.stringify(r)}`)
    assert(r.capabilities && typeof r.capabilities === 'object', 'capabilities missing')
    assert(r.serverInfo && typeof r.serverInfo.name === 'string' && typeof r.serverInfo.version === 'string', `serverInfo drifted: ${JSON.stringify(r.serverInfo)}`)
  })

  await test('🔍 every tools/list entry has exactly { name, description, inputSchema } with a valid schema', async () => {
    const res = await client.call('tools/list')
    const tools = res.result?.tools
    assert(Array.isArray(tools) && tools.length > 0, `no tools advertised: ${JSON.stringify(res.result)}`)
    for (const t of tools) {
      assert(sameKeys(t, ['name', 'description', 'inputSchema']), `tool "${t.name}" keys drifted -> ${JSON.stringify(Object.keys(t))}`)
      assert(typeof t.name === 'string' && t.name.length > 0, 'tool name missing')
      assert(typeof t.description === 'string' && t.description.length > 0, `tool ${t.name} description missing`)
      assert(t.inputSchema && t.inputSchema.type === 'object' && typeof t.inputSchema.properties === 'object', `tool ${t.name} inputSchema is not a valid JSON-Schema object`)
      if ('required' in t.inputSchema) assert(Array.isArray(t.inputSchema.required), `tool ${t.name} required is not an array`)
    }
    return `${tools.length} tools`
  })

  client.close()
  stopMcpServer()
  stopGateway()

  // ---------------------------------------------------------------------------
  // Cleanup + summary
  // ---------------------------------------------------------------------------
  fs.rmSync(tmpDir, { recursive: true, force: true })

  const failed = results.filter(r => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length) {
    console.log(`\n${failed.length} FAILED:`)
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
    process.exit(1)
  }
  process.exit(0)
}

main().catch(err => { console.error(err); process.exit(1) })
