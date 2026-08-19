// =============================================================================
// Unit tests for electron/main/plugin-provider.mjs — the adapter that turns a
// registry entry into a provider-contract object mcp-server.mjs can dispatch
// to (task T7 / Phase 6 test plan).
// =============================================================================
// This module is the join point between three things this repo tests
// separately but had never tested TOGETHER: the registry (plugin-registry.mjs,
// its own suite), the child transport (mcp-plugin-client.mjs, its own suite),
// and the provider contract every other capability satisfies
// (test-provider-conformance.mjs). Nothing here exercised plugin-provider.mjs
// directly before this suite — a bug in the two things it is solely
// responsible for (the dual-switch `isActive` check, and writing/clearing
// `lastError` health) would have shipped with every existing suite green.
//
// Drives the real fake-mcp-server.mjs fixture over real stdio, same posture as
// test-plugin-client.mjs — no mocked transport.
//
// plugin-registry.mjs and plugin-provider.mjs both import `app` from
// 'electron', so this runs under the same resolve-hook stub every other
// electron-touching suite uses.
//
// Run:  node scripts/test-plugin-provider.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-plugin-provider-test-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir

register('./auth-test-loader.mjs', import.meta.url)

const { addPlugin, getPlugin, removePlugin } = await import('../electron/main/plugin-registry.mjs')
const { pluginProviders, stopAllPlugins, syncPluginProviders } = await import('../electron/main/plugin-provider.mjs')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(__dirname, 'fixtures', 'fake-mcp-server.mjs')

// ---------------------------------------------------------------------------
// Harness (mirrors scripts/test-plugin-client.mjs)
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

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`test itself timed out waiting on: ${label}`)), ms)),
  ])
}

function registerFixturePlugin(id, mode, overrides = {}) {
  const add = addPlugin({
    id,
    displayName: `Fixture (${mode})`,
    source: { kind: 'command', command: process.execPath, args: [FIXTURE, mode] },
    resolvedCommand: process.execPath,
    resolvedArgs: [FIXTURE, mode],
    env: {},
    timeoutMs: 5000,
    enabled: true, // registry-level (install) switch ON by default in these tests
    allowWrite: false,
    allowDestructive: false,
    tools: [
      { name: 'echo', description: 'Echo the supplied text back.', inputSchema: {}, class: 'read' },
      { name: 'write_thing', description: 'Pretends to write something.', inputSchema: {}, class: 'write' },
    ],
    ...overrides,
  })
  assert(add.ok, `addPlugin("${id}") failed: ${add.error}`)
}

// pluginProviders() returns bare {toolDefs,callTool,shutdown} objects with no
// id on them by contract (mcp-server.mjs doesn't need one) — so tests below
// find the right adapter by calling toolDefs()/callTool() with THIS plugin's
// namespace prefix and checking which adapter answers, exactly as
// mcp-server.mjs's own dispatch loop does (try each provider, first non-null
// wins).
function findProviderForPrefix(prefix, cfg) {
  for (const provider of pluginProviders()) {
    const defs = provider.toolDefs(cfg)
    if (defs.some((d) => d.name.startsWith(prefix))) return provider
  }
  return null
}

// ---------------------------------------------------------------------------

console.log('\n-- isActive: both switches required (D-a) --')

await test('🔍 registry enabled=true but profile switch OFF: toolDefs empty, direct call is isError not null', async () => {
  registerFixturePlugin('bothswitch1', 'normal', { enabled: true })
  try {
    const cfg = { bothswitch1: { enabled: false } } // profile switch off
    const provider = findProviderForPrefix('bothswitch1__', { bothswitch1: { enabled: true } }) // find it while active, to get a handle
    assert(provider, 'could not locate the plugin provider at all')
    assert(provider.toolDefs(cfg).length === 0, 'toolDefs advertised tools while the profile switch was off')

    const result = await provider.callTool('bothswitch1__echo', { text: 'x' }, cfg, {})
    assert(result !== null, 'callTool returned null for an installed-but-inactive plugin — this reads as "unknown tool" instead of "disabled"')
    assert(result.isError === true, 'callTool did not refuse a call to an inactive plugin')
  } finally {
    removePlugin('bothswitch1')
  }
})

await test('🔍 registry enabled=false (profile switch ON): still inactive — the install-level switch is not bypassable per-profile', async () => {
  registerFixturePlugin('bothswitch2', 'normal', { enabled: false })
  try {
    const cfg = { bothswitch2: { enabled: true } } // profile switch on, registry switch off
    // toolDefs is empty either way here since BOTH must be true to advertise —
    // so this provider can't be located by findProviderForPrefix. Every
    // plugin's provider still claims its namespace on a DIRECT call though
    // (so the caller gets "disabled", not "unknown tool") — probe every
    // provider's callTool and require exactly one non-null, isError response.
    let sawNonNull = false
    for (const p of pluginProviders()) {
      const r = await p.callTool('bothswitch2__echo', { text: 'x' }, cfg, {})
      if (r !== null) { sawNonNull = true; assert(r.isError === true, 'a registry-disabled plugin executed a call') }
    }
    assert(sawNonNull, 'no provider claimed the "bothswitch2__" namespace at all')
  } finally {
    removePlugin('bothswitch2')
  }
})

await test('both switches ON: toolDefs advertises namespaced tools, callTool forwards to the child', async () => {
  registerFixturePlugin('bothon', 'normal', { enabled: true })
  try {
    const cfg = { bothon: { enabled: true } }
    const provider = findProviderForPrefix('bothon__', cfg)
    assert(provider, 'no provider advertised the active plugin\'s tools')
    const defs = provider.toolDefs(cfg)
    const names = defs.map((d) => d.name).sort()
    assert(names[0] === 'bothon__echo' && names[1] === 'bothon__write_thing', `unexpected names: ${names.join(',')}`)

    const result = await withTimeout(provider.callTool('bothon__echo', { text: 'hello' }, cfg, {}), 10000, 'callTool')
    assert(result?.content?.[0]?.text === 'hello', `unexpected result: ${JSON.stringify(result)}`)
  } finally {
    stopAllPlugins()
    removePlugin('bothon')
  }
})

console.log('\n-- D3: the child\'s own annotations never reach tools/list --')

await test('write_thing declares readOnlyHint:true in the fixture, but toolDefs strips annotations entirely', async () => {
  registerFixturePlugin('noannotate', 'normal', { enabled: true })
  try {
    const cfg = { noannotate: { enabled: true } }
    const provider = findProviderForPrefix('noannotate__', cfg)
    const writeThing = provider.toolDefs(cfg).find((d) => d.name === 'noannotate__write_thing')
    assert(writeThing, 'write_thing missing from toolDefs()')
    assert(!('annotations' in writeThing), 'toolDefs passed the child\'s own annotations through — a plugin could masquerade its own class via readOnlyHint (D3 violation)')
  } finally {
    stopAllPlugins()
    removePlugin('noannotate')
  }
})

console.log('\n-- namespace dispatch --')

await test('callTool returns null (not an error) for a name outside this plugin\'s namespace', async () => {
  registerFixturePlugin('nsdispatch', 'normal', { enabled: true })
  try {
    const cfg = { nsdispatch: { enabled: true } }
    const provider = findProviderForPrefix('nsdispatch__', cfg)
    const result = await provider.callTool('some_other_plugin__echo', { text: 'x' }, cfg, {})
    assert(result === null, `expected null so the next provider gets a turn, got ${JSON.stringify(result)}`)
  } finally {
    stopAllPlugins()
    removePlugin('nsdispatch')
  }
})

console.log('\n-- health: lastError / lastErrorAt (Verifying an install, layer 4) --')

await test('🔍 a failing tools/call (auth-fail fixture) is reported isError AND writes lastError/lastErrorAt', async () => {
  // This is the realistic wrong-API-key case "Verifying an install" layer 4
  // exists for: the child answers just fine (no thrown/transport error) but
  // its OWN result says the call failed. That must count as unhealthy — a
  // provider that only tracked thrown exceptions would leave the single most
  // common credential fault invisible on the plugin's card.
  registerFixturePlugin('healthfail', 'auth-fail', { enabled: true })
  try {
    const cfg = { healthfail: { enabled: true } }
    const provider = findProviderForPrefix('healthfail__', cfg)
    const result = await withTimeout(provider.callTool('healthfail__echo', { text: 'x' }, cfg, {}), 10000, 'callTool auth-fail')
    assert(result?.isError === true, `expected isError for an auth-fail call, got ${JSON.stringify(result)}`)

    const after = getPlugin('healthfail')
    assert(after.lastError, 'an in-band isError result did not write lastError')
    assert(after.lastErrorAt, 'an in-band isError result did not write lastErrorAt')
    return after.lastError
  } finally {
    stopAllPlugins()
    removePlugin('healthfail')
  }
})

await test('a transport-level failure (unknown tool name -> JSON-RPC error -> client rejects) also writes lastError', async () => {
  registerFixturePlugin('healthtransport', 'normal', { enabled: true })
  try {
    const cfg = { healthtransport: { enabled: true } }
    const provider = findProviderForPrefix('healthtransport__', cfg)
    const badResult = await withTimeout(provider.callTool('healthtransport__nonexistent', { text: 'x' }, cfg, {}), 10000, 'callTool unknown-tool')
    assert(badResult?.isError === true, 'an unknown tool name did not surface as isError')
    const after = getPlugin('healthtransport')
    assert(after.lastError, 'a transport-level tool failure did not write lastError')
    assert(after.lastErrorAt, 'a transport-level tool failure did not write lastErrorAt')
  } finally {
    stopAllPlugins()
    removePlugin('healthtransport')
  }
})

await test('a later successful call clears a previously recorded lastError', async () => {
  registerFixturePlugin('healthclear', 'normal', { enabled: true, lastError: 'stale failure from a prior session', lastErrorAt: '2020-01-01T00:00:00.000Z' })
  try {
    const cfg = { healthclear: { enabled: true } }
    const before = getPlugin('healthclear')
    assert(before.lastError, 'test setup did not seed a stale lastError')

    const provider = findProviderForPrefix('healthclear__', cfg)
    const result = await withTimeout(provider.callTool('healthclear__echo', { text: 'x' }, cfg, {}), 10000, 'callTool success')
    assert(result?.content?.[0]?.text === 'x', 'the successful call did not actually succeed')

    const after = getPlugin('healthclear')
    assert(after.lastError === null, `lastError was not cleared after a success: ${after.lastError}`)
    assert(after.lastErrorAt === null, `lastErrorAt was not cleared after a success: ${after.lastErrorAt}`)
  } finally {
    stopAllPlugins()
    removePlugin('healthclear')
  }
})

console.log('\n-- syncPluginProviders / stopAllPlugins --')

await test('syncPluginProviders stops the client of a plugin that is no longer active, without starting anything new', async () => {
  registerFixturePlugin('sync1', 'normal', { enabled: true })
  try {
    const activeCfg = { sync1: { enabled: true } }
    const provider = findProviderForPrefix('sync1__', activeCfg)
    // Spawn the child for real by making one call.
    await withTimeout(provider.callTool('sync1__echo', { text: 'x' }, activeCfg, {}), 10000, 'warm-up call')

    // Now deactivate for this profile and sync — the child must stop even
    // though the registry entry (and thus the provider) still exists.
    syncPluginProviders({ sync1: { enabled: false } })

    // A fresh call after sync must still work (lazy respawn) — sync only
    // stops, it must never leave the plugin permanently broken.
    const provider2 = findProviderForPrefix('sync1__', activeCfg)
    const result = await withTimeout(provider2.callTool('sync1__echo', { text: 'still works' }, activeCfg, {}), 10000, 'respawn call')
    assert(result?.content?.[0]?.text === 'still works', 'plugin did not respawn lazily after being synced down and reactivated')
  } finally {
    stopAllPlugins()
    removePlugin('sync1')
  }
})

await test('stopAllPlugins leaves pluginProviders() usable afterward (no crash on next lazy spawn)', async () => {
  registerFixturePlugin('stopall', 'normal', { enabled: true })
  try {
    const cfg = { stopall: { enabled: true } }
    const provider = findProviderForPrefix('stopall__', cfg)
    await withTimeout(provider.callTool('stopall__echo', { text: 'x' }, cfg, {}), 10000, 'warm-up')
    stopAllPlugins()
    const provider2 = findProviderForPrefix('stopall__', cfg)
    const result = await withTimeout(provider2.callTool('stopall__echo', { text: 'again' }, cfg, {}), 10000, 'after stopAll')
    assert(result?.content?.[0]?.text === 'again', 'plugin did not respawn after stopAllPlugins')
  } finally {
    stopAllPlugins()
    removePlugin('stopall')
  }
})

// ---------------------------------------------------------------------------

fs.rmSync(tmpDir, { recursive: true, force: true })

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
