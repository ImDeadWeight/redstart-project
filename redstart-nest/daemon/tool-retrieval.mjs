'use strict'

import { createHash } from 'node:crypto'
import { stripAttachmentNote } from '../../shared/agent-core/attachment-note.mjs'
import { metadataText, toolMetadata } from './tool-metadata.mjs'

// =============================================================================
// Redstart Nest — tool retrieval: hashing, vectors, scoring, selection
// =============================================================================
// Pure. Imports node:crypto and two pure helpers and nothing else — no
// electron, no network, no process — so it runs under the headless daemon and under plain `node` in the
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
 * The tools that find other tools (second pass 5.x). They are never embedded
 * or scored: they are pinned whenever the request carries them, they are
 * never a search result, and a score for them would only move the relative
 * floor that everything else is measured against.
 */
export const DISCOVERY_TOOL_NAMES = Object.freeze(['search_tools', 'describe_tool', 'call_tool'])

// ---------------------------------------------------------------------------
// Every view of a tool retrieval uses (second pass 2.2)
// ---------------------------------------------------------------------------
// One place builds them all, from the tool and its registry metadata
// (tool-metadata.mjs): the text embedded, the BM25 document, and the row a
// search returns. The wire description is never rewritten here.

function toolDescription(tool) {
  const body = toolBody(tool)
  return typeof body.description === 'string' ? body.description : ''
}

/**
 * The text an embedding model sees for a tool.
 *
 * Version 1: name and description only. A JSON schema is mostly type
 * keywords, which crowd out the prose that actually distinguishes one tool
 * from another. Version 2 adds the registry metadata (category, where it
 * acts, tags, when to use it), the part that tells the File System tools from
 * the workspace ones.
 *
 * @param {any} tool
 * @param {{ textVersion?: number }} [options]
 * @returns {string}
 */
export function toolEmbeddingText(tool, { textVersion = 1 } = {}) {
  const description = toolDescription(tool)
  const base = description ? `${toolName(tool)}: ${description}` : toolName(tool)
  if (textVersion < 2) return base
  const meta = metadataText(toolName(tool))
  return meta ? `${base}\n${meta}` : base
}

/**
 * The BM25 document for a tool: its name with `_` and `-` read as spaces, its
 * description, and every metadata field. Not versioned: BM25 has no stored
 * vectors to keep in step.
 *
 * @param {any} tool
 * @returns {string}
 */
export function toolSearchDocument(tool) {
  const name = toolName(tool)
  return [name, name.replace(/[_-]+/g, ' '), toolDescription(tool), metadataText(name)].filter(Boolean).join('\n')
}

/**
 * The row search_tools returns for a tool: never a schema (a result is an
 * index, not a definition).
 *
 * @param {any} tool
 * @returns {{ name: string, category: string, store: string, description: string }}
 */
export function toolSearchResult(tool) {
  const name = toolName(tool)
  const m = toolMetadata(name)
  return { name, category: m.category, store: m.store, description: toolDescription(tool) }
}

/**
 * The vector-store key for a tool's embedding. Version 1 is the content hash,
 * unchanged, so a store filled before version 2 existed stays valid. Later
 * versions hash the embedded text with it: the metadata is not in the content
 * hash, and a plugin's can change without its description changing.
 *
 * @param {any} tool
 * @param {number} [textVersion]
 */
export function toolVectorKey(tool, textVersion = 1) {
  const hash = toolContentHash(tool)
  if (textVersion < 2) return hash
  return createHash('sha256').update(`${hash}\u0000${textVersion}\u0000${toolEmbeddingText(tool, { textVersion })}`).digest('hex')
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
 *   missingHashes(tools: any[], options?: { textVersion?: number }): { hash: string, text: string }[],
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
    // in first-seen order so a batch is reproducible. `hash` is the store key
    // (toolVectorKey) for the text version asked for.
    missingHashes(tools, { textVersion = 1 } = {}) {
      const seen = new Set()
      const out = []
      for (const tool of Array.isArray(tools) ? tools : []) {
        const hash = toolVectorKey(tool, textVersion)
        if (vectors.has(hash) || seen.has(hash)) continue
        seen.add(hash)
        out.push({ hash, text: toolEmbeddingText(tool, { textVersion }) })
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
 * @param {{ tools: any[], query: ArrayLike<number>|null|undefined, store: ReturnType<typeof createVectorStore>, textVersion?: number }} args
 * @returns {{ tool: any, name: string, hash: string, score: number, missing: boolean }[]}
 */
export function scoreTools({ tools, query, store, textVersion = 1 }) {
  const scored = (Array.isArray(tools) ? tools : []).map(tool => {
    const hash = toolVectorKey(tool, textVersion)
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
// Keyword search: BM25 (second pass 3.1)
// ---------------------------------------------------------------------------
// Pure, and small: a few hundred short documents, so a linear scan per query.
// The documents are toolSearchDocument(): name (also as words), description
// and registry metadata. A small model's search query is often one or two
// words ("config", "notes") that an embedding places badly and a keyword
// index finds at once.

const STOPWORDS = new Set((
  'a an and are as at be by can could do does for from get give has have how i if in into is it its me my ' +
  'need of on or please show so some that the their them then there these this to tool tools use using ' +
  'want was we what when where which who will with would you your'
).split(' '))

/**
 * Lowercase, split on anything that is not a letter or digit (so `_` and `-`
 * split, and `read_text_file` matches "text file"), drop stopwords and bare
 * numbers, and strip
 * a plural or verb ending so "commits" meets "commit".
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (typeof text !== 'string' || !text) return []
  const out = []
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    // A bare number names no tool ("48271 × 9973"), and as a rare term it
    // would hand its whole weight to whichever description has a digit.
    if (!raw || STOPWORDS.has(raw) || /^\p{N}+$/u.test(raw)) continue
    out.push(stem(raw))
  }
  return out
}

function stem(word) {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.length > 5 && word.endsWith('ing')) return undouble(word.slice(0, -3))
  if (word.length > 4 && word.endsWith('ed')) return undouble(word.slice(0, -2))
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

// "running" → "runn" → "run"; "spelled" keeps its "ll".
function undouble(word) {
  const n = word.length
  return n > 2 && word[n - 1] === word[n - 2] && !'lsz'.includes(word[n - 1]) ? word.slice(0, -1) : word
}

/** BM25's two constants, the usual ones. */
export const BM25_K1 = 1.2
export const BM25_B = 0.75

/**
 * An index over tools' search documents.
 *
 * `key` is a hash of every document, so a caller can keep one index while the
 * catalog's content is unchanged and rebuild when it is not.
 *
 * `documentOf` picks the text indexed for a tool; toolSearchDocument() by
 * default.
 *
 * @param {any[]} tools
 * @param {(tool: any) => string} [documentOf]
 * @returns {{ key: string, size: number, score(query: string): Map<string, number> }}
 */
export function createBm25Index(tools, documentOf = toolSearchDocument) {
  const list = Array.isArray(tools) ? tools : []
  /** @type {{ name: string, tf: Map<string, number>, length: number }[]} */
  const docs = []
  /** @type {Map<string, number>} */
  const df = new Map()
  const keyHash = createHash('sha256')
  for (const tool of list) {
    const name = toolName(tool)
    const text = documentOf(tool)
    keyHash.update(`${name}\u0000${text}\u0001`)
    const tokens = tokenize(text)
    const tf = new Map()
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)
    docs.push({ name, tf, length: tokens.length })
  }
  const n = docs.length
  const avg = n ? docs.reduce((a, d) => a + d.length, 0) / n : 0

  return {
    key: keyHash.digest('hex'),
    size: n,
    // Name to score, for the tools that match at least one query term. A tool
    // that matches nothing is absent, not zero: it has no keyword rank.
    score(query) {
      const terms = [...new Set(tokenize(query))]
      /** @type {Map<string, number>} */
      const out = new Map()
      if (!terms.length || !n) return out
      for (const doc of docs) {
        let score = 0
        for (const term of terms) {
          const f = doc.tf.get(term)
          if (!f) continue
          const d = df.get(term) ?? 0
          const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5))
          score += idf * (f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * (avg ? doc.length / avg : 1)))
        }
        if (score > 0) out.set(doc.name, Math.max(out.get(doc.name) ?? 0, score))
      }
      return out
    },
  }
}

// ---------------------------------------------------------------------------
// Fusion (second pass 3.2)
// ---------------------------------------------------------------------------

// 1-based ranks by descending score, ties sharing the better rank
// ("1, 1, 3"), so two tools a scorer cannot tell apart are not split by
// their names' alphabetical order.
function ranksOf(rows) {
  /** @type {Map<string, number>} */
  const out = new Map()
  const sorted = [...rows].sort((a, b) => b.score - a.score)
  let rank = 0
  let last = NaN
  sorted.forEach((row, i) => {
    if (row.score !== last) { rank = i + 1; last = row.score }
    if (!out.has(row.name)) out.set(row.name, rank)
  })
  return out
}

/** Reciprocal rank fusion's constant: the usual 60. */
export const RRF_K = 60

/** The scorers a call can ask for. 'cosine' is the first pass's. */
export const SCORERS = Object.freeze(['cosine', 'bm25', 'fused'])

/**
 * Re-score a cosine-scored list (scoreTools) with BM25 or with the reciprocal
 * rank fusion of the two, keeping the shape: sorted by descending score, ties
 * by name, every tool present.
 *
 * Rank based, so the narrow cosine band (0.57 to 0.82 on bge-small) does not
 * matter. Each score is normalised so 1 is the best possible: for 'fused', a
 * tool ranked first by both; for 'bm25', the best keyword match this query.
 * A tool with no keyword match gets only its cosine share under 'fused' and
 * 0 under 'bm25'. With no usable cosine score (no vectors, or none above 0),
 * 'fused' returns the cosine list as it is, so a broken embedder fails open.
 *
 * @param {{ scored: { tool: any, name: string, hash?: string, score: number, missing?: boolean }[], keyword: Map<string, number>, scorer?: string, k?: number }} args
 */
export function rescore({ scored, keyword, scorer = 'cosine', k = RRF_K }) {
  const entries = Array.isArray(scored) ? scored : []
  if (scorer !== 'bm25' && scorer !== 'fused') return entries
  const kw = keyword instanceof Map ? keyword : new Map()
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

  if (scorer === 'bm25') {
    const best = Math.max(0, ...kw.values())
    return entries
      .map((e) => ({ ...e, score: best > 0 ? (kw.get(e.name) ?? 0) / best : 0 }))
      .sort((a, b) => (b.score - a.score) || byName(a, b))
  }

  // A cosine ranking where nothing scored above 0 (no vectors, or vectors
  // that cannot be compared) is an embedder that is not working, and fused
  // does not quietly become keywords-only on one: the scores stay 0, nothing
  // clears a floor, and the caller fails open (tool-filter.mjs), exactly as
  // the cosine scorer does. Keywords alone are the 'bm25' scorer, chosen.
  if (!entries.some((e) => !e.missing && e.score > 0)) return entries
  const cosineUsable = true
  const kwRank = ranksOf([...kw.entries()].map(([name, score]) => ({ name, score })))
  const cosRank = ranksOf(entries)
  const max = (cosineUsable ? 1 : 0) / (k + 1) + 1 / (k + 1)
  return entries
    .map((e) => {
      const fromCosine = cosineUsable ? 1 / (k + (cosRank.get(e.name) ?? entries.length)) : 0
      const r = kwRank.get(e.name)
      const fromKeyword = r ? 1 / (k + r) : 0
      return { ...e, score: (fromCosine + fromKeyword) / max }
    })
    .sort((a, b) => (b.score - a.score) || byName(a, b))
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
 *   families?: Iterable<Iterable<string>>,
 *   growth?: 'scored' | 'pins-only',
 *   minTools?: number,
 * }} args
 *   `growth` (second pass 4.1): with `previous` and 'pins-only', the set is
 *   frozen after the first selection: `previous` plus the pins (and their
 *   families), never a newly scored tool, so the prompt ahead of the chat
 *   stays byte-identical (P2). Scoring still runs, and `wouldAdd` counts what
 *   'scored' would have added, so the cost of freezing stays visible. A
 *   previous tool the request no longer carries (banned since, or dropped by
 *   the client) leaves, as it always did.
 *   `minTools` (4.2): on a FIRST selection (no `previous`), keep adding by
 *   score past the floors and the margin until this many tools were chosen by
 *   score, pins not counted, inside the budget. A frozen set that starts at
 *   two tools stays at two.
 * @returns {{ selected: any[], dropped: any[], reason: string, wouldAdd: number }}
 *   `families`: tools that only make sense together. Once any member is
 *   selected, every other member the request carries comes with it, past
 *   the floor, the margin and the budget (a family is a few small tools).
 *   Like a pin it only keeps what the client sent, so this stays a subset.
 *   Added 2026-11-12: memory_save was selected for "remember X, then forget
 *   Y" and memory_forget was dropped, so the model said it had no way to
 *   forget and told the user it had, with the memory still saved.
 */
export function selectTools({ scored, pins, previous, budgetTokens = Infinity, floor = 0, relativeFloor = 0, margin = 0, families = [], growth = 'scored', minTools = 0 }) {
  const entries = Array.isArray(scored) ? scored : []
  const pinned = new Set(pins ?? [])
  const carried = new Set(previous ?? [])
  const frozen = growth === 'pins-only' && carried.size > 0

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
  // Frozen, the scored pass runs on a copy: what it would add is counted and
  // nothing is.
  const target = frozen ? new Map(included) : included
  let scoredCount = 0

  for (const entry of entries) {
    if (target.has(entry.name)) continue
    if (entry.score < effectiveFloor) { floorBit = true; continue }
    if (weakestIncluded !== null && entry.score < weakestIncluded + margin) { marginBit = true; continue }
    const cost = estimateToolTokens(entry.tool)
    // Stop at the first tool that does not fit rather than skipping it and
    // trying smaller ones — "the next cheap thing squeezed in" is exactly the
    // kind of set that reshuffles between turns.
    if (spent + cost > budgetTokens) { budgetBit = true; break }
    target.set(entry.name, entry)
    spent += cost
    scoredCount++
  }
  const wouldAdd = frozen ? target.size - included.size : 0

  // The minimum (4.2): a first selection only, best score first, inside the
  // budget, stopping at the first tool that does not fit as above.
  const minimum = Number.isInteger(minTools) && minTools > 0 ? minTools : 0
  if (!frozen && carried.size === 0 && scoredCount < minimum && !budgetBit) {
    for (const entry of entries) {
      if (scoredCount >= minimum) break
      if (included.has(entry.name)) continue
      const cost = estimateToolTokens(entry.tool)
      if (spent + cost > budgetTokens) { budgetBit = true; break }
      included.set(entry.name, entry)
      spent += cost
      scoredCount++
    }
  }

  for (const family of families ?? []) {
    const members = [...family]
    if (!members.some((n) => included.has(n))) continue
    for (const entry of entries) {
      if (members.includes(entry.name) && !included.has(entry.name)) included.set(entry.name, entry)
    }
  }

  const byName = (a, b) => (toolName(a) < toolName(b) ? -1 : toolName(a) > toolName(b) ? 1 : 0)
  const selected = [...included.values()].map(e => e.tool).sort(byName)
  const dropped = entries.filter(e => !included.has(e.name)).map(e => e.tool).sort(byName)

  const reason = dropped.length === 0
    ? 'all-selected'
    : frozen ? 'frozen' : budgetBit ? 'budget' : marginBit ? 'margin' : floorBit ? 'floor' : 'all-selected'

  return { selected, dropped, reason, wouldAdd }
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
 * Characters per token, for sizing text against a model's positional limit.
 *
 * Deliberately pessimistic — English runs nearer 4 — because the two errors are
 * not symmetric. Over-estimating the token count costs a little text; under-
 * estimating it costs the whole request, since an over-long input returns a 500
 * that takes its entire batch down with it.
 */
export const CHARS_PER_TOKEN = 3

/**
 * Cut a string to a token budget, on a word boundary when one is near the end.
 *
 * @param {string} text
 * @param {number} maxTokens
 * @returns {string}
 */
export function truncateForEmbedding(text, maxTokens) {
  if (typeof text !== 'string') return ''
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return text
  const maxChars = Math.floor(maxTokens * CHARS_PER_TOKEN)
  if (text.length <= maxChars) return text
  const cut = text.slice(0, maxChars)
  const lastSpace = cut.lastIndexOf(' ')
  return lastSpace > maxChars * 0.8 ? cut.slice(0, lastSpace) : cut
}

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
 * The embedding model has a hard positional limit, so "the whole conversation"
 * has a ceiling whether anyone likes it or not. When it is reached the OLDEST
 * user messages are dropped first and the tool names are always kept: names are
 * a handful of tokens each and are the strongest signal in the query, while the
 * opening of a long conversation is the part least likely to describe what is
 * wanted now.
 *
 * Dropping the oldest reintroduces some of the volatility that choosing the
 * whole conversation was meant to avoid — but only some, and it is affordable
 * precisely because application is monotonic: a drifting query can add tools,
 * never take them away, so the cost of drift is bounded at one re-prefill.
 *
 * `dropAttachmentNote` (text version 2, second pass 1.2): leave out the
 * attachment note chat-ui appends to a message with files. The note names
 * tools, the File System ones included ("cannot see these files"), and an
 * embedding cannot read the "cannot": it ranked those tools up on exactly the
 * prompts they are wrong for (P3).
 *
 * @param {any[]} messages
 * @param {{ maxTokens?: number, dropAttachmentNote?: boolean }} [options]
 * @returns {string}
 */
export function conversationQueryText(messages, { maxTokens = Infinity, dropAttachmentNote = false } = {}) {
  const userParts = []
  const toolNames = []
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (msg?.role === 'user') {
      const raw = messageText(msg.content)
      const text = dropAttachmentNote ? stripAttachmentNote(raw) : raw
      if (text) userParts.push(text)
    }
    for (const call of Array.isArray(msg?.tool_calls) ? msg.tool_calls : []) {
      const name = call?.function?.name
      if (typeof name === 'string' && name && !toolNames.includes(name)) toolNames.push(name)
    }
  }

  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    return [...userParts, ...toolNames].join('\n')
  }

  const budget = Math.floor(maxTokens * CHARS_PER_TOKEN)
  // Names first, so what survives a tight budget is the part that identifies
  // tools rather than the part that describes a problem.
  const names = truncateForEmbedding(toolNames.join('\n'), maxTokens)
  let remaining = budget - names.length - 1
  const kept = []
  for (let i = userParts.length - 1; i >= 0 && remaining > 0; i--) {
    const part = userParts[i].length <= remaining ? userParts[i] : userParts[i].slice(-remaining)
    kept.unshift(part)
    remaining -= part.length + 1
  }
  return [...kept, names].filter(Boolean).join('\n')
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
 * @param {string|null} [conversationId]
 * @returns {string}
 */
export function conversationKey(messages, accountId, conversationId = null) {
  // A conversation id the client sent (redstart_conversation_id, second pass
  // 4.3) is the better key: compaction folds the first user message into a
  // summary, after which the hash below names a different conversation and
  // the frozen set would be chosen again. Still under the account, so an id
  // can only ever name the caller's own entry.
  if (isConversationId(conversationId)) {
    return createHash('sha256').update(`${accountId ?? ''}\u0000id\u0000${conversationId}`).digest('hex')
  }
  const first = (Array.isArray(messages) ? messages : []).find(m => m?.role === 'user')
  return createHash('sha256')
    .update(`${accountId ?? ''}\u0000${messageText(first?.content)}`)
    .digest('hex')
}

/**
 * A usable client conversation id: a non-empty string of at most 128
 * printable ASCII characters. Anything else is ignored, never an error.
 *
 * @param {unknown} id
 * @returns {id is string}
 */
export function isConversationId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && /^[\x21-\x7e]+$/.test(id)
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
  // Which tool a result answers. OpenAI tool messages carry tool_call_id and,
  // from chat-ui and the agent core, no `name` (stored-messages.mjs,
  // tool-calls.mjs), so the name is read off the assistant call it answers.
  // Until 2026-11-13 only `name` was read, and a search hit never became a
  // pin in a real chat (second pass, P5).
  /** @type {Map<string, string>} */
  const callNames = new Map()
  for (const msg of Array.isArray(messages) ? messages : []) {
    for (const call of Array.isArray(msg?.tool_calls) ? msg.tool_calls : []) {
      const name = call?.function?.name
      if (typeof name === 'string' && name) pins.add(name)
      if (typeof call?.id === 'string' && typeof name === 'string') callNames.set(call.id, name)
    }
    const answered = msg?.role === 'tool'
      ? (typeof msg.name === 'string' && msg.name ? msg.name : callNames.get(msg.tool_call_id))
      : undefined
    // A search result is a tool-role message whose body is the JSON this
    // gateway produced. Names it surfaced become pins on the next turn, which
    // is the entire mechanism behind search_tools — no new protocol, no server
    // state, just the transcript the client already sends back.
    if (answered === searchToolName) {
      for (const name of searchResultNames(msg.content)) pins.add(name)
    }
    // describe_tool (second pass 5.2): the tool it described joins the list
    // on the next turn, with its real schema, the same way.
    if (answered === 'describe_tool') {
      const name = describedName(msg.content)
      if (name) pins.add(name)
    }
  }
  return pins
}

function describedName(content) {
  try {
    const body = JSON.parse(messageText(content))
    return body && typeof body === 'object' && !Array.isArray(body) && typeof body.name === 'string' && body.name ? body.name : null
  } catch {
    return null
  }
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
