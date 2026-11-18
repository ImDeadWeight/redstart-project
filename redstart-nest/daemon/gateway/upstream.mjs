'use strict'

// =============================================================================
// Redstart Nest — the gateway's side of llama-server
// =============================================================================
// Forwarding a rewritten completions request, and piping everything else
// through, to llama-server on the internal port (bound to 127.0.0.1 only).
// Split out of tools-gateway.mjs in master plan Phase 4, so the completions
// route (completion-route.mjs) and the catch-all passthrough share it without
// importing the gateway; tools-gateway.mjs re-exports what it exported.
// =============================================================================

import * as http from 'http'
import { beginCompletion } from '../completion-activity.mjs'

// llama-server reflects the request's Origin back into its own
// Access-Control-Allow-Origin header. If we spread its headers and then also set
// our own '*', the response carries TWO values for that header (the reflected
// origin AND '*') — which browsers reject as invalid CORS, silently blocking
// every cross-origin call from a UI served on a different origin (Twig's file
// server, the web dev server). Strip any upstream CORS-origin header
// (case-insensitively) so the gateway emits exactly one value.
function withoutUpstreamCors(headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'access-control-allow-origin') continue
    out[k] = v
  }
  return out
}

// ---------------------------------------------------------------------------
// Context-exceeded diagnosis.
//
// llama-server rejects a prompt larger than n_ctx with HTTP 400 and
// { error: { type: 'exceed_context_size_error', message, n_prompt_tokens,
// n_ctx } } — and in streaming mode too, because an error that is the FIRST
// result is deliberately returned as a non-stream response rather than an SSE
// frame (server-context.cpp, "in streaming mode, the first error must be
// treated as non-stream response"). A prompt too large to process always fails
// before the first token, so this rejection is always the first result.
//
// So the numbers do reach the client. What no client can know is WHY, and the
// answer is usually the same one: every enabled tool's full JSON schema rides
// on every request, so one plugin advertising forty tools can spend more of the
// window than the conversation does. llama-server cannot say that — it never
// saw a tool list, only a rendered prompt — and each client would otherwise
// have to reinvent the explanation. The gateway is the one place that knows
// both halves, so it annotates the message here, once, for every client.
//
// The count is of what was actually FORWARDED (post-ban and post-catalog), so
// the number quoted is the one that was really spent. Same chars/4 heuristic
// as estimateActiveToolTokens — a diagnosis, not an accounting.
// ---------------------------------------------------------------------------
function toolCostOf(parsed) {
  const tools = Array.isArray(parsed?.tools) ? parsed.tools : []
  if (tools.length === 0) return null
  return { count: tools.length, approxTokens: Math.ceil(JSON.stringify(tools).length / 4) }
}

export function annotateContextError(body, cost) {
  // Anything unrecognised is returned byte-identical: this must never be able
  // to turn an upstream error into a different one, or a parse failure into a
  // gateway failure.
  if (!cost) return body
  let parsedBody
  try { parsedBody = JSON.parse(body) } catch { return body }
  if (parsedBody?.error?.type !== 'exceed_context_size_error') return body
  if (typeof parsedBody.error.message !== 'string') return body

  const { count, approxTokens } = cost
  parsedBody.error.message +=
    ` About ${approxTokens.toLocaleString()} of those tokens are the ${count} tool definition${count === 1 ? '' : 's'}` +
    ' sent with this request — every enabled tool\'s full schema is included in every message.' +
    ' Turning off tools you are not using, or raising the context size, both free up room.'
  return JSON.stringify(parsedBody)
}

/**
 * Forward a modified completions request to llama-server, piping the response
 * back unchanged — streaming SSE and non-streaming JSON alike.
 * `extraHeaders` are added to the response on every path that answers it
 * from upstream (the retrieval report).
 */
export function forwardModified(res, internalPort, parsed, extraHeaders = {}) {
  // Every user completion passes through here, so this is where "is the model
  // busy" is counted (completion-activity.mjs; the memory review waits for 0).
  const done = beginCompletion()
  res.on('close', done)
  res.on('finish', done)
  const payload = JSON.stringify(parsed)
  const toolCost = toolCostOf(parsed)
  const options = {
    hostname: '127.0.0.1',
    port: internalPort,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
    timeout: 180000,
  }

  const proxyReq = http.request(options, proxyRes => {
    // A 400 is small, complete, and never a stream — buffer it so the tool cost
    // can be added to the message. Every other status is piped exactly as
    // before, so nothing about the streaming path changes.
    if (proxyRes.statusCode === 400 && toolCost) {
      let raw = ''
      proxyRes.setEncoding('utf8')
      proxyRes.on('data', chunk => { raw += chunk })
      proxyRes.on('end', () => {
        const out = annotateContextError(raw, toolCost)
        const headers = withoutUpstreamCors(proxyRes.headers)
        // The body length changed, so the upstream's own value would truncate
        // the response. Drop every spelling of it and let Node recompute.
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === 'content-length') delete headers[key]
        }
        res.writeHead(400, { ...headers, ...extraHeaders, 'Access-Control-Allow-Origin': '*' })
        res.end(out)
      })
      // A truncated error response must still terminate the client's request.
      proxyRes.on('error', () => { if (!res.writableEnded) res.end(raw) })
      return
    }

    res.writeHead(proxyRes.statusCode, {
      ...withoutUpstreamCors(proxyRes.headers),
      ...extraHeaders,
      'Access-Control-Allow-Origin': '*',
    })
    proxyRes.pipe(res)
  })

  proxyReq.on('error', err => {
    if (res.destroyed) return // the client left; cancelUpstreamOnHangUp destroyed us
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' })
      res.end(`Gateway error: ${err.message}`)
    }
  })
  cancelUpstreamOnHangUp(res, proxyReq)
  proxyReq.write(payload)
  proxyReq.end()
}

/**
 * When the client goes away before the reply is finished, close our own
 * request to llama-server too.
 *
 * llama-server cancels a task only when ITS connection closes. Without this,
 * a client that disconnected (Stop in the chat UI, a closed tab, a script
 * interrupted, the agent bench's time limit) stopped receiving the reply, but
 * the generation behind it ran on to the end or until the context filled.
 * Found by the agent bench, 2026-11-11: two stopped runs left a small model
 * looping for 8 minutes (12k and 10k tokens). That filled the shared KV cache
 * ("failed to find a memory slot"), slowed every other request about
 * threefold, and finally failed all live requests with "Context size has
 * been exceeded".
 *
 * `close` after `finish` is the normal end of a reply and leaves the request
 * alone: by then the upstream response has been fully piped.
 *
 * @param {import('http').ServerResponse} res
 * @param {import('http').ClientRequest} proxyReq
 */
export function cancelUpstreamOnHangUp(res, proxyReq) {
  res.on('close', () => {
    if (res.writableFinished) return
    proxyReq.destroy()
  })
}

/** Passthrough proxy for every non-completions path. */
export function passthrough(req, res, internalPort) {
  const options = {
    hostname: '127.0.0.1',
    port: internalPort,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${internalPort}` },
  }

  const proxyReq = http.request(options, proxyRes => {
    res.writeHead(proxyRes.statusCode, {
      ...withoutUpstreamCors(proxyRes.headers),
      'Access-Control-Allow-Origin': '*',
    })
    proxyRes.pipe(res)
  })

  req.pipe(proxyReq)
  // The same leak as completions: llama-server's own /completion and
  // /v1/completions stream through here.
  cancelUpstreamOnHangUp(res, proxyReq)
  proxyReq.on('error', err => {
    if (res.destroyed) return
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' })
      res.end(`Gateway error: ${err.message}`)
    }
  })
}
