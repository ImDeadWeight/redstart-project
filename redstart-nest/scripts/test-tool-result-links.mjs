// =============================================================================
// Tool results that carry files as MCP resource links (chat-tooling Phase 2)
// =============================================================================
// Pinned here:
//   - fileLink(): MCP's own resource_link shape, uri = the per-account
//     /files/download route, relative, with the path encoded
//   - linkText(): the one-line model copy, `[file: <path>, <mime>, <size>]`,
//     byte-for-byte what chat-ui's resourceLinkText produces (the same strings
//     are asserted in src/chat-ui/tests/unit/resource-links.test.ts)
//   - another server's link is never read as one of ours
//   - create_document returns a link to what it wrote, beside the [FILE:]
//     line older clients use
//
// Ownership (another account's link 404s) is in test-file-isolation.mjs,
// against the real gateway.
//
// Run:  node scripts/test-tool-result-links.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-links-test-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir
register('./auth-test-loader.mjs', import.meta.url)
await import('./electron-stub.mjs')

const links = await import('../daemon/tool-result-links.mjs')
const documentsTool = await import('../daemon/documents-tool.mjs')

const results = []
async function test(name, fn) {
  try {
    await fn()
    results.push({ name, pass: true })
    console.log(`  ok  - ${name}`)
  } catch (err) {
    results.push({ name, pass: false })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}
function assert(cond, message) { if (!cond) throw new Error(message) }

await test('fileLink is a resource_link to the per-account download route', () => {
  const l = links.fileLink('chats/c1/fig-1.png', { bytes: 41231 })
  assert(l.type === 'resource_link', l.type)
  assert(l.uri === '/files/download?path=chats%2Fc1%2Ffig-1.png', l.uri)
  assert(l.name === 'fig-1.png' && l.mimeType === 'image/png' && l.size === 41231, JSON.stringify(l))
})

await test('linkText matches chat-ui exactly', () => {
  assert(links.linkText(links.fileLink('chats/c1/fig-1.png', { bytes: 41231 })) === '[file: chats/c1/fig-1.png, image/png, 40 KB]', 'format drifted')
  assert(links.sizeLabel(512) === '512 B' && links.sizeLabel(2048) === '2.0 KB' && links.sizeLabel(5 * 1048576) === '5.0 MB', 'sizeLabel drifted')
})

await test('backslashes and a leading slash are normalised, never kept', () => {
  const l = links.fileLink('\\chats\\c1\\out.csv')
  assert(links.linkPath(l) === 'chats/c1/out.csv' && l.mimeType === 'text/csv', JSON.stringify(l))
})

await test('another server\'s link is not ours', () => {
  const foreign = { type: 'resource_link', uri: 'https://x.example/a.png', name: 'a.png' }
  assert(links.linkPath(foreign) === null, 'foreign link read as ours')
  assert(links.linkText(foreign).startsWith('[resource: '), links.linkText(foreign))
})

await test('create_document returns a link to the file it wrote', async () => {
  const docs = fs.mkdtempSync(path.join(tmpDir, 'docs-'))
  const res = await documentsTool.callTool('create_document', { title: 'Q3 numbers', content: 'a,b\n1,2', format: 'csv' }, { documents: { enabled: true, outputDir: docs } }, { account: { id: 'acct-1', username: 'pat' } })
  assert(!res.isError, res.content?.[0]?.text)
  const link = res.content.find((c) => c.type === 'resource_link')
  assert(link && links.linkPath(link) === 'q3-numbers.csv' && link.mimeType === 'text/csv' && link.size === 7, JSON.stringify(res.content))
  assert(/^\[FILE: q3-numbers\.csv\]/.test(res.content[0].text), 'the [FILE:] line older clients use is gone')
})

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
process.exit(failed.length ? 1 : 0)
