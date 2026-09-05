'use strict'

import { embedTexts } from './embed-server.mjs'
import { EMBED_MODEL } from './embed-model.mjs'
import { logEvent } from './logger.mjs'
import {
  conversationKey,
  conversationQueryText,
  createSelectionMemory,
  createVectorStore,
  estimateToolTokens,
  pinsFromMessages,
  scoreTools,
  selectTools,
  toolName,
} from './tool-retrieval.mjs'

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
})

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
 *   settings?: { enabled?: boolean, relativeFloor?: number, floor?: number, margin?: number },
 *   ctxSize?: number,
 *   reservedTokens?: number,
 *   embed?: typeof embedTexts,
 * }} request
 * @returns {Promise<any[]>}
 */
export async function filterRequestTools({
  tools, messages, accountId, settings, ctxSize, reservedTokens = 0, embed = embedTexts,
}) {
  const config = { ...RETRIEVAL_DEFAULTS, ...(settings ?? {}) }
  if (!config.enabled) return tools
  if (!Array.isArray(tools) || tools.length === 0) return tools

  const startedAt = Date.now()
  try {
    // Fill the cache before scoring. A tool is embedded once per content hash,
    // ever, so this is empty on all but the first request that sees a given
    // tool set — and a failure here is simply a colder cache, not an error.
    const missing = store.missingHashes(tools)
    if (missing.length > 0) {
      const vectors = await embed(missing.map(m => m.text))
      if (!vectors) return unchanged(tools, 'no-embedding-server')
      store.setMany(missing.map((m, i) => [m.hash, vectors[i]]))
    }

    const queryText = conversationQueryText(messages, { maxTokens: EMBED_MODEL.maxTokens })
    if (!queryText.trim()) return unchanged(tools, 'no-query')
    const queryVectors = await embed([queryText])
    if (!queryVectors) return unchanged(tools, 'no-embedding-server')

    const key = conversationKey(messages, accountId)
    const scored = scoreTools({ tools, query: queryVectors[0], store })
    const budgetTokens = toolBudget(ctxSize, reservedTokens)

    const { selected, dropped, reason } = selectTools({
      scored,
      pins: pinsFromMessages(messages),
      previous: memory.get(key),
      budgetTokens,
      floor: config.floor,
      relativeFloor: config.relativeFloor,
      margin: config.margin,
    })

    // Nothing survived. That is a scorer that has gone wrong, not a request
    // with no tools, and sending an empty list would strip a capability the
    // model was told it has. Fall back rather than trust it.
    if (selected.length === 0) return unchanged(tools, 'empty-selection')

    memory.set(key, selected.map(toolName))

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
    })
    return selected
  } catch (err) {
    // Belt and braces over embedTexts' own contract: nothing this module does
    // may become a failed completion.
    return unchanged(tools, err?.message ?? 'unknown-error')
  }
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
 * costs nothing to search, and vice versa.
 *
 * Returns `{ name, description }` and NEVER a schema. A search result is an
 * index, not a definition: the names it surfaces become pins on the next turn
 * (pinsFromMessages), and the tool arrives with its real schema through the
 * ordinary path — so shipping schemas here would spend the context the whole
 * feature exists to save.
 *
 * Returns null if it cannot rank, which callers must report as a failure rather
 * than as an empty result: "no tools match" and "the scorer is down" are
 * different answers and the model should not confuse them.
 *
 * @param {{ tools: any[], query: string, limit?: number, embed?: typeof embedTexts }} args
 * @returns {Promise<{ name: string, description: string }[]|null>}
 */
export async function searchTools({ tools, query, limit = SEARCH_RESULT_LIMIT, embed = embedTexts }) {
  if (!Array.isArray(tools) || tools.length === 0) return []
  if (typeof query !== 'string' || !query.trim()) return null

  try {
    const missing = store.missingHashes(tools)
    if (missing.length > 0) {
      const vectors = await embed(missing.map(m => m.text))
      if (!vectors) return null
      store.setMany(missing.map((m, i) => [m.hash, vectors[i]]))
    }
    const queryVectors = await embed([query])
    if (!queryVectors) return null

    return scoreTools({ tools, query: queryVectors[0], store })
      .slice(0, limit)
      .map(({ tool }) => ({
        name: toolName(tool),
        description: String((tool?.function ?? tool)?.description ?? ''),
      }))
  } catch {
    return null
  }
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

/** @type {{ at: number, toolsOffered: number, toolsAfterBans: number, toolsSent: number, toolTokens: number, promptTokens: number, ctxSize: number|null, filtered: boolean }|null} */
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
 * Null is a meaningful answer and must not be papered over with zeros: "no
 * request has been made yet" and "requests cost nothing" are different, and
 * only one of them means the estimate beside it is the best available number.
 */
export function observedWireCost() {
  return lastWireCost
}
