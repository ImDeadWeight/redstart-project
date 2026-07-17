'use strict'

// =============================================================================
// Redstart Nest — MCP Provider: Vault (markdown knowledge base)
// =============================================================================
// Read-only access to a folder of markdown notes — an Obsidian vault, a
// Logseq graph, or any plain folder of .md files. This addresses the #1 gap
// in local LLM use: the model can cross-reference the user's own notes
// (case details, research, meeting notes) without any of it leaving the
// machine. Generic by design: nothing Obsidian-specific beyond understanding
// #tags and YAML frontmatter `tags:`, so any markdown folder works.
//
// Read-only is structural: this module contains no write calls at all.
// Containment via the shared path-scope util, same as every file capability.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import { resolveWithinRoot } from './path-scope.mjs'

const TOOL_NAMES = ['vault_search', 'vault_get', 'vault_tags']
const MAX_OUTPUT_CHARS = 8000
const MAX_NOTE_READ_CHARS = 8000     // per vault_get call; offset paginates
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_FILES_SCANNED = 5000
const MAX_SEARCH_RESULTS = 12
const SNIPPET_CHARS = 160
// Folders that are tool/plumbing state, not notes.
const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'logseq/.recycle', 'node_modules'])

// ---------------------------------------------------------------------------
// Vault walking
// ---------------------------------------------------------------------------

function* walkMarkdownFiles(root) {
  let scanned = 0
  const stack = ['']
  while (stack.length) {
    const relDir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true })
    } catch { continue }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !SKIP_DIRS.has(rel)) stack.push(rel)
        continue
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
      if (++scanned > MAX_FILES_SCANNED) return
      yield rel
    }
  }
}

function readNote(root, rel) {
  const full = path.join(root, rel)
  try {
    if (fs.statSync(full).size > MAX_FILE_BYTES) return null
    return fs.readFileSync(full, 'utf8')
  } catch { return null }
}

// ---------------------------------------------------------------------------
// Tag extraction — inline #tags plus YAML frontmatter `tags:` (both the
// `tags: [a, b]` and the dash-list form).
// ---------------------------------------------------------------------------

function extractTags(content) {
  const tags = new Set()
  for (const m of content.matchAll(/(^|\s)#([\p{L}\p{N}_\/-]+)/gmu)) {
    if (!/^\d+$/.test(m[2])) tags.add(m[2].toLowerCase())
  }
  const fm = content.match(/^---\n([\s\S]*?)\n---/)
  if (fm) {
    const tagLine = fm[1].match(/^tags:\s*(.*)$/m)
    if (tagLine) {
      const inline = tagLine[1].replace(/[[\]"']/g, '').split(',').map(t => t.trim()).filter(Boolean)
      inline.forEach(t => tags.add(t.toLowerCase()))
      if (!tagLine[1].trim()) {
        // dash-list form on following lines
        const rest = fm[1].slice(fm[1].indexOf(tagLine[0]) + tagLine[0].length)
        for (const dm of rest.matchAll(/^\s*-\s*([^\s#][^\n]*)$/gm)) {
          tags.add(dm[1].trim().replace(/[["']/g, '').toLowerCase())
          if (!/^\s*-/.test(dm.input.slice(dm.index + dm[0].length).split('\n', 2)[1] ?? '')) break
        }
      }
    }
  }
  return tags
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function searchVault(rootDir, query) {
  if (!query || typeof query !== 'string') {
    return { isError: true, content: [{ type: 'text', text: 'Missing required argument: query' }] }
  }
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) {
    return { isError: true, content: [{ type: 'text', text: 'Query is empty' }] }
  }

  const hits = []
  for (const rel of walkMarkdownFiles(rootDir)) {
    const content = readNote(rootDir, rel)
    if (content === null) continue
    const haystack = content.toLowerCase()
    const nameHay = rel.toLowerCase()
    // Score: every term must appear somewhere (filename counts); rank by
    // total occurrences with a filename-match bonus.
    let score = 0
    let allFound = true
    let firstIdx = -1
    for (const term of terms) {
      let count = 0
      for (let i = haystack.indexOf(term); i !== -1; i = haystack.indexOf(term, i + term.length)) {
        count++
        if (firstIdx === -1) firstIdx = i
        if (count > 50) break
      }
      if (nameHay.includes(term)) { count += 5; if (firstIdx === -1) firstIdx = 0 }
      if (count === 0) { allFound = false; break }
      score += count
    }
    if (!allFound) continue
    const from = Math.max(0, firstIdx - 30)
    const snippet = content.slice(from, from + SNIPPET_CHARS).replace(/\s+/g, ' ').trim()
    hits.push({ rel, score, snippet })
  }

  if (hits.length === 0) {
    return { content: [{ type: 'text', text: `No notes matching "${query}".` }] }
  }
  hits.sort((a, b) => b.score - a.score)
  const shown = hits.slice(0, MAX_SEARCH_RESULTS)
  let text = shown.map(h => `${h.rel}\n  …${h.snippet}…`).join('\n\n')
  if (hits.length > shown.length) text += `\n\n[Showing top ${shown.length} of ${hits.length} matching notes]`
  text += '\n\nUse vault_get with a path above to read a full note.'
  if (text.length > MAX_OUTPUT_CHARS) text = text.slice(0, MAX_OUTPUT_CHARS) + '\n[Output truncated]'
  return { content: [{ type: 'text', text }] }
}

function getNote(rootDir, notePath, offset) {
  if (!notePath || typeof notePath !== 'string') {
    return { isError: true, content: [{ type: 'text', text: 'Missing required argument: path' }] }
  }
  let filePath
  try {
    filePath = resolveWithinRoot(rootDir, notePath)
  } catch {
    return { isError: true, content: [{ type: 'text', text: 'Path is outside the configured vault folder' }] }
  }
  if (!filePath.toLowerCase().endsWith('.md')) {
    return { isError: true, content: [{ type: 'text', text: 'Only .md notes can be read with vault_get' }] }
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return { isError: true, content: [{ type: 'text', text: `Note not found: ${notePath}. Use vault_search to find notes.` }] }
  }
  if (fs.statSync(filePath).size > MAX_FILE_BYTES) {
    return { isError: true, content: [{ type: 'text', text: `Note is larger than the ${(MAX_FILE_BYTES / 1048576).toFixed(0)} MB limit` }] }
  }

  const text = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n')
  const start = Math.max(0, Number.isFinite(+offset) ? Math.trunc(+offset) : 0)
  let out = text.slice(start, start + MAX_NOTE_READ_CHARS)
  if (start > 0) out = `[...continuing from character ${start}]\n` + out
  if (start + MAX_NOTE_READ_CHARS < text.length) {
    out += `\n\n[Truncated — showing characters ${start}–${start + MAX_NOTE_READ_CHARS} of ${text.length}. Call vault_get again with offset=${start + MAX_NOTE_READ_CHARS} for more.]`
  }
  return { content: [{ type: 'text', text: out || '[Empty note]' }] }
}

function listTags(rootDir, tag) {
  const wanted = typeof tag === 'string' && tag.trim() ? tag.trim().replace(/^#/, '').toLowerCase() : null
  const tagCounts = new Map()
  const notesWithTag = []

  for (const rel of walkMarkdownFiles(rootDir)) {
    const content = readNote(rootDir, rel)
    if (content === null) continue
    const tags = extractTags(content)
    if (wanted) {
      if (tags.has(wanted)) notesWithTag.push(rel)
    } else {
      for (const t of tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1)
    }
  }

  if (wanted) {
    if (notesWithTag.length === 0) return { content: [{ type: 'text', text: `No notes tagged #${wanted}.` }] }
    let text = notesWithTag.slice(0, 100).join('\n')
    if (notesWithTag.length > 100) text += `\n[Showing first 100 of ${notesWithTag.length} notes]`
    return { content: [{ type: 'text', text }] }
  }

  if (tagCounts.size === 0) return { content: [{ type: 'text', text: 'No tags found in the vault.' }] }
  const sorted = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 200)
  const text = sorted.map(([t, n]) => `#${t} (${n})`).join('\n')
  return { content: [{ type: 'text', text }] }
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export function toolDefs(cfg) {
  if (!cfg?.vault?.enabled) return []
  return [
    {
      name: 'vault_search',
      description: 'Full-text search across the user\'s local markdown notes (Obsidian vault or any markdown folder). Returns matching notes with snippets. All terms must match; filenames count as matches.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search terms' } },
        required: ['query'],
      },
    },
    {
      name: 'vault_get',
      description: 'Read the full content of a markdown note in the vault. Long notes are returned in chunks — follow the offset instructions at the end of a truncated result.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Note path relative to the vault folder (from vault_search results)' },
          offset: { type: 'number', description: 'Character position to continue reading from' },
        },
        required: ['path'],
      },
    },
    {
      name: 'vault_tags',
      description: 'Without arguments: list all tags in the vault with note counts. With a tag argument: list the notes carrying that tag. Understands inline #tags and YAML frontmatter tags.',
      inputSchema: {
        type: 'object',
        properties: { tag: { type: 'string', description: 'Optional tag to look up (with or without the leading #)' } },
      },
    },
  ]
}

export async function callTool(name, args, cfg) {
  if (!TOOL_NAMES.includes(name)) return null

  const vaultCfg = cfg?.vault
  if (!vaultCfg?.enabled || !vaultCfg?.rootDir) {
    return { isError: true, content: [{ type: 'text', text: 'Vault is not configured or enabled.' }] }
  }
  if (!fs.existsSync(vaultCfg.rootDir)) {
    return { isError: true, content: [{ type: 'text', text: 'The configured vault folder does not exist.' }] }
  }

  try {
    if (name === 'vault_search') return searchVault(vaultCfg.rootDir, args?.query)
    if (name === 'vault_get') return getNote(vaultCfg.rootDir, args?.path, args?.offset)
    if (name === 'vault_tags') return listTags(vaultCfg.rootDir, args?.tag)
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Vault error: ${err.message}` }] }
  }
}
