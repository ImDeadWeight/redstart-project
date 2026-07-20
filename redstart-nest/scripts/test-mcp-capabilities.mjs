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
import pg from 'pg'

const tmpUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-mcp-test-userdata-'))
const tmpDocsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-mcp-test-docs-'))
const tmpSqliteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-mcp-test-sqlite-'))
const tmpVaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-mcp-test-vault-'))
const tmpGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-mcp-test-git-'))
const tmpFsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-mcp-test-fs-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpUserDataDir

register('./auth-test-loader.mjs', import.meta.url)

const { startMcpServer, stopMcpServer } = await import('../electron/main/mcp-server.mjs')
const { setAuthRequired } = await import('../electron/main/auth.mjs')

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
    const resolvedDocsDir = path.resolve(tmpDocsDir)
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
    fs.writeFileSync(path.join(tmpDocsDir, 'long.txt'), 'A'.repeat(9000) + 'ZEBRA-MARKER')
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
    fs.writeFileSync(path.join(tmpDocsDir, 'binary.exe'), 'MZ')
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
    await wb.xlsx.writeFile(path.join(tmpDocsDir, 'caseload.xlsx'))

    const res = await client.call('tools/call', { name: 'read_document', arguments: { path: 'caseload.xlsx' } })
    assert(!res.result?.isError, `read failed: ${JSON.stringify(res.result)}`)
    const text = res.result.content[0].text
    assert(text.includes('=== Sheet: Caseload ==='), `missing sheet header: ${text}`)
    assert(text.includes('Henderson | 12'), `missing row: ${text}`)
    assert(text.includes('Total | 15'), `formula not resolved to result: ${text}`)
    assert(text.includes('=== Sheet: Budget ===') && text.includes('1250.5'), `missing second sheet: ${text}`)
  })

  await test('read_document reads a .csv file', async () => {
    fs.writeFileSync(path.join(tmpDocsDir, 'export.csv'), 'name,status\nHenderson,active\nAlvarez,waitlist\n')
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
    assert(text.includes('#intake (2)') && text.includes('#followup (1)'), `unexpected tags: ${text}`)
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
      for (const n of ['git_status', 'git_log', 'git_diff']) assert(names.includes(n), `expected ${n} in ${JSON.stringify(names)}`)
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
      const bytes = fs.readFileSync(path.join(tmpDocsDir, filename))
      assert(bytes.subarray(0, 4).toString() === '%PDF', 'saved file is not a PDF')
      const read = await client.call('tools/call', { name: 'read_document', arguments: { path: filename } })
      assert(!read.result?.isError && /attention/i.test(read.result.content[0].text), `read-back failed: ${JSON.stringify(read.result).slice(0, 300)}`)
    })
  } else {
    console.log('  skip - live scholar tests (set REDSTART_TEST_LIVE_WEB=1 to run)')
  }

  console.log('\n-- file system provider (via buildGatewayConfig) --')

  // File System is the one read/write capability, so it's exercised end-to-end
  // through the REAL producer (buildGatewayConfig) and the MCP HTTP path — not a
  // hand-built config. The vitest fs suite calls fs-tool directly with a
  // hand-built { fileSystem: ... } config, which can't catch a producer that
  // emits the wrong key (the snake_case `file_system` bug that silently disabled
  // the capability in production). These tests go through the seam that hid it.
  {
    const { buildGatewayConfig } = await import('../electron/main/gateway-config.mjs')
    const storageFs = await import('../electron/main/tools-storage.mjs')
    storageFs.setCapabilityConfig('file_system', { enabled: true, rootDir: tmpFsDir })
    fs.writeFileSync(path.join(tmpFsDir, 'note.txt'), 'hello world')
    const fsProfile = { tools: { enabled: true, activeToolIds: ['file_system'] } }

    await test('🔍 buildGatewayConfig emits camelCase fileSystem (producer/consumer keys agree)', async () => {
      const cfg = buildGatewayConfig(fsProfile)
      assert(cfg.fileSystem?.enabled === true, `expected cfg.fileSystem.enabled true; keys: ${JSON.stringify(Object.keys(cfg))}`)
      assert(cfg.file_system === undefined, 'must not emit snake_case file_system — fs-tool reads cfg.fileSystem')
    })

    updateMcpConfig(buildGatewayConfig(fsProfile))

    await test('tools/list advertises fs_* once File System is active (regression: config key)', async () => {
      const res = await client.call('tools/list')
      const names = res.result.tools.map(t => t.name)
      // Non-destructive tools only — fs_delete_file is gated off by default (see
      // the permission-gate tests below); this guards the config-key wiring.
      for (const n of ['fs_read_file', 'fs_write_file', 'fs_list_directory']) {
        assert(names.includes(n), `expected ${n} in ${JSON.stringify(names)}`)
      }
    })

    await test('fs_read_file reads a file within the configured root', async () => {
      const res = await client.call('tools/call', { name: 'fs_read_file', arguments: { path: 'note.txt' } })
      assert(!res.result?.isError, `unexpected error: ${JSON.stringify(res.result)}`)
      assert(res.result.content[0].text.includes('hello world'), `unexpected content: ${res.result.content[0].text}`)
    })

    // --- Permission gate (Plan 2): writes on, deletes off by default ---

    await test('🔍 fs_delete_file is NOT advertised under the default policy (destructive off)', async () => {
      const names = (await client.call('tools/list')).result.tools.map(t => t.name)
      assert(!names.includes('fs_delete_file'), `fs_delete_file must be hidden by default; got ${JSON.stringify(names.filter(n => n.startsWith('fs_')))}`)
      assert(names.includes('fs_write_file'), 'fs_write_file should be advertised (writes on by default)')
    })

    await test('🔍 fs_delete_file is refused by the server gate even when called directly (default policy)', async () => {
      fs.writeFileSync(path.join(tmpFsDir, 'victim.txt'), 'delete me')
      const res = await client.call('tools/call', { name: 'fs_delete_file', arguments: { path: 'victim.txt' } })
      assert(res.result?.isError === true, `expected gate refusal, got ${JSON.stringify(res.result)}`)
      assert(fs.existsSync(path.join(tmpFsDir, 'victim.txt')), 'file must NOT be deleted while destructive ops are disabled')
    })

    await test('fs_write_file works under the default policy (writes allowed)', async () => {
      const res = await client.call('tools/call', { name: 'fs_write_file', arguments: { path: 'written.txt', content: 'hi there' } })
      assert(!res.result?.isError, `unexpected error: ${JSON.stringify(res.result)}`)
      assert(fs.readFileSync(path.join(tmpFsDir, 'written.txt'), 'utf8').includes('hi there'), 'file was not written')
    })

    storageFs.setCapabilityConfig('file_system', { allowDestructive: true })
    updateMcpConfig(buildGatewayConfig(fsProfile))

    await test('fs_delete_file is advertised and works once destructive ops are enabled', async () => {
      const names = (await client.call('tools/list')).result.tools.map(t => t.name)
      assert(names.includes('fs_delete_file'), 'fs_delete_file should be advertised after opt-in')
      const res = await client.call('tools/call', { name: 'fs_delete_file', arguments: { path: 'victim.txt' } })
      assert(!res.result?.isError, `delete failed after opt-in: ${JSON.stringify(res.result)}`)
      assert(!fs.existsSync(path.join(tmpFsDir, 'victim.txt')), 'file should be deleted after opt-in')
    })

    storageFs.setCapabilityConfig('file_system', { allowWrite: false, allowDestructive: false })
    updateMcpConfig(buildGatewayConfig(fsProfile))

    await test('🔍 fs_write_file is refused when writes are disabled by policy', async () => {
      const res = await client.call('tools/call', { name: 'fs_write_file', arguments: { path: 'blocked.txt', content: 'x' } })
      assert(res.result?.isError === true, `expected write refusal, got ${JSON.stringify(res.result)}`)
      assert(!fs.existsSync(path.join(tmpFsDir, 'blocked.txt')), 'file must not be written when writes are disabled')
    })

    // --- Permission escalation: a caller cannot grant itself permission by
    // smuggling policy fields into the tool arguments. The gate reads the
    // server-side capability config, never the call's arguments, so these are
    // inert. (Policy is still writes-off / destructive-off from above.)

    await test('🔍 fs_write_file cannot self-promote via policy fields in arguments', async () => {
      const res = await client.call('tools/call', { name: 'fs_write_file', arguments: {
        path: 'escalate.txt', content: 'x',
        allowWrite: true, allowDestructive: true,
        policy: { allowWrite: true }, fileSystem: { allowWrite: true },
      } })
      assert(res.result?.isError === true, `write self-promotion was allowed: ${JSON.stringify(res.result)}`)
      assert(!fs.existsSync(path.join(tmpFsDir, 'escalate.txt')), 'file was written despite writes being disabled')
    })

    await test('🔍 fs_delete_file cannot self-promote via policy fields in arguments', async () => {
      fs.writeFileSync(path.join(tmpFsDir, 'keep.txt'), 'do not delete')
      const res = await client.call('tools/call', { name: 'fs_delete_file', arguments: {
        path: 'keep.txt',
        allowDestructive: true, policy: { allowDestructive: true },
      } })
      assert(res.result?.isError === true, `delete self-promotion was allowed: ${JSON.stringify(res.result)}`)
      assert(fs.existsSync(path.join(tmpFsDir, 'keep.txt')), 'file was deleted despite destructive ops being disabled')
    })

    // restore default policy so any later capability reads see the secure default
    storageFs.setCapabilityConfig('file_system', { allowWrite: true, allowDestructive: false })
    updateMcpConfig(baseConfig)
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
