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
//                                source: { conversationId }, fromWebTurn,
//                                kind, why?, asOf? (state only), via? } ] } }
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

// ---------------------------------------------------------------------------
// Kinds (agent-runtime plan Phase 8, D35)
// ---------------------------------------------------------------------------
//   fact      about the user or their work ("Uses Postgres 16")
//   guidance  how the user wants the assistant to work, with why ("Wants the
//             test command shown before it runs. Why: twice ran the wrong
//             suite"). Only the user's own words make one (D37): memory_save
//             refuses it.
//   state     where ongoing work stands ("Import migrated; export next"),
//             dated by asOf, which the SERVER sets, never the caller.
// A record saved before kinds existed reads as `fact` (filled on read, never
// written back), so nothing is migrated.

export const MEMORY_KINDS = Object.freeze(['fact', 'guidance', 'state'])
export const MAX_WHY_CHARS = 300

/** The day a state memory describes, from the server's clock. */
export function asOfDate(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10)
}

/**
 * Text, kind and why, normalized and checked. `kind` and `why` are optional:
 * undefined means "not given". A blank why is null (no reason).
 *
 * @returns {{ text: string, kind: string | undefined, why: string | null | undefined } | { error: string }}
 */
export function normalizeMemoryInput({ text, kind, why } = {}) {
  const norm = normalizeText(text)
  if (norm.error) return norm
  if (kind !== undefined && kind !== null && !MEMORY_KINDS.includes(kind)) {
    return { error: `kind must be one of ${MEMORY_KINDS.join(', ')}` }
  }
  let w
  if (why === null || why === '') w = null
  else if (why !== undefined) {
    if (typeof why !== 'string') return { error: 'why must be a string' }
    w = why.replace(/\s+/g, ' ').trim() || null
    if (w && w.length > MAX_WHY_CHARS) return { error: `a reason is at most ${MAX_WHY_CHARS} characters; this is ${w.length}` }
  }
  return { text: norm.text, kind: kind ?? undefined, why: w }
}

/** A stored record as callers see it: an old record's missing kind is `fact`. */
function withKind(m) {
  return m && !m.kind ? { ...m, kind: 'fact' } : m
}

/** kind, why and asOf for a record, from what is being saved. asOf only on state. */
function kindFields(kind, why, now) {
  const out = { kind }
  if (why) out.why = why
  if (kind === 'state') out.asOf = asOfDate(now)
  return out
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

/** Newest first. Every record carries a kind (old ones read as `fact`). */
export function listMemories(account, { projectId = null } = {}) {
  const list = read().accounts[scopeKey(account, projectId)] || []
  return [...list].sort((a, b) => b.createdAt - a.createdAt).map(withKind)
}

export function getMemory(account, id, { projectId = null } = {}) {
  return withKind((read().accounts[scopeKey(account, projectId)] || []).find((m) => m.id === id) || null)
}

/**
 * Save a memory. An exact duplicate (case-insensitive) is not stored twice:
 * the existing entry is returned with `duplicate: true`.
 *
 * `kind` defaults to fact; `why` is optional; a state memory is dated (asOf)
 * by the server's clock. A caller's asOf is never read.
 *
 * @returns {{ ok: true, memory: object, duplicate?: boolean } | { ok: false, error: string }}
 */
export function saveMemory(account, text, { conversationId = null, fromWebTurn = false, projectId = null, via = null, kind, why, now = Date.now() } = {}) {
  const norm = normalizeMemoryInput({ text, kind, why })
  if (norm.error) return { ok: false, error: norm.error }
  const data = read()
  const key = scopeKey(account, projectId)
  const list = data.accounts[key] || []
  const existing = list.find((m) => m.text.toLowerCase() === norm.text.toLowerCase())
  if (existing) return { ok: true, memory: withKind(existing), duplicate: true }
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
    ...kindFields(norm.kind ?? 'fact', norm.why, now),
  }
  data.accounts[key] = [...list, memory]
  write(data)
  return { ok: true, memory }
}

/**
 * Edit (Settings, an accepted review). A user edit clears the web badge: they
 * have now read it. `kind` and `why` left undefined keep what the memory had;
 * `why: null` (or '') clears the reason. A state memory's asOf moves to today
 * whenever it is edited (its text now describes today); another kind has none.
 */
export function updateMemory(account, id, text, { projectId = null, kind, why, now = Date.now() } = {}) {
  const norm = normalizeMemoryInput({ text, kind, why })
  if (norm.error) return { ok: false, error: norm.error }
  const data = read()
  const key = scopeKey(account, projectId)
  const list = data.accounts[key] || []
  const idx = list.findIndex((m) => m.id === id)
  if (idx === -1) return { ok: false, error: 'not found' }
  const before = list[idx]
  const nextKind = norm.kind ?? before.kind ?? 'fact'
  const nextWhy = norm.why === undefined ? (before.why ?? null) : norm.why
  const { why: _w, asOf: _a, kind: _k, ...rest } = before
  list[idx] = { ...rest, text: norm.text, updatedAt: now, fromWebTurn: false, ...kindFields(nextKind, nextWhy, now) }
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

/** Content words (lower case, stop words and 1-letter words dropped). memory-review's citation check shares it. */
export function tokens(s) {
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
// The prompt block's selection: relevant first, then newest, within a budget
// ---------------------------------------------------------------------------

export const DEFAULT_PROMPT_BUDGET_CHARS = 1200   // ≈ 300 tokens (plan §3)

/**
 * The memories that fit the budget, plus how many did not. Pure over its
 * input, which is newest first.
 *
 * With a `query` (the chat's FIRST user message, so the block stays the same
 * across turns and the prompt cache holds: agent-runtime D40, tools-gateway
 * firstUserText), memories sharing words with it
 * come first, best match first, then the rest newest first (projects-plan
 * D20). Recency alone dropped an old fact the moment it mattered: "what
 * database do I use?" in a chat where twenty newer memories had pushed
 * "Uses Postgres 16" out of the budget. Keyword scoring only, no embedding
 * call: this runs on every request, and must never wait on a sidecar.
 */
//
// By kind (agent-runtime D40, 8.4): each kind is picked on its own, so a
// hundred facts cannot crowd out how the user wants the assistant to work.
// Guidance takes up to a third of the budget, state up to a third, and facts
// whatever those two leave, so an account of facts only (every record saved
// before kinds existed) keeps the whole budget, as before.
export const GUIDANCE_WHY_CHARS = 120
// The rendered line costs more than the text: a why on guidance, a date on state.
function promptCost(m) {
  if (m.kind === 'guidance') return m.text.length + 3 + (m.why ? Math.min(m.why.length, GUIDANCE_WHY_CHARS) + 8 : 0)
  if (m.kind === 'state') return m.text.length + 3 + 20
  return m.text.length + 3
}
function byRelevance(list, query) {
  if (typeof query !== 'string' || !query.trim()) return list
  const scored = list.map((m, i) => ({ m, i, s: keywordScore(query, m.text) }))
  const relevant = scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i)
  return [...relevant.map((x) => x.m), ...scored.filter((x) => x.s === 0).map((x) => x.m)]
}
function fill(ordered, budgetChars) {
  const chosen = []
  let used = 0
  for (const m of ordered) {
    const cost = promptCost(m)
    if (used + cost > budgetChars) break
    chosen.push(m)
    used += cost
  }
  return { chosen, used }
}
/** A state memory's date: asOf, else when it was last written. */
function stateTime(m) {
  const t = m.asOf ? Date.parse(`${m.asOf}T00:00:00Z`) : NaN
  return Number.isFinite(t) ? t : (m.updatedAt ?? m.createdAt ?? 0)
}

/**
 * @returns {{ guidance, facts, state, chosen, omitted }} `chosen` is the three
 *   in prompt order (guidance, facts, state); `omitted` counts every memory
 *   left out, of any kind.
 */
export function selectForPrompt(memories, budgetChars = DEFAULT_PROMPT_BUDGET_CHARS, { query = '' } = {}) {
  const kindOf = (m) => m.kind ?? 'fact'
  const third = Math.floor(budgetChars / 3)
  const guidance = fill(byRelevance(memories.filter((m) => kindOf(m) === 'guidance'), query), third)
  // Newest first by its own date: what a state says is only as good as when.
  const state = fill(memories.filter((m) => kindOf(m) === 'state').sort((a, b) => stateTime(b) - stateTime(a)), third)
  const facts = fill(byRelevance(memories.filter((m) => kindOf(m) === 'fact'), query), budgetChars - guidance.used - state.used)
  const chosen = [...guidance.chosen, ...facts.chosen, ...state.chosen]
  return { guidance: guidance.chosen, facts: facts.chosen, state: state.chosen, chosen, omitted: memories.length - chosen.length }
}

/**
 * The composer's memory input for one request. Gated on the NARROWED config,
 * so a role that withholds `memory` withholds the block too, and not on the
 * tools in the request: retrieval dropping memory_save this turn must not make
 * what is remembered vanish. Used by the completions path and the admin preview.
 */
export function memoriesFor(config, account, { projectId = null, query = '' } = {}) {
  if (!config?.memory?.enabled) return {}
  try {
    const { chosen, omitted } = selectForPrompt(listMemories(account), config.memory.promptBudgetChars, { query })
    const out = { memories: chosen, memoriesOmitted: omitted }
    // A project chat also carries the project's own memories (plan D13), on
    // their own budget so a busy project cannot crowd out who the user is.
    // projectId is one the caller already verified (getProject).
    if (projectId) {
      const p = selectForPrompt(listMemories(account, { projectId }), config.memory.promptBudgetChars, { query })
      out.projectMemories = p.chosen
      out.projectMemoriesOmitted = p.omitted
    }
    return out
  } catch {
    return {} // a malformed account gets no memories rather than someone else's
  }
}
