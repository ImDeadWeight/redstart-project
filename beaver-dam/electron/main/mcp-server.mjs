'use strict'

// =============================================================================
// Beaver Dam — Built-in MCP Server (web_fetch)
// =============================================================================
// Implements the Model Context Protocol SSE transport (MCP spec 2024-11-05)
// on port config.port + 2 (default 8082). Exposes a single tool: web_fetch —
// fetches GET content from approved sources, strips HTML, and returns text.
//
// URL whitelist is enforced HERE at the server level — not just in the system
// prompt. A request to a non-whitelisted domain never leaves the machine.
//
// Transport: HTTP SSE (two-endpoint pattern)
//   GET  /sse              — SSE connection; server sends endpoint URL immediately
//   POST /message?sessionId — JSON-RPC 2.0 request from client
// =============================================================================

import * as http from 'http'
import * as crypto from 'crypto'

let mcpServer = null
let activeFetchConfig = null   // { allowedBaseUrls, activeTools, maxFetchTokens }

// ---------------------------------------------------------------------------
// Whitelist enforcement
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

// ---------------------------------------------------------------------------
// Web fetch implementation
// ---------------------------------------------------------------------------

async function fetchPage(url, maxTokens) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Beaver/1.0 (local AI assistant)' },
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

// ---------------------------------------------------------------------------
// MCP SSE transport — JSON-RPC 2.0 handler
// ---------------------------------------------------------------------------

const sessions = new Map()

function sseEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

async function handleRpc(msg, send) {
  const { id, method, params } = msg

  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'beaver-fetch', version: '1.0.0' },
    }})
    return
  }

  // Notifications have no response
  if (id === undefined && method?.startsWith('notifications/')) return

  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} })
    return
  }

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [{
      name: 'web_fetch',
      description: 'Fetch live content from an approved web source. Returns page text (HTML stripped). Only domains in the approved whitelist are allowed.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL to fetch — must be from an approved source' },
        },
        required: ['url'],
      },
    }]}})
    return
  }

  if (method === 'tools/call') {
    const toolName = params?.name
    const args = params?.arguments ?? {}
    const cfg = activeFetchConfig

    if (toolName !== 'web_fetch') {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${toolName}` }})
      return
    }

    const url = args.url
    if (!url) {
      send({ jsonrpc: '2.0', id, result: {
        isError: true,
        content: [{ type: 'text', text: 'Missing required argument: url' }],
      }})
      return
    }

    if (!isAllowed(url, cfg?.allowedBaseUrls)) {
      const approvedList = (cfg?.allowedBaseUrls || []).join(', ') || 'none configured'
      send({ jsonrpc: '2.0', id, result: {
        isError: true,
        content: [{ type: 'text', text: `Access denied: "${url}" is not in the approved sources list.\nApproved domains: ${approvedList}` }],
      }})
      return
    }

    try {
      const text = await fetchPage(url, cfg?.maxFetchTokens ?? 2000)
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] }})
    } catch (err) {
      send({ jsonrpc: '2.0', id, result: {
        isError: true,
        content: [{ type: 'text', text: `Fetch error: ${err.message}` }],
      }})
    }
    return
  }

  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` }})
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

export function startMcpServer(port, config) {
  stopMcpServer()
  activeFetchConfig = config

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      })
      res.end()
      return
    }

    const urlPath = req.url.split('?')[0]

    if (req.method === 'GET' && urlPath === '/sse') {
      const sessionId = crypto.randomUUID()
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      })
      const send = (data) => sseEvent(res, 'message', data)
      sessions.set(sessionId, send)
      res.write(`event: endpoint\ndata: ${JSON.stringify('/message?sessionId=' + sessionId)}\n\n`)
      req.on('close', () => sessions.delete(sessionId))
      return
    }

    if (req.method === 'POST' && urlPath === '/message') {
      const sessionId = new URL(req.url, 'http://x').searchParams.get('sessionId')
      const send = sessions.get(sessionId)
      if (!send) {
        res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' })
        res.end('Session not found')
        return
      }
      let body = ''
      for await (const chunk of req) body += chunk
      res.writeHead(202, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' })
      res.end('Accepted')
      try {
        const msg = JSON.parse(body)
        await handleRpc(msg, send)
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' }})
      }
      return
    }

    res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' })
    res.end('Not found')
  })

  return new Promise((resolve, reject) => {
    server.listen(port, '0.0.0.0', () => {
      mcpServer = server
      resolve(port)
    })
    server.on('error', (err) => {
      console.warn(`MCP server could not start on port ${port}: ${err.message}`)
      mcpServer = null
      reject(err)
    })
  })
}

export function stopMcpServer() {
  sessions.clear()
  if (mcpServer) {
    mcpServer.closeAllConnections()  // force-close open SSE sockets so port is freed immediately
    mcpServer.close()
    mcpServer = null
  }
  activeFetchConfig = null
}

export function updateMcpConfig(config) {
  activeFetchConfig = config
}

export function getMcpServerRunning() {
  return mcpServer !== null
}
