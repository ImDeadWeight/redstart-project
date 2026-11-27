'use strict'

// =============================================================================
// Redstart Nest — programs: a group of projects (tasks plan Phase 4)
// =============================================================================
// A program is a name, a description and a list of projects, with one page
// that shows them and their tasks together.
//
//   <config>/programs.json   { version: 1, programs: [program] }
//
// A PROGRAM GIVES NO ACCESS. Sharing a program shares its page, never its
// projects: each person sees the projects in it that they can already open,
// and nothing about the others (not even how many). So no project access ever
// depends on a program, and removing someone from a program takes nothing
// away from them in any project.
//
// Who may do what with the program itself, like a project (projects-plan D7),
// decided in accessFor() below and nowhere else:
//
//   viewer  open the program page
//   editor  also rename it, change its description, add and remove projects
//   owner   also share it, hand it over, delete it
//
// An admin who manages every project manages every program. Adding a project
// takes managing BOTH: the program (editor and up) and the project (its owner,
// or such an admin), so nobody can pull someone else's project into a page
// they run. Taking one out takes either.
//
// Not yet (the plan's later step): program instructions or memory that stack
// onto each project's.
// =============================================================================

import * as crypto from 'node:crypto'
import * as path from 'node:path'
import { configDir } from './platform-paths.mjs'
import { readJsonOr, writeJsonAtomic } from './json-store.mjs'
import { ownerKeyOf, managesAllProjects, memberRoles, highestRole } from './access-core.mjs'
import { findProjectById, accessFor as projectAccess, canManage as canManageProject, isProjectId } from './projects-storage.mjs'
import { findById as findAccountById } from './accounts-storage.mjs'
import { findGroupById } from './groups-storage.mjs'

export const MAX_NAME_CHARS = 80
export const MAX_DESCRIPTION_CHARS = 2000
export const MAX_PROGRAMS_PER_ACCOUNT = 50
export const MAX_PROJECTS_PER_PROGRAM = 100
export const MAX_MEMBERS = 200
const MEMBER_ROLES = ['viewer', 'editor']
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export const isProgramId = (id) => typeof id === 'string' && ID.test(id)

function file() { return path.join(configDir(), 'programs.json') }
function read() {
  const data = readJsonOr(file(), { version: 1, programs: [] })
  return { version: 1, programs: Array.isArray(data?.programs) ? data.programs : [] }
}
function write(data) { writeJsonAtomic(file(), { version: 1, programs: data.programs }) }

// ---------------------------------------------------------------------------
// Access — the one place it is decided
// ---------------------------------------------------------------------------

/** 'owner' | 'admin' | 'editor' | 'viewer', or null for nothing. */
export function accessFor(program, account) {
  if (!program) return null
  const key = ownerKeyOf(account)
  if (key === null) return null
  if (program.ownerKey === key) return 'owner'
  if (!account) return null
  const held = memberRoles(program.members, account)
  return highestRole([managesAllProjects(account) ? 'admin' : null, held.account, ...held.groups])
}
const canWrite = (program, account) => ['owner', 'admin', 'editor'].includes(accessFor(program, account))
const canManage = (program, account) => ['owner', 'admin'].includes(accessFor(program, account))

const accountName = (key) => (key && key !== '_local' ? findAccountById(key)?.username ?? null : null)

/**
 * What the caller sees: the program, its access, and ONLY the projects in it
 * they can open. The rest are left out entirely, count included.
 */
function view(program, account) {
  const access = accessFor(program, account)
  const projects = []
  for (const id of program.projectIds || []) {
    const p = findProjectById(id)
    const pa = p ? projectAccess(p, account) : null
    if (pa) projects.push({ id: p.id, name: p.name, access: pa, canRemove: canWrite(program, account) || canManageProject(p, account) })
  }
  return {
    id: program.id,
    name: program.name,
    description: program.description,
    ownerKey: program.ownerKey,
    ownerName: accountName(program.ownerKey),
    members: canManage(program, account) ? program.members : program.members.filter((m) => m.type === 'account' && m.id === account?.id),
    access,
    projects,
    createdAt: program.createdAt,
    updatedAt: program.updatedAt,
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateProgram(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'a JSON object is required' }
  const fields = {}
  if (body.name !== undefined || !partial) {
    if (typeof body.name !== 'string') return { ok: false, error: 'name must be a string' }
    const name = body.name.replace(/\s+/g, ' ').trim()
    if (!name) return { ok: false, error: 'name is required' }
    if (name.length > MAX_NAME_CHARS) return { ok: false, error: `name is at most ${MAX_NAME_CHARS} characters` }
    fields.name = name
  }
  if (body.description !== undefined || !partial) {
    const raw = body.description ?? ''
    if (typeof raw !== 'string') return { ok: false, error: 'description must be a string' }
    const description = raw.replace(/\r\n?/g, '\n').trim()
    if (description.length > MAX_DESCRIPTION_CHARS) return { ok: false, error: `description is at most ${MAX_DESCRIPTION_CHARS} characters` }
    fields.description = description
  }
  return { ok: true, fields }
}

const NOT_FOUND = { ok: false, error: 'not found', code: 'not_found' }

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** The programs the caller can open, newest change first. */
export function listPrograms(account) {
  if (ownerKeyOf(account) === null) return []
  return read().programs
    .filter((p) => accessFor(p, account))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((p) => view(p, account))
}

export function getProgram(account, id) {
  const p = isProgramId(id) ? read().programs.find((x) => x.id === id) : null
  return p && accessFor(p, account) ? { ok: true, program: view(p, account) } : NOT_FOUND
}

/** The program record for another module's own check (assignment routes). */
export function readableProgram(account, id) {
  const p = isProgramId(id) ? read().programs.find((x) => x.id === id) : null
  return p && accessFor(p, account) ? p : null
}

export function createProgram(account, body, { now = Date.now() } = {}) {
  const key = ownerKeyOf(account)
  if (key === null) return { ok: false, error: 'sign in to create programs', code: 'forbidden' }
  const v = validateProgram(body)
  if (!v.ok) return v
  const data = read()
  if (data.programs.filter((p) => p.ownerKey === key).length >= MAX_PROGRAMS_PER_ACCOUNT) {
    return { ok: false, error: `the limit of ${MAX_PROGRAMS_PER_ACCOUNT} programs is reached; delete one first` }
  }
  const program = { id: crypto.randomUUID(), ownerKey: key, members: [], projectIds: [], ...v.fields, createdAt: now, updatedAt: now }
  data.programs.push(program)
  write(data)
  return { ok: true, program: view(program, account) }
}

export function updateProgram(account, id, body, { now = Date.now() } = {}) {
  const v = validateProgram(body, { partial: true })
  if (!v.ok) return v
  const data = read()
  const p = data.programs.find((x) => x.id === id)
  if (!p || !accessFor(p, account)) return NOT_FOUND
  if (!canWrite(p, account)) return { ok: false, error: 'You can view this program but not change it', code: 'forbidden' }
  Object.assign(p, v.fields, { updatedAt: now })
  write(data)
  return { ok: true, program: view(p, account) }
}

export function deleteProgram(account, id) {
  const data = read()
  const p = data.programs.find((x) => x.id === id)
  if (!p || !accessFor(p, account)) return NOT_FOUND
  if (!canManage(p, account)) return { ok: false, error: 'Only the program\'s owner, or an admin, can delete it', code: 'forbidden' }
  data.programs = data.programs.filter((x) => x.id !== id)
  write(data)
  return { ok: true }
}

/** Replace the members, as a project's (owner and admin only). */
export function setProgramMembers(account, id, members, { now = Date.now() } = {}) {
  const data = read()
  const p = data.programs.find((x) => x.id === id)
  if (!p || !accessFor(p, account)) return NOT_FOUND
  if (!canManage(p, account)) return { ok: false, error: 'Only the program\'s owner, or an admin, can change who it is shared with', code: 'forbidden' }
  if (!Array.isArray(members)) return { ok: false, error: 'members must be a list' }
  if (members.length > MAX_MEMBERS) return { ok: false, error: `at most ${MAX_MEMBERS} members` }
  const seen = new Set()
  const clean = []
  for (const m of members) {
    const type = m?.type === 'group' ? 'group' : m?.type === 'account' ? 'account' : null
    if (!type || typeof m.id !== 'string' || !MEMBER_ROLES.includes(m.role)) return { ok: false, error: 'each member needs a type (account or group), an id and a role (viewer or editor)' }
    if (type === 'account' && !findAccountById(m.id)) return { ok: false, error: 'No such account' }
    if (type === 'group' && !findGroupById(m.id)) return { ok: false, error: 'No such group' }
    if (type === 'account' && m.id === p.ownerKey) continue
    const k = `${type}:${m.id}`
    if (seen.has(k)) continue
    seen.add(k)
    clean.push({ type, id: m.id, role: m.role })
  }
  p.members = clean
  p.updatedAt = now
  write(data)
  return { ok: true, program: view(p, account) }
}

/**
 * Set the program's projects. Each project added needs the caller to manage
 * it as well as the program; each taken out needs either. Projects the
 * caller cannot see stay where they are, whatever the list says: a caller
 * never removes what they were never shown.
 */
export function setProgramProjects(account, id, projectIds, { now = Date.now() } = {}) {
  const data = read()
  const p = data.programs.find((x) => x.id === id)
  if (!p || !accessFor(p, account)) return NOT_FOUND
  if (!Array.isArray(projectIds) || !projectIds.every(isProjectId)) return { ok: false, error: 'projectIds must be a list of project ids' }
  const wanted = new Set(projectIds)
  const current = p.projectIds || []
  const next = []
  for (const pid of current) {
    const proj = findProjectById(pid)
    const visible = proj && projectAccess(proj, account)
    if (!visible || wanted.has(pid)) { next.push(pid); continue }
    if (!(canWrite(p, account) || canManageProject(proj, account))) return { ok: false, error: `You cannot take "${proj.name}" out of this program`, code: 'forbidden' }
  }
  for (const pid of wanted) {
    if (next.includes(pid)) continue
    const proj = findProjectById(pid)
    if (!proj || !projectAccess(proj, account)) return { ok: false, error: 'No such project', code: 'not_found' }
    if (!canWrite(p, account)) return { ok: false, error: 'You can view this program but not add to it', code: 'forbidden' }
    if (!canManageProject(proj, account)) return { ok: false, error: `Only "${proj.name}"'s owner, or an admin, can add it to a program`, code: 'forbidden' }
    next.push(pid)
  }
  if (next.length > MAX_PROJECTS_PER_PROGRAM) return { ok: false, error: `at most ${MAX_PROJECTS_PER_PROGRAM} projects in a program` }
  p.projectIds = next
  p.updatedAt = now
  write(data)
  return { ok: true, program: view(p, account) }
}

/** The ids of the projects in a program the caller can open, for its task list. */
export function visibleProjectIds(account, program) {
  return (program?.projectIds || []).filter((pid) => {
    const proj = findProjectById(pid)
    return proj && projectAccess(proj, account)
  })
}

// ---------------------------------------------------------------------------
// When projects, accounts and groups go
// ---------------------------------------------------------------------------

/** A project was deleted: out of every program. */
export function removeProjectEverywhere(projectId) {
  const data = read()
  let changed = 0
  for (const p of data.programs) {
    const before = (p.projectIds || []).length
    p.projectIds = (p.projectIds || []).filter((id) => id !== projectId)
    if (p.projectIds.length !== before) changed++
  }
  if (changed) write(data)
  return changed
}

/** An account is being deleted: its programs go to `toAccountId`; it leaves every other. */
export function handOverAccountPrograms(accountId, toAccountId, { now = Date.now() } = {}) {
  const data = read()
  let transferred = 0
  for (const p of data.programs) {
    p.members = (p.members || []).filter((m) => !(m.type === 'account' && m.id === accountId))
    if (p.ownerKey === accountId && toAccountId) {
      p.ownerKey = toAccountId
      p.members = p.members.filter((m) => !(m.type === 'account' && m.id === toAccountId))
      p.updatedAt = now
      transferred++
    }
  }
  write(data)
  return { transferred }
}

/** A group was deleted: off every program. */
export function removeGroupFromPrograms(groupId) {
  const data = read()
  let changed = 0
  for (const p of data.programs) {
    const before = (p.members || []).length
    p.members = (p.members || []).filter((m) => !(m.type === 'group' && m.id === groupId))
    if (p.members.length !== before) changed++
  }
  if (changed) write(data)
  return changed
}

