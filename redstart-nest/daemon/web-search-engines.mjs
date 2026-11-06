'use strict'

// =============================================================================
// Redstart Nest — general web search engines (web_search source "web")
// =============================================================================
// THIS REVERSES A STATED DESIGN CHOICE, so it's recorded where the choice was
// made. web-fetch-tool.mjs's web_search was built to use no third-party search
// engine: each source is queried through its own first-party API. The "web"
// source sends the model's query to a general engine chosen by the admin:
//
//   searxng — a self-hosted SearXNG instance at a URL the admin gives. The
//             query reaches infrastructure the admin runs; SearXNG then
//             forwards it to whichever upstream engines it is configured with.
//   brave   — the Brave Search API, with a key held in secrets.mjs. Hosted:
//             the query leaves the network.
//
// OFF BY DEFAULT ('none'), and off is enforced in three places, not one (plan
// D1): the source is stripped from the schema, refused on the call path, and
// narrowable by role. See web-fetch-tool.mjs and permissions.mjs.
//
// SPLIT FOR TESTING: buildRequest() and parseResults() are pure. search() is
// the only function that touches the network, and the security suite drives it
// against a stub server through an injected fetch.
// =============================================================================

export const ENGINE_KINDS = ['none', 'searxng', 'brave']

export const ENGINE_LABELS = {
  searxng: 'SearXNG',
  brave: 'Brave Search',
}

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'

// Snippets are text from pages nobody reviewed, delivered straight into the
// model's context: the cheapest prompt-injection channel there is. Kept short
// so a result list cannot carry an essay of instructions, and the tool's
// description tells the model to fetch a page before quoting it.
export const SNIPPET_MAX_CHARS = 300

const TIMEOUT_MS = 12000
const USER_AGENT = 'Redstart/1.0 (local AI assistant)'

/** Is this an http(s) URL? Used for the SearXNG base URL and every result URL. */
export function isHttpUrl(value) {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * The engine a profile actually has, from the stored choice and connection.
 * An engine that is chosen but not configured resolves to 'none': a missing
 * key must read as "off", never as a schema advertising a source that fails
 * on every call.
 *
 * @returns {{ kind: 'none' } | { kind: 'searxng', url: string } | { kind: 'brave', apiKey: string }}
 */
export function resolveEngine(choice, connection) {
  if (choice === 'searxng' && isHttpUrl(connection?.searxngUrl)) {
    return { kind: 'searxng', url: connection.searxngUrl }
  }
  if (choice === 'brave' && typeof connection?.braveApiKey === 'string' && connection.braveApiKey) {
    return { kind: 'brave', apiKey: connection.braveApiKey }
  }
  return { kind: 'none' }
}

/** The host a query is sent to, for the prompt's disclosure and the UI. */
export function engineHost(engine) {
  if (engine?.kind === 'searxng') {
    try { return new URL(engine.url).host } catch { return null }
  }
  if (engine?.kind === 'brave') return new URL(BRAVE_ENDPOINT).host
  return null
}

/**
 * The HTTP request for one search. Pure.
 * `count` is how many results to ask for (more than shown, when the whitelist
 * will filter them).
 */
export function buildRequest(engine, query, count) {
  if (engine?.kind === 'searxng') {
    const url = new URL('search', engine.url.endsWith('/') ? engine.url : `${engine.url}/`)
    url.searchParams.set('q', query)
    url.searchParams.set('format', 'json')
    return { url: url.toString(), headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } }
  }
  if (engine?.kind === 'brave') {
    const url = new URL(BRAVE_ENDPOINT)
    url.searchParams.set('q', query)
    url.searchParams.set('count', String(Math.min(Math.max(count, 1), 20)))
    return {
      url: url.toString(),
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', 'X-Subscription-Token': engine.apiKey },
    }
  }
  throw new Error('No web search engine is configured.')
}

// Entities decoded ONCE (&amp; last, as in web-fetch-tool's decodeHtml), THEN
// tags stripped until none are left, then any stray angle bracket dropped.
// The order matters: stripping first and decoding after turned
// "&lt;script&gt;" back into a literal <script>, and a single strip pass
// leaves "<scr<b>ipt>" as "<script>". A snippet is plain text, so a lone
// "<" or ">" costs nothing to lose.
export function cleanSnippet(text) {
  let plain = String(text ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  let previous
  do {
    previous = plain
    plain = plain.replace(/<[^<>]*>/g, '')
  } while (plain !== previous)
  plain = plain.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim()
  return plain.length > SNIPPET_MAX_CHARS ? `${plain.slice(0, SNIPPET_MAX_CHARS - 1)}…` : plain
}

/**
 * An engine's JSON response as [{ title, url, snippet }]. Pure.
 * Results without an http(s) URL are dropped: the model is told to web_fetch
 * a result next, and a javascript: or file: link has no business there.
 */
export function parseResults(engine, body) {
  const raw = engine?.kind === 'searxng'
    ? (Array.isArray(body?.results) ? body.results.map(r => ({ title: r?.title, url: r?.url, snippet: r?.content })) : [])
    : engine?.kind === 'brave'
      ? (Array.isArray(body?.web?.results) ? body.web.results.map(r => ({ title: r?.title, url: r?.url, snippet: r?.description })) : [])
      : []
  return raw
    .filter(r => typeof r.url === 'string' && isHttpUrl(r.url))
    .map(r => ({ title: cleanSnippet(r.title) || r.url, url: r.url, snippet: cleanSnippet(r.snippet) }))
}

/**
 * Run one search. The only network call in this module.
 *
 * redirect: 'error' — the SearXNG URL is an admin trust decision (often a LAN
 * host, so no SSRF guard applies), but that trust covers the URL they gave,
 * not wherever it might bounce the request to.
 *
 * Errors say what to try next, since the admin is the one who can fix them
 * and the model relays the message.
 */
export async function search(engine, query, count, { fetchImpl = fetch } = {}) {
  const { url, headers } = buildRequest(engine, query, count)
  let resp
  try {
    resp = await fetchImpl(url, { headers, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (err) {
    throw new Error(`${ENGINE_LABELS[engine.kind]} could not be reached (${err.message}).`)
  }
  if (engine.kind === 'searxng' && resp.status === 403) {
    throw new Error('SearXNG refused the request (HTTP 403). Its settings.yml must list "json" under search.formats.')
  }
  if (engine.kind === 'brave' && (resp.status === 401 || resp.status === 403)) {
    throw new Error(`Brave Search rejected the API key (HTTP ${resp.status}).`)
  }
  if (engine.kind === 'brave' && resp.status === 429) {
    throw new Error('Brave Search rate limit reached (HTTP 429). Try again later.')
  }
  if (!resp.ok) throw new Error(`${ENGINE_LABELS[engine.kind]} returned HTTP ${resp.status}.`)
  let body
  try { body = await resp.json() } catch { throw new Error(`${ENGINE_LABELS[engine.kind]} returned a response that is not JSON.`) }
  return parseResults(engine, body)
}
