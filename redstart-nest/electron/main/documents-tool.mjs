'use strict'

// =============================================================================
// Redstart Nest — MCP Provider: Document generation
// =============================================================================
// Lets the model write a real deliverable (case notes, summaries, reports) to
// disk as .docx / .pdf / .md — pure local file I/O, no network egress. Output
// is confined to one admin-configured directory (cfg.documents.outputDir); the
// model only ever supplies a title, never a path — the filename is derived
// server-side and checked to stay inside that directory.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import { Document, Packer, Paragraph, HeadingLevel } from 'docx'
import PDFDocument from 'pdfkit'

const FORMATS = ['markdown', 'docx', 'pdf']

// ---------------------------------------------------------------------------
// Lightweight markdown-style parsing — headings, bullets, paragraphs.
// Not full CommonMark, just enough structure for reports/notes.
// ---------------------------------------------------------------------------

function parseBlocks(content) {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  let paragraphBuffer = []

  const flushParagraph = () => {
    if (paragraphBuffer.length) {
      blocks.push({ type: 'paragraph', text: paragraphBuffer.join(' ').trim() })
      paragraphBuffer = []
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line === '') { flushParagraph(); continue }
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

function buildDocx(title, blocks) {
  const children = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })]
  for (const block of blocks) {
    if (block.type === 'heading1') children.push(new Paragraph({ text: block.text, heading: HeadingLevel.HEADING_1 }))
    else if (block.type === 'heading2') children.push(new Paragraph({ text: block.text, heading: HeadingLevel.HEADING_2 }))
    else if (block.type === 'bullet') children.push(new Paragraph({ text: block.text, bullet: { level: 0 } }))
    else children.push(new Paragraph({ text: block.text }))
  }
  return new Document({ sections: [{ children }] })
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
  let candidate = path.join(outputDir, `${slug}.${extension}`)
  let n = 2
  while (fs.existsSync(candidate)) {
    candidate = path.join(outputDir, `${slug}-${n}.${extension}`)
    n++
  }

  const resolvedDir = path.resolve(outputDir)
  const resolvedCandidate = path.resolve(candidate)
  if (resolvedCandidate !== resolvedDir && !resolvedCandidate.startsWith(resolvedDir + path.sep)) {
    throw new Error('Resolved output path escapes the configured output directory')
  }
  return resolvedCandidate
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export function toolDefs(cfg) {
  if (!cfg?.documents?.enabled) return []
  return [{
    name: 'create_document',
    description: 'Create a new document and save it to the local output folder. Use simple markdown-style formatting in content: "# Heading", "## Subheading", "- bullet", blank lines between paragraphs.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Document title — also used to name the file' },
        content: { type: 'string', description: 'Document body, using simple markdown-style formatting' },
        format: { type: 'string', enum: FORMATS, description: 'Output file format' },
      },
      required: ['title', 'content', 'format'],
    },
  }]
}

export async function callTool(name, args, cfg) {
  if (name !== 'create_document') return null

  const docCfg = cfg?.documents
  if (!docCfg?.enabled || !docCfg?.outputDir) {
    return { isError: true, content: [{ type: 'text', text: 'Document generation is not configured or enabled.' }] }
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

    return { content: [{ type: 'text', text: `Document created: ${outputPath}` }] }
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Failed to create document: ${err.message}` }] }
  }
}
