'use strict'

// =============================================================================
// Redstart Nest — projects: a named place for related chats (projects-plan)
// =============================================================================
// A project holds instructions that apply to every chat in it, its own memory
// (memory-storage, scope key `<account>#project:<id>`), a files folder under
// the user's Documents, and the chats that point at it (conversation
// `projectId`). Claude Projects is the model.
//
//   <config>/projects.json
//   { accounts: { "<scope key>": [project] } }
//
// The scope key is memoryKey(account): the account id, or '_local' with auth
// off, which every auth-off caller shares, as with memories and workflows.
//
// PERSONAL TODAY, SHARED LATER (plan D7). The user's target is Google-Docs-
// like: the owner adds people and sets what each may do. Not built. So that
// adding it is not a migration, every record carries `ownerKey` and an empty
// `members` list from the start, and every access decision goes through
// canRead / canWrite below, which today mean "the owner". Nothing else in Nest
// may compare keys itself.
//
// THE INSTRUCTIONS ARE USER-TIER TEXT (plan D9). They reach the model after
// the precedence clause, never among the admin's blocks; that framing is
// system-prompt.mjs's job. This module only bounds them.
// =============================================================================

import * as crypto from 'crypto'
import * as path from 'path'
import { configDir } from './platform-paths.mjs'
import { readJsonOr, writeJsonAtomic } from './json-store.mjs'
import { memoryKey } from './memory-storage.mjs'

export const MAX_NAME_CHARS = 80
export const MAX_INSTRUCTIONS_CHARS = 8000
export const MAX_PROJECTS_PER_ACCOUNT = 100
export const MAX_SLUG_CHARS = 48

const ID = /^[A-Za-z0-9-]{1,64}$/

function file() { return path.join(configDir(), 'projects.json') }
function read() {
  const data = readJsonOr(file(), { accounts: {} })
  if (!data.accounts || typeof data.accounts !== 'object') data.accounts = {}
  return data
}
function write(data) { writeJsonAtomic(file(), data) }

export function isProjectId(id) {
  return typeof id === 'string' && ID.test(id)
}

// ---------------------------------------------------------------------------
// Access — the one place it is decided (plan D7)
// ---------------------------------------------------------------------------

/** May this caller see the project and use it in a chat? Owner only, today. */
export function canRead(project, account) {
  if (!project) return false
  try { return project.ownerKey === memoryKey(account) } catch { return false }
}

/** May this caller change or delete it? Owner only, today. */
export function canWrite(project, account) {
  return canRead(project, account)
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
// CRUD — scoped to the caller's own list
// ---------------------------------------------------------------------------

function ownList(data, account) {
  const key = memoryKey(account)
  if (!data.accounts[key]) data.accounts[key] = []
  return data.accounts[key]
}

/** The caller's projects, most recently updated first. */
export function listProjects(account) {
  const list = read().accounts[memoryKey(account)] || []
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt)
}

/** One project the caller may read, or null — never another account's. */
export function getProject(account, id) {
  if (!isProjectId(id)) return null
  let key
  try { key = memoryKey(account) } catch { return null }
  const project = (read().accounts[key] || []).find((p) => p.id === id) || null
  return canRead(project, account) ? project : null
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
  const list = ownList(data, account)
  if (list.length >= MAX_PROJECTS_PER_ACCOUNT) {
    return { ok: false, error: `the limit of ${MAX_PROJECTS_PER_ACCOUNT} projects is reached; delete one first` }
  }
  if (list.some((p) => p.name.toLowerCase() === v.fields.name.toLowerCase())) {
    return { ok: false, error: `a project named "${v.fields.name}" already exists`, code: 'conflict' }
  }
  const project = {
    id: crypto.randomUUID(),
    ownerKey: memoryKey(account),
    // plan D7: sharing is not built; the field exists so it is not a migration
    members: [],
    name: v.fields.name,
    instructions: v.fields.instructions,
    slug: uniqueSlug(list, slugify(v.fields.name)),
    createdAt: now,
    updatedAt: now,
  }
  list.push(project)
  write(data)
  return { ok: true, project }
}

export function updateProject(account, id, body, { now = Date.now() } = {}) {
  const v = validateProject(body, { partial: true })
  if (!v.ok) return v
  const data = read()
  const list = ownList(data, account)
  const idx = list.findIndex((p) => p.id === id)
  if (idx === -1 || !canWrite(list[idx], account)) return { ok: false, error: 'not found', code: 'not_found' }
  if (v.fields.name && list.some((p, i) => i !== idx && p.name.toLowerCase() === v.fields.name.toLowerCase())) {
    return { ok: false, error: `a project named "${v.fields.name}" already exists`, code: 'conflict' }
  }
  // Only validated fields: the body never sets id, ownerKey, members or slug.
  list[idx] = { ...list[idx], ...v.fields, updatedAt: now }
  write(data)
  return { ok: true, project: list[idx] }
}

/** Removes the record only. The route detaches chats and drops project memory. */
export function deleteProject(account, id) {
  const data = read()
  const list = ownList(data, account)
  const target = list.find((p) => p.id === id)
  if (!target || !canWrite(target, account)) return null
  data.accounts[memoryKey(account)] = list.filter((p) => p.id !== id)
  write(data)
  return target
}
