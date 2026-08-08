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
  // A browser fails the entire request when a preflight omits any header the
  // client asked for, so the CORS allow-list is part of the transport contract.
  // Node's fetch performs no preflight, which is why every suite here passed
  // while no browser client could POST a single message.
  await test('CORS preflight allows the MCP protocol headers', async () => {
    const res = await fetch(`http://127.0.0.1:${MCP_PORT}/message?sessionId=x`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://127.0.0.1:19080',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type, authorization, mcp-protocol-version',
      },
    })
    assert(res.status === 204 || res.ok, `preflight status ${res.status}`)
    const allowed = (res.headers.get('access-control-allow-headers') || '').toLowerCase()
    for (const header of ['content-type', 'authorization', 'mcp-protocol-version']) {
      assert(allowed.includes(header), `preflight does not allow "${header}": ${allowed}`)
    }
  })

  // The SSE handshake itself is a contract. The endpoint event must carry a
  // BARE URI: a JSON-encoded one ("/message?...") is taken verbatim by a
  // spec-compliant client and produces a POST to /"/message?..." that 404s, so
  // no real client can connect. Asserted on the raw stream rather than through
  // the test client, because a client that parses the value would repair the
  // defect and hide it — which is exactly what happened before.
  await test('SSE endpoint event carries a bare URI, not a JSON string', async () => {
    const res = await fetch(`http://127.0.0.1:${MCP_PORT}/sse`)
    assert(res.ok && res.body, `SSE connect failed: ${res.status}`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let dataLine = null
    const deadline = Date.now() + 5000
    while (!dataLine && Date.now() < deadline) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const frame = buffer.split('\n\n')[0]
      if (frame.includes('event: endpoint')) {
        dataLine = frame.split('\n').find((l) => l.startsWith('data: '))?.slice(6) ?? null
      }
    }
    reader.cancel().catch(() => {})
    assert(dataLine !== null, 'no endpoint event received')
    assert(!dataLine.startsWith('"'), `endpoint URI is JSON-encoded: ${dataLine}`)
    assert(dataLine.startsWith('/message?sessionId='), `unexpected endpoint URI: ${dataLine}`)
  })

  const client = await connectMcpClient(`http://127.0.0.1:${MCP_PORT}`)

  await test('initialize returns protocolVersion + capabilities + serverInfo{name,version}', async () => {
    const res = await client.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'contract-test', version: '1.0.0' } })
    const r = res.result
    assert(r && typeof r.protocolVersion === 'string', `protocolVersion missing: ${JSON.stringify(r)}`)
    assert(r.capabilities && typeof r.capabilities === 'object', 'capabilities missing')
    assert(r.serverInfo && typeof r.serverInfo.name === 'string' && typeof r.serverInfo.version === 'string', `serverInfo drifted: ${JSON.stringify(r.serverInfo)}`)
  })

  // The advertised tool shape is { name, description, inputSchema } plus the two
  // MCP-standard optional fields we populate: `annotations` (spec hints) and
  // `_meta` (Redstart provenance — capability + class, consumed by the chat-ui
  // to key filesystem precedence on capability identity rather than tool
  // names). Anything BEYOND that list is drift: providers must not leak their
  // internal fields (outputSchema, execution metadata) into what the model and
  // third-party MCP clients see.
  await test('🔍 every tools/list entry has exactly { name, description, inputSchema, annotations, _meta } with a valid schema', async () => {
    const res = await client.call('tools/list')
    const tools = res.result?.tools
    assert(Array.isArray(tools) && tools.length > 0, `no tools advertised: ${JSON.stringify(res.result)}`)
    for (const t of tools) {
      assert(sameKeys(t, ['name', 'description', 'inputSchema', 'annotations', '_meta']), `tool "${t.name}" keys drifted -> ${JSON.stringify(Object.keys(t))}`)
      assert(typeof t.name === 'string' && t.name.length > 0, 'tool name missing')
      assert(typeof t.description === 'string' && t.description.length > 0, `tool ${t.name} description missing`)
      assert(t.inputSchema && t.inputSchema.type === 'object' && typeof t.inputSchema.properties === 'object', `tool ${t.name} inputSchema is not a valid JSON-Schema object`)
      if ('required' in t.inputSchema) assert(Array.isArray(t.inputSchema.required), `tool ${t.name} required is not an array`)
    }
    return `${tools.length} tools`
  })

  await test('🔍 every tools/list entry carries Redstart provenance in _meta', async () => {
    // The chat-ui reads these to decide which filesystem the model is offered
    // (and, later, which tools may never be "always allowed"). A tool arriving
    // without them silently opts out of both rules, so absence is a failure
    // rather than a default.
    const res = await client.call('tools/list')
    for (const t of res.result.tools) {
      assert(t._meta && typeof t._meta === 'object', `tool ${t.name} has no _meta`)
      assert(Object.prototype.hasOwnProperty.call(t._meta, 'redstart/capability'), `tool ${t.name} is missing redstart/capability`)
      assert(typeof t._meta['redstart/class'] === 'string', `tool ${t.name} is missing redstart/class`)
      assert(typeof t.annotations?.readOnlyHint === 'boolean', `tool ${t.name} is missing the readOnlyHint annotation`)
    }
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
