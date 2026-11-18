'use strict'

// =============================================================================
// Redstart Nest — which capabilities are deferred (master plan Phase 3.1)
// =============================================================================
// A DEFERRED capability's tools are not in the prompt's tool list. The model
// finds them with search_tools and calls them with call_tool, so the list at
// the front of the prompt stays the same for the whole conversation and an
// admin installing ten plugins does not change it. On llama.cpp the tool list
// is part of the prompt prefix: any change to it is a full prefill (B0).
//
// The core (ask_user, memory, documents, run_python, web, search_tools and
// call_tool) is simply everything that is not deferred. Capabilities and
// roles still decide what a caller has at all; bans still strip first.
//
// This module only answers WHICH capabilities are deferred. Whether a request
// is actually narrowed to the core is the retrieval mode's decision
// (tools.retrieval.mode 'catalog', commit 4), so turning a capability's flag
// on changes nothing until that mode is on.
//
// A built-in's default is below. Every plugin is deferred by default: a plugin
// is the long tail by definition, and its tools arrive classed destructive
// until an admin promotes them. An admin's override (tools-storage
// getDeferralOverrides) wins either way.
// =============================================================================

/** Built-in capabilities whose tools are catalog-only unless an admin says otherwise. */
export const DEFERRED_BY_DEFAULT = Object.freeze(['file_system', 'git', 'sqlite', 'postgres', 'vault', 'scholar'])

/**
 * The capability ids that are deferred, sorted.
 *
 * @param {{ builtinIds: string[], pluginIds: string[], overrides?: Record<string, unknown> }} facts
 *   builtinIds: every built-in capability id; pluginIds: every installed
 *   plugin's id; overrides: id → boolean from tools.json (anything that is
 *   not a boolean is ignored, so a hand-edited value cannot widen or narrow
 *   by accident)
 * @returns {string[]}
 */
export function deferredCapabilities({ builtinIds, pluginIds, overrides = {} }) {
  const out = []
  const seen = new Set()
  const consider = (id, byDefault) => {
    if (typeof id !== 'string' || seen.has(id)) return
    seen.add(id)
    const o = overrides?.[id]
    if (typeof o === 'boolean' ? o : byDefault) out.push(id)
  }
  for (const id of builtinIds ?? []) consider(id, DEFERRED_BY_DEFAULT.includes(id))
  for (const id of pluginIds ?? []) consider(id, true)
  return out.sort()
}

/**
 * Is this tool deferred under this config?
 *
 * @param {string} name the tool's function name
 * @param {{ deferredCapabilities?: string[] } | null | undefined} cfg the gateway config
 * @param {(name: string) => string | null} capabilityOf tools-definitions capabilityForTool
 */
export function isDeferredTool(name, cfg, capabilityOf) {
  const list = cfg?.deferredCapabilities
  if (!Array.isArray(list) || list.length === 0) return false
  const cap = capabilityOf(name)
  return cap !== null && list.includes(cap)
}

/** At most this many names under one built-in capability in the prompt. */
export const CATALOG_NAMES_PER_GROUP = 8
/** At most this many plugin tool names in the prompt, all plugins together. */
export const CATALOG_PLUGIN_NAMES = 10

/**
 * What the catalog holds for THIS request, for the system prompt's catalog
 * line (2026-11-18): the tools the catalog took out of the list, grouped by
 * capability. The prompt said how to search but not what there was to find,
 * and a small model cannot tell when a search is worth trying: Ornith, asked
 * to delete a File System file, said it had no delete tool without searching
 * (4 such runs in the 8.4 bench).
 *
 * Built from the names actually removed from this request, after bans, so it
 * never names a tool the caller could not reach. The same request shape gives
 * the same groups, so the prompt prefix stays the same for the conversation.
 * Built-in capabilities are labelled by name; plugins have no label of their
 * own, so their tools are pooled and named without the "<pluginId>__" prefix.
 *
 * @param {string[]} names the tool names the catalog removed
 * @param {(name: string) => string | null} capabilityOf tools-definitions capabilityForTool
 * @param {(capabilityId: string) => string | null} labelOf a built-in capability's name, or null for a plugin
 * @returns {{ groups: Array<{ label: string, tools: string[], more: number }>, plugins: { tools: string[], more: number } | null }}
 */
export function catalogContents(names, capabilityOf, labelOf) {
  /** @type {Map<string, { label: string, tools: string[] }>} */
  const byCap = new Map()
  const pluginTools = []
  for (const name of names ?? []) {
    if (typeof name !== 'string' || !name) continue
    const cap = capabilityOf(name)
    const label = cap ? labelOf(cap) : null
    if (cap && label) {
      if (!byCap.has(cap)) byCap.set(cap, { label, tools: [] })
      byCap.get(cap).tools.push(name)
    } else {
      const sep = name.indexOf('__')
      pluginTools.push(sep > 0 ? name.slice(sep + 2) : name)
    }
  }
  const cut = (list, n) => ({ tools: list.slice(0, n), more: Math.max(0, list.length - n) })
  const groups = [...byCap.values()]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((g) => ({ label: g.label, ...cut(g.tools, CATALOG_NAMES_PER_GROUP) }))
  const unique = [...new Set(pluginTools)]
  return { groups, plugins: unique.length ? cut(unique, CATALOG_PLUGIN_NAMES) : null }
}
