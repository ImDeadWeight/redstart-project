'use strict'

// =============================================================================
// Redstart Nest — infrastructure egress (TLS plan C10)
// =============================================================================
// GET /egress and the system prompt's data-handling block describe where
// CONVERSATION data can go (system-prompt.mjs deriveEgressFacts). Some traffic
// is not conversation data at all: HTTPS's name provider (the LAN address,
// when it changes) and Let's Encrypt (a verification record, about every 60
// days). That goes in a SEPARATE `infrastructure` list, so the conversation
// claim stays exact, and it is NOT given to the model, which has nothing to
// say about it.
//
// A registry rather than an import: lan.mjs owns the answer and itself
// imports the gateway, so the gateway reading lan.mjs directly would be a
// cycle. lan.mjs registers a provider at init; with none registered the
// list is empty.
// =============================================================================

let provider = () => []

/** @param {() => Array<{ host: string, purpose: string }>} fn */
export function setInfrastructureEgress(fn) {
  provider = typeof fn === 'function' ? fn : () => []
}

/** @returns {Array<{ host: string, purpose: string }>} */
export function infrastructureEgress() {
  try {
    const list = provider()
    return Array.isArray(list) ? list.map(({ host, purpose }) => ({ host: String(host), purpose: String(purpose) })) : []
  } catch {
    return []
  }
}
