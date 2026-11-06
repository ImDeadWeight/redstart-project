// =============================================================================
// search_documents (chat-tooling Phase 5a) — private RAG over a user's own files
// =============================================================================
// Pinned here:
//   - chunking: fixed windows with overlap, cut at a boundary, nothing lost
//   - ranking: BM25 finds an exact term; vectors, when given, lift paraphrase;
//     with no embedder (or one that dies) search still works on words
//   - sync is mtime-on-access: new, changed and deleted files; the trash,
//     links, oversized and unreadable files are skipped; a time budget leaves
//     the rest pending and says so
//   - ISOLATION: one account's search never returns another account's passage
//   - conversation workspaces (chats/<id>/) are searched (Phase 1 uploads)
//   - the result numbers passages, names files, links each source (Phase 2)
//   - the store keeps grant_id (5b needs no schema change), persists across a
//     reopen, and a corrupt index is rebuilt rather than fatal
//   - the manual rebuild clears only the caller's scope
//
// Run:  node scripts/test-document-search.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-docsearch-test-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir
register('./auth-test-loader.mjs', import.meta.url)
await import('./electron-stub.mjs')

const idx = await import('../daemon/document-index.mjs')
const tool = await import('../daemon/document-search-tool.mjs')
const { resolveUserRoot } = await import('../daemon/user-scope.mjs')
const { classifyTool } = await import('../daemon/tools-definitions.mjs')
const { narrowConfig } = await import('../daemon/permissions.mjs')

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

const indexDir = fs.mkdtempSync(path.join(tmpDir, 'index-'))
const docs = fs.mkdtempSync(path.join(tmpDir, 'docs-'))
const ALICE = { id: 'alice-0001', username: 'alice' }
const BOB = { id: 'bob-00002', username: 'bob' }
const aliceRoot = resolveUserRoot(docs, ALICE, { create: true })
const bobRoot = resolveUserRoot(docs, BOB, { create: true })
const CFG = { documentSearch: { enabled: true, documentsRoot: docs } }
const readText = async (f) => fs.readFileSync(f, 'utf8')

// A deterministic stand-in for the embedding model: a vector per concept, so
// a paraphrase with no shared word still lands near its passage.
const CONCEPTS = [/notice|terminat|quit|resign|leav/i, /holiday|vacation|annual leave|time off/i, /salary|pay|wage|compensat/i, /encrypt|tls|https/i]
const fakeEmbed = async (texts) => texts.map((t) => Float32Array.from(CONCEPTS.map((re) => (re.test(t) ? 1 : 0)).concat([0.05])))

await test('chunkText: windows overlap, cut on a boundary, and keep every word', () => {
  const words = Array.from({ length: 900 }, (_, i) => `w${i}`).join(' ')
  const chunks = idx.chunkText(words, { size: 1200, overlap: 200 })
  assert(chunks.length > 3, `${chunks.length} chunks`)
  assert(chunks.every((c) => c.length <= 1200), 'a chunk is over size')
  assert(chunks.every((c) => /^w\d+/.test(c) && /w\d+$/.test(c)), 'a chunk was cut mid-word')
  const joined = new Set(chunks.join(' ').split(' '))
  for (let i = 0; i < 900; i++) assert(joined.has(`w${i}`), `w${i} lost`)
  assert(idx.chunkText('   \n\n  ').length === 0, 'blank text produced a chunk')
})

await test('BM25 ranks the exact term first; vectors lift a paraphrase; no vector → words only', () => {
  const chunks = [
    { text: 'Policy HR-2041: employees must give four weeks notice before resigning.', vector: Float32Array.from([1, 0, 0, 0, 0.05]) },
    { text: 'The office kitchen is cleaned on Fridays.', vector: Float32Array.from([0, 0, 0, 0, 0.05]) },
    { text: 'Annual leave is 25 days plus public holidays.', vector: Float32Array.from([0, 1, 0, 0, 0.05]) },
  ]
  assert(idx.rankChunks(chunks, 'HR-2041', null)[0].chunk === chunks[0], 'exact term not first')
  const para = idx.rankChunks(chunks, 'how much vacation do I get', Float32Array.from([0, 1, 0, 0, 0.05]))
  assert(para[0]?.chunk === chunks[2], 'paraphrase not lifted by the vector')
  assert(idx.rankChunks(chunks, 'how much vacation do I get', null).length === 0, 'words-only matched nothing-in-common text')
})

// Alice's files: a policy, a CSV, a file in a conversation workspace, plus
// things that must NOT be indexed.
fs.writeFileSync(path.join(aliceRoot, 'handbook.md'), '# Handbook\n\nPolicy HR-2041: employees must give four weeks notice before resigning.\n\nAnnual leave is 25 days plus public holidays.')
fs.writeFileSync(path.join(aliceRoot, 'salaries.csv'), 'role,pay\nengineer,90000\ndesigner,80000')
fs.mkdirSync(path.join(aliceRoot, 'chats', 'conv-9'), { recursive: true })
fs.writeFileSync(path.join(aliceRoot, 'chats', 'conv-9', 'notes.txt'), 'The Q3 launch codename is BLUEFINCH.')
fs.mkdirSync(path.join(aliceRoot, '.trash', 'old'), { recursive: true })
fs.writeFileSync(path.join(aliceRoot, '.trash', 'old', 'deleted.md'), 'TRASHEDSECRET should never be found')
fs.writeFileSync(path.join(aliceRoot, 'program.exe'), 'MZ binary EXESECRET')
const outside = fs.mkdtempSync(path.join(tmpDir, 'outside-'))
fs.writeFileSync(path.join(outside, 'leak.md'), 'LINKEDSECRET outside the root')
try { fs.symlinkSync(outside, path.join(aliceRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir') } catch {}
// Bob's file with a term only he has.
fs.writeFileSync(path.join(bobRoot, 'bob.md'), 'Bob private plan: the codename is OSPREY. Four weeks notice applies to Bob too.')

tool._setTestSeams({ dir: indexDir, embed: null })

await test('syncScope indexes what is there and skips trash, links and non-text files', async () => {
  const s = await idx.syncScope({ dir: indexDir, scope: 'alice-scope', root: aliceRoot, extract: readText })
  assert(s.files === 3 && s.indexed === 3 && s.pending === 0, JSON.stringify(s))
  for (const secret of ['TRASHEDSECRET', 'EXESECRET', 'LINKEDSECRET']) {
    const hits = await idx.searchScope({ dir: indexDir, scope: 'alice-scope', query: secret })
    assert(hits.length === 0, `${secret} was indexed`)
  }
})

await test('mtime-on-access: a changed file is re-indexed, a deleted one dropped, an unchanged one left', async () => {
  const p = path.join(aliceRoot, 'salaries.csv')
  fs.writeFileSync(p, 'role,pay\nengineer,95000\nmanager,120000')
  const future = new Date(Date.now() + 5000); fs.utimesSync(p, future, future)
  let s = await idx.syncScope({ dir: indexDir, scope: 'alice-scope', root: aliceRoot, extract: readText })
  assert(s.indexed === 1 && s.removed === 0, JSON.stringify(s))
  assert((await idx.searchScope({ dir: indexDir, scope: 'alice-scope', query: 'manager' })).length === 1, 'new content not found')
  assert((await idx.searchScope({ dir: indexDir, scope: 'alice-scope', query: 'designer' })).length === 0, 'old content still found')
  fs.writeFileSync(path.join(aliceRoot, 'gone.md'), 'EPHEMERAL text')
  await idx.syncScope({ dir: indexDir, scope: 'alice-scope', root: aliceRoot, extract: readText })
  fs.rmSync(path.join(aliceRoot, 'gone.md'))
  s = await idx.syncScope({ dir: indexDir, scope: 'alice-scope', root: aliceRoot, extract: readText })
  assert(s.removed === 1 && s.indexed === 0, JSON.stringify(s))
  assert((await idx.searchScope({ dir: indexDir, scope: 'alice-scope', query: 'EPHEMERAL' })).length === 0, 'a deleted file is still searchable')
})

await test('a time budget leaves files pending and the result says so', async () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'budget-'))
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, `f${i}.md`), `file ${i}`)
  let t = 0
  const s = await idx.syncScope({ dir: indexDir, scope: 'budget', root, extract: readText, budgetMs: 1, now: () => (t += 2) })
  assert(s.pending > 0 && s.indexed < 5, JSON.stringify(s))
  const text = tool.formatHits([], { query: 'x', status: { ...s, semantic: false } })
  assert(/still being indexed/.test(text) && /words only/.test(text), text)
})

await test('an unreadable file is reported, not fatal', async () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'bad-'))
  fs.writeFileSync(path.join(root, 'ok.md'), 'readable words here')
  fs.writeFileSync(path.join(root, 'broken.pdf'), 'not a pdf')
  const s = await idx.syncScope({ dir: indexDir, scope: 'bad', root, extract: async (f) => { if (f.endsWith('.pdf')) throw new Error('bad xref'); return readText(f) } })
  assert(s.indexed === 2 && s.errors.length === 1 && /broken\.pdf/.test(s.errors[0]), JSON.stringify(s))
})

await test('🔍 ISOLATION: Alice\'s search never returns Bob\'s passage, and the reverse', async () => {
  // Checked by the PASSAGE and the FILE, not the query term: the no-match
  // message echoes the query back.
  const a = await tool.callTool('search_documents', { query: 'OSPREY codename' }, CFG, { account: ALICE })
  assert(!a.content[0].text.includes('Bob private plan') && !a.content[0].text.includes('bob.md'), `alice saw bob's passage: ${a.content[0].text}`)
  assert(!a.content.some((c) => c.type === 'resource_link' && c.uri.includes('bob')), 'alice got a link to a file of bob')
  const b = await tool.callTool('search_documents', { query: 'BLUEFINCH' }, CFG, { account: BOB })
  assert(!b.content[0].text.includes('launch codename') && !b.content[0].text.includes('notes.txt'), `bob saw alice's passage: ${b.content[0].text}`)
  const both = await tool.callTool('search_documents', { query: 'four weeks notice' }, CFG, { account: BOB })
  assert(both.content[0].text.includes('bob.md') && !both.content[0].text.includes('handbook.md'), both.content[0].text)
})

await test('conversation workspaces are searched, and results cite, link and say words-only', async () => {
  const r = await tool.callTool('search_documents', { query: 'BLUEFINCH launch' }, CFG, { account: ALICE })
  const text = r.content[0].text
  assert(/^\[1\] chats\/conv-9\/notes\.txt \(part 1\)/m.test(text), text)
  assert(/Cite each claim/.test(text) && /words only/.test(text), text)
  const link = r.content.find((c) => c.type === 'resource_link')
  assert(link && link.uri === '/files/download?path=' + encodeURIComponent('chats/conv-9/notes.txt'), JSON.stringify(r.content))
})

await test('with an embedder: vectors are stored and a paraphrase finds the passage', async () => {
  tool._setTestSeams({ embed: fakeEmbed })
  const r = await tool.callTool('search_documents', { query: 'how much vacation time do I get' }, CFG, { account: ALICE })
  assert(/handbook\.md/.test(r.content[0].text) && !/words only/.test(r.content[0].text), r.content[0].text)
  tool._setTestSeams({ embed: async () => null })   // sidecar died mid-session
  const dead = await tool.callTool('search_documents', { query: 'HR-2041' }, CFG, { account: ALICE })
  assert(/handbook\.md/.test(dead.content[0].text), 'a dead embedder broke search')
  tool._setTestSeams({ embed: null })
})

await test('the schema carries grant_id (5b), and the index persists across a reopen', async () => {
  idx.closeAll()
  const initSqlJs = (await import('sql.js')).default
  const SQL = await initSqlJs()
  const d = new SQL.Database(fs.readFileSync(path.join(indexDir, idx.INDEX_FILE)))
  const cols = d.exec('PRAGMA table_info(chunks)')[0].values.map((v) => v[1])
  assert(cols.includes('grant_id') && cols.includes('scope'), cols.join(','))
  const nonNull = d.exec('SELECT COUNT(*) FROM chunks WHERE grant_id IS NOT NULL')[0].values[0][0]
  assert(nonNull === 0, '5a wrote a grant id')
  d.close()
  const hits = await idx.searchScope({ dir: indexDir, scope: 'alice-scope', query: 'HR-2041' })
  assert(hits.length > 0, 'nothing survived the reopen')
})

await test('a corrupt index file is moved aside and rebuilt', async () => {
  idx.closeAll()
  const dir = fs.mkdtempSync(path.join(tmpDir, 'corrupt-'))
  fs.writeFileSync(path.join(dir, idx.INDEX_FILE), 'this is not sqlite')
  const root = fs.mkdtempSync(path.join(tmpDir, 'croot-'))
  fs.writeFileSync(path.join(root, 'a.md'), 'recoverable text')
  const s = await idx.syncScope({ dir, scope: 'c', root, extract: readText })
  assert(s.indexed === 1, JSON.stringify(s))
  assert(fs.readdirSync(dir).some((f) => f.includes('.corrupt-')), 'the bad file was not kept')
})

await test('the manual rebuild clears only the caller\'s scope', async () => {
  await tool.rebuildIndexFor(ALICE)
  const stats = await idx.scopeStats({ dir: indexDir, scope: tool.scopeFor(ALICE) })
  assert(stats.files === 0, JSON.stringify(stats))
  const bob = await idx.scopeStats({ dir: indexDir, scope: tool.scopeFor(BOB) })
  assert(bob.files === 1, `bob's index was touched: ${JSON.stringify(bob)}`)
  const again = await tool.callTool('search_documents', { query: 'HR-2041' }, CFG, { account: ALICE })
  assert(/handbook\.md/.test(again.content[0].text), 'the next search did not rebuild')
})

await test('class read; a role withholds it; off serves nothing', async () => {
  assert(classifyTool('search_documents') === 'read', 'class')
  const narrowed = narrowConfig({ ...CFG, disabledTools: [] }, { capabilities: [] })
  assert(narrowed.documentSearch.enabled === false && narrowed.disabledTools.includes('search_documents'), 'survived the role')
  assert(tool.toolDefs({ documentSearch: { enabled: false } }).length === 0, 'advertised while off')
  const r = await tool.callTool('search_documents', { query: 'x' }, { documentSearch: { enabled: false } }, { account: ALICE })
  assert(r.isError, 'ran while off')
})

idx.closeAll()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
process.exit(failed.length ? 1 : 0)
