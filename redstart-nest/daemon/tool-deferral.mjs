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
