'use strict'

// =============================================================================
// Redstart Nest — Control-plane wire helpers
// =============================================================================
// The byte layer for the admin listener's routes. A deliberate sibling of
// gateway/http-json.mjs rather than a reuse of it, because the one line that
// differs is the one that matters: the gateway sends
// `Access-Control-Allow-Origin: *` on every response, and the control plane
// sends no CORS headers at all. Importing the gateway's helper would put that
// header on process-spawning routes by inheritance, which is exactly the kind of
// thing nobody notices in review.
// =============================================================================

/** Bodies are small — a config object, a plugin manifest. Anything larger is a
 *  mistake or an attempt to make the daemon hold a lot of memory for free. */
const MAX_BODY_BYTES = 2 * 1024 * 1024

export function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body ?? null)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    // Control-plane responses carry account listings and configuration. Nothing
    // in front of this should hold on to them, and nothing should guess at the
    // type of a body it was handed.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  })
  res.end(payload)
}

/**
 * Parse a JSON request body.
 *
 * @returns {Promise<object|null>} null for malformed JSON or an oversized body —
 *   callers treat both as "the request did not say anything usable", which is a
 *   400 either way, so they are deliberately not distinguished.
 */
export async function readJsonBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      req.destroy()
      return null
    }
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return null
  }
}

/**
 * The address a request came from, for rate limiting.
 *
 * `X-Forwarded-For` is deliberately NOT consulted. Behind the reverse proxy
 * that plan §3.3 documents, every request genuinely does arrive from loopback
 * and all callers share one bucket — which is a real weakness, stated in
 * rate-limit.mjs. Trusting the header instead would trade it for a worse one:
 * with no proxy in front, a client that sets its own header gets a fresh bucket
 * per request and the limit stops existing.
 */
export function remoteAddress(req) {
  return req?.socket?.remoteAddress || 'unknown'
}
