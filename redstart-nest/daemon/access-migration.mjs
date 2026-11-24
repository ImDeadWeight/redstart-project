'use strict'

// =============================================================================
// Redstart Nest — one-time migration to additive roles (2026-11-24)
// =============================================================================
// Before: every account had a hardcoded TIER (owner / admin / user) and at most
// one ROLE, and a role was a RESTRICTION — an absent field inherited
// everything, and no role at all meant Full Access. Admin rights came from the
// tier, and a role's `admin` block could only take some of them away.
//
// After: roles are GRANTS (permissions.mjs combineRoles), an account holds a
// list of them (`roleIds`), and administration is a set of permissions roles
// grant. Only the owner keeps a tier.
//
// THE PROMISE: every account can reach exactly what it reached before. So:
//
//   - each user-defined role is rewritten field by field into its grant form
//     (toAdditive below), with its `admin` block removed — a role used to give
//     admin rights only to admin-TIER members, so it cannot carry them now;
//   - a user-tier account keeps its role, or gets Full Access if it had none;
//   - an admin-tier account with no role gets Administrator;
//   - an admin-tier account with role X gets a derived role "X (administration)"
//     — X's grants plus exactly the admin permissions X left it — shared by
//     every admin on X. If X left it none, it simply gets X.
//
// CRASH SAFETY. accounts.json is written first, with each account's old tier
// and roleId kept under `migratedFrom`; roles.json is written last and its
// `version: 2` is the "done" mark. A crash between the two re-runs the whole
// migration from `migratedFrom`, which gives the same answer (derived role ids
// are deterministic). Downgrading Nest after this has run is not supported.
//
// This module reads and writes the two files directly and imports neither
// storage module, so either can call it without a cycle.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import { configDir } from './platform-paths.mjs'
import { readJsonOr, writeJsonAtomic } from './json-store.mjs'

const OLD_ADMIN_PERMISSIONS = ['manageAccounts', 'manageRoles', 'managePromptBlocks', 'manageOrgWorkflows']

const absent = (v) => v === null || v === undefined

/** A version-1 (restriction) permission set rewritten as version-2 grants. */
export function toAdditive(old) {
  const p = old || {}
  const out = {
    capabilities: absent(p.capabilities) ? null : [...p.capabilities],
    webSourceIds: absent(p.webSourceIds) ? null : [...p.webSourceIds],
    allowWebSearchEngine: p.allowWebSearchEngine !== false,
    allowWhitelistBypass: p.allowWhitelistBypass !== false,
    fileSystem: {
      allowWrite: p.fileSystem?.allowWrite !== false,
      allowDestructive: p.fileSystem?.allowDestructive !== false,
    },
  }
  // Absent grants meant "every folder", which is what absent means now too.
  if (p.grants && typeof p.grants === 'object') out.grants = JSON.parse(JSON.stringify(p.grants))
  if (typeof p.maxFetchTokens === 'number') out.maxFetchTokens = p.maxFetchTokens
  if (!absent(p.surfaces)) out.surfaces = [...p.surfaces]
  return out
}

/** The admin permissions a version-1 role left an admin-tier member. */
function adminLeft(oldPermissions) {
  const block = oldPermissions?.admin
  if (absent(block)) return [...OLD_ADMIN_PERMISSIONS]
  return OLD_ADMIN_PERMISSIONS.filter(k => block[k] === true)
}

// The version-1 built-ins, as they were, so accounts on them migrate exactly.
const V1_BUILTINS = {
  'full-access': { name: 'Full Access', permissions: {} },
  restricted: {
    name: 'Restricted',
    permissions: {
      capabilities: [],
      fileSystem: { allowWrite: false, allowDestructive: false },
      allowWhitelistBypass: false,
      allowWebSearchEngine: false,
      admin: {},
    },
  },
}

/**
 * Migrate a config directory if it has not been. Idempotent and cheap once
 * done (one stat and one small read per process per directory).
 *
 * @returns {{ migrated: boolean, accounts?: number, derivedRoles?: number }}
 */
const done = new Set()

export function ensureAccessModel(dir = configDir()) {
  if (done.has(dir)) return { migrated: false }
  const rolesPath = path.join(dir, 'roles.json')
  const accountsPath = path.join(dir, 'accounts.json')

  const rolesFile = readJsonOr(rolesPath, { roles: [] })
  if (rolesFile.version >= 2) { done.add(dir); return { migrated: false } }
  if (!fs.existsSync(accountsPath) && !fs.existsSync(rolesPath)) {
    // A fresh install has nothing to migrate. Nothing is written either, so a
    // read never creates files; the first real write stamps version 2.
    done.add(dir)
    return { migrated: false }
  }

  const accountsFile = readJsonOr(accountsPath, { authRequired: true, accounts: [] })
  const accountsList = Array.isArray(accountsFile.accounts) ? accountsFile.accounts : []
  const oldRoles = Array.isArray(rolesFile.roles) ? rolesFile.roles : []
  const oldById = new Map(oldRoles.map(r => [r.id, r]))
  for (const [id, r] of Object.entries(V1_BUILTINS)) if (!oldById.has(id)) oldById.set(id, { id, ...r })

  // The pre-three-tier promotion (accounts-storage.mjs) must come first, or an
  // old install's only admin would become an Administrator instead of Owner.
  const tierOf = (a) => a.migratedFrom?.tier ?? a.tier ?? a.role ?? 'user'
  if (!accountsList.some(a => tierOf(a) === 'owner')) {
    for (const a of accountsList) if (tierOf(a) === 'admin') { a.tier = 'owner'; a.role = 'owner'; if (a.migratedFrom) a.migratedFrom.tier = 'owner' }
  }

  // User-defined roles, rewritten. Built-in ids are left to the code.
  const newRoles = oldRoles
    .filter(r => !V1_BUILTINS[r.id] && r.id !== 'administrator')
    .map(r => ({ ...r, permissions: toAdditive(r.permissions), builtIn: false }))
  const derived = new Map()

  for (const a of accountsList) {
    // Already in the new shape and never migrated: made by this version (a
    // fresh install whose roles.json was never written). Leave it alone.
    if (Array.isArray(a.roleIds) && !a.migratedFrom) continue
    const from = a.migratedFrom ?? { tier: a.tier ?? a.role ?? 'user', roleId: a.roleId ?? null }
    a.migratedFrom = from
    if (from.tier === 'owner') { a.tier = 'owner'; a.role = 'owner'; a.roleIds = []; continue }
    // A dangling id resolved to Full Access before; it does now too.
    const old = oldById.get(from.roleId) ?? oldById.get('full-access')
    let roleIds
    if (from.tier === 'admin') {
      const left = adminLeft(old.permissions)
      if (old.id === 'full-access' && left.length === OLD_ADMIN_PERMISSIONS.length) {
        // Administrator also carries manageProjects, which did not exist before.
        // An unrestricted admin could already reach every account's data by
        // other means; projects are the one new thing, and an admin is who an
        // owner would expect to manage them.
        roleIds = ['administrator']
      } else if (left.length === 0) {
        roleIds = [old.id]
      } else {
        const id = `${old.id}--admin`
        if (!derived.has(id)) {
          derived.set(id, {
            id,
            name: `${old.name} (administration)`.slice(0, 64),
            description: `Made when roles became additive: ${old.name}, plus the administration its admin members had.`.slice(0, 280),
            permissions: { ...toAdditive(old.permissions), admin: Object.fromEntries(left.map(k => [k, true])) },
            builtIn: false,
          })
        }
        roleIds = [id]
      }
    } else {
      roleIds = [old.id]
    }
    a.roleIds = roleIds
    a.tier = 'member'
    a.role = 'member'
    delete a.roleId
  }

  const now = new Date().toISOString()
  for (const r of derived.values()) newRoles.push({ ...r, createdAt: now, updatedAt: now })

  if (fs.existsSync(accountsPath)) writeJsonAtomic(accountsPath, { ...accountsFile, accounts: accountsList })
  writeJsonAtomic(rolesPath, { ...rolesFile, version: 2, roles: newRoles })
  done.add(dir)
  return { migrated: true, accounts: accountsList.length, derivedRoles: derived.size }
}

/** For tests that rewrite a directory's files and need the check to run again. */
export function forgetMigration(dir) { done.delete(dir) }
