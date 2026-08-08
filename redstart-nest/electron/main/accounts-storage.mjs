'use strict'

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

function getPath() {
  return path.join(app.getPath('userData'), 'accounts.json')
}

export function defaults() {
  return { authRequired: true, accounts: [] }
}

// Normalizes fields that may be absent on records written before they
// existed — in-memory only, not persisted, so this doesn't add a write to
// the hot read path (accounts.json is read on every gateway/MCP request).
function normalizeAccount(a) {
  return {
    ...a,
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
  if (!fs.existsSync(p)) return defaults()
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (!Array.isArray(data.accounts)) data.accounts = []
    if (typeof data.authRequired !== 'boolean') data.authRequired = true

    data.accounts = data.accounts.map(normalizeAccount)

    // One-time migration for pre-three-tier installs, which only ever wrote
    // role: 'admin' | 'user'. Promote the existing admin(s) to 'owner' so
    // nobody loses access they already had — only runs while no owner
    // exists yet, and is idempotent (never touches a file that already has one).
    if (!data.accounts.some(a => a.role === 'owner')) {
      let migrated = false
      for (const a of data.accounts) {
        if (a.role === 'admin') { a.role = 'owner'; migrated = true }
      }
      if (migrated) write(data)
    }

    return data
  } catch { return defaults() }
}

export function write(data) {
  fs.writeFileSync(getPath(), JSON.stringify(data, null, 2), 'utf8')
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
  return read().accounts.some(a => a.role === 'owner')
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
