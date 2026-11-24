'use strict'

import * as fs from 'fs'
import * as path from 'path'
import { configDir } from './platform-paths.mjs'
import { readJsonOr, writeJsonAtomic } from './json-store.mjs'
import { ensureAccessModel } from './access-migration.mjs'

function getPath() {
  return path.join(configDir(), 'accounts.json')
}

export function defaults() {
  return { authRequired: true, accounts: [] }
}

// Normalizes fields that may be absent on records written before they
// existed — in-memory only, not persisted, so this doesn't add a write to
// the hot read path (accounts.json is read on every gateway/MCP request).
function normalizeAccount(a) {
  // Only the owner has a tier now (access-migration.mjs). Everyone else is a
  // member whose rights come from roles. `role` mirrors the tier for old
  // clients; auth.mjs toPublicAccount replaces it with 'admin' or 'user' from
  // the account's actual permissions, which is what those clients mean by it.
  //
  // A record still in the old shape (no roleIds — written by hand, by an old
  // tool, or by a test fixture) is read the way the migration would have
  // converted it, minus the derived "(administration)" roles: an old admin
  // reads as an Administrator, anyone else as their role or Full Access.
  const legacy = !Array.isArray(a.roleIds)
  const oldTier = a.tier ?? a.role ?? 'user'
  const tier = (legacy ? oldTier : a.tier) === 'owner' ? 'owner' : 'member'
  const roleIds = !legacy ? a.roleIds.filter(x => typeof x === 'string')
    : tier === 'owner' ? []
    : oldTier === 'admin' ? ['administrator']
    : [typeof a.roleId === 'string' && a.roleId ? a.roleId : 'full-access']
  return {
    ...a,
    tier,
    role: tier,
    // The roles this account holds directly; its groups add more.
    roleIds,
    status: a.status === 'disabled' ? 'disabled' : 'active',
    createdBy: a.createdBy ?? null,
    lastLoginAt: a.lastLoginAt ?? null,
    // Per-connector credentials (system-prompt spec §8). Each entry binds a
    // key to one surface, so the server derives which app is calling from the
    // credential rather than believing a header.
    clientKeys: Array.isArray(a.clientKeys) ? a.clientKeys : [],
  }
}

export function read() {
  const p = getPath()
  ensureAccessModel()
  if (!fs.existsSync(p)) return defaults()
  try {
    // readJsonOr rather than a bare parse: a torn or corrupt accounts.json
    // would otherwise read as "no accounts", and since login is required by
    // default and owner bootstrap is launcher-only, that silently locks every
    // client out of the appliance. The .corrupt copy it leaves behind is the
    // difference between a recoverable incident and a vanished Owner record.
    const data = readJsonOr(p, defaults())
    if (!Array.isArray(data.accounts)) data.accounts = []
    if (typeof data.authRequired !== 'boolean') data.authRequired = true

    data.accounts = data.accounts.map(normalizeAccount)

    // The pre-three-tier owner promotion now runs inside ensureAccessModel().
    return data
  } catch { return defaults() }
}

export function write(data) {
  writeJsonAtomic(getPath(), data)
}

function stripSecrets(account) {
  const { passwordHash, passwordSalt, apiKeyHash, clientKeys, ...safe } = account
  // clientKeys carries a keyHash per entry. Destructuring the array out is not
  // enough — the metadata is genuinely useful to show ("Blueprints key, issued
  // March 4"), so it is rebuilt without the hash rather than dropped.
  safe.clientKeys = (Array.isArray(clientKeys) ? clientKeys : []).map(
    ({ keyHash, ...publicFields }) => publicFields
  )
  return safe
}

export function getAuthRequired() {
  return read().authRequired
}

export function setAuthRequired(required) {
  const data = read()
  data.authRequired = !!required
  write(data)
  return data.authRequired
}

export function listAccounts() {
  return read().accounts.map(stripSecrets)
}

export function findByUsername(username) {
  const needle = username.toLowerCase()
  return read().accounts.find(a => a.username.toLowerCase() === needle) || null
}

export function findById(id) {
  return read().accounts.find(a => a.id === id) || null
}

export function findByApiKeyHash(apiKeyHash) {
  return read().accounts.find(a => a.apiKeyHash === apiKeyHash) || null
}

/**
 * Resolve a per-connector credential (spec §8) to its account AND the surface
 * it was issued for. Returning both together is the point: surface must come
 * from the credential, never from a header a client can set.
 *
 * @returns {{ account: object, clientKey: object } | null}
 */
export function findByClientKeyHash(keyHash) {
  for (const account of read().accounts) {
    const clientKey = (account.clientKeys || []).find(k => k.keyHash === keyHash)
    if (clientKey) return { account, clientKey }
  }
  return null
}

export function hasOwner() {
  return read().accounts.some(a => a.tier === 'owner')
}

/** Drop a role from every account (the role was deleted). */
export function removeRoleEverywhere(roleId) {
  const data = read()
  let changed = 0
  for (const a of data.accounts) {
    if (a.roleIds.includes(roleId)) { a.roleIds = a.roleIds.filter(id => id !== roleId); changed++ }
  }
  if (changed) write(data)
  return changed
}

export function insertAccount(account) {
  const data = read()
  data.accounts.push(account)
  write(data)
  return stripSecrets(account)
}

export function updateAccount(id, patch) {
  const data = read()
  const idx = data.accounts.findIndex(a => a.id === id)
  if (idx === -1) return null
  data.accounts[idx] = { ...data.accounts[idx], ...patch, updatedAt: new Date().toISOString() }
  write(data)
  return stripSecrets(data.accounts[idx])
}

export function deleteAccount(id) {
  const data = read()
  const before = data.accounts.length
  data.accounts = data.accounts.filter(a => a.id !== id)
  write(data)
  return data.accounts.length < before
}
