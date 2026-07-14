'use strict'

// =============================================================================
// Redstart Nest — Tool Gateway (system-prompt injector)
// =============================================================================
// Listens on config.port (the public-facing port). llama-server runs on
// config.port + 1 bound to 127.0.0.1 only — not reachable from the LAN.
//
// The gateway intercepts every POST /v1/chat/completions request, prepends
// a Redstart identity + active-tool context system message, then pipes the
// request and response straight through (streaming SSE included). Everything
// else is a transparent passthrough to llama-server.
//
// Tool execution (web_fetch, etc.) is handled client-side by the chat-ui
// via llama-server's built-in GET/POST /tools endpoints. The gateway passes
// those requests through without interference.
// =============================================================================

import * as http from 'http'
import { authenticate, login, logout, listAccounts, getAuthRequired, createAccount, deleteAccount, resetPassword, regenerateApiKey, hasAdminAccess } from './auth.mjs'

let gatewayServer = null

// Active tool config: set when the gateway starts, updated when profile changes.
// { allowedBaseUrls: string[], activeTools: {name,baseUrl,description}[], maxFetchTokens: number }
let activeConfig = null

// ---------------------------------------------------------------------------
// System context injection
// ---------------------------------------------------------------------------

function buildSystemContext(config) {
  const base = 'You are a local AI assistant running inside Redstart — a private, on-premises AI system. Your conversations stay on the local network and do not leave the building.'
  const parts = [base]

  const tools = config?.webFetch?.activeTools
  if (tools?.length) {
    const list = tools.map(t => {
      let hostname = t.baseUrl
      try { hostname = new URL(t.baseUrl).hostname } catch {}
      return `- ${t.name} (${hostname})${t.description ? ` — ${t.description}` : ''}`
    }).join('\n')
    parts.push(`You have access to the web_fetch tool to retrieve live content from approved sources.\n\nApproved sources:\n${list}\n\nOnly fetch from these approved domains. Do not attempt to access any other URLs.`)
  }

  if (config?.postgres?.enabled) {
    parts.push('You have access to postgres_query, postgres_list_tables, and postgres_describe_table to read from a connected local Postgres database. Queries are read-only.')
  }

  if (config?.documents?.enabled) {
    parts.push('You have access to create_document to save a docx, pdf, or markdown file to a local output folder for the user.')
  }

  return parts.join('\n\n')
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
// Auth routes — /auth/*
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  try { return JSON.parse(raw || '{}') } catch { return null }
}

async function handleAuthRoute(req, res, urlPath) {
  // Public — no auth required (chicken-and-egg: the client needs this
  // before it can even attempt to log in).
  if (req.method === 'GET' && urlPath === '/auth/config') {
    return sendJson(res, 200, { authRequired: getAuthRequired() })
  }

  if (req.method === 'POST' && urlPath === '/auth/login') {
    const body = await readJsonBody(req)
    if (!body?.username || !body?.password) return sendJson(res, 400, { error: 'Username and password required' })
    const result = login(body.username, body.password)
    if (!result.ok) return sendJson(res, 401, { error: result.error })
    return sendJson(res, 200, { token: result.token, user: result.user })
  }

  if (req.method === 'POST' && urlPath === '/auth/logout') {
    logout(req)
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
    return res.end()
  }

  if (req.method === 'GET' && urlPath === '/auth/me') {
    const authResult = authenticate(req)
    if (!authResult.ok) return sendJson(res, 401, { error: 'Unauthorized' })
    return sendJson(res, 200, { authRequired: getAuthRequired(), user: authResult.account })
  }

  // Everything below manages accounts — admin-tier (Admin or Owner) only,
  // regardless of the authRequired toggle (an unauthenticated/bypassed
  // request has no account attached, so it can never satisfy this check).
  // Actor-vs-target checks (e.g. an Admin trying to touch another Admin or
  // the Owner) happen inside auth.mjs's functions, not here.
  const authResult = authenticate(req)
  if (!authResult.ok) return sendJson(res, 401, { error: 'Unauthorized' })
  if (!hasAdminAccess(authResult.account)) return sendJson(res, 403, { error: 'Admin role required' })

  if (req.method === 'GET' && urlPath === '/auth/accounts') {
    return sendJson(res, 200, { accounts: listAccounts(authResult.account) })
  }

  if (req.method === 'POST' && urlPath === '/auth/accounts') {
    const body = await readJsonBody(req)
    if (!body?.username || !body?.password) return sendJson(res, 400, { error: 'Username and password required' })
    const result = createAccount(authResult.account, { username: body.username, password: body.password, role: body.role })
    if (!result.ok) return sendJson(res, result.error?.startsWith('Not permitted') ? 403 : 400, { error: result.error })
    return sendJson(res, 200, { account: result.account, apiKey: result.apiKey })
  }

  const idMatch = /^\/auth\/accounts\/([^/]+)(?:\/(reset-password|regenerate-key))?$/.exec(urlPath)
  if (idMatch) {
    const [, id, action] = idMatch

    if (req.method === 'DELETE' && !action) {
      const result = deleteAccount(authResult.account, id)
      if (!result.ok) return sendJson(res, result.error === 'Account not found' ? 404 : 403, { error: result.error })
      return sendJson(res, 200, { ok: true })
    }

    if (req.method === 'POST' && action === 'reset-password') {
      const body = await readJsonBody(req)
      if (!body?.password) return sendJson(res, 400, { error: 'Password required' })
      const result = resetPassword(authResult.account, id, body.password)
      if (!result.ok) return sendJson(res, result.error === 'Account not found' ? 404 : 403, { error: result.error })
      return sendJson(res, 200, { account: result.account })
    }

    if (req.method === 'POST' && action === 'regenerate-key') {
      const result = regenerateApiKey(authResult.account, id)
      if (!result.ok) return sendJson(res, result.error === 'Account not found' ? 404 : 403, { error: result.error })
      return sendJson(res, 200, { account: result.account, apiKey: result.apiKey })
    }
  }

  return sendJson(res, 404, { error: 'Not found' })
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

      // Auth routes handle their own responses (including the unauthenticated
      // /auth/config and /auth/login endpoints), so branch before the gate.
      const urlPath = req.url.split('?')[0]
      if (urlPath.startsWith('/auth/')) {
        return await handleAuthRoute(req, res, urlPath)
      }

      // Everything else requires a valid session/API key when auth is
      // required — localhost is always exempt (see auth.mjs isLocalhost).
      const authResult = authenticate(req)
      if (!authResult.ok) {
        res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: { message: 'Unauthorized', type: 'auth_error' } }))
        return
      }

      // Intercept completions to inject Redstart identity + tool context
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
