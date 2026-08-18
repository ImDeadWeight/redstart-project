'use strict'

// =============================================================================
// Redstart Nest — Built-in MCP Server
// =============================================================================
// Implements the Model Context Protocol Streamable HTTP transport
// on port config.port + 2 (default 19082). Tools are contributed by provider
// modules (web-fetch-tool.mjs, postgres-tool.mjs, documents-tool.mjs) — each
// exports toolDefs(cfg) and callTool(name, args, cfg, ctx); this file just merges
// tools/list across providers and routes tools/call to whichever provider
// claims the tool name. Enforcement (URL whitelist, read-only SQL, output-dir
// containment) lives in each provider, not here — a request that violates a
// provider's rules never leaves the machine.
//
// Transport: HTTP Streamable HTTP (single-endpoint pattern)
//   POST /mcp  — JSON-RPC 2.0 request/response
//   GET  /mcp  — SSE stream for server-initiated notifications
//   DELETE /mcp — session termination
// =============================================================================

import * as http from 'http'
import * as crypto from 'crypto'
import { authenticate, getAuthRequired, surfacePermitted, roleFor } from './auth.mjs'
import { resolveEffectiveConfig, narrowConfig, DENY_ALL } from './permissions.mjs'
import * as webFetchTool from './web-fetch-tool.mjs'
import * as postgresTool from './postgres-tool.mjs'
import * as documentsTool from './documents-tool.mjs'
import * as sqliteTool from './sqlite-tool.mjs'
import * as vaultTool from './vault-tool.mjs'
import * as gitTool from './git-tool.mjs'
import * as filesystemProvider from './filesystem-mcp-provider.mjs'
import * as fsDeleteTool from './fs-delete-tool.mjs'
import * as scholarTool from './scholar-tool.mjs'
import { pluginProviders, stopAllPlugins } from './plugin-provider.mjs'
import {
  classifyTool,
  capabilityForTool,
  CAPABILITY_TOOL_NAMES,
  META_CAPABILITY_KEY,
  META_CLASS_KEY,
} from './tools-definitions.mjs'
import { logEvent } from './logger.mjs'
import {
  StreamableHTTPServerTransport
} from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'

const BUILTIN_PROVIDERS = [webFetchTool, postgresTool, documentsTool, sqliteTool, vaultTool, gitTool, filesystemProvider, fsDeleteTool, scholarTool]

// Resolved per call, never captured in a const: a plugin installed or removed
// while Nest is running must take effect without a restart. Built-ins come
// first so a plugin can never be dispatched ahead of one — though namespacing
// already makes a collision impossible.
function resolveProviders() {
  return [...BUILTIN_PROVIDERS, ...pluginProviders()]
}

export const ALLOWED_CORS_HEADERS =
  'Content-Type, Authorization, mcp-protocol-version, mcp-session-id, last-event-id'

// Response headers a browser MCP client must be able to READ. This is the
// whole session mechanism under Streamable HTTP: the server assigns the id on
// the initialize RESPONSE, and the client echoes it back on every subsequent
// request. `mcp-session-id` is not a CORS-safelisted response header, so
// without this the browser hides it from JS — the client's _sessionId stays
// undefined, the next POST carries no session, and the server rejects it.
//
// This MUST be sent on the actual responses, not only on the OPTIONS
// preflight. Preflight negotiates which headers a request may SEND
// (Access-Control-Allow-Headers); Access-Control-Expose-Headers governs what
// a response permits the caller to read and is meaningless on the preflight
// itself. Setting it only there is exactly the bug this constant now prevents:
// every Node client worked (no CORS at all) while every browser failed on the
// request immediately after initialize.
//
// The legacy SSE transport had no equivalent exposure requirement — it carried
// the session in the URL (/message?sessionId=...) — so this became load-bearing
// only with the Streamable HTTP migration.
export const EXPOSED_CORS_HEADERS = 'mcp-session-id'

// ---------------------------------------------------------------------------
// Permission gate — server-side, non-bypassable enforcement of the per-class
// tool policy. Currently governs the File System capability (the one read/write
// capability): writes obey fileSystem.allowWrite, deletes obey
// fileSystem.allowDestructive (see gateway-config.mjs / DEFAULT_CAPABILITIES).
// Returns { allowed, cls, reason? }. Applied at tools/call (enforcement) and
// tools/list (so a blocked tool isn't even advertised to the model).
// ---------------------------------------------------------------------------
const FS_TOOL_NAMES = new Set(CAPABILITY_TOOL_NAMES.file_system)

function evaluateToolPolicy(toolName, config) {
  const cls = classifyTool(toolName)

  if (Array.isArray(config?.disabledTools) && config.disabledTools.includes(toolName)) {
    return { allowed: false, cls, reason: `The "${toolName}" tool has been disabled by an administrator.` }
  }

  if (FS_TOOL_NAMES.has(toolName)) {
    const fsPolicy = config?.fileSystem || {}
    if (cls === 'destructive' && fsPolicy.allowDestructive !== true) {
      return { allowed: false, cls, reason: 'Destructive file-system operations (delete) are disabled by policy. An administrator must enable them for the File System capability.' }
    }
    if (cls === 'write' && fsPolicy.allowWrite === false) {
      return { allowed: false, cls, reason: 'File-system writes are disabled by policy. An administrator must enable them for the File System capability.' }
    }
  }

  // Plugin tools carry the same class-based policy, keyed on the plugin's own
  // capability config. Polarity deliberately differs from File System's:
  // a plugin's allowWrite defaults to OFF (`!== true`), because File System is a
  // capability an admin configured deliberately and a plugin is third-party code.
  const capability = capabilityForTool(toolName)
  if (capability && !FS_TOOL_NAMES.has(toolName)) {
    const pluginPolicy = config?.[capability]
    if (pluginPolicy && pluginPolicy.isPlugin) {
      if (cls === 'destructive' && pluginPolicy.allowDestructive !== true) {
        return { allowed: false, cls, reason: `Destructive operations are disabled for the "${capability}" plugin. An administrator must enable them.` }
      }
      if (cls === 'write' && pluginPolicy.allowWrite !== true) {
        return { allowed: false, cls, reason: `Write operations are disabled for the "${capability}" plugin. An administrator must enable them.` }
      }
    }
  }
  return { allowed: true, cls }
}

// ---------------------------------------------------------------------------
// Tool provenance annotation.
//
// Stamped centrally on every advertised tool rather than asked of each
// provider, so no provider can forget and a new provider gets it for free.
// Two channels, deliberately:
//
//   _meta['redstart/*'] — the authoritative one. MCP treats _meta as an
//       implementation-defined passthrough, so this is where a Redstart client
//       reads a tool's capability and class from. Consumed by the chat-ui to
//       key filesystem precedence on capability IDENTITY rather than on tool
//       names (which is what broke when the FS MCP migration renamed them), and
//       later to keep destructive-class tools out of "Always allow".
//
//   annotations — the standard MCP hints, for any third-party MCP client that
//       connects to us. Purely informational: the spec is explicit that clients
//       must not make trust decisions from annotations, because on a normal
//       connection they are attacker-controlled. Our own enforcement never
//       reads them — evaluateToolPolicy classifies from the static TOOL_CLASSES
//       map, server-side, and that remains the only thing standing between a
//       call and the disk.
// ---------------------------------------------------------------------------
function annotateTool(tool) {
  const cls = classifyTool(tool.name)
  const readOnly = cls === 'read' || cls === 'network'
  return {
    ...tool,
    annotations: {
      ...(tool.annotations || {}),
      readOnlyHint: readOnly,
      destructiveHint: cls === 'destructive',
      openWorldHint: cls === 'network',
    },
    _meta: {
      ...(tool._meta || {}),
      [META_CAPABILITY_KEY]: capabilityForTool(tool.name),
      [META_CLASS_KEY]: cls,
    },
  }
}

let mcpServer = null
let activeToolsConfig = null   // { webFetch: {...}, postgres: {...}, documents: {...} }

// ---------------------------------------------------------------------------
// MCP dispatch — JSON-RPC 2.0 handler
// ---------------------------------------------------------------------------

// Session store: one SDK transport per session, keyed by the session ID the
// transport generates during initialize.
const transports = new Map()

async function handleRpc(msg, send, ctx = { account: null }) {
  const { id, method, params } = msg

  //
  // The null-account branch is split deliberately. A null account means "auth is
  // off" — the documented, unnarrowed posture — but ONLY when auth is actually
  // off. With auth on, a null account here means identity failed to reach this
  // function, and treating that as the auth-off posture would hand a broken
  // plumbing path the full tool set. That is not hypothetical: it is exactly
  // what the missing `req.auth` assignment in the transport above produced.
  const cfg = ctx.account
    ? resolveEffectiveConfig(ctx.account, activeToolsConfig, roleFor(ctx.account))
    : getAuthRequired()
      ? narrowConfig(activeToolsConfig, DENY_ALL)
      : activeToolsConfig

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
    const tools = []
    const seen = new Set()
    for (const provider of resolveProviders()) {
      for (const tool of provider.toolDefs(cfg)) {
        if (seen.has(tool.name)) {
          console.warn(`MCP: duplicate tool name "${tool.name}" — keeping the first provider's definition. Namespace your tool names.`)
          continue
        }
        seen.add(tool.name)
        if (!evaluateToolPolicy(tool.name, cfg).allowed) continue
        tools.push(annotateTool(tool))
      }
    }
    send({ jsonrpc: '2.0', id, result: { tools } })
    return
  }

  if (method === 'tools/call') {
    const toolName = params?.name
    const args = params?.arguments ?? {}

    const policy = evaluateToolPolicy(toolName, cfg)
    if (!policy.allowed) {
      logEvent('tool', 'denied', { tool: toolName, class: policy.cls })
      send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: policy.reason }] } })
      return
    }

    const startedAt = Date.now()
    for (const provider of resolveProviders()) {
      const result = await provider.callTool(toolName, args, cfg, ctx)
      if (result !== null && result !== undefined) {
        logEvent('tool', 'called', { tool: toolName, class: policy.cls, isError: !!result.isError, durationMs: Date.now() - startedAt })
        send({ jsonrpc: '2.0', id, result })
        return
      }
    }

    logEvent('tool', 'unknown', { tool: toolName })
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${toolName}` }})
    return
  }

  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` }})
  }
}

// ---------------------------------------------------------------------------
// CORS helper — applied to every response the SDK transport writes.
//
// Both headers matter. Allow-Origin decides whether the browser hands the
// response to JS at all; Expose-Headers decides whether JS may read the
// session id out of it (see EXPOSED_CORS_HEADERS). Set via setHeader before
// the transport writes, so they survive the SDK's own writeHead() — Node
// merges previously-set headers rather than discarding them.
// ---------------------------------------------------------------------------
function addCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Expose-Headers', EXPOSED_CORS_HEADERS)
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
export function startMcpServer(port, config, { bindHost = '127.0.0.1' } = {}) {
  stopMcpServer()
  activeToolsConfig = config

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': ALLOWED_CORS_HEADERS,
        'Access-Control-Expose-Headers': EXPOSED_CORS_HEADERS,
        'Access-Control-Max-Age': '86400',
      })
      res.end()
      return
    }

    const urlPath = req.url.split('?')[0]

    if (urlPath !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' })
      res.end('Not found')
      return
    }

    const authResult = authenticate(req)
    if (!authResult.ok) {
      res.writeHead(401, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' })
      res.end('Unauthorized')
      return
    }

    // The second chokepoint. tools-gateway.mjs refuses a credential whose app is
    // outside the account's role, and this server has to agree — otherwise a
    // surface-restricted account reaches every tool it is otherwise allowed by
    // pointing a client straight at port+2 instead of at the proxy. Surface comes
    // from the credential (authResult), never from a header.
    if (!surfacePermitted(authResult.account, authResult.surface)) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'This account is not permitted to connect from this application' } }))
      return
    }

    addCorsHeaders(res)

    let body = ''
    for await (const chunk of req) body += chunk

    let parsed
    try {
      parsed = body ? JSON.parse(body) : {}
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
      return
    }

    const sessionId = req.headers['mcp-session-id']
    let transport

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)
    } else if (!sessionId && isInitializeRequest(parsed)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport)
        },
      })

      transport.onclose = () => {
        const sid = transport.sessionId
        if (sid) transports.delete(sid)
      }

      transport.onerror = (err) => {
        console.error('MCP transport error:', err)
      }

      transport.onmessage = async (message, extra) => {
        const ctx = { account: extra.authInfo?.account ?? null }
        await handleRpc(message, (response) => {
          transport.send(response).catch((err) => {
            console.error('MCP response send error:', err)
          })
        }, ctx)
      }
    } else if (req.method === 'GET' || req.method === 'DELETE') {
      // A session-less GET is the SDK client's OPTIONAL opening probe — it
      // always issues one before the POST /initialize, to see if this server
      // offers a standalone SSE stream for server-initiated messages (we
      // don't). The client's own contract for that probe (streamableHttp.js
      // _startOrAuthSse) is explicit: 405 means "not supported, expected,
      // keep going silently"; anything else — including 400 — is thrown as a
      // fatal StreamableHTTPError and aborts connect() before it ever sends
      // the initialize POST. A session-less DELETE gets the same answer for
      // the same reason (nothing to tear down that this server offers over
      // GET/DELETE outside a session). Only a POST that is neither a known
      // session nor a valid initialize request is an actual bad request.
      res.writeHead(405, { 'Content-Type': 'application/json', 'Allow': 'POST' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method Not Allowed: no active session' } }))
      return
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Bad Request: No valid session ID provided' } }))
      return
    }

    // The SDK sources per-request identity from `req.auth` and hands it to
    // onmessage as `extra.authInfo` (see streamableHttp.js: `const authInfo =
    // req.auth`). Without this assignment that read yields undefined, so every
    // tool call runs with ctx.account === null: per-account storage collapses to
    // the anonymous scope, and role narrowing takes the auth-off path and
    // applies nothing. Both fail silently and look completely normal.
    req.auth = { account: authResult.account ?? null, surface: authResult.surface ?? null }

    try {
      await transport.handleRequest(req, res, parsed)
    } catch (err) {
      console.error('MCP request error:', err)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal server error' } }))
      }
    }
  })

  return new Promise((resolve, reject) => {
    server.listen(port, bindHost, () => {
      mcpServer = server
      logEvent('mcp', 'started', { port, bindHost })
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
  const allTransports = [...transports.values()]
  for (const transport of allTransports) {
    transport.close().catch(() => {})
  }
  transports.clear()
  if (mcpServer) {
    mcpServer.closeAllConnections()
    mcpServer.close()
    mcpServer = null
  }
  activeToolsConfig = null
  postgresTool.closePool()
  // Plugin children are separate OS processes; without this they outlive the
  // server that spawned them.
  stopAllPlugins()
}

export function updateMcpConfig(config) {
  activeToolsConfig = config
}

// Force-closes open sessions without stopping the server — used when
// "Require login" is switched on, since sessions opened while auth was off
// have no account attached to them.
export function closeAllMcpSessions() {
  const allTransports = [...transports.values()]
  for (const transport of allTransports) {
    transport.close().catch(() => {})
  }
  transports.clear()
  if (mcpServer) mcpServer.closeAllConnections()
}

export function getMcpServerRunning() {
  return mcpServer !== null
}

// Estimates the context-window cost of the tool set a given config would
// expose. Every active tool's JSON schema rides along in the prompt of every
// completion request, so this is a per-request standing cost — surfaced in
// the Tools UI so users see why "turn everything on" is a bad default.
// chars/4 is the usual rough token heuristic; close enough for a warning.
export function estimateActiveToolTokens(config) {
  const seen = new Set()
  const tools = []
  for (const provider of resolveProviders()) {
    for (const tool of provider.toolDefs(config)) {
      if (seen.has(tool.name)) continue
      seen.add(tool.name)
      if (!evaluateToolPolicy(tool.name, config).allowed) continue
      tools.push(tool)
    }
  }
  return { toolCount: tools.length, approxTokens: Math.ceil(JSON.stringify(tools).length / 4) }
}
