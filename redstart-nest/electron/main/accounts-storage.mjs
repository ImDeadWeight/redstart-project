'use strict'

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

function getPath() {
  return path.join(app.getPath('userData'), 'accounts.json')
}

function defaults() {
  return { authRequired: false, accounts: [] }
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
  }
}

function read() {
  const p = getPath()
  if (!fs.existsSync(p)) return defaults()
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (!Array.isArray(data.accounts)) data.accounts = []
    if (typeof data.authRequired !== 'boolean') data.authRequired = false

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

function write(data) {
  fs.writeFileSync(getPath(), JSON.stringify(data, null, 2), 'utf8')
}

function stripSecrets(account) {
  const { passwordHash, passwordSalt, apiKeyHash, ...safe } = account
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
