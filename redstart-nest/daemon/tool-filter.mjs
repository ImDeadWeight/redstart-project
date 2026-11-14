'use strict'

import { embedTexts } from './embed-server.mjs'
import { EMBED_MODEL } from './embed-model.mjs'
import { logEvent } from './logger.mjs'
import { createHash } from 'node:crypto'
import {
  DISCOVERY_TOOL_NAMES,
  SCORERS,
  conversationKey,
  createBm25Index,
  rescore,
  toolContentHash,
  toolSearchResult,
  tokenize,
  conversationQueryText,
  createSelectionMemory,
  createVectorStore,
  estimateToolTokens,
  pinsFromMessages,
  pinReasons,
  scoreTools,
  selectTools,
  toolName,
} from './tool-retrieval.mjs'
import { HOST_RESOLVED_TOOL_NAMES } from './tools-definitions.mjs'
import { toolMetadata } from './tool-metadata.mjs'
import { TOOL_NAMES as MEMORY_TOOL_NAMES } from './memory-tool.mjs'


// Tools retrieval keeps together (tool-retrieval.mjs selectTools, families).
// Memory: saving without forgetting is the half that does damage, since a
// model offered only memory_save says it has no way to forget, then says it
// forgot (2026-11-12).
export const TOOL_FAMILIES = [MEMORY_TOOL_NAMES]

// Kept on every turn the request carries them, past the floor and the budget
// (selectTools pins). Host-resolved tools, and the memory tools (second pass
// 1.1): a fact to remember arrives on a turn about something else, so the
// query cannot be trusted to score them. Block 12's "you cannot save" line in
// system-prompt.mjs stays as the fallback for a request that has none.
//
// And search_tools (second pass 3.2, ahead of Phase 5): it is how the model
// reaches what the selection left out, so a selection must never be the
// thing that hides it. Under the cosine scorer it only survived because its
// description is about tools in general and scores alike on everything.
// describe_tool and call_tool (Phase 5) likewise: the discovery tools.
export const ALWAYS_PINNED_TOOL_NAMES = Object.freeze([...HOST_RESOLVED_TOOL_NAMES, ...MEMORY_TOOL_NAMES, ...DISCOVERY_TOOL_NAMES])

const DISCOVERY = new Set(DISCOVERY_TOOL_NAMES)
const isDiscovery = (tool) => DISCOVERY.has(toolName(tool))

// =============================================================================
// Redstart Nest — applying tool retrieval to a request
// =============================================================================
// tool-retrieval.mjs decides; embed-server.mjs embeds; this joins them to one
// completions request. It is the only file that holds state across requests,
// and both pieces of that state are caches whose worst failure is a slower
// turn: the vector store, and the last set applied per conversation.
//
// INVARIANT — this runs AFTER enforceToolAllowList() and can only ever shrink
// what that left behind. It is handed the post-ban tools and returns a subset;
// a banned tool cannot re-enter by scoring well, by being pinned, or by having
// been applied on an earlier turn.
//
// INVARIANT — fail open. Retrieval off, no embedding server, a cold cache that
// cannot be filled, an embed call that times out: every one of them returns the
// tools unchanged, which is byte-for-byte today's behaviour. Nothing in this
// file is allowed to fail a completion.
// =============================================================================

const store = createVectorStore()
const memory = createSelectionMemory({ max: 200 })
// Per conversation, when and why each applied tool came in (6.1), for the
// caller's report only; the same keys and bound as `memory`, and as lossy.
/** @type {Map<string, Record<string, { turn: number, why: string }>>} */
const origins = new Map()

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
 * How much of the context window the tool list may occupy.
 *
 * A QUARTER, matching the threshold the Tools tab has always used to turn its
 * estimate amber ("over a quarter of your window — consider enabling fewer
 * tools"). Two numbers in one product disagreeing about what "too much context
 * spent on tools" means is how a filter comes to report success while sending
 * a request the UI would have warned about.
 *
 * It was a half, and a half is enough rope to make the filter useless: on a
 * query where every tool scores alike — "which tools are relevant here?" is the
 * pathological case, since it is *about* tool descriptions — the floors admit
 * nearly everything and this becomes the only constraint left. Retrieval then
 * stops selecting and starts packing: measured at 29 of 76 tools and 15,494
 * tokens, which is a filter that has technically run and saved the user very
 * little. At a quarter the same query yields 14 tools and 7,480 tokens.
 *
 * When this is the binding constraint the scorer could not tell the tools
 * apart, which is worth knowing — `reason: 'budget'` in the telemetry says so.
 */
export const CONTEXT_BUDGET_FRACTION = 0.25

/** Defaults for the knobs an admin does not set. */
export const RETRIEVAL_DEFAULTS = Object.freeze({
  enabled: false,
  // A fraction of the best score this turn. The load-bearing floor: the
  // embedding model puts every score in a narrow absolute band, so "within 15%
  // of the best match" means the same thing on every query where an absolute
  // threshold does not. See embed-model.mjs for the measurement.
  relativeFloor: 0.85,
  // A hard "this query matched nothing" cut, well below anything the model
  // produces for a real match.
  floor: 0.2,
  // Hysteresis against the weakest included tool, so a score jittering by a
  // hair does not toggle the set and re-prefill the conversation.
  margin: 0.02,
  // Which text retrieval embeds (tool retrieval second pass). 1: the query is
  // every user message as sent, and a tool is its name and description. 2:
  // the query leaves out chat-ui's attachment note (1.2), and a tool is its
  // name, description and registry metadata (2.2). Both change what is
  // embedded, so 2 needs a refreeze of the eval with a real embedder and a
  // before/after on it; it stays 1 until that has been run.
  textVersion: 1,
  // How tools are ranked (tool-retrieval.mjs SCORERS): 'cosine' (the
  // embedding alone, the first pass), 'bm25' (keywords alone) or 'fused'
  // (reciprocal rank fusion of the two, second pass 3.2). Fused by default
  // since 3.2: on the 93-case eval it took MRR from 0.706 to 0.809, R@3 from
  // 76.9% to 91.9% (the small-model queries from 88.2% to 100%) and selection
  // recall from 98.4% to 100% with fewer tools sent (13.9 against 16.1), and
  // every case it misses cosine misses too.
  scorer: 'fused',
  // After the first selection of a conversation (second pass 4.1): 'scored'
  // keeps adding tools that score well as the conversation moves, which
  // changes the prompt ahead of the chat each time (P2); 'pins-only' freezes
  // the set, adding only what the model called or searched for. 'scored'
  // until discovery (Phase 5) has been measured to bring back what freezing
  // leaves out (U1, U5).
  growth: 'scored',
  // The fewest tools a first selection chooses by score, pins not counted
  // (4.2). 0 is off; the plan proposed 8, the user's call (U2).
  minTools: 0,
})

/**
 * The floors and margin for a scorer other than cosine, applied unless the
 * admin set their own. RETRIEVAL_DEFAULTS' were tuned on cosine scores; these
 * are on the normalised rank scores rescore() returns (1 = ranked first by
 * both), tuned on the eval set (tool-retrieval-fixes-implementation.md, 3.2).
 */
export const SCORER_DEFAULTS = Object.freeze({
  cosine: Object.freeze({}),
  bm25: Object.freeze({ relativeFloor: 0.5, floor: 0.05, margin: 0.02 }),
  fused: Object.freeze({ relativeFloor: 0.85, floor: 0.2, margin: 0.02 }),
})

/**
 * The settings a call runs with: the defaults, then the chosen scorer's
 * floors, then what the admin set. An unknown scorer is cosine.
 *
 * @param {Record<string, any>|null|undefined} settings
 */
export function resolveRetrievalSettings(settings) {
  const asked = settings ?? {}
  const scorer = SCORERS.includes(asked.scorer) ? asked.scorer : RETRIEVAL_DEFAULTS.scorer
  return { ...RETRIEVAL_DEFAULTS, ...SCORER_DEFAULTS[scorer], ...asked, scorer }
}

/**
 * The settings a request ran with, as one `key=value;...` string for the
 * caller's report (x-redstart-retrieval-config, benchmarks H1). The bench
 * switches these in Nest between runs, so a result has to carry what was in
 * effect rather than trust its label. Settings only: no tool names, no query.
 * Keys are fixed and in a fixed order, so two runs' strings compare as text.
 *
 * @param {object|null|undefined} settings  effectiveConfig.toolRetrieval
 * @returns {string}
 */
export function retrievalConfigSummary(settings) {
  const c = resolveRetrievalSettings(settings)
  return [
    `scorer=${c.scorer}`,
    `growth=${c.growth === 'pins-only' ? 'pins-only' : 'scored'}`,
    `text=${c.textVersion}`,
    `min=${c.minTools}`,
    `callTool=${c.callTool === true ? 1 : 0}`,
    `floor=${c.floor}`,
    `rel=${c.relativeFloor}`,
    `margin=${c.margin}`,
  ].join(';')
}

// The keyword index of the last few catalogs seen, by their content. A
// request's tools are mostly the same from one turn to the next, so this is
// rebuilt only when the set or a tool's text changes.
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

/**
 * Rank tools for a query with the configured scorer: cosine from the store,
 * then rescore() for 'bm25' or 'fused'. Sorted, every tool present.
 *
 * @param {{ tools: any[], queryVector: any, queryText: string, config: ReturnType<typeof resolveRetrievalSettings> }} args
 */
function rankTools({ tools, queryVector, queryText, config }) {
  // The discovery tools are not scored (DISCOVERY_TOOL_NAMES): they go last,
  // at 0, and come in as pins when they come in at all.
  const scorable = tools.filter((t) => !isDiscovery(t))
  const scored = scoreTools({ tools: scorable, query: queryVector, store, textVersion: config.textVersion })
  const ranked = config.scorer === 'cosine'
    ? scored
    : rescore({ scored, keyword: keywordIndexFor(scorable).score(queryText), scorer: config.scorer })
  const unscored = tools.filter(isDiscovery).map((tool) => ({ tool, name: toolName(tool), hash: '', score: 0, missing: false }))
  return unscored.length ? [...ranked, ...unscored] : ranked
}

/**
 * Filter a request's tools down to the ones this conversation plausibly needs.
 *
 * Returns the tools to send. On any failure, and whenever retrieval is off,
 * that is the input array unchanged and by identity, so a caller can tell that
 * nothing happened without comparing contents.
 *
 * @param {{
 *   tools: any[],
 *   messages: any[],
 *   accountId?: string|null,
 *   conversationId?: string|null,
 *   settings?: { enabled?: boolean, relativeFloor?: number, floor?: number, margin?: number, textVersion?: number, scorer?: string, growth?: 'scored'|'pins-only', minTools?: number },
 *   ctxSize?: number,
 *   reservedTokens?: number,
 *   embed?: typeof embedTexts,
 *   record?: { origins?: Record<string, { turn: number, why: string }>, wouldAdd?: number },
 * }} request
 *   `record`, when given, is filled with this conversation's retrieval record
 *   (6.1): for each tool sent, the turn it first came in (the count of user
 *   messages then) and why ('first' selection, 'scored' later, 'called',
 *   'search', 'describe', 'always' pinned, 'family'); and wouldAdd. Only the
 *   caller who asked ever sees it (retrievalReportHeaders).
 * @returns {Promise<any[]>}
 */
export async function filterRequestTools({
  tools, messages, accountId, conversationId = null, settings, ctxSize, reservedTokens = 0, embed = defaultEmbed, record = undefined,
}) {
  const config = resolveRetrievalSettings(settings)
  if (!config.enabled) return tools
  if (!Array.isArray(tools) || tools.length === 0) return tools

  const startedAt = Date.now()
  try {
    // Fill the cache before scoring. A tool is embedded once per content hash,
    // ever, so this is empty on all but the first request that sees a given
    // tool set — and a failure here is simply a colder cache, not an error.
    const textVersion = config.textVersion
    const missing = store.missingHashes(tools.filter((t) => !isDiscovery(t)), { textVersion })
    if (missing.length > 0) {
      const vectors = await embed(missing.map(m => m.text))
      if (!vectors) return unchanged(tools, 'no-embedding-server')
      store.setMany(missing.map((m, i) => [m.hash, vectors[i]]))
    }

    const queryText = conversationQueryText(messages, { maxTokens: EMBED_MODEL.maxTokens, dropAttachmentNote: config.textVersion >= 2 })
    if (!queryText.trim()) return unchanged(tools, 'no-query')
    const queryVectors = await embed([queryText])
    if (!queryVectors) return unchanged(tools, 'no-embedding-server')

    const key = conversationKey(messages, accountId, conversationId)
    const scored = rankTools({ tools, queryVector: queryVectors[0], queryText, config })
    const budgetTokens = toolBudget(ctxSize, reservedTokens)

    const { selected, dropped, reason, wouldAdd } = selectTools({
      scored,
      // Host-resolved tools are always kept (tools-definitions.mjs,
      // HOST_RESOLVED_TOOL_NAMES): asking scores against no task in
      // particular, and a dropped ask_user reads as "you may not ask". A pin
      // only keeps a tool the request carries, so this adds nothing a client
      // did not send.
      // The memory tools likewise (tool-retrieval second pass, 1.1, P1):
      // "remember that" can come on any turn of any topic, the query rarely
      // scores them, and a model without memory_save says it cannot save.
      pins: new Set([...pinsFromMessages(messages), ...ALWAYS_PINNED_TOOL_NAMES]),
      previous: memory.get(key),
      budgetTokens,
      floor: config.floor,
      relativeFloor: config.relativeFloor,
      margin: config.margin,
      families: TOOL_FAMILIES,
      growth: config.growth === 'pins-only' ? 'pins-only' : 'scored',
      minTools: config.minTools,
    })

    // Nothing survived. That is a scorer that has gone wrong, not a request
    // with no tools, and sending an empty list would strip a capability the
    // model was told it has. Fall back rather than trust it.
    if (selected.length === 0) return unchanged(tools, 'empty-selection')

    const previousNames = memory.get(key)
    memory.set(key, selected.map(toolName))
    const origin = noteOrigins(key, selected.map(toolName), { messages, previous: previousNames })
    if (record) {
      record.origins = origin
      record.wouldAdd = wouldAdd
    }

    // COUNTS ONLY — never tool names, never query text, never message content.
    // The privacy contract in logger.mjs is about what a support log may
    // contain, and "which tools this user has" is exactly the kind of fact it
    // exists to keep out.
    // `ms` is here because the first question asked of a filter that runs on
    // every request is "is this what made the model slow?", and counts alone
    // cannot answer it. Cold is one batch of embeds; warm is single-digit
    // milliseconds, and a log that shows which is which settles the question
    // instead of inviting a guess.
    logEvent('retrieval', 'tools_filtered', {
      offered: tools.length,
      selected: selected.length,
      dropped: dropped.length,
      reason,
      ms: Date.now() - startedAt,
      budgetTokens: Number.isFinite(budgetTokens) ? budgetTokens : null,
      sentTokens: estimateToolTokens(selected),
      // What a frozen set left out this turn (4.1): 0 unless growth is
      // 'pins-only'. A count, like everything here.
      would_add: wouldAdd,
    })
    return selected
  } catch (err) {
    // Belt and braces over embedTexts' own contract: nothing this module does
    // may become a failed completion.
    return unchanged(tools, err?.message ?? 'unknown-error')
  }
}

function noteOrigins(key, names, { messages, previous }) {
  const turn = (Array.isArray(messages) ? messages : []).filter((m) => m?.role === 'user').length
  const before = origins.get(key) ?? {}
  const reasons = pinReasons(messages)
  const always = new Set(ALWAYS_PINNED_TOOL_NAMES)
  const family = new Set(TOOL_FAMILIES.flat())
  const first = !previous || previous.length === 0
  /** @type {Record<string, { turn: number, why: string }>} */
  const out = {}
  for (const name of names) {
    out[name] = before[name] ?? {
      turn,
      why: reasons.get(name) ?? (always.has(name) ? 'always' : first ? 'first' : family.has(name) ? 'family' : 'scored'),
    }
  }
  origins.delete(key)
  origins.set(key, out)
  while (origins.size > 200) origins.delete(origins.keys().next().value)
  return out
}

function unchanged(tools, reason) {
  logEvent('retrieval', 'tools_unfiltered', { offered: tools.length, reason })
  return tools
}

/**
 * How many tokens the tool list may spend.
 *
 * The circular part of the plan's §3.3: the prompt is composed from the
 * selected tools, and the selection needs to know how big the prompt is. It is
 * broken by budgeting against `reservedTokens` — a LOWER bound on the non-tool
 * cost, measured from a prompt composed before any selection exists — so the
 * budget is always at least as tight as the truth. Erring tight costs a tool;
 * erring loose costs the request.
 *
 * An unknown or absurd ctxSize yields no budget at all rather than a guess:
 * with Infinity the other constraints (the floors, the margin) still decide,
 * which is a better failure than a number invented here.
 */
export function toolBudget(ctxSize, reservedTokens = 0) {
  if (!Number.isFinite(ctxSize) || ctxSize <= 0) return Infinity
  return Math.max(0, Math.floor(ctxSize * CONTEXT_BUDGET_FRACTION) - reservedTokens)
}

/**
 * Approximate token cost of a message array as it will go on the wire. Same
 * length/4 heuristic as everything else here, and it is used only to size a
 * budget, never to reject a request.
 */
export function estimateMessagesTokens(messages) {
  return estimateToolTokens(messages)
}

/** Test seam: forget everything cached between requests. */
export function resetToolFilterState() {
  memory.clear()
  origins.clear()
  lastWireCost = null
}

// ---------------------------------------------------------------------------
// search_tools
// ---------------------------------------------------------------------------

/** How many matches a search returns. Enough to choose from, few enough to read. */
export const SEARCH_RESULT_LIMIT = 10

/**
 * Rank a tool catalog against a free-text description of what the model wants.
 *
 * Shares this module's vector store, so a tool the filter has already embedded
 * costs nothing to search, and vice versa. Ranks with the configured scorer
 * (fused by default), so a search and a selection agree.
 *
 * Returns toolSearchResult() rows, `{ name, category, store, description }`,
 * and NEVER a schema. A search result is an index, not a definition: the names
 * it surfaces become pins on the next turn (pinsFromMessages), and the tool
 * arrives with its real schema through the ordinary path (or describe_tool) —
 * so shipping schemas here would spend the context the whole feature exists
 * to save. The discovery tools are never results.
 *
 * Returns null if it cannot rank, which callers must report as a failure rather
 * than as an empty result: "no tools match" and "the scorer is down" are
 * different answers and the model should not confuse them.
 *
 * @param {{ tools: any[], query: string, limit?: number, embed?: typeof embedTexts, settings?: Record<string, any> }} args
 * @returns {Promise<{ name: string, category: string, store: string, description: string }[]|null>}
 */
export async function searchTools({ tools, query, limit = SEARCH_RESULT_LIMIT, embed = defaultEmbed, settings = {} }) {
  const ranked = await rankForSearch({ tools, query, embed, settings })
  if (ranked === null) return null
  return ranked.slice(0, limit).map(({ tool }) => toolSearchResult(tool))
}

/**
 * searchTools' ranking with its scores, for search_tools' widening steps
 * (search-tools-provider.mjs). The same contract: [] for an empty catalog,
 * null when it cannot rank.
 *
 * @param {{ tools: any[], query: string, embed?: typeof embedTexts, settings?: Record<string, any> }} args
 * @returns {Promise<{ tool: any, name: string, score: number }[]|null>}
 */
export async function rankForSearch({ tools, query, embed = defaultEmbed, settings = {} }) {
  const config = resolveRetrievalSettings(settings)
  const textVersion = config.textVersion
  const searchable = Array.isArray(tools) ? tools.filter((t) => !isDiscovery(t)) : []
  if (searchable.length === 0) return []
  if (typeof query !== 'string' || !query.trim()) return null

  try {
    const missing = store.missingHashes(searchable, { textVersion })
    if (missing.length > 0) {
      const vectors = await embed(missing.map(m => m.text))
      if (!vectors) return null
      store.setMany(missing.map((m, i) => [m.hash, vectors[i]]))
    }
    const queryVectors = await embed([query])
    if (!queryVectors) return null
    return rankTools({ tools: searchable, queryVector: queryVectors[0], queryText: query, config })
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
// system prompt the client never accounted for. Retrieval did not make that
// wrong — it made it matter, because an admin now needs to know what the filter
// removed as well as what was there to remove.
//
// So the gateway records what it actually forwarded, and the estimate is shown
// beside it rather than instead of it. One observation, overwritten per
// request: this is a "what is this costing me right now" readout, not a series,
// and a history would be a log of one account's tool usage with a retention
// policy to argue about.

/** @type {{ at: number, toolsOffered: number, toolsAfterBans: number, toolsSent: number, toolTokens: number, promptTokens: number, ctxSize: number|null, filtered: boolean, wouldAdd: number }|null} */
let lastWireCost = null

/**
 * Record what one completions request really carried. Counts and token
 * estimates only — no names, no content, nothing an account could be
 * identified by.
 *
 * THREE tool counts, not two, because two would make the reconciliation
 * dishonest: bans and retrieval both remove tools, and an admin looking at a
 * shrunken list needs to know which did it. A ban is policy they set; a
 * retrieval drop is a judgement the scorer made.
 */
export function recordWireCost({ toolsOffered, toolsAfterBans, tools, messages, ctxSize, filtered, wouldAdd = 0 }) {
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
    // Tools a frozen set (growth 'pins-only') left out that scoring would
    // have added (6.2). 0 when retrieval did not run on this request.
    wouldAdd: filtered && Number.isInteger(wouldAdd) ? wouldAdd : 0,
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
