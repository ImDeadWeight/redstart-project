'use strict'

// =============================================================================
// Redstart Nest — MCP Provider: Documents (create + read)
// =============================================================================
// One admin-configured folder (cfg.documents.outputDir), two directions:
//   - create_document writes a deliverable (case notes, summaries, reports)
//     as .docx / .pdf / .md; the model supplies a title, never a path — the
//     filename is derived server-side.
//   - read_document / list_documents let the model read source material the
//     user drops into the same folder (.pdf / .docx / .txt / .md), extracted
//     on-device with pure-JS parsers (pdf-parse, mammoth) — no network egress.
// All paths are confined to the configured folder via the shared path-scope
// containment (symlink-aware).
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell, TextRun, WidthType } from 'docx'
import PDFDocument from 'pdfkit'
import { PDFParse } from 'pdf-parse'
import mammoth from 'mammoth'
import ExcelJS from 'exceljs'
import { resolveWithinRoot } from './path-scope.mjs'

const FORMATS = ['markdown', 'docx', 'pdf']
const TOOL_NAMES = ['create_document', 'read_document', 'list_documents']
const READABLE_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md', '.xlsx', '.csv']
const MAX_SHEET_ROWS = 1000               // per sheet; keeps huge workbooks bounded
const MAX_READ_CHARS = 8000               // per call; offset paginates longer documents
const MAX_READ_FILE_BYTES = 50 * 1024 * 1024
const MAX_LIST_ENTRIES = 500

// ---------------------------------------------------------------------------
// Lightweight markdown-style parsing — headings, bullets, paragraphs, tables.
// Not full CommonMark, just enough structure for reports/notes/logs.
// ---------------------------------------------------------------------------

// A markdown table is a header row, then a separator row made only of dashes,
// colons, pipes and spaces, then body rows. Leading/trailing pipes optional.
const TABLE_SEPARATOR_REGEX = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/

function isTableSeparator(line) {
  return line.includes('-') && TABLE_SEPARATOR_REGEX.test(line)
}

// Split one table row into trimmed cells. A pipe escaped as \| is a literal.
function splitTableRow(line) {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  return s
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, '|').trim())
}

// Every row is normalized to the header's column count: ragged rows are a
// common model output, and a jagged table breaks both renderers.
function normalizeRow(cells, columnCount) {
  const row = cells.slice(0, columnCount)
  while (row.length < columnCount) row.push('')
  return row
}

// Exported for unit tests — the block model is where table detection can go
// subtly wrong (bullets, horizontal rules and prose containing "|" must not
// become tables), and that is cheaper to pin down here than through a rendered
// .docx. Production callers should use callTool().
export function parseBlocks(content) {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  let paragraphBuffer = []

  const flushParagraph = () => {
    if (paragraphBuffer.length) {
      blocks.push({ type: 'paragraph', text: paragraphBuffer.join(' ').trim() })
      paragraphBuffer = []
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '') { flushParagraph(); continue }

    // Table: current line has cells and the next line is a separator. Consume
    // the whole table here so its rows never fall through to paragraph text.
    const next = lines[i + 1]?.trim()
    if (line.includes('|') && next && isTableSeparator(next)) {
      flushParagraph()
      const header = splitTableRow(line)
      const columnCount = header.length
      const rows = []
      let j = i + 2
      for (; j < lines.length; j++) {
        const bodyLine = lines[j].trim()
        if (bodyLine === '' || !bodyLine.includes('|')) break
        rows.push(normalizeRow(splitTableRow(bodyLine), columnCount))
      }
      blocks.push({ type: 'table', header, rows })
      i = j - 1
      continue
    }

    if (line.startsWith('## ')) { flushParagraph(); blocks.push({ type: 'heading2', text: line.slice(3).trim() }); continue }
    if (line.startsWith('# ')) { flushParagraph(); blocks.push({ type: 'heading1', text: line.slice(2).trim() }); continue }
    if (line.startsWith('- ') || line.startsWith('* ')) { flushParagraph(); blocks.push({ type: 'bullet', text: line.slice(2).trim() }); continue }
    paragraphBuffer.push(line)
  }
  flushParagraph()
  return blocks
}

// ---------------------------------------------------------------------------
// Format writers
// ---------------------------------------------------------------------------

// A real Word table (not pipe-text paragraphs): header row bold and marked as a
// header so Word repeats it across page breaks.
function buildDocxTable(block) {
  const columnCount = block.header.length
  const makeRow = (cells, isHeader) =>
    new TableRow({
      // Only set on the header row: docx emits the <w:tblHeader/> flag whenever
      // the property is present, so passing `false` would mark every body row
      // as a repeating header too.
      ...(isHeader ? { tableHeader: true } : {}),
      children: Array.from({ length: columnCount }, (_, i) =>
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: String(cells[i] ?? ''), bold: isHeader })] })],
        })
      ),
    })

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [makeRow(block.header, true), ...block.rows.map((row) => makeRow(row, false))],
  })
}

function buildDocx(title, blocks) {
  const children = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })]
  for (const block of blocks) {
    if (block.type === 'heading1') children.push(new Paragraph({ text: block.text, heading: HeadingLevel.HEADING_1 }))
    else if (block.type === 'heading2') children.push(new Paragraph({ text: block.text, heading: HeadingLevel.HEADING_2 }))
    else if (block.type === 'bullet') children.push(new Paragraph({ text: block.text, bullet: { level: 0 } }))
    else if (block.type === 'table') {
      children.push(buildDocxTable(block))
      // Word merges consecutive tables that aren't separated by a paragraph.
      children.push(new Paragraph({ text: '' }))
    }
    else children.push(new Paragraph({ text: block.text }))
  }
  return new Document({ sections: [{ children }] })
}

// pdfkit 0.15 has no table primitive, so the grid is drawn by hand: column
// widths weighted by content length, per-row height from the tallest wrapped
// cell, an explicit page break before any row that would overflow, and the
// header repeated at the top of each new page.
const PDF_TABLE_FONT_SIZE = 9
const PDF_TABLE_PADDING = 4
const PDF_BODY_FONT_SIZE = 11

function drawPdfTable(doc, block) {
  const columnCount = block.header.length
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right

  // Weight each column by its longest cell, clamped so one verbose column
  // can't starve the rest.
  const weights = []
  for (let i = 0; i < columnCount; i++) {
    let longest = String(block.header[i] ?? '').length
    for (const row of block.rows) longest = Math.max(longest, String(row[i] ?? '').length)
    weights.push(Math.min(Math.max(longest, 4), 40))
  }
  const totalWeight = weights.reduce((sum, w) => sum + w, 0)
  const widths = weights.map((w) => (w / totalWeight) * usableWidth)

  doc.fontSize(PDF_TABLE_FONT_SIZE)

  const measureRow = (cells, isHeader) => {
    doc.font(isHeader ? 'Helvetica-Bold' : 'Helvetica')
    let tallest = 0
    for (let i = 0; i < columnCount; i++) {
      const height = doc.heightOfString(String(cells[i] ?? ''), { width: widths[i] - PDF_TABLE_PADDING * 2 })
      tallest = Math.max(tallest, height)
    }
    return tallest + PDF_TABLE_PADDING * 2
  }

  const renderRow = (cells, isHeader, height) => {
    const top = doc.y
    let x = doc.page.margins.left
    doc.font(isHeader ? 'Helvetica-Bold' : 'Helvetica')
    for (let i = 0; i < columnCount; i++) {
      doc.rect(x, top, widths[i], height).stroke()
      doc.text(String(cells[i] ?? ''), x + PDF_TABLE_PADDING, top + PDF_TABLE_PADDING, {
        width: widths[i] - PDF_TABLE_PADDING * 2,
      })
      x += widths[i]
    }
    // Each doc.text moved the cursor; put it back on the row boundary.
    doc.y = top + height
  }

  const bottomLimit = () => doc.page.height - doc.page.margins.bottom

  const headerHeight = measureRow(block.header, true)
  if (doc.y + headerHeight > bottomLimit()) doc.addPage()
  renderRow(block.header, true, headerHeight)

  for (const row of block.rows) {
    const height = measureRow(row, false)
    if (doc.y + height > bottomLimit()) {
      doc.addPage()
      renderRow(block.header, true, measureRow(block.header, true))
    }
    renderRow(row, false, height)
  }

  doc.font('Helvetica').fontSize(PDF_BODY_FONT_SIZE)
  doc.moveDown(0.5)
}

function writePdf(outputPath, title, blocks) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 })
    const stream = fs.createWriteStream(outputPath)
    doc.pipe(stream)

    doc.fontSize(20).text(title)
    doc.moveDown()
    for (const block of blocks) {
      if (block.type === 'heading1') { doc.fontSize(16).text(block.text); doc.moveDown(0.5) }
      else if (block.type === 'heading2') { doc.fontSize(14).text(block.text); doc.moveDown(0.5) }
      else if (block.type === 'bullet') { doc.fontSize(11).text(`•  ${block.text}`, { indent: 20 }); doc.moveDown(0.2) }
      else if (block.type === 'table') { drawPdfTable(doc, block) }
      else { doc.fontSize(11).text(block.text); doc.moveDown(0.5) }
    }
    doc.end()

    stream.on('finish', resolve)
    stream.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// Output path — server-derived filename, checked against traversal
// ---------------------------------------------------------------------------

function slugify(title) {
  const base = (title || 'document').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return base || 'document'
}

function resolveOutputPath(outputDir, title, extension) {
  const slug = slugify(title)
  let filename = `${slug}.${extension}`
  let n = 2
  while (fs.existsSync(path.join(outputDir, filename))) {
    filename = `${slug}-${n}.${extension}`
    n++
  }
  // Shared containment check (path-scope.mjs) — also symlink-aware, unlike the
  // lexical resolve+startsWith this replaced. Belt-and-suspenders here since
  // slugify() already strips separators, but the shared util is the audit point.
  return resolveWithinRoot(outputDir, filename)
}

// ---------------------------------------------------------------------------
// Reading — on-device text extraction
// ---------------------------------------------------------------------------

// Renders one worksheet as a pipe-separated text table the model can read.
// ExcelJS row.values is 1-based (index 0 is always empty); formula cells carry
// {formula, result} objects — the model wants the computed result.
function sheetToText(worksheet) {
  const lines = []
  let rows = 0
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    if (++rows > MAX_SHEET_ROWS) return
    const cells = row.values.slice(1).map((v) => {
      if (v === null || v === undefined) return ''
      if (typeof v === 'object') {
        if (v.result !== undefined) return String(v.result)      // formula cell
        if (v.text !== undefined) return String(v.text)          // rich text / hyperlink
        if (v instanceof Date) return v.toISOString().slice(0, 10)
        return JSON.stringify(v)
      }
      return String(v)
    })
    lines.push(cells.join(' | '))
  })
  if (rows > MAX_SHEET_ROWS) lines.push(`[Showing first ${MAX_SHEET_ROWS} of ${rows} rows]`)
  return lines.join('\n')
}

async function extractText(filePath) {
  const extension = path.extname(filePath).toLowerCase()

  if (extension === '.txt' || extension === '.md' || extension === '.csv') {
    return fs.readFileSync(filePath, 'utf8')
  }
  if (extension === '.xlsx') {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(filePath)
    const parts = []
    workbook.eachSheet((worksheet) => {
      parts.push(`=== Sheet: ${worksheet.name} ===\n${sheetToText(worksheet)}`)
    })
    return parts.join('\n\n') || '[Workbook contains no sheets]'
  }
  if (extension === '.docx') {
    const result = await mammoth.extractRawText({ buffer: fs.readFileSync(filePath) })
    return result.value
  }
  if (extension === '.pdf') {
    const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(filePath)) })
    try {
      const result = await parser.getText()
      return result.text
    } finally {
      await parser.destroy?.()
    }
  }
  throw new Error(`Unsupported file type "${extension}" — readable types: ${READABLE_EXTENSIONS.join(', ')}`)
}

async function readDocument(docCfg, args) {
  const { path: docPath, offset } = args || {}
  if (!docPath || typeof docPath !== 'string') {
    return { isError: true, content: [{ type: 'text', text: 'Missing required argument: path' }] }
  }

  let filePath
  try {
    filePath = resolveWithinRoot(docCfg.outputDir, docPath)
  } catch {
    return { isError: true, content: [{ type: 'text', text: 'Path is outside the configured documents folder' }] }
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return { isError: true, content: [{ type: 'text', text: `File not found: ${docPath}. Use list_documents to see available files.` }] }
  }
  if (fs.statSync(filePath).size > MAX_READ_FILE_BYTES) {
    return { isError: true, content: [{ type: 'text', text: `File is larger than the ${(MAX_READ_FILE_BYTES / 1048576).toFixed(0)} MB read limit` }] }
  }

  const text = (await extractText(filePath)).replace(/\r\n/g, '\n')
  const start = Math.max(0, Number.isFinite(+offset) ? Math.trunc(+offset) : 0)
  const slice = text.slice(start, start + MAX_READ_CHARS)

  let out = slice
  if (start > 0) out = `[...continuing from character ${start}]\n` + out
  if (start + MAX_READ_CHARS < text.length) {
    out += `\n\n[Truncated — showing characters ${start}–${start + slice.length} of ${text.length}. Call read_document again with offset=${start + slice.length} for more.]`
  }
  if (!out.trim()) out = '[Document contains no extractable text]'
  return { content: [{ type: 'text', text: out }] }
}

function listDocuments(docCfg) {
  const root = path.resolve(docCfg.outputDir)
  const entries = []
  // Recursive walk of the configured folder only — readdirSync never follows
  // the tree outward, and reads of individual files re-check containment.
  const files = fs.readdirSync(root, { recursive: true, withFileTypes: false })
  for (const rel of files) {
    if (entries.length >= MAX_LIST_ENTRIES) break
    const full = path.join(root, String(rel))
    let stat
    try { stat = fs.statSync(full) } catch { continue }
    if (!stat.isFile()) continue
    if (!READABLE_EXTENSIONS.includes(path.extname(full).toLowerCase())) continue
    entries.push(`${String(rel).replace(/\\/g, '/')}  (${(stat.size / 1024).toFixed(1)} KB)`)
  }
  if (entries.length === 0) {
    return { content: [{ type: 'text', text: `No readable documents found (looking for ${READABLE_EXTENSIONS.join(', ')}).` }] }
  }
  let text = entries.join('\n')
  if (entries.length >= MAX_LIST_ENTRIES) text += `\n\n[Showing first ${MAX_LIST_ENTRIES} files]`
  return { content: [{ type: 'text', text }] }
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export function toolDefs(cfg) {
  if (!cfg?.documents?.enabled) return []
  return [
    {
      name: 'create_document',
      description: 'Create a new document and save it to the local documents folder. Use simple markdown-style formatting in content: "# Heading", "## Subheading", "- bullet", blank lines between paragraphs.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Document title — also used to name the file' },
          content: { type: 'string', description: 'Document body, using simple markdown-style formatting' },
          format: { type: 'string', enum: FORMATS, description: 'Output file format' },
        },
        required: ['title', 'content', 'format'],
      },
    },
    {
      name: 'read_document',
      description: 'Read the text content of a document (.pdf, .docx, .txt, .md, .xlsx, .csv) in the local documents folder. Spreadsheets are rendered as one text table per sheet. Long documents are returned in chunks — follow the offset instructions at the end of a truncated result to read more.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the documents folder (e.g. "brief.pdf" or "cases/intake-notes.docx")' },
          offset: { type: 'number', description: 'Character position to continue reading from (from a previous truncated read)' },
        },
        required: ['path'],
      },
    },
    {
      name: 'list_documents',
      description: 'List the readable documents (.pdf, .docx, .txt, .md, .xlsx, .csv) in the local documents folder, with sizes.',
      inputSchema: { type: 'object', properties: {} },
    },
  ]
}

export async function callTool(name, args, cfg) {
  if (!TOOL_NAMES.includes(name)) return null

  const docCfg = cfg?.documents
  if (!docCfg?.enabled || !docCfg?.outputDir) {
    return { isError: true, content: [{ type: 'text', text: 'Documents capability is not configured or enabled.' }] }
  }

  if (name === 'read_document') {
    try {
      return await readDocument(docCfg, args)
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `Failed to read document: ${err.message}` }] }
    }
  }
  if (name === 'list_documents') {
    try {
      return listDocuments(docCfg)
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `Failed to list documents: ${err.message}` }] }
    }
  }

  const { title, content, format } = args || {}
  if (!title || typeof title !== 'string') {
    return { isError: true, content: [{ type: 'text', text: 'Missing required argument: title' }] }
  }
  if (!content || typeof content !== 'string') {
    return { isError: true, content: [{ type: 'text', text: 'Missing required argument: content' }] }
  }
  if (!FORMATS.includes(format)) {
    return { isError: true, content: [{ type: 'text', text: `format must be one of: ${FORMATS.join(', ')}` }] }
  }

  try {
    fs.mkdirSync(docCfg.outputDir, { recursive: true })
    const extension = format === 'markdown' ? 'md' : format
    const outputPath = resolveOutputPath(docCfg.outputDir, title, extension)

    if (format === 'markdown') {
      fs.writeFileSync(outputPath, `# ${title}\n\n${content}`, 'utf8')
    } else if (format === 'docx') {
      const buffer = await Packer.toBuffer(buildDocx(title, parseBlocks(content)))
      fs.writeFileSync(outputPath, buffer)
    } else {
      await writePdf(outputPath, title, parseBlocks(content))
    }

    // The [FILE: ...] marker is what the chat UI turns into a download button
    // (FILE_PATH_REGEX in chat-ui constants/agentic.ts). It must be the start of
    // its own line and carry the path RELATIVE to a served root — /files/download
    // resolves it against the documents folder. Without this line a created
    // document is unreachable from a browser client.
    const relativePath = path.relative(docCfg.outputDir, outputPath).split(path.sep).join('/')
    return { content: [{ type: 'text', text: `[FILE: ${relativePath}]\nDocument created: ${outputPath}` }] }
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Failed to create document: ${err.message}` }] }
  }
}
