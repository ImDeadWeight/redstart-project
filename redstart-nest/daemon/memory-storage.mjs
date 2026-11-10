'use strict'

// =============================================================================
// Redstart Nest — per-account memory (chat-tooling Phase 3)
// =============================================================================
// Durable facts a user asked the assistant to remember ("uses Postgres 16",
// "writes in British English"). One JSON file, keyed by account, through
// json-store's atomic writes. Small by design: JSON is right at this size, and
// the caps below keep it that way.
//
//   <config>/memories.json
//   { accounts: { "<scope>": [ { id, text, createdAt, updatedAt,
//                                source: { conversationId }, fromWebTurn } ] } }
//
// The key is the account id, or '_local' with auth off. With auth off every
// caller shares one memory, the same posture as the anonymous file scope,
// stated in security.md.
//
// MEMORIES ARE DATA, NOT INSTRUCTIONS. That framing is the prompt block's job
// (system-prompt.mjs), and the persisted-injection risk is why each entry
// records whether it was saved in a turn that had read the web (fromWebTurn):
// the UI badges those.
// =============================================================================

import * as crypto from 'crypto'
import * as path from 'path'
import { configDir } from './platform-paths.mjs'
import { readJsonOr, writeJsonAtomic } from './json-store.mjs'

export const MAX_MEMORY_CHARS = 500
export const MAX_MEMORIES_PER_ACCOUNT = 200
export const ANONYMOUS_KEY = '_local'

function file() { return path.join(configDir(), 'memories.json') }
function read() {
  const data = readJsonOr(file(), { accounts: {} })
  if (!data.accounts || typeof data.accounts !== 'object') data.accounts = {}
  return data
}
function write(data) { writeJsonAtomic(file(), data) }

/** The storage key for an account: its id, or the shared auth-off key. */
export function memoryKey(account) {
  if (account === null || account === undefined) return ANONYMOUS_KEY
  const id = typeof account.id === 'string' ? account.id.trim() : ''
  // Same rule as user-scope.mjs: an account with no id is a broken invariant,
  // and must not fall into the shared auth-off bucket.
  if (!id) throw new Error('Cannot resolve a memory scope: the account has no id')
  return id
}

/** Collapse whitespace and refuse what a memory is not. */
export function normalizeText(text) {
  if (typeof text !== 'string') return { error: 'text must be a string' }
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t) return { error: 'text is empty' }
  if (t.length > MAX_MEMORY_CHARS) return { error: `a memory is at most ${MAX_MEMORY_CHARS} characters; this is ${t.length}. Save the durable fact, not the conversation.` }
  return { text: t }
}

/**
 * The storage key for one memory scope: the account's own memories, or one of
 * its projects' (projects-plan D13), `<account key>#project:<id>`. The '#'
 * cannot occur in an account id or in '_local', so the two never collide.
 *
 * THE CALLER VERIFIES THE PROJECT. This module trusts `projectId` the way it
 * trusts `account`: routes and tools pass only an id that getProject()
 * returned for this account, never a raw client value.
 */
export function scopeKey(account, projectId = null) {
  const base = memoryKey(account)
  if (projectId === null || projectId === undefined) return base
  if (typeof projectId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(projectId)) {
    throw new Error('Cannot resolve a memory scope: malformed project id')
  }
  return `${base}#project:${projectId}`
}

/** Newest first. */
export function listMemories(account, { projectId = null } = {}) {
  const list = read().accounts[scopeKey(account, projectId)] || []
  return [...list].sort((a, b) => b.createdAt - a.createdAt)
}

export function getMemory(account, id, { projectId = null } = {}) {
  return (read().accounts[scopeKey(account, projectId)] || []).find((m) => m.id === id) || null
}

/**
 * Save a memory. An exact duplicate (case-insensitive) is not stored twice:
 * the existing entry is returned with `duplicate: true`.
 *
 * @returns {{ ok: true, memory: object, duplicate?: boolean } | { ok: false, error: string }}
 */
export function saveMemory(account, text, { conversationId = null, fromWebTurn = false, projectId = null, via = null, now = Date.now() } = {}) {
  const norm = normalizeText(text)
  if (norm.error) return { ok: false, error: norm.error }
  const data = read()
  const key = scopeKey(account, projectId)
  const list = data.accounts[key] || []
  const existing = list.find((m) => m.text.toLowerCase() === norm.text.toLowerCase())
  if (existing) return { ok: true, memory: existing, duplicate: true }
  if (list.length >= MAX_MEMORIES_PER_ACCOUNT) {
    return { ok: false, error: `This account already has ${MAX_MEMORIES_PER_ACCOUNT} memories, the limit. Ask the user which to forget (memory_forget), or they can remove some under Settings → Memory.` }
  }
  const memory = {
    id: crypto.randomUUID(),
    text: norm.text,
    createdAt: now,
    updatedAt: now,
    source: { conversationId: conversationId || null },
    fromWebTurn: fromWebTurn === true,
    // How it got here when not by memory_save or the user: 'review' is the
    // automatic memory pass (memory-review.mjs). Shown, never trusted.
    ...(via ? { via } : {}),
  }
  data.accounts[key] = [...list, memory]
  write(data)
  return { ok: true, memory }
}

/** Edit by the user (Settings). A user edit clears the web badge: they have now read it. */
export function updateMemory(account, id, text, { projectId = null, now = Date.now() } = {}) {
  const norm = normalizeText(text)
  if (norm.error) return { ok: false, error: norm.error }
  const data = read()
  const key = scopeKey(account, projectId)
  const list = data.accounts[key] || []
  const idx = list.findIndex((m) => m.id === id)
  if (idx === -1) return { ok: false, error: 'not found' }
  list[idx] = { ...list[idx], text: norm.text, updatedAt: now, fromWebTurn: false }
  data.accounts[key] = list
  write(data)
  return { ok: true, memory: list[idx] }
}

export function deleteMemory(account, id, { projectId = null } = {}) {
  const data = read()
  const key = scopeKey(account, projectId)
  const list = data.accounts[key] || []
  const next = list.filter((m) => m.id !== id)
  if (next.length === list.length) return false
  data.accounts[key] = next
  write(data)
  return true
}

/** A deleted project's memories go with it (plan D13). Returns how many. */
export function deleteProjectMemories(account, projectId) {
  const data = read()
  const key = scopeKey(account, projectId)
  const count = (data.accounts[key] || []).length
  if (!(key in data.accounts)) return 0
  delete data.accounts[key]
  write(data)
  return count
}

// ---------------------------------------------------------------------------
// Search: keyword always; embeddings when the sidecar is up (never load-bearing)
// ---------------------------------------------------------------------------

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'are', 'for', 'on', 'with', 'what', 'does', 'do', 'my', 'i', 'me', 'user', 'uses', 'use'])

function tokens(s) {
  return String(s).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t))
}

/** Pure keyword score: the share of query terms a memory contains (prefix match). */
export function keywordScore(query, text) {
  const q = [...new Set(tokens(query))]
  if (!q.length) return 0
  const words = tokens(text)
  let hit = 0
  for (const t of q) if (words.some((w) => w === t || (t.length >= 4 && w.startsWith(t)))) hit++
  return hit / q.length
}

/**
 * Rank memories against a query.
 *
 * @param {object[]} memories
 * @param {string} query
 * @param {{ embed?: (texts: string[]) => Promise<Float32Array[]|null>, limit?: number }} [opts]
 *   `embed` is embed-server's embedTexts, which never throws and returns null
 *   when the sidecar is down; then this is keyword-only.
 */
export async function searchMemories(memories, query, { embed, limit = 10 } = {}) {
  if (!memories.length || typeof query !== 'string' || !query.trim()) return []
  let semantic = null
  if (embed) {
    const vectors = await embed([query, ...memories.map((m) => m.text)])
    if (Array.isArray(vectors) && vectors.length === memories.length + 1) {
      const [qv, ...mv] = vectors
      semantic = mv.map((v) => cosineSimilarity(qv, v))
    }
  }
  const scored = memories.map((m, i) => {
    const kw = keywordScore(query, m.text)
    const sem = semantic ? semantic[i] : 0
    // Keyword hits are exact evidence; semantic similarity only ranks, and
    // only counts above a floor bge-small clears for related short texts.
    const score = Math.max(kw, semantic && sem > 0.55 ? sem : 0)
    return { memory: m, score }
  })
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit)
}

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

// ---------------------------------------------------------------------------
// The prompt block's selection: newest first, within a character budget
// ---------------------------------------------------------------------------

export const DEFAULT_PROMPT_BUDGET_CHARS = 1200   // ≈ 300 tokens (plan §3)

/**
 * The memories that fit the budget, newest first, plus how many did not.
 * Pure over its input.
 */
export function selectForPrompt(memories, budgetChars = DEFAULT_PROMPT_BUDGET_CHARS) {
  const chosen = []
  let used = 0
  for (const m of memories) {
    const cost = m.text.length + 3
    if (used + cost > budgetChars) break
    chosen.push(m)
    used += cost
  }
  return { chosen, omitted: memories.length - chosen.length }
}

/**
 * The composer's memory input for one request. Gated on the NARROWED config,
 * so a role that withholds `memory` withholds the block too, and not on the
 * tools in the request: retrieval dropping memory_save this turn must not make
 * what is remembered vanish. Used by the completions path and the admin preview.
 */
export function memoriesFor(config, account, { projectId = null } = {}) {
  if (!config?.memory?.enabled) return {}
  try {
    const { chosen, omitted } = selectForPrompt(listMemories(account), config.memory.promptBudgetChars)
    const out = { memories: chosen, memoriesOmitted: omitted }
    // A project chat also carries the project's own memories (plan D13), on
    // their own budget so a busy project cannot crowd out who the user is.
    // projectId is one the caller already verified (getProject).
    if (projectId) {
      const p = selectForPrompt(listMemories(account, { projectId }), config.memory.promptBudgetChars)
      out.projectMemories = p.chosen
      out.projectMemoriesOmitted = p.omitted
    }
    return out
  } catch {
    return {} // a malformed account gets no memories rather than someone else's
  }
}
