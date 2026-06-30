'use strict'

// =============================================================================
// Beaver Dam — Tool Gateway (system-prompt injector)
// =============================================================================
// Listens on config.port (the public-facing port). llama-server runs on
// config.port + 1 bound to 127.0.0.1 only — not reachable from the LAN.
//
// The gateway intercepts every POST /v1/chat/completions request, prepends
// a Beaver identity + active-tool context system message, then pipes the
// request and response straight through (streaming SSE included). Everything
// else is a transparent passthrough to llama-server.
//
// Tool execution (web_fetch, etc.) is handled client-side by the chat-ui
// via llama-server's built-in GET/POST /tools endpoints. The gateway passes
// those requests through without interference.
// =============================================================================

import * as http from 'http'

let gatewayServer = null

// Active tool config: set when the gateway starts, updated when profile changes.
// { allowedBaseUrls: string[], activeTools: {name,baseUrl,description}[], maxFetchTokens: number }
let activeConfig = null

// ---------------------------------------------------------------------------
// System context injection
// ---------------------------------------------------------------------------

function buildSystemContext(config) {
  const base = 'You are a local AI assistant running inside Beaver — a private, on-premises AI system. Your conversations stay on the local network and do not leave the building.'

  const tools = config?.activeTools
  if (!tools?.length) return base

  const list = tools.map(t => {
    let hostname = t.baseUrl
    try { hostname = new URL(t.baseUrl).hostname } catch {}
    return `- ${t.name} (${hostname})${t.description ? ` — ${t.description}` : ''}`
  }).join('\n')

  return `${base} You have access to the web_fetch tool to retrieve live content from approved sources.\n\nApproved sources:\n${list}\n\nOnly fetch from these approved domains. Do not attempt to access any other URLs.`
}

function injectSystemContext(messages, config) {
  const context = buildSystemContext(config)
  const sysIdx = messages.findIndex(m => m.role === 'system')
  if (sysIdx >= 0) {
    messages[sysIdx] = { ...messages[sysIdx], content: `${context}\n\n${messages[sysIdx].content}` }
  } else {
    messages.unshift({ role: 'system', content: context })
  }
  return messages
}

// ---------------------------------------------------------------------------
// Forward a modified completions request to llama-server, piping the response
// back unchanged — handles both streaming SSE and non-streaming JSON.
// ---------------------------------------------------------------------------

function forwardModified(res, internalPort, parsed) {
  const payload = JSON.stringify(parsed)
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
    res.writeHead(proxyRes.statusCode, {
      ...proxyRes.headers,
      'Access-Control-Allow-Origin': '*',
    })
    proxyRes.pipe(res)
  })

  proxyReq.on('error', err => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' })
      res.end(`Gateway error: ${err.message}`)
    }
  })
  proxyReq.write(payload)
  proxyReq.end()
}

// ---------------------------------------------------------------------------
// Passthrough proxy for all non-completions paths
// ---------------------------------------------------------------------------

function passthrough(req, res, internalPort) {
  const options = {
    hostname: '127.0.0.1',
    port: internalPort,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${internalPort}` },
  }

  const proxyReq = http.request(options, proxyRes => {
    res.writeHead(proxyRes.statusCode, {
      ...proxyRes.headers,
      'Access-Control-Allow-Origin': '*',
    })
    proxyRes.pipe(res)
  })

  req.pipe(proxyReq)
  proxyReq.on('error', err => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' })
      res.end(`Gateway error: ${err.message}`)
    }
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startGateway(publicPort, config) {
  stopGateway()
  activeConfig = config
  const internalPort = publicPort + 1

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        })
        res.end()
        return
      }

      // Intercept completions to inject Beaver identity + tool context
      if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
        let rawBody = ''
        for await (const chunk of req) rawBody += chunk

        let parsed
        try { parsed = JSON.parse(rawBody) } catch {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
          res.end(JSON.stringify({ error: { message: 'Bad request: invalid JSON', type: 'invalid_request_error' } }))
          return
        }

        parsed.messages = injectSystemContext([...(parsed.messages || [])], activeConfig)

        try {
          forwardModified(res, internalPort, parsed)
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { message: err.message, type: 'internal_error' } }))
          }
        }
        return
      }

      // Everything else → passthrough to llama-server
      passthrough(req, res, internalPort)
    })

    server.listen(publicPort, '0.0.0.0', () => {
      gatewayServer = server
      resolve(publicPort)
    })
    server.on('error', err => {
      console.warn(`Tool gateway could not start on port ${publicPort}: ${err.message}`)
      gatewayServer = null
      reject(err)
    })
  })
}

export function stopGateway() {
  if (gatewayServer) { gatewayServer.close(); gatewayServer = null }
  activeConfig = null
}

export function updateGatewayConfig(config) {
  activeConfig = config
}

export function getGatewayPort(publicPort) {
  return gatewayServer ? publicPort : null
}
