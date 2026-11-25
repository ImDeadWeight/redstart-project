'use strict'

// =============================================================================
// Redstart Nest — projects: a named place for related chats (projects-plan)
// =============================================================================
// A project holds instructions that apply to every chat in it, its own memory
// (memory-storage, scope key `#project:<id>`), a files folder of its own
// (project_files/<id>/ under the Documents root), and the chats that point at
// it (conversation `projectId`). Claude Projects is the model.
//
//   <config>/projects.json   (version 2, 2026-11-24)
//   { version: 2, projects: [project] }
//
// Version 1 kept a list per owner ({ accounts: { "<owner key>": [project] } });
// read() flattens it once. ownerKey is memoryKey(account): the account id, or
// '_local' with auth off, which every auth-off caller shares.
//
// SHARED, LIKE A DOCUMENT (plan D7, built 2026-11-24). The owner adds people
// and groups as Viewers or Editors:
//
//   viewer  open the project, chat in it (with their OWN chats — chats are
//           never shared), read its instructions, memory and files
//   editor  also change its name and instructions, its memory and its files
//   owner   also manage members, hand the project to someone else, delete it
//
// An admin whose roles grant manageProjects (and the Nest owner) may do what
// the project's owner may, to every project. Every access decision goes
// through accessFor() below; nothing else in Nest may compare keys itself.
//
// THE INSTRUCTIONS ARE USER-TIER TEXT (plan D9). They reach the model after
// the precedence clause, never among the admin's blocks; that framing is
// system-prompt.mjs's job. This module only bounds them.
// =============================================================================

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { configDir } from './platform-paths.mjs'
import { readJsonOr, writeJsonAtomic } from './json-store.mjs'
import { memoryKey } from './memory-storage.mjs'
import { getConversation, getConversationAnyAccount } from './conversations-storage.mjs'
import { findGroupById } from './groups-storage.mjs'
import { findById as findAccountById } from './accounts-storage.mjs'
import { ownerKeyOf, managesAllProjects, memberRoles, highestRole } from './access-core.mjs'
import { resolveWithinRoot } from './path-scope.mjs'
import { resolveUserScope, USER_FILES_DIR } from './user-scope.mjs'

export const MAX_NAME_CHARS = 80
export const MAX_INSTRUCTIONS_CHARS = 8000
export const MAX_PROJECTS_PER_ACCOUNT = 100
export const MAX_SLUG_CHARS = 48
export const MAX_MEMBERS = 200
export const MEMBER_ROLES = ['viewer', 'editor']

const ID = /^[A-Za-z0-9-]{1,64}$/

function file() { return path.join(configDir(), 'projects.json') }
function read() {
  const data = readJsonOr(file(), { version: 2, projects: [] })
  if (data.version !== 2) {
    // Version 1: one list per owner. Flattened, each record keeping its
    // ownerKey (which every record already carried, plan D7).
    const projects = []
    for (const list of Object.values(data.accounts && typeof data.accounts === 'object' ? data.accounts : {})) {
      if (Array.isArray(list)) projects.push(...list)
    }
    const flat = { version: 2, projects: projects.map((p) => ({ ...p, members: [] })) }
    if (fs.existsSync(file())) write(flat)
    return flat
  }
  if (!Array.isArray(data.projects)) data.projects = []
  return data
}
function write(data) { writeJsonAtomic(file(), { ...data, version: 2 }) }

export function isProjectId(id) {
  return typeof id === 'string' && ID.test(id)
}

// ---------------------------------------------------------------------------
// Access — the one place it is decided (plan D7)
// ---------------------------------------------------------------------------

// The owner check, the admin check and the group lookup are access-core's,
// shared with artifacts; the rule that the HIGHEST role wins is projects'.
const keyOf = ownerKeyOf
export { managesAllProjects }

/**
 * What this caller may do with the project: 'owner' | 'admin' | 'editor' |
 * 'viewer', or null for nothing. With auth off everyone is the '_local' owner
 * of '_local' projects, as before; sharing needs accounts.
 */
export function accessFor(project, account) {
  if (!project) return null
  const key = keyOf(account)
  if (key === null) return null
  if (project.ownerKey === key) return 'owner'
  if (!account) return null
  const held = memberRoles(project.members, account)
  return highestRole([managesAllProjects(account) ? 'admin' : null, held.account, ...held.groups])
}

/** May this caller see the project, chat in it, read its memory and files? */
export function canRead(project, account) {
  return accessFor(project, account) !== null
}

/** May this caller change its name, instructions, memory and files? */
export function canWrite(project, account) {
  const a = accessFor(project, account)
  return a === 'owner' || a === 'admin' || a === 'editor'
}

/** May this caller manage its members, hand it over, or delete it? */
export function canManage(project, account) {
  const a = accessFor(project, account)
  return a === 'owner' || a === 'admin'
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * A folder-safe name derived from the project name, fixed at creation: the
 * files folder keeps its name when the project is renamed. Never empty, never
 * a dot-name, never a separator.
 */
export function slugify(name) {
  const s = String(name ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-+$/g, '')
  return s || 'project'
}

/**
 * @param {unknown} body
 * @param {{ partial?: boolean }} opts  partial: an update, where absent fields keep their value
 * @returns {{ ok: true, fields: object } | { ok: false, error: string }}
 */
export function validateProject(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'a JSON object is required' }
  const fields = {}

  if (body.name !== undefined || !partial) {
    if (typeof body.name !== 'string') return { ok: false, error: 'name must be a string' }
    const name = body.name.replace(/\s+/g, ' ').trim()
    if (!name) return { ok: false, error: 'name is required' }
    if (name.length > MAX_NAME_CHARS) return { ok: false, error: `name is at most ${MAX_NAME_CHARS} characters` }
    fields.name = name
  }

  if (body.instructions !== undefined || !partial) {
    const raw = body.instructions ?? ''
    if (typeof raw !== 'string') return { ok: false, error: 'instructions must be a string' }
    const instructions = raw.replace(/\r\n/g, '\n').trim()
    if (instructions.length > MAX_INSTRUCTIONS_CHARS) {
      return { ok: false, error: `instructions are at most ${MAX_INSTRUCTIONS_CHARS} characters; this is ${instructions.length}` }
    }
    fields.instructions = instructions
  }

  return { ok: true, fields }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

function ownedBy(data, key) {
  return data.projects.filter((p) => p.ownerKey === key)
}

/** The project with its caller's access attached, for responses. */
function withAccess(project, account) {
  return { ...project, access: accessFor(project, account) }
}

/**
 * The projects the caller owns or was given, most recently updated first,
 * each with `access`. An admin's view of every project is listAllProjects().
 */
export function listProjects(account) {
  if (keyOf(account) === null) return []
  return read().projects
    .map((p) => withAccess(p, account))
    .filter((p) => p.access && p.access !== 'admin')
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Every project, for an admin who manages them all; [] for anyone else. */
export function listAllProjects(account) {
  if (!managesAllProjects(account)) return []
  return read().projects.map((p) => withAccess(p, account)).sort((a, b) => b.updatedAt - a.updatedAt)
}

/** One project the caller may read (with `access`), or null. */
export function getProject(account, id) {
  if (!isProjectId(id)) return null
  const project = read().projects.find((p) => p.id === id) || null
  return canRead(project, account) ? withAccess(project, account) : null
}

function uniqueSlug(list, base) {
  const taken = new Set(list.map((p) => p.slug))
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const suffix = `-${i}`
    const candidate = `${base.slice(0, MAX_SLUG_CHARS - suffix.length)}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

/** @returns {{ ok: true, project: object } | { ok: false, error: string, code?: string }} */
export function createProject(account, body, { now = Date.now() } = {}) {
  const v = validateProject(body)
  if (!v.ok) return v
  const data = read()
  const key = memoryKey(account)
  const list = ownedBy(data, key)
  if (list.length >= MAX_PROJECTS_PER_ACCOUNT) {
    return { ok: false, error: `the limit of ${MAX_PROJECTS_PER_ACCOUNT} projects is reached; delete one first` }
  }
  if (list.some((p) => p.name.toLowerCase() === v.fields.name.toLowerCase())) {
    return { ok: false, error: `a project named "${v.fields.name}" already exists`, code: 'conflict' }
  }
  const project = {
    id: crypto.randomUUID(),
    ownerKey: key,
    members: [],
    name: v.fields.name,
    instructions: v.fields.instructions,
    slug: uniqueSlug(list, slugify(v.fields.name)),
    createdAt: now,
    updatedAt: now,
  }
  data.projects.push(project)
  write(data)
  return { ok: true, project: withAccess(project, account) }
}

export function updateProject(account, id, body, { now = Date.now() } = {}) {
  const v = validateProject(body, { partial: true })
  if (!v.ok) return v
  const data = read()
  const idx = data.projects.findIndex((p) => p.id === id)
  if (idx === -1 || !canRead(data.projects[idx], account)) return { ok: false, error: 'not found', code: 'not_found' }
  if (!canWrite(data.projects[idx], account)) return { ok: false, error: 'You can view this project but not change it', code: 'forbidden' }
  const owner = data.projects[idx].ownerKey
  if (v.fields.name && data.projects.some((p, i) => i !== idx && p.ownerKey === owner && p.name.toLowerCase() === v.fields.name.toLowerCase())) {
    return { ok: false, error: `a project named "${v.fields.name}" already exists`, code: 'conflict' }
  }
  // Only validated fields: the body never sets id, ownerKey, members or slug.
  data.projects[idx] = { ...data.projects[idx], ...v.fields, updatedAt: now }
  write(data)
  return { ok: true, project: withAccess(data.projects[idx], account) }
}

// ---------------------------------------------------------------------------
// Members and ownership
// ---------------------------------------------------------------------------

/**
 * Replace a project's members. Each is { type: 'account' | 'group', id, role:
 * 'viewer' | 'editor' }; the owner is never a member of their own project.
 */
export function setMembers(account, id, members, { now = Date.now() } = {}) {
  const data = read()
  const project = data.projects.find((p) => p.id === id)
  if (!project || !canRead(project, account)) return { ok: false, error: 'not found', code: 'not_found' }
  if (!canManage(project, account)) return { ok: false, error: 'Only the project\'s owner, or an admin, can change who it is shared with', code: 'forbidden' }
  if (!Array.isArray(members)) return { ok: false, error: 'members must be a list' }
  if (members.length > MAX_MEMBERS) return { ok: false, error: `at most ${MAX_MEMBERS} members` }
  const seen = new Set()
  const clean = []
  for (const m of members) {
    const type = m?.type === 'group' ? 'group' : m?.type === 'account' ? 'account' : null
    if (!type || typeof m.id !== 'string' || !MEMBER_ROLES.includes(m.role)) return { ok: false, error: 'each member needs a type (account or group), an id and a role (viewer or editor)' }
    if (type === 'account' && !findAccountById(m.id)) return { ok: false, error: 'No such account' }
    if (type === 'group' && !findGroupById(m.id)) return { ok: false, error: 'No such group' }
    if (type === 'account' && m.id === project.ownerKey) continue
    const k = `${type}:${m.id}`
    if (seen.has(k)) continue
    seen.add(k)
    clean.push({ type, id: m.id, role: m.role })
  }
  project.members = clean
  project.updatedAt = now
  write(data)
  return { ok: true, project: withAccess(project, account) }
}

/**
 * Hand a project to another account. The previous owner stays on as an
 * editor (as in Google Docs), unless that is who receives it. A clashing name
 * in the new owner's projects gets " (2)" and so on.
 */
export function transferProject(account, id, newOwnerId, { now = Date.now() } = {}) {
  const data = read()
  const project = data.projects.find((p) => p.id === id)
  if (!project || !canRead(project, account)) return { ok: false, error: 'not found', code: 'not_found' }
  if (!canManage(project, account)) return { ok: false, error: 'Only the project\'s owner, or an admin, can hand it over', code: 'forbidden' }
  const target = findAccountById(newOwnerId)
  if (!target) return { ok: false, error: 'No such account' }
  if (project.ownerKey === target.id) return { ok: true, project: withAccess(project, account) }
  moveOwnership(data, project, target.id, now)
  write(data)
  return { ok: true, project: withAccess(project, account) }
}

function moveOwnership(data, project, newKey, now) {
  const previous = project.ownerKey
  const taken = new Set(ownedBy(data, newKey).map((p) => p.name.toLowerCase()))
  let name = project.name
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${project.name.slice(0, MAX_NAME_CHARS - 6)} (${i})`
  project.name = name
  project.ownerKey = newKey
  project.members = (project.members || []).filter((m) => !(m.type === 'account' && m.id === newKey))
  if (previous !== '_local' && findAccountById(previous)) project.members.push({ type: 'account', id: previous, role: 'editor' })
  project.updatedAt = now
}

/**
 * An account is being deleted: hand every project it owns to `toAccountId`,
 * and take it off every project it was a member of. Called by the route that
 * deletes accounts, before the account goes.
 */
export function handOverAccount(accountId, toAccountId, { now = Date.now() } = {}) {
  const data = read()
  let transferred = 0
  for (const p of data.projects) {
    if (p.ownerKey === accountId) {
      moveOwnership(data, p, toAccountId, now)
      // The deleted account must not linger as an editor.
      p.members = p.members.filter((m) => !(m.type === 'account' && m.id === accountId))
      transferred++
    } else if ((p.members || []).some((m) => m.type === 'account' && m.id === accountId)) {
      p.members = p.members.filter((m) => !(m.type === 'account' && m.id === accountId))
    }
  }
  write(data)
  return { transferred }
}

/** A group was deleted: take it off every project. */
export function removeGroupEverywhere(groupId) {
  const data = read()
  let changed = 0
  for (const p of data.projects) {
    const before = (p.members || []).length
    p.members = (p.members || []).filter((m) => !(m.type === 'group' && m.id === groupId))
    if (p.members.length !== before) changed++
  }
  if (changed) write(data)
  return changed
}

/** Projects an account owns, for the "who takes these over?" question. */
export function countOwnedBy(accountId) {
  return read().projects.filter((p) => p.ownerKey === accountId).length
}

// ---------------------------------------------------------------------------
// AGENTS.md (master plan Phase 5)
// ---------------------------------------------------------------------------
// The file other coding agents read their project instructions from: plain
// Markdown, no front matter. A project's instructions ARE such a file, so the
// mapping is the text itself, both ways, and a round trip changes nothing.

/** A project's instructions as an AGENTS.md file. */
export function agentsMdFor(project) {
  return `${project.instructions ?? ''}`.replace(/\s+$/, '') + '\n'
}

/** An AGENTS.md file's text as instructions: BOM and CRLF gone, trimmed. */
export function instructionsFromAgentsMd(text) {
  return String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
}

// ---------------------------------------------------------------------------
// The files folder — the project's own, shared with its members
// ---------------------------------------------------------------------------
// <documents root>/project_files/<project id>/. Not inside anyone's
// user_files/<scope>/, because every member reaches it; the file explorer
// offers it as a space of its own (read-only to viewers) and search_documents
// searches it in the project's chats. Before 2026-11-24 it was
// user_files/<owner scope>/Projects/<slug>/; ensureProjectFiles() moves that
// folder here the first time it is needed.

export const PROJECT_FILES_DIR = 'project_files'

/** The project's folder, contained in the Documents root. Does not create it. */
export function projectFilesDir(documentsRoot, project) {
  if (!documentsRoot || !isProjectId(project?.id)) return null
  return resolveWithinRoot(documentsRoot, `${PROJECT_FILES_DIR}/${project.id}`)
}

/** Make the folder, moving the pre-sharing one into place if it exists. */
export function ensureProjectFiles(documentsRoot, project) {
  const dir = projectFilesDir(documentsRoot, project)
  if (!dir) return null
  if (!fs.existsSync(dir)) {
    let legacy = null
    try {
      const owner = project.ownerKey === '_local' ? null : findAccountById(project.ownerKey)
      if (owner || project.ownerKey === '_local') {
        legacy = resolveWithinRoot(documentsRoot, `${USER_FILES_DIR}/${resolveUserScope(owner)}/Projects/${project.slug}`)
      }
    } catch { legacy = null }
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    if (legacy && fs.existsSync(legacy)) fs.renameSync(legacy, dir)
    else fs.mkdirSync(dir, { recursive: true })
  }
  return dir
}

/** What a response says about the folder: the file-explorer space that shows it. */
export function projectFolder(project) {
  return `project-${project.id}`
}

/**
 * The project a tool call's conversation is in, or null (plan D10). The
 * conversation id must already be VERIFIED for this caller
 * (mcp-server verifiedConversationId); the project is then resolved through
 * getProject, so a chat pointing at a project the caller may not read
 * resolves to none. With auth off, conversations are keyed by a device id
 * the MCP connection does not carry, so the record is found by id alone —
 * the shared auth-off posture verifiedConversationId already takes.
 */
export function projectForConversation(account, conversationId) {
  if (!conversationId) return null
  const conv = account ? getConversation(account.id, conversationId) : getConversationAnyAccount(conversationId)
  return conv?.projectId ? getProject(account, conv.projectId) : null
}

/**
 * The project a tool call works in. Its conversation's, when Nest stores it;
 * otherwise the project the client named in _meta['redstart/projectId'] (a
 * client whose chats are its own, like Yellowscript), which mcp-server has
 * already checked (verifiedProjectId). Checked again here, so a ctx built
 * anywhere else cannot name a project the caller may not write. The
 * conversation wins: a stored chat's project is not the client's to change.
 */
export function projectForCall(account, ctx) {
  const fromConversation = projectForConversation(account, ctx?.conversationId ?? null)
  if (fromConversation) return fromConversation
  if (!ctx?.projectId) return null
  const project = getProject(account, ctx.projectId)
  return project && canWrite(project, account) ? project : null
}

/** Removes the record only. The route detaches chats and drops project memory. */
export function deleteProject(account, id) {
  const data = read()
  const target = data.projects.find((p) => p.id === id)
  if (!target || !canManage(target, account)) return null
  data.projects = data.projects.filter((p) => p.id !== id)
  write(data)
  return target
}
