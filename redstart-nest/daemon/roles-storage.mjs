'use strict'

// =============================================================================
// Redstart Nest — Roles
// =============================================================================
// A role is a named set of GRANTS (roles.json version 2, 2026-11-24). An
// account holds any number of roles, directly and through its groups
// (groups-storage.mjs), and may do what any of them allows; permissions.mjs
// combineRoles() documents each field. Roles still cannot reach past the
// server: effective access is
//
//     (globally configured AND activated by the running profile) ∩ combined roles
//
// so roles.json never becomes a second source of truth about what exists.
//
// Version 1 roles were RESTRICTIONS (an absent field inherited everything)
// beside a hardcoded tier (owner / admin / user). access-migration.mjs turns
// those files into this shape once, keeping every account's reach exactly as it
// was. Only the owner remains a tier: the one account that cannot be narrowed,
// recovers the box, and reaches the control plane.
//
// BUILT-IN ROLES ARE HARDCODED, NOT SEEDED
//
// Same shape as BUILTIN_TOOLS/BUILTIN_GROUPS in tools-definitions.mjs: the
// built-ins live in code and are merged with the user's roles at read time.
// They cannot be edited or deleted; the UI offers "clone" instead.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import { configDir } from './platform-paths.mjs'
import { readJsonOr, writeJsonAtomic } from './json-store.mjs'
import { ensureAccessModel } from './access-migration.mjs'

function getPath() {
  return path.join(configDir(), 'roles.json')
}

/** The role a new account gets when none is chosen: what "no role" used to mean. */
export const DEFAULT_ROLE_ID = 'full-access'

const EVERYTHING = {
  capabilities: null,
  webSourceIds: null,
  allowWebSearchEngine: true,
  allowWhitelistBypass: true,
  fileSystem: { allowWrite: true, allowDestructive: true },
}

export const BUILTIN_ROLES = [
  {
    id: 'administrator',
    name: 'Administrator',
    description: 'Everything the running profile has enabled, and every kind of administration: accounts, groups, roles, prompt blocks, organization workflows and all projects.',
    builtIn: true,
    permissions: {
      ...EVERYTHING,
      admin: { manageAccounts: true, manageRoles: true, managePromptBlocks: true, manageOrgWorkflows: true, manageProjects: true },
    },
  },
  {
    id: DEFAULT_ROLE_ID,
    name: 'Full Access',
    description: 'Everything the running profile has enabled, and no administration. What a new account gets unless you choose otherwise.',
    builtIn: true,
    permissions: { ...EVERYTHING },
  },
  {
    id: 'restricted',
    name: 'Restricted',
    description: 'Web sources only: no local capabilities, no file-system writes, no general web search engine, no administration. A starting point to clone and widen.',
    builtIn: true,
    permissions: {
      capabilities: [],
      webSourceIds: null,
      allowWebSearchEngine: false,
      allowWhitelistBypass: false,
      fileSystem: { allowWrite: false, allowDestructive: false },
    },
  },
]

// roles.json is small, changes only on an admin action, and is read on every
// permission decision — i.e. on every request and every MCP message. The cache
// is invalidated by the only thing that can change the file (write, below), so
// "a role edit takes effect on the very next request" still holds exactly: the
// request that reads it always runs after the write that changed it.
let cached = null

let cachedKey = null

// Keyed by path and mtime, so a test pointing configDir elsewhere, a hand edit
// or a restore is never served a stale copy.
function fileKey() {
  const p = getPath()
  try { return `${p}@${fs.statSync(p).mtimeMs}` } catch { return `${p}@none` }
}

function read() {
  ensureAccessModel()
  const key = fileKey()
  if (!cached || cachedKey !== key) {
    cached = readJsonOr(getPath(), { version: 2, roles: [] })
    cachedKey = key
  }
  return cached
}

function write(data) {
  data.version = 2
  writeJsonAtomic(getPath(), data)
  cached = data
  cachedKey = fileKey()
}

/** User-defined roles only, in creation order. */
export function getUserRoles() {
  const roles = read().roles
  return Array.isArray(roles) ? roles : []
}

/** Built-ins first, then user-defined. This is the list the UI renders. */
export function listRoles() {
  return [...BUILTIN_ROLES, ...getUserRoles()]
}

export function findRoleById(id) {
  if (typeof id !== 'string' || !id) return null
  return listRoles().find(r => r.id === id) || null
}

export function isBuiltInRole(id) {
  return BUILTIN_ROLES.some(r => r.id === id)
}

/** Resolve role ids to role records, dropping any that no longer exist. */
export function resolveRoles(ids) {
  const all = listRoles()
  return [...new Set(Array.isArray(ids) ? ids : [])].map(id => all.find(r => r.id === id)).filter(Boolean)
}

export function upsertRole(role) {
  if (isBuiltInRole(role.id)) {
    return { ok: false, error: 'Built-in roles cannot be modified' }
  }
  const data = read()
  if (!Array.isArray(data.roles)) data.roles = []
  const idx = data.roles.findIndex(r => r.id === role.id)
  const now = new Date().toISOString()
  const record = {
    ...role,
    builtIn: false,
    createdAt: idx === -1 ? now : data.roles[idx].createdAt,
    updatedAt: now,
  }
  if (idx === -1) data.roles.push(record)
  else data.roles[idx] = record
  write(data)
  return { ok: true, role: record }
}

/**
 * Delete a role. Accounts and groups that held it are cleaned up by the caller
 * (auth.mjs deleteRole); until then a dangling id is simply ignored by
 * resolveRoles(), which can only take access away, never add it.
 */
export function deleteRole(id) {
  if (isBuiltInRole(id)) return { ok: false, error: 'Built-in roles cannot be deleted' }
  const data = read()
  const before = (data.roles || []).length
  data.roles = (data.roles || []).filter(r => r.id !== id)
  if (data.roles.length === before) return { ok: false, error: 'Role not found' }
  write(data)
  return { ok: true }
}
