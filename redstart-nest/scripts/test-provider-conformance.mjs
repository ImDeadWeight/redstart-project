// =============================================================================
// Provider conformance harness — one invariant battery, every MCP provider.
// =============================================================================
// The ecosystem direction (Redstart Core as shared infrastructure) requires
// every capability provider to "expose a common interface regardless of which
// application consumes them." This suite makes that a TESTED guarantee: instead
// of hand-writing the same security checks per provider, it defines them once
// and runs them against every provider over the real MCP boundary. Adding a new
// provider to the registry below gives it these invariants for free.
//
// The invariants, for every provider:
//   1. Disabled  -> none of its tools are advertised in tools/list.
//   2. Disabled  -> every one of its tools is refused on a DIRECT tools/call
//                   (isError result, not executed) — proving tools/list
//                   filtering is not the only gate.
//   3. Enabled   -> it advertises its tools.
//   4. Enabled   -> malformed input yields an isError result, never a crash or
//                   an unhandled JSON-RPC error, and the server stays up.
//
// Drives the real mcp-server.mjs over the shared SSE client. Postgres needs a
// reachable throwaway database for the enabled-phase checks (invariants 3/4);
// without one those are skipped, but its disabled-phase checks (1/2) still run.
//
// Run:  node scripts/test-provider-conformance.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import pg from 'pg'
import { connectMcpClient } from './lib/mcp-test-client.mjs'

const dirs = {
  userData: fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-conformance-userdata-')),
  docs: fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-conformance-docs-')),
  sqlite: fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-conformance-sqlite-')),
  vault: fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-conformance-vault-')),
  git: fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-conformance-git-')),
  fs: fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-conformance-fs-')),
}
process.env.REDSTART_TEST_USERDATA_DIR = dirs.userData

register('./auth-test-loader.mjs', import.meta.url)

const { startMcpServer, stopMcpServer, updateMcpConfig } = await import('../electron/main/mcp-server.mjs')
const { setAuthRequired } = await import('../electron/main/auth.mjs')
const { CAPABILITY_TOOL_NAMES } = await import('../electron/main/tools-definitions.mjs')

// This suite exercises providers, not the auth gate (which has its own suite).
setAuthRequired(false)

const MCP_PORT = 48092
const PG_URL = process.env.REDSTART_TEST_PG_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres'

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

async function isPostgresReachable(connectionString) {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 1500 })
  try {
    await client.connect()
    await client.query('SELECT 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Baseline: every capability present but DISABLED. Enabling one provider is
// this baseline plus that provider's override, so no test leaks state into the
// next.
// ---------------------------------------------------------------------------

function disabledBase() {
  return {
    webFetch: { enabled: false, whitelistEnabled: true, allowedBaseUrls: [], activeTools: [], maxFetchTokens: 2000 },
    postgres: { enabled: false, connectionString: null, maxRows: 200 },
    documents: { enabled: false, outputDir: dirs.docs },
    sqlite: { enabled: false, rootDir: dirs.sqlite, maxRows: 200 },
    vault: { enabled: false, rootDir: dirs.vault },
    git: { enabled: false, rootDir: dirs.git },
    fileSystem: { enabled: false, rootDir: dirs.fs },
    scholar: { enabled: false, venueFilter: null, saveDir: dirs.docs },
  }
}

// ---------------------------------------------------------------------------
// Provider registry. Each entry: the tool names it owns, how to enable it, the
// tools it should advertise once enabled (fs_delete_file is destructive and
// gated off by the default policy, so it is intentionally excluded), and a
// deliberately-malformed call for the bad-input invariant.
// ---------------------------------------------------------------------------

const PROVIDERS = [
  {
    name: 'web-fetch',
    tools: ['web_fetch', 'web_search'],
    enable: () => ({ webFetch: { enabled: true, whitelistEnabled: false, allowedBaseUrls: [], activeTools: [], maxFetchTokens: 2000 } }),
    advertised: ['web_fetch', 'web_search'],
    badCall: { name: 'web_fetch', arguments: {} }, // missing required url
  },
  {
    name: 'documents',
    tools: CAPABILITY_TOOL_NAMES.documents,
    enable: () => ({ documents: { enabled: true, outputDir: dirs.docs } }),
    advertised: CAPABILITY_TOOL_NAMES.documents,
    badCall: { name: 'create_document', arguments: {} }, // missing title/content
  },
  {
    name: 'sqlite',
    tools: CAPABILITY_TOOL_NAMES.sqlite,
    enable: () => ({ sqlite: { enabled: true, rootDir: dirs.sqlite, maxRows: 200 } }),
    advertised: CAPABILITY_TOOL_NAMES.sqlite,
    badCall: { name: 'sqlite_query', arguments: {} }, // missing database/sql
  },
  {
    name: 'vault',
    tools: CAPABILITY_TOOL_NAMES.vault,
    enable: () => ({ vault: { enabled: true, rootDir: dirs.vault } }),
    advertised: CAPABILITY_TOOL_NAMES.vault,
    badCall: { name: 'vault_get', arguments: { path: '../../etc/passwd' } }, // traversal
  },
  {
    name: 'git',
    tools: CAPABILITY_TOOL_NAMES.git,
    enable: () => ({ git: { enabled: true, rootDir: dirs.git } }),
    advertised: CAPABILITY_TOOL_NAMES.git,
    badCall: { name: 'git_status', arguments: { repo: '../../etc' } }, // traversal
  },
  {
    name: 'file-system',
    tools: CAPABILITY_TOOL_NAMES.file_system,
    enable: () => ({ fileSystem: { enabled: true, rootDir: dirs.fs } }),
    advertised: CAPABILITY_TOOL_NAMES.file_system.filter(n => n !== 'fs_delete_file'),
    badCall: { name: 'fs_read_file', arguments: { path: '../../../etc/passwd' } }, // traversal
  },
  {
    name: 'scholar',
    tools: CAPABILITY_TOOL_NAMES.scholar,
    enable: () => ({ scholar: { enabled: true, venueFilter: null, saveDir: dirs.docs } }),
    advertised: CAPABILITY_TOOL_NAMES.scholar,
    badCall: { name: 'scholar_get', arguments: {} }, // missing id
  },
  {
    name: 'postgres',
    tools: CAPABILITY_TOOL_NAMES.postgres,
    enable: () => ({ postgres: { enabled: true, connectionString: PG_URL, maxRows: 200 } }),
    advertised: CAPABILITY_TOOL_NAMES.postgres,
    badCall: { name: 'postgres_query', arguments: {} }, // missing sql
    needsDb: true,
  },
]

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await startMcpServer(MCP_PORT, disabledBase())
  const client = await connectMcpClient(`http://127.0.0.1:${MCP_PORT}`)

  const listNames = async () => (await client.call('tools/list')).result.tools.map(t => t.name)

  // -- Phase 1: disabled-provider invariants (all providers, all off) --------
  console.log('\n-- disabled: not advertised, not directly callable --')
  updateMcpConfig(disabledBase())

  for (const p of PROVIDERS) {
    await test(`[${p.name}] disabled: none of its tools are advertised`, async () => {
      const names = await listNames()
      const leaked = p.tools.filter(t => names.includes(t))
      assert(leaked.length === 0, `advertised while disabled: ${leaked.join(', ')}`)
    })

    await test(`🔍 [${p.name}] disabled: every tool is refused on a direct call`, async () => {
      for (const tool of p.tools) {
        const res = await client.call('tools/call', { name: tool, arguments: {} })
        assert(res.result?.isError === true, `${tool} was not refused when disabled: ${JSON.stringify(res.result ?? res.error)}`)
      }
    })
  }

  // -- Phase 2: enabled-provider invariants (one provider on at a time) ------
  console.log('\n-- enabled: advertised + malformed input is handled, not fatal --')
  const pgReachable = await isPostgresReachable(PG_URL)

  for (const p of PROVIDERS) {
    if (p.needsDb && !pgReachable) {
      console.log(`  skip - [${p.name}] enabled-phase (no database reachable at ${PG_URL.replace(/:[^:@]*@/, ':***@')})`)
      continue
    }

    updateMcpConfig({ ...disabledBase(), ...p.enable() })

    await test(`[${p.name}] enabled: advertises its tools`, async () => {
      const names = await listNames()
      const missing = p.advertised.filter(t => !names.includes(t))
      assert(missing.length === 0, `enabled but not advertised: ${missing.join(', ')}`)
    })

    await test(`🔍 [${p.name}] enabled: malformed input -> isError, not a crash`, async () => {
      const res = await client.call('tools/call', p.badCall)
      assert(res.result?.isError === true, `expected isError for ${p.badCall.name}, got ${JSON.stringify(res.result ?? res.error)}`)
    })

    updateMcpConfig(disabledBase())
  }

  // -- Phase 3: the server survived the whole battery ------------------------
  await test('the MCP server is still alive and answering after the full battery', async () => {
    const names = await listNames()
    assert(Array.isArray(names), 'tools/list did not return a tool array')
  })

  client.close()
  stopMcpServer()

  // ---------------------------------------------------------------------------
  // Cleanup + summary
  // ---------------------------------------------------------------------------
  for (const d of Object.values(dirs)) fs.rmSync(d, { recursive: true, force: true })

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
