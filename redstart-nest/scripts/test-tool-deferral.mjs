#!/usr/bin/env node
// =============================================================================
// Which capabilities are deferred (master plan Phase 3.1)
// =============================================================================
// The rule (tool-deferral.mjs), the stored override (tools-storage), the IPC
// setter's refusals, and the gateway config carrying the resolved list. What
// the catalog mode then does with the list is test-gateway-routes' business.
//
// Run:  node scripts/test-tool-deferral.mjs
// =============================================================================

import { registerElectronStub } from './electron-stub-hooks.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-deferral-test-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir
registerElectronStub()
await import('./electron-stub.mjs')

const { deferredCapabilities, isDeferredTool, DEFERRED_BY_DEFAULT } = await import('../daemon/tool-deferral.mjs')
const { getDeferralOverrides, setDeferralOverride } = await import('../daemon/tools-storage.mjs')
const { setDeferredConfig, getCapabilitiesConfig } = await import('../daemon/ipc/capabilities.mjs')
const { buildGatewayConfig } = await import('../daemon/gateway-config.mjs')
const { BUILTIN_CAPABILITIES, capabilityForTool } = await import('../daemon/tools-definitions.mjs')

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
function assert(cond, message) { if (!cond) throw new Error(message) }
function eq(a, b, what) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}\n        expected ${JSON.stringify(b)}\n        got      ${JSON.stringify(a)}`)
}

const builtinIds = BUILTIN_CAPABILITIES.map((c) => c.id)
const noop = { refreshLiveToolsConfig: () => {} }

console.log('\n-- the rule --')

await test('🔍 the defaults: six built-ins deferred, the core not, every plugin deferred', () => {
  const out = deferredCapabilities({ builtinIds, pluginIds: ['comfy'] })
  eq(out, [...DEFERRED_BY_DEFAULT, 'comfy'].sort(), 'deferred')
  for (const core of ['documents', 'python', 'memory', 'document_search']) assert(!out.includes(core), `${core} is deferred by default`)
})

await test('an override wins both ways; a non-boolean is ignored', () => {
  const out = deferredCapabilities({ builtinIds, pluginIds: ['comfy'], overrides: { git: false, python: true, comfy: false, sqlite: 'no', vault: 1 } })
  assert(!out.includes('git') && out.includes('python') && !out.includes('comfy'), out.join(','))
  assert(out.includes('sqlite') && out.includes('vault'), 'a non-boolean override changed the default')
})

await test('🔍 a tool is deferred by its capability; a client tool or an unknown name never is', () => {
  const cfg = { deferredCapabilities: ['file_system', 'git'] }
  assert(isDeferredTool('write_file', cfg, capabilityForTool), 'write_file')
  assert(isDeferredTool('git_log', cfg, capabilityForTool), 'git_log')
  assert(!isDeferredTool('read_document', cfg, capabilityForTool), 'read_document')
  assert(!isDeferredTool('fs_read_file', cfg, capabilityForTool), "Twig's fs_read_file")
  assert(!isDeferredTool('not_a_tool', cfg, capabilityForTool), 'an unknown name')
  assert(!isDeferredTool('write_file', {}, capabilityForTool), 'no list means nothing is deferred')
})

console.log('\n-- storage and IPC --')

await test('🔍 the override round-trips, and null goes back to the default', () => {
  setDeferralOverride('git', false)
  eq(getDeferralOverrides(), { git: false }, 'stored')
  setDeferralOverride('git', null)
  eq(getDeferralOverrides(), {}, 'cleared')
})

await test('🔒 the setter refuses an unknown id and a non-boolean, and stores nothing', () => {
  for (const bad of [{ id: 'nope', deferred: true }, { id: 'git', deferred: 'yes' }, { id: 42, deferred: true }, null, 'git']) {
    const r = setDeferredConfig(bad, noop)
    assert(r && r.ok === false, `accepted ${JSON.stringify(bad)}`)
  }
  eq(getDeferralOverrides(), {}, 'something was stored')
})

await test('the setter saves, refreshes the live config, and the status reports it', () => {
  let refreshed = 0
  const r = setDeferredConfig({ id: 'documents', deferred: true }, { refreshLiveToolsConfig: () => { refreshed++ } })
  assert(r.ok && refreshed === 1, `ok=${r.ok}, refreshed ${refreshed}`)
  const row = getCapabilitiesConfig().deferral.find((d) => d.id === 'documents')
  eq(row, { id: 'documents', name: row.name, plugin: false, byDefault: false, overridden: true, deferred: true }, 'status row')
  setDeferredConfig({ id: 'documents', deferred: null }, noop)
})

await test('catalogContents groups by capability, pools plugins without their prefix, and caps both', async () => {
  const { catalogContents, CATALOG_NAMES_PER_GROUP, CATALOG_PLUGIN_NAMES } = await import('../daemon/tool-deferral.mjs')
  const { builtinCapabilityName } = await import('../daemon/tools-definitions.mjs')
  const plugin = (n) => `someplugin__tool_${n}`
  const capOf = (name) => (name.startsWith('someplugin__') ? 'someplugin' : capabilityForTool(name))
  const got = catalogContents(
    ['git_log', 'write_file', 'delete_file', 'git_status', plugin(1), plugin(1), 'not_a_tool', '', null],
    capOf, builtinCapabilityName)
  eq(got.groups, [
    { label: 'File System', tools: ['write_file', 'delete_file'], more: 0 },
    { label: 'Git', tools: ['git_log', 'git_status'], more: 0 },
  ], 'groups, by label, in the order removed')
  eq(got.plugins, { tools: ['tool_1', 'not_a_tool'], more: 0 }, 'plugins pooled, prefix dropped, repeats once')
  const many = catalogContents(Array.from({ length: CATALOG_PLUGIN_NAMES + 3 }, (_, i) => plugin(i)), capOf, builtinCapabilityName)
  eq([many.plugins.tools.length, many.plugins.more], [CATALOG_PLUGIN_NAMES, 3], 'plugin cap')
  const fs = catalogContents(Array.from({ length: CATALOG_NAMES_PER_GROUP + 2 }, (_, i) => `fs${i}`), () => 'file_system', builtinCapabilityName)
  eq([fs.groups[0].tools.length, fs.groups[0].more], [CATALOG_NAMES_PER_GROUP, 2], 'per-group cap')
  eq(catalogContents([], capOf, builtinCapabilityName), { groups: [], plugins: null }, 'nothing removed')
})

await test('🔍 the gateway config carries the resolved list, tools on or off', () => {
  setDeferralOverride('git', false)
  for (const enabled of [true, false]) {
    const cfg = buildGatewayConfig({ ctxSize: 4096, tools: { enabled, activeToolIds: [] } })
    assert(Array.isArray(cfg.deferredCapabilities), `no list with tools ${enabled ? 'on' : 'off'}`)
    assert(cfg.deferredCapabilities.includes('file_system') && !cfg.deferredCapabilities.includes('git'), cfg.deferredCapabilities.join(','))
    // The tool-text arm rides along the same way (tool-text-arms.mjs).
    assert(cfg.toolTextArm === 'a', `default arm ${cfg.toolTextArm}`)
    for (const [asked, got] of [['b', 'b'], ['c', 'c'], ['z', 'a']]) {
      const armed = buildGatewayConfig({ ctxSize: 4096, toolTextArm: asked, tools: { enabled, activeToolIds: [] } })
      assert(armed.toolTextArm === got, `asked ${asked}, got ${armed.toolTextArm}`)
    }
  }
  setDeferralOverride('git', null)
})

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
fs.rmSync(tmpDir, { recursive: true, force: true })
if (failed.length) {
  console.log(`${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}`)
  process.exit(1)
}
