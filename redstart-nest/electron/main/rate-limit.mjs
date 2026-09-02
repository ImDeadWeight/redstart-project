'use strict'

// =============================================================================
// Redstart Nest — Rate limiting
// =============================================================================
// For the two control-plane routes that are reachable WITHOUT a credential and
// hand one out if you get them right: login, and the bootstrap token. Everything
// else on that listener is already behind an owner session, where a rate limit
// would be protecting an attacker who has already won.
//
// A fixed window, not a token bucket. The thing being bounded is guessing
// attempts against a secret, and for that the two behave the same; a fixed
// window is a Map and a timestamp, and this codebase hand-rolls its primitives
// by preference (path-scope.mjs, external-mcp-url.mjs) rather than shipping a
// dependency for a dozen lines.
//
// KEYED BY REMOTE ADDRESS, WHICH IS NOT A STRONG IDENTITY, and the limit is
// chosen knowing that. A LAN attacker can change source address, and a reverse
// proxy (the documented way to expose this — plan §3.3) makes every request
// arrive from loopback, collapsing all callers onto one bucket. That second case
// is the awkward one and it is deliberately not solved by trusting
// X-Forwarded-For: a header the client controls is not an identity, and behind
// no proxy it is a way to get a fresh bucket per request. So this is a brake on
// automated guessing, not an access control. What actually makes the secrets
// unguessable is their entropy — 32 CSPRNG bytes for the token, scrypt for the
// password — and the limit exists so a slow attempt is also a loud one.
//
// No cleanup timer: entries are pruned on the next call for the same key, and
// the whole map is dropped when a window's worth of keys goes quiet. The set of
// addresses that can reach a loopback-or-LAN listener is small and bounded.
// =============================================================================

/**
 * @param {object} options
 * @param {number} options.limit    attempts permitted per window
 * @param {number} options.windowMs window length
 */
export function createRateLimiter({ limit, windowMs }) {
  const hits = new Map() // key -> { count, resetAt }

  return {
    /**
     * Record an attempt and say whether it is permitted.
     *
     * @returns {{ ok: boolean, retryAfterMs: number }}
     */
    check(key) {
      const now = Date.now()
      const id = typeof key === 'string' && key ? key : 'unknown'
      const entry = hits.get(id)

      if (!entry || entry.resetAt <= now) {
        hits.set(id, { count: 1, resetAt: now + windowMs })
        return { ok: true, retryAfterMs: 0 }
      }

      entry.count++
      if (entry.count > limit) return { ok: false, retryAfterMs: entry.resetAt - now }
      return { ok: true, retryAfterMs: 0 }
    },

    /** Forget an address's attempts — called on success, so a legitimate user
     *  who mistyped twice is not still carrying it an hour later. */
    clear(key) {
      hits.delete(typeof key === 'string' && key ? key : 'unknown')
    },

    /** Test seam, and the reset a rotation wants. */
    reset() {
      hits.clear()
    },
  }
}
