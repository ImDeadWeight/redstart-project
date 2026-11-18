'use strict'

import { embedTexts } from './embed-server.mjs'
import { createHash } from 'node:crypto'
import {
  DISCOVERY_TOOL_NAMES,
  createBm25Index,
  fuse,
  toolContentHash,
  toolSearchResult,
  tokenize,
  createVectorStore,
  estimateToolTokens,
  scoreTools,
  toolName,
} from './tool-retrieval.mjs'
import { toolMetadata } from './tool-metadata.mjs'

const DISCOVERY = new Set(DISCOVERY_TOOL_NAMES)
const isDiscovery = (tool) => DISCOVERY.has(toolName(tool))

// =============================================================================
// Redstart Nest — tool retrieval: the setting, search_tools' ranking, the wire
// =============================================================================
// tool-retrieval.mjs ranks; embed-server.mjs embeds; this joins them for
// search_tools (search-tools-provider.mjs) and holds the one cache that lives
// across requests, the vector store, whose worst failure is a slower search.
//
// What "on" means since master plan 3.3: the catalog. The gateway sends every
// tool that is not deferred (tool-deferral.mjs), the same list on every turn,
// and the deferred ones are reached through search_tools and call_tool.
// Per-turn selection, its budget, floors-as-a-selection, growth modes,
// selection memory and withhold all went; so did the scorer switch.
// =============================================================================

const store = createVectorStore()

// Test seam: the port the default embedder dials. Null is production
// (EMBED_PORT). The suites set it to a port they own, either a closed one for
// "no embedding server" or a stub's ephemeral one, so they no longer depend on
// what a running Redstart has on 19084. That dependency made "retrieval that
// fails open discloses nothing" fail now and then (P6, 2026-10-26). The
// production client still runs over a real socket; only its port changes.
/** @type {number|null} */
let embedPortOverride = null

/** @param {number|null} port */
export function setEmbedPortForTests(port) {
  embedPortOverride = Number.isInteger(port) && port > 0 ? port : null
}

/** @type {typeof embedTexts} */
const defaultEmbed = (texts, options) =>
  embedTexts(texts, embedPortOverride === null ? options : { ...options, port: embedPortOverride })

/**
 * On by default since 2026-11-18 (the user: on, unless the benchmarks say
 * otherwise; master plan 3.2's catalog arm passed the bar). Per profile;
 * `enabled` is the only setting, and only an explicit `false` turns it off.
 */
export const RETRIEVAL_DEFAULTS = Object.freeze({ enabled: true })

/** Does a profile's tools block want retrieval? Absent reads as on. */
export function retrievalOnFor(tools) {
  return tools?.retrieval?.enabled !== false
}

/**
 * search_tools' floors on the fused scores (fuse() returns 1 for a tool
 * ranked first by both), tuned on the eval set
 * (tool-retrieval-fixes-implementation.md, 3.2). Constants since master plan
 * 3.3: the per-profile floor, relativeFloor and margin settings went with the
 * selection they also tuned.
 *
 * relativeFloor: a fraction of the best score this query, the load-bearing
 * one, since "close to the best match" means the same on every query where an
 * absolute threshold does not. floor: a hard "this matched nothing" cut.
 */
export const SEARCH_FLOORS = Object.freeze({ relativeFloor: 0.85, floor: 0.2 })

/** Is retrieval on? On means the catalog (master plan 3.3). */
export function retrievalEnabled(settings) {
  return settings?.enabled === true
}

/**
 * The settings a request ran with, for the caller's report
 * (x-redstart-retrieval-config, benchmarks H1), so a bench row says what ran
 * rather than trusting its label. Keys are fixed and in a fixed order, so two
 * runs' strings compare as text. One key since 3.3; the header stays so a row
 * still says which arm ran.
 *
 * @returns {string}
 */
export function retrievalConfigSummary() {
  return 'mode=catalog'
}

// The keyword index of the last few catalogs seen, by their content. A
// catalog is mostly the same from one search to the next, so this is rebuilt
// only when the set or a tool's text changes.
/** @type {Map<string, ReturnType<typeof createBm25Index>>} */
const keywordIndexes = new Map()
const KEYWORD_INDEX_CACHE = 8

function keywordIndexFor(tools) {
  const key = createHash('sha256').update(tools.map((t) => toolContentHash(t)).join(',')).digest('hex')
  let index = keywordIndexes.get(key)
  if (!index) {
    index = createBm25Index(tools)
    keywordIndexes.set(key, index)
    while (keywordIndexes.size > KEYWORD_INDEX_CACHE) keywordIndexes.delete(keywordIndexes.keys().next().value)
  }
  return index
}

/** Test seam: forget the recorded wire cost. */
export function resetToolFilterState() {
  lastWireCost = null
}

// ---------------------------------------------------------------------------
// search_tools
// ---------------------------------------------------------------------------

/** How many matches searchTools returns by default. */
export const SEARCH_RESULT_LIMIT = 10

/**
 * Rank a tool catalog against a free-text description of what the model wants.
 *
 * Returns toolSearchResult() rows, `{ name, category, store, description }`;
 * search-tools-provider.mjs adds the schemas. The discovery tools are never
 * results.
 *
 * Returns null if it cannot rank, which callers must report as a failure rather
 * than as an empty result: "no tools match" and "the scorer is down" are
 * different answers and the model should not confuse them.
 *
 * @param {{ tools: any[], query: string, limit?: number, embed?: typeof embedTexts }} args
 * @returns {Promise<{ name: string, category: string, store: string, description: string }[]|null>}
 */
export async function searchTools({ tools, query, limit = SEARCH_RESULT_LIMIT, embed = defaultEmbed }) {
  const ranked = await rankForSearch({ tools, query, embed })
  if (ranked === null) return null
  return ranked.slice(0, limit).map(({ tool }) => toolSearchResult(tool))
}

/**
 * searchTools' ranking with its scores, for search_tools' widening steps
 * (search-tools-provider.mjs). The same contract: [] for an empty catalog,
 * null when it cannot rank.
 *
 * @param {{ tools: any[], query: string, embed?: typeof embedTexts }} args
 * @returns {Promise<{ tool: any, name: string, score: number }[]|null>}
 */
export async function rankForSearch({ tools, query, embed = defaultEmbed }) {
  const searchable = Array.isArray(tools) ? tools.filter((t) => !isDiscovery(t)) : []
  if (searchable.length === 0) return []
  if (typeof query !== 'string' || !query.trim()) return null

  try {
    // A tool is embedded once per content hash, ever, so this is empty on all
    // but the first search that sees a given catalog.
    const missing = store.missingHashes(searchable)
    if (missing.length > 0) {
      const vectors = await embed(missing.map(m => m.text))
      if (!vectors) return null
      store.setMany(missing.map((m, i) => [m.hash, vectors[i]]))
    }
    const queryVectors = await embed([query])
    if (!queryVectors) return null
    const scored = scoreTools({ tools: searchable, query: queryVectors[0], store })
    return fuse({ scored, keyword: keywordIndexFor(searchable).score(query) })
  } catch {
    return null
  }
}

/**
 * Keywords alone, on each tool's name and registry tags (search_tools' third
 * step, 5.3): what still works with no embedding server, and what a one-word
 * query from a small model ("config") is most likely to hit. Best first; only
 * tools that match.
 *
 * @param {{ tools: any[], query: string }} args
 * @returns {{ tool: any, name: string, score: number }[]}
 */
export function keywordSearch({ tools, query }) {
  const searchable = Array.isArray(tools) ? tools.filter((t) => !isDiscovery(t)) : []
  if (!searchable.length || !tokenize(query).length) return []
  const nameAndTags = (tool) => {
    const name = toolName(tool)
    return [name, name.replace(/[_-]+/g, ' '), ...toolMetadata(name).tags].join('\n')
  }
  const scores = createBm25Index(searchable, nameAndTags).score(query)
  return searchable
    .map((tool) => ({ tool, name: toolName(tool), score: scores.get(toolName(tool)) ?? 0 }))
    .filter((e) => e.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

// ---------------------------------------------------------------------------
// What actually went on the wire
// ---------------------------------------------------------------------------
// The Tools tab's estimate walks the providers Nest would serve over MCP. That
// is a configuration-time hint and it has always UNDER-counted the real cost:
// `parsed.tools` is composed client-side (live MCP connections, health-check
// tools, and a client app's own local tools), and the gateway then adds a
// system prompt the client never accounted for.
//
// So the gateway records what it actually forwarded, and the estimate is shown
// beside it rather than instead of it. One observation, overwritten per
// request: this is a "what is this costing me right now" readout, not a series,
// and a history would be a log of one account's tool usage with a retention
// policy to argue about.

/** @type {{ at: number, toolsOffered: number, toolsAfterBans: number, toolsSent: number, toolTokens: number, promptTokens: number, ctxSize: number|null, filtered: boolean }|null} */
let lastWireCost = null

/**
 * Record what one completions request really carried. Counts and token
 * estimates only — no names, no content, nothing an account could be
 * identified by.
 *
 * THREE tool counts, not two, because two would make the reconciliation
 * dishonest: bans and the catalog both remove tools, and an admin looking at
 * a shrunken list needs to know which did it. A ban is policy they set; a
 * deferred tool is still there, through search_tools.
 */
export function recordWireCost({ toolsOffered, toolsAfterBans, tools, messages, ctxSize, filtered }) {
  const sent = Array.isArray(tools) ? tools.length : 0
  lastWireCost = {
    at: Date.now(),
    toolsOffered,
    toolsAfterBans: toolsAfterBans ?? sent,
    toolsSent: sent,
    toolTokens: estimateToolTokens(tools ?? []),
    promptTokens: estimateToolTokens(messages ?? []),
    ctxSize: Number.isFinite(ctxSize) && ctxSize > 0 ? ctxSize : null,
    filtered: !!filtered,
  }
}

/**
 * The last observed request cost, or null if no completion has been forwarded
 * since this daemon started.
 *
 * SERVER-WIDE. Every account's completions overwrite the same slot, so on a
 * multi-user daemon this is whoever asked last. That is the deliberate trade —
 * a per-account series is a log of one user's tool usage with a retention
 * policy to argue about — but it makes the number easy to misread as "my last
 * request", so the Tools tab labels it "Last request from any account".
 *
 * Null is a meaningful answer and must not be papered over with zeros: "no
 * request has been made yet" and "requests cost nothing" are different, and
 * only one of them means the estimate beside it is the best available number.
 */
export function observedWireCost() {
  return lastWireCost
}
