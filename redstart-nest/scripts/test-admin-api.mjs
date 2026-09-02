// =============================================================================
// The control-plane API surface — coverage, and the gate in front of it.
// =============================================================================
// scripts/test-ipc-contract.mjs pins preload-to-handler parity: every channel
// the renderer can invoke has something on the other end. HTTP-only makes that
// test moot in the long run, and design trap 5.8 says the equivalent invariant
// has to be pinned the same way rather than left as a convention. This is it,
// and it has two halves:
//
//   COVERAGE — every method the preload bridge exposes is reachable over HTTP,
//   or is explicitly marked local-only. Not "most of them", and not a list
//   maintained by hand: the same function objects back both transports
//   (ipc/transport.mjs), so a namespace that grows a method grows a route, and
//   the only way to end up with a hole is to mark one deliberately.
//
//   THE GATE — no route on this surface answers an anonymous caller or a
//   non-owner. Checked against EVERY route rather than a sample, because "every
//   route is gated" is the claim and a sample proves something weaker.
//
// The local-only exclusions are the handlers that act on the CLIENT's machine —
// native pickers and "reveal in explorer". Those are trap 5.2, and Phase 4 is
// what replaces them with a server-side browser. This suite's job is to make
// sure that set stays deliberate and small rather than becoming a drawer.
//
// Run:  node scripts/test-admin-api.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(here, '..')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-admin-api-test-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir

register('./auth-test-loader.mjs', import.meta.url)
await import('./electron-stub.mjs')

const { startAdminListener, stopAdminListener } = await import('../electron/main/admin-listener.mjs')
const {
  setAdminApi, channelFromPath, pathForChannel, isAdminApiRoute,
} = await import('../electron/main/admin/api-routes.mjs')
const { buildAdminApi } = await import('../electron/main/admin/api-table.mjs')
const { isLocalOnly } = await import('../electron/main/ipc/transport.mjs')
const { createOwner, createAccount, login, CONTROL_PLANE } = await import('../electron/main/auth.mjs')

const PORT = 48385
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

// ---------------------------------------------------------------------------
// The table, under stand-in collaborators.
//
// Nothing below INVOKES a handler that would do work — the gate checks stop at
// the status code, and the one route that is actually called is a read. A Proxy
// returning no-op functions is enough to get every namespace assembled, which is
// the same trick test-ipc-contract.mjs uses for registration.
// ---------------------------------------------------------------------------

const noopDeps = new Proxy({}, { get: () => () => {} })
const table = buildAdminApi(noopDeps)
setAdminApi(table)

const channels = Object.keys(table)
const routable = channels.filter(c => !isLocalOnly(table[c]))
const localOnlyChannels = channels.filter(c => isLocalOnly(table[c]))

// Channels the preload bridge actually invokes — the renderer's whole reach.
const preloadSource = fs.readFileSync(path.join(repoRoot, 'electron', 'preload', 'index.mjs'), 'utf8')
const preloadChannels = new Set(
  [...preloadSource.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)].map(m => m[1])
)

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

console.log('\n-- every method the renderer can reach has a route --')

await test('🔍 every preload channel is in the control-plane table', () => {
  const missing = [...preloadChannels].filter(c => !(c in table)).sort()
  assert(missing.length === 0,
    `reachable over IPC but absent from the control plane: ${missing.join(', ')}`)
  return `${preloadChannels.size} channels`
})

await test('🔍 every table entry is routable or explicitly local-only', () => {
  // Nothing here can be neither — the table is functions, and localOnly() is the
  // only way to opt one out. What this really pins is the SIZE and SHAPE of the
  // opt-out set, so a handler that stops working remotely cannot be quietly
  // marked and forgotten.
  assert(routable.length + localOnlyChannels.length === channels.length, 'a channel is neither')
  return `${routable.length} routable, ${localOnlyChannels.length} local-only`
})

await test('🔍 the local-only set is exactly the client-machine actions', () => {
  const expected = [
    'capabilities:select-documents-folder',
    'capabilities:select-file-system-folder',
    'capabilities:select-git-folder',
    'capabilities:select-sqlite-folder',
    'capabilities:select-vault-folder',
    'hardware:select-model',
    'models:reveal-folder',
    'plugins:pick-folder',
    'settings:select-binary',
    'settings:select-models-dir',
  ]
  const actual = [...localOnlyChannels].sort()
  assert(JSON.stringify(actual) === JSON.stringify(expected),
    `the local-only set has drifted:\n        expected ${expected.join(', ')}\n        actual   ${actual.join(', ')}`)
  return 'native pickers and reveal-in-explorer, nothing else'
})

await test('🔍 nothing that changes server state is local-only', () => {
  // The failure this catches: a handler marked local-only to make a remote
  // problem go away, which silently removes it from the appliance rather than
  // fixing it. Every legitimate exclusion is a READ that opens a window on the
  // caller's own machine.
  const suspicious = localOnlyChannels.filter(c => !/:(select|pick|reveal)-/.test(c))
  assert(suspicious.length === 0, `these are excluded but are not pickers: ${suspicious.join(', ')}`)
})

await test('the namespaces in the table match the ones index.mjs registers', () => {
  const indexSource = fs.readFileSync(path.join(repoRoot, 'electron', 'main', 'index.mjs'), 'utf8')
  const registered = [...indexSource.matchAll(/register(\w+)Handlers\(/g)]
    .map(m => m[1].toLowerCase())
    .filter(n => n !== 'ipc')
  const tableSource = fs.readFileSync(path.join(repoRoot, 'electron', 'main', 'admin', 'api-table.mjs'), 'utf8')
  const tabled = [...tableSource.matchAll(/\.\.\.(\w+)Handlers\(/g)].map(m => m[1].toLowerCase())
  const missing = [...new Set(registered)].filter(n => !tabled.includes(n)).sort()
  assert(missing.length === 0, `registered over IPC but not in the control-plane table: ${missing.join(', ')}`)
  return `${tabled.length} namespaces`
})

// ---------------------------------------------------------------------------
// The rule the HTTP client derives its URLs from
// ---------------------------------------------------------------------------
// src/api/http.ts does not list 74 methods — it builds each channel as
// `namespace:kebab-case(method)` and lets a Proxy do the rest, because 74
// hand-written entries is 74 places for a typo typecheck cannot see. That
// shortcut is only sound while the rule actually holds for every channel, so it
// is checked here rather than assumed. A future channel that breaks it is not a
// disaster — it just has to be spelled out — but it must not go unnoticed, since
// the symptom would be one method 404ing in a browser and nowhere else.

console.log('\n-- namespace.method -> channel --')

// The same one-liner src/api/http.ts uses. Duplicated on purpose: the point of
// this check is that two independent statements of the rule agree, and importing
// the TypeScript one would make it a tautology.
const kebab = (method) => method.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)

// The preload as a nested literal: `namespace: {` opens a block, and each
// `method: (...) => ipcRenderer.invoke('channel')` inside it is one binding.
function preloadBindings() {
  const bindings = []
  let namespace = null
  for (const line of preloadSource.split('\n')) {
    const open = line.match(/^  (\w+): \{/)
    if (open) { namespace = open[1]; continue }
    if (line === '  },') { namespace = null; continue }
    const invoke = line.match(/^\s*(\w+):.*ipcRenderer\.invoke\(\s*'([^']+)'/)
    if (invoke && namespace) bindings.push({ namespace, method: invoke[1], channel: invoke[2] })
  }
  return bindings
}

const bindings = preloadBindings()

await test('the preload parses into namespace/method/channel triples', () => {
  assert(bindings.length === preloadChannels.size,
    `parsed ${bindings.length} bindings but found ${preloadChannels.size} channels — the preload's shape changed`)
  return `${bindings.length} bindings`
})

const httpSource = fs.readFileSync(path.join(repoRoot, 'src', 'api', 'http.ts'), 'utf8')

// The exceptions the client declares. Parsed from source rather than imported,
// because this suite runs under plain node and the client is TypeScript — and
// because reading the declaration is the point: the check is that the rule PLUS
// the written-down exceptions reproduce the bridge exactly.
const overrides = new Map(
  [...(httpSource.match(/const CHANNEL_OVERRIDES[^}]*\}/)?.[0] ?? '')
    .matchAll(/'([^']+)':\s*'([^']+)'/g)].map(m => [m[1], m[2]])
)

const clientChannelFor = (namespace, method) => {
  const derived = `${namespace}:${kebab(method)}`
  return overrides.get(derived) ?? derived
}

await test('\u{1F50D} the HTTP client derives every channel the bridge invokes', () => {
  const broken = bindings
    .filter(b => clientChannelFor(b.namespace, b.method) !== b.channel)
    .map(b => `${b.namespace}.${b.method} wants ${b.channel}, client builds ${clientChannelFor(b.namespace, b.method)}`)
  assert(broken.length === 0, `a browser would 404 on: ${broken.join('; ')}`)
  return `${bindings.length} bindings, ${overrides.size} declared exception(s)`
})

await test('every declared exception is one the bridge actually needs', () => {
  // Stops the override map becoming a graveyard: an entry for a binding that no
  // longer exists is a rule nobody is applying and nobody will remove.
  const wanted = new Set(bindings.map(b => `${b.namespace}:${kebab(b.method)}`))
  const stale = [...overrides.keys()].filter(k => !wanted.has(k))
  assert(stale.length === 0, `these overrides match no bridge method: ${stale.join(', ')}`)
})

await test('\u{1F50D} the HTTP client knows every namespace the preload exposes', () => {
  const listed = new Set(
    (httpSource.match(/const NAMESPACES = \[([\s\S]*?)\] as const/)?.[1] ?? '')
      .split(',').map(part => part.trim().replace(/^'|'$/g, '')).filter(Boolean)
  )
  const missing = [...new Set(bindings.map(b => b.namespace))].filter(n => !listed.has(n)).sort()
  assert(missing.length === 0, `a browser cannot reach these namespaces at all: ${missing.join(', ')}`)
  return `${listed.size} namespaces`
})

// ---------------------------------------------------------------------------
// Path shape
// ---------------------------------------------------------------------------

console.log('\n-- paths --')

await test('a channel round-trips through its path', () => {
  for (const channel of channels) {
    assert(channelFromPath(pathForChannel(channel)) === channel, `${channel} did not round-trip`)
  }
  return `${channels.length} channels`
})

await test('🔍 a malformed path resolves to no channel at all', () => {
  for (const urlPath of [
    '/admin/api/llama',              // one segment
    '/admin/api/llama/launch/extra', // three
    '/admin/api/llama/',             // trailing slash
    '/admin/api//launch',            // empty segment
    '/admin/api/../auth/login',      // traversal shape
    '/admin/api/LLAMA/LAUNCH',       // case
    '/admin/api/llama/launch?x=1',   // the query is stripped upstream, not here
    '/admin/api/__proto__/x',        // does not even match the segment shape
    '/admin/api/llama/launch;drop',
  ]) {
    assert(channelFromPath(urlPath) === null, `${urlPath} resolved to ${channelFromPath(urlPath)}`)
  }
  return 'two segments, a conservative alphabet, nothing else'
})

await test('a well-shaped path that names nothing resolves to a channel the table lacks', () => {
  // Deliberately NOT null: the parser validates SHAPE, and membership is the
  // dispatcher's question. Saying so here is what keeps the next reader from
  // "fixing" the parser to know about the table.
  const channel = channelFromPath('/admin/api/constructor/prototype')
  assert(channel === 'constructor:prototype', `parsed as ${channel}`)
  assert(!Object.hasOwn(table, channel), 'the table somehow holds it')
})

await test('the API prefix is recognised and nothing else is', () => {
  assert(isAdminApiRoute('/admin/api/llama/launch'), 'the prefix was not recognised')
  for (const other of ['/admin/auth/login', '/admin/bootstrap', '/admin/whoami', '/index.html', '/']) {
    assert(!isAdminApiRoute(other), `${other} was treated as an API route`)
  }
})

// ---------------------------------------------------------------------------
// The gate, over real sockets, against every route
// ---------------------------------------------------------------------------

console.log('\n-- the gate --')

const ownerResult = createOwner({ username: 'owner', password: 'owner-pw-1234' })
if (!ownerResult.ok) throw new Error(`could not create the owner: ${ownerResult.error}`)
const subAdmin = createAccount(ownerResult.account, { username: 'sub', password: 'sub-pw-1234', tier: 'admin' })
if (!subAdmin.ok) throw new Error(`could not create the admin: ${subAdmin.error}`)

const ownerToken = login('owner', 'owner-pw-1234', CONTROL_PLANE).token
const adminToken = login('sub', 'sub-pw-1234', CONTROL_PLANE).token

await startAdminListener({ bindHost: '127.0.0.1', port: PORT })

async function call(channel, { token, args = [], method = 'POST' } = {}) {
  const res = await fetch(`${admin}${pathForChannel(channel)}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify({ args }) } : {}),
  })
  let body = null
  try { body = await res.json() } catch { /* no body */ }
  return { status: res.status, body }
}

await test('🔍 EVERY route refuses an anonymous caller', async () => {
  const leaked = []
  for (const channel of channels) {
    const res = await call(channel)
    if (res.status !== 401) leaked.push(`${channel} -> ${res.status}`)
  }
  assert(leaked.length === 0, `answered without a credential: ${leaked.join(', ')}`)
  return `${channels.length} routes, all 401`
})

await test('🔍 EVERY route refuses an admin-tier session', async () => {
  const leaked = []
  for (const channel of channels) {
    const res = await call(channel, { token: adminToken })
    if (res.status !== 403) leaked.push(`${channel} -> ${res.status}`)
  }
  assert(leaked.length === 0, `answered a non-owner: ${leaked.join(', ')}`)
  return 'owner-only, uniformly'
})

await test('🔍 the refusal comes BEFORE the handler runs', async () => {
  // The gate is in the listener, ahead of dispatch, so a refused call cannot
  // have had a side effect. Probed with the most destructive route on the
  // surface: if the ordering were wrong, this would have uninstalled something.
  const res = await call('plugins:uninstall', { token: adminToken, args: ['anything'] })
  assert(res.status === 403, `expected 403, got ${res.status}`)
  return 'plugins:uninstall never reached its handler'
})

await test('🔍 an owner reaches a real handler', async () => {
  const res = await call('admin:get-control-plane', { token: ownerToken })
  assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`)
  assert(res.body.result?.running === true, `unexpected result: ${JSON.stringify(res.body)}`)
  return 'the gate is a gate, not a wall'
})

await test('🔍 a local-only route refuses the owner too, and says why', async () => {
  for (const channel of localOnlyChannels) {
    const res = await call(channel, { token: ownerToken })
    assert(res.status === 501, `${channel} answered ${res.status} — a native picker ran on the server`)
  }
  return `${localOnlyChannels.length} routes, 501 not 403`
})

await test('a GET is refused even from the owner', async () => {
  const res = await call('admin:get-control-plane', { token: ownerToken, method: 'GET' })
  assert(res.status === 405, `expected 405, got ${res.status}`)
  return 'no process-spawning route is reachable by a link'
})

await test('a body without an args array is a 400, not a call with no arguments', async () => {
  for (const body of ['{}', '{"args":"launch"}', 'not json', '[]']) {
    const res = await fetch(`${admin}${pathForChannel('admin:get-control-plane')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body,
    })
    assert(res.status === 400, `${body} was accepted with ${res.status}`)
  }
})

await test('🔍 a path naming an Object.prototype member dispatches nothing', async () => {
  // `constructor/prototype` passes the segment shape and is not a channel, so
  // what stops it is the dispatcher's own-property lookup, not the parser.
  // Probed over the wire because a plain `api[channel]` is exactly where this
  // would have handed back a function.
  for (const urlPath of ['/admin/api/constructor/prototype', '/admin/api/valueof/tostring']) {
    const res = await fetch(`${admin}${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ args: [] }),
    })
    assert(res.status === 404, `${urlPath} answered ${res.status}`)
  }
})

await test('an unknown method is a 404 for the owner', async () => {
  const res = await fetch(`${admin}/admin/api/llama/no-such-method`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ args: [] }),
  })
  assert(res.status === 404, `expected 404, got ${res.status}`)
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
