'use strict'

// =============================================================================
// Redstart Nest — Gateway POST /v1/chat/completions
// =============================================================================
// The one route the gateway rewrites rather than proxies: the body goes
// through prepareCompletion (the redstart_* fields, bans, the catalog, the
// composed prompt, the wire cost), then to llama-server, with the retrieval
// report's headers when the caller asked for them. Split out of
// tools-gateway.mjs's startGateway in master plan Phase 4, like the other
// gateway/*-routes.mjs.
//
// prepareCompletion is handed in rather than imported: it stays in
// tools-gateway.mjs, which the daemon's task runner also calls, and this
// module is imported by it.
//
// Identity is the caller's to supply, already authenticated: account and
// surface come from the credential (spec §8), never from a header.
// X-Redstart-Surface stays accepted and inert; the connector-contract suite
// asserts that.
// =============================================================================

import { forwardModified } from './upstream.mjs'

/** Is this the completions route? */
export function isCompletionRoute(req) {
  return req.method === 'POST' && req.url.startsWith('/v1/chat/completions')
}

// Header names of the retrieval report, also listed in
// Access-Control-Expose-Headers so a browser client (chat-ui on another
// origin) can read them.
export const RETRIEVAL_REPORT_HEADERS = Object.freeze({
  sent: 'x-redstart-tools-sent',
  filtered: 'x-redstart-tools-filtered',
  retrieval: 'x-redstart-retrieval',
  config: 'x-redstart-retrieval-config',
  // The tool-text arm the prompt used (tool-text-arms.mjs, an experiment).
  arm: 'x-redstart-tool-text-arm',
})

/** How much system prompt the gateway added to this request, in characters. */
export const SYSTEM_PROMPT_CHARS_HEADER = 'x-redstart-system-prompt-chars'

/**
 * Sent on every completion, report or not: the client sizes its context
 * budget over the messages it wrote, and the gateway prepends its own
 * composed prompt (identity, policy, capabilities, memories) that the client
 * never sees. On a 4,096-token profile that and the tool list can be 2,000+
 * tokens, so a request overflowed while the client's budget still showed
 * room. Characters, not tokens: the gateway has no tokenizer.
 *
 * @param {{ systemPromptChars?: number }|null|undefined} wire
 * @returns {Record<string, string>}
 */
export function systemPromptHeaders(wire) {
  const chars = wire?.systemPromptChars
  return Number.isFinite(chars) ? { [SYSTEM_PROMPT_CHARS_HEADER]: String(chars) } : {}
}

/** The two header sets of a response, with one Access-Control-Expose-Headers naming every header in both. */
export function completionResponseHeaders(wire) {
  const headers = { ...systemPromptHeaders(wire), ...retrievalReportHeaders(wire) }
  const exposed = Object.keys(headers).filter((h) => h !== 'Access-Control-Expose-Headers')
  if (exposed.length) headers['Access-Control-Expose-Headers'] = exposed.join(', ')
  return headers
}

/**
 * The response headers that answer `redstart_retrieval_report: true`: the
 * tools forwarded, by name; whether retrieval removed any; and whether it ran
 * on this request at all (`on`: enabled, not opted out, tools to choose from).
 * The last is separate because "kept everything" and "off" both remove
 * nothing, and the bench must tell them apart. Empty when the caller did not
 * ask, so an ordinary response is unchanged.
 *
 * Names are comma-separated and each one percent-encoded, so an MCP tool name
 * with a comma or a non-ASCII character cannot break the list or the header.
 * Ordinary names (letters, digits, `_`, `-`) read as they are.
 *
 * Only `wire` is read, which prepareCompletion builds after bans and the
 * catalog, so a banned tool can never appear here.
 *
 * @param {{ report?: boolean, toolNamesSent?: string[], toolsRemoved?: boolean, filtered?: boolean, retrievalConfig?: string|null }|null|undefined} wire
 * @returns {Record<string, string>}
 */
export function retrievalReportHeaders(wire) {
  if (!wire?.report) return {}
  const names = Array.isArray(wire.toolNamesSent) ? wire.toolNamesSent : []
  return {
    [RETRIEVAL_REPORT_HEADERS.sent]: names.map(encodeURIComponent).join(','),
    [RETRIEVAL_REPORT_HEADERS.filtered]: wire.toolsRemoved ? '1' : '0',
    [RETRIEVAL_REPORT_HEADERS.retrieval]: wire.filtered ? 'on' : 'off',
    // The settings in effect (benchmarks H1), so a bench row records what ran
    // instead of trusting its label. `off` when retrieval did not run.
    [RETRIEVAL_REPORT_HEADERS.config]: typeof wire.retrievalConfig === 'string' ? wire.retrievalConfig : 'off',
    [RETRIEVAL_REPORT_HEADERS.arm]: wire.toolTextArm ?? 'a',
    'Access-Control-Expose-Headers': Object.values(RETRIEVAL_REPORT_HEADERS).join(', '),
  }
}

/**
 * Answer one completions request.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {{
 *   internalPort: number,
 *   account: any, surface: any, effectiveConfig: any, accountId: any,
 *   prepareCompletion: (parsed: any, facts: object) => Promise<{ parsed: any, wire: any }>,
 * }} ctx account is null when auth is off: the composer degrades to a
 *   date-only session block rather than failing.
 */
export async function handleCompletionRoute(req, res, { internalPort, account, surface, effectiveConfig, accountId, prepareCompletion }) {
  let rawBody = ''
  for await (const chunk of req) rawBody += chunk

  let parsed
  try { parsed = JSON.parse(rawBody) } catch {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ error: { message: 'Bad request: invalid JSON', type: 'invalid_request_error' } }))
    return
  }

  // The browser's IANA zone, so the prompt states the USER'S date rather
  // than the UTC one. A header, not a body field, so every completions
  // caller in chat-ui (chat, titles, compaction) sends it from one place.
  // Unvalidated here: session-time.mjs validates it before it reaches
  // the prompt, and an invalid value degrades to the server's zone.
  const timeZone = typeof req.headers['x-redstart-timezone'] === 'string'
    ? req.headers['x-redstart-timezone']
    : null

  let wire
  ;({ parsed, wire } = await prepareCompletion(parsed, { account, surface, effectiveConfig, accountId, timeZone }))

  try {
    forwardModified(res, internalPort, parsed, completionResponseHeaders(wire))
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: err.message, type: 'internal_error' } }))
    }
  }
}
