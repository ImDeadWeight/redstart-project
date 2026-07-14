'use strict'

// =============================================================================
// Redstart Nest — MCP Provider: web_fetch
// =============================================================================
// Fetches GET content from approved sources, strips HTML, returns text. The
// domain whitelist is enforced HERE — a request to a non-whitelisted domain
// never leaves the machine. Config shape (cfg.webFetch): the same
// { allowedBaseUrls, activeTools, maxFetchTokens } the gateway has always used.
// =============================================================================

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

async function fetchPage(url, maxTokens) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Redstart/1.0 (local AI assistant)' },
    signal: AbortSignal.timeout(12000),
    redirect: 'follow',
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`)

  const ct = resp.headers.get('content-type') || ''
  let text = await resp.text()

  if (ct.includes('html')) {
    text = text
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

  const maxChars = (maxTokens ?? 2000) * 4
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + `\n\n[Content truncated at ~${maxTokens} tokens]`
  }
  return text
}

export function toolDefs(cfg) {
  if (!cfg?.webFetch?.allowedBaseUrls?.length) return []
  return [{
    name: 'web_fetch',
    description: 'Fetch live content from an approved web source. Returns page text (HTML stripped). Only domains in the approved whitelist are allowed.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to fetch — must be from an approved source' },
      },
      required: ['url'],
    },
  }]
}

export async function callTool(name, args, cfg) {
  if (name !== 'web_fetch') return null

  const webFetchCfg = cfg?.webFetch
  const url = args?.url
  if (!url) {
    return { isError: true, content: [{ type: 'text', text: 'Missing required argument: url' }] }
  }

  if (!isAllowed(url, webFetchCfg?.allowedBaseUrls)) {
    const approvedList = (webFetchCfg?.allowedBaseUrls || []).join(', ') || 'none configured'
    return {
      isError: true,
      content: [{ type: 'text', text: `Access denied: "${url}" is not in the approved sources list.\nApproved domains: ${approvedList}` }],
    }
  }

  try {
    const text = await fetchPage(url, webFetchCfg?.maxFetchTokens ?? 2000)
    return { content: [{ type: 'text', text }] }
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Fetch error: ${err.message}` }] }
  }
}
