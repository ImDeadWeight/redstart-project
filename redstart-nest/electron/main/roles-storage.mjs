'use strict'

// =============================================================================
// Redstart Nest — Roles
// =============================================================================
// A role is a named RESTRICTION applied to one account. It can never grant
// access the server has not already enabled: effective access is
//
//     (globally configured AND activated by the running profile) ∩ role
//
// so `roles.json` is a narrowing layer over `tools.json` + the profile, never a
// second source of truth about what exists. permissions.mjs is where that
// narrowing is actually computed; this module only stores and resolves.
//
// WHY ROLES ARE A SEPARATE AXIS FROM `tier`
//
// `tier` ('owner' | 'admin' | 'user') governs ACCOUNT MANAGEMENT — who may
// create accounts, who may be managed by whom (auth.mjs canManage). It is
// hardcoded and stays that way: the moment an admin can create a tier called
// "Legal Team", every management check in the system has to have an opinion
// about where it sits in a hierarchy that no longer exists. Roles govern
// CAPABILITY instead, and the two compose without either knowing about the
// other's values.
//
// BUILT-IN ROLES ARE HARDCODED, NOT SEEDED
//
// Same shape as BUILTIN_TOOLS/BUILTIN_GROUPS in tools-definitions.mjs: the
// built-ins live in code and are merged with the user's roles at read time.
// Seeding them into roles.json instead would mean a first-run write, and a
// built-in whose definition could drift from the code that documents it. They
// cannot be edited or deleted; the UI offers "clone" instead.
// =============================================================================

import * as path from 'path'
import { app } from 'electron'
import { readJsonOr, writeJsonAtomic } from './json-store.mjs'

function getPath() {
  return path.join(app.getPath('userData'), 'roles.json')
}

/**
 * The role every account resolves to when it has no `roleId`.
 *
 * Its permission set is EMPTY, and empty means "narrow nothing" (see
 * permissions.mjs). That is what makes this whole feature inert on upgrade:
 * every existing account has no roleId, resolves here, and is served exactly
 * the config it was served before.
 */
export const DEFAULT_ROLE_ID = 'full-access'

export const BUILTIN_ROLES = [
  {
    id: DEFAULT_ROLE_ID,
    name: 'Full Access',
    description:
      'Everything the running profile has enabled. Assigned to any account without a role, so it is also what the server did before roles existed.',
    builtIn: true,
    permissions: {},
  },
  {
    id: 'restricted',
    name: 'Restricted',
    description:
      'Web sources only — no local capabilities, no file-system writes, no administration. A starting point to clone and widen.',
    builtIn: true,
    permissions: {
      capabilities: [],
      fileSystem: { allowWrite: false, allowDestructive: false },
      allowWhitelistBypass: false,
      admin: {},
    },
  },
]

// roles.json is small, changes only on an admin action, and is read on every
// permission decision — i.e. on every request and every MCP message. The cache
// is invalidated by the only thing that can change the file (write, below), so
// "a role edit takes effect on the very next request" still holds exactly: the
// request that reads it always runs after the write that changed it.
let cached = null

function read() {
  if (!cached) cached = readJsonOr(getPath(), { roles: [] })
  return cached
}

function write(data) {
  writeJsonAtomic(getPath(), data)
  cached = data
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

/**
 * The role governing an account.
 *
 * An account with no roleId, or one pointing at a role that has since been
 * deleted, resolves to Full Access. The dangling case is defended twice — once
 * here and once by deleteRole() reassigning members — because the failure
 * direction matters: a dangling id that resolved to "no role object" would read
 * as "no restrictions" in permissions.mjs anyway, but only by accident. Making
 * it explicit means a future change to the null handling cannot silently turn a
 * deleted role into an escalation.
 */
export function getRoleForAccount(account) {
  if (!account) return null
  return findRoleById(account.roleId) || findRoleById(DEFAULT_ROLE_ID)
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
 * Delete a role and hand back the members that need reassigning.
 *
 * This function does NOT touch accounts.json — accounts-storage owns that file
 * and importing it here would make two storage modules mutually dependent. The
 * caller (auth.mjs deleteRole) reassigns, and the roles.json write happens
 * FIRST so a crash between the two leaves accounts pointing at a role that no
 * longer exists — which getRoleForAccount already resolves to Full Access —
 * rather than a role that exists but nobody can see.
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
