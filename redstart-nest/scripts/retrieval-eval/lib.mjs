// =============================================================================
// Tool retrieval eval — cases, scoring and metrics
// =============================================================================
// Tool retrieval second pass, 0.4. Labelled cases over the real built-in
// catalog (catalog.json), scored through the PRODUCTION functions:
//
//   ranking    searchTools() with no limit: the full order a query gives
//   selection  filterRequestTools(): what a completions request would send,
//              pins, families, floors and budget included
//
// Both take an injected `embed`, so the same code runs against the real
// embedding sidecar (run.mjs) and against stored vectors (the frozen CI
// subset, test-retrieval-eval.mjs). Nothing here reimplements the scorer: a
// change to tool-retrieval.mjs or tool-filter.mjs shows up in these numbers.
//
// A case is one of:
//   { id, kind: 'selection', conversation: [messages] | "one user message",
//     attachments?: [paths], expected: [names], need?, source, notes? }
//   { id, kind: 'search', query: "what the model typed", expected: [names], need?, source, notes? }
// `need` says how `expected` is read: 'any' (the default: each is a right
// answer, finding one is a hit) or 'all' (the task needs every one of them,
// e.g. memory_save AND memory_forget). `attachments` appends chat-ui's
// attachment note for those workspace files to the last user message.
// Bench tasks become selection cases at load time (benchCases), from their
// prompt plus the attachment note and expectTools.
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { attachmentNote } from '../../../shared/agent-core/attachment-note.mjs'
import { conversationQueryText, toolName, CHARS_PER_TOKEN } from '../../daemon/tool-retrieval.mjs'
import { filterRequestTools, searchTools, resetToolFilterState } from '../../daemon/tool-filter.mjs'
import { EMBED_MODEL } from '../../daemon/embed-model.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const CATALOG_FILE = path.join(here, 'catalog.json')
export const CASES_FILE = path.join(here, 'cases.json')
export const FROZEN_FILE = path.join(here, 'frozen.json')
export const BENCH_TASKS_DIR = path.join(here, '..', 'agent-bench', 'tasks')

/** The K values recall@K and precision@K are reported at. */
export const KS = [1, 3, 5, 10]

/**
 * The context window the selection is budgeted against: 32k, the size the
 * first pass's origin report ran at (84 tools, 58,881 tokens of schemas).
 */
export const EVAL_CTX_SIZE = 32768

/**
 * What the gateway reserves for the prompt before choosing (tools-gateway.mjs:
 * the messages plus a pins-only system prompt). The eval has no composer, so
 * it adds this fixed allowance for the system prompt to the messages' own
 * estimate. A lower bound, as the gateway's is.
 */
export const SYSTEM_PROMPT_ALLOWANCE_TOKENS = 2000

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

const KINDS = new Set(['selection', 'search'])
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
    if (!KINDS.has(c.kind)) throw new Error(`${where}: kind must be selection or search`)
    if (c.kind === 'search' && (typeof c.query !== 'string' || !c.query.trim())) throw new Error(`${where}: a search case needs a query`)
    if (c.kind === 'selection' && !(typeof c.conversation === 'string' || Array.isArray(c.conversation))) {
      throw new Error(`${where}: a selection case needs a conversation`)
    }
    if (!Array.isArray(c.expected) || c.expected.length === 0) throw new Error(`${where}: expected must list at least one tool`)
    const unknown = c.expected.filter((n) => !names.has(n))
    if (unknown.length) throw new Error(`${where}: expected names tools the catalog does not have: ${unknown.join(', ')}`)
    if (typeof c.source !== 'string' || !c.source) throw new Error(`${where}: source is required`)
    if (c.need !== undefined && !NEEDS.has(c.need)) throw new Error(`${where}: need must be any or all`)
    if (c.attachments !== undefined && (c.kind !== 'selection' || !Array.isArray(c.attachments) || !c.attachments.every((a) => typeof a === 'string' && a))) {
      throw new Error(`${where}: attachments must be a list of paths, on a selection case`)
    }
  }
  return raw
}

/**
 * The bench tasks' first user messages as selection cases: the prompt plus
 * the attachment note the bench appends (agent-bench/lib/bench.mjs
 * userMessage), expected = the task's expectTools that the catalog has.
 * Tasks whose expected tools are all missing (run_command before agent-runtime
 * Phase 4) are left out rather than scored as misses.
 *
 * @param {Set<string>} names
 * @param {string} [dir]
 */
export function benchCases(names, dir = BENCH_TASKS_DIR) {
  const out = []
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
    const expected = (t.expectTools ?? []).filter((n) => names.has(n))
    if (expected.length === 0) continue
    const saved = (t.fixtures ?? []).filter((fx) => (fx.space ?? 'workspace') !== 'files').map((fx) => fx.path)
    const note = attachmentNote({ saved, conversationId: 'eval', hasTool: (n) => names.has(n) })
    out.push({
      id: `bench:${t.id}`,
      kind: 'selection',
      conversation: note ? `${t.prompt}\n\n${note}` : t.prompt,
      expected,
      source: saved.length ? 'bench-attachment' : 'bench',
    })
  }
  return out
}

export function loadCases(names, { file = CASES_FILE, withBench = true } = {}) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')).cases
  const cases = validateCases([...raw, ...(withBench ? benchCases(names) : [])], names)
  // The attachment note names the offered tools, so it is built here, against
  // the catalog, as chat-ui builds it against what it was offered.
  for (const c of cases) {
    if (c.attachments) c.note = attachmentNote({ saved: c.attachments, conversationId: 'eval', hasTool: (n) => names.has(n) })
  }
  return cases
}

/** A case's messages, as a completions request carries them (note appended). */
export function caseMessages(c) {
  const messages = typeof c.conversation === 'string' ? [{ role: 'user', content: c.conversation }] : c.conversation.map((m) => ({ ...m }))
  if (c.note) {
    const last = messages.findLast((m) => m.role === 'user')
    if (last) last.content = `${last.content}\n\n${c.note}`
  }
  return messages
}

/**
 * The text embedded for a case's query: for a selection case, exactly what
 * filterRequestTools embeds (conversationQueryText, bounded to the model); for
 * a search case, the query as the model typed it.
 */
export function caseQueryText(c) {
  return c.kind === 'search' ? c.query : conversationQueryText(caseMessages(c), { maxTokens: EMBED_MODEL.maxTokens })
}

// ---------------------------------------------------------------------------
// Scoring one case
// ---------------------------------------------------------------------------

/**
 * Rank and (for a selection case) select, through the production functions.
 *
 * @param {any} c a case
 * @param {{ wire: any[], embed: (texts: string[]) => Promise<Float32Array[] | null>, ctxSize?: number }} ctx
 * @returns {Promise<{ ranking: string[], selected: string[] | null, ms: number }>}
 */
export async function scoreCase(c, { wire, embed, ctxSize = EVAL_CTX_SIZE }) {
  // Each case is its own conversation: no selection carried from another.
  resetToolFilterState()
  const started = performance.now()
  const ranked = await searchTools({ tools: wire, query: caseQueryText(c), limit: Infinity, embed })
  const ms = performance.now() - started
  if (ranked === null) throw new Error(`case ${c.id}: the scorer could not rank (no vectors)`)

  let selected = null
  if (c.kind === 'selection') {
    const messages = caseMessages(c)
    const reserved = Math.ceil(JSON.stringify(messages).length / 4) + SYSTEM_PROMPT_ALLOWANCE_TOKENS
    const sent = await filterRequestTools({
      tools: wire, messages, accountId: 'eval', settings: { enabled: true }, ctxSize, reservedTokens: reserved, embed,
    })
    // Fail-open returns the input by identity: that is not a selection.
    if (sent === wire) throw new Error(`case ${c.id}: retrieval failed open (no vectors)`)
    selected = sent.map(toolName)
  }
  return { ranking: ranked.map((r) => r.name), selected, ms }
}

/**
 * Per-case metrics. Ranks are 1-based; a tool missing from the ranking ranks
 * after everything.
 *
 * recall@K: with need 'any', 1 when some expected tool is in the top K, else
 * 0; with 'all', the share of them that is. precision@K: expected tools in
 * the top K, over K. The reciprocal rank is of the best-ranked expected tool.
 * selectedRecall reads the selection the same way as recall.
 *
 * @param {string[]} expected
 * @param {{ ranking: string[], selected: string[] | null }} scored
 * @param {'any' | 'all'} [need]
 */
export function caseMetrics(expected, { ranking, selected }, need = 'any') {
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
  return {
    ranks,
    reciprocalRank: 1 / best,
    at,
    selectedRecall: selected ? share(expected.filter((n) => selected.includes(n)).length) : null,
    selectedSize: selected ? selected.length : null,
  }
}

/** A search case's right tool must rank in the top FROZEN_TOP to count as right. */
export const FROZEN_TOP = 3

/**
 * Does the scorer get this case right? The bar the frozen CI subset holds:
 * a search case has a right tool in the top FROZEN_TOP (the model reads the
 * first few results); a selection case's selection holds what it needs (one
 * expected tool for need 'any', all of them for 'all').
 *
 * @param {any} c
 * @param {{ ranking: string[], selected: string[] | null }} scored
 */
export function frozenCaseOk(c, scored) {
  const m = caseMetrics(c.expected, scored, c.need)
  return c.kind === 'search' ? m.at[FROZEN_TOP].recall > 0 && (c.need !== 'all' || m.at[FROZEN_TOP].recall === 1) : m.selectedRecall === 1
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
    selectedRecall: mean(subset.map((r) => r.metrics.selectedRecall).filter((x) => x !== null)),
    selectedSize: mean(subset.map((r) => r.metrics.selectedSize).filter((x) => x !== null)),
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

/** Approximate characters for a token budget, re-exported for run.mjs. */
export { CHARS_PER_TOKEN }
