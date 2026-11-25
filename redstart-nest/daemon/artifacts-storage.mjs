'use strict'

// =============================================================================
// Redstart Nest — artifacts: persistent, versioned, shared work products
// =============================================================================
// Website mockups, prototypes, document mockups and SVGs that the chat-ui
// agent and the Yellowscript agent make and change through the same tools
// (artifacts-tool.mjs), and that people open in the web UI (artifacts plan).
// Nest is the only store (D1); no client keeps its own.
//
//   <config>/artifacts/
//     index.json        { version: 1, artifacts: [meta] }  — every field that
//                       listing and access need, so both are one read
//     <id>/record.json  { revisions: [{ n, sealedAt, by, conversationId, restoredFrom? }] }
//     <id>/draft/       the mutable working files (absent when clean)
//     <id>/draft.json   { base, holder: { accountKey, conversationId }, touchedAt }
//     <id>/revisions/<n>/   immutable, one full copy per revision (all kept, U2)
//
// DRAFTS AND REVISIONS (D7). Every content write goes to the draft. A draft is
// sealed into the next numbered revision when the client says its turn ended
// (seal), when it has been idle IDLE_SEAL_MS, or when another conversation
// takes the artifact over. A draft that changed nothing is discarded, not
// sealed. Restoring a revision makes a NEW revision with its content; history
// never rewinds.
//
// THE HOLDER. A draft belongs to one (account, conversation). A write from
// another while the draft was touched in the last HOLD_MS is refused (busy);
// after that, the old draft is sealed and the new writer takes over.
//
// ACCESS (§5, D4, D5) — first match wins, for caller C on artifact A:
//   1. C owns A                                        → owner
//   2. C owns or administers A's project, or manages
//      every project (manageProjects)                  → admin
//   3. A has an account entry for C                    → its role ('none' = no access)
//   4. A has group entries for C's groups              → the highest; 'none' only
//                                                        when every one is 'none'
//   5. A is in a project C is a member of:
//        inherit  project editor → editor, viewer → viewer
//        view     every member   → viewer
//        none     nothing from the project
//   6. otherwise nothing; routes answer 404
// The shared parts (owner key, group lookup) are access-core's.
//
// WHAT NO TOOL CAN DO (D8): share, transfer, delete, restore. Those functions
// are here for the gateway routes only; artifacts-tool.mjs never imports them.
//
// CRASH SAFETY. JSON through writeJsonAtomic; files written to a temp name and
// renamed; a seal copies draft/ to revisions/<n>.tmp/, renames it, then
// updates record.json, the index, and only then removes the draft. Startup
// (cleanupArtifacts) removes .tmp leftovers, revision folders no record names
// (their draft is still there and seals again), and draft folders without a
// draft.json, and puts each index head back in line with its record.
// =============================================================================

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { configDir } from './platform-paths.mjs'
import { readJsonOr, writeJsonAtomic } from './json-store.mjs'
import { ownerKeyOf, managesAllProjects, memberRoles, highestRole } from './access-core.mjs'
import { getProject, canWrite as canWriteProject } from './projects-storage.mjs'
import { findGroupById } from './groups-storage.mjs'
import { findById as findAccountById } from './accounts-storage.mjs'
import { replaceInText } from '../../shared/agent-core/replace-match.mjs'
import { moveToTrash } from './trash.mjs'

export const KINDS = ['web', 'document', 'svg']
export const PROJECT_ACCESS = ['inherit', 'view', 'none']
export const MEMBER_ROLES = ['editor', 'viewer', 'none']
export const MAX_FILES = 255
export const MAX_REVISION_BYTES = 10 * 1024 * 1024
export const MAX_FILE_BYTES = 2 * 1024 * 1024
export const MAX_TITLE_CHARS = 120
export const MAX_DESCRIPTION_CHARS = 2000
export const MAX_PATH_CHARS = 200
export const MAX_MEMBERS = 200
export const MAX_ARTIFACTS_PER_ACCOUNT = 1000
export const IDLE_SEAL_MS = 10 * 60 * 1000
export const HOLD_MS = 2 * 60 * 1000
/** What a file may be called. Text through the tools; binary arrives later (plan §15). */
export const EXTENSIONS = ['html', 'htm', 'css', 'js', 'mjs', 'json', 'svg', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'ico', 'woff2', 'txt', 'md']

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/

export function isArtifactId(id) {
  return typeof id === 'string' && ID.test(id)
}

// ---------------------------------------------------------------------------
// Where things are
// ---------------------------------------------------------------------------

export function artifactsRoot() { return path.join(configDir(), 'artifacts') }
const indexFile = () => path.join(artifactsRoot(), 'index.json')
const artDir = (id) => path.join(artifactsRoot(), id)
const recordFile = (id) => path.join(artDir(id), 'record.json')
const draftDir = (id) => path.join(artDir(id), 'draft')
const draftFile = (id) => path.join(artDir(id), 'draft.json')
const revisionsDir = (id) => path.join(artDir(id), 'revisions')
const revisionDir = (id, n) => path.join(revisionsDir(id), String(n))

function readIndex() {
  const data = readJsonOr(indexFile(), { version: 1, artifacts: [] })
  if (!Array.isArray(data.artifacts)) data.artifacts = []
  return data
}
function writeIndex(data) { writeJsonAtomic(indexFile(), { ...data, version: 1 }) }
function readRecord(id) {
  const r = readJsonOr(recordFile(id), { revisions: [] })
  if (!Array.isArray(r.revisions)) r.revisions = []
  return r
}
function readDraft(id) {
  const d = readJsonOr(draftFile(id), null)
  if (!d || typeof d !== 'object' || !fs.existsSync(draftDir(id))) return null
  return d
}

// ---------------------------------------------------------------------------
// Paths inside an artifact
// ---------------------------------------------------------------------------

/**
 * A file path inside an artifact: relative, '/'-separated, from
 * [A-Za-z0-9._/-], no '..', no dot-files, an allowed extension.
 * @returns {{ ok: true, path: string } | { ok: false, error: string }}
 */
export function validatePath(p) {
  if (typeof p !== 'string' || !p) return { ok: false, error: 'path is required, e.g. "index.html" or "css/site.css"' }
  if (p.length > MAX_PATH_CHARS) return { ok: false, error: `path is at most ${MAX_PATH_CHARS} characters` }
  if (p.startsWith('/') || p.includes('\\')) return { ok: false, error: `path "${p}" must be relative and use "/", e.g. "css/site.css"` }
  const segments = p.split('/')
  if (segments.length > 8) return { ok: false, error: 'paths are at most 8 folders deep' }
  for (const s of segments) {
    if (!SEGMENT.test(s)) return { ok: false, error: `path "${p}" may use only letters, digits, ".", "_", "-" and "/", and no part may start with "."` }
  }
  const ext = path.posix.extname(p).slice(1).toLowerCase()
  if (!EXTENSIONS.includes(ext)) return { ok: false, error: `"${p}": files must end in one of .${EXTENSIONS.join(', .')}` }
  return { ok: true, path: segments.join('/') }
}

/** Every file under a folder: [{ path, size }], '/'-separated, sorted. Dot-names (temp files) are skipped. */
function listFilesIn(dir) {
  const out = []
  const walk = (abs, rel) => {
    let entries
    try { entries = fs.readdirSync(abs, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const childRel = rel ? `${rel}/${e.name}` : e.name
      const childAbs = path.join(abs, e.name)
      if (e.isDirectory()) walk(childAbs, childRel)
      else if (e.isFile()) out.push({ path: childRel, size: fs.statSync(childAbs).size })
    }
  }
  walk(dir, '')
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/** The absolute file for a VALIDATED path inside `dir`. */
const fileIn = (dir, rel) => path.join(dir, ...rel.split('/'))

function writeFileAtomic(abs, data) {
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${crypto.randomBytes(4).toString('hex')}.tmp`)
  try {
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, abs)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* nothing to clean */ }
    throw err
  }
}

/** Remove a file and any folders it leaves empty, up to (not including) `root`. */
function removeFileIn(root, rel) {
  fs.rmSync(fileIn(root, rel), { force: true })
  let dir = path.dirname(fileIn(root, rel))
  while (path.resolve(dir) !== path.resolve(root)) {
    try { fs.rmdirSync(dir) } catch { break }
    dir = path.dirname(dir)
  }
}

function sameFiles(dirA, dirB) {
  const a = listFilesIn(dirA)
  const b = listFilesIn(dirB)
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].path !== b[i].path || a[i].size !== b[i].size) return false
    if (!fs.readFileSync(fileIn(dirA, a[i].path)).equals(fs.readFileSync(fileIn(dirB, b[i].path)))) return false
  }
  return true
}

/** The file a viewer opens first: index.html, else the first .html, else the first .svg. */
export function entryFile(files) {
  const paths = files.map((f) => f.path)
  if (paths.includes('index.html')) return 'index.html'
  return paths.find((p) => /\.html?$/i.test(p)) ?? paths.find((p) => /\.svg$/i.test(p)) ?? null
}

// ---------------------------------------------------------------------------
// Access — the one place it is decided (§5)
// ---------------------------------------------------------------------------

/**
 * @param {object | null} meta  the artifact's index entry
 * @param {object | null} account
 * @param {{ includeManager?: boolean }} [opts]  includeManager false: leave out
 *        the admin role that comes only from managing every project (listings)
 * @returns {'owner' | 'admin' | 'editor' | 'viewer' | null}
 */
export function accessFor(meta, account, { includeManager = true } = {}) {
  if (!meta) return null
  const key = ownerKeyOf(account)
  if (key === null) return null
  // 1. The owner.
  if (meta.ownerKey === key) return 'owner'
  if (!account) return null
  // 2. The project's owner (D5), or whoever manages every project — the
  // project's admins — whose admin role a listing leaves out.
  const project = meta.projectId ? getProject(account, meta.projectId) : null
  if (project && project.access === 'owner') return 'admin'
  if (includeManager && managesAllProjects(account)) return 'admin'
  // 3-4. The artifact's own entries: the account's, else its groups'.
  const held = memberRoles(meta.members, account)
  if (held.account) return held.account === 'none' ? null : /** @type {any} */ (held.account)
  if (held.groups.length) {
    const best = highestRole(held.groups)
    return best === 'none' ? null : /** @type {any} */ (best)
  }
  // 5. Through the project: real membership only (getProject also answers a
  // manager who is not a member).
  if (project && meta.projectAccess !== 'none') {
    const inProject = memberRoles(project.members, account)
    const role = highestRole([inProject.account, ...inProject.groups])
    if (!role) return null
    if (meta.projectAccess === 'view') return 'viewer'
    return role === 'editor' ? 'editor' : 'viewer'
  }
  return null
}

export const canReadArtifact = (meta, account) => accessFor(meta, account) !== null
export function canEditArtifact(meta, account) {
  const a = accessFor(meta, account)
  return a === 'owner' || a === 'admin' || a === 'editor'
}
export function canManageArtifact(meta, account) {
  const a = accessFor(meta, account)
  return a === 'owner' || a === 'admin'
}

/** What a tool says to someone who may read but not edit. */
export const VIEW_ONLY_TEXT = 'You can view this artifact but not edit it. artifact_create with "from" set to its id makes your own copy.'

const NOT_FOUND = { ok: false, code: 'not_found', error: 'No artifact with that id, or you cannot see it. artifact_list shows the ones you can.' }
const FORBIDDEN = (error) => ({ ok: false, code: 'forbidden', error })

/** The index entry, or null; both lookups go through here. */
function findMeta(data, id) {
  return isArtifactId(id) ? data.artifacts.find((a) => a.id === id) ?? null : null
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function cleanTitle(t) {
  if (typeof t !== 'string') return { ok: false, error: 'title must be a string' }
  const title = t.replace(/\s+/g, ' ').trim()
  if (!title) return { ok: false, error: 'title is required' }
  if (title.length > MAX_TITLE_CHARS) return { ok: false, error: `title is at most ${MAX_TITLE_CHARS} characters` }
  return { ok: true, title }
}
function cleanDescription(d) {
  if (d === undefined || d === null) return { ok: true, description: '' }
  if (typeof d !== 'string') return { ok: false, error: 'description must be a string' }
  const description = d.replace(/\r\n/g, '\n').trim()
  if (description.length > MAX_DESCRIPTION_CHARS) return { ok: false, error: `description is at most ${MAX_DESCRIPTION_CHARS} characters` }
  return { ok: true, description }
}
/** @returns {Buffer} */
const bytesOf = (content) => Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')

// ---------------------------------------------------------------------------
// Drafts, seals, revisions
// ---------------------------------------------------------------------------

/** Who is writing: the account's key and the conversation (null when the client has none). */
export function holderFor(account, conversationId) {
  return { accountKey: ownerKeyOf(account), conversationId: conversationId || null }
}
const sameHolder = (a, b) => !!a && !!b && a.accountKey === b.accountKey && (a.conversationId || null) === (b.conversationId || null)

/**
 * Seal the draft into the next revision, or discard it when it changed
 * nothing. Returns the new revision number, or null when nothing was sealed.
 */
function sealDraft(data, meta, now) {
  const draft = readDraft(meta.id)
  if (!draft) return null
  const headDir = meta.head ? revisionDir(meta.id, meta.head) : null
  const unchanged = headDir ? sameFiles(draftDir(meta.id), headDir) : listFilesIn(draftDir(meta.id)).length === 0
  if (!unchanged) {
    const record = readRecord(meta.id)
    const n = Math.max(meta.head || 0, ...record.revisions.map((r) => r.n)) + 1
    const tmp = path.join(revisionsDir(meta.id), `${n}.tmp`)
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.mkdirSync(revisionsDir(meta.id), { recursive: true })
    // Temp files (dot-names) are never part of a revision.
    fs.cpSync(draftDir(meta.id), tmp, { recursive: true, filter: (src) => !path.basename(src).startsWith('.') })
    fs.renameSync(tmp, revisionDir(meta.id, n))
    record.revisions.push({ n, sealedAt: now, by: draft.holder?.accountKey ?? null, conversationId: draft.holder?.conversationId ?? null })
    writeJsonAtomic(recordFile(meta.id), record)
    meta.head = n
    meta.updatedAt = now
    writeIndex(data)
  }
  fs.rmSync(draftFile(meta.id), { force: true })
  fs.rmSync(draftDir(meta.id), { recursive: true, force: true })
  return unchanged ? null : meta.head
}

/**
 * Make sure `holder` holds the artifact's draft, starting one from head when
 * there is none. Seals an idle draft, and another holder's once HOLD_MS has
 * passed; refuses while they are still at it.
 */
function takeDraft(data, meta, holder, now) {
  let draft = readDraft(meta.id)
  if (draft && !sameHolder(draft.holder, holder)) {
    if (now - (draft.touchedAt || 0) < HOLD_MS) {
      return { ok: false, code: 'busy', error: 'This artifact is being edited in another chat. Try again in a moment, or fork it with artifact_create and "from".' }
    }
    sealDraft(data, meta, now)
    draft = null
  } else if (draft && now - (draft.touchedAt || 0) > IDLE_SEAL_MS) {
    sealDraft(data, meta, now)
    draft = null
  }
  if (!draft) {
    fs.rmSync(draftDir(meta.id), { recursive: true, force: true })
    if (meta.head) fs.cpSync(revisionDir(meta.id, meta.head), draftDir(meta.id), { recursive: true })
    else fs.mkdirSync(draftDir(meta.id), { recursive: true })
    draft = { base: meta.head || 0, holder, touchedAt: now }
    writeJsonAtomic(draftFile(meta.id), draft)
  }
  return { ok: true, draft }
}

function touchDraft(data, meta, draft, now) {
  writeJsonAtomic(draftFile(meta.id), { ...draft, touchedAt: now })
  meta.updatedAt = now
  writeIndex(data)
}

/**
 * Where a read comes from: a revision by number; otherwise the draft when the
 * caller's own account holds it (so an agent reads what it just wrote, and the
 * person's viewer shows the live draft); otherwise head.
 * @returns {{ ok: true, dir: string | null, source: number | 'draft' } | { ok: false, error: string, code?: string }}
 */
function contentSource(meta, account, revision) {
  if (revision !== undefined && revision !== null && revision !== 'draft') {
    const n = Number(revision)
    if (!Number.isInteger(n) || n < 1 || !fs.existsSync(revisionDir(meta.id, n))) {
      return { ok: false, code: 'not_found', error: `Revision ${revision} does not exist; this artifact has ${meta.head ? `revisions 1-${meta.head}` : 'no revisions yet'}.` }
    }
    return { ok: true, dir: revisionDir(meta.id, n), source: n }
  }
  const draft = readDraft(meta.id)
  if (draft && draft.holder?.accountKey === ownerKeyOf(account)) return { ok: true, dir: draftDir(meta.id), source: 'draft' }
  if (revision === 'draft') return { ok: false, code: 'not_found', error: 'There is no draft of yours on this artifact.' }
  return { ok: true, dir: meta.head ? revisionDir(meta.id, meta.head) : null, source: meta.head || 0 }
}

/** Seal every draft idle longer than IDLE_SEAL_MS. Run by a timer and at startup. */
export function sealIdleDrafts(now = Date.now()) {
  const data = readIndex()
  let sealed = 0
  for (const meta of data.artifacts) {
    const draft = readDraft(meta.id)
    if (draft && now - (draft.touchedAt || 0) > IDLE_SEAL_MS && sealDraft(data, meta, now) !== null) sealed++
  }
  return sealed
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function view(meta, account) {
  const draft = readDraft(meta.id)
  const key = ownerKeyOf(account)
  return {
    id: meta.id,
    title: meta.title,
    description: meta.description,
    kind: meta.kind,
    ownerKey: meta.ownerKey,
    projectId: meta.projectId,
    projectAccess: meta.projectAccess,
    members: meta.members,
    head: meta.head || 0,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    role: accessFor(meta, account),
    draft: draft ? { mine: draft.holder?.accountKey === key, conversationId: draft.holder?.accountKey === key ? draft.holder.conversationId : null, touchedAt: draft.touchedAt, base: draft.base } : null,
  }
}

// ---------------------------------------------------------------------------
// Create, list, read
// ---------------------------------------------------------------------------

/**
 * A new artifact. In `projectId` when the caller may edit that project (D6),
 * otherwise in their own space, and `placedIn` says which. With `from`, a
 * copy of what the caller can see of that artifact (their own draft, else its
 * head); viewing is enough to fork. `files` are written over the copy.
 *
 * @param {object | null} account
 * @param {{ title?: string, kind?: string, description?: string, files?: Array<{ path: string, content: string | Buffer }>, from?: string }} body
 * @param {{ projectId?: string | null, conversationId?: string | null, sealNow?: boolean, now?: number }} [opts]
 *        sealNow: make revision 1 at once (the UI's "New"), not a draft
 */
export function createArtifact(account, body, { projectId = null, conversationId = null, sealNow = false, now = Date.now() } = {}) {
  const key = ownerKeyOf(account)
  if (key === null) return FORBIDDEN('Sign in to make artifacts.')
  if (!body || typeof body !== 'object') return { ok: false, error: 'a JSON object is required' }
  const data = readIndex()

  let source = null
  if (body.from !== undefined && body.from !== null && body.from !== '') {
    const src = findMeta(data, body.from)
    if (!src || !canReadArtifact(src, account)) return NOT_FOUND
    const where = contentSource(src, account, undefined)
    if (!where.ok) return where
    source = { meta: src, dir: where.dir }
  }

  const t = cleanTitle(body.title ?? (source ? `${source.meta.title} (copy)`.slice(0, MAX_TITLE_CHARS) : undefined))
  if (!t.ok) return t
  const kind = body.kind ?? source?.meta.kind ?? 'web'
  if (!KINDS.includes(kind)) return { ok: false, error: `kind must be one of ${KINDS.join(', ')}` }
  const d = cleanDescription(body.description ?? (source ? source.meta.description : undefined))
  if (!d.ok) return d
  const files = body.files ?? []
  if (!Array.isArray(files)) return { ok: false, error: 'files must be a list of { path, content }' }
  const checked = []
  for (const f of files) {
    const p = validatePath(f?.path)
    if (!p.ok) return p
    if (typeof f.content !== 'string' && !Buffer.isBuffer(f.content)) return { ok: false, error: `"${p.path}": content must be a string` }
    checked.push({ path: p.path, data: bytesOf(f.content) })
  }

  if (data.artifacts.filter((a) => a.ownerKey === key).length >= MAX_ARTIFACTS_PER_ACCOUNT) {
    return { ok: false, error: `the limit of ${MAX_ARTIFACTS_PER_ACCOUNT} artifacts is reached; delete some first` }
  }

  // D6: a project's editors may add to it; anyone else's lands in their own space.
  let placedIn = 'own'
  let projectRefused = null
  let inProject = null
  if (projectId) {
    const project = getProject(account, projectId)
    if (project && canWriteProject(project, account)) { inProject = project.id; placedIn = 'project' }
    else if (project) projectRefused = project.name
  }

  // Limits over the copy plus the new files, before anything is written.
  const merged = new Map()
  if (source?.dir) for (const f of listFilesIn(source.dir)) merged.set(f.path, f.size)
  for (const f of checked) {
    if (f.data.length > MAX_FILE_BYTES) return { ok: false, error: `"${f.path}" is ${f.data.length} bytes; a file is at most ${MAX_FILE_BYTES}` }
    merged.set(f.path, f.data.length)
  }
  const limit = checkLimits(merged)
  if (limit) return limit

  const id = crypto.randomUUID()
  const meta = {
    id,
    ownerKey: key,
    projectId: inProject,
    projectAccess: 'inherit',
    members: [],
    title: t.title,
    description: d.description,
    kind,
    head: 0,
    createdAt: now,
    updatedAt: now,
    ...(source ? { forkedFrom: source.meta.id } : {}),
  }
  fs.mkdirSync(artDir(id), { recursive: true })
  writeJsonAtomic(recordFile(id), { revisions: [] })
  data.artifacts.push(meta)
  writeIndex(data)

  if (source?.dir || checked.length) {
    fs.mkdirSync(draftDir(id), { recursive: true })
    if (source?.dir) fs.cpSync(source.dir, draftDir(id), { recursive: true })
    for (const f of checked) writeFileAtomic(fileIn(draftDir(id), f.path), f.data)
    writeJsonAtomic(draftFile(id), { base: 0, holder: holderFor(account, conversationId), touchedAt: now })
    if (sealNow) sealDraft(data, meta, now)
  }
  return { ok: true, artifact: view(meta, account), placedIn, projectRefused }
}

function checkLimits(sizes) {
  if (sizes.size > MAX_FILES) return { ok: false, code: 'too_large', error: `an artifact holds at most ${MAX_FILES} files` }
  let total = 0
  for (const s of sizes.values()) total += s
  if (total > MAX_REVISION_BYTES) return { ok: false, code: 'too_large', error: `an artifact is at most ${MAX_REVISION_BYTES / 1024 / 1024} MB in all; this would be ${(total / 1024 / 1024).toFixed(1)} MB` }
  return null
}

/**
 * The artifacts the caller can see, newest first, each with `role`.
 * scope: 'mine' (owned), 'shared' (given to them directly or by a group),
 * 'project' (in projectId, or in any project when none is named); omitted:
 * all of them. One reached only by managing every project is left out, as
 * projects leave out theirs.
 */
export function listArtifacts(account, { scope, projectId, query } = {}) {
  const key = ownerKeyOf(account)
  if (key === null) return []
  const q = typeof query === 'string' ? query.trim().toLowerCase() : ''
  return readIndex().artifacts
    .map((meta) => ({ meta, role: accessFor(meta, account, { includeManager: false }) }))
    .filter(({ meta, role }) => {
      if (!role) return false
      if (scope === 'mine' && meta.ownerKey !== key) return false
      // Shared: not mine, and not reached by opening a project I am in (a
      // reviewer given one project artifact finds it here).
      if (scope === 'shared' && (meta.ownerKey === key || (meta.projectId && getProject(account, meta.projectId)))) return false
      if (scope === 'project' && (projectId ? meta.projectId !== projectId : !meta.projectId)) return false
      if (!scope && projectId && meta.projectId !== projectId) return false
      if (q && !`${meta.title}\n${meta.description}`.toLowerCase().includes(q)) return false
      return true
    })
    .map(({ meta }) => view(meta, account))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** One artifact the caller can see, or null. Seals an idle draft on the way. */
export function getArtifact(account, id, { now = Date.now() } = {}) {
  const data = readIndex()
  const meta = findMeta(data, id)
  if (!meta || !canReadArtifact(meta, account)) return null
  const draft = readDraft(meta.id)
  if (draft && now - (draft.touchedAt || 0) > IDLE_SEAL_MS) sealDraft(data, meta, now)
  return view(meta, account)
}

/**
 * The files of a revision, the caller's draft, or head (contentSource), with
 * the artifact's view. `revision` 'draft' asks for the caller's draft only.
 */
export function getManifest(account, id, { revision } = {}) {
  const data = readIndex()
  const meta = findMeta(data, id)
  if (!meta || !canReadArtifact(meta, account)) return NOT_FOUND
  const where = contentSource(meta, account, revision)
  if (!where.ok) return where
  const files = where.dir ? listFilesIn(where.dir) : []
  return { ok: true, artifact: view(meta, account), source: where.source, files, entry: entryFile(files), bytes: files.reduce((s, f) => s + f.size, 0) }
}

/** One file's bytes from the same place getManifest reads. */
export function readArtifactFile(account, id, filePath, { revision } = {}) {
  const data = readIndex()
  const meta = findMeta(data, id)
  if (!meta || !canReadArtifact(meta, account)) return NOT_FOUND
  const p = validatePath(filePath)
  if (!p.ok) return p
  const where = contentSource(meta, account, revision)
  if (!where.ok) return where
  const abs = where.dir ? fileIn(where.dir, p.path) : null
  if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    const files = where.dir ? listFilesIn(where.dir).map((f) => f.path) : []
    return { ok: false, code: 'not_found', error: `"${p.path}" is not in this artifact. Its files: ${files.length ? files.join(', ') : '(none yet)'}.` }
  }
  return { ok: true, data: fs.readFileSync(abs), path: p.path, source: where.source, artifact: view(meta, account) }
}

/**
 * Read a revision's (or the token holder's draft's) file for the content
 * listener, by artifact id alone: the view token already carries the access
 * decision made when it was issued. Never called with a model-supplied id.
 */
export function readForViewToken(id, filePath, { revision, holderKey }) {
  const meta = findMeta(readIndex(), id)
  if (!meta) return null
  const p = validatePath(filePath)
  if (!p.ok) return null
  let dir
  if (revision === 'draft') {
    const draft = readDraft(id)
    if (!draft || draft.holder?.accountKey !== holderKey) return null
    dir = draftDir(id)
  } else {
    const n = Number(revision)
    if (!Number.isInteger(n) || n < 1) return null
    dir = revisionDir(id, n)
  }
  const abs = fileIn(dir, p.path)
  try {
    if (!fs.statSync(abs).isFile()) return null
    return fs.readFileSync(abs)
  } catch { return null }
}

/** For the content listener's directory URLs: the entry file of that revision or draft. */
export function entryForViewToken(id, { revision, holderKey }) {
  const meta = findMeta(readIndex(), id)
  if (!meta) return null
  if (revision === 'draft') {
    const draft = readDraft(id)
    return draft && draft.holder?.accountKey === holderKey ? entryFile(listFilesIn(draftDir(id))) : null
  }
  const n = Number(revision)
  return Number.isInteger(n) && n >= 1 ? entryFile(listFilesIn(revisionDir(id, n))) : null
}

// ---------------------------------------------------------------------------
// Content writes (tools and UI)
// ---------------------------------------------------------------------------

function editable(data, account, id) {
  const meta = findMeta(data, id)
  if (!meta || !canReadArtifact(meta, account)) return { ok: false, ...NOT_FOUND }
  if (!canEditArtifact(meta, account)) return FORBIDDEN(VIEW_ONLY_TEXT)
  return { ok: true, meta }
}

/**
 * Create, overwrite (content a string or Buffer) or delete (content null) one
 * file in the caller's draft.
 * @param {{ conversationId?: string | null, now?: number }} [opts]
 */
export function writeArtifactFile(account, id, filePath, content, { conversationId = null, now = Date.now() } = {}) {
  const data = readIndex()
  const e = editable(data, account, id)
  if (!e.ok) return e
  const meta = e.meta
  const p = validatePath(filePath)
  if (!p.ok) return p
  const bytes = content === null ? null : bytesOf(content)
  if (bytes && bytes.length > MAX_FILE_BYTES) return { ok: false, code: 'too_large', error: `"${p.path}" is ${bytes.length} bytes; a file is at most ${MAX_FILE_BYTES}` }
  // A delete of nothing is refused before the draft is taken, so it changes nothing.
  if (bytes === null) {
    const where = contentSource(meta, account, undefined)
    if (!where.ok || !where.dir || !fs.existsSync(fileIn(where.dir, p.path))) {
      return { ok: false, code: 'not_found', error: `"${p.path}" is not in this artifact, so there is nothing to delete.` }
    }
  }

  const took = takeDraft(data, meta, holderFor(account, conversationId), now)
  if (!took.ok) return took
  const dir = draftDir(meta.id)
  const abs = fileIn(dir, p.path)
  const existed = fs.existsSync(abs)
  if (bytes === null) {
    if (!existed) return { ok: false, code: 'not_found', error: `"${p.path}" is not in this artifact, so there is nothing to delete.` }
    removeFileIn(dir, p.path)
  } else {
    const sizes = new Map(listFilesIn(dir).map((f) => [f.path, f.size]))
    sizes.set(p.path, bytes.length)
    const limit = checkLimits(sizes)
    if (limit) return limit
    writeFileAtomic(abs, bytes)
  }
  touchDraft(data, meta, took.draft, now)
  return { ok: true, artifact: view(meta, account), path: p.path, action: bytes === null ? 'deleted' : existed ? 'overwrote' : 'created', bytes: bytes?.length ?? 0 }
}

/**
 * Replace old_string with new_string in one file of the caller's draft,
 * through the shared matcher (D3), so the errors are ys_replace's.
 */
export function editArtifactFile(account, id, filePath, oldString, newString, { replaceAll = false, conversationId = null, now = Date.now() } = {}) {
  if (typeof oldString !== 'string' || typeof newString !== 'string') return { ok: false, error: 'old_string and new_string must be strings (new_string may be empty).' }
  const data = readIndex()
  const e = editable(data, account, id)
  if (!e.ok) return e
  const meta = e.meta
  const p = validatePath(filePath)
  if (!p.ok) return p

  // Find the text before taking the draft, so a miss changes nothing.
  const where = contentSource(meta, account, undefined)
  const current = where.ok && where.dir && fs.existsSync(fileIn(where.dir, p.path)) ? fs.readFileSync(fileIn(where.dir, p.path), 'utf8') : null
  if (current === null) {
    const files = where.ok && where.dir ? listFilesIn(where.dir).map((f) => f.path) : []
    return { ok: false, code: 'not_found', error: `"${p.path}" is not in this artifact. Its files: ${files.length ? files.join(', ') : '(none yet)'}. artifact_write creates a file.` }
  }
  const r = replaceInText(current, oldString, newString, { replaceAll, label: p.path })
  if (!r.ok) return { ok: false, error: r.error }
  const bytes = Buffer.from(r.after, 'utf8')
  if (bytes.length > MAX_FILE_BYTES) return { ok: false, code: 'too_large', error: `"${p.path}" would be ${bytes.length} bytes; a file is at most ${MAX_FILE_BYTES}` }

  const took = takeDraft(data, meta, holderFor(account, conversationId), now)
  if (!took.ok) return took
  // The draft just taken may have been started from head, which can differ
  // from what was matched only if it was someone else's draft — re-run then.
  const abs = fileIn(draftDir(meta.id), p.path)
  const inDraft = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null
  let after = r.after
  if (inDraft !== current) {
    if (inDraft === null) return { ok: false, code: 'not_found', error: `"${p.path}" is not in this artifact any more.` }
    const again = replaceInText(inDraft, oldString, newString, { replaceAll, label: p.path, seen: 'changed' })
    if (!again.ok) return { ok: false, error: again.error }
    after = again.after
  }
  const sizes = new Map(listFilesIn(draftDir(meta.id)).map((f) => [f.path, f.size]))
  sizes.set(p.path, Buffer.byteLength(after))
  const limit = checkLimits(sizes)
  if (limit) return limit
  writeFileAtomic(abs, after)
  touchDraft(data, meta, took.draft, now)
  return { ok: true, artifact: view(meta, account), path: p.path, at: r.at, note: r.note }
}

/** Title and/or description; editors and up. */
export function renameArtifact(account, id, body, { now = Date.now() } = {}) {
  const data = readIndex()
  const e = editable(data, account, id)
  if (!e.ok) return e
  const meta = e.meta
  if (body?.title !== undefined) {
    const t = cleanTitle(body.title)
    if (!t.ok) return t
    meta.title = t.title
  }
  if (body?.description !== undefined) {
    const d = cleanDescription(body.description)
    if (!d.ok) return d
    meta.description = d.description
  }
  meta.updatedAt = now
  writeIndex(data)
  return { ok: true, artifact: view(meta, account) }
}

/**
 * Seal the draft now (the client's turn ended). Only the draft's own holder
 * account, or the artifact's owner or admin, may; with `conversationId` given,
 * only that conversation's draft is sealed, so one chat ending never seals
 * another's work in progress.
 */
export function sealArtifact(account, id, { conversationId, now = Date.now() } = {}) {
  const data = readIndex()
  const meta = findMeta(data, id)
  if (!meta || !canReadArtifact(meta, account)) return NOT_FOUND
  const draft = readDraft(meta.id)
  if (!draft) return { ok: true, sealed: false, reason: 'no draft', revision: meta.head || 0 }
  const mine = draft.holder?.accountKey === ownerKeyOf(account)
  if (!mine && !canManageArtifact(meta, account)) return FORBIDDEN('This draft is someone else\'s.')
  if (conversationId !== undefined && (draft.holder?.conversationId || null) !== (conversationId || null)) {
    return { ok: true, sealed: false, reason: 'held by another chat', revision: meta.head || 0 }
  }
  const n = sealDraft(data, meta, now)
  return { ok: true, sealed: n !== null, reason: n === null ? 'unchanged' : undefined, revision: meta.head || 0, artifact: view(meta, account) }
}

/** The revision list, newest first. */
export function listRevisions(account, id) {
  const meta = findMeta(readIndex(), id)
  if (!meta || !canReadArtifact(meta, account)) return NOT_FOUND
  return { ok: true, revisions: readRecord(meta.id).revisions.slice().reverse(), head: meta.head || 0 }
}

// ---------------------------------------------------------------------------
// UI only (D8): restore, share, transfer, delete
// ---------------------------------------------------------------------------

/** A new revision with revision n's content. Editors and up. Seals a draft first. */
export function restoreRevision(account, id, n, { now = Date.now() } = {}) {
  const data = readIndex()
  const e = editable(data, account, id)
  if (!e.ok) return e
  const meta = e.meta
  if (!Number.isInteger(n) || n < 1 || !fs.existsSync(revisionDir(meta.id, n))) return { ok: false, code: 'not_found', error: `Revision ${n} does not exist.` }
  const draft = readDraft(meta.id)
  if (draft && !sameHolder(draft.holder, holderFor(account, null)) && now - (draft.touchedAt || 0) < HOLD_MS) {
    return { ok: false, code: 'busy', error: 'This artifact is being edited in a chat right now. Try again in a moment.' }
  }
  if (draft) sealDraft(data, meta, now)
  const record = readRecord(meta.id)
  const next = Math.max(meta.head || 0, ...record.revisions.map((r) => r.n)) + 1
  const tmp = path.join(revisionsDir(meta.id), `${next}.tmp`)
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.cpSync(revisionDir(meta.id, n), tmp, { recursive: true })
  fs.renameSync(tmp, revisionDir(meta.id, next))
  record.revisions.push({ n: next, sealedAt: now, by: ownerKeyOf(account), conversationId: null, restoredFrom: n })
  writeJsonAtomic(recordFile(meta.id), record)
  meta.head = next
  meta.updatedAt = now
  writeIndex(data)
  return { ok: true, artifact: view(meta, account), revision: next }
}

/**
 * Who sees it: projectAccess ('inherit' | 'view' | 'none') and members
 * ([{ type: 'account' | 'group', id, role: 'editor' | 'viewer' | 'none' }]).
 * Owner and admin only.
 */
export function setArtifactAccess(account, id, body, { now = Date.now() } = {}) {
  const data = readIndex()
  const meta = findMeta(data, id)
  if (!meta || !canReadArtifact(meta, account)) return NOT_FOUND
  if (!canManageArtifact(meta, account)) return FORBIDDEN('Only the artifact\'s owner, or an admin, can change who it is shared with.')
  if (body?.projectAccess !== undefined) {
    if (!PROJECT_ACCESS.includes(body.projectAccess)) return { ok: false, error: `projectAccess must be one of ${PROJECT_ACCESS.join(', ')}` }
  }
  let clean = meta.members
  if (body?.members !== undefined) {
    if (!Array.isArray(body.members)) return { ok: false, error: 'members must be a list' }
    if (body.members.length > MAX_MEMBERS) return { ok: false, error: `at most ${MAX_MEMBERS} members` }
    const seen = new Set()
    clean = []
    for (const m of body.members) {
      const type = m?.type === 'group' ? 'group' : m?.type === 'account' ? 'account' : null
      if (!type || typeof m.id !== 'string' || !MEMBER_ROLES.includes(m.role)) return { ok: false, error: 'each member needs a type (account or group), an id and a role (editor, viewer or none)' }
      if (type === 'account' && !findAccountById(m.id)) return { ok: false, error: 'No such account' }
      if (type === 'group' && !findGroupById(m.id)) return { ok: false, error: 'No such group' }
      if (type === 'account' && m.id === meta.ownerKey) continue
      const k = `${type}:${m.id}`
      if (seen.has(k)) continue
      seen.add(k)
      clean.push({ type, id: m.id, role: m.role })
    }
  }
  if (body?.projectAccess !== undefined) meta.projectAccess = body.projectAccess
  meta.members = clean
  meta.updatedAt = now
  writeIndex(data)
  return { ok: true, artifact: view(meta, account) }
}

/** Hand it to another account; the previous owner stays as an editor (as projects do). */
export function transferArtifact(account, id, newOwnerId, { now = Date.now() } = {}) {
  const data = readIndex()
  const meta = findMeta(data, id)
  if (!meta || !canReadArtifact(meta, account)) return NOT_FOUND
  if (!canManageArtifact(meta, account)) return FORBIDDEN('Only the artifact\'s owner, or an admin, can hand it over.')
  const target = findAccountById(newOwnerId)
  if (!target) return { ok: false, error: 'No such account' }
  if (meta.ownerKey !== target.id) moveOwnership(meta, target.id, now)
  writeIndex(data)
  return { ok: true, artifact: view(meta, account) }
}

function moveOwnership(meta, newKey, now) {
  const previous = meta.ownerKey
  meta.ownerKey = newKey
  meta.members = (meta.members || []).filter((m) => !(m.type === 'account' && m.id === newKey))
  if (previous !== '_local' && findAccountById(previous)) meta.members.push({ type: 'account', id: previous, role: 'editor' })
  meta.updatedAt = now
}

/** Move it to the trash (recoverable). Owner and admin only. */
export async function deleteArtifact(account, id) {
  const data = readIndex()
  const meta = findMeta(data, id)
  if (!meta || !canReadArtifact(meta, account)) return NOT_FOUND
  if (!canManageArtifact(meta, account)) return FORBIDDEN('Only the artifact\'s owner, or an admin, can delete it.')
  const moved = await moveToTrash(artifactsRoot(), artDir(meta.id))
  if (!moved.ok) return { ok: false, error: moved.error }
  const fresh = readIndex()
  fresh.artifacts = fresh.artifacts.filter((a) => a.id !== meta.id)
  writeIndex(fresh)
  return { ok: true, hint: moved.hint }
}

// ---------------------------------------------------------------------------
// When projects, accounts and groups go away
// ---------------------------------------------------------------------------

/** A project was deleted: its artifacts move out to their owners, keeping their own members. */
export function detachProjectArtifacts(projectId, { now = Date.now() } = {}) {
  const data = readIndex()
  let moved = 0
  for (const meta of data.artifacts) {
    if (meta.projectId === projectId) { meta.projectId = null; meta.projectAccess = 'inherit'; meta.updatedAt = now; moved++ }
  }
  if (moved) writeIndex(data)
  return moved
}

/** An account is being deleted: its artifacts go to `toAccountId` (as its projects do), and it leaves every member list. */
export function handOverArtifacts(accountId, toAccountId, { now = Date.now() } = {}) {
  const data = readIndex()
  let transferred = 0
  for (const meta of data.artifacts) {
    if (meta.ownerKey === accountId) { moveOwnership(meta, toAccountId, now); transferred++ }
    meta.members = (meta.members || []).filter((m) => !(m.type === 'account' && m.id === accountId))
  }
  writeIndex(data)
  return { transferred }
}

/** A group was deleted: take it off every artifact. */
export function removeGroupFromArtifacts(groupId) {
  const data = readIndex()
  let changed = 0
  for (const meta of data.artifacts) {
    const before = (meta.members || []).length
    meta.members = (meta.members || []).filter((m) => !(m.type === 'group' && m.id === groupId))
    if (meta.members.length !== before) changed++
  }
  if (changed) writeIndex(data)
  return changed
}

export function countArtifactsOwnedBy(accountId) {
  return readIndex().artifacts.filter((a) => a.ownerKey === accountId).length
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/**
 * Put the store back in a consistent state after a crash: remove .tmp
 * revision folders and temp files, revision folders no record names (their
 * draft still exists and seals again), drafts without draft.json, and index
 * entries whose folder is gone; set each head to its record's last revision.
 */
export function cleanupArtifacts() {
  const root = artifactsRoot()
  if (!fs.existsSync(root)) return { removed: 0 }
  const data = readIndex()
  let removed = 0
  let changed = false
  const keep = []
  for (const meta of data.artifacts) {
    if (!isArtifactId(meta.id) || !fs.existsSync(artDir(meta.id))) { changed = true; removed++; continue }
    keep.push(meta)
    const record = readRecord(meta.id)
    const known = new Set(record.revisions.map((r) => String(r.n)))
    let entries = []
    try { entries = fs.readdirSync(revisionsDir(meta.id)) } catch { /* none yet */ }
    for (const name of entries) {
      if (!known.has(name)) { fs.rmSync(path.join(revisionsDir(meta.id), name), { recursive: true, force: true }); removed++ }
    }
    const last = record.revisions.reduce((m, r) => Math.max(m, r.n), 0)
    if ((meta.head || 0) !== last) { meta.head = last; changed = true }
    if (fs.existsSync(draftDir(meta.id)) && !fs.existsSync(draftFile(meta.id))) {
      fs.rmSync(draftDir(meta.id), { recursive: true, force: true }); removed++
    }
    removed += removeTempFiles(artDir(meta.id))
  }
  if (changed) { data.artifacts = keep; writeIndex(data) }
  return { removed }
}

let sweepTimer = null

/**
 * At daemon start: clean up after a crash, seal what went idle while Nest was
 * down, then seal idle drafts once a minute (D7's "idle 10 minutes" for a
 * client that never called seal). Never throws; a broken store must not stop
 * the daemon starting.
 */
export function startArtifactSweep(intervalMs = 60_000) {
  try {
    cleanupArtifacts()
    sealIdleDrafts()
  } catch (err) { console.warn('Artifact cleanup failed:', err.message) }
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = setInterval(() => {
    try { sealIdleDrafts() } catch (err) { console.warn('Artifact sweep failed:', err.message) }
  }, intervalMs)
  sweepTimer.unref?.()
}

export function stopArtifactSweep() {
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = null
}

function removeTempFiles(dir) {
  let n = 0
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  for (const e of entries) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) n += removeTempFiles(abs)
    else if (e.name.startsWith('.') && e.name.endsWith('.tmp')) { fs.rmSync(abs, { force: true }); n++ }
  }
  return n
}
