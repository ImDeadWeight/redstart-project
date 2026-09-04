// =============================================================================
// CP3 manual round-trip (docs/notes/mcp-plugin-system-tasks.md) — NOT part of
// test:security.
// =============================================================================
// Phase 3 wires plugins into tools/list and tools/call, but there is still no
// install path (Phase 4). CP3 asks to prove the wiring by hand: write an
// entry in plugins.json pointing at the fake fixture server, enable it,
// activate it for a "profile" (here: the cfg object passed to
// startMcpServer/updateMcpConfig, which is what buildGatewayConfig would
// have produced), and confirm its two tools appear namespaced in tools/list
// — then actually call one over the real MCP transport.
//
// Same electron-stub approach as test-mcp-capabilities.mjs.
//
// Run:  node scripts/manual-cp3-plugin-roundtrip.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const tmpUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-cp3-userdata-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpUserDataDir

register('./auth-test-loader.mjs', import.meta.url)

// Explicit, main-thread trigger for the stub's platform-paths.mjs initialization.
// module.register() hooks run in a separate worker thread, so a side effect
// inside auth-test-loader.mjs itself can't reach this thread's copy of
// platform-paths.mjs -- only an ordinary import, resolved here in the main
// thread, can. Needed because production code no longer imports 'electron'
// at all in several modules this suite exercises, so nothing else would
// trigger the stub's initPaths() call.
await import('./electron-stub.mjs')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(__dirname, 'fixtures', 'fake-mcp-server.mjs')

const { startMcpServer, stopMcpServer } = await import('../electron/main/mcp-server.mjs')
const { setAuthRequired } = await import('../electron/main/auth.mjs')
const { addPlugin } = await import('../electron/main/plugin-registry.mjs')
const { setPluginCapabilityProvider } = await import('../electron/main/tools-definitions.mjs')
const { pluginCapabilities } = await import('../electron/main/plugin-registry.mjs')
const { connectMcpClient } = await import('./lib/mcp-test-client.mjs')

setAuthRequired(false)
// T12's wiring, done by hand here since index.mjs never runs under this script.
setPluginCapabilityProvider(pluginCapabilities)

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg)
  console.log('  ok  - ' + msg)
}

async function main() {
  console.log(`userData dir: ${tmpUserDataDir}`)

  const add = addPlugin({
    id: 'cp3fixture',
    displayName: 'CP3 Fixture',
    resolvedCommand: process.execPath,
    resolvedArgs: [FIXTURE, 'normal'],
    env: {},
    timeoutMs: 15000,
    enabled: true, // registry master switch (Plugins tab)
    allowWrite: true,
    allowDestructive: true,
    tools: [
      { name: 'echo', description: 'Echo the supplied text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, class: 'read' },
      { name: 'write_thing', description: 'Pretends to write something.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }, class: 'write' },
    ],
  })
  assert(add.ok, `addPlugin succeeded (${add.error ?? 'no error'})`)

  const MCP_PORT = 48099
  const cfg = {
    webFetch: { enabled: false, whitelistEnabled: true, allowedBaseUrls: [], activeTools: [], maxFetchTokens: 2000 },
    postgres: { enabled: false },
    documents: { enabled: false },
    sqlite: { enabled: false },
    vault: { enabled: false },
    git: { enabled: false },
    fileSystem: { enabled: false },
    scholar: { enabled: false },
    // The second switch (Tools tab / activeToolIds), as buildGatewayConfig
    // would have written it (T11).
    cp3fixture: { enabled: true, isPlugin: true, allowWrite: true, allowDestructive: true },
  }

  await startMcpServer(MCP_PORT, cfg)
  try {
    const client = await connectMcpClient(`http://127.0.0.1:${MCP_PORT}`)
    assert(!!client.initResult, 'initialize handshake succeeded')

    const listRes = await client.call('tools/list', {})
    const names = (listRes.result?.tools ?? []).map((t) => t.name)
    console.log('    tools/list ->', names.join(', '))
    assert(names.includes('cp3fixture__echo'), 'cp3fixture__echo present in tools/list')
    assert(names.includes('cp3fixture__write_thing'), 'cp3fixture__write_thing present in tools/list')

    const echoTool = listRes.result.tools.find((t) => t.name === 'cp3fixture__echo')
    assert(echoTool._meta?.['redstart/capability'] === 'cp3fixture', 'provenance _meta names the plugin as the capability')
    assert(echoTool._meta?.['redstart/class'] === 'read', 'provenance _meta carries the admin-assigned class')

    const callRes = await client.call('tools/call', { name: 'cp3fixture__echo', arguments: { text: 'hello from CP3' } })
    const text = callRes.result?.content?.[0]?.text
    assert(text === 'hello from CP3', `tools/call round-trips through the child (got: ${JSON.stringify(callRes.result)})`)

    console.log('\nCP3 round trip: PASS')
  } finally {
    await stopMcpServer()
    fs.rmSync(tmpUserDataDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err.stack || err.message)
  process.exitCode = 1
})
