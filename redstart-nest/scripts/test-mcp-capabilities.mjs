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
import pg from 'pg'

const tmpUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-mcp-test-userdata-'))
const tmpDocsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-mcp-test-docs-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpUserDataDir

register('./auth-test-loader.mjs', import.meta.url)

const { startMcpServer, stopMcpServer } = await import('../electron/main/mcp-server.mjs')

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

// ---------------------------------------------------------------------------
// Minimal MCP SSE/JSON-RPC client — enough to drive tools/list + tools/call
// against the real running server, the same way the chat-ui's MCP client does.
// ---------------------------------------------------------------------------

async function connectMcpClient(baseUrl) {
  const sseRes = await fetch(`${baseUrl}/sse`)
  if (!sseRes.ok || !sseRes.body) throw new Error(`SSE connect failed: ${sseRes.status}`)

  const reader = sseRes.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let endpointPath = null
  const pending = new Map()
  let nextId = 0

  ;(async function pump() {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const lines = rawEvent.split('\n')
          const eventLine = lines.find(l => l.startsWith('event: '))
          const dataLine = lines.find(l => l.startsWith('data: '))
          if (!dataLine) continue
          const data = JSON.parse(dataLine.slice(6))
          const eventType = eventLine ? eventLine.slice(7) : 'message'
          if (eventType === 'endpoint') {
            endpointPath = data
          } else if (data?.id !== undefined && pending.has(data.id)) {
            pending.get(data.id).resolve(data)
            pending.delete(data.id)
          }
        }
      }
    } catch { /* stream closed */ }
  })()

  const start = Date.now()
  while (!endpointPath) {
    if (Date.now() - start > 5000) throw new Error('Timed out waiting for SSE endpoint event')
    await new Promise(r => setTimeout(r, 20))
  }

  async function call(method, params) {
    const id = ++nextId
    const promise = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`Timed out waiting for response to ${method}`)) }
      }, 8000)
    })
    await fetch(`${baseUrl}${endpointPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    })
    return promise
  }

  return { call, close: () => reader.cancel().catch(() => {}) }
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
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`userData dir: ${tmpUserDataDir}`)
  console.log(`documents output dir: ${tmpDocsDir}`)

  const baseConfig = {
    webFetch: { allowedBaseUrls: ['https://en.wikipedia.org'], activeTools: [{ name: 'Wikipedia', baseUrl: 'https://en.wikipedia.org', description: '' }], maxFetchTokens: 2000 },
    postgres: { enabled: false, connectionString: null, maxRows: 200 },
    documents: { enabled: false, outputDir: tmpDocsDir },
  }

  await startMcpServer(MCP_PORT, baseConfig)
  const mcpUrl = `http://127.0.0.1:${MCP_PORT}`

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

  console.log('\n-- documents provider --')

  // Live-update config: documents enabled, postgres still off.
  const { updateMcpConfig } = await import('../electron/main/mcp-server.mjs')
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
