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
//   - the port of the llama-server behind the gateway, for those calls;
//   - whether the model is PAUSED for image generation (ipc/server.mjs
//     suspendModel), and a promise for when it is back, which the gateway
//     holds completions on instead of refusing them. While paused the
//     upstream port reads null, so tasks wait for a model and the memory
//     review stays idle without knowing why.
// =============================================================================

let inFlight = 0
let upstreamPort = null

const beginListeners = new Set()

/**
 * Be told each time a user completion starts. The memory review checks for
 * zero only when it begins; a review already running when someone sends a
 * message shared the GPU with that reply (47 → 29 tokens/s on 2026-11-25) and
 * took its cached slot. This lets it stop instead. Returns the unsubscribe.
 */
export function onCompletionBegin(fn) {
  beginListeners.add(fn)
  return () => beginListeners.delete(fn)
}

/** Call when a completion starts; returns the function that ends it (idempotent). */
export function beginCompletion() {
  inFlight++
  for (const fn of beginListeners) {
    try { fn() } catch { /* a listener's failure is its own */ }
  }
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

// ---------------------------------------------------------------------------
// The model paused for image generation
// ---------------------------------------------------------------------------

let suspension = null
const readyWaiters = new Set()

/** Mark the model paused. `info` is { since, reason }. */
export function beginModelSuspension(info) { suspension = { ...info } }

/** The current pause, or null. */
export function modelSuspension() { return suspension }

/**
 * End the pause and answer everyone waiting: true when the model is back,
 * false when it is not coming back (stopped, or the reload failed).
 */
export function endModelSuspension(resumed) {
  suspension = null
  for (const done of [...readyWaiters]) done(resumed === true)
  readyWaiters.clear()
}

/**
 * Resolves true once the model is serving, false on timeout, abort, or a
 * pause that ended without the model. Immediately true when not paused.
 */
export function whenModelReady(timeoutMs, signal) {
  if (!suspension) return Promise.resolve(true)
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const done = (value) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      readyWaiters.delete(done)
      resolve(value)
    }
    const onAbort = () => done(false)
    const timer = setTimeout(() => done(false), timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    readyWaiters.add(done)
  })
}
