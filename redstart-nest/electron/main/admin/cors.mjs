'use strict'

// =============================================================================
// Control-plane CORS — an explicit origin allowlist, off by default
// =============================================================================
// Phase 8A.6. The admin listener has never sent a CORS header, and that is
// exactly right for the way it is used today: the browser panel is served BY
// the daemon, so every request it makes is same-origin, and Phase 6's Vite dev
// proxy sidesteps the question during local UI development rather than
// answering it.
//
// What changes with 8A is that a daemon can now run somewhere else. A client
// that did not come from this origin — an Electron launcher pointed at a
// remote box, a panel served from a different host — is a cross-origin caller,
// and the browser will refuse its requests before the daemon ever sees them.
//
// THE DEFAULT IS EMPTY, and empty means NO CORS HEADERS AT ALL — byte-for-byte
// today's behaviour. This is opt-in machinery for a deployment that needs it,
// not a loosening applied to every install.
//
// Three rules, each of which is a way this could have been got wrong:
//
//   1. NEVER `*`. A wildcard on a surface that spawns processes would let any
//      page on the internet a logged-in admin happens to visit make
//      authenticated calls, provided it can get a token — and this listener
//      authenticates with a bearer header, which is precisely what an
//      allow-all policy plus `Access-Control-Allow-Headers: Authorization`
//      makes reachable. Refused at validation, not merely discouraged.
//   2. NEVER reflect the request's Origin. Reflecting is the wildcard wearing
//      a hat: every origin is allowed, and the response merely looks specific.
//      An origin is echoed only after it has been matched against the list.
//   3. An origin that is NOT on the list gets no CORS headers and is otherwise
//      handled completely normally — the request still authenticates, and is
//      still refused if it cannot. CORS is a browser-side control, so treating
//      a disallowed origin as an authorization failure would only mislead:
//      a non-browser caller ignores these headers entirely and always has.
// =============================================================================

/**
 * Validate and normalise a configured allowlist.
 *
 * @param {unknown} value  whatever settings.json holds
 * @returns {{ origins: string[], rejection: string|null }}
 */
export function parseAllowedOrigins(value) {
  if (value === undefined || value === null) return { origins: [], rejection: null }
  if (!Array.isArray(value)) {
    return { origins: [], rejection: 'Allowed origins must be a list.' }
  }

  const origins = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim()) {
      return { origins: [], rejection: 'Every allowed origin must be a non-empty string.' }
    }
    const origin = entry.trim()
    if (origin === '*') {
      return { origins: [], rejection: 'A wildcard origin is not allowed on the control plane.' }
    }
    let parsed
    try {
      parsed = new URL(origin)
    } catch {
      return { origins: [], rejection: `Not a valid origin: ${origin}` }
    }
    // An Origin header is scheme://host[:port] and nothing else. Accepting a
    // path here would produce a value that can never match a real request and
    // would read, to whoever configured it, as though it had been accepted.
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return { origins: [], rejection: `An origin must have no path: ${origin}` }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { origins: [], rejection: `An origin must be http or https: ${origin}` }
    }
    origins.push(parsed.origin)
  }
  // A rejection is all-or-nothing on purpose: silently dropping the one bad
  // entry out of five would leave an admin believing a list they cannot see is
  // in force.
  return { origins: [...new Set(origins)], rejection: null }
}

/**
 * The CORS headers for one request, or an empty object when none apply.
 *
 * @param {string|undefined} requestOrigin the request's Origin header
 * @param {string[]} allowed the validated allowlist
 */
export function corsHeaders(requestOrigin, allowed) {
  if (!requestOrigin || !allowed?.length) return {}
  if (!allowed.includes(requestOrigin)) return {}
  return {
    'Access-Control-Allow-Origin': requestOrigin,
    // Without this, a cache that saw one origin's response could hand it to
    // another origin — the allowlist would hold, and the cache would not.
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    // Authorization because that is how this listener authenticates; the SSE
    // feed rides on the same header (src/api/http.ts uses fetch rather than
    // EventSource for exactly that reason).
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
  }
}

/**
 * Whether this request is a CORS preflight, which must be answered BEFORE the
 * auth gate: a preflight carries no credentials by definition, so gating it
 * would 401 every cross-origin request before the real one was ever sent.
 * Answering it leaks only whether an origin is allowed — which that origin
 * finds out either way the moment it makes the real call.
 */
export function isPreflight(req) {
  return req.method === 'OPTIONS' && !!req.headers['origin']
    && !!req.headers['access-control-request-method']
}
