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

import * as fs from 'fs'
import * as path from 'path'
import { syncScope, searchScope, searchSources, clearScope } from './document-index.mjs'
import { extractText } from './documents-tool.mjs'
import { resolveUserRoot, resolveUserScope } from './user-scope.mjs'
import { embedTexts, embedServerStatus } from './embed-server.mjs'
import { fileLink } from './tool-result-links.mjs'
import { configDir } from './platform-paths.mjs'
import { logEvent } from './logger.mjs'
import { projectForCall, ensureProjectFiles } from './projects-storage.mjs'

export const TOOL_NAME = 'search_documents'
const SNIPPET_CHARS = 900
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 10
const SYNC_BUDGET_MS = 20000

// Shared Documents (master plan 6.2): one index scope for the shared folder,
// whoever searches it; each search keeps only the chunks under the caller's
// granted folders. A revoked grant stops matching with no re-index.
export const SHARED_SCOPE = '_shared'
export const SHARED_GRANT = 'shared'
/** How a shared passage is cited, so it is never taken for the user's own file. */
export const SHARED_LABEL = 'Shared: '

// A project's files (2026-11-24): one index scope per project, shared by its
// members, as its folder is (projects-storage projectFilesDir).
export const PROJECT_GRANT = 'project'
export const PROJECT_LABEL = 'Project: '
export const projectScope = (project) => `_project-${project.id}`

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
      'When the organization has a shared documents folder it searches the parts of it this user may read too, and marks those passages "Shared:". ' +
      'It does not search the web or databases. To read a whole file of the user\'s own, use read_document with the path shown. ' +
      'Example: {"query": "termination notice period"}',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, in words likely to appear in the documents.' },
        limit: { type: 'number', description: `How many passages (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
        scope: { type: 'string', enum: ['project', 'all'], description: 'In a project chat, "project" (default) searches that project\'s files first; "all" searches every document.' },
      },
      required: ['query'],
    },
  }]
}

const isShared = (h) => h.chunk.grantId === SHARED_GRANT
const isProjectHit = (h) => h.chunk.grantId === PROJECT_GRANT
const labelOf = (h) => (isShared(h) ? SHARED_LABEL : isProjectHit(h) ? PROJECT_LABEL : '')

/**
 * The shared folder's part of a search, or null when there is none for this
 * caller: no folder set, it does not exist, or the role grants none of it.
 * `pathPrefixes` is null for the whole folder, otherwise the granted folders
 * each with a trailing slash.
 */
function sharedSource(dsCfg) {
  const root = dsCfg?.sharedRootDir
  if (!root || !fs.existsSync(root)) return null
  const grants = dsCfg.sharedGrants
  if (Array.isArray(grants) && grants.length === 0) return null
  return { root, pathPrefixes: Array.isArray(grants) ? grants.map((g) => `${g}/`) : null }
}

/** Pure: word the hits for the model. Exported for the suite. */
export function formatHits(hits, { status, query }) {
  const lines = []
  if (!hits.length) {
    lines.push(`No passage in your documents matches "${query}".`)
  } else {
    hits.forEach((h, i) => {
      const snippet = h.chunk.text.length > SNIPPET_CHARS ? h.chunk.text.slice(0, SNIPPET_CHARS) + ' …' : h.chunk.text
      lines.push(`[${i + 1}] ${labelOf(h)}${h.chunk.path} (part ${h.chunk.ord + 1})\n${snippet}`)
    })
    const anyShared = hits.some(isShared)
    lines.push('Cite each claim with its passage number and file name, e.g. [1] ' + path.posix.basename(hits[0].chunk.path) + '. ' +
      (anyShared
        ? 'Passages marked "Shared:" come from the organization\'s shared documents folder, the rest from this user\'s own documents.'
        : 'These come only from this user\'s own documents.'))
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
  const own = await syncScope({ dir: indexDir(), scope, root, extract: extractText, embed: embed ?? undefined, budgetMs: SYNC_BUDGET_MS })
  // The shared folder, indexed once for everyone, inside what is left of the
  // budget; this caller's grants decide which of its chunks they see.
  const shared = sharedSource(dsCfg)
  let sync = own
  if (shared) {
    const left = Math.max(1000, SYNC_BUDGET_MS - (Date.now() - started))
    const s2 = await syncScope({ dir: indexDir(), scope: SHARED_SCOPE, grantId: SHARED_GRANT, root: shared.root, extract: extractText, embed: embed ?? undefined, budgetMs: left })
    sync = {
      ...own,
      files: own.files + s2.files,
      indexed: own.indexed + s2.indexed,
      pending: own.pending + s2.pending,
      errors: [...own.errors, ...s2.errors.map((e) => `${SHARED_LABEL}${e}`)],
    }
  }
  const sharedSrc = shared ? [{ scope: SHARED_SCOPE, grantId: SHARED_GRANT, pathPrefixes: shared.pathPrefixes }] : []
  let queryVector = null
  if (embed) {
    const v = await embed([query])
    if (Array.isArray(v) && v[0]) queryVector = v[0]
  }
  // A project chat searches the project's files first (projects-plan D14).
  // The project comes from the VERIFIED conversation (or a client's verified
  // project, for one with no Nest conversation), never an argument; the
  // model can only widen back to everything with scope "all". When the
  // project's files have nothing, the whole folder is searched and the
  // answer says so, so "nothing found" is never claimed too early.
  // The project's folder is shared by its members, so it is a source of its
  // own (indexed once for all of them), not a corner of this user's files.
  const project = projectForCall(ctx?.account ?? null, ctx)
  let projectSrc = null
  if (project) {
    try {
      const projectRoot = ensureProjectFiles(dsCfg.documentsRoot, project)
      const left = Math.max(1000, SYNC_BUDGET_MS - (Date.now() - started))
      const s3 = await syncScope({ dir: indexDir(), scope: projectScope(project), grantId: PROJECT_GRANT, root: projectRoot, extract: extractText, embed: embed ?? undefined, budgetMs: left })
      sync = { ...sync, files: sync.files + s3.files, indexed: sync.indexed + s3.indexed, pending: sync.pending + s3.pending, errors: [...sync.errors, ...s3.errors.map((e) => `${PROJECT_LABEL}${e}`)] }
      projectSrc = { scope: projectScope(project), grantId: PROJECT_GRANT }
    } catch (err) {
      logEvent('documents', 'project_folder_failed', { reason: err.message })
    }
  }
  const everywhere = [{ scope }, ...sharedSrc, ...(projectSrc ? [projectSrc] : [])]
  const projectFirst = projectSrc && args?.scope !== 'all'
  let hits = projectFirst
    ? await searchScope({ dir: indexDir(), scope: projectSrc.scope, grantId: PROJECT_GRANT, query, queryVector, limit })
    : await searchSources({ dir: indexDir(), sources: everywhere, query, queryVector, limit })
  let where = projectFirst ? 'project' : 'all'
  if (projectFirst && hits.length === 0) {
    hits = await searchSources({ dir: indexDir(), sources: everywhere, query, queryVector, limit })
    where = 'fallback'
  }
  let text = formatHits(hits, { query, status: { ...sync, semantic: !!queryVector } })
  if (where === 'project') text = `From the files of the project "${project.name}", which everyone in the project shares. Search with scope "all" for the rest of the user's documents.\n\n${text}`
  if (where === 'fallback') text = `Nothing in the files of the project "${project.name}" matched, so this searched all of the user's documents.\n\n${text}`

  logEvent('documents', 'searched', { durationMs: Date.now() - started, files: sync.files, indexed: sync.indexed, pending: sync.pending, hits: hits.length, semantic: !!queryVector, shared: hits.filter(isShared).length })

  // One link per distinct source of the user's own, so the user can open what
  // was read (Phase 2). A shared file has no download link: the download
  // route serves the user's own folders; the file explorer shows the shared
  // one (6.2).
  const seen = new Set()
  const links = []
  for (const h of hits) {
    if (isShared(h) || isProjectHit(h) || seen.has(h.chunk.path)) continue
    seen.add(h.chunk.path)
    links.push(fileLink(h.chunk.path))
  }
  return { content: [{ type: 'text', text }, ...links] }
}

/** The manual rebuild (rag-plan §4): forget the caller's index; the next search rebuilds it. */
export async function rebuildIndexFor(account) {
  await clearScope({ dir: indexDir(), scope: scopeFor(account) })
}
