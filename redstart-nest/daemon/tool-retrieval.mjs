'use strict'

import { createHash } from 'node:crypto'
import { metadataText, toolMetadata } from './tool-metadata.mjs'

// =============================================================================
// Redstart Nest — tool retrieval: hashing, vectors, ranking
// =============================================================================
// Pure. Imports node:crypto and one pure helper and nothing else — no
// electron, no network, no process — so it runs under the headless daemon and
// under plain `node` in the test suite. Everything that talks to an embedding
// server lives elsewhere; this module never learns where its vectors came
// from.
//
// What is left after master plan 3.3: the pieces search_tools ranks the
// catalog with (a tool's text, its hash, the vector store, cosine, BM25 and
// their reciprocal rank fusion). Per-turn selection (selectTools, the
// conversation query, the pins, the selection memory, withhold) went: the
// catalog's list is fixed for the conversation, so nothing here decides what
// a request carries.
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
 * or scored, and never a search result: a score for them would only move the
 * relative floor that everything else is measured against. describe_tool
 * went in master plan 3.3 (a search row carries the schema).
 */
export const DISCOVERY_TOOL_NAMES = Object.freeze(['search_tools', 'call_tool'])

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
 * The text an embedding model sees for a tool: name and description only. A
 * JSON schema is mostly type keywords, which crowd out the prose that
 * actually distinguishes one tool from another. (A second version with the
 * registry metadata was built and never switched on; it went in master plan
 * 3.3. BM25 reads the metadata instead, toolSearchDocument.)
 *
 * @param {any} tool
 * @returns {string}
 */
export function toolEmbeddingText(tool) {
  const description = toolDescription(tool)
  return description ? `${toolName(tool)}: ${description}` : toolName(tool)
}

/**
 * The BM25 document for a tool: its name with `_` and `-` read as spaces, its
 * description, and every metadata field.
 *
 * @param {any} tool
 * @returns {string}
 */
export function toolSearchDocument(tool) {
  const name = toolName(tool)
  return [name, name.replace(/[_-]+/g, ' '), toolDescription(tool), metadataText(name)].filter(Boolean).join('\n')
}

/**
 * The row search_tools returns for a tool, before the provider adds its
 * inputSchema (search-tools-provider.mjs callRows).
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
 * Approximate token cost of a tool as serialized on the wire. The same
 * length/4 heuristic the Tools tab's estimator uses, so the wire cost the
 * gateway records and the UI's estimate share an arithmetic.
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
    // What a search would need embedded before it could rank: deduped, in
    // first-seen order so a batch is reproducible. `hash` is the store key
    // (toolContentHash).
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
 * Score every tool against the query vector. Decides nothing (no floor).
 * Sorted by descending score, ties broken by name so the order is a function
 * of the inputs alone.
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

/**
 * Re-score a cosine-scored list (scoreTools) with the reciprocal rank fusion
 * of cosine and BM25, keeping the shape: sorted by descending score, ties by
 * name, every tool present. The only ranking since master plan 3.3 fixed it
 * (the 'cosine' and 'bm25' switch went).
 *
 * Rank based, so the narrow cosine band (0.57 to 0.82 on bge-small) does not
 * matter. Each score is normalised so 1 is the best possible: a tool ranked
 * first by both. A tool with no keyword match gets only its cosine share.
 *
 * With no usable cosine score (no vectors, or none above 0) it returns the
 * cosine list as it is: an embedder that is not working, on which fusion does
 * not quietly become keywords alone. The scores stay 0, nothing clears a
 * floor, and search_tools falls through to its keyword step, which says so.
 *
 * @param {{ scored: { tool: any, name: string, hash?: string, score: number, missing?: boolean }[], keyword: Map<string, number>, k?: number }} args
 */
export function fuse({ scored, keyword, k = RRF_K }) {
  const entries = Array.isArray(scored) ? scored : []
  if (!entries.some((e) => !e.missing && e.score > 0)) return entries
  const kw = keyword instanceof Map ? keyword : new Map()
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const kwRank = ranksOf([...kw.entries()].map(([name, score]) => ({ name, score })))
  const cosRank = ranksOf(entries)
  const max = 2 / (k + 1)
  return entries
    .map((e) => {
      const fromCosine = 1 / (k + (cosRank.get(e.name) ?? entries.length))
      const r = kwRank.get(e.name)
      const fromKeyword = r ? 1 / (k + r) : 0
      return { ...e, score: (fromCosine + fromKeyword) / max }
    })
    .sort((a, b) => (b.score - a.score) || byName(a, b))
}

// ---------------------------------------------------------------------------
// Text against a positional limit (embed-server.mjs)
// ---------------------------------------------------------------------------

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
