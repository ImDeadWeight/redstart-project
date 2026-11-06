'use strict'

// =============================================================================
// Redstart Nest — MCP Provider: search_documents (chat-tooling Phase 5a)
// =============================================================================
// "Here are three PDFs, what do they say about X." One tool, capability
// `document_search`, class read: search the caller's OWN documents (their
// Documents folder, which includes every conversation workspace and whatever
// they uploaded) and return the best passages, each with where it came from.
//
// A TOOL, NOT AUTOMATIC INJECTION (rag-plan §3): the model asks when it needs
// to, and retrieval never silently eats the context window.
//
// CITATIONS ARE THE PRODUCT CLAIM (rag-plan §3): every passage is numbered and
// names its file, the result says to cite by that number and name, and each
// source also comes back as a Phase 2 resource link, so the user can open
// exactly what was read. 5a reads only the caller's own files, and the result
// says so; "documents it was allowed to read" in the shared sense arrives with
// 5b and grants.
//
// Indexing is mtime-on-access (document-index.mjs syncScope): each call first
// catches the index up with the folder within a time budget, and says when
// files are still pending.
// =============================================================================

import * as path from 'path'
import { syncScope, searchScope, clearScope } from './document-index.mjs'
import { extractText } from './documents-tool.mjs'
import { resolveUserRoot, resolveUserScope } from './user-scope.mjs'
import { embedTexts, embedServerStatus } from './embed-server.mjs'
import { fileLink } from './tool-result-links.mjs'
import { configDir } from './platform-paths.mjs'
import { logEvent } from './logger.mjs'

export const TOOL_NAME = 'search_documents'
const SNIPPET_CHARS = 900
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 10
const SYNC_BUDGET_MS = 20000

// The embedder is used only while the sidecar runs; null otherwise, and the
// index falls back to words. Overridable for the suite.
let embedder = () => (embedServerStatus().state === 'running' ? embedTexts : null)
let indexDir = () => configDir()
export function _setTestSeams({ embed, dir } = {}) {
  if (embed !== undefined) embedder = () => embed
  if (dir !== undefined) indexDir = () => dir
}

/** The index scope for an account: the same slug its files live under. */
export function scopeFor(account) {
  return resolveUserScope(account)
}

export function toolDefs(cfg) {
  if (!cfg?.documentSearch?.enabled) return []
  return [{
    name: TOOL_NAME,
    description:
      'Search the text of the user\'s own documents on this server: files they uploaded or attached to chats, documents you created, and files in their conversation workspaces (pdf, docx, xlsx, txt, md, csv, json, html). ' +
      'Returns the most relevant passages, numbered, each naming its file. Use it when the user asks what their documents say, or refers to a file they gave you. ' +
      'Cite every claim from a passage with its number and file name, e.g. [2] contract.pdf, and say plainly when nothing relevant was found rather than answering from memory. ' +
      'It does not search the web, shared folders or databases. To read a whole file, use read_document with the path shown. ' +
      'Example: {"query": "termination notice period"}',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, in words likely to appear in the documents.' },
        limit: { type: 'number', description: `How many passages (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
      },
      required: ['query'],
    },
  }]
}

/** Pure: word the hits for the model. Exported for the suite. */
export function formatHits(hits, { status, query }) {
  const lines = []
  if (!hits.length) {
    lines.push(`No passage in your documents matches "${query}".`)
  } else {
    hits.forEach((h, i) => {
      const snippet = h.chunk.text.length > SNIPPET_CHARS ? h.chunk.text.slice(0, SNIPPET_CHARS) + ' …' : h.chunk.text
      lines.push(`[${i + 1}] ${h.chunk.path} (part ${h.chunk.ord + 1})\n${snippet}`)
    })
    lines.push('Cite each claim with its passage number and file name, e.g. [1] ' + path.posix.basename(hits[0].chunk.path) + '. These come only from this user\'s own documents.')
  }
  const notes = []
  notes.push(`Searched ${status.files} file${status.files === 1 ? '' : 's'}.`)
  if (status.pending > 0) notes.push(`${status.pending} more are still being indexed, so results may be incomplete; searching again shortly will include them.`)
  if (status.semantic === false) notes.push('Matching is by words only right now (the embedding model is not running), so try the exact terms the documents would use.')
  if (status.errors?.length) notes.push(`Could not read: ${status.errors.slice(0, 3).join('; ')}.`)
  lines.push(notes.join(' '))
  return lines.join('\n\n')
}

export async function callTool(name, args, cfg, ctx) {
  if (name !== TOOL_NAME) return null
  const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] })
  const dsCfg = cfg?.documentSearch
  if (!dsCfg?.enabled || !dsCfg.documentsRoot) return fail('Document search is not enabled, or no Documents folder is configured.')
  const query = typeof args?.query === 'string' ? args.query.trim() : ''
  if (!query) return fail('Missing required argument: query (the words to look for).')
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(+args?.limit) ? Math.trunc(+args.limit) : DEFAULT_LIMIT))

  let root, scope
  try {
    root = resolveUserRoot(dsCfg.documentsRoot, ctx?.account ?? null, { create: true })
    scope = scopeFor(ctx?.account ?? null)
  } catch (err) {
    return fail(`Could not open your documents: ${err.message}`)
  }

  const embed = embedder()
  const started = Date.now()
  const sync = await syncScope({ dir: indexDir(), scope, root, extract: extractText, embed: embed ?? undefined, budgetMs: SYNC_BUDGET_MS })
  let queryVector = null
  if (embed) {
    const v = await embed([query])
    if (Array.isArray(v) && v[0]) queryVector = v[0]
  }
  const hits = await searchScope({ dir: indexDir(), scope, query, queryVector, limit })
  const text = formatHits(hits, { query, status: { ...sync, semantic: !!queryVector } })

  logEvent('documents', 'searched', { durationMs: Date.now() - started, files: sync.files, indexed: sync.indexed, pending: sync.pending, hits: hits.length, semantic: !!queryVector })

  // One link per distinct source, so the user can open what was read (Phase 2).
  const seen = new Set()
  const links = []
  for (const h of hits) {
    if (seen.has(h.chunk.path)) continue
    seen.add(h.chunk.path)
    links.push(fileLink(h.chunk.path))
  }
  return { content: [{ type: 'text', text }, ...links] }
}

/** The manual rebuild (rag-plan §4): forget the caller's index; the next search rebuilds it. */
export async function rebuildIndexFor(account) {
  await clearScope({ dir: indexDir(), scope: scopeFor(account) })
}
