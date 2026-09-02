// =============================================================================
// The control-plane API surface — coverage, and the gate in front of it.
// =============================================================================
// Design trap 5.8 says "every RedstartAPI method has a route, every route is
// tier/surface-gated" needs to be pinned by a test, not left a convention.
// This is it, and it has two halves:
//
//   COVERAGE — every method declared on RedstartAPI (src/api/redstart.ts) is
//   reachable over HTTP, or is explicitly marked local-only. Not "most of
//   them", and not a list maintained by hand: the same function objects back
//   the table (ipc/transport.mjs), so a namespace that grows a method grows a
//   route, and the only way to end up with a hole is to mark one deliberately.
//
//   THE GATE — no route on this surface answers an anonymous caller or a
//   non-owner. Checked against EVERY route rather than a sample, because "every
//   route is gated" is the claim and a sample proves something weaker.
//
// Until Phase 6 §6.2 this suite's ground truth for "every method the renderer
// can reach" was the preload bridge's literal `ipcRenderer.invoke('channel')`
// calls — an exact, mechanically-scannable list. Retiring the preload
// (test-ipc-contract.mjs's whole job) removed that ground truth along with
// it; RedstartAPI's TypeScript type is what is left, so the method list below
// is parsed out of it directly rather than assumed. A parser bug here is a
// real risk this shortcut carries — see apiMethods()'s own comment.
//
// The local-only exclusions are the handlers that act on the CLIENT's machine —
// native pickers and "reveal in explorer". Both retired in Phase 6 §6.1; the
// set is pinned at empty rather than the check being deleted.
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

// The methods RedstartAPI declares — the renderer's whole reach — parsed out
// of src/api/redstart.ts's type declaration. `events` is excluded: it is not
// a request/response namespace (no channel, no route — see
// src/api/http.ts's separate EVENT_NAMESPACE handling), the same way the old
// preload-based version only ever looked at ipcRenderer.invoke() and left
// ipcRenderer.on()/removeAllListeners() to a separate check.
const redstartSource = fs.readFileSync(path.join(repoRoot, 'src', 'api', 'redstart.ts'), 'utf8')

/**
 * Extract { namespace, method } pairs from RedstartAPI's type body.
 *
 * A depth-aware line walker, the same shape scripts/test-ipc-contract.mjs
 * used for the preload (a nested-object literal), applied here to a nested
 * TYPE literal instead: depth 0 is namespace names, depth 1 (inside a
 * namespace's braces) is method names, depth 2+ is a method's own
 * parameter/return type and is deliberately never inspected — a field name
 * inside a returned object (e.g. admin.getStatus()'s `port`) must never be
 * mistaken for a sibling method. `github: { checkReleases: ... }` is the one
 * single-line namespace in the file and is handled as its own case.
 */
function apiMethods(source) {
  const marker = 'export type RedstartAPI = {'
  const start = source.indexOf(marker)
  if (start === -1) throw new Error('RedstartAPI type not found in redstart.ts')
  const bodyStart = start + marker.length
  let depth = 1 // already inside the outer { at bodyStart
  let end = bodyStart
  for (; end < source.length && depth > 0; end++) {
    if (source[end] === '{') depth++
    else if (source[end] === '}') depth--
  }
  const body = source.slice(bodyStart, end - 1)

  const methods = []
  let currentNamespace = null
  let lineDepth = 0
  for (const line of body.split('\n')) {
    if (lineDepth === 0) {
      const single = line.match(/^\s*(\w+): \{\s*(\w+):/)
      if (single && /\}\s*$/.test(line)) {
        methods.push({ namespace: single[1], method: single[2] })
        continue // self-contained and brace-balanced — depth unchanged
      }
      const open = line.match(/^\s*(\w+): \{\s*$/)
      if (open) currentNamespace = open[1]
    } else if (lineDepth === 1 && currentNamespace) {
      const m = line.match(/^\s*(\w+)\??:/)
      if (m) methods.push({ namespace: currentNamespace, method: m[1] })
    }
    for (const ch of line) {
      if (ch === '{') lineDepth++
      else if (ch === '}') lineDepth--
    }
  }
  return methods.filter(m => m.namespace !== 'events')
}

const apiMembers = apiMethods(redstartSource)

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

console.log('\n-- every method the renderer can reach has a route --')

const kebab = (method) => method.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)

const httpSource = fs.readFileSync(path.join(repoRoot, 'src', 'api', 'http.ts'), 'utf8')

// The exceptions the client declares. Parsed from source rather than imported,
// because this suite runs under plain node and the client is TypeScript — and
// because reading the declaration is the point: the check is that the rule PLUS
// the written-down exceptions reproduce every declared method.
const overrides = new Map(
  [...(httpSource.match(/const CHANNEL_OVERRIDES[^}]*\}/)?.[0] ?? '')
    .matchAll(/'([^']+)':\s*'([^']+)'/g)].map(m => [m[1], m[2]])
)

const clientChannelFor = (namespace, method) => {
  const derived = `${namespace}:${kebab(method)}`
  return overrides.get(derived) ?? derived
}

await test('🔍 every RedstartAPI method is in the control-plane table', () => {
  const missing = apiMembers
    .map(m => clientChannelFor(m.namespace, m.method))
    .filter(c => !(c in table))
    .sort()
  assert(missing.length === 0,
    `declared on RedstartAPI but absent from the control plane: ${missing.join(', ')}`)
  return `${apiMembers.length} methods`
})

await test('🔍 every table entry is routable or explicitly local-only', () => {
  // Nothing here can be neither — the table is functions, and localOnly() is the
  // only way to opt one out. What this really pins is the SIZE and SHAPE of the
  // opt-out set, so a handler that stops working remotely cannot be quietly
  // marked and forgotten.
  assert(routable.length + localOnlyChannels.length === channels.length, 'a channel is neither')
  return `${routable.length} routable, ${localOnlyChannels.length} local-only`
})

await test('🔍 the local-only set is empty — Phase 6 retired the last two members', () => {
  // browse:pick-native (the native picker) and models:reveal-folder
  // (reveal-in-explorer) were the whole set, and both retired in Phase 6
  // §6.1 along with IPC: once nothing can tell "the caller is sitting at
  // this machine" from "the caller is a browser anywhere on the network",
  // there is no safe caller left for either. isLocalOnly()/localOnly() and
  // this 501 branch stay in the code (ipc/transport.mjs,
  // admin/api-routes.mjs) as machinery for the day a channel genuinely
  // needs it again — pinned at zero here rather than deleted, so the
  // pattern reappearing is a deliberate, visible choice and not a quiet
  // regrowth of the set this test used to bound.
  const actual = [...localOnlyChannels].sort()
  assert(actual.length === 0, `expected no local-only channels, found: ${actual.join(', ')}`)
})

await test('🔍 nothing that changes server state is local-only', () => {
  // The failure this catches: a handler marked local-only to make a remote
  // problem go away, which silently removes it from the appliance rather than
  // fixing it. Every legitimate exclusion is a READ that opens a window on the
  // caller's own machine.
  const suspicious = localOnlyChannels.filter(c => !/:(select|pick|reveal)-/.test(c))
  assert(suspicious.length === 0, `these are excluded but are not pickers: ${suspicious.join(', ')}`)
})

await test('the table assembles a real number of namespaces', () => {
  // Used to also check this set against what index.mjs registered over IPC —
  // meaningful when the table was ONE of two consumers of each handler
  // table. Phase 6 §6.2 retired IPC (and registerXHandlers() with it), so
  // admin/api-table.mjs's buildAdminApi() is now the only consumer there is;
  // the parity check collapsed to a tautology (nothing is ever "registered
  // over IPC" any more) rather than being deleted outright, in case a
  // second transport is ever added again. What is still worth pinning: the
  // table actually assembles something, so a namespace import throwing
  // silently at build time does not quietly shrink the whole admin API.
  const tableSource = fs.readFileSync(path.join(repoRoot, 'electron', 'main', 'admin', 'api-table.mjs'), 'utf8')
  const tabled = [...tableSource.matchAll(/\.\.\.(\w+)Handlers\(/g)].map(m => m[1].toLowerCase())
  assert(tabled.length >= 10, `expected at least 10 namespaces, found ${tabled.length}`)
  return `${tabled.length} namespaces`
})

console.log('\n-- namespace.method -> channel --')

await test('every declared exception is one RedstartAPI actually needs', () => {
  // Stops the override map becoming a graveyard: an entry for a method that
  // no longer exists is a rule nobody is applying and nobody will remove.
  const wanted = new Set(apiMembers.map(m => `${m.namespace}:${kebab(m.method)}`))
  const stale = [...overrides.keys()].filter(k => !wanted.has(k))
  assert(stale.length === 0, `these overrides match no RedstartAPI method: ${stale.join(', ')}`)
})

await test('\u{1F50D} the HTTP client knows every namespace RedstartAPI declares', () => {
  const listed = new Set(
    (httpSource.match(/const NAMESPACES = \[([\s\S]*?)\] as const/)?.[1] ?? '')
      .split(',').map(part => part.trim().replace(/^'|'$/g, '')).filter(Boolean)
  )
  const missing = [...new Set(apiMembers.map(m => m.namespace))].filter(n => !listed.has(n)).sort()
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
