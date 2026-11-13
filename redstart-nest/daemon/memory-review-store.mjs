'use strict'

// =============================================================================
// Redstart Nest — automatic memory: settings, suggestions, review bookkeeping
// =============================================================================
// projects-plan Phase 3. The reviewer (memory-review.mjs) reads a chat's user
// turns and proposes memories; this module keeps what that needs between
// calls, per account (memoryKey: account id, or '_local' with auth off):
//
//   <config>/memory-review.json
//   { settings:    { "<key>": { mode } },
//     suggestions: { "<key>": [suggestion] },
//     dismissed:   { "<key>": [textHash] },
//     reviewed:    { "<key>": { "<conversationId>": [messageId] } } }
//
// Its own file, not memories.json: the memories are the user's data, and
// this is machinery around them that can be thrown away without losing any.
//
// MODES (plan D17): 'off' — memory as before (the model saves when told,
// /remember); 'suggest' — the default, the user's decision: the reviewer's
// proposals wait for the user to Save or Dismiss; 'auto' — they are saved at
// once and shown with Undo.
// =============================================================================

import * as crypto from 'crypto'
import * as path from 'path'
import { configDir } from './platform-paths.mjs'
import { readJsonOr, writeJsonAtomic } from './json-store.mjs'
import { memoryKey, normalizeText } from './memory-storage.mjs'

export const MODES = ['off', 'suggest', 'auto']
export const DEFAULT_MODE = 'suggest'
export const MAX_SUGGESTIONS_PER_ACCOUNT = 50
export const MAX_DISMISSED_PER_ACCOUNT = 500
export const MAX_REVIEWED_PER_CONVERSATION = 1000
export const MAX_REVIEWED_CONVERSATIONS = 500

function file() { return path.join(configDir(), 'memory-review.json') }
function read() {
  const data = readJsonOr(file(), {})
  for (const k of ['settings', 'suggestions', 'dismissed', 'reviewed']) {
    if (!data[k] || typeof data[k] !== 'object') data[k] = {}
  }
  return data
}
function write(data) { writeJsonAtomic(file(), data) }

/** Case- and space-insensitive, so "Uses vim" and "uses  VIM" are one text. */
export function textHash(text) {
  const norm = String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 32)
}

/**
 * What makes two suggestions the same, and what a dismissal remembers. A
 * forget carries the text it would forget, so it has its own key: dismissing
 * "forget: Works at Acme" must not stop "Works at Acme" being proposed.
 */
export function suggestionKey(s) {
  return s.op === 'forget' ? textHash(`forget:${s.text}`) : textHash(s.text)
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function getSettings(account) {
  const s = read().settings[memoryKey(account)]
  return { mode: MODES.includes(s?.mode) ? s.mode : DEFAULT_MODE }
}

/** @returns {{ ok: true, settings } | { ok: false, error }} */
export function setSettings(account, body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'a JSON object is required' }
  if (!MODES.includes(body.mode)) return { ok: false, error: `mode must be one of ${MODES.join(', ')}` }
  const data = read()
  data.settings[memoryKey(account)] = { mode: body.mode }
  write(data)
  return { ok: true, settings: { mode: body.mode } }
}

// ---------------------------------------------------------------------------
// Suggestions (plan D19)
// ---------------------------------------------------------------------------

/**
 * Newest first. With `conversationId`, only that chat's.
 * A suggestion: { id, op: 'add'|'update'|'forget', text, kind, why?, quote?,
 * scope: 'user'|'project', projectId?, targetId?, previousText?, replaces?,
 * conversationId, createdAt }. A forget's text is the memory it would forget.
 */
export function listSuggestions(account, { conversationId = null } = {}) {
  const list = read().suggestions[memoryKey(account)] || []
  return list
    .filter((s) => !conversationId || s.conversationId === conversationId)
    .sort((a, b) => b.createdAt - a.createdAt)
}

export function getSuggestion(account, id) {
  return (read().suggestions[memoryKey(account)] || []).find((s) => s.id === id) || null
}

/**
 * Store proposals for the user to decide on. Skips one already pending or
 * dismissed (by text), and keeps the newest MAX_SUGGESTIONS_PER_ACCOUNT.
 * The caller has already validated and filtered them (memory-review.mjs).
 *
 * @returns {object[]} the suggestions that were added
 */
export function addSuggestions(account, proposals, { conversationId, now = Date.now() } = {}) {
  const data = read()
  const key = memoryKey(account)
  const list = data.suggestions[key] || []
  const dismissed = new Set(data.dismissed[key] || [])
  const pending = new Set(list.map(suggestionKey))
  const added = []
  for (const p of proposals) {
    const norm = normalizeText(p.text)
    if (norm.error) continue
    const op = p.op === 'update' || p.op === 'forget' ? p.op : 'add'
    const h = suggestionKey({ op, text: norm.text })
    if (dismissed.has(h) || pending.has(h)) continue
    pending.add(h)
    const s = {
      id: crypto.randomUUID(),
      op,
      text: norm.text,
      kind: typeof p.kind === 'string' ? p.kind : 'fact',
      ...(p.why ? { why: p.why } : {}),
      ...(p.quote ? { quote: p.quote } : {}),
      scope: p.scope === 'project' ? 'project' : 'user',
      ...(p.scope === 'project' && p.projectId ? { projectId: p.projectId } : {}),
      ...(op !== 'add' ? { targetId: p.targetId } : {}),
      ...(op === 'update' ? { previousText: p.previousText ?? null } : {}),
      ...(op === 'update' && Array.isArray(p.replaces) && p.replaces.length ? { replaces: [...p.replaces] } : {}),
      conversationId: conversationId ?? null,
      createdAt: now,
    }
    added.push(s)
    list.push(s)
  }
  if (added.length === 0) return []
  list.sort((a, b) => b.createdAt - a.createdAt)
  data.suggestions[key] = list.slice(0, MAX_SUGGESTIONS_PER_ACCOUNT)
  write(data)
  return added.filter((s) => data.suggestions[key].includes(s))
}

/** Remove one (after it was saved, or dismissed). Returns the removed suggestion or null. */
export function takeSuggestion(account, id) {
  const data = read()
  const key = memoryKey(account)
  const list = data.suggestions[key] || []
  const found = list.find((s) => s.id === id)
  if (!found) return null
  data.suggestions[key] = list.filter((s) => s.id !== id)
  write(data)
  return found
}

/** Dismiss: remove it and remember the text, so it is not proposed again. */
export function dismissSuggestion(account, id) {
  const data = read()
  const key = memoryKey(account)
  const list = data.suggestions[key] || []
  const found = list.find((s) => s.id === id)
  if (!found) return false
  data.suggestions[key] = list.filter((s) => s.id !== id)
  const dismissed = data.dismissed[key] || []
  dismissed.push(suggestionKey(found))
  data.dismissed[key] = dismissed.slice(-MAX_DISMISSED_PER_ACCOUNT)
  write(data)
  return true
}

export function isDismissed(account, text) {
  return (read().dismissed[memoryKey(account)] || []).includes(textHash(text))
}

/** A deleted conversation's or project's pending suggestions go with it. */
export function dropSuggestions(account, predicate) {
  const data = read()
  const key = memoryKey(account)
  const list = data.suggestions[key] || []
  const next = list.filter((s) => !predicate(s))
  if (next.length === list.length) return 0
  data.suggestions[key] = next
  write(data)
  return list.length - next.length
}

// ---------------------------------------------------------------------------
// Which user messages have been reviewed (plan D15: each once)
// ---------------------------------------------------------------------------

export function reviewedIds(account, conversationId) {
  return new Set(read().reviewed[memoryKey(account)]?.[conversationId] || [])
}

export function markReviewed(account, conversationId, messageIds) {
  if (!conversationId || messageIds.length === 0) return
  const data = read()
  const key = memoryKey(account)
  const perAccount = data.reviewed[key] || {}
  const ids = [...(perAccount[conversationId] || []), ...messageIds]
  // Re-inserted, so this conversation becomes the most recent and the trim
  // below drops the ones reviewed longest ago.
  delete perAccount[conversationId]
  perAccount[conversationId] = [...new Set(ids)].slice(-MAX_REVIEWED_PER_CONVERSATION)
  // Bounded: forget the oldest conversations' bookkeeping first (insertion order).
  const convs = Object.keys(perAccount)
  for (const c of convs.slice(0, Math.max(0, convs.length - MAX_REVIEWED_CONVERSATIONS))) delete perAccount[c]
  data.reviewed[key] = perAccount
  write(data)
}
