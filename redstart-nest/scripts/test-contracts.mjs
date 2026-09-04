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

// Explicit, main-thread trigger for the stub's platform-paths.mjs initialization.
// module.register() hooks run in a separate worker thread, so a side effect
// inside auth-test-loader.mjs itself can't reach this thread's copy of
// platform-paths.mjs -- only an ordinary import, resolved here in the main
// thread, can. Needed because production code no longer imports 'electron'
// at all in several modules this suite exercises, so nothing else would
// trigger the stub's initPaths() call.
await import('./electron-stub.mjs')

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
//
// `tier` is the management tier and `role` is its mirror under the old name —
// both are emitted deliberately, because connector apps (Twig, Blueprints,
// Yellowscript) hold their own copy of this shape and an undefined `role` there
// reads as "not an admin". `roleId` is the admin-defined capability role, null
// for Full Access. Drop `role` from this list only when every connector reads
// `tier`.
const PUBLIC_USER_KEYS = ['id', 'username', 'tier', 'role', 'roleId', 'apiKeyPrefix', 'createdAt', 'lastLoginAt']
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
    const res = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
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

  await test('the MCP server emits exactly one Access-Control-Allow-Origin on a real response', async () => {
    // fetch() joins duplicate header values with ', ', so an exact '*' proves there
    // is exactly one — the failure mode a browser rejects outright.
    const res = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cors-test', version: '1.0.0' } } }),
    })
    assert(res.headers.get('access-control-allow-origin') === '*', `expected a single '*', got ${JSON.stringify(res.headers.get('access-control-allow-origin'))}`)
    await res.text()
  })

  // The session id is delivered as a RESPONSE header, and `mcp-session-id` is
  // not CORS-safelisted — so a cross-origin browser client cannot read it
  // unless the ACTUAL response exposes it. The chat-ui is always cross-origin
  // here (served from the gateway on port+0, this server is on port+2).
  //
  // Asserting it on the preflight is not enough and is precisely how this
  // regressed: Access-Control-Expose-Headers was set only on the OPTIONS
  // response, where it does nothing. Every Node suite passed (no CORS at all)
  // while every browser silently lost the session and got a 400 on the request
  // straight after initialize.
  await test('a browser can READ the session id off the initialize response (cross-origin)', async () => {
    const res = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Origin: 'http://127.0.0.1:19080' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cors-expose-test', version: '1.0.0' } } }),
    })
    assert(res.headers.get('mcp-session-id'), 'no Mcp-Session-Id header on the initialize response')
    const exposed = (res.headers.get('access-control-expose-headers') || '').toLowerCase()
    assert(
      exposed.includes('mcp-session-id'),
      `the initialize response does not expose mcp-session-id, so a browser client cannot read it: ${JSON.stringify(exposed)}`,
    )
    await res.text()
  })

  // The SDK client opens EVERY connection with an optional GET probe, before
  // it sends initialize, to discover whether a standalone SSE stream exists.
  // Its contract is explicit (client/streamableHttp.js _startOrAuthSse): 405
  // means "not offered, expected, continue silently", while any other error
  // status is thrown as a fatal StreamableHTTPError that aborts connect()
  // before initialize is ever sent. Answering that probe with 400 made the
  // whole transport unreachable from a browser.
  await test('a session-less GET is answered 405 (the SDK probe the client must survive)', async () => {
    const res = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
      method: 'GET',
      headers: { Accept: 'text/event-stream', Origin: 'http://127.0.0.1:19080' },
    })
    assert(res.status === 405, `expected 405 for the session-less GET probe, got ${res.status} (anything but 405 aborts the client's connect())`)
    await res.text()
  })

  // The Streamable HTTP handshake is a contract. `initialize` must return an
  // `Mcp-Session-Id` response header, and every subsequent call is required to
  // echo it back — that header, not the JSON-RPC body, is what session
  // continuity rides on. Asserted on the raw fetch rather than through the test
  // client, because the client already treats the header as load-bearing and
  // would hide a regression here.
  await test('initialize response carries an Mcp-Session-Id header usable on the next request', async () => {
    const initRes = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'contract-test', version: '1.0.0' } } }),
    })
    assert(initRes.ok, `initialize failed: ${initRes.status}`)
    const sessionId = initRes.headers.get('mcp-session-id')
    assert(sessionId, 'no Mcp-Session-Id header on initialize response')

    const listRes = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    })
    assert(listRes.ok, `tools/list with the session id failed: ${listRes.status}`)
  })

  await test('a request with an unrecognised Mcp-Session-Id is rejected, not silently accepted', async () => {
    const res = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': 'not-a-real-session' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    })
    assert(res.status === 400, `expected 400 for an unrecognised session, got ${res.status}`)
  })

  // connectMcpClient performs the initialize handshake itself as part of
  // connecting (Streamable HTTP rejects a second initialize on the same
  // session, unlike the old SSE transport), so the shape is asserted on the
  // result it captured rather than by re-initializing.
  const client = await connectMcpClient(`http://127.0.0.1:${MCP_PORT}`)

  await test('initialize returns protocolVersion + capabilities + serverInfo{name,version}', async () => {
    const r = client.initResult
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
