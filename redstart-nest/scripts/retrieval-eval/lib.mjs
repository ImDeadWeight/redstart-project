// =============================================================================
// Tool retrieval eval — cases, scoring and metrics
// =============================================================================
// Tool retrieval second pass, 0.4. Labelled search cases over the real
// built-in catalog (catalog.json), ranked through the PRODUCTION function
// search_tools runs: searchTools() with no limit, the full order a query
// gives.
//
// It takes an injected `embed`, so the same code runs against the real
// embedding sidecar (run.mjs) and against stored vectors (the frozen CI
// subset, test-retrieval-eval.mjs). Nothing here reimplements the scorer: a
// change to tool-retrieval.mjs or tool-filter.mjs shows up in these numbers.
//
// A case is { id, kind: 'search', query: "what the model typed",
// expected: [names], need?, source, notes? }. `need` says how `expected` is
// read: 'any' (the default: each is a right answer, finding one is a hit) or
// 'all' (the task needs every one of them, e.g. memory_save AND
// memory_forget).
//
// Master plan 3.3 removed the selection cases (a conversation, scored by what
// a completions request would have sent) and the bench tasks loaded as them:
// per-turn selection is gone, and the catalog's list is fixed, so the only
// ranking left in production is search_tools' over the model's own query.
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { searchTools } from '../../daemon/tool-filter.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const CATALOG_FILE = path.join(here, 'catalog.json')
export const CASES_FILE = path.join(here, 'cases.json')
export const FROZEN_FILE = path.join(here, 'frozen.json')

/** The K values recall@K and precision@K are reported at. */
export const KS = [1, 3, 5, 10]

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

/**
 * A gateway config with every built-in capability on: what build-catalog.mjs
 * hands activeToolCatalog(). Web search is the open variant (no whitelist), so
 * web_search and web_fetch are both listed.
 *
 * @param {string} fsRoot the File System folder (the child needs a real one)
 */
export function fullCatalogConfig(fsRoot) {
  return {
    webFetch: { enabled: true, whitelistEnabled: false, allowedBaseUrls: [], activeTools: [], maxFetchTokens: 2000 },
    postgres: { enabled: true },
    documents: { enabled: true },
    sqlite: { enabled: true },
    vault: { enabled: true },
    git: { enabled: true },
    fileSystem: { enabled: true, rootDir: fsRoot, allowWrites: true, allowDestructive: true },
    scholar: { enabled: true, venueFilter: null },
    python: { enabled: true },
    memory: { enabled: true },
    documentSearch: { enabled: true },
    toolRetrieval: { enabled: true },
  }
}

/** A chat-ui session: it answers ask_user and update_plan itself. */
export function catalogContext() {
  return { session: { hostTools: ['ask_user', 'update_plan'] } }
}

/** The fields retrieval reads, in a stable shape. */
export function toCatalogEntry(tool) {
  return { name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema ?? null }
}

export function loadCatalog(file = CATALOG_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).tools
}

/** catalog.json entries → the OpenAI tool list a completions request carries. */
export function toWireTools(catalog) {
  return catalog.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema ?? { type: 'object', properties: {} } },
  }))
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const NEEDS = new Set(['any', 'all'])

/**
 * @param {any[]} raw
 * @param {Set<string>} names the catalog's tool names
 */
export function validateCases(raw, names) {
  const seen = new Set()
  for (const c of raw) {
    const where = `case ${c?.id ?? '(no id)'}`
    if (typeof c?.id !== 'string' || !c.id) throw new Error(`${where}: id is required`)
    if (seen.has(c.id)) throw new Error(`${where}: duplicate id`)
    seen.add(c.id)
    if (c.kind !== 'search') throw new Error(`${where}: kind must be search (selection cases went with per-turn selection, master plan 3.3)`)
    if (typeof c.query !== 'string' || !c.query.trim()) throw new Error(`${where}: a search case needs a query`)
    if (!Array.isArray(c.expected) || c.expected.length === 0) throw new Error(`${where}: expected must list at least one tool`)
    const unknown = c.expected.filter((n) => !names.has(n))
    if (unknown.length) throw new Error(`${where}: expected names tools the catalog does not have: ${unknown.join(', ')}`)
    if (typeof c.source !== 'string' || !c.source) throw new Error(`${where}: source is required`)
    if (c.need !== undefined && !NEEDS.has(c.need)) throw new Error(`${where}: need must be any or all`)
  }
  return raw
}

export function loadCases(names, { file = CASES_FILE } = {}) {
  return validateCases(JSON.parse(fs.readFileSync(file, 'utf8')).cases, names)
}

// ---------------------------------------------------------------------------
// Scoring one case
// ---------------------------------------------------------------------------

/**
 * Rank, through the production function.
 *
 * @param {any} c a case
 * @param {{ wire: any[], embed: (texts: string[]) => Promise<Float32Array[] | null> }} ctx
 * @returns {Promise<{ ranking: string[], ms: number }>}
 */
export async function scoreCase(c, { wire, embed }) {
  const started = performance.now()
  const ranked = await searchTools({ tools: wire, query: c.query, limit: Infinity, embed })
  const ms = performance.now() - started
  if (ranked === null) throw new Error(`case ${c.id}: the scorer could not rank (no vectors)`)
  return { ranking: ranked.map((r) => r.name), ms }
}

/**
 * Per-case metrics. Ranks are 1-based; a tool missing from the ranking ranks
 * after everything.
 *
 * recall@K: with need 'any', 1 when some expected tool is in the top K, else
 * 0; with 'all', the share of them that is. precision@K: expected tools in
 * the top K, over K. The reciprocal rank is of the best-ranked expected tool.
 *
 * @param {string[]} expected
 * @param {{ ranking: string[] }} scored
 * @param {'any' | 'all'} [need]
 */
export function caseMetrics(expected, { ranking }, need = 'any') {
  const rankOf = (n) => {
    const i = ranking.indexOf(n)
    return i < 0 ? ranking.length + 1 : i + 1
  }
  const ranks = expected.map(rankOf)
  const best = Math.min(...ranks)
  /** @type {Record<string, { recall: number, precision: number }>} */
  const at = {}
  const share = (hits) => (need === 'all' ? hits / expected.length : hits > 0 ? 1 : 0)
  for (const k of KS) {
    const hits = ranks.filter((r) => r <= k).length
    at[k] = { recall: share(hits), precision: hits / k }
  }
  return { ranks, reciprocalRank: 1 / best, at }
}

/** A search case's right tool must rank in the top FROZEN_TOP to count as right. */
export const FROZEN_TOP = 3

/**
 * Does the scorer get this case right? The bar the frozen CI subset holds:
 * a right tool in the top FROZEN_TOP (the model reads the first few
 * results), every one of them for need 'all'.
 *
 * @param {any} c
 * @param {{ ranking: string[] }} scored
 */
export function frozenCaseOk(c, scored) {
  const m = caseMetrics(c.expected, scored, c.need)
  return m.at[FROZEN_TOP].recall > 0 && (c.need !== 'all' || m.at[FROZEN_TOP].recall === 1)
}

/** Identifies the catalog a freeze was made against. */
export function catalogHash(catalog) {
  return createHash('sha256').update(JSON.stringify(catalog)).digest('hex').slice(0, 16)
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

/**
 * Means over cases, overall and per source.
 *
 * @param {Array<{ case: any, metrics: ReturnType<typeof caseMetrics>, ms: number }>} rows
 */
export function aggregate(rows) {
  const one = (subset) => ({
    cases: subset.length,
    mrr: mean(subset.map((r) => r.metrics.reciprocalRank)),
    recall: Object.fromEntries(KS.map((k) => [k, mean(subset.map((r) => r.metrics.at[k].recall))])),
    precision: Object.fromEntries(KS.map((k) => [k, mean(subset.map((r) => r.metrics.at[k].precision))])),
    ms: mean(subset.map((r) => r.ms)),
  })
  const bySource = {}
  for (const src of [...new Set(rows.map((r) => r.case.source))].sort()) bySource[src] = one(rows.filter((r) => r.case.source === src))
  return { all: one(rows), bySource }
}

// ---------------------------------------------------------------------------
// Embedders
// ---------------------------------------------------------------------------

export const textKey = (text) => createHash('sha256').update(text).digest('hex')

/**
 * An embedder that serves stored vectors and nothing else: the frozen CI
 * subset. A text it has no vector for is a stale freeze, said by name.
 *
 * @param {Record<string, string>} vectors text sha256 → base64 float32
 */
export function frozenEmbedder(vectors) {
  return async (texts) => texts.map((t) => {
    const b64 = vectors[textKey(t)]
    if (!b64) throw new Error(`no stored vector for "${t.slice(0, 60)}${t.length > 60 ? '…' : ''}"; run retrieval-eval/run.mjs --freeze`)
    const buf = Buffer.from(b64, 'base64')
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice()
  })
}

/**
 * Wrap an embedder so every text it embeds is remembered, for --freeze.
 *
 * @param {(texts: string[]) => Promise<Float32Array[] | null>} embed
 */
export function recordingEmbedder(embed) {
  /** @type {Record<string, string>} */
  const seen = {}
  const wrapped = async (texts) => {
    const out = await embed(texts)
    if (out) texts.forEach((t, i) => { seen[textKey(t)] = Buffer.from(out[i].buffer, out[i].byteOffset, out[i].byteLength).toString('base64') })
    return out
  }
  return { embed: wrapped, seen }
}
