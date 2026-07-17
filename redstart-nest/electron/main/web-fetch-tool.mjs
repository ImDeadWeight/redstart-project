'use strict'

// =============================================================================
// Redstart Nest — MCP Provider: web_fetch + web_search
// =============================================================================
// web_fetch: fetches a URL and returns the ARTICLE text, extracted with
// Mozilla Readability (the Firefox Reader Mode engine, running locally) —
// so the model gets the story, not the nav menus. Falls back to tag-stripping
// for pages Readability can't parse.
//
// web_search: searches a source using that source's OWN first-party search
// API (Wikipedia OpenSearch, arXiv API, PubMed E-utilities, MDN, Stack
// Exchange). No third-party search engine is ever involved — the query goes
// only to the site being searched. Endpoints are hardcoded here; the model
// picks a source and a query, never a URL, so it cannot redirect a search
// elsewhere.
//
// Whitelist: enforced HERE, per profile. cfg.webFetch.whitelistEnabled
// (default true) restricts web_fetch to allowedBaseUrls and web_search to
// sources whose domain is allowed. With the whitelist toggled OFF, web_fetch
// may fetch any public http(s) URL — but never private/loopback/link-local
// addresses (SSRF guard: an open-web model must not be able to probe the LAN,
// the gateway itself, or a router admin page).
// =============================================================================

import { parseHTML } from 'linkedom'
import { Readability } from '@mozilla/readability'

const TOOL_NAMES = ['web_fetch', 'web_search']
const FETCH_TIMEOUT_MS = 12000
const USER_AGENT = 'Redstart/1.0 (local AI assistant)'
const SEARCH_RESULT_LIMIT = 8

// ---------------------------------------------------------------------------
// URL policy
// ---------------------------------------------------------------------------

function isAllowed(url, allowedBaseUrls) {
  if (!allowedBaseUrls?.length) return false
  try {
    const target = new URL(url)
    return allowedBaseUrls.some(base => {
      try {
        const b = new URL(base)
        return target.hostname === b.hostname || target.hostname.endsWith('.' + b.hostname)
      } catch { return false }
    })
  } catch { return false }
}

// SSRF guard for whitelist-off mode: public http(s) only. Blocks loopback,
// RFC1918 ranges, link-local, and .local names so the model can't reach the
// gateway, llama-server, or anything else on the user's network.
function isPublicHttpUrl(url) {
  let target
  try { target = new URL(url) } catch { return false }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false
  const host = target.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost')) return false
  if (host === '::1' || host === '[::1]') return false
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
    if (a === 127 || a === 10 || a === 0) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 169 && b === 254) return false
  }
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return false
  return true
}

// ---------------------------------------------------------------------------
// web_fetch — Readability extraction with tag-strip fallback
// ---------------------------------------------------------------------------

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

// Follows redirects MANUALLY so every hop is re-validated against the same
// policy as the original URL. With redirect:'follow', a whitelisted page
// could bounce the fetch to any domain (consent pages, shorteners — or, in
// open mode, a public URL redirecting to a LAN address) without the
// destination ever being checked. Each Location is validated BEFORE it is
// requested, so a disallowed hop never generates network traffic.
const MAX_REDIRECTS = 5

async function fetchPage(url, maxTokens, isUrlAllowed) {
  let current = url
  let resp
  for (let hop = 0; ; hop++) {
    resp = await fetch(current, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'manual',
    })
    if (resp.status < 300 || resp.status >= 400) break
    const location = resp.headers.get('location')
    if (!location) break
    if (hop >= MAX_REDIRECTS) throw new Error('Too many redirects')
    const next = new URL(location, current).href
    if (!isUrlAllowed(next)) {
      throw new Error(`The page redirects to "${next}", which is not an approved address`)
    }
    current = next
  }
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`)

  const contentType = resp.headers.get('content-type') || ''
  const raw = await resp.text()
  let text = raw

  if (contentType.includes('html')) {
    // Reader-mode extraction: pulls the article body and drops navigation,
    // cookie banners, and sidebars — the difference between the model reading
    // the story and reading the menu.
    try {
      const { document } = parseHTML(raw)
      const article = new Readability(document).parse()
      if (article?.textContent && article.textContent.trim().length >= 200) {
        const title = article.title ? `# ${article.title}\n\n` : ''
        const byline = article.byline ? `${article.byline}\n\n` : ''
        text = title + byline + article.textContent.replace(/\n{3,}/g, '\n\n').trim()
      } else {
        text = stripTags(raw)
      }
    } catch {
      text = stripTags(raw)
    }
  }

  const maxChars = (maxTokens ?? 2000) * 4
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + `\n\n[Content truncated at ~${maxTokens} tokens]`
  }
  return text
}

// ---------------------------------------------------------------------------
// web_search — first-party search endpoints per source
// ---------------------------------------------------------------------------

async function getJson(url) {
  const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return resp.json()
}

// Each provider: the whitelist domain it belongs to, and a search(query)
// returning "Title — URL" lines. Endpoints are OURS, not the model's — the
// model supplies only the query string, which is URL-encoded.
const SEARCH_PROVIDERS = {
  wikipedia: {
    domain: 'en.wikipedia.org',
    label: 'Wikipedia',
    async search(query) {
      const data = await getJson(`https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=${SEARCH_RESULT_LIMIT}&format=json`)
      return (data[1] || []).map((title, i) => `${title} — ${data[3][i]}`)
    },
  },
  arxiv: {
    domain: 'arxiv.org',
    label: 'arXiv',
    async search(query) {
      const resp = await fetch(`https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(`"${query}"`)}&max_results=${SEARCH_RESULT_LIMIT}`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const xml = await resp.text()
      const out = []
      for (const entry of xml.split('<entry>').slice(1)) {
        const title = (entry.match(/<title>([\s\S]*?)<\/title>/) || [])[1]?.replace(/\s+/g, ' ').trim()
        const id = (entry.match(/<id>([\s\S]*?)<\/id>/) || [])[1]?.trim()
        if (title && id) out.push(`${title} — ${id}`)
      }
      return out
    },
  },
  pubmed: {
    domain: 'pubmed.ncbi.nlm.nih.gov',
    label: 'PubMed',
    async search(query) {
      const search = await getJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmode=json&retmax=${SEARCH_RESULT_LIMIT}`)
      const ids = search?.esearchresult?.idlist || []
      if (ids.length === 0) return []
      const summary = await getJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json`)
      return ids.map(id => `${summary?.result?.[id]?.title || '(untitled)'} — https://pubmed.ncbi.nlm.nih.gov/${id}/`)
    },
  },
  mdn: {
    domain: 'developer.mozilla.org',
    label: 'MDN Web Docs',
    async search(query) {
      const data = await getJson(`https://developer.mozilla.org/api/v1/search?q=${encodeURIComponent(query)}&locale=en-US`)
      return (data?.documents || []).slice(0, SEARCH_RESULT_LIMIT).map(d => `${d.title} — https://developer.mozilla.org${d.mdn_url}`)
    },
  },
  stackoverflow: {
    domain: 'stackoverflow.com',
    label: 'Stack Overflow',
    async search(query) {
      const data = await getJson(`https://api.stackexchange.com/2.3/search/advanced?q=${encodeURIComponent(query)}&site=stackoverflow&pagesize=${SEARCH_RESULT_LIMIT}&order=desc&sort=relevance`)
      return (data?.items || []).map(i => `${decodeHtml(i.title)} — ${i.link}`)
    },
  },
}

function decodeHtml(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}

// Which search providers this profile may use: all of them when the whitelist
// is off; otherwise only those whose domain is on the approved list.
function availableSearchSources(webFetchCfg) {
  const whitelistOn = webFetchCfg?.whitelistEnabled !== false
  const keys = Object.keys(SEARCH_PROVIDERS)
  if (!whitelistOn) return keys
  return keys.filter(k => isAllowed(`https://${SEARCH_PROVIDERS[k].domain}/`, webFetchCfg?.allowedBaseUrls))
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export function toolDefs(cfg) {
  const webFetchCfg = cfg?.webFetch
  const whitelistOn = webFetchCfg?.whitelistEnabled !== false
  const fetchEnabled = whitelistOn ? !!webFetchCfg?.allowedBaseUrls?.length : !!webFetchCfg?.enabled
  if (!fetchEnabled) return []

  const defs = [{
    name: 'web_fetch',
    description: whitelistOn
      ? 'Fetch a web page from an approved source and return its main article text (extracted reader-mode style). Only domains in the approved whitelist are allowed.'
      : 'Fetch any public web page and return its main article text (extracted reader-mode style).',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: whitelistOn ? 'Full URL to fetch — must be from an approved source' : 'Full URL to fetch' },
      },
      required: ['url'],
    },
  }]

  const sources = availableSearchSources(webFetchCfg)
  if (sources.length) {
    defs.push({
      name: 'web_search',
      description: `Search a source using its own search API and get back result titles with URLs (then use web_fetch to read one). Available sources: ${sources.map(s => `"${s}" (${SEARCH_PROVIDERS[s].label})`).join(', ')}.`,
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: sources, description: 'Which source to search' },
          query: { type: 'string', description: 'Search terms' },
        },
        required: ['source', 'query'],
      },
    })
  }
  return defs
}

export async function callTool(name, args, cfg) {
  if (!TOOL_NAMES.includes(name)) return null

  const webFetchCfg = cfg?.webFetch
  const whitelistOn = webFetchCfg?.whitelistEnabled !== false
  const fetchEnabled = whitelistOn ? !!webFetchCfg?.allowedBaseUrls?.length : !!webFetchCfg?.enabled
  if (!fetchEnabled) {
    return { isError: true, content: [{ type: 'text', text: 'Web access is not enabled.' }] }
  }

  if (name === 'web_search') {
    const { source, query } = args || {}
    const sources = availableSearchSources(webFetchCfg)
    if (!source || !sources.includes(source)) {
      return { isError: true, content: [{ type: 'text', text: `Unknown or unavailable search source. Available: ${sources.join(', ') || 'none'}` }] }
    }
    if (!query || typeof query !== 'string' || !query.trim()) {
      return { isError: true, content: [{ type: 'text', text: 'Missing required argument: query' }] }
    }
    try {
      const results = await SEARCH_PROVIDERS[source].search(query.trim())
      if (!results.length) return { content: [{ type: 'text', text: `No results on ${SEARCH_PROVIDERS[source].label} for "${query}".` }] }
      return { content: [{ type: 'text', text: results.join('\n') + '\n\nUse web_fetch with one of these URLs to read the full page.' }] }
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `Search error (${source}): ${err.message}` }] }
    }
  }

  // web_fetch
  const url = args?.url
  if (!url) {
    return { isError: true, content: [{ type: 'text', text: 'Missing required argument: url' }] }
  }

  // One policy function used for the initial URL AND every redirect hop.
  const isUrlAllowed = whitelistOn
    ? (u) => isAllowed(u, webFetchCfg?.allowedBaseUrls)
    : (u) => isPublicHttpUrl(u)

  if (!isUrlAllowed(url)) {
    if (whitelistOn) {
      const approvedList = (webFetchCfg?.allowedBaseUrls || []).join(', ') || 'none configured'
      return {
        isError: true,
        content: [{ type: 'text', text: `Access denied: "${url}" is not in the approved sources list.\nApproved domains: ${approvedList}` }],
      }
    }
    return {
      isError: true,
      content: [{ type: 'text', text: `Access denied: "${url}" is not a public http(s) address. Local and private network addresses cannot be fetched.` }],
    }
  }

  try {
    const text = await fetchPage(url, webFetchCfg?.maxFetchTokens ?? 2000, isUrlAllowed)
    return { content: [{ type: 'text', text }] }
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Fetch error: ${err.message}` }] }
  }
}
