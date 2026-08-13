'use strict'

// =============================================================================
// Redstart Nest — File explorer API (per-account server storage)
// =============================================================================
// The HTTP surface behind the web UI's file explorer. Everything here operates
// on ONE account's own storage, and which account that is comes from the
// authenticated credential — never from a parameter. There is deliberately no
// way for a client to name a user; a request can only ever reach the caller's
// own files, so there is no ownership check to forget on one endpoint.
//
// Routes (all under /files/, all authenticated by the gateway before dispatch):
//   GET  /files/spaces           — which storage spaces exist for this account
//   GET  /files/list?space&path  — one directory listing
//   GET  /files/preview?space&path — extracted text for .pdf/.docx/.xlsx/.csv/…
//   POST /files/mkdir            — { space, path }
//   POST /files/rename           — { space, from, to }
//   POST /files/delete           — { space, path }   (recoverable — see trash.mjs)
//   POST /files/upload?space&path&name — raw body
//   (GET /files/download lives in tools-gateway.mjs and predates this module)
//
// UPLOAD IS THE ONE GENUINELY NEW RISK IN THIS FILE, and it is not a reuse of
// the model-facing rules. Every other write path in Redstart runs through a
// tool the model called, under a permission prompt, producing text. This one
// lets a signed-in human put ARBITRARY BYTES on the server's disk — a different
// question, needing its own answers: a size cap, an extension DENYLIST for
// things the OS or a browser would execute, a filename reduced to a bare
// basename, and no silent overwrite. Those limits live here rather than being
// borrowed from the tool layer, because the tool layer never had to think about
// executables.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import { resolveWithinRoot } from './path-scope.mjs'
import { resolveUserRoot } from './user-scope.mjs'
import { moveToTrash, isInTrash, TRASH_DIR_NAME } from './trash.mjs'
import { logAudit } from './logger.mjs'

// The capabilities that have per-account storage. `space` is validated against
// these keys, so a client cannot name an arbitrary config path.
//
// There are two because there are two write capabilities with separately
// configured roots — not as a UI choice. Which one a file lands in depends on
// which tool the model reached for, so the labels have to say that: "Documents"
// and "Files" side by side tell a user nothing about where their file went.
const SPACES = {
  documents: {
    label: 'Documents',
    description: 'Reports and documents the model writes, plus anything you upload for it to read',
    pick: (cfg) => cfg?.documents?.outputDir,
  },
  files: {
    label: 'Workspace',
    description: 'Scripts and project files the model reads and edits',
    pick: (cfg) => cfg?.fileSystem?.rootDir,
  },
}

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const MAX_LIST_ENTRIES = 1000
const MAX_PREVIEW_CHARS = 20000

// Extensions refused on upload. A denylist rather than an allowlist because the
// point of the explorer is that users keep their own working files here and an
// allowlist would be wrong for someone within a week. What must not land is
// anything a double-click or a stray shell would EXECUTE — including the script
// formats Windows runs without ceremony.
//
// DELIBERATELY NOT THE SAME LIST as documents-tool's create_document formats,
// which can write .ps1 and .js that this refuses. The two paths carry different
// evidence: an upload is opaque bytes arriving over HTTP, while a created file's
// entire contents were authored in the conversation and are visible to the user
// before they download it. Neither path executes anything. Do not "fix" the
// difference by loosening this set — tighten the other one if the call changes.
const BLOCKED_UPLOAD_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.com', '.scr', '.msi', '.msp', '.cpl', '.jar',
  '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh',
  '.hta', '.lnk', '.reg', '.scf', '.sh', '.app', '.pif', '.gadget',
])

// Extractable preview formats — reuses documents-tool's on-device extraction,
// so nothing about a preview leaves the machine. Every entry must be one
// extractText can actually handle (PLAIN_TEXT_EXTENSIONS or one of the parsed
// binary formats), or the preview 500s instead of rendering.
const PREVIEWABLE = new Set([
  '.pdf', '.docx', '.xlsx',
  '.txt', '.md', '.csv', '.json', '.html', '.log',
  '.py', '.js', '.ps1',
])

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(body))
}

function fail(res, status, message, type = 'invalid_request_error') {
  sendJson(res, status, { error: { message, type } })
}

async function readJsonBody(req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 1_000_000) throw new Error('Request body too large')
  }
  return body ? JSON.parse(body) : {}
}

/**
 * Resolve { space, path } to an absolute path inside the caller's own storage.
 * Both containment layers apply: the account's root inside the capability root,
 * then the client-supplied path inside the account's root.
 */
function resolveRequest(config, account, space, relPath = '.') {
  // hasOwnProperty, not a bare lookup: `SPACES['__proto__']` resolves to
  // Object.prototype — truthy, so a plain `if (!spec)` waves it through and the
  // next line throws on a spec that has no pick(). Same for 'constructor' and
  // 'toString'. A client-supplied string is never safe as a bare object key.
  const spec = Object.prototype.hasOwnProperty.call(SPACES, space) ? SPACES[space] : null
  if (!spec) return { error: { status: 400, message: `Unknown storage space: ${space}` } }
  const capabilityRoot = spec.pick(config)
  if (!capabilityRoot) return { error: { status: 404, message: `The ${spec.label} storage is not configured` } }

  let userRoot
  try {
    userRoot = resolveUserRoot(capabilityRoot, account, { create: true })
  } catch (err) {
    return { error: { status: 500, message: `Could not open your storage: ${err.message}` } }
  }

  let full
  try {
    full = resolveWithinRoot(userRoot, relPath ?? '.')
  } catch {
    // Deliberately the same message for "escaped" and "malformed": a probing
    // client learns nothing about the layout from the difference.
    return { error: { status: 403, message: 'Path is outside your storage' } }
  }
  return { userRoot, full }
}

const toRelative = (userRoot, full) => path.relative(userRoot, full).split(path.sep).join('/')

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function listDirectory(res, config, account, url) {
  const space = url.searchParams.get('space') || 'documents'
  const relPath = url.searchParams.get('path') || '.'
  const { userRoot, full, error } = resolveRequest(config, account, space, relPath)
  if (error) return fail(res, error.status, error.message)

  let stat
  try {
    stat = fs.statSync(full)
  } catch {
    return fail(res, 404, 'Folder not found', 'not_found')
  }
  if (!stat.isDirectory()) return fail(res, 400, 'Not a folder')

  let dirents
  try {
    dirents = fs.readdirSync(full, { withFileTypes: true })
  } catch (err) {
    return fail(res, 500, `Could not read the folder: ${err.message}`, 'internal_error')
  }

  const entries = []
  for (const dirent of dirents.slice(0, MAX_LIST_ENTRIES)) {
    const childPath = path.join(full, dirent.name)
    // The trash folder is an implementation detail of recoverable deletion, not
    // a place to browse: showing it would invite "delete" on already-deleted
    // items, which is the one path that could destroy data.
    if (dirent.isDirectory() && isInTrash(userRoot, childPath)) continue
    let childStat
    try {
      childStat = fs.statSync(childPath)
    } catch {
      continue // vanished or unreadable between readdir and stat
    }
    entries.push({
      name: dirent.name,
      path: toRelative(userRoot, childPath),
      type: childStat.isDirectory() ? 'folder' : 'file',
      size: childStat.isDirectory() ? null : childStat.size,
      modified: childStat.mtime.toISOString(),
      previewable: !childStat.isDirectory() && PREVIEWABLE.has(path.extname(dirent.name).toLowerCase()),
    })
  }
  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1,
  )

  sendJson(res, 200, {
    space,
    path: toRelative(userRoot, full),
    truncated: dirents.length > MAX_LIST_ENTRIES,
    entries,
  })
}

async function previewFile(res, config, account, url) {
  const space = url.searchParams.get('space') || 'documents'
  const relPath = url.searchParams.get('path')
  if (!relPath) return fail(res, 400, 'Missing required query parameter: path')

  const { full, error } = resolveRequest(config, account, space, relPath)
  if (error) return fail(res, error.status, error.message)
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return fail(res, 404, 'File not found', 'not_found')
  if (!PREVIEWABLE.has(path.extname(full).toLowerCase())) return fail(res, 415, 'No preview is available for this file type')

  try {
    // Same on-device extraction the model's read_document uses — .pdf/.docx/
    // .xlsx go through the local parsers, nothing is uploaded anywhere.
    const { extractText } = await import('./documents-tool.mjs')
    const text = await extractText(full)
    sendJson(res, 200, { text: text.slice(0, MAX_PREVIEW_CHARS), truncated: text.length > MAX_PREVIEW_CHARS })
  } catch (err) {
    fail(res, 500, `Could not read the file: ${err.message}`, 'internal_error')
  }
}

async function makeDirectory(req, res, config, account) {
  const body = await readJsonBody(req)
  const { userRoot, full, error } = resolveRequest(config, account, body.space, body.path)
  if (error) return fail(res, error.status, error.message)
  if (path.relative(userRoot, full) === '') return fail(res, 400, 'A folder needs a name')
  if (fs.existsSync(full)) return fail(res, 409, 'Something with that name already exists', 'conflict')
  try {
    fs.mkdirSync(full, { recursive: true })
  } catch (err) {
    return fail(res, 500, `Could not create the folder: ${err.message}`, 'internal_error')
  }
  sendJson(res, 201, { path: toRelative(userRoot, full) })
}

async function renameEntry(req, res, config, account) {
  const body = await readJsonBody(req)
  // BOTH paths are resolved through the same containment — a rename is two
  // path arguments, and checking only the source would let the destination
  // write anywhere.
  const from = resolveRequest(config, account, body.space, body.from)
  if (from.error) return fail(res, from.error.status, from.error.message)
  const to = resolveRequest(config, account, body.space, body.to)
  if (to.error) return fail(res, to.error.status, to.error.message)

  if (path.relative(from.userRoot, from.full) === '') return fail(res, 400, 'Cannot rename your storage root')
  if (path.relative(to.userRoot, to.full) === '') return fail(res, 400, 'The new name cannot be empty')
  if (!fs.existsSync(from.full)) return fail(res, 404, 'Not found', 'not_found')
  if (fs.existsSync(to.full)) return fail(res, 409, 'Something with that name already exists', 'conflict')

  // Refuse moving a folder inside itself. Drag-and-drop makes this a
  // one-gesture mistake — drop a folder onto a folder it contains — and
  // fs.renameSync answers it with a bare EINVAL that would surface as an
  // unexplained 500. path.relative() from a directory to something beneath it
  // has no '..' segment, which is exactly the test.
  const intoItself = path.relative(from.full, to.full)
  if (intoItself !== '' && !intoItself.startsWith('..') && !path.isAbsolute(intoItself)) {
    return fail(res, 400, 'A folder cannot be moved inside itself')
  }

  try {
    fs.mkdirSync(path.dirname(to.full), { recursive: true })
    fs.renameSync(from.full, to.full)
  } catch (err) {
    return fail(res, 500, `Could not rename: ${err.message}`, 'internal_error')
  }
  sendJson(res, 200, { path: toRelative(to.userRoot, to.full) })
}

async function deleteEntry(req, res, config, account) {
  const body = await readJsonBody(req)
  const { userRoot, full, error } = resolveRequest(config, account, body.space, body.path)
  if (error) return fail(res, error.status, error.message)

  if (path.relative(userRoot, full) === '') return fail(res, 400, 'Cannot delete your storage root')
  if (isInTrash(userRoot, full)) return fail(res, 400, `Items in ${TRASH_DIR_NAME}/ are kept so deletions can be undone`)
  if (!fs.existsSync(full)) return fail(res, 404, 'Not found', 'not_found')

  // Same rule as the model's delete: no implicit recursive removal. A user
  // emptying a folder should see what is in it first.
  const stat = fs.lstatSync(full)
  if (stat.isDirectory() && !stat.isSymbolicLink() && fs.readdirSync(full).length > 0) {
    return fail(res, 409, 'That folder is not empty. Remove its contents first.', 'conflict')
  }

  const relative = toRelative(userRoot, full)
  const outcome = await moveToTrash(userRoot, full)
  if (!outcome.ok) return fail(res, 500, `Could not delete: ${outcome.error}`, 'internal_error')

  logAudit('deleted', { tool: 'file-explorer', path: relative, kind: stat.isDirectory() ? 'directory' : 'file', recoverable: outcome.method })
  sendJson(res, 200, { path: relative, recoverable: outcome.method, hint: outcome.hint })
}

/**
 * Upload — the only place a user can put arbitrary bytes on the server.
 *
 * Raw body rather than multipart: one file per request, so there is no parser
 * to get wrong and no chance of a second part smuggling a second path. The
 * filename arrives as a query parameter and is reduced to a bare basename.
 */
async function uploadFile(req, res, config, account, url) {
  const space = url.searchParams.get('space') || 'documents'
  const dirParam = url.searchParams.get('path') || '.'
  const nameParam = url.searchParams.get('name') || ''

  // A file NAME must be exactly that. Stripping the directory off
  // "../escaped.txt" and saving it as "escaped.txt" would be contained and
  // therefore safe — but silently reinterpreting a request into a different one
  // is how a probing client gets a 201 and learns nothing, and how a genuine
  // client's bug goes unnoticed for months. Refuse instead of reinterpreting.
  // Both separators are checked regardless of platform, since the caller may be
  // on either.
  const name = String(nameParam).trim()
  if (!name || name === '.' || name === '..') return fail(res, 400, 'Missing or invalid file name')
  if (name.includes('/') || name.includes('\\') || name !== path.basename(name)) {
    return fail(res, 400, 'File name must not contain a path — use the path parameter for the folder')
  }

  const extension = path.extname(name).toLowerCase()
  if (BLOCKED_UPLOAD_EXTENSIONS.has(extension)) {
    return fail(res, 415, `Files of type ${extension} cannot be uploaded`)
  }

  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    return fail(res, 413, `Files must be ${MAX_UPLOAD_BYTES / 1048576} MB or smaller`, 'too_large')
  }

  const { userRoot, full, error } = resolveRequest(config, account, space, path.join(dirParam, name))
  if (error) return fail(res, error.status, error.message)
  if (fs.existsSync(full)) return fail(res, 409, 'A file with that name already exists', 'conflict')

  // Buffered with a running cap: Content-Length is a claim, not a guarantee, so
  // the real limit is enforced against the bytes actually received.
  const chunks = []
  let received = 0
  try {
    for await (const chunk of req) {
      received += chunk.length
      if (received > MAX_UPLOAD_BYTES) {
        return fail(res, 413, `Files must be ${MAX_UPLOAD_BYTES / 1048576} MB or smaller`, 'too_large')
      }
      chunks.push(chunk)
    }
  } catch (err) {
    return fail(res, 400, `Upload failed: ${err.message}`)
  }
  if (received === 0) return fail(res, 400, 'The uploaded file is empty')

  try {
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, Buffer.concat(chunks))
  } catch (err) {
    return fail(res, 500, `Could not save the file: ${err.message}`, 'internal_error')
  }
  sendJson(res, 201, { path: toRelative(userRoot, full), size: received })
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Handle an explorer route. Returns true when the request was handled.
 *
 * The gateway authenticates BEFORE calling this and passes the resulting
 * account in — this module never inspects headers, so there is exactly one
 * place where identity is established for these routes.
 */
export async function handleFilesRequest(req, res, urlPath, { config, account }) {
  const url = new URL(req.url, 'http://x')

  try {
    if (req.method === 'GET' && urlPath === '/files/spaces') {
      // Two capabilities pointed at the SAME folder is a perfectly reasonable
      // setup — and would otherwise produce two tabs showing identical
      // contents, where renaming in one silently changes the other. Collapse
      // them to the first, so the number of tabs reflects the number of actual
      // places rather than the number of capabilities.
      const seen = new Map()
      for (const [id, spec] of Object.entries(SPACES)) {
        const root = spec.pick(config)
        if (!root) continue
        const key = process.platform === 'win32'
          ? path.resolve(root).toLowerCase()
          : path.resolve(root)
        if (seen.has(key)) continue
        seen.set(key, { id, label: spec.label, description: spec.description })
      }
      sendJson(res, 200, { spaces: [...seen.values()] })
      return true
    }
    if (req.method === 'GET' && urlPath === '/files/list') {
      listDirectory(res, config, account, url)
      return true
    }
    if (req.method === 'GET' && urlPath === '/files/preview') {
      await previewFile(res, config, account, url)
      return true
    }
    if (req.method === 'POST' && urlPath === '/files/mkdir') {
      await makeDirectory(req, res, config, account)
      return true
    }
    if (req.method === 'POST' && urlPath === '/files/rename') {
      await renameEntry(req, res, config, account)
      return true
    }
    if (req.method === 'POST' && urlPath === '/files/delete') {
      await deleteEntry(req, res, config, account)
      return true
    }
    if (req.method === 'POST' && urlPath === '/files/upload') {
      await uploadFile(req, res, config, account, url)
      return true
    }
  } catch (err) {
    if (!res.headersSent) fail(res, 500, err.message, 'internal_error')
    return true
  }
  return false
}

// Exported for the boundary suite, which asserts the upload limits directly
// rather than inferring them from a rejected request.
export const UPLOAD_LIMITS = { maxBytes: MAX_UPLOAD_BYTES, blockedExtensions: BLOCKED_UPLOAD_EXTENSIONS }
