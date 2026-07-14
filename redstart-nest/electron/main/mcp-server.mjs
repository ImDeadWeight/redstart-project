'use strict'

// =============================================================================
// Redstart Nest — Built-in MCP Server
// =============================================================================
// Implements the Model Context Protocol SSE transport (MCP spec 2024-11-05)
// on port config.port + 2 (default 19082). Tools are contributed by provider
// modules (web-fetch-tool.mjs, postgres-tool.mjs, documents-tool.mjs) — each
// exports toolDefs(cfg) and callTool(name, args, cfg); this file just merges
// tools/list across providers and routes tools/call to whichever provider
// claims the tool name. Enforcement (URL whitelist, read-only SQL, output-dir
// containment) lives in each provider, not here — a request that violates a
// provider's rules never leaves the machine.
//
// Transport: HTTP SSE (two-endpoint pattern)
//   GET  /sse              — SSE connection; server sends endpoint URL immediately
//   POST /message?sessionId — JSON-RPC 2.0 request from client
// =============================================================================

import * as http from 'http'
import * as crypto from 'crypto'
import { authenticate } from './auth.mjs'
import * as webFetchTool from './web-fetch-tool.mjs'
import * as postgresTool from './postgres-tool.mjs'
import * as documentsTool from './documents-tool.mjs'

const PROVIDERS = [webFetchTool, postgresTool, documentsTool]

let mcpServer = null
let activeToolsConfig = null   // { webFetch: {...}, postgres: {...}, documents: {...} }

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
      serverInfo: { name: 'redstart-fetch', version: '1.0.0' },
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
    const tools = PROVIDERS.flatMap(provider => provider.toolDefs(activeToolsConfig))
    send({ jsonrpc: '2.0', id, result: { tools } })
    return
  }

  if (method === 'tools/call') {
    const toolName = params?.name
    const args = params?.arguments ?? {}

    for (const provider of PROVIDERS) {
      const result = await provider.callTool(toolName, args, activeToolsConfig)
      if (result !== null && result !== undefined) {
        send({ jsonrpc: '2.0', id, result })
        return
      }
    }

    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${toolName}` }})
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
  activeToolsConfig = config

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      })
      res.end()
      return
    }

    const urlPath = req.url.split('?')[0]

    if (req.method === 'GET' && urlPath === '/sse') {
      const authResult = authenticate(req)
      if (!authResult.ok) {
        res.writeHead(401, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' })
        res.end('Unauthorized')
        return
      }

      const sessionId = crypto.randomUUID()
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      })
      const send = (data) => sseEvent(res, 'message', data)
      sessions.set(sessionId, { send, account: authResult.account })
      res.write(`event: endpoint\ndata: ${JSON.stringify('/message?sessionId=' + sessionId)}\n\n`)
      req.on('close', () => sessions.delete(sessionId))
      return
    }

    if (req.method === 'POST' && urlPath === '/message') {
      const sessionId = new URL(req.url, 'http://x').searchParams.get('sessionId')
      const session = sessions.get(sessionId)
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' })
        res.end('Session not found')
        return
      }

      // Defense in depth: re-check on every message, not just at SSE-open —
      // covers a session whose token was revoked, or auth toggled on, since.
      const authResult = authenticate(req)
      if (!authResult.ok) {
        sessions.delete(sessionId)
        res.writeHead(401, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' })
        res.end('Unauthorized')
        return
      }

      const { send } = session
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
  activeToolsConfig = null
  postgresTool.closePool()
}

export function updateMcpConfig(config) {
  activeToolsConfig = config
}

// Force-closes open SSE sessions without stopping the server — used when
// "Require login" is switched on, since sessions opened while auth was off
// have no account attached to them.
export function closeAllMcpSessions() {
  sessions.clear()
  if (mcpServer) mcpServer.closeAllConnections()
}

export function getMcpServerRunning() {
  return mcpServer !== null
}
