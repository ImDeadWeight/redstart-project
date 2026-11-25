'use strict'

// =============================================================================
// Redstart Nest — MCP Provider: artifacts (artifacts plan §6, D2)
// =============================================================================
// ONE implementation for both agents: chat-ui's loop reaches these tools
// through its MCP client, Yellowscript through mergeNestTools, a background
// task through callToolAs. Capability id `artifacts`, unprefixed names
// (docs/tool-namespacing.md):
//
//   artifact_create  write  new artifact (in the chat's project when allowed, D6),
//                           or a fork with `from`
//   artifact_list    read   the ones the caller can see, newest first
//   artifact_read    read   the manifest, or one file numbered
//   artifact_write   write  create / overwrite / delete (content null) one file
//   artifact_edit    write  old/new-string replacement, the shared matcher (D3)
//   artifact_rename  write  title and description
//   artifact_check   read   HOST-RESOLVED (D11): offered only to a client that
//                           declared it; chat-ui loads the artifact in a hidden
//                           sandboxed frame, Yellowscript runs its CDP check
//
// WHAT NO TOOL HERE CAN DO (D8): share, hand over, delete or restore. Those
// are routes only (gateway/artifact-routes.mjs); this module never imports
// them. A "share this with X" injected into a page the model read has
// nothing to call. Every content change is a draft that becomes a revision
// the person can roll back, which is why these writes need no approval card
// (tools-definitions.mjs REVISIONED_WRITE_TOOLS).
//
// The project comes from the VERIFIED conversation, or the VERIFIED project a
// client with no Nest conversation named (projects-storage projectForCall),
// never from an argument.
//
// Every result that names an artifact ends with `[artifact: <id> r<n>|draft]`
// (shared/agent-core/artifact-lines.mjs), which hosts turn into a card and
// use to seal what the turn touched.
// =============================================================================

import {
  createArtifact, listArtifacts, getManifest, readArtifactFile, writeArtifactFile, editArtifactFile,
  renameArtifact, isArtifactId, KINDS, MAX_FILES, MAX_FILE_BYTES,
} from './artifacts-storage.mjs'
import { projectForCall, getProject } from './projects-storage.mjs'
import { formatArtifactLine } from '../../shared/agent-core/artifact-lines.mjs'
import { appOriginFromSession } from './artifact-session-origin.mjs'
import { logEvent } from './logger.mjs'

export const TOOL_NAMES = ['artifact_create', 'artifact_list', 'artifact_read', 'artifact_write', 'artifact_edit', 'artifact_rename', 'artifact_check']
/** Answered by the client running the loop (D11). */
export const HOST_RESOLVED = ['artifact_check']

const READ_LINES = 400
const READ_CHARS = 40_000
const LIST_LIMIT = 50

const SELF_CONTAINED = 'Artifacts are self-contained: nothing outside the artifact loads (no CDN scripts or styles, no web fonts, no remote images). Use system fonts, inline SVG, and files you write into the artifact.'

const idArg = { type: 'string', description: 'The artifact id (from artifact_create or artifact_list).' }

export function toolDefs(cfg, ctx) {
  if (!cfg?.artifacts?.enabled) return []
  const defs = [
    {
      name: 'artifact_create',
      description:
        'Make a new artifact: a web page, interactive prototype, document mockup or SVG that the user opens beside the chat and can share. It is saved and versioned, and you can change it later. ' +
        'Put the page in "index.html" and its CSS and JavaScript in their own files (relative links like "site.css" work). ' + SELF_CONTAINED + ' ' +
        'A new design direction is a new artifact; to try a variation of an existing one without changing it, pass its id as "from" (copies it). To change an artifact the user asked about, use artifact_edit or artifact_write on it instead.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A short name the user will recognise, e.g. "Sales dashboard".' },
          kind: { type: 'string', enum: KINDS, description: '"web" (default): a page or prototype. "document": a printable document mockup (use @page for the paper size). "svg": one SVG image.' },
          files: {
            type: 'array',
            description: `The files, e.g. [{"path":"index.html","content":"<!doctype html>..."},{"path":"site.css","content":"..."}]. Up to ${MAX_FILES} files, ${MAX_FILE_BYTES / 1024 / 1024} MB each.`,
            items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
          },
          from: { type: 'string', description: 'Optional: the id of an artifact to copy as the starting point (a fork). The original is not changed.' },
          description: { type: 'string', description: 'Optional: one sentence on what it is.' },
        },
        required: ['title'],
      },
    },
    {
      name: 'artifact_list',
      description: 'List the artifacts this user can see (their own, shared with them, and in their projects), newest first, with ids. Use it to find one the user mentions.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional words to look for in titles and descriptions.' },
          scope: { type: 'string', enum: ['mine', 'shared', 'project'], description: 'Optional: only the user\'s own, only ones shared with them, or only ones in a project.' },
        },
      },
    },
    {
      name: 'artifact_read',
      description: 'Read an artifact. Without "path": its title, kind, revision and file list. With "path": that file, with line numbers (the numbers are not part of the file). Read a file before you edit it.',
      inputSchema: {
        type: 'object',
        properties: {
          id: idArg,
          path: { type: 'string', description: 'Optional: a file in it, e.g. "index.html".' },
          offset: { type: 'number', description: 'Optional: the first line to show (1-based), for a long file.' },
          revision: { type: 'number', description: 'Optional: an earlier revision number. Default: the latest, including your unsaved changes.' },
        },
        required: ['id'],
      },
    },
    {
      name: 'artifact_write',
      description: 'Create or replace one whole file in an artifact, or delete it with "content": null. For a small change to an existing file, artifact_edit is better: it does not resend the file. ' + SELF_CONTAINED,
      inputSchema: {
        type: 'object',
        properties: {
          id: idArg,
          path: { type: 'string', description: 'The file, e.g. "index.html" or "js/app.js".' },
          content: { type: ['string', 'null'], description: 'The whole new content of the file, or null to delete it.' },
        },
        required: ['id', 'path', 'content'],
      },
    },
    {
      name: 'artifact_edit',
      description: 'Change part of one file in an artifact: replace old_string with new_string. old_string must match the file exactly, indentation included, and only once unless replace_all; add surrounding lines to make it unique. Read the file with artifact_read first.',
      inputSchema: {
        type: 'object',
        properties: {
          id: idArg,
          path: { type: 'string', description: 'The file, e.g. "index.html".' },
          old_string: { type: 'string', description: 'The exact text to replace, copied from the file.' },
          new_string: { type: 'string', description: 'The text to put there (may be empty).' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence.' },
        },
        required: ['id', 'path', 'old_string', 'new_string'],
      },
    },
    {
      name: 'artifact_rename',
      description: 'Change an artifact\'s title or description.',
      inputSchema: {
        type: 'object',
        properties: {
          id: idArg,
          title: { type: 'string', description: 'The new title.' },
          description: { type: 'string', description: 'Optional: the new one-sentence description.' },
        },
        required: ['id', 'title'],
      },
    },
  ]
  if ((ctx?.session?.hostTools ?? []).includes('artifact_check')) {
    defs.push({
      name: 'artifact_check',
      description:
        'Open an artifact the way the user will see it and report what happened: script errors, files that failed to load, the page title and visible text' +
        ' (and a screenshot when this app can take one). Check after you make or change one, before you say it is done, and fix what it reports.',
      inputSchema: {
        type: 'object',
        properties: {
          id: idArg,
          viewport: { type: 'string', enum: ['desktop', 'tablet', 'phone'], description: 'Optional: the screen width to check at. Default desktop.' },
        },
        required: ['id'],
      },
    })
  }
  return defs
}

const err = (text) => ({ isError: true, content: [{ type: 'text', text }] })
const ok = (text) => ({ content: [{ type: 'text', text }] })

/** Bytes as "2.1 KB". */
function size(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** "2 h ago", for a listing. */
function ago(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 129600) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} days ago`
}

/**
 * URLs a page loads from outside itself, which the content policy blocks
 * (D12): a src/href of http(s) or protocol-relative on a script, stylesheet,
 * image or font, and CSS @import / url() of one. Links (<a href>) are not
 * loads, so they are left alone.
 */
export function externalLoads(text) {
  if (typeof text !== 'string') return []
  const found = new Set()
  const tag = /<(script|link|img|source|video|audio|iframe|embed)\b[^>]*?\s(?:src|href)\s*=\s*["']?((?:https?:)?\/\/[^"'\s>]+)/gi
  for (const m of text.matchAll(tag)) found.add(m[2])
  const css = /(?:@import\s+(?:url\()?|url\()\s*["']?((?:https?:)?\/\/[^"')\s]+)/gi
  for (const m of text.matchAll(css)) found.add(m[1])
  return [...found].slice(0, 5)
}

function blockedNote(texts) {
  const urls = [...new Set(texts.flatMap(externalLoads))].slice(0, 5)
  return urls.length ? `\nThese load from outside the artifact and will be BLOCKED: ${urls.join(', ')}. Put the code or image in the artifact instead, or use system fonts.` : ''
}

const pageLink = (ctx, id) => {
  const origin = appOriginFromSession(ctx?.session)
  return origin ? `\nOpen: ${origin}/#/artifacts/${id}` : ''
}

const revisionOf = (art) => art.draft?.mine ? 'draft' : art.head

function describeSource(source, head) {
  if (source === 'draft') return head ? `your unsaved changes on top of revision ${head}` : 'your unsaved first version'
  return source ? `revision ${source}` : 'empty, nothing saved yet'
}

export async function callTool(name, args, cfg, ctx) {
  if (!TOOL_NAMES.includes(name)) return null
  if (!cfg?.artifacts?.enabled) return err('The artifacts capability is not enabled.')
  if (name === 'artifact_check') {
    return err('artifact_check is answered by the application you are running in, and this application did not answer it. Continue without it, and tell the user you could not check the artifact yourself.')
  }
  const account = ctx?.account ?? null
  const conversationId = ctx?.conversationId ?? null
  const a = args && typeof args === 'object' ? args : {}
  const needId = () => (typeof a.id === 'string' && isArtifactId(a.id.trim()) ? a.id.trim() : null)

  try {
    if (name === 'artifact_list') {
      const all = listArtifacts(account, { scope: ['mine', 'shared', 'project'].includes(a.scope) ? a.scope : undefined, query: typeof a.query === 'string' ? a.query : undefined })
      if (!all.length) return ok(a.query ? `No artifact matches "${a.query}".` : 'This user has no artifacts yet. artifact_create makes one.')
      const names = new Map()
      const projectName = (id) => {
        if (!names.has(id)) names.set(id, getProject(account, id)?.name ?? null)
        return names.get(id)
      }
      const lines = all.slice(0, LIST_LIMIT).map((x) => {
        const p = x.projectId ? projectName(x.projectId) : null
        const rev = x.draft?.mine ? (x.head ? `r${x.head} + your draft` : 'draft') : x.head ? `r${x.head}` : 'empty'
        return `- ${x.id} "${x.title}" (${x.kind}, ${rev}, updated ${ago(x.updatedAt)}, you: ${x.role}${p ? `, project "${p}"` : ''})`
      })
      if (all.length > LIST_LIMIT) lines.push(`… and ${all.length - LIST_LIMIT} more; add a "query" to narrow it.`)
      return ok(lines.join('\n'))
    }

    if (name === 'artifact_create') {
      const project = projectForCall(account, ctx)
      const r = createArtifact(account, { title: a.title, kind: a.kind, description: a.description, files: a.files, from: a.from || undefined }, { projectId: project?.id ?? null, conversationId })
      if (!r.ok) return err(`Not created: ${r.error}`)
      const art = r.artifact
      const m = getManifest(account, art.id)
      const files = m.ok ? m.files : []
      logEvent('artifact', 'created', { via: 'tool', forked: !!a.from, files: files.length, placedIn: r.placedIn })
      const where = r.placedIn === 'project' ? ` in the project "${project.name}"`
        : r.projectRefused ? `. You can view the project "${r.projectRefused}" but not add to it, so it was made in the user's own space` : ''
      return ok(
        `Created artifact ${art.id} "${art.title}" (${art.kind})${where}${a.from ? `, a copy of ${a.from}` : ''}, with ${files.length ? `${files.length} file${files.length === 1 ? '' : 's'}: ${files.map((f) => f.path).join(', ')}` : 'no files yet; add them with artifact_write'}.\n` +
        'It is saved as a draft and becomes a revision when this turn ends.' +
        (m.ok && files.length && !m.entry ? '\nIt has no .html or .svg file, so there is nothing to open yet.' : '') +
        blockedNote((Array.isArray(a.files) ? a.files : []).map((f) => f?.content)) +
        pageLink(ctx, art.id) + '\n' +
        formatArtifactLine(art.id, revisionOf(art)),
      )
    }

    const id = needId()
    if (!id) return err('Missing or malformed "id". artifact_list shows the ids of the artifacts this user can see.')

    if (name === 'artifact_read') {
      const revision = a.revision === undefined || a.revision === null ? undefined : Number(a.revision)
      if (typeof a.path !== 'string' || !a.path) {
        const m = getManifest(account, id, { revision })
        if (!m.ok) return err(m.error)
        const art = m.artifact
        const list = m.files.length ? m.files.map((f) => `  ${f.path} (${size(f.size)})`).join('\n') : '  (no files yet)'
        return ok(
          `Artifact ${art.id} "${art.title}" (${art.kind})${art.description ? `: ${art.description}` : ''}\n` +
          `Showing ${describeSource(m.source, art.head)}; ${art.head} revision${art.head === 1 ? '' : 's'} saved. Your role: ${art.role}.\n` +
          `Files (${m.files.length}, ${size(m.bytes)}), opens at ${m.entry ?? '(no page)'}:\n${list}` +
          pageLink(ctx, art.id) + '\n' +
          formatArtifactLine(art.id, m.source === 'draft' ? 'draft' : m.source),
        )
      }
      const r = readArtifactFile(account, id, a.path, { revision })
      if (!r.ok) return err(r.error)
      const text = r.data.toString('utf8')
      const lines = text.split('\n')
      const start = Math.max(1, Math.floor(Number(a.offset) || 1))
      const out = []
      let chars = 0
      let n = start
      for (; n <= lines.length && n < start + READ_LINES; n++) {
        const line = `${String(n).padStart(5)}\t${lines[n - 1].replace(/\r$/, '')}`
        if (chars + line.length > READ_CHARS) break
        out.push(line)
        chars += line.length + 1
      }
      const more = n <= lines.length ? `\n(lines ${start}-${n - 1} of ${lines.length}; read on with "offset": ${n})` : ''
      return ok(`${r.path} in "${r.artifact.title}", ${describeSource(r.source, r.artifact.head)}:\n${out.join('\n')}${more}\n${formatArtifactLine(id, r.source === 'draft' ? 'draft' : r.source)}`)
    }

    if (name === 'artifact_write') {
      if (!('content' in a)) return err('artifact_write needs "content": the whole file, or null to delete it.')
      if (a.content !== null && typeof a.content !== 'string') return err('"content" must be a string, or null to delete the file.')
      const r = writeArtifactFile(account, id, a.path, a.content, { conversationId })
      if (!r.ok) return err(r.error)
      return ok(
        `${r.action === 'deleted' ? 'Deleted' : r.action === 'created' ? 'Created' : 'Replaced'} ${r.path} in "${r.artifact.title}"${r.action === 'deleted' ? '' : ` (${size(r.bytes)})`}. Saved as a draft; it becomes a revision when this turn ends.` +
        (r.action === 'deleted' ? '' : blockedNote([a.content])) + '\n' +
        formatArtifactLine(id, 'draft'),
      )
    }

    if (name === 'artifact_edit') {
      const r = editArtifactFile(account, id, a.path, a.old_string, a.new_string, { replaceAll: a.replace_all === true, conversationId })
      if (!r.ok) return err(r.error)
      return ok(`Edited ${r.path} in "${r.artifact.title}" at ${r.at}.${r.note ? ` ${r.note}` : ''} Saved as a draft; it becomes a revision when this turn ends.${blockedNote([a.new_string])}\n${formatArtifactLine(id, 'draft')}`)
    }

    // artifact_rename
    const r = renameArtifact(account, id, { title: a.title, description: a.description })
    if (!r.ok) return err(r.error)
    return ok(`Renamed to "${r.artifact.title}".\n${formatArtifactLine(id, revisionOf(r.artifact))}`)
  } catch (e) {
    return err(`The artifact tool failed: ${e.message}`)
  }
}
