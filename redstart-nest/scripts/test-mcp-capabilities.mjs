// =============================================================================
// Manual/CI smoke test for the Postgres and Documents MCP capability providers.
// =============================================================================
// Spins up the REAL mcp-server.mjs (production code, unmodified) and drives it
// over real HTTP + the actual MCP SSE/JSON-RPC transport — same electron-stub
// approach as test-auth.mjs, since mcp-server.mjs -> auth.mjs ->
// accounts-storage.mjs calls Electron's app.getPath().
//
// Documents tests always run (pure local file I/O, no external dependency).
// Postgres tests run against a real database if one is reachable
// (REDSTART_TEST_PG_URL, or postgresql://postgres:postgres@127.0.0.1:5432/postgres
// by default) — otherwise they're skipped with a clear message, except the
// "disabled" gating checks, which need no database at all.
//
// Run:  node scripts/test-mcp-capabilities.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_FIXTURE = path.join(__dirname, 'fixtures', 'fake-mcp-server.mjs')

const tmpUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-mcp-test-userdata-'))
const tmpDocsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-mcp-test-docs-'))
const tmpSqliteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-mcp-test-sqlite-'))
const tmpVaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-mcp-test-vault-'))
const tmpGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-mcp-test-git-'))
const tmpFsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-mcp-test-fs-'))

// Per-account storage: every capability that WRITES now serves each caller from
// its own folder inside the configured root, so a fixture dropped in the root
// itself is invisible to the tools. This suite runs with auth off, which is the
// defined anonymous scope — so these are the directories the tools actually
// read from and write to. (Cross-account isolation itself is proven separately
// in test-file-isolation.mjs; here the scoped dirs are only fixture plumbing.)
const scopedDocsDir = path.join(tmpDocsDir, 'user_files', '_local')
const scopedFsDir = path.join(tmpFsDir, 'user_files', '_local')
fs.mkdirSync(scopedDocsDir, { recursive: true })
fs.mkdirSync(scopedFsDir, { recursive: true })
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

const { startMcpServer, stopMcpServer } = await import('../electron/main/mcp-server.mjs')
const { setAuthRequired } = await import('../electron/main/auth.mjs')
const { capabilityForTool, classifyTool, expandDisabledToolIds, setPluginCapabilityProvider } = await import('../electron/main/tools-definitions.mjs')
const { addPlugin, removePlugin, pluginCapabilities } = await import('../electron/main/plugin-registry.mjs')

// Real app startup wires this in electron/main/index.mjs; this suite imports
// mcp-server.mjs and plugin-registry.mjs independently of that bootstrap, so
// it has to do the same wiring itself or every plugin-ban test below would
// pass for the wrong reason (capabilityToolNames() would simply never see the
// plugin at all, rather than genuinely proving the ban).
setPluginCapabilityProvider(pluginCapabilities)

// Auth is ON by default (secure default, no localhost bypass) and this suite's
// MCP client connects token-less. Auth behavior has its own suite
// (test-auth.mjs); here it is explicitly switched off so capability tests
// exercise the providers, not the gate.
setAuthRequired(false)

const MCP_PORT = 48091
const PG_URL = process.env.REDSTART_TEST_PG_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres'

// ---------------------------------------------------------------------------
// Tiny test harness (mirrors scripts/test-auth.mjs)
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

// Minimal MCP SSE/JSON-RPC client — shared with the other boundary suites.
import { connectMcpClient } from './lib/mcp-test-client.mjs'

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
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`userData dir: ${tmpUserDataDir}`)
  console.log(`documents output dir: ${tmpDocsDir}`)

  const baseConfig = {
    webFetch: { enabled: true, whitelistEnabled: true, allowedBaseUrls: ['https://en.wikipedia.org'], activeTools: [{ name: 'Wikipedia', baseUrl: 'https://en.wikipedia.org', description: '' }], maxFetchTokens: 2000 },
    postgres: { enabled: false, connectionString: null, maxRows: 200 },
    documents: { enabled: false, outputDir: tmpDocsDir },
    sqlite: { enabled: false, rootDir: tmpSqliteDir, maxRows: 200 },
    vault: { enabled: false, rootDir: tmpVaultDir },
    git: { enabled: false, rootDir: tmpGitDir },
    fileSystem: { enabled: false, rootDir: tmpFsDir },
    scholar: { enabled: false, venueFilter: null, saveDir: tmpDocsDir },
  }

  await startMcpServer(MCP_PORT, baseConfig)
  const mcpUrl = `http://127.0.0.1:${MCP_PORT}`

  console.log('\n-- default capability folder provisioning --')

  {
    const storage = await import('../electron/main/tools-storage.mjs')
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-default-folders-'))

    await test('first run provisions Documents/Databases/Notes/Repos and sets paths', async () => {
      const applied = storage.ensureDefaultCapabilityFolders(base)
      for (const [cap, sub] of [['documents', 'Documents'], ['sqlite', 'Databases'], ['vault', 'Notes'], ['git', 'Repos']]) {
        const expected = path.join(base, sub)
        assert(fs.existsSync(expected), `folder missing: ${expected}`)
        assert(applied[cap] === expected, `path not applied for ${cap}: ${JSON.stringify(applied)}`)
      }
      const caps = storage.getCapabilities()
      assert(caps.documents.outputDir === path.join(base, 'Documents'), 'documents outputDir not persisted')
      assert(caps.vault.rootDir === path.join(base, 'Notes'), 'vault rootDir not persisted')
    })

    await test('capabilities stay disabled after provisioning (two-key model intact)', async () => {
      const caps = storage.getCapabilities()
      for (const cap of ['documents', 'sqlite', 'vault', 'git']) {
        assert(caps[cap].enabled === false, `${cap} unexpectedly enabled`)
      }
    })

    await test('re-run is idempotent and never overrides a user-chosen path', async () => {
      const userChoice = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-user-vault-'))
      storage.setCapabilityConfig('vault', { rootDir: userChoice })
      const applied = storage.ensureDefaultCapabilityFolders(base)
      assert(!('vault' in applied), `vault path was re-applied: ${JSON.stringify(applied)}`)
      assert(storage.getCapabilities().vault.rootDir === userChoice, 'user-chosen vault path was clobbered')
      fs.rmSync(userChoice, { recursive: true, force: true })
    })

    // Reset paths the provisioning wrote so later sections configure their own
    // temp dirs from a clean slate.
    for (const [cap, field] of [['documents', 'outputDir'], ['sqlite', 'rootDir'], ['vault', 'rootDir'], ['git', 'rootDir']]) {
      storage.setCapabilityConfig(cap, { [field]: null })
    }
    fs.rmSync(base, { recursive: true, force: true })
  }

  console.log('\n-- provider registry / regression check --')

  let client = await connectMcpClient(mcpUrl)

  await test('tools/list includes web_fetch when a web source is active (unaffected by the provider refactor)', async () => {
    const res = await client.call('tools/list')
    const names = res.result.tools.map(t => t.name)
    assert(names.includes('web_fetch'), `expected web_fetch in ${JSON.stringify(names)}`)
  })

  await test('tools/list omits create_document and postgres_* when both capabilities are disabled', async () => {
    const res = await client.call('tools/list')
    const names = res.result.tools.map(t => t.name)
    assert(!names.includes('create_document'), `did not expect create_document in ${JSON.stringify(names)}`)
    assert(!names.some(n => n.startsWith('postgres_')), `did not expect postgres_* in ${JSON.stringify(names)}`)
  })

  await test('tools/call on a disabled postgres tool returns isError, not a crash', async () => {
    const res = await client.call('tools/call', { name: 'postgres_query', arguments: { sql: 'SELECT 1' } })
    assert(res.result?.isError === true, `expected isError:true, got ${JSON.stringify(res.result)}`)
  })

  await test('tools/call on an entirely unknown tool name -> JSON-RPC error, not a crash', async () => {
    const res = await client.call('tools/call', { name: 'not_a_real_tool', arguments: {} })
    assert(res.error?.code === -32601, `expected -32601, got ${JSON.stringify(res)}`)
  })

  const { updateMcpConfig } = await import('../electron/main/mcp-server.mjs')

  console.log('\n-- web_fetch / web_search policy (offline) --')

  await test('tools/list includes web_search when a search-capable source is whitelisted', async () => {
    const res = await client.call('tools/list')
    const search = res.result.tools.find(t => t.name === 'web_search')
    assert(search, 'web_search missing')
    assert(search.inputSchema.properties.source.enum.includes('wikipedia'), `wikipedia not offered: ${JSON.stringify(search.inputSchema.properties.source)}`)
    assert(!search.inputSchema.properties.source.enum.includes('mdn'), 'mdn offered despite not being whitelisted')
  })

  await test('web_search on a non-whitelisted source -> isError listing what is available', async () => {
    const res = await client.call('tools/call', { name: 'web_search', arguments: { source: 'mdn', query: 'flexbox' } })
    assert(res.result?.isError === true && res.result.content[0].text.includes('wikipedia'), `unexpected: ${JSON.stringify(res.result)}`)
  })

  await test('🔍 whitelist ON: non-whitelisted domain fetch is denied without a network call', async () => {
    const res = await client.call('tools/call', { name: 'web_fetch', arguments: { url: 'https://example.com/page' } })
    assert(res.result?.isError === true && res.result.content[0].text.includes('Access denied'), `unexpected: ${JSON.stringify(res.result)}`)
  })

  {
    const openConfig = { ...baseConfig, webFetch: { enabled: true, whitelistEnabled: false, allowedBaseUrls: [], activeTools: [], maxFetchTokens: 2000 } }
    updateMcpConfig(openConfig)

    await test('whitelist OFF: web_search offers every search source', async () => {
      const res = await client.call('tools/list')
      const search = res.result.tools.find(t => t.name === 'web_search')
      for (const s of ['wikipedia', 'arxiv', 'pubmed', 'mdn', 'stackoverflow']) {
        assert(search.inputSchema.properties.source.enum.includes(s), `${s} missing from open-mode sources`)
      }
    })

    await test('🔍 whitelist OFF: private/LAN addresses are still blocked (SSRF guard)', async () => {
      for (const url of ['http://192.168.1.1/admin', 'http://127.0.0.1:19082/sse', 'http://localhost:19080/', 'http://10.0.0.5/', 'http://169.254.1.1/', 'http://[::1]:19081/']) {
        const res = await client.call('tools/call', { name: 'web_fetch', arguments: { url } })
        assert(res.result?.isError === true && res.result.content[0].text.includes('not a public http(s) address'), `${url} was not blocked: ${JSON.stringify(res.result)}`)
      }
    })

    await test('🔍 whitelist OFF: non-http schemes are blocked', async () => {
      const res = await client.call('tools/call', { name: 'web_fetch', arguments: { url: 'file:///C:/Windows/system.ini' } })
      assert(res.result?.isError === true, `file:// not blocked: ${JSON.stringify(res.result)}`)
    })

    updateMcpConfig(baseConfig)
  }

  console.log('\n-- web_fetch redirect re-validation (SSRF via redirect) --')

  // web-fetch-tool.mjs follows redirects MANUALLY, re-validating every hop
  // against the SAME policy as the original URL, so a whitelisted page cannot
  // bounce the fetch to a disallowed destination (a shortener, a consent page —
  // or, the SSRF case, a public/allowed URL redirecting to a LAN address). This
  // guard is implemented but was previously untested; these cases lock it in.
  //
  // Two throwaway loopback origins stand in for "approved" and "off-limits":
  // isAllowed() matches on hostname, so the whitelist trusts host `localhost`
  // while the redirect target host `127.0.0.1` is a different, untrusted host.
  // The off-limits server counts every hit, so we can prove the blocked hop
  // generates NO network traffic to the destination.
  {
    let secretHits = 0
    const offLimits = http.createServer((req, res) => {
      secretHits++
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('TOP SECRET LAN CONTENT — should never be reached')
    })
    const origin = http.createServer((req, res) => {
      const url = req.url || '/'
      if (url.startsWith('/redirect-to-blocked')) {
        // Bounce to a different (untrusted) host — the SSRF-via-redirect move.
        res.writeHead(302, { Location: `http://127.0.0.1:${offLimits.address().port}/secret` })
        res.end()
      } else if (url.startsWith('/redirect-to-allowed')) {
        // Bounce within the approved host — must be followed, not blocked.
        res.writeHead(302, { Location: `http://localhost:${origin.address().port}/final` })
        res.end()
      } else if (url.startsWith('/final')) {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('REDIRECT_FOLLOWED_OK — this is the real destination body.')
      } else if (url.startsWith('/loop')) {
        res.writeHead(302, { Location: `http://localhost:${origin.address().port}/loop` })
        res.end()
      } else {
        res.writeHead(404); res.end()
      }
    })

    await new Promise(r => offLimits.listen(0, r))
    await new Promise(r => origin.listen(0, r))
    const originUrl = `http://localhost:${origin.address().port}`

    // Whitelist ONLY the approved origin host. Port is irrelevant to isAllowed
    // (it matches on hostname), which is exactly why the 127.0.0.1 target is
    // out of scope even though it is also loopback.
    const redirectConfig = { ...baseConfig, webFetch: { enabled: true, whitelistEnabled: true, allowedBaseUrls: [originUrl], activeTools: [{ name: 'Origin', baseUrl: originUrl, description: '' }], maxFetchTokens: 2000 } }
    updateMcpConfig(redirectConfig)

    try {
      await test('🔍 an approved page redirecting to an off-limits host is refused, with NO request to the destination', async () => {
        const res = await client.call('tools/call', { name: 'web_fetch', arguments: { url: `${originUrl}/redirect-to-blocked` } })
        assert(res.result?.isError === true, `expected isError, got ${JSON.stringify(res.result)}`)
        assert(/not an approved address/.test(res.result.content[0].text), `unexpected message: ${res.result.content[0].text}`)
        assert(secretHits === 0, `the blocked destination was contacted ${secretHits} time(s) — re-validation happened too late`)
      })

      await test('a redirect within the approved host is followed and returns the destination body', async () => {
        const res = await client.call('tools/call', { name: 'web_fetch', arguments: { url: `${originUrl}/redirect-to-allowed` } })
        assert(!res.result?.isError, `unexpected error: ${JSON.stringify(res.result)}`)
        assert(res.result.content[0].text.includes('REDIRECT_FOLLOWED_OK'), `did not follow to destination: ${res.result.content[0].text.slice(0, 120)}`)
      })

      await test('a redirect loop is bounded and reported, not hung', async () => {
        const res = await client.call('tools/call', { name: 'web_fetch', arguments: { url: `${originUrl}/loop` } })
        assert(res.result?.isError === true && /Too many redirects/i.test(res.result.content[0].text), `unexpected: ${JSON.stringify(res.result)}`)
      })
    } finally {
      updateMcpConfig(baseConfig)
      await new Promise(r => origin.close(r))
      await new Promise(r => offLimits.close(r))
    }
  }

  if (process.env.REDSTART_TEST_LIVE_WEB === '1') {
    await test('LIVE: web_search(wikipedia) returns titled results', async () => {
      const res = await client.call('tools/call', { name: 'web_search', arguments: { source: 'wikipedia', query: 'community health worker' } })
      assert(!res.result?.isError && res.result.content[0].text.includes('en.wikipedia.org/wiki/'), `unexpected: ${JSON.stringify(res.result)}`)
    })
    await test('LIVE: web_fetch extracts article body, not nav soup', async () => {
      const res = await client.call('tools/call', { name: 'web_fetch', arguments: { url: 'https://en.wikipedia.org/wiki/Community_health_worker' } })
      const text = res.result.content[0].text
      assert(text.includes('# Community health worker'), `no extracted title: ${text.slice(0, 200)}`)
      assert(text.includes('community') && !text.slice(0, 500).includes('Jump to content'), `looks like nav soup: ${text.slice(0, 200)}`)
    })
  } else {
    console.log('  skip - live web tests (set REDSTART_TEST_LIVE_WEB=1 to run)')
  }

  console.log('\n-- documents provider --')

  // Live-update config: documents enabled, postgres still off.
  updateMcpConfig({ ...baseConfig, documents: { enabled: true, outputDir: tmpDocsDir } })

  await test('tools/list includes create_document once enabled', async () => {
    const res = await client.call('tools/list')
    const names = res.result.tools.map(t => t.name)
    assert(names.includes('create_document'), `expected create_document in ${JSON.stringify(names)}`)
  })

  for (const format of ['markdown', 'docx', 'pdf']) {
    await test(`create_document writes a real, non-empty .${format === 'markdown' ? 'md' : format} file`, async () => {
      const res = await client.call('tools/call', {
        name: 'create_document',
        arguments: { title: `Test Report ${format}`, content: '# Heading\n\nA paragraph.\n\n- bullet one\n- bullet two', format },
      })
      assert(!res.result?.isError, `unexpected error: ${JSON.stringify(res.result)}`)
      const text = res.result.content[0].text
      const match = text.match(/Document created: (.+)$/)
      assert(match, `unexpected result text: ${text}`)
      const filePath = match[1]
      assert(fs.existsSync(filePath), `file does not exist: ${filePath}`)
      const stat = fs.statSync(filePath)
      assert(stat.size > 0, 'file is empty')

      if (format === 'markdown') {
        assert(fs.readFileSync(filePath, 'utf8').includes('Heading'), 'markdown content missing expected text')
      } else if (format === 'docx') {
        assert(fs.readFileSync(filePath).subarray(0, 2).toString() === 'PK', 'docx file missing zip signature')
      } else if (format === 'pdf') {
        assert(fs.readFileSync(filePath).subarray(0, 4).toString() === '%PDF', 'pdf file missing %PDF header')
      }
      return path.basename(filePath)
    })
  }

  await test('create_document writes a runnable .py script verbatim (no title heading)', async () => {
    const source = 'import sys\n\n\ndef main():\n    if len(sys.argv) > 1:\n        print(sys.argv[1])\n\n\nmain()'
    const res = await client.call('tools/call', {
      name: 'create_document',
      arguments: { title: 'Echo Arg', content: source, format: 'python' },
    })
    assert(!res.result?.isError, `unexpected error: ${JSON.stringify(res.result)}`)
    const filePath = res.result.content[0].text.match(/Document created: (.+)$/)[1]
    assert(filePath.endsWith('.py'), `expected a .py file, got ${filePath}`)
    const written = fs.readFileSync(filePath, 'utf8')
    assert(written === source, `script was not written verbatim:\n${JSON.stringify(written)}`)
    assert(!written.startsWith('#'), 'a title heading was prepended to the script')
    return path.basename(filePath)
  })

  await test('create_document (python) strips an enclosing markdown code fence', async () => {
    const res = await client.call('tools/call', {
      name: 'create_document',
      arguments: { title: 'Fenced Script', content: '```python\nprint("hi")\n```', format: 'python' },
    })
    const filePath = res.result.content[0].text.match(/Document created: (.+)$/)[1]
    const written = fs.readFileSync(filePath, 'utf8')
    assert(!written.includes('```'), `fence survived into the script: ${JSON.stringify(written)}`)
    assert(written.trim() === 'print("hi")', `unexpected script body: ${JSON.stringify(written)}`)
  })

  await test('create_document (python) emits a [FILE:] marker so the UI can offer a download', async () => {
    const res = await client.call('tools/call', {
      name: 'create_document',
      arguments: { title: 'Downloadable Script', content: 'print(1)', format: 'python' },
    })
    const text = res.result.content[0].text
    const marker = text.match(/^\[FILE: (.+)\]$/m)
    assert(marker, `no [FILE:] marker in result: ${text}`)
    assert(marker[1].endsWith('.py'), `marker path is not the script: ${marker[1]}`)
    assert(fs.existsSync(path.join(scopedDocsDir, marker[1])), `marker path does not resolve under the caller's docs root: ${marker[1]}`)
  })

  await test('a filename argument ending in .py infers the python format', async () => {
    const res = await client.call('tools/call', {
      name: 'create_document',
      arguments: { filename: 'batch_rename.py', content: 'print("renamed")' },
    })
    assert(!res.result?.isError, `unexpected error: ${JSON.stringify(res.result)}`)
    const filePath = res.result.content[0].text.match(/Document created: (.+)$/)[1]
    assert(filePath.endsWith('.py'), `expected a .py file, got ${filePath}`)
    assert(fs.readFileSync(filePath, 'utf8').trim() === 'print("renamed")', 'script body was altered')
  })

  // slugify() maps every non-alphanumeric run to '-', so an extension left on
  // the title used to survive as part of the NAME — 'sum_of_odds.py' landed as
  // 'sum-of-odds-py.py'. Models write titles that way constantly despite the
  // schema saying not to, so a recognised extension is stripped instead.
  await test('a title that carries its extension does not have it mangled into the name', async () => {
    const res = await client.call('tools/call', {
      name: 'create_document',
      arguments: { title: 'sum_of_odds.py', content: 'print(sum(range(1, 100, 2)))', format: 'python' },
    })
    assert(!res.result?.isError, `unexpected error: ${JSON.stringify(res.result)}`)
    const filePath = res.result.content[0].text.match(/Document created: (.+)$/)[1]
    const name = path.basename(filePath)
    assert(name === 'sum-of-odds.py', `expected 'sum-of-odds.py', got '${name}'`)
  })

  // The guard on the above: only KNOWN format extensions are stripped, so a
  // version number at the end of a real title is not mistaken for one.
  await test('a version-numbered title keeps its trailing segment', async () => {
    const res = await client.call('tools/call', {
      name: 'create_document',
      arguments: { title: 'Q3 Report v1.2', content: 'body', format: 'markdown' },
    })
    const name = path.basename(res.result.content[0].text.match(/Document created: (.+)$/)[1])
    assert(name === 'q3-report-v1-2.md', `expected the '.2' to survive as part of the title, got '${name}'`)
  })

  // A created document is not reachable through the File System tools — they
  // are a different root. The result says so at the point of creation, because
  // a model that guesses wrong here burns several calls discovering it.
  await test('create_document names read_document as the way to read it back', async () => {
    const res = await client.call('tools/call', {
      name: 'create_document',
      arguments: { title: 'Pointer Check', content: 'body', format: 'markdown' },
    })
    const text = res.result.content[0].text
    assert(text.includes('read_document'), `result does not name read_document: ${text}`)
    assert(/read_text_file/.test(text), `result does not warn off the File System tools: ${text}`)
  })

  await test('round trip: create_document (python) then read_document returns the source', async () => {
    const created = await client.call('tools/call', {
      name: 'create_document',
      arguments: { title: 'Readable Script', content: 'THRESHOLD = 4417\nprint(THRESHOLD)', format: 'python' },
    })
    const filename = path.basename(created.result.content[0].text.match(/Document created: (.+)$/)[1])
    const read = await client.call('tools/call', { name: 'read_document', arguments: { path: filename } })
    assert(!read.result?.isError, `read failed: ${JSON.stringify(read.result)}`)
    assert(read.result.content[0].text.includes('THRESHOLD = 4417'), `source missing: ${read.result.content[0].text}`)
  })

  await test('a second create_document with the same title gets a distinct filename, not an overwrite', async () => {
    const first = await client.call('tools/call', { name: 'create_document', arguments: { title: 'Duplicate Title', content: 'first', format: 'markdown' } })
    const second = await client.call('tools/call', { name: 'create_document', arguments: { title: 'Duplicate Title', content: 'second', format: 'markdown' } })
    const firstPath = first.result.content[0].text.match(/Document created: (.+)$/)[1]
    const secondPath = second.result.content[0].text.match(/Document created: (.+)$/)[1]
    assert(firstPath !== secondPath, `expected distinct paths, both were ${firstPath}`)
    assert(fs.readFileSync(firstPath, 'utf8').includes('first'), 'first file was overwritten')
    assert(fs.readFileSync(secondPath, 'utf8').includes('second'), 'second file has wrong content')
  })

  await test('🔍 a title containing path-traversal segments cannot escape the configured output directory', async () => {
    const res = await client.call('tools/call', { name: 'create_document', arguments: { title: '../../../../evil', content: 'x', format: 'markdown' } })
    assert(!res.result?.isError, `unexpected error: ${JSON.stringify(res.result)}`)
    const filePath = res.result.content[0].text.match(/Document created: (.+)$/)[1]
    const resolvedDocsDir = path.resolve(scopedDocsDir)
    const resolvedFile = path.resolve(filePath)
    assert(resolvedFile === resolvedDocsDir || resolvedFile.startsWith(resolvedDocsDir + path.sep),
      `file escaped the output directory: ${resolvedFile}`)
  })

  await test('create_document with a missing content argument -> isError', async () => {
    const res = await client.call('tools/call', { name: 'create_document', arguments: { title: 'No Content', format: 'markdown' } })
    assert(res.result?.isError === true, `expected isError:true, got ${JSON.stringify(res.result)}`)
  })

  await test('create_document with an invalid format -> isError', async () => {
    const res = await client.call('tools/call', { name: 'create_document', arguments: { title: 'Bad Format', content: 'x', format: 'exe' } })
    assert(res.result?.isError === true, `expected isError:true, got ${JSON.stringify(res.result)}`)
  })

  console.log('\n-- documents provider: reading --')

  await test('tools/list includes read_document and list_documents alongside create_document', async () => {
    const res = await client.call('tools/list')
    const names = res.result.tools.map(t => t.name)
    for (const n of ['read_document', 'list_documents']) assert(names.includes(n), `expected ${n} in ${JSON.stringify(names)}`)
  })

  await test('round trip: create_document (.md) then read_document returns the content', async () => {
    const created = await client.call('tools/call', { name: 'create_document', arguments: { title: 'Round Trip', content: 'The quarterly summary mentions Maple Street.', format: 'markdown' } })
    assert(!created.result?.isError, `create failed: ${JSON.stringify(created.result)}`)
    const filename = path.basename(created.result.content[0].text.match(/Document created: (.+)$/)[1])
    const read = await client.call('tools/call', { name: 'read_document', arguments: { path: filename } })
    assert(!read.result?.isError, `read failed: ${JSON.stringify(read.result)}`)
    assert(read.result.content[0].text.includes('Maple Street'), `content missing: ${read.result.content[0].text}`)
  })

  await test('round trip: create_document (.docx) then read_document extracts the text', async () => {
    const created = await client.call('tools/call', { name: 'create_document', arguments: { title: 'Docx Round Trip', content: 'Intake notes reference case 4417.', format: 'docx' } })
    const filename = path.basename(created.result.content[0].text.match(/Document created: (.+)$/)[1])
    const read = await client.call('tools/call', { name: 'read_document', arguments: { path: filename } })
    assert(!read.result?.isError, `read failed: ${JSON.stringify(read.result)}`)
    assert(read.result.content[0].text.includes('case 4417'), `content missing: ${read.result.content[0].text}`)
  })

  await test('round trip: create_document (.pdf) then read_document extracts the text', async () => {
    const created = await client.call('tools/call', { name: 'create_document', arguments: { title: 'Pdf Round Trip', content: 'The policy manual covers reimbursement.', format: 'pdf' } })
    const filename = path.basename(created.result.content[0].text.match(/Document created: (.+)$/)[1])
    const read = await client.call('tools/call', { name: 'read_document', arguments: { path: filename } })
    assert(!read.result?.isError, `read failed: ${JSON.stringify(read.result)}`)
    assert(read.result.content[0].text.includes('reimbursement'), `content missing: ${read.result.content[0].text}`)
  })

  await test('read_document paginates long files via offset', async () => {
    fs.writeFileSync(path.join(scopedDocsDir, 'long.txt'), 'A'.repeat(9000) + 'ZEBRA-MARKER')
    const first = await client.call('tools/call', { name: 'read_document', arguments: { path: 'long.txt' } })
    const firstText = first.result.content[0].text
    assert(firstText.includes('Truncated') && firstText.includes('offset=8000'), `expected truncation notice: ...${firstText.slice(-140)}`)
    const second = await client.call('tools/call', { name: 'read_document', arguments: { path: 'long.txt', offset: 8000 } })
    assert(second.result.content[0].text.includes('ZEBRA-MARKER'), `expected tail content: ${second.result.content[0].text.slice(0, 160)}`)
  })

  await test('list_documents lists readable files with sizes', async () => {
    const res = await client.call('tools/call', { name: 'list_documents', arguments: {} })
    const text = res.result.content[0].text
    assert(text.includes('long.txt') && text.includes('KB'), `unexpected listing: ${text}`)
  })

  await test('🔍 read_document with traversal segments is rejected', async () => {
    const res = await client.call('tools/call', { name: 'read_document', arguments: { path: '../../../../windows/system.ini' } })
    assert(res.result?.isError === true, `expected isError:true, got ${JSON.stringify(res.result)}`)
    assert(res.result.content[0].text.includes('outside the configured'), `unexpected message: ${res.result.content[0].text}`)
  })

  await test('read_document on an unsupported extension -> isError', async () => {
    fs.writeFileSync(path.join(scopedDocsDir, 'binary.exe'), 'MZ')
    const res = await client.call('tools/call', { name: 'read_document', arguments: { path: 'binary.exe' } })
    assert(res.result?.isError === true && res.result.content[0].text.includes('Unsupported'), `expected unsupported-type error, got ${JSON.stringify(res.result)}`)
  })

  await test('read_document on a missing file -> isError suggesting list_documents', async () => {
    const res = await client.call('tools/call', { name: 'read_document', arguments: { path: 'no-such-file.pdf' } })
    assert(res.result?.isError === true && res.result.content[0].text.includes('list_documents'), `unexpected: ${JSON.stringify(res.result)}`)
  })

  await test('read_document reads a multi-sheet .xlsx as text tables (formulas resolved)', async () => {
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Caseload')
    ws.addRow(['Client', 'Sessions'])
    ws.addRow(['Henderson', 12])
    ws.addRow(['Alvarez', 3])
    ws.addRow(['Total', { formula: 'SUM(B2:B3)', result: 15 }])
    wb.addWorksheet('Budget').addRow(['Rent assistance', 1250.5])
    await wb.xlsx.writeFile(path.join(scopedDocsDir, 'caseload.xlsx'))

    const res = await client.call('tools/call', { name: 'read_document', arguments: { path: 'caseload.xlsx' } })
    assert(!res.result?.isError, `read failed: ${JSON.stringify(res.result)}`)
    const text = res.result.content[0].text
    assert(text.includes('=== Sheet: Caseload ==='), `missing sheet header: ${text}`)
    assert(text.includes('Henderson | 12'), `missing row: ${text}`)
    assert(text.includes('Total | 15'), `formula not resolved to result: ${text}`)
    assert(text.includes('=== Sheet: Budget ===') && text.includes('1250.5'), `missing second sheet: ${text}`)
  })

  await test('read_document reads a .csv file', async () => {
    fs.writeFileSync(path.join(scopedDocsDir, 'export.csv'), 'name,status\nHenderson,active\nAlvarez,waitlist\n')
    const res = await client.call('tools/call', { name: 'read_document', arguments: { path: 'export.csv' } })
    assert(!res.result?.isError, `read failed: ${JSON.stringify(res.result)}`)
    assert(res.result.content[0].text.includes('Alvarez,waitlist'), `unexpected csv content: ${res.result.content[0].text}`)
  })

  await test('list_documents includes the spreadsheet files', async () => {
    const res = await client.call('tools/call', { name: 'list_documents', arguments: {} })
    const text = res.result.content[0].text
    assert(text.includes('caseload.xlsx') && text.includes('export.csv'), `unexpected listing: ${text}`)
  })

  console.log('\n-- sqlite provider --')

  // Fixture database, built with sql.js itself and exported to disk — no
  // sqlite3 CLI dependency. 250 rows exercises the maxRows cap.
  const { default: initSqlJs } = await import('sql.js')
  const SQL = await initSqlJs()
  {
    const fixture = new SQL.Database()
    fixture.run('CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT NOT NULL, active INTEGER DEFAULT 1)')
    fixture.run('CREATE VIEW active_clients AS SELECT * FROM clients WHERE active = 1')
    for (let i = 1; i <= 250; i++) fixture.run('INSERT INTO clients (name) VALUES (?)', [`client-${i}`])
    fs.writeFileSync(path.join(tmpSqliteDir, 'cases.db'), Buffer.from(fixture.export()))
    fixture.close()
  }
  const fixtureBytesBefore = fs.readFileSync(path.join(tmpSqliteDir, 'cases.db'))

  await test('tools/list omits sqlite_* while the capability is disabled', async () => {
    const res = await client.call('tools/list')
    const names = res.result.tools.map(t => t.name)
    assert(!names.some(n => n.startsWith('sqlite_')), `did not expect sqlite_* in ${JSON.stringify(names)}`)
  })

  updateMcpConfig({ ...baseConfig, sqlite: { enabled: true, rootDir: tmpSqliteDir, maxRows: 200 } })

  // --- Discovery. Every other sqlite tool REQUIRES a database path, so without
  // a listing the capability is unusable unless the model already knows a
  // filename — and nothing tells it one. A model asked to find databases falls
  // back to the file-system tools (a different root entirely), finds nothing,
  // and reports that no databases exist. Observed in practice; these lock the
  // fix in. ---

  await test('🔍 sqlite_list_databases finds databases without being told a filename', async () => {
    const res = await client.call('tools/call', { name: 'sqlite_list_databases', arguments: {} })
    assert(!res.result?.isError, `unexpected error: ${JSON.stringify(res.result)}`)
    const text = res.result.content[0].text
    assert(text.includes('cases.db'), `the fixture database was not listed: ${text}`)
  })

  await test('sqlite_list_databases reports files in subfolders too', async () => {
    fs.mkdirSync(path.join(tmpSqliteDir, 'archive'), { recursive: true })
    fs.copyFileSync(path.join(tmpSqliteDir, 'cases.db'), path.join(tmpSqliteDir, 'archive', 'old.db'))
    const res = await client.call('tools/call', { name: 'sqlite_list_databases', arguments: {} })
    assert(res.result.content[0].text.includes('archive/old.db'), `nested database missing: ${res.result.content[0].text}`)
  })

  await test('🔍 a file merely NAMED .db is not offered as a database', async () => {
    // Listing it would send the model off to query something that cannot be
    // opened, and the failure would look like a permissions problem.
    fs.writeFileSync(path.join(tmpSqliteDir, 'notes.db'), 'this is not a database')
    const res = await client.call('tools/call', { name: 'sqlite_list_databases', arguments: {} })
    assert(!res.result.content[0].text.includes('notes.db'), `a non-SQLite file was listed: ${res.result.content[0].text}`)
    fs.rmSync(path.join(tmpSqliteDir, 'notes.db'))
  })

  await test('sqlite_list_databases needs no arguments (it is the entry point)', async () => {
    const tools = (await client.call('tools/list')).result.tools
    const listTool = tools.find(t => t.name === 'sqlite_list_databases')
    assert(listTool, 'sqlite_list_databases is not advertised')
    assert(
      !listTool.inputSchema.required || listTool.inputSchema.required.length === 0,
      `discovery must not require an argument: ${JSON.stringify(listTool.inputSchema.required)}`,
    )
  })

  await test('tools/list includes sqlite_query/list_tables/describe_table once enabled', async () => {
    const res = await client.call('tools/list')
    const names = res.result.tools.map(t => t.name)
    for (const n of ['sqlite_query', 'sqlite_list_tables', 'sqlite_describe_table']) {
      assert(names.includes(n), `expected ${n} in ${JSON.stringify(names)}`)
    }
  })

  await test('sqlite_list_tables lists the fixture table and view', async () => {
    const res = await client.call('tools/call', { name: 'sqlite_list_tables', arguments: { database: 'cases.db' } })
    assert(!res.result?.isError, `unexpected error: ${JSON.stringify(res.result)}`)
    const text = res.result.content[0].text
    assert(text.includes('clients') && text.includes('active_clients (view)'), `unexpected listing: ${text}`)
  })

  await test('sqlite_describe_table reports columns, types, and PK', async () => {
    const res = await client.call('tools/call', { name: 'sqlite_describe_table', arguments: { database: 'cases.db', table: 'clients' } })
    assert(!res.result?.isError, `unexpected error: ${JSON.stringify(res.result)}`)
    const text = res.result.content[0].text
    assert(text.includes('id') && text.includes('PRIMARY KEY') && text.includes('name') && text.includes('NOT NULL'), `unexpected describe: ${text}`)
  })

  await test('sqlite_query returns rows', async () => {
    const res = await client.call('tools/call', { name: 'sqlite_query', arguments: { database: 'cases.db', sql: 'SELECT id, name FROM clients WHERE id <= 3 ORDER BY id' } })
    assert(!res.result?.isError, `unexpected error: ${JSON.stringify(res.result)}`)
    const text = res.result.content[0].text
    assert(text.includes('client-1') && text.includes('client-3'), `unexpected rows: ${text}`)
  })

  await test('sqlite_query caps output at maxRows', async () => {
    const res = await client.call('tools/call', { name: 'sqlite_query', arguments: { database: 'cases.db', sql: 'SELECT * FROM clients' } })
    const text = res.result.content[0].text
    assert(text.includes('Showing first 200 of 250 rows'), `expected row cap notice, got tail: ...${text.slice(-120)}`)
  })

  await test('🔍 write statement is rejected by the engine (query_only)', async () => {
    const res = await client.call('tools/call', { name: 'sqlite_query', arguments: { database: 'cases.db', sql: "INSERT INTO clients (name) VALUES ('mallory')" } })
    assert(res.result?.isError === true, `expected isError:true, got ${JSON.stringify(res.result)}`)
    assert(/readonly/i.test(res.result.content[0].text), `expected a readonly rejection, got: ${res.result.content[0].text}`)
  })

  await test('🔍 on-disk database is byte-identical after the attempted write', async () => {
    const after = fs.readFileSync(path.join(tmpSqliteDir, 'cases.db'))
    assert(fixtureBytesBefore.equals(after), 'database file changed on disk')
  })

  await test('🔍 database path with traversal segments is rejected', async () => {
    const res = await client.call('tools/call', { name: 'sqlite_query', arguments: { database: '../../outside.db', sql: 'SELECT 1' } })
    assert(res.result?.isError === true, `expected isError:true, got ${JSON.stringify(res.result)}`)
    assert(res.result.content[0].text.includes('outside the configured'), `unexpected message: ${res.result.content[0].text}`)
  })

  await test('missing database file -> isError, not a crash', async () => {
    const res = await client.call('tools/call', { name: 'sqlite_query', arguments: { database: 'nope.db', sql: 'SELECT 1' } })
    assert(res.result?.isError === true, `expected isError:true, got ${JSON.stringify(res.result)}`)
  })

  await test('invalid SQL -> isError with the engine message', async () => {
    const res = await client.call('tools/call', { name: 'sqlite_query', arguments: { database: 'cases.db', sql: 'SELEC oops' } })
    assert(res.result?.isError === true, `expected isError:true, got ${JSON.stringify(res.result)}`)
  })

  await test('file over maxFileBytes is refused', async () => {
    updateMcpConfig({ ...baseConfig, sqlite: { enabled: true, rootDir: tmpSqliteDir, maxRows: 200, maxFileBytes: 1024 } })
    const res = await client.call('tools/call', { name: 'sqlite_query', arguments: { database: 'cases.db', sql: 'SELECT 1' } })
    assert(res.result?.isError === true && res.result.content[0].text.includes('limit'), `expected size-limit error, got ${JSON.stringify(res.result)}`)
    updateMcpConfig({ ...baseConfig, sqlite: { enabled: true, rootDir: tmpSqliteDir, maxRows: 200 } })
  })

  console.log('\n-- vault provider --')

  // Fixture notes: tags in both inline and frontmatter form, a subfolder,
  // and an .obsidian dir that must be ignored.
  fs.mkdirSync(path.join(tmpVaultDir, 'cases'), { recursive: true })
  fs.mkdirSync(path.join(tmpVaultDir, '.obsidian'), { recursive: true })
  fs.writeFileSync(path.join(tmpVaultDir, 'meeting-notes.md'),
    '---\ntags: [intake, followup]\n---\n# Meeting\nDiscussed the Henderson housing application deadline.')
  fs.writeFileSync(path.join(tmpVaultDir, 'cases', 'henderson.md'),
    '# Henderson case\n#intake\nHousing application filed in March. Deadline extended.')
  // The YAML dash-list tag form. Obsidian writes this by default, and it had no
  // coverage: the inline-value regex used \s* (which matches newlines), so it
  // captured "- review" as an inline tag, skipped the dash-list branch, and lost
  // every tag after the first. Keep a note that uses ONLY this form.
  fs.writeFileSync(path.join(tmpVaultDir, 'dash-list.md'),
    '---\ntags:\n  - review\n  - followup\n---\n# Quarterly review\nNothing inline here.')
  fs.writeFileSync(path.join(tmpVaultDir, 'unrelated.md'), '# Groceries\nMilk, eggs.')
  fs.writeFileSync(path.join(tmpVaultDir, '.obsidian', 'hidden.md'), 'Henderson should never appear from here.')

  updateMcpConfig({ ...baseConfig, vault: { enabled: true, rootDir: tmpVaultDir } })

  await test('tools/list includes vault_search/get/tags once enabled', async () => {
    const res = await client.call('tools/list')
    const names = res.result.tools.map(t => t.name)
    for (const n of ['vault_search', 'vault_get', 'vault_tags']) assert(names.includes(n), `expected ${n} in ${JSON.stringify(names)}`)
  })

  await test('vault_search finds matching notes with snippets, skipping .obsidian', async () => {
    const res = await client.call('tools/call', { name: 'vault_search', arguments: { query: 'henderson housing' } })
    const text = res.result.content[0].text
    assert(text.includes('henderson.md') && text.includes('meeting-notes.md'), `unexpected results: ${text}`)
    assert(!text.includes('.obsidian'), `.obsidian leaked into results: ${text}`)
    assert(!text.includes('unrelated.md'), `non-matching note returned: ${text}`)
  })

  await test('vault_get reads a note from a subfolder', async () => {
    const res = await client.call('tools/call', { name: 'vault_get', arguments: { path: 'cases/henderson.md' } })
    assert(res.result.content[0].text.includes('Deadline extended'), `unexpected content: ${res.result.content[0].text}`)
  })

  await test('vault_tags lists tags from both inline and frontmatter forms', async () => {
    const res = await client.call('tools/call', { name: 'vault_tags', arguments: {} })
    const text = res.result.content[0].text
    // intake: one inline #tag + one frontmatter list. followup: the frontmatter
    // list here plus dash-list.md, which carries it in the YAML dash form.
    assert(text.includes('#intake (2)') && text.includes('#followup (2)'), `unexpected tags: ${text}`)
  })

  await test('vault_tags reads the YAML dash-list tag form', async () => {
    const res = await client.call('tools/call', { name: 'vault_tags', arguments: {} })
    const text = res.result.content[0].text
    // Both entries, not just the first — and no "- review" artefact.
    assert(text.includes('#review (1)'), `dash-list tag missing: ${text}`)
    assert(text.includes('#followup (2)'), `dash-list note not counted under followup: ${text}`)
    assert(!/#-\s/.test(text), `malformed tag parsed from the dash list: ${text}`)
  })

  await test('vault_tags with a tag argument lists the tagged notes', async () => {
    const res = await client.call('tools/call', { name: 'vault_tags', arguments: { tag: '#intake' } })
    const text = res.result.content[0].text
    assert(text.includes('henderson.md') && text.includes('meeting-notes.md'), `unexpected notes: ${text}`)
  })

  await test('🔍 vault_get with traversal segments is rejected', async () => {
    const res = await client.call('tools/call', { name: 'vault_get', arguments: { path: '../../secrets.md' } })
    assert(res.result?.isError === true, `expected isError:true, got ${JSON.stringify(res.result)}`)
  })

  await test('vault_get on a non-markdown path is rejected', async () => {
    fs.writeFileSync(path.join(tmpVaultDir, 'data.bin'), 'x')
    const res = await client.call('tools/call', { name: 'vault_get', arguments: { path: 'data.bin' } })
    assert(res.result?.isError === true && res.result.content[0].text.includes('.md'), `unexpected: ${JSON.stringify(res.result)}`)
  })

  console.log('\n-- git provider --')

  const { execFileSync } = await import('node:child_process')
  let gitAvailable = true
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }) } catch { gitAvailable = false }

  if (!gitAvailable) {
    console.log('  skip - git not found on PATH')
  } else {
    // Real fixture repo: one commit, then an uncommitted modification.
    const repoDir = path.join(tmpGitDir, 'myrepo')
    fs.mkdirSync(repoDir, { recursive: true })
    const git = (...a) => execFileSync('git', ['-C', repoDir, ...a], { stdio: 'pipe' })
    git('init', '-q')
    git('config', 'user.email', 'test@redstart.local')
    git('config', 'user.name', 'Redstart Test')
    fs.writeFileSync(path.join(repoDir, 'readme.txt'), 'hello\n')
    git('add', '.')
    git('commit', '-q', '-m', 'initial commit for provider test')
    fs.writeFileSync(path.join(repoDir, 'readme.txt'), 'hello world\n')

    updateMcpConfig({ ...baseConfig, git: { enabled: true, rootDir: tmpGitDir } })

    await test('tools/list includes git_status/log/diff once enabled', async () => {
      const res = await client.call('tools/list')
      const names = res.result.tools.map(t => t.name)
      for (const n of ['git_list_repos', 'git_status', 'git_log', 'git_diff']) assert(names.includes(n), `expected ${n} in ${JSON.stringify(names)}`)
    })

    await test('🔍 git_list_repos finds repositories in subfolders', async () => {
      // `repo` defaults to the configured root, so a root that IS a repo works
      // without discovery — but a folder holding several repos leaves the model
      // guessing names. Same gap sqlite had.
      const res = await client.call('tools/call', { name: 'git_list_repos', arguments: {} })
      assert(!res.result?.isError, `unexpected error: ${JSON.stringify(res.result)}`)
      assert(res.result.content[0].text.includes('myrepo'), `repo not listed: ${res.result.content[0].text}`)
    })

    await test('git_status reports the modified file', async () => {
      const res = await client.call('tools/call', { name: 'git_status', arguments: { repo: 'myrepo' } })
      assert(res.result.content[0].text.includes('readme.txt'), `unexpected status: ${res.result.content[0].text}`)
    })

    await test('git_log shows the commit', async () => {
      const res = await client.call('tools/call', { name: 'git_log', arguments: { repo: 'myrepo' } })
      assert(res.result.content[0].text.includes('initial commit for provider test'), `unexpected log: ${res.result.content[0].text}`)
    })

    await test('git_diff shows the uncommitted change', async () => {
      const res = await client.call('tools/call', { name: 'git_diff', arguments: { repo: 'myrepo' } })
      const text = res.result.content[0].text
      assert(text.includes('+hello world'), `unexpected diff: ${text}`)
    })

    await test('git tools work when the configured root is itself the repo (repo omitted)', async () => {
      updateMcpConfig({ ...baseConfig, git: { enabled: true, rootDir: repoDir } })
      const res = await client.call('tools/call', { name: 'git_status', arguments: {} })
      assert(res.result.content[0].text.includes('readme.txt'), `unexpected status: ${res.result.content[0].text}`)
      updateMcpConfig({ ...baseConfig, git: { enabled: true, rootDir: tmpGitDir } })
    })

    await test('🔍 repo path with traversal segments is rejected', async () => {
      const res = await client.call('tools/call', { name: 'git_diff', arguments: { repo: '../../somewhere' } })
      assert(res.result?.isError === true, `expected isError:true, got ${JSON.stringify(res.result)}`)
      assert(res.result.content[0].text.includes('outside the configured'), `unexpected message: ${res.result.content[0].text}`)
    })

    await test('non-repo folder -> friendly "not a git repository" error', async () => {
      fs.mkdirSync(path.join(tmpGitDir, 'plain-folder'), { recursive: true })
      const res = await client.call('tools/call', { name: 'git_status', arguments: { repo: 'plain-folder' } })
      assert(res.result?.isError === true && res.result.content[0].text.includes('Not a git repository'), `unexpected: ${JSON.stringify(res.result)}`)
    })

    await test('🔍 file argument to git_diff cannot smuggle flags (option injection)', async () => {
      const res = await client.call('tools/call', { name: 'git_diff', arguments: { repo: 'myrepo', file: '--output=/tmp/pwned' } })
      // Behind "--" git treats it as a (nonexistent) path — must not error out
      // with a file written, and must not be interpreted as an option.
      const text = res.result?.isError ? res.result.content[0].text : res.result.content[0].text
      assert(!fs.existsSync('/tmp/pwned'), 'flag injection wrote a file!')
      assert(typeof text === 'string', 'no response text')
    })
  }

  console.log('\n-- scholar provider --')

  await test('tools/list omits scholar_* while disabled', async () => {
    const res = await client.call('tools/list')
    assert(!res.result.tools.some(t => t.name.startsWith('scholar_')), 'scholar tools leaked while disabled')
  })

  updateMcpConfig({ ...baseConfig, scholar: { enabled: true, venueFilter: null, saveDir: tmpDocsDir } })

  await test('tools/list includes scholar_search/get/save_pdf once enabled (saveDir set)', async () => {
    const res = await client.call('tools/list')
    const names = res.result.tools.map(t => t.name)
    for (const n of ['scholar_search', 'scholar_get', 'scholar_save_pdf']) assert(names.includes(n), `expected ${n}`)
  })

  await test('scholar_save_pdf is hidden when no documents folder is configured', async () => {
    updateMcpConfig({ ...baseConfig, scholar: { enabled: true, venueFilter: null, saveDir: null } })
    const res = await client.call('tools/list')
    const names = res.result.tools.map(t => t.name)
    assert(names.includes('scholar_search') && !names.includes('scholar_save_pdf'), `unexpected: ${JSON.stringify(names)}`)
    updateMcpConfig({ ...baseConfig, scholar: { enabled: true, venueFilter: null, saveDir: tmpDocsDir } })
  })

  await test('scholar_get with an unrecognized identifier -> isError with guidance', async () => {
    const res = await client.call('tools/call', { name: 'scholar_get', arguments: { id: 'not-a-real-id' } })
    assert(res.result?.isError === true && res.result.content[0].text.includes('doi:'), `unexpected: ${JSON.stringify(res.result)}`)
  })

  await test('🔍 venue whitelist with only arXiv categories blocks OpenAlex/PubMed search (no network)', async () => {
    updateMcpConfig({ ...baseConfig, scholar: { enabled: true, venueFilter: 'cs.CL, stat.ML', saveDir: tmpDocsDir } })
    for (const source of ['openalex', 'pubmed']) {
      const res = await client.call('tools/call', { name: 'scholar_search', arguments: { query: 'anything', source } })
      assert(res.result?.isError === true && res.result.content[0].text.includes('no journal ISSNs'), `${source} not blocked: ${JSON.stringify(res.result)}`)
    }
  })

  await test('🔍 venue whitelist with only ISSNs blocks arXiv search (no network)', async () => {
    updateMcpConfig({ ...baseConfig, scholar: { enabled: true, venueFilter: '1932-6203', saveDir: tmpDocsDir } })
    const res = await client.call('tools/call', { name: 'scholar_search', arguments: { query: 'anything', source: 'arxiv' } })
    assert(res.result?.isError === true && res.result.content[0].text.includes('no arXiv categories'), `unexpected: ${JSON.stringify(res.result)}`)
    updateMcpConfig({ ...baseConfig, scholar: { enabled: true, venueFilter: null, saveDir: tmpDocsDir } })
  })

  if (process.env.REDSTART_TEST_LIVE_WEB === '1') {
    await test('LIVE: scholar_search(openalex) returns titled results with ids', async () => {
      const res = await client.call('tools/call', { name: 'scholar_search', arguments: { query: 'trauma informed care' } })
      assert(!res.result?.isError, `search failed: ${JSON.stringify(res.result)}`)
      assert(res.result.content[0].text.includes('id: doi:'), `no DOIs in results: ${res.result.content[0].text.slice(0, 300)}`)
    })

    await test('LIVE: scholar_get(arxiv) returns an abstract', async () => {
      const res = await client.call('tools/call', { name: 'scholar_get', arguments: { id: 'arxiv:1706.03762' } })
      assert(!res.result?.isError, `get failed: ${JSON.stringify(res.result)}`)
      assert(/attention/i.test(res.result.content[0].text), `unexpected abstract: ${res.result.content[0].text.slice(0, 200)}`)
    })

    await test('LIVE: 🔍 scholar_get outside an ISSN whitelist is refused', async () => {
      updateMcpConfig({ ...baseConfig, scholar: { enabled: true, venueFilter: '9999-9999', saveDir: tmpDocsDir } })
      const res = await client.call('tools/call', { name: 'scholar_get', arguments: { id: 'doi:10.7717/peerj.4375' } })
      assert(res.result?.isError === true && res.result.content[0].text.includes('not on the venue whitelist'), `unexpected: ${JSON.stringify(res.result)}`)
      updateMcpConfig({ ...baseConfig, scholar: { enabled: true, venueFilter: null, saveDir: tmpDocsDir }, documents: { enabled: true, outputDir: tmpDocsDir } })
    })

    await test('LIVE: scholar_save_pdf(arxiv) -> read_document reads the paper', async () => {
      const saved = await client.call('tools/call', { name: 'scholar_save_pdf', arguments: { id: 'arxiv:1706.03762' } })
      assert(!saved.result?.isError, `save failed: ${JSON.stringify(saved.result)}`)
      const filename = saved.result.content[0].text.match(/Saved: (\S+\.pdf)/)[1]
      const bytes = fs.readFileSync(path.join(scopedDocsDir, filename))
      assert(bytes.subarray(0, 4).toString() === '%PDF', 'saved file is not a PDF')
      const read = await client.call('tools/call', { name: 'read_document', arguments: { path: filename } })
      assert(!read.result?.isError && /attention/i.test(read.result.content[0].text), `read-back failed: ${JSON.stringify(read.result).slice(0, 300)}`)
    })
  } else {
    console.log('  skip - live scholar tests (set REDSTART_TEST_LIVE_WEB=1 to run)')
  }

  console.log('\n-- file system provider (@modelcontextprotocol/server-filesystem, spawned) --')

  // File System is served by the official server-filesystem, spawned as a stdio
  // child (filesystem-mcp-provider.mjs). Exercised end-to-end through the REAL
  // producer (buildGatewayConfig) -> MCP server -> spawned child -> disk. The
  // child must be spawned + handshaked (syncFilesystemProvider) before its tools
  // appear, since toolDefs() serves the cached tools/list from the live child.
  {
    const { buildGatewayConfig } = await import('../electron/main/gateway-config.mjs')
    const { expandDisabledToolIds } = await import('../electron/main/tools-definitions.mjs')
    const storageFs = await import('../electron/main/tools-storage.mjs')
    const fsProvider = await import('../electron/main/filesystem-mcp-provider.mjs')
    storageFs.setCapabilityConfig('file_system', { enabled: true, rootDir: tmpFsDir })
    fs.writeFileSync(path.join(scopedFsDir, 'note.txt'), 'hello world')
    const fsProfile = { tools: { enabled: true, activeToolIds: ['file_system'] } }

    await test('🔍 buildGatewayConfig emits camelCase fileSystem (producer/consumer keys agree)', async () => {
      const cfg = buildGatewayConfig(fsProfile)
      assert(cfg.fileSystem?.enabled === true, `expected cfg.fileSystem.enabled true; keys: ${JSON.stringify(Object.keys(cfg))}`)
      assert(cfg.file_system === undefined, 'must not emit snake_case file_system — the provider reads cfg.fileSystem')
    })

    // A profile saved before webAccessEnabled existed has no such key, and must
    // still get web access — otherwise the upgrade silently disables it.
    await test('🔍 a legacy profile (no webAccessEnabled key) still gets web access', async () => {
      const legacyProfile = { tools: { enabled: true, activeToolIds: [] } }
      const cfg = buildGatewayConfig(legacyProfile)
      assert(cfg.webFetch.enabled === true, 'legacy profile lost web access')

      const offProfile = { tools: { enabled: true, webAccessEnabled: false, activeToolIds: [] } }
      assert(buildGatewayConfig(offProfile).webFetch.enabled === false, 'webAccessEnabled:false not honoured')
    })

    await test('🔍 disabling Web Access serves no web tool even with whitelist ON and sources selected', async () => {
      // Web Access off + whitelist on + sources selected: the combination where
      // the pre-Step-2b gate consulted allowedBaseUrls and never looked at
      // `enabled`, so the card's Disable silently served the tools anyway.
      const webFetchTool = await import('../electron/main/web-fetch-tool.mjs')
      const webOff = webFetchTool.toolDefs({
        webFetch: { enabled: false, whitelistEnabled: true, allowedBaseUrls: ['https://example.com/'], activeTools: [], maxFetchTokens: 2000 },
      })
      assert(webOff.length === 0, `disabling Web Access still served ${webOff.map(t => t.name).join(', ')}`)

      // And the execution backstop, for a client that calls it regardless.
      const refused = await webFetchTool.callTool('web_fetch', { url: 'https://example.com/' }, {
        webFetch: { enabled: false, whitelistEnabled: true, allowedBaseUrls: ['https://example.com/'] },
      })
      assert(refused?.isError, 'web_fetch ran with Web Access disabled')
    })

    // Spawn + handshake the child, then push the same config to the MCP server.
    await fsProvider.syncFilesystemProvider(buildGatewayConfig(fsProfile).fileSystem)
    updateMcpConfig(buildGatewayConfig(fsProfile))

    await test('the filesystem child spawns and hands off its tool list', async () => {
      assert(fsProvider.isFilesystemProviderReady(), 'provider did not reach ready (child spawn/handshake failed — is npx available?)')
    })

    await test('tools/list advertises the standard server-filesystem tools once active', async () => {
      const res = await client.call('tools/list')
      const names = res.result.tools.map(t => t.name)
      // Standard upstream names — the whole point of the swap (local models call
      // write_file/read_text_file far more reliably than the old fs_* schema).
      for (const n of ['read_text_file', 'write_file', 'list_directory']) {
        assert(names.includes(n), `expected ${n} in ${JSON.stringify(names)}`)
      }
    })

    await test('read_text_file reads a file within the configured root', async () => {
      const res = await client.call('tools/call', { name: 'read_text_file', arguments: { path: 'note.txt' } })
      assert(!res.result?.isError, `unexpected error: ${JSON.stringify(res.result)}`)
      assert(res.result.content[0].text.includes('hello world'), `unexpected content: ${res.result.content[0].text}`)
    })

    await test('write_file works under the default policy (writes allowed)', async () => {
      const res = await client.call('tools/call', { name: 'write_file', arguments: { path: 'written.txt', content: 'hi there' } })
      assert(!res.result?.isError, `unexpected error: ${JSON.stringify(res.result)}`)
      assert(fs.readFileSync(path.join(scopedFsDir, 'written.txt'), 'utf8').includes('hi there'), 'file was not written')
    })

    await test('write_file emits a [FILE:] marker so a written script is downloadable', async () => {
      // Nested on purpose: the marker path must be relative to the root and
      // forward-slashed, since /files/download resolves it as a URL parameter.
      // The upstream server does not create parent dirs, hence create_directory.
      const made = await client.call('tools/call', { name: 'create_directory', arguments: { path: 'scripts' } })
      assert(!made.result?.isError, `create_directory failed: ${JSON.stringify(made.result)}`)
      const res = await client.call('tools/call', { name: 'write_file', arguments: { path: 'scripts/tidy.py', content: 'print("tidy")' } })
      assert(!res.result?.isError, `unexpected error: ${JSON.stringify(res.result)}`)
      const text = res.result.content[0].text
      const marker = text.match(/^\[FILE: (.+)\]$/m)
      assert(marker, `no [FILE:] marker in result: ${text}`)
      assert(marker[1] === 'scripts/tidy.py', `expected a forward-slash path relative to the root, got ${marker[1]}`)
      assert(fs.existsSync(path.join(scopedFsDir, 'scripts', 'tidy.py')), 'script was not written')
    })

    // --- Per-account scoping: the model addresses its own folder and is never
    // told where that folder actually is. Absolute server paths in a tool
    // result would disclose the on-disk layout, the account-folder naming
    // scheme, and the existence of sibling accounts. ---

    await test('🔍 no tool result leaks the absolute server path of the capability root', async () => {
      const scopedRoot = path.join(tmpFsDir, 'user_files', '_local')
      fs.writeFileSync(path.join(scopedRoot, 'visible.txt'), 'hi')
      for (const call of [
        { name: 'list_allowed_directories', arguments: {} },
        { name: 'list_directory', arguments: { path: '.' } },
        { name: 'directory_tree', arguments: { path: '.' } },
        { name: 'search_files', arguments: { path: '.', pattern: 'visible' } },
        { name: 'get_file_info', arguments: { path: 'visible.txt' } },
        { name: 'write_file', arguments: { path: 'echoed.txt', content: 'x' } },
      ]) {
        const res = await client.call('tools/call', call)
        const text = (res.result?.content ?? []).map(c => c.text).join('\n')
        assert(!text.includes(tmpFsDir), `${call.name} leaked the capability root: ${text.slice(0, 200)}`)
        assert(!text.includes('user_files'), `${call.name} leaked the account-folder layout: ${text.slice(0, 200)}`)
      }
    })

    await test('a relative path still resolves inside the caller\'s own folder', async () => {
      // Scoping that breaks addressing is not scoping.
      const res = await client.call('tools/call', { name: 'read_text_file', arguments: { path: 'visible.txt' } })
      assert(!res.result?.isError, `could not read own file: ${JSON.stringify(res.result)}`)
      assert(res.result.content[0].text.includes('hi'), `unexpected contents: ${res.result.content[0].text}`)
    })

    await test('a read tool result is not decorated with a [FILE:] marker', async () => {
      const res = await client.call('tools/call', { name: 'read_text_file', arguments: { path: 'written.txt' } })
      assert(!res.result.content[0].text.includes('[FILE:'), `read result was decorated: ${res.result.content[0].text}`)
    })

    // --- Containment: the provider re-validates every path argument through the
    // symlink-aware path-scope gate BEFORE forwarding to the child, so a ".."
    // escape is refused even though the request reached the MCP layer. ---

    await test('🔍 read_text_file with a "../" escape is refused by the containment gate', async () => {
      const res = await client.call('tools/call', { name: 'read_text_file', arguments: { path: '../../secret.txt' } })
      assert(res.result?.isError === true, `expected containment refusal, got ${JSON.stringify(res.result)}`)
    })

    // --- Permission gate: writes obey allowWrite. ---

    storageFs.setCapabilityConfig('file_system', { allowWrite: false, allowDestructive: false })
    updateMcpConfig(buildGatewayConfig(fsProfile))

    await test('🔍 write_file is not advertised when writes are disabled by policy', async () => {
      const names = (await client.call('tools/list')).result.tools.map(t => t.name)
      assert(!names.includes('write_file'), `write_file must be hidden when writes disabled; got ${JSON.stringify(names)}`)
      assert(names.includes('read_text_file'), 'read_text_file should still be advertised (reads unaffected)')
    })

    await test('🔍 write_file is refused by the server gate when writes are disabled', async () => {
      const res = await client.call('tools/call', { name: 'write_file', arguments: { path: 'blocked.txt', content: 'x' } })
      assert(res.result?.isError === true, `expected write refusal, got ${JSON.stringify(res.result)}`)
      assert(!fs.existsSync(path.join(scopedFsDir, 'blocked.txt')), 'file must not be written when writes are disabled')
    })

    // --- Permission escalation: a caller cannot grant itself permission by
    // smuggling policy fields into the tool arguments. The gate reads the
    // server-side capability config, never the call's arguments. ---

    await test('🔍 write_file cannot self-promote via policy fields in arguments', async () => {
      const res = await client.call('tools/call', { name: 'write_file', arguments: {
        path: 'escalate.txt', content: 'x',
        allowWrite: true, allowDestructive: true,
        policy: { allowWrite: true }, fileSystem: { allowWrite: true },
      } })
      assert(res.result?.isError === true, `write self-promotion was allowed: ${JSON.stringify(res.result)}`)
      assert(!fs.existsSync(path.join(scopedFsDir, 'escalate.txt')), 'file was written despite writes being disabled')
    })

    // --- Destructive class: the delete tool and the gate that governs it. ---
    //
    // Everything except the tool itself already existed and was inert:
    // evaluateToolPolicy refuses cls === 'destructive' unless allowDestructive
    // is true, at BOTH tools/list and tools/call. Classifying delete_file is
    // what made all of it load-bearing, so these tests check the gate as much
    // as the tool.
    console.log('\n-- file system: destructive class (delete) --')

    {
      storageFs.setCapabilityConfig('file_system', { allowWrite: true, allowDestructive: false })
      updateMcpConfig(buildGatewayConfig(fsProfile))

      await test('🔍 with allowDestructive OFF the delete tool is not advertised at all', async () => {
        const names = (await client.call('tools/list')).result.tools.map(t => t.name)
        assert(!names.includes('delete_file'), `delete_file advertised while disabled: ${JSON.stringify(names)}`)
      })

      await test('🔍 with allowDestructive OFF a DIRECT delete call is refused, bypassing the filtered list', async () => {
        fs.writeFileSync(path.join(scopedFsDir, 'protected.txt'), 'still here')
        const res = await client.call('tools/call', { name: 'delete_file', arguments: { path: 'protected.txt' } })
        assert(res.result?.isError === true, `delete was allowed while disabled: ${JSON.stringify(res.result)}`)
        assert(fs.existsSync(path.join(scopedFsDir, 'protected.txt')), 'THE FILE WAS DELETED while the policy was off')
      })

      storageFs.setCapabilityConfig('file_system', { allowWrite: true, allowDestructive: true })
      updateMcpConfig(buildGatewayConfig(fsProfile))

      await test('with allowDestructive ON the tool is advertised and flagged destructive', async () => {
        const tool = (await client.call('tools/list')).result.tools.find(t => t.name === 'delete_file')
        assert(tool, 'delete_file not advertised despite the policy being on')
        assert(tool._meta['redstart/class'] === 'destructive', `class is ${tool._meta['redstart/class']}`)
        assert(tool.annotations.destructiveHint === true, 'destructiveHint not set')
        assert(tool._meta['redstart/capability'] === 'file_system', 'not attributed to the file_system capability')
      })

      await test('🔍 a deleted file is RECOVERABLE, not destroyed', async () => {
        // The property that makes exposing a delete to a local model defensible.
        // Under the test stub there is no OS recycle bin, so this exercises the
        // .trash/ fallback — the tier that must never degrade to a real delete.
        fs.writeFileSync(path.join(scopedFsDir, 'doomed.txt'), 'recover me')
        const res = await client.call('tools/call', { name: 'delete_file', arguments: { path: 'doomed.txt' } })
        assert(!res.result?.isError, `delete failed: ${JSON.stringify(res.result)}`)
        assert(!fs.existsSync(path.join(scopedFsDir, 'doomed.txt')), 'the file is still at its original path')

        const trashRoot = path.join(scopedFsDir, '.trash')
        const found = []
        const stack = [trashRoot]
        while (stack.length) {
          const dir = stack.pop()
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) stack.push(full)
            else found.push(full)
          }
        }
        const recovered = found.filter(f => f.endsWith('doomed.txt'))
        assert(recovered.length === 1, `expected 1 recoverable copy, found ${recovered.length}`)
        assert(fs.readFileSync(recovered[0], 'utf8') === 'recover me', 'the recoverable copy lost its contents')
        assert(/recoverable/i.test(res.result.content[0].text), `reply does not mention recoverability: ${res.result.content[0].text}`)
      })

      await test('🔍 containment: a path outside the caller\'s storage is refused', async () => {
        const outside = path.join(tmpFsDir, 'outside-victim.txt')
        fs.writeFileSync(outside, 'not yours')
        for (const attempt of ['../outside-victim.txt', '../../outside-victim.txt', outside]) {
          const res = await client.call('tools/call', { name: 'delete_file', arguments: { path: attempt } })
          assert(res.result?.isError === true, `escape allowed via "${attempt}": ${JSON.stringify(res.result)}`)
        }
        assert(fs.existsSync(outside), 'A FILE OUTSIDE THE CALLER\'S STORAGE WAS DELETED')
      })

      await test('🔍 the storage root itself cannot be deleted', async () => {
        for (const attempt of ['.', '', './']) {
          const res = await client.call('tools/call', { name: 'delete_file', arguments: { path: attempt } })
          assert(res.result?.isError === true, `root delete allowed via "${attempt}"`)
        }
        assert(fs.existsSync(scopedFsDir), 'THE STORAGE ROOT WAS DELETED')
      })

      await test('🔍 a non-empty directory is refused and its contents survive', async () => {
        fs.mkdirSync(path.join(scopedFsDir, 'keepdir'), { recursive: true })
        fs.writeFileSync(path.join(scopedFsDir, 'keepdir', 'inner.txt'), 'inner')
        const res = await client.call('tools/call', { name: 'delete_file', arguments: { path: 'keepdir' } })
        assert(res.result?.isError === true, `non-empty directory was deleted: ${JSON.stringify(res.result)}`)
        assert(fs.existsSync(path.join(scopedFsDir, 'keepdir', 'inner.txt')), 'directory contents were removed')
      })

      await test('an empty directory is accepted', async () => {
        fs.mkdirSync(path.join(scopedFsDir, 'emptydir'), { recursive: true })
        const res = await client.call('tools/call', { name: 'delete_file', arguments: { path: 'emptydir' } })
        assert(!res.result?.isError, `empty directory delete failed: ${JSON.stringify(res.result)}`)
        assert(!fs.existsSync(path.join(scopedFsDir, 'emptydir')), 'the empty directory is still there')
      })

      await test('🔍 an item already in .trash/ is refused, never permanently removed', async () => {
        // Emptying the bin is a different operation with a different risk
        // profile. Allowing it here would hand the model a path it could use to
        // make this tool destructive after all.
        fs.mkdirSync(path.join(scopedFsDir, '.trash', 'bucket'), { recursive: true })
        const trashed = path.join(scopedFsDir, '.trash', 'bucket', 'gone.txt')
        fs.writeFileSync(trashed, 'already trashed')
        const res = await client.call('tools/call', { name: 'delete_file', arguments: { path: '.trash/bucket/gone.txt' } })
        assert(res.result?.isError === true, `trash emptying was allowed: ${JSON.stringify(res.result)}`)
        assert(fs.existsSync(trashed), 'a trashed file was PERMANENTLY removed')
      })

      await test('a missing path reports not-found rather than succeeding silently', async () => {
        const res = await client.call('tools/call', { name: 'delete_file', arguments: { path: 'no-such-file.txt' } })
        assert(res.result?.isError === true, `expected an error: ${JSON.stringify(res.result)}`)
      })

      await test('banning file_system also removes the delete tool', async () => {
        // delete_file is in CAPABILITY_TOOL_NAMES.file_system, so a capability
        // ban expands to cover it — the tool most worth banning must not be the
        // one the ban misses.
        const banned = { ...buildGatewayConfig(fsProfile), disabledTools: expandDisabledToolIds(['file_system']) }
        updateMcpConfig(banned)
        const names = (await client.call('tools/list')).result.tools.map(t => t.name)
        assert(!names.includes('delete_file'), 'a file_system ban did not cover delete_file')
        updateMcpConfig(buildGatewayConfig(fsProfile))
      })
    }

    // restore default policy + stop the child so later capability reads see the
    // secure default and no orphaned process survives the suite.
    storageFs.setCapabilityConfig('file_system', { allowWrite: true, allowDestructive: false })
    fsProvider.stopFilesystemProvider()
    updateMcpConfig(baseConfig)
  }

  // -------------------------------------------------------------------------
  // Tool provenance annotation + admin tool bans.
  //
  // Two properties, both of which used to be missing:
  //
  //   1. tools/list carries the capability and class of every tool in _meta, so
  //      a client can act on capability IDENTITY rather than tool names. The
  //      chat-ui's filesystem precedence rule was previously expressed as a name
  //      collision and stopped working, silently, when Nest renamed its file
  //      tools.
  //
  //   2. Bans are enforced HERE, not only in the completions proxy. Previously
  //      disabledTools was read exclusively by tools-gateway.mjs, so a banned
  //      tool was stripped from the model's vocabulary while this server still
  //      advertised it AND still executed it for anyone calling tools/call
  //      directly — which is what an MCP client does by definition.
  // -------------------------------------------------------------------------
  console.log('\n-- tool provenance annotation --')

  {
    updateMcpConfig({ ...baseConfig, documents: { enabled: true, outputDir: tmpDocsDir } })

    await test('every advertised tool carries its capability and class in _meta', async () => {
      const res = await client.call('tools/list')
      for (const tool of res.result.tools) {
        assert(tool._meta, `${tool.name} has no _meta`)
        assert(
          Object.prototype.hasOwnProperty.call(tool._meta, 'redstart/capability'),
          `${tool.name} is missing redstart/capability`,
        )
        assert(
          typeof tool._meta['redstart/class'] === 'string',
          `${tool.name} is missing redstart/class`,
        )
      }
      return `${res.result.tools.length} tools`
    })

    await test('the annotated capability matches CAPABILITY_TOOL_NAMES', async () => {
      const res = await client.call('tools/list')
      for (const tool of res.result.tools) {
        assert(
          tool._meta['redstart/capability'] === capabilityForTool(tool.name),
          `${tool.name} claims capability ${tool._meta['redstart/capability']}, expected ${capabilityForTool(tool.name)}`,
        )
      }
    })

    await test('the annotated class matches classifyTool — the same map the gate uses', async () => {
      const res = await client.call('tools/list')
      for (const tool of res.result.tools) {
        assert(
          tool._meta['redstart/class'] === classifyTool(tool.name),
          `${tool.name} claims class ${tool._meta['redstart/class']}, expected ${classifyTool(tool.name)}`,
        )
      }
    })

    await test('standard MCP annotation hints mirror the class', async () => {
      const res = await client.call('tools/list')
      const doc = res.result.tools.find(t => t.name === 'create_document')
      const read = res.result.tools.find(t => t.name === 'read_document')
      const fetch = res.result.tools.find(t => t.name === 'web_fetch')
      assert(doc?.annotations?.readOnlyHint === false, 'create_document is not marked as mutating')
      assert(read?.annotations?.readOnlyHint === true, 'read_document is not marked read-only')
      assert(fetch?.annotations?.openWorldHint === true, 'web_fetch is not marked open-world')
      assert(
        res.result.tools.every(t => t.annotations.destructiveHint === false),
        'a tool is flagged destructive while no destructive tool exists yet',
      )
    })

    updateMcpConfig(baseConfig)
  }

  console.log('\n-- admin tool bans (enforced at the MCP chokepoint) --')

  {
    const bannedConfig = {
      ...baseConfig,
      documents: { enabled: true, outputDir: tmpDocsDir },
      disabledTools: ['create_document'],
    }
    updateMcpConfig(bannedConfig)

    await test('a banned tool is not advertised in tools/list', async () => {
      const res = await client.call('tools/list')
      const names = res.result.tools.map(t => t.name)
      assert(!names.includes('create_document'), `banned tool still advertised: ${JSON.stringify(names)}`)
      // Its siblings from the same capability are untouched — the ban is by
      // tool name, not by capability.
      assert(names.includes('read_document'), 'the ban took out the whole capability')
    })

    await test('🔍 a banned tool is REFUSED on a direct tools/call, bypassing the filtered list', async () => {
      // The regression that mattered: the completions proxy stripped the name
      // from the payload, but this server executed it happily for any client
      // that called it directly.
      const res = await client.call('tools/call', {
        name: 'create_document',
        arguments: { title: 'banned', content: 'should not exist', format: 'markdown' },
      })
      assert(res.result?.isError === true, `banned tool executed: ${JSON.stringify(res.result)}`)
      assert(
        /disabled by an administrator/i.test(res.result.content[0].text),
        `unexpected refusal reason: ${res.result.content[0].text}`,
      )
    })

    await test('lifting the ban restores the tool', async () => {
      updateMcpConfig({ ...bannedConfig, disabledTools: [] })
      const res = await client.call('tools/list')
      assert(res.result.tools.map(t => t.name).includes('create_document'), 'tool did not come back')
    })

    updateMcpConfig(baseConfig)
  }

  console.log('\n-- installed plugin: ban propagation (Trap 3 / T21) --')

  {
    const add = addPlugin({
      id: 'banproptest',
      displayName: 'Ban Propagation Fixture',
      source: { kind: 'command', command: process.execPath, args: [PLUGIN_FIXTURE, 'normal'] },
      resolvedCommand: process.execPath,
      resolvedArgs: [PLUGIN_FIXTURE, 'normal'],
      env: {},
      timeoutMs: 15000,
      enabled: true, // install-level switch on
      allowWrite: false,
      allowDestructive: false,
      tools: [
        { name: 'echo', description: 'Echo the supplied text back.', inputSchema: {}, class: 'read' },
        { name: 'write_thing', description: 'Pretends to write something.', inputSchema: {}, class: 'write' },
      ],
    })
    assert(add.ok, `addPlugin failed: ${add.error}`)

    try {
      // Per-profile switch on too (plan decision D-a — both required).
      const pluginActiveConfig = { ...baseConfig, banproptest: { enabled: true } }
      updateMcpConfig(pluginActiveConfig)

      await test('an active plugin advertises its namespaced tools', async () => {
        const res = await client.call('tools/list')
        const names = res.result.tools.map(t => t.name)
        assert(names.includes('banproptest__echo'), `plugin tool missing from tools/list: ${JSON.stringify(names)}`)
        assert(names.includes('banproptest__write_thing'), 'second plugin tool missing')
      })

      await test('🔍 banning the plugin id removes ALL of its tools from tools/list', async () => {
        updateMcpConfig({ ...pluginActiveConfig, disabledTools: expandDisabledToolIds(['banproptest']) })
        const res = await client.call('tools/list')
        const names = res.result.tools.map(t => t.name)
        assert(!names.includes('banproptest__echo'), 'banned plugin tool still advertised')
        assert(!names.includes('banproptest__write_thing'), 'banned plugin tool still advertised')
      })

      await test('🔍 a banned plugin tool is refused on a DIRECT call, bypassing the filtered list', async () => {
        const res = await client.call('tools/call', { name: 'banproptest__echo', arguments: { text: 'x' } })
        assert(res.result?.isError === true, `banned plugin tool executed: ${JSON.stringify(res.result)}`)
      })

      await test('lifting the ban restores the plugin\'s tools', async () => {
        updateMcpConfig(pluginActiveConfig)
        const res = await client.call('tools/list')
        const names = res.result.tools.map(t => t.name)
        assert(names.includes('banproptest__echo'), 'plugin tool did not come back after the ban was lifted')
      })
    } finally {
      updateMcpConfig(baseConfig)
      removePlugin('banproptest')
    }
  }

  console.log('\n-- postgres provider --')

  const pgReachable = await isPostgresReachable(PG_URL)
  if (!pgReachable) {
    console.log(`  skip - no Postgres reachable at ${PG_URL.replace(/:[^:@]*@/, ':***@')} (set REDSTART_TEST_PG_URL to point at a throwaway database to exercise these)`)
  } else {
    updateMcpConfig({ ...baseConfig, documents: { enabled: true, outputDir: tmpDocsDir }, postgres: { enabled: true, connectionString: PG_URL, maxRows: 200 } })

    await test('tools/list includes postgres_query/list_tables/describe_table once enabled', async () => {
      const res = await client.call('tools/list')
      const names = res.result.tools.map(t => t.name)
      for (const n of ['postgres_query', 'postgres_list_tables', 'postgres_describe_table']) {
        assert(names.includes(n), `expected ${n} in ${JSON.stringify(names)}`)
      }
    })

    await test('postgres_query SELECT 1 returns a row', async () => {
      const res = await client.call('tools/call', { name: 'postgres_query', arguments: { sql: 'SELECT 1 AS one' } })
      assert(!res.result?.isError, `unexpected error: ${JSON.stringify(res.result)}`)
      assert(res.result.content[0].text.includes('one'), `unexpected output: ${res.result.content[0].text}`)
    })

    await test('postgres_list_tables does not error', async () => {
      const res = await client.call('tools/call', { name: 'postgres_list_tables', arguments: {} })
      assert(!res.result?.isError, `unexpected error: ${JSON.stringify(res.result)}`)
    })

    await test('🔍 postgres_query rejects a write statement (READ ONLY transaction enforced by the database)', async () => {
      const res = await client.call('tools/call', {
        name: 'postgres_query',
        arguments: { sql: 'CREATE TABLE redstart_mcp_test_should_never_exist (id int)' },
      })
      assert(res.result?.isError === true, `expected the write to be rejected, got ${JSON.stringify(res.result)}`)
    })

    await test('postgres_describe_table on a nonexistent table -> isError', async () => {
      const res = await client.call('tools/call', { name: 'postgres_describe_table', arguments: { table: 'table_that_does_not_exist_12345' } })
      assert(res.result?.isError === true, `expected isError:true, got ${JSON.stringify(res.result)}`)
    })
  }

  client.close()
  await stopMcpServer()
  fs.rmSync(tmpUserDataDir, { recursive: true, force: true })
  fs.rmSync(tmpDocsDir, { recursive: true, force: true })
  fs.rmSync(tmpSqliteDir, { recursive: true, force: true })
  fs.rmSync(tmpVaultDir, { recursive: true, force: true })
  fs.rmSync(tmpGitDir, { recursive: true, force: true })
  fs.rmSync(tmpFsDir, { recursive: true, force: true })

  console.log('\n' + '='.repeat(60))
  const passed = results.filter(r => r.pass).length
  const failed = results.length - passed
  console.log(`${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`)
  console.log('='.repeat(60))

  if (failed) process.exit(1)
}

main().catch(err => {
  console.error('Test run crashed:', err)
  process.exit(1)
})
