// =============================================================================
// create_document / read_document — formats, tables, the download marker
// =============================================================================
// Moved from chat-ui's tests/unit/documents-formats.test.ts and
// documents-tables.test.ts (master plan Phase 7b, app-boundaries step 2).
// They tested daemon/documents-tool.mjs from inside the chat app. Every case
// keeps its name and its assertions; only the harness changed.
//
// Pinned here:
//   - source and data formats are written verbatim (no title line, no
//     reflowing); an enclosing markdown fence is stripped; markdown keeps
//     its title heading
//   - format aliases and filename inference; .mjs is refused on purpose
//   - the new types read back and list
//   - extractText handles every type files-api previews as text
//   - parseBlocks finds pipe tables and nothing that only looks like one
//   - a docx gets a real Word table with one header row; pdf renders
//   - the result starts with a relative [FILE: ...] marker, never an
//     absolute path; bad calls name the real arguments
//
// The tool is called with no ctx — the auth-off case — so documents land in
// the anonymous caller's folder inside the configured root.
//
// Run:  node scripts/test-document-formats.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { deepStrictEqual } from 'node:assert/strict'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-document-formats-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir
register('./auth-test-loader.mjs', import.meta.url)
await import('./electron-stub.mjs')

const tool = await import('../daemon/documents-tool.mjs')
const { resolveUserRoot } = await import('../daemon/user-scope.mjs')
const mammoth = (await import('mammoth')).default

/** The configured capability root — what an admin picks in the Tools window. */
const outputDir = path.join(tmpDir, 'documents')
/** Where documents actually land: the anonymous caller's folder inside it. */
let writtenDir

const results = []
// A fresh documents folder per case, as both vitest files' beforeEach did.
async function test(name, fn) {
  try {
    fs.rmSync(outputDir, { recursive: true, force: true })
    fs.mkdirSync(outputDir, { recursive: true })
    writtenDir = resolveUserRoot(outputDir, null, { create: true })
    const detail = await fn()
    results.push({ name, pass: true })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}
function assert(cond, message) { if (!cond) throw new Error(message) }
function eq(actual, expected, what) {
  try { deepStrictEqual(actual, expected) } catch {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

const cfg = () => ({ documents: { enabled: true, outputDir } })

/** Call the documents provider and assert it claimed the tool name. */
async function callDocumentTool(name, args) {
  const result = await tool.callTool(name, args, cfg())
  assert(result !== null, `callTool returned null for ${name}`)
  return result
}
const written = (filename) => path.join(writtenDir, filename)
const readWritten = (filename) => fs.readFileSync(written(filename), 'utf8')
const exists = (filename) => fs.existsSync(written(filename))

// ---------------------------------------------------------------------------
console.log('\n-- create_document — verbatim formats --')

// format -> [expected filename, content that must survive byte-for-byte]
const verbatim = [
  ['text', 'note.txt', 'Line one\nLine two\n'],
  ['csv', 'note.csv', 'Date,Item\n2026-01-01,Tile\n'],
  ['json', 'note.json', '{\n  "model": "qwen",\n  "ctx": 32768\n}\n'],
  ['html', 'note.html', '<!doctype html>\n<h1>Report</h1>\n'],
  ['javascript', 'note.js', 'export function run() {\n\treturn 1;\n}\n'],
  ['powershell', 'note.ps1', 'Get-ChildItem |\n\tSelect-Object Name\n'],
]
for (const [format, filename, content] of verbatim) {
  await test(`writes ${format} to ${filename.split('.')[1]} exactly as supplied`, async () => {
    const result = await callDocumentTool('create_document', { title: 'Note', content, format })
    assert(!result.isError, `isError: ${result.content?.[0]?.text}`)
    assert(exists(filename), `${filename} not written`)
    // Verbatim: no title heading, no reflowing, no block parsing. For json and
    // csv a prepended "# Note" line would be corruption, and in a script it
    // would change the file's meaning.
    eq(readWritten(filename), content, 'file content')
  })
}

await test('writes json that parses back as json', async () => {
  const profile = { name: 'Local', model: 'qwen3.6-35b', contextSize: 32768 }
  await callDocumentTool('create_document', {
    title: 'Profile', content: JSON.stringify(profile, null, 2), format: 'json',
  })
  eq(JSON.parse(readWritten('profile.json')), profile, 'parsed json')
})

await test('strips an enclosing markdown fence the model wrapped the file in', async () => {
  await callDocumentTool('create_document', { title: 'Fenced', content: '```json\n{"a": 1}\n```', format: 'json' })
  // A leading ```json line makes the file invalid json — and unrunnable for
  // the script formats, which is why the fence strip exists.
  eq(readWritten('fenced.json'), '{"a": 1}\n', 'file content')
  eq(JSON.parse(readWritten('fenced.json')), { a: 1 }, 'parsed json')
})

await test('still prepends the title heading for markdown, which is prose', async () => {
  await callDocumentTool('create_document', { title: 'Prose', content: 'Body text', format: 'markdown' })
  eq(readWritten('prose.md'), '# Prose\n\nBody text', 'file content')
})

// ---------------------------------------------------------------------------
console.log('\n-- create_document — format aliases --')

const aliases = [
  ['txt', 'aliased.txt'],
  ['js', 'aliased.js'],
  ['ps1', 'aliased.ps1'],
  ['htm', 'aliased.html'],
  ['pwsh', 'aliased.ps1'],
  ['PDF', 'aliased.pdf'],
  ['Markdown', 'aliased.md'],
]
for (const [format, filename] of aliases) {
  await test(`accepts "${format}" as a format`, async () => {
    const result = await callDocumentTool('create_document', { title: 'Aliased', content: 'x', format })
    assert(!result.isError, `isError: ${result.content?.[0]?.text}`)
    assert(exists(filename), `${filename} not written`)
  })
}

await test('infers the format from a supplied filename', async () => {
  const result = await callDocumentTool('create_document', { filename: 'nest_profile.json', content: '{"a": 1}' })
  assert(!result.isError, `isError: ${result.content?.[0]?.text}`)
  assert(exists('nest-profile.json'), 'nest-profile.json not written')
})

await test('rejects .mjs rather than silently writing it as .js', async () => {
  // Renaming an ES module to .js can change how node parses it, so this
  // errors on purpose — the message names the format to retry with.
  const result = await callDocumentTool('create_document', { title: 'Module', content: 'export default 1', format: 'mjs' })
  eq(result.isError, true, 'isError')
  assert(result.content[0].text.includes('javascript'), `message lacks "javascript": ${result.content[0].text}`)
})

// ---------------------------------------------------------------------------
console.log('\n-- read_document / list_documents — new types --')

await test('reads back a json file it just wrote', async () => {
  await callDocumentTool('create_document', { title: 'Roundtrip', content: '{"ctx": 32768}', format: 'json' })
  const read = await callDocumentTool('read_document', { path: 'roundtrip.json' })
  assert(!read.isError, `isError: ${read.content?.[0]?.text}`)
  assert(read.content[0].text.includes('32768'), 'read text lacks 32768')
})

await test('lists the new file types alongside the old ones', async () => {
  for (const [title, format] of [['Script', 'powershell'], ['Data', 'csv'], ['Page', 'html'], ['Config', 'json']]) {
    await callDocumentTool('create_document', { title, content: 'x', format })
  }
  const listed = (await callDocumentTool('list_documents', {})).content[0].text
  for (const name of ['script.ps1', 'data.csv', 'page.html', 'config.json']) {
    assert(listed.includes(name), `list lacks ${name}`)
  }
})

// ---------------------------------------------------------------------------
// files-api gates previews on its own extension set, and an entry there that
// extractText cannot handle fails the request at runtime.
console.log('\n-- extractText covers every previewable text type --')

// The binary formats go through pdf-parse/mammoth/exceljs and need real
// fixtures; the text ones are the half that silently drifted.
const TEXT_PREVIEWABLE = ['.txt', '.md', '.csv', '.json', '.html', '.log', '.py', '.js', '.ps1']
for (const extension of TEXT_PREVIEWABLE) {
  await test(`extracts ${extension}`, async () => {
    const file = written(`sample${extension}`)
    fs.writeFileSync(file, 'hello contents', 'utf8')
    eq(await tool.extractText(file), 'hello contents', 'extracted text')
  })
}

await test('still rejects a type it cannot parse', async () => {
  const file = written('sample.bin')
  fs.writeFileSync(file, 'x', 'utf8')
  let message = null
  try { await tool.extractText(file) } catch (err) { message = err.message }
  assert(message !== null, 'extractText did not throw')
  assert(message.includes('Unsupported file type'), `wrong error: ${message}`)
})

// ---------------------------------------------------------------------------
console.log('\n-- parseBlocks — table detection --')

const parse = (content) => tool.parseBlocks(content)

await test('parses a pipe table into a table block', () => {
  const blocks = parse('| Date | Item |\n| --- | --- |\n| 2026-01-01 | Tile |\n| 2026-01-02 | Grout |')
  eq(blocks.length, 1, 'block count')
  eq(blocks[0].type, 'table', 'type')
  eq(blocks[0].header, ['Date', 'Item'], 'header')
  eq(blocks[0].rows, [['2026-01-01', 'Tile'], ['2026-01-02', 'Grout']], 'rows')
})

await test('accepts tables without leading and trailing pipes', () => {
  const blocks = parse('Date | Item\n--- | ---\n2026-01-01 | Tile')
  eq(blocks[0].type, 'table', 'type')
  eq(blocks[0].header, ['Date', 'Item'], 'header')
  eq(blocks[0].rows, [['2026-01-01', 'Tile']], 'rows')
})

await test('accepts alignment colons in the separator row', () => {
  const blocks = parse('| Item | Qty |\n| :--- | ---: |\n| Tile | 50 |')
  eq(blocks[0].type, 'table', 'type')
  eq(blocks[0].rows, [['Tile', '50']], 'rows')
})

await test('pads short rows and truncates long ones to the header width', () => {
  const blocks = parse('| A | B | C |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |')
  eq(blocks[0].rows, [['1', '', ''], ['1', '2', '3']], 'rows')
})

await test('treats an escaped pipe as literal cell text', () => {
  const blocks = parse('| Expr | Note |\n|---|---|\n| a \\| b | or |')
  eq(blocks[0].rows, [['a | b', 'or']], 'rows')
})

await test('ends the table at a blank line and keeps following blocks', () => {
  const blocks = parse('| A |\n|---|\n| 1 |\n\nAfter the table.')
  eq(blocks.length, 2, 'block count')
  eq(blocks[0].type, 'table', 'type')
  eq(blocks[1], { type: 'paragraph', text: 'After the table.' }, 'second block')
})

await test('parses a table that ends at the end of the content', () => {
  eq(parse('| A |\n|---|\n| 1 |')[0].rows, [['1']], 'rows')
})

await test('parses headings and bullets around a table', () => {
  const blocks = parse('# Title\n\n| A |\n|---|\n| 1 |\n\n- point one')
  eq(blocks.map(b => b.type), ['heading1', 'table', 'bullet'], 'types')
})

await test('does not treat a bullet list as a table', () => {
  assert(parse('- alpha\n- beta').every(b => b.type === 'bullet'), 'a non-bullet block appeared')
})

await test('does not treat a horizontal rule after prose as a table', () => {
  assert(!parse('Some prose.\n\n---\n\nMore prose.').some(b => b.type === 'table'), 'found a table')
})

await test('does not treat prose containing a pipe as a table', () => {
  eq(parse('Use grep | sort to chain commands.'),
    [{ type: 'paragraph', text: 'Use grep | sort to chain commands.' }], 'blocks')
})

// ---------------------------------------------------------------------------
console.log('\n-- create_document — table rendering --')

function tableMarkdown(rowCount) {
  let md = '| Date | Item | Qty |\n| --- | --- | ---: |\n'
  for (let i = 1; i <= rowCount; i++) md += `| 2026-01-${String(i).padStart(2, '0')} | Item ${i} | ${i} |\n`
  return md
}
const count = (s, re) => (s.match(re) || []).length

await test('writes a real Word table, not pipe-text paragraphs', async () => {
  const result = await callDocumentTool('create_document', { title: 'Purchase Log', content: tableMarkdown(50), format: 'docx' })
  assert(!result.isError, `isError: ${result.content?.[0]?.text}`)
  const { value: html } = await mammoth.convertToHtml({ path: written('purchase-log.docx') })
  eq(count(html, /<table>/g), 1, 'tables')
  eq(count(html, /<tr>/g), 51, 'rows (header + 50)')
  // Exactly one repeating header row; body rows must be data cells, not
  // headers, or Word repeats all 50 on every page.
  const thead = html.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? ''
  eq(count(thead, /<tr>/g), 1, 'header rows')
  eq(count(html, /<td>/g), 150, 'data cells (50 rows x 3 columns)')
  assert(html.includes('Item 50'), 'last row missing')
})

await test('renders a table to PDF without error', async () => {
  const result = await callDocumentTool('create_document', { title: 'Pdf Log', content: tableMarkdown(50), format: 'pdf' })
  assert(!result.isError, `isError: ${result.content?.[0]?.text}`)
  assert(exists('pdf-log.pdf'), 'pdf-log.pdf not written')
})

await test('returns a [FILE: ...] marker so the chat UI renders a download button', async () => {
  const result = await callDocumentTool('create_document', { title: 'Marker Doc', content: 'Body text.', format: 'markdown' })
  assert(!result.isError, `isError: ${result.content?.[0]?.text}`)
  const text = result.content[0].text
  // Must be the first thing on its own line — that is what chat-ui's
  // FILE_PATH_REGEX anchors on.
  eq(text.split('\n')[0], '[FILE: marker-doc.md]', 'first line')
  // The relative marker is all the model gets: the absolute path this result
  // used to end with told it where the server keeps its files.
  assert(!text.includes('Document created:'), 'result still says "Document created:"')
  assert(!text.includes(writtenDir), 'result contains the absolute folder')
})

// A local model that guesses the signature will retry, so the error it sees
// has to name the real arguments or it just repeats the same bad call.
await test('gives usage guidance when the document cannot be named at all', async () => {
  const result = await callDocumentTool('create_document', { content: '| A |\n|---|\n| 1 |', format: 'docx' })
  eq(result.isError, true, 'isError')
  assert(result.content[0].text.includes('title'), 'message lacks "title"')
  assert(result.content[0].text.includes('format'), 'message lacks "format"')
})

await test('still requires content even when a filename is supplied', async () => {
  const result = await callDocumentTool('create_document', { filename: 'empty.docx' })
  eq(result.isError, true, 'isError')
  assert(result.content[0].text.includes('content'), 'message lacks "content"')
})

// The recovered orphan payload arrives with the model's own key names. It is
// otherwise a complete, valid call, so accept it rather than bouncing it.
await test('accepts filename as an alias for title and infers format from it', async () => {
  const result = await callDocumentTool('create_document', {
    filename: 'Tiling_Company_Purchase_Log.docx',
    content: '| Pricing | Items |\n|---|---|\n| 2,450.00 | Ceramic Floor Tiles |',
  })
  assert(!result.isError, `isError: ${result.content?.[0]?.text}`)
  eq(result.content[0].text.split('\n')[0], '[FILE: tiling-company-purchase-log.docx]', 'marker')
  assert(exists('tiling-company-purchase-log.docx'), 'file not written')
})

await test('honors an explicit format over the filename extension', async () => {
  const result = await callDocumentTool('create_document', { filename: 'report.docx', content: 'Body', format: 'markdown' })
  assert(!result.isError, `isError: ${result.content?.[0]?.text}`)
  assert(exists('report.md'), 'report.md not written')
})

await test('ignores any directory in the supplied filename', async () => {
  const result = await callDocumentTool('create_document', { file_path: '../../escape/Secret Notes.pdf', content: 'Body' })
  assert(!result.isError, `isError: ${result.content?.[0]?.text}`)
  // Server-derived name in the configured folder — no traversal honored.
  assert(exists('secret-notes.pdf'), 'secret-notes.pdf not written in the folder')
})

await test('names the valid formats when format is invalid', async () => {
  const result = await callDocumentTool('create_document', { title: 'T', content: 'x', format: 'xlsx' })
  eq(result.isError, true, 'isError')
  assert(result.content[0].text.includes('docx'), 'message lacks "docx"')
})

await test('marker path is relative to the documents folder, not absolute', async () => {
  const result = await callDocumentTool('create_document', { title: 'Rel Path', content: 'x', format: 'markdown' })
  const marker = result.content[0].text.split('\n')[0]
  eq(marker, '[FILE: rel-path.md]', 'marker')
  assert(!marker.includes(outputDir), 'marker contains the absolute root')
})

fs.rmSync(tmpDir, { recursive: true, force: true })
fs.rmSync(tmpDir + '-capabilities', { recursive: true, force: true })

const passed = results.filter(r => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
