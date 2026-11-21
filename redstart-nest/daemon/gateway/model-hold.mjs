'use strict'

// =============================================================================
// Redstart Nest — holding requests while the model is paused
// =============================================================================
// While image generation has the GPU (ipc/server.mjs suspendModel), there is
// no llama-server behind the gateway. Everything the gateway would forward to
// it — completions, /props, /health, and the chat UI's own static files, which
// llama-server serves with --path — waits here for the model to come back
// instead of failing with a 502. A pause lasts seconds to under a minute
// (docs/notes/image-generation-plan.md §8), so waiting is the better answer.
//
// The wait is bounded (HOLD_MS) and ends when the client hangs up. If the
// model does not come back (Stop, or a failed reload) the request gets a 503
// that says why: an OpenAI-shaped error for the API, plain text otherwise.
// =============================================================================

import { modelSuspension, whenModelReady } from '../completion-activity.mjs'

/** How long a request waits for a paused model (plan decision U-IG5). */
export const HOLD_MS = 180_000

/**
 * Resolve true when the request may be forwarded now; false when it has been
 * answered here (a 503) or the client left. Immediate when nothing is paused.
 */
export async function holdWhilePaused(req, res, { holdMs = HOLD_MS } = {}) {
  if (!modelSuspension()) return true
  const ac = new AbortController()
  const onClose = () => ac.abort()
  res.on('close', onClose)
  let ready
  try {
    ready = await whenModelReady(holdMs, ac.signal)
  } finally {
    res.off('close', onClose)
  }
  if (ready) return true
  if (res.destroyed || res.writableEnded) return false
  const message = modelSuspension()
    ? 'The model is paused while an image is generated, and it is taking longer than expected. Try again shortly.'
    : 'The model is not running: it was stopped, or did not reload after image generation.'
  const isApi = (req.url || '').startsWith('/v1/') || req.method === 'POST'
  res.writeHead(503, {
    'Content-Type': isApi ? 'application/json' : 'text/plain',
    'Access-Control-Allow-Origin': '*',
    'Retry-After': '10',
  })
  res.end(isApi ? JSON.stringify({ error: { message, type: 'model_paused', code: 503 } }) : message)
  return false
}
