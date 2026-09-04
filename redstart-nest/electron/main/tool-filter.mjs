'use strict'

import { embedTexts } from './embed-server.mjs'
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
 * How much of the context window the tool list and the prompt may occupy
 * between them. The rest is the conversation and the answer — a tool list that
 * fits the window exactly is a request that cannot be replied to.
 */
export const CONTEXT_BUDGET_FRACTION = 0.5

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

    const queryText = conversationQueryText(messages)
    if (!queryText.trim()) return unchanged(tools, 'no-query')
    const queryVectors = await embed([queryText])
    if (!queryVectors) return unchanged(tools, 'no-embedding-server')

    const key = conversationKey(messages, accountId)
    const scored = scoreTools({ tools, query: queryVectors[0], store })

    const { selected, dropped, reason } = selectTools({
      scored,
      pins: pinsFromMessages(messages),
      previous: memory.get(key),
      budgetTokens: toolBudget(ctxSize, reservedTokens),
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
    logEvent('retrieval', 'tools_filtered', {
      offered: tools.length,
      selected: selected.length,
      dropped: dropped.length,
      reason,
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
