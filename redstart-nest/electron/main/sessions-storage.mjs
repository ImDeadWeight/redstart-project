'use strict'

// =============================================================================
// Redstart Nest — Session storage
// =============================================================================
// Sessions used to be a plain in-memory Map. Invisible today, because the window
// and the runtime die together — and Phase 7 exists to break exactly that
// coupling, so "stay logged in" would stop working at the moment it starts
// mattering (headless-admin-plane-plan.md §3.7). Persisted from the start
// instead: the storage pattern already exists next door in accounts-storage.mjs,
// so doing it properly is barely more work than doing it temporarily.
//
// HASHED AT REST, and for the same reason API keys are. A session string IS
// being logged in for the life of the session, so a readable sessions.json would
// mean anyone who reads that file becomes every logged-in user. SHA-256 rather
// than scrypt is the correct call here and the reasoning is already written out
// at hashApiKey() in auth.mjs: 32 CSPRNG bytes need no slow KDF, and the hash
// must stay deterministic and salt-free so a presented token resolves in one
// hash rather than one scrypt run per stored session.
//
// WRITE AMPLIFICATION IS THE REASON FOR THE CACHE. Expiry is sliding, so a naive
// persist-on-touch would write this file on every single authenticated request —
// accounts.json is read per request but never written, and matching that read
// pattern with a write pattern would be a new and needless disk cost. So the
// records live in a Map that is loaded once and flushed on the events that
// matter (create, revoke, prune) plus a THROTTLED slide: an expiry that has
// moved less than SLIDE_PERSIST_MS since it was last written is left in memory.
// The cost of that choice is bounded and stated: a hard-killed daemon can lose
// up to SLIDE_PERSIST_MS of sliding, which shortens a session and never extends
// one. Failing in the direction of "log in again" is the right direction.
//
// Single-writer, like every other JSON file here (see json-store.mjs). If state
// ever moves out of process, that module is where locking would go.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import { configDir } from './platform-paths.mjs'
import { readJsonOr, writeJsonAtomic } from './json-store.mjs'

/** How far an expiry may drift in memory before the slide is written down. */
const SLIDE_PERSIST_MS = 60 * 60 * 1000 // 1 hour

function getPath() {
  return path.join(configDir(), 'sessions.json')
}

function defaults() {
  return { sessions: [] }
}

// tokenHash -> { tokenHash, accountId, username, plane, expiresAt, createdAt }
// plus `persisted`, the expiry as last written, which is memory-only.
let cache = null

function isRecord(record) {
  return (
    record && typeof record === 'object' &&
    typeof record.tokenHash === 'string' && record.tokenHash &&
    typeof record.accountId === 'string' && record.accountId &&
    typeof record.expiresAt === 'number'
  )
}

function load() {
  if (cache) return cache
  cache = new Map()
  const p = getPath()
  if (!fs.existsSync(p)) return cache

  // readJsonOr, like accounts.json: a torn file reading as "no sessions" is
  // survivable (everyone logs in again) but the .corrupt copy it leaves behind
  // is what makes the incident explicable rather than mysterious.
  const data = readJsonOr(p, defaults())
  const now = Date.now()
  for (const record of Array.isArray(data?.sessions) ? data.sessions : []) {
    // Expired records are dropped at load rather than carried and filtered
    // forever — this is the only moment the whole set is in hand.
    if (!isRecord(record) || record.expiresAt <= now) continue
    cache.set(record.tokenHash, { ...record, persisted: record.expiresAt })
  }
  return cache
}

function flush() {
  const sessions = []
  for (const record of load().values()) {
    const { persisted, ...stored } = record
    sessions.push(stored)
    record.persisted = record.expiresAt
  }
  writeJsonAtomic(getPath(), { sessions })
}

/**
 * Store a new session.
 * @param {{tokenHash: string, accountId: string, username: string, plane: string, expiresAt: number}} record
 */
export function insertSession(record) {
  load().set(record.tokenHash, { ...record, createdAt: Date.now(), persisted: record.expiresAt })
  flush()
  return record
}

/** The live session for this token hash, or null. Expired records are reaped. */
export function findByTokenHash(tokenHash) {
  const sessions = load()
  const record = sessions.get(tokenHash)
  if (!record) return null
  if (record.expiresAt <= Date.now()) {
    sessions.delete(tokenHash)
    flush()
    return null
  }
  return record
}

/**
 * Slide a session's expiry forward.
 *
 * Written down only once the drift exceeds SLIDE_PERSIST_MS — see the module
 * header for why this file must not be written on every request.
 */
export function touchSession(tokenHash, expiresAt) {
  const record = load().get(tokenHash)
  if (!record) return
  record.expiresAt = expiresAt
  if (expiresAt - record.persisted >= SLIDE_PERSIST_MS) flush()
}

export function deleteByTokenHash(tokenHash) {
  if (!load().delete(tokenHash)) return false
  flush()
  return true
}

/** Revoke every session an account holds — password reset, delete, disable. */
export function deleteForAccount(accountId) {
  const sessions = load()
  let removed = 0
  for (const [tokenHash, record] of sessions) {
    if (record.accountId === accountId) {
      sessions.delete(tokenHash)
      removed++
    }
  }
  if (removed) flush()
  return removed
}

/** Every live session, for the accounts panel and for tests. Never the hashes. */
export function listSessions() {
  return [...load().values()].map(({ tokenHash, persisted, ...safe }) => safe)
}

/**
 * Drop the in-memory cache so the next read comes off disk.
 *
 * The seam a test uses to prove a session actually SURVIVED a restart rather
 * than merely being remembered — which is the whole property this module
 * exists for, and is otherwise unobservable in one process.
 */
export function reloadSessions() {
  cache = null
}
