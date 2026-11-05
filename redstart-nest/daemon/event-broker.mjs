'use strict'

// =============================================================================
// Redstart Nest — the shared event broker
// =============================================================================
// Eight call sites — six in ipc/server.mjs, one each in ipc/models.mjs and
// ipc/plugins.mjs — used to independently decide that `getMainWindow()`'s
// `webContents.send(...)` was the only possible reader of a server log line,
// a tokens/minute tick, or install/download progress. That was true only
// because nothing else had ever been able to ask. Now that a browser admin
// can (admin/events-routes.mjs's SSE route), those eight sites publish here
// instead, and the Electron window becomes one subscriber among others —
// registered once, from index.mjs, rather than special-cased at every site.
//
// No Electron import: like logger.mjs and platform-paths.mjs before it, this
// is plain Node so the security suite can drive it directly.
// =============================================================================

const subscribers = new Set()

/**
 * Publish one event to every current subscriber. Fire-and-forget: a
 * subscriber that throws (a dead SSE connection whose cleanup raced this
 * call, say) must not stop the next subscriber, or the server's own log line
 * from reaching the window because an unrelated browser tab misbehaved.
 */
export function publish(channel, payload) {
  for (const fn of subscribers) {
    try {
      fn(channel, payload)
    } catch (err) {
      console.warn('[event-broker] a subscriber threw:', err.message)
    }
  }
}

/**
 * Subscribe to every event published. Returns an unsubscribe function —
 * callers (the SSE route, one per connection) call it on disconnect so a
 * closed browser tab does not accumulate as a leaked listener over a
 * long-running daemon's lifetime.
 */
export function subscribeToEvents(fn) {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

/** Test/diagnostic hook — how many live subscribers there are right now. */
export function subscriberCount() {
  return subscribers.size
}
