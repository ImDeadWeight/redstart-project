'use strict'

import { createHash } from 'node:crypto'

// =============================================================================
// Redstart Nest — tool retrieval: hashing, vectors, scoring, selection
// =============================================================================
// Pure. Imports node:crypto and nothing else — no electron, no network, no
// process — so it runs under the headless daemon and under plain `node` in the
// test suite. Everything that talks to an embedding server lives elsewhere;
// this module never learns where its vectors came from.
//
// INVARIANT — retrieval is an optimization, never a boundary. Nothing here is
// allowed to widen a tool set: selectTools() only ever returns a subset of the
// tools handed to it, and callers must hand it the POST-ban list so a banned
// tool cannot re-enter by scoring well. enforceToolAllowList() in
// tools-gateway.mjs is the boundary; this is a selection over what survives it.
//
// INVARIANT — an unchanged selection serializes identically. The tools block is
// rendered into the prompt ahead of every message, so any reordering of it
// invalidates llama-server's KV cache for the whole conversation and costs a
// full re-prefill. selectTools() therefore returns its result ordered by NAME,
// never by score, and never shrinks a set within a conversation. Guarded by
// scripts/test-tool-retrieval.mjs.
// =============================================================================

/**
 * A tool's name, across both shapes the gateway sees: OpenAI's
 * { type: 'function', function: { name } } on the wire, and MCP's flat
 * { name } from the provider registry.
 *
 * @param {any} tool
 * @returns {string}
 */
export function toolName(tool) {
  if (!tool || typeof tool !== 'object') return ''
  const name = tool.function?.name ?? tool.name
  return typeof name === 'string' ? name : ''
}

function toolBody(tool) {
  if (!tool || typeof tool !== 'object') return {}
  return (tool.function && typeof tool.function === 'object') ? tool.function : tool
}

// Sorts object keys at every depth so two structurally identical schemas
// serialize to the same string. Arrays keep their order — an array's order is
// content, not presentation.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    /** @type {Record<string, any>} */
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key])
    return out
  }
  return value
}

/**
 * The cache key for a tool's embedding: sha256 over its name, description and
 * schema, and nothing else.
 *
 * Deliberately blind to source, plugin id and trust class. Two tools with
 * identical text from different publishers collide, and that is correct — they
 * mean the same thing to an embedding model, so they should cost one embed
 * between them. A field that is Redstart's verdict about a tool rather than the
 * publisher's own text does not belong in a fingerprint of that text.
 *
 * @param {any} tool
 * @returns {string} 64 hex chars
 */
export function toolContentHash(tool) {
  const body = toolBody(tool)
  const payload = canonical({
    name: toolName(tool),
    description: typeof body.description === 'string' ? body.description : '',
    schema: body.inputSchema ?? body.parameters ?? null,
  })
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

/**
 * The text an embedding model sees for a tool. Name and description only: a
 * JSON schema is mostly type keywords, which crowd out the prose that actually
 * distinguishes one tool from another.
 *
 * @param {any} tool
 * @returns {string}
 */
export function toolEmbeddingText(tool) {
  const body = toolBody(tool)
  const description = typeof body.description === 'string' ? body.description : ''
  return description ? `${toolName(tool)}: ${description}` : toolName(tool)
}

/**
 * Approximate token cost of a tool as serialized on the wire. The same
 * length/4 heuristic the Tools tab's estimator uses, kept here so the budget
 * gate and the UI hint at least share an arithmetic.
 *
 * @param {any} tool
 * @returns {number}
 */
export function estimateToolTokens(tool) {
  let serialized
  try {
    serialized = JSON.stringify(tool) ?? ''
  } catch {
    serialized = ''
  }
  return Math.ceil(serialized.length / 4)
}

// ---------------------------------------------------------------------------
// The vector store
// ---------------------------------------------------------------------------

/**
 * An in-memory content-hash to vector cache.
 *
 * In-memory only, and deliberately so for now: a cold cache costs one batch of
 * embed calls on the first request after a restart, which is a latency cost on
 * a path that already falls back cleanly. Persistence is a recorded gap, not an
 * oversight.
 *
 * @returns {{
 *   get(hash: string): Float32Array|undefined,
 *   has(hash: string): boolean,
 *   setMany(entries: Iterable<[string, ArrayLike<number>]>): void,
 *   missingHashes(tools: any[]): { hash: string, text: string }[],
 *   size: () => number,
 * }}
 */
export function createVectorStore() {
  /** @type {Map<string, Float32Array>} */
  const vectors = new Map()

  return {
    get: (hash) => vectors.get(hash),
    has: (hash) => vectors.has(hash),
    setMany(entries) {
      for (const [hash, vector] of entries) {
        if (typeof hash !== 'string' || !hash) continue
        if (!vector || typeof vector.length !== 'number') continue
        vectors.set(hash, vector instanceof Float32Array ? vector : Float32Array.from(vector))
      }
    },
    // What a request would need embedded before it could be scored: deduped,
    // in first-seen order so a batch is reproducible.
    missingHashes(tools) {
      const seen = new Set()
      const out = []
      for (const tool of Array.isArray(tools) ? tools : []) {
        const hash = toolContentHash(tool)
        if (vectors.has(hash) || seen.has(hash)) continue
        seen.add(hash)
        out.push({ hash, text: toolEmbeddingText(tool) })
      }
      return out
    },
    size: () => vectors.size,
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Cosine similarity, brute force. A few hundred 384-dim vectors is tens of
 * microseconds, so there is no index and no reason for one.
 *
 * Returns 0 rather than NaN for a zero vector or a length mismatch: a
 * degenerate embedding is a bad score, not a poisoned sort.
 *
 * @param {ArrayLike<number>|undefined|null} a
 * @param {ArrayLike<number>|undefined|null} b
 * @returns {number}
 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i]
    dot += x * y
    normA += x * x
    normB += y * y
  }
  if (normA === 0 || normB === 0) return 0
  const score = dot / (Math.sqrt(normA) * Math.sqrt(normB))
  return Number.isFinite(score) ? score : 0
}

/**
 * Score every tool against the query vector. Decides nothing — no floor, no
 * budget, no pins. Sorted by descending score, ties broken by name so the order
 * is a function of the inputs alone.
 *
 * A tool whose vector is not in the store scores 0 and is flagged `missing`; a
 * partially cold cache degrades to "these tools rank last", not to an error.
 *
 * @param {{ tools: any[], query: ArrayLike<number>|null|undefined, store: ReturnType<typeof createVectorStore> }} args
 * @returns {{ tool: any, name: string, hash: string, score: number, missing: boolean }[]}
 */
export function scoreTools({ tools, query, store }) {
  const scored = (Array.isArray(tools) ? tools : []).map(tool => {
    const hash = toolContentHash(tool)
    const vector = store?.get(hash)
    return {
      tool,
      name: toolName(tool),
      hash,
      score: vector ? cosine(query, vector) : 0,
      missing: !vector,
    }
  })
  scored.sort((a, b) => (b.score - a.score) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return scored
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * The whole policy, pure.
 *
 * - `pins` are included first and unconditionally, and are NOT weighed against
 *   the budget. A pin is a promise: a tool the model has already called, or a
 *   tool an admin requires, cannot vanish mid-task because the budget got tight.
 * - `previous` — the set applied on the last turn of this conversation — is
 *   included for the same reason, which is what makes the applied set
 *   monotonic. A tool wrongly added costs one re-prefill once; a set that
 *   churns costs one every turn, forever.
 * - Everything else is added by descending score while it clears the floor and
 *   while the running estimate stays under `budgetTokens`. Below the floor a
 *   tool is never added even with budget to spare, so a pathological query
 *   cannot drag the whole registry in.
 * - The floor has two halves and a tool must clear BOTH. `floor` is absolute;
 *   `relativeFloor` is a fraction of the best score this turn. The relative one
 *   is the load-bearing half in practice: measured against this tree's own tool
 *   descriptions, bge-small-en-v1.5 puts every score in a narrow band (0.57 to
 *   0.82 across 21 tools and 18 asks), so an absolute cut is either a no-op or
 *   an arbitrary guillotine, while "within x% of the best match this turn"
 *   means the same thing on every query.
 * - `margin` is hysteresis against the weakest tool already included, so a
 *   score jittering by a hair does not toggle the set.
 *
 * @param {{
 *   scored: { tool: any, name: string, score: number }[],
 *   pins?: Iterable<string>,
 *   previous?: Iterable<string>,
 *   budgetTokens?: number,
 *   floor?: number,
 *   relativeFloor?: number,
 *   margin?: number,
 * }} args
 * @returns {{ selected: any[], dropped: any[], reason: string }}
 */
export function selectTools({ scored, pins, previous, budgetTokens = Infinity, floor = 0, relativeFloor = 0, margin = 0 }) {
  const entries = Array.isArray(scored) ? scored : []
  const pinned = new Set(pins ?? [])
  const carried = new Set(previous ?? [])

  /** @type {Map<string, { tool: any, name: string, score: number }>} */
  const included = new Map()
  let spent = 0

  for (const entry of entries) {
    if (!pinned.has(entry.name) && !carried.has(entry.name)) continue
    included.set(entry.name, entry)
    spent += estimateToolTokens(entry.tool)
  }

  // The hysteresis baseline is computed once, from the set we start with.
  // Candidates only ever clear it by `margin`, so admitting one cannot lower it.
  const weakestIncluded = included.size > 0
    ? Math.min(...[...included.values()].map(e => e.score))
    : null

  // entries is sorted by descending score, so the best is the first — but a
  // pinned tool that scores higher is already in `included` and must not raise
  // the bar for everything else, which is why this reads the scored list rather
  // than the selection.
  const best = entries.length > 0 ? entries[0].score : 0
  // A relative floor off a non-positive best score would admit everything or
  // nothing depending on sign; a query that matched nothing is not a licence to
  // widen, so fall back to the absolute floor alone.
  const effectiveFloor = (relativeFloor > 0 && best > 0) ? Math.max(floor, best * relativeFloor) : floor

  let budgetBit = false, floorBit = false, marginBit = false

  for (const entry of entries) {
    if (included.has(entry.name)) continue
    if (entry.score < effectiveFloor) { floorBit = true; continue }
    if (weakestIncluded !== null && entry.score < weakestIncluded + margin) { marginBit = true; continue }
    const cost = estimateToolTokens(entry.tool)
    // Stop at the first tool that does not fit rather than skipping it and
    // trying smaller ones — "the next cheap thing squeezed in" is exactly the
    // kind of set that reshuffles between turns.
    if (spent + cost > budgetTokens) { budgetBit = true; break }
    included.set(entry.name, entry)
    spent += cost
  }

  const byName = (a, b) => (toolName(a) < toolName(b) ? -1 : toolName(a) > toolName(b) ? 1 : 0)
  const selected = [...included.values()].map(e => e.tool).sort(byName)
  const dropped = entries.filter(e => !included.has(e.name)).map(e => e.tool).sort(byName)

  const reason = dropped.length === 0
    ? 'all-selected'
    : budgetBit ? 'budget' : marginBit ? 'margin' : floorBit ? 'floor' : 'all-selected'

  return { selected, dropped, reason }
}

// ---------------------------------------------------------------------------
// Reading the request
// ---------------------------------------------------------------------------
// No conversation identity reaches the gateway: chat.service.ts takes a
// conversationId and does not put it in the body, so everything below is
// derived from the `messages` array, which arrives in full on every request.
// That turns out to be a feature — pins are a pure function of the payload,
// with no session table to grow, expire, or leak across accounts.

/**
 * The text scored against the tools: every user message in the conversation,
 * plus the name of every tool it has already called.
 *
 * The WHOLE conversation, not the last turn. It costs one embed either way, and
 * the last turn is the most volatile input available — a query built from it
 * would reshuffle the tool list constantly, and each reshuffle re-prefills the
 * entire KV cache. A query that drifts slowly is what makes a monotonic
 * selection nearly free rather than a constant fight against the scorer.
 *
 * @param {any[]} messages
 * @returns {string}
 */
export function conversationQueryText(messages) {
  const parts = []
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (msg?.role === 'user') {
      const text = messageText(msg.content)
      if (text) parts.push(text)
    }
    for (const call of Array.isArray(msg?.tool_calls) ? msg.tool_calls : []) {
      const name = call?.function?.name
      if (typeof name === 'string' && name) parts.push(name)
    }
  }
  return parts.join('\n')
}

// Content is a string in the simple case and an array of parts in the
// multimodal one. Only text parts are read: an image contributes nothing to
// which tool is wanted, and its base64 would swamp the query if it did.
function messageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join(' ')
}

/**
 * A stable key for the conversation this request belongs to.
 *
 * The first user message plus the account id. The first message is the one part
 * of a conversation that never changes as it grows, and the account id keeps
 * two users who opened with the same sentence in separate buckets. Only ever
 * used as a cache key for the previously-applied set, so a miss costs one
 * re-prefill and never correctness.
 *
 * @param {any[]} messages
 * @param {string|null|undefined} accountId
 * @returns {string}
 */
export function conversationKey(messages, accountId) {
  const first = (Array.isArray(messages) ? messages : []).find(m => m?.role === 'user')
  return createHash('sha256')
    .update(`${accountId ?? ''}\u0000${messageText(first?.content)}`)
    .digest('hex')
}

/**
 * Tools this request has already committed to, which must therefore survive
 * any filtering: everything the model has already called, and everything a
 * previous search_tools call surfaced.
 *
 * A tool dropped mid-task is the worst failure this feature has, and deriving
 * the pins from the payload makes avoiding it structural rather than a rule
 * someone has to remember.
 *
 * @param {any[]} messages
 * @param {{ searchToolName?: string }} [options]
 * @returns {Set<string>}
 */
export function pinsFromMessages(messages, { searchToolName = 'search_tools' } = {}) {
  const pins = new Set()
  for (const msg of Array.isArray(messages) ? messages : []) {
    for (const call of Array.isArray(msg?.tool_calls) ? msg.tool_calls : []) {
      const name = call?.function?.name
      if (typeof name === 'string' && name) pins.add(name)
    }
    // A search result is a tool-role message whose body is the JSON this
    // gateway produced. Names it surfaced become pins on the next turn, which
    // is the entire mechanism behind search_tools — no new protocol, no server
    // state, just the transcript the client already sends back.
    if (msg?.role === 'tool' && msg?.name === searchToolName) {
      for (const name of searchResultNames(msg.content)) pins.add(name)
    }
  }
  return pins
}

function searchResultNames(content) {
  const text = messageText(content)
  if (!text) return []
  try {
    const body = JSON.parse(text)
    const rows = Array.isArray(body) ? body : Array.isArray(body?.tools) ? body.tools : []
    return rows.map(r => (typeof r === 'string' ? r : r?.name)).filter(n => typeof n === 'string' && n)
  } catch {
    // Not JSON: a client that rewrote the result into prose gets no pins from
    // it rather than a guess parsed out of English.
    return []
  }
}

/**
 * A bounded map of conversation key to the tool names applied on its last turn.
 *
 * Deliberately lossy. Eviction costs one re-prefill for a conversation nobody
 * has touched in a while, never a wrong answer, so there is no expiry policy to
 * get wrong and nothing to persist across a restart.
 *
 * @param {{ max?: number }} [options]
 */
export function createSelectionMemory({ max = 200 } = {}) {
  /** @type {Map<string, string[]>} */
  const entries = new Map()
  return {
    get(key) {
      const value = entries.get(key)
      if (!value) return []
      // Re-insert so the least recently USED is evicted, not the oldest.
      entries.delete(key)
      entries.set(key, value)
      return value
    },
    set(key, names) {
      entries.delete(key)
      entries.set(key, [...names])
      while (entries.size > max) entries.delete(entries.keys().next().value)
    },
    size: () => entries.size,
    clear: () => entries.clear(),
  }
}
