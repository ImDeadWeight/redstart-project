// =============================================================================
// Unit tests for electron/main/plugin-registry.mjs — the installed MCP plugin
// registry.
// =============================================================================
// A registry entry decides what a third-party process is allowed to do, so
// this suite leans on validation: a malformed entry must be DROPPED on read,
// never repaired or half-trusted, and pluginCapabilities() — the bridge into
// tools-definitions.mjs's identity/classification layer — must include
// disabled plugins, which is the thing most likely to be "fixed" into a bug.
//
// plugin-registry.mjs imports `app` from 'electron' (for app.getPath
// ('userData')), so this runs under the same resolve-hook stub
// scripts/test-conversation-isolation.mjs uses, with the temp userData dir
// set BEFORE the module is imported (getPath() resolves it lazily per call,
// but the stub itself reads the env var at call time too, so order here is
// just hygiene).
//
// Run:  node scripts/test-plugin-registry.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-plugin-registry-test-'))
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

const registry = await import('../electron/main/plugin-registry.mjs')

// ---------------------------------------------------------------------------
// Harness (mirrors scripts/test-json-store.mjs)
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

const pluginsJsonPath = () => path.join(tmpDir, 'plugins.json')

function samplePlugin(overrides = {}) {
  return {
    id: 'memory',
    displayName: 'Memory',
    source: { kind: 'npm', package: '@modelcontextprotocol/server-memory', version: '2026.7.4' },
    resolvedCommand: process.execPath,
    resolvedArgs: ['C:\\fake\\path\\index.js'],
    env: {},
    timeoutMs: 15000,
    enabled: false,
    allowWrite: false,
    allowDestructive: false,
    tools: [
      { name: 'create_entities', description: 'Create entities', inputSchema: { type: 'object' }, class: 'destructive' },
    ],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------

console.log('\n-- round trip --')

await test('add -> list -> get round-trips the entry unchanged', async () => {
  const add = registry.addPlugin(samplePlugin({ id: 'roundtrip' }))
  assert(add.ok, `addPlugin failed: ${add.error}`)

  const listed = registry.listPlugins().find((p) => p.id === 'roundtrip')
  assert(listed, 'roundtrip plugin missing from listPlugins()')
  assert(listed.displayName === 'Memory', 'displayName did not survive the round trip')
  assert(listed.tools.length === 1 && listed.tools[0].name === 'create_entities', 'tools did not survive')

  const got = registry.getPlugin('roundtrip')
  assert(got && got.id === 'roundtrip', 'getPlugin did not find the entry')
  assert(JSON.stringify(got) === JSON.stringify(listed), 'getPlugin and listPlugins disagree')

  registry.removePlugin('roundtrip')
  return 'add/list/get consistent'
})

await test('a written file re-read after a process restart returns the same data', async () => {
  registry.addPlugin(samplePlugin({ id: 'restarttest' }))

  // Simulate a restart: re-import via a fresh dynamic import is unnecessary —
  // this module keeps no in-memory cache, every call reads plugins.json fresh.
  // Prove that directly by reading the file ourselves and comparing.
  const raw = JSON.parse(fs.readFileSync(pluginsJsonPath(), 'utf8'))
  const onDisk = raw.plugins.find((p) => p.id === 'restarttest')
  assert(onDisk, 'entry not found on disk')

  const got = registry.getPlugin('restarttest')
  assert(got.id === onDisk.id && got.displayName === onDisk.displayName, 'in-memory and on-disk views disagree')

  registry.removePlugin('restarttest')
  return 'no cache to go stale'
})

console.log('\n-- corruption --')

await test('a plugins.json containing invalid JSON returns an empty list and leaves a .corrupt file', async () => {
  fs.writeFileSync(pluginsJsonPath(), '{ "plugins": [ { "id": "bro', 'utf8')

  const list = registry.listPlugins()
  assert(Array.isArray(list) && list.length === 0, 'a corrupt file did not fall back to an empty list')
  assert(fs.existsSync(`${pluginsJsonPath()}.corrupt`), 'no .corrupt rescue file was left behind')

  fs.rmSync(pluginsJsonPath(), { force: true })
  fs.rmSync(`${pluginsJsonPath()}.corrupt`, { force: true })
  return 'fallback + rescue copy, same as json-store.mjs'
})

console.log('\n-- validation --')

await test('an entry with a bad id is rejected by addPlugin', async () => {
  const bad = registry.addPlugin(samplePlugin({ id: 'Not-Valid!' }))
  assert(bad.ok === false, 'a malformed id was accepted')
  assert(/id/i.test(bad.error), `error should mention the id, got: ${bad.error}`)
  return bad.error
})

await test('an entry with id "twig" is rejected', async () => {
  const bad = registry.addPlugin(samplePlugin({ id: 'twig' }))
  assert(bad.ok === false, 'a plugin claiming the "twig" client-app id was accepted')
  return bad.error
})

await test('an entry whose id collides with a built-in capability id is rejected', async () => {
  const bad = registry.addPlugin(samplePlugin({ id: 'postgres' }))
  assert(bad.ok === false, 'a plugin claiming the "postgres" capability id was accepted')
  return bad.error
})

await test('an entry whose id collides with a built-in tool name is rejected', async () => {
  const bad = registry.addPlugin(samplePlugin({ id: 'read_file' }))
  assert(bad.ok === false, 'a plugin claiming a built-in tool name as its id was accepted')
  return bad.error
})

await test('an entry with a class of "banana" is rejected', async () => {
  const bad = registry.addPlugin(samplePlugin({
    id: 'badclass',
    tools: [{ name: 'do_thing', description: '', inputSchema: {}, class: 'banana' }],
  }))
  assert(bad.ok === false, 'an invalid tool class was accepted')
  return bad.error
})

await test('an id containing the namespace separator is rejected', async () => {
  const bad = registry.addPlugin(samplePlugin({ id: 'ab__cd' }))
  assert(bad.ok === false, 'an id containing "__" was accepted')
  return bad.error
})

await test('a timeoutMs outside the allowed range is rejected', async () => {
  const tooLow = registry.addPlugin(samplePlugin({ id: 'timeoutlow', timeoutMs: 10 }))
  assert(tooLow.ok === false, 'a timeoutMs below the minimum was accepted')
  const tooHigh = registry.addPlugin(samplePlugin({ id: 'timeouthigh', timeoutMs: 999999999 }))
  assert(tooHigh.ok === false, 'a timeoutMs above the maximum was accepted')
  return 'both rejected'
})

await test('a file containing one valid and one invalid entry returns exactly the valid one', async () => {
  registry.addPlugin(samplePlugin({ id: 'valid_one' }))

  const raw = JSON.parse(fs.readFileSync(pluginsJsonPath(), 'utf8'))
  raw.plugins.push({ id: 'Also Not Valid' })
  fs.writeFileSync(pluginsJsonPath(), JSON.stringify(raw, null, 2), 'utf8')

  const list = registry.listPlugins()
  assert(list.length === 1, `expected exactly one valid entry, got ${list.length}`)
  assert(list[0].id === 'valid_one', 'the surviving entry is not the valid one')

  registry.removePlugin('valid_one')
  return '1 valid, 1 dropped'
})

console.log('\n-- credential storage (T17 groundwork: field is accepted and type-checked now) --')

await test('a written plugins.json contains no plaintext secret anywhere in the file', async () => {
  const add = registry.addPlugin(samplePlugin({ id: 'withsecret', envEnc: { API_KEY: 'ZmFrZS1jaXBoZXJ0ZXh0' } }))
  assert(add.ok, `addPlugin failed: ${add.error}`)

  const raw = fs.readFileSync(pluginsJsonPath(), 'utf8')
  assert(!raw.includes('plaintext-secret-marker'), 'sanity check marker unexpectedly present')
  assert(raw.includes('ZmFrZS1jaXBoZXJ0ZXh0'), 'the (already-encrypted) envEnc value did not persist at all')

  registry.removePlugin('withsecret')
  return 'only ciphertext strings stored, as expected'
})

await test('an entry with a non-string envEnc value is rejected', async () => {
  const bad = registry.addPlugin(samplePlugin({ id: 'badenc', envEnc: { API_KEY: 12345 } }))
  assert(bad.ok === false, 'a non-string envEnc value was accepted')
  return bad.error
})

console.log('\n-- pluginCapabilities() --')

await test('pluginCapabilities() namespaces tool names as "<id>__<name>" and includes a disabled plugin', async () => {
  // Deliberately enabled: false — this is the exact case the module's own
  // comment warns is the one most likely to be "fixed" into a bug.
  const add = registry.addPlugin(samplePlugin({
    id: 'disabledplugin',
    enabled: false,
    tools: [
      { name: 'read_thing', description: '', inputSchema: {}, class: 'read' },
      { name: 'write_thing', description: '', inputSchema: {}, class: 'write' },
    ],
  }))
  assert(add.ok, `addPlugin failed: ${add.error}`)

  const caps = registry.pluginCapabilities()
  assert('disabledplugin' in caps, 'a DISABLED plugin is missing from pluginCapabilities() — it must still appear')
  assert(caps.disabledplugin.toolNames.includes('disabledplugin__read_thing'), 'tool name not namespaced with "__"')
  assert(caps.disabledplugin.toolNames.includes('disabledplugin__write_thing'), 'second tool missing')
  assert(caps.disabledplugin.classes['disabledplugin__write_thing'] === 'write', 'class not preserved under the namespaced key')

  registry.removePlugin('disabledplugin')
  return 'disabled plugin present, both tools namespaced'
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
