'use strict'

// =============================================================================
// Redstart Nest — what the gateway's completions are doing right now
// =============================================================================
// Two facts Nest's own background model calls need, kept apart from
// tools-gateway.mjs so a caller (memory-review.mjs) does not import the
// gateway, which imports the routes that call it.
//
//   - how many user completions are being generated now: the automatic
//     memory review runs only at zero, so it never competes with someone
//     waiting on a reply (projects-plan D16);
//   - the port of the llama-server behind the gateway, for those calls.
// =============================================================================

let inFlight = 0
let upstreamPort = null

/** Call when a completion starts; returns the function that ends it (idempotent). */
export function beginCompletion() {
  inFlight++
  let open = true
  return () => {
    if (!open) return
    open = false
    inFlight--
  }
}

export function completionsInFlight() { return inFlight }

export function setUpstreamPort(port) { upstreamPort = port ?? null }
export function getUpstreamPort() { return upstreamPort }
