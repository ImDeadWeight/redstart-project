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
import * as path from 'path'
import { authenticate, login, logout, listAccounts, getAuthRequired, createAccount, deleteAccount, resetPassword, regenerateApiKey, regenerateOwnApiKey, hasAdminAccess, issueClientKey, revokeClientKey, getOwnClientKeys } from './auth.mjs'
import { logEvent } from './logger.mjs'
import { getMcpServerRunning } from './mcp-server.mjs'
import { getExternalServers } from './tools-storage.mjs'
import { CLIENT_APP_TOOL_NAMES } from './tools-definitions.mjs'
import { resolveWithinRoot } from './path-scope.mjs'
import { resolveUserRoot } from './user-scope.mjs'
import { handleFilesRequest } from './files-api.mjs'
import { composePrompt, deriveEgressFacts, DEFAULT_TOKEN_BUDGET, listModes, SURFACE_IDS } from './system-prompt.mjs'
import { getPromptBlocks, getPromptBlocksMeta, setPromptBlocks, MAX_BLOCK_CHARS } from './prompt-storage.mjs'
import { getConversations, getConversation as getConv, createConversation, updateConversation, deleteConversation, deleteConversationsWithForks } from './conversations-storage.mjs'
import * as fs from 'fs'

let gatewayServer = null

// Active tool config: set when the gateway starts, updated when profile changes.
// { allowedBaseUrls: string[], activeTools: {name,baseUrl,description}[], maxFetchTokens: number }
let activeConfig = null

// ---------------------------------------------------------------------------
// System context injection
// ---------------------------------------------------------------------------

// Assembly itself lives in system-prompt.mjs — pure, synchronous, and testable
// without a server (spec §11). This function's only job is to resolve the live
// facts the composer needs and hand them over.
//
// `hasTools` = the request actually carries tool definitions, and gates every
// capability claim; see the substantiation rule in system-prompt.mjs.
function buildSystemContext(config, hasTools, account, mode, surface, clientToolNames) {
  const { prompt } = composePrompt({
    config,
    hasTools,
    externalServers: getExternalServers(),
    account,
    admin: getPromptBlocks(),
    mode,
    surface,
    clientToolNames,
  })
  return prompt
}

// Tool names in this request that execute on the CLIENT'S machine — Redstart
// Twig's fs_* file tools, which act on a folder the user granted on their own
// PC. Read from the payload rather than inferred from the surface: a Twig user
// who has granted no folder sends none of them, and for that session there is
// only one machine to talk about.
//
// This is the same rule the rest of the prompt follows: a claim is made only
// when the request substantiates it.
function clientToolNamesIn(parsed) {
  if (!Array.isArray(parsed?.tools)) return []
  const present = new Set()
  for (const tool of parsed.tools) {
    const name = typeof tool === 'object' && tool !== null ? tool.function?.name : tool?.name
    if (typeof name === 'string') present.add(name)
  }
  const local = []
  for (const names of Object.values(CLIENT_APP_TOOL_NAMES)) {
    for (const name of names) if (present.has(name)) local.push(name)
  }
  return local
}

// The composed prompt is PREPENDED to any client-supplied system message, so
// client text lands after the precedence clause and is thereby subordinated to
// admin policy (spec §4). Phase 7 stops accepting client system prose
// altogether; until then this ordering is what makes the floor hold.
function injectSystemContext(messages, config, hasTools, account, mode, surface, clientToolNames) {
  const context = buildSystemContext(config, hasTools, account, mode, surface, clientToolNames)
  const sysIdx = messages.findIndex(m => m.role === 'system')
  if (sysIdx >= 0) {
    messages[sysIdx] = { ...messages[sysIdx], content: `${context}\n\n${messages[sysIdx].content}` }
  } else {
    messages.unshift({ role: 'system', content: context })
  }
  return messages
}

// ---------------------------------------------------------------------------
// Server-enforced tool allow-list.
//
// The server (Redstart Nest) may ban specific tool function names
// (activeConfig.disabledTools) so an org policy can't be overridden by a
// client's local enable/disable toggle. We strip those names from the tool
// list the model receives AND from any pre-baked tool_calls in the request
// body (defense in depth against a client that hands the model a banned
// call). The model never learns a banned tool exists, so it cannot invoke it.
// ---------------------------------------------------------------------------

function getDisabledToolNames(config) {
  const list = config?.disabledTools
  return Array.isArray(list) ? list : []
}

function enforceToolAllowList(parsed, config) {
  const banned = getDisabledToolNames(config)
  if (banned.length === 0) return parsed

  const bannedSet = new Set(banned)

  if (Array.isArray(parsed.tools)) {
    parsed.tools = parsed.tools.filter(t => {
      const name = typeof t === 'object' && t !== null ? t.function?.name : t?.name
      return !name || !bannedSet.has(name)
    })
    if (parsed.tools.length === 0) delete parsed.tools
  }

  // Strip tool_choice that points at a banned tool.
  if (parsed.tool_choice && typeof parsed.tool_choice === 'object' && parsed.tool_choice.function?.name) {
    if (bannedSet.has(parsed.tool_choice.function.name)) delete parsed.tool_choice
  }

  // Strip assistant messages that already carry a banned tool call.
  if (Array.isArray(parsed.messages)) {
    for (const msg of parsed.messages) {
      if (msg?.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue
      msg.tool_calls = msg.tool_calls.filter(tc => {
        const name = tc?.function?.name
        return !name || !bannedSet.has(name)
      })
      if (msg.tool_calls.length === 0) delete msg.tool_calls
    }
  }

  return parsed
}

// ---------------------------------------------------------------------------
// Forward a modified completions request to llama-server, piping the response
// back unchanged — handles both streaming SSE and non-streaming JSON.
// ---------------------------------------------------------------------------

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
      ...withoutUpstreamCors(proxyRes.headers),
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
      ...withoutUpstreamCors(proxyRes.headers),
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
    if (!result.ok) {
      // Log the outcome + role, never the password or token.
      logEvent('auth', 'login_failed', { username: String(body.username).slice(0, 64) })
      return sendJson(res, 401, { error: result.error })
    }
    logEvent('auth', 'login_ok', { username: result.user?.username, role: result.user?.role })
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

  // Per-connector credentials (spec §8). Self-service only: a user issues keys
  // for their own account, because issuing one for another account would be an
  // impersonation primitive. Placed with the other self-service routes, before
  // the admin gate below.
  if (req.method === 'GET' && urlPath === '/auth/me/client-keys') {
    const authResult = authenticate(req)
    if (!authResult.ok || !authResult.account) return sendJson(res, 401, { error: 'Unauthorized' })
    return sendJson(res, 200, {
      clientKeys: getOwnClientKeys(authResult.account),
      surfaces: SURFACE_IDS,
    })
  }

  if (req.method === 'POST' && urlPath === '/auth/me/client-keys') {
    const authResult = authenticate(req)
    if (!authResult.ok || !authResult.account) return sendJson(res, 401, { error: 'Unauthorized' })
    const body = await readJsonBody(req)
    const result = issueClientKey(authResult.account, {
      surface: body?.surface,
      label: body?.label,
    })
    if (!result.ok) return sendJson(res, 400, { error: result.error })
    logEvent('auth', 'client_key_issued', {
      username: authResult.account.username,
      surface: body?.surface,
    })
    // The raw key is returned exactly once and never stored.
    return sendJson(res, 200, { apiKey: result.apiKey, clientKey: result.clientKey })
  }

  if (req.method === 'DELETE' && urlPath.startsWith('/auth/me/client-keys/')) {
    const authResult = authenticate(req)
    if (!authResult.ok || !authResult.account) return sendJson(res, 401, { error: 'Unauthorized' })
    const keyId = urlPath.slice('/auth/me/client-keys/'.length)
    const result = revokeClientKey(authResult.account, keyId)
    if (!result.ok) return sendJson(res, 404, { error: result.error })
    logEvent('auth', 'client_key_revoked', { username: authResult.account.username })
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
    return res.end()
  }

  // Self-service key rotation — any logged-in user, acting on their own
  // account. Placed before the admin gate below because it is NOT an
  // account-management action. Requires a real authenticated account (an
  // anonymous localhost/auth-off request has account: null → 401).
  if (req.method === 'POST' && urlPath === '/auth/me/regenerate-key') {
    const authResult = authenticate(req)
    if (!authResult.ok || !authResult.account) return sendJson(res, 401, { error: 'Unauthorized' })
    const result = regenerateOwnApiKey(authResult.account)
    if (!result.ok) return sendJson(res, 400, { error: result.error })
    return sendJson(res, 200, { account: result.account, apiKey: result.apiKey })
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
// Static app-shell detection
// ---------------------------------------------------------------------------
// The chat-ui's own HTML/JS/CSS/icons/manifest/service-worker must be
// servable WITHOUT auth — otherwise the login screen itself can never load on
// a remote device (it lives inside the SPA), which is exactly the
// "raw 401 JSON on a black page" symptom. A browser also can't attach the
// bearer token to a document/asset navigation (it only rides on fetch()
// calls), so gating this layer is both impossible to do correctly and
// pointless. Real enforcement happens on the API surface, which stays gated.
//
// Fail-closed by design: only paths that clearly look like static assets are
// public. Anything unrecognized — including any current or future
// llama-server API route (/completion, /tokenize, /embedding, …) — falls
// through to authenticate(). llama-server's API routes never end in a
// file-extension, so the extension test below can't accidentally expose them.
function isPublicAsset(urlPath) {
  return (
    urlPath === '/' ||
    urlPath === '/index.html' ||
    urlPath.startsWith('/_app/') ||
    /\.(js|mjs|css|map|svg|png|webp|ico|webmanifest|woff2?|txt|html)$/.test(urlPath)
  )
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// bindHost decides whether this server is reachable from the LAN at all, and
// it defaults to LOOPBACK — fail closed. Callers that want LAN exposure ask for
// it explicitly (ipc/server.mjs derives '0.0.0.0' from config.networkMode).
//
// This used to be a hardwired '0.0.0.0' with the Windows Firewall as the only
// thing standing between the LAN and this port. That made the launcher's
// "Local network" toggle a firewall-rule switch rather than an exposure
// control: the socket was bound wide either way, so a host with the firewall
// off, a third-party firewall, or a rule left behind by an earlier run was
// reachable with the toggle off. The boundary belongs on the socket, where the
// app actually owns it; the firewall rule is only permission on top of that.
export function startGateway(publicPort, config, { bindHost = '127.0.0.1' } = {}) {
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
          // X-Redstart-Device-Id is sent by the chat-ui's DatabaseService on
          // every /conversations call; without it here, browsers block those
          // cross-origin requests at preflight.
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Redstart-Device-Id',
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

      // Serve the app shell (static assets) to everyone — the login screen
      // can't appear until the SPA loads. See isPublicAsset() for the
      // fail-closed rationale. Same passthrough target as the catch-all below.
      if (req.method === 'GET' && isPublicAsset(urlPath)) {
        return passthrough(req, res, internalPort)
      }

      // Everything else requires a valid session/API key when auth is
      // required — no localhost exemption; every HTTP client authenticates.
      const authResult = authenticate(req)
      if (!authResult.ok) {
        res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: { message: 'Unauthorized', type: 'auth_error' } }))
        return
      }

      // Conversation API — scoped to the authenticated account, or to the
      // client-supplied device ID when auth is off. Only these routes need an
      // identity to scope storage by; completions and the passthrough below
      // must keep working for token-less clients when auth is off, so the
      // accountId requirement is enforced HERE and not as a gate over
      // everything that follows. The device ID is client-chosen and
      // unauthenticated — acceptable only for the deliberate auth-off
      // posture; with auth on, every request already carries a real account.
      const accountId = authResult.account?.id || req.headers['x-redstart-device-id']
      const isConversationRoute = urlPath === '/conversations' || /^\/conversations\/[^/]+$/.test(urlPath)
      if (isConversationRoute && !accountId) {
        res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: { message: 'Unauthorized — no account or device ID', type: 'auth_error' } }))
        return
      }

      // Egress audit (spec §7). The same facts the data_handling block is
      // built from, served as data so "where does my data go?" is a question
      // with a checkable answer rather than a sentence the model paraphrases.
      //
      // hasTools is TRUE here on purpose: the prompt describes only egress the
      // current request can actually reach, but an audit must report every
      // path the deployment is CONFIGURED for, whether or not this particular
      // client sent tool definitions. Understating configured egress to an
      // auditor is the same failure as overstating privacy to a user.
      if (req.method === 'GET' && urlPath === '/egress') {
        const facts = deriveEgressFacts(activeConfig, getExternalServers(), true)
        return sendJson(res, 200, {
          inference: facts.inference,
          webDomains: facts.webDomains,
          remoteToolServers: facts.remoteToolServers,
          localStores: facts.localStores,
          hasEgress: facts.hasEgress,
          // Redstart records no retention/training terms for third parties.
          // Reporting the absence is the point — see spec §7.
          externalTermsKnown: false,
        })
      }

      // Available task modes (spec §9). Clients send the ID, so they need to
      // know which IDs exist; the preset text is returned for display only —
      // sending it back has no effect, since the composer resolves IDs.
      if (req.method === 'GET' && urlPath === '/prompt-modes') {
        return sendJson(res, 200, { modes: listModes() })
      }

      // Admin-owned prompt blocks (spec §3).
      //
      // READ is open to any authenticated user, deliberately: the policy block
      // governs how the assistant treats them, and a rule you are subject to
      // but cannot read is not a policy the user can hold the deployment to.
      // WRITE is admin-tier, which is what makes it a floor rather than a
      // preference (spec §4).
      if (req.method === 'GET' && urlPath === '/prompt-blocks') {
        const meta = getPromptBlocksMeta()
        const preview = composePrompt({
          config: activeConfig,
          hasTools: true,
          externalServers: getExternalServers(),
          account: authResult.account,
          admin: getPromptBlocks(),
        })
        return sendJson(res, 200, {
          blocks: meta,
          limits: { maxBlockChars: MAX_BLOCK_CHARS, tokenBudget: DEFAULT_TOKEN_BUDGET },
          // Live budget feedback for the Settings UI (spec §10). Advisory:
          // overBudget is surfaced to the admin, never enforced on the request.
          composed: {
            tokens: preview.tokens,
            overBudget: preview.overBudget,
            blocks: preview.blocks,
            prompt: preview.prompt,
          },
          canEdit: hasAdminAccess(authResult.account),
        })
      }

      if (req.method === 'PUT' && urlPath === '/prompt-blocks') {
        if (!hasAdminAccess(authResult.account)) {
          return sendJson(res, 403, { error: 'Admin role required' })
        }
        const body = await readJsonBody(req)
        if (!body) return sendJson(res, 400, { error: 'Invalid JSON' })
        const result = setPromptBlocks(body, authResult.account?.username)
        if (!result.ok) return sendJson(res, 400, { error: result.error })
        logEvent('prompt', 'blocks_updated', {
          username: authResult.account?.username,
          keys: Object.keys(body).filter(k => typeof body[k] === 'string'),
        })
        return sendJson(res, 200, { blocks: result.blocks })
      }

      if (req.method === 'GET' && urlPath === '/conversations') {
        const convs = getConversations(accountId)
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        return res.end(JSON.stringify(convs))
      }

      const convMatch = /^\/conversations\/([^/]+)$/.exec(urlPath)
      if (convMatch) {
        const [, convId] = convMatch

        if (req.method === 'GET') {
          const conv = getConv(accountId, convId)
          if (!conv) return sendJson(res, 404, { error: { message: 'Not found', type: 'not_found' } })
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
          return res.end(JSON.stringify(conv))
        }

        if (req.method === 'PUT') {
          const body = await readJsonBody(req)
          if (!body) return sendJson(res, 400, { error: { message: 'Bad request', type: 'invalid_request_error' } })
          const updated = updateConversation(accountId, convId, body)
          if (!updated) return sendJson(res, 404, { error: { message: 'Not found', type: 'not_found' } })
          return sendJson(res, 200, updated)
        }

        if (req.method === 'DELETE') {
          const url = new URL(req.url, 'http://x')
          const deleteWithForks = url.searchParams.get('deleteWithForks') === 'true'
          if (deleteWithForks) {
            deleteConversationsWithForks(accountId, convId)
          } else {
            deleteConversation(accountId, convId)
          }
          return sendJson(res, 204)
        }
      }

      if (req.method === 'POST' && urlPath === '/conversations') {
        const body = await readJsonBody(req)
        if (!body?.name) return sendJson(res, 400, { error: { message: 'Name required', type: 'invalid_request_error' } })
        const conv = createConversation(accountId, {
          id: body.id || crypto.randomUUID(),
          name: body.name,
          currNode: body.currNode || '',
          lastModified: Date.now(),
          mcpServerOverrides: body.mcpServerOverrides,
          thinkingEnabled: body.thinkingEnabled,
          reasoningEffort: body.reasoningEffort,
          forkedFromConversationId: body.forkedFromConversationId,
          pinned: body.pinned,
          contextSummary: body.contextSummary,
          messages: body.messages || []
        })
        return sendJson(res, 201, conv)
      }

      // MCP server discovery — the chat-ui fetches this at startup to
      // auto-configure its MCP connections, so servers are managed centrally
      // in Redstart Nest instead of per-device in each client's settings.
      // The built-in server's URL is derived from the Host header the client
      // used to reach us, so it works for both localhost and LAN clients.
      if (req.method === 'GET' && urlPath === '/redstart/mcp-servers') {
        const host = (req.headers.host || `127.0.0.1:${publicPort}`).split(':')[0]
        const servers = []
        if (getMcpServerRunning()) {
          servers.push({ name: 'Redstart Built-in', url: `http://${host}:${publicPort + 2}/sse` })
        }
        for (const s of getExternalServers()) {
          if (s.enabled) servers.push({ name: s.name, url: s.url })
        }
        // Server-enforced tool bans — the chat-ui intersects these with the
        // user's own enable/disable toggles so a banned tool can't be locally
        // re-enabled. The gateway is the real enforcement point; this is UX.
        const disabledTools = getDisabledToolNames(activeConfig)
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ servers, disabledTools }))
        return
      }

      // File explorer API (list / preview / mkdir / rename / delete / upload).
      // Authenticated HERE, once, and the account is handed to the handler —
      // files-api.mjs never inspects a header, so there is exactly one place
      // where identity is established for every one of those routes, and no way
      // for a client to name a user it is not.
      if (urlPath.startsWith('/files/') && urlPath !== '/files/download') {
        const authResult = authenticate(req)
        if (!authResult.ok) {
          res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
          res.end(JSON.stringify({ error: { message: 'Unauthorized', type: 'auth_error' } }))
          return
        }
        const handled = await handleFilesRequest(req, res, urlPath, {
          config: activeConfig,
          account: authResult.account ?? null,
        })
        if (handled) return
      }

      // Serve files created by the File System capability (write_file, etc.)
      // Auth + path containment enforced — the resolved path must stay within the
      // configured fileSystem.rootDir, same as the MCP provider.
      if (req.method === 'GET' && urlPath === '/files/download') {
        const authResult = authenticate(req)
        if (!authResult.ok) {
          res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
          res.end(JSON.stringify({ error: { message: 'Unauthorized', type: 'auth_error' } }))
          return
        }

        // Two capabilities write files a client may need to fetch: File System
        // (write_file) and Documents (create_document). Each has its own root
        // and neither is a subpath of the other, so try both — containment is
        // still enforced per-root by resolveWithinRoot.
        //
        // Scoped to the CALLER'S OWN folder inside each root, matching where
        // the tools now write. This endpoint authenticated the caller and then
        // resolved against the shared roots with no account scoping at all, so
        // any signed-in user could download any other user's files by naming
        // them — and list_documents handed out the names. Scoping it here means
        // another account's path resolves inside your own folder and 404s;
        // there is no ownership comparison to get wrong.
        const scopedRoot = (root) => {
          if (!root) return null
          try {
            return resolveUserRoot(root, authResult.account)
          } catch {
            return null // malformed account — serve nothing rather than the shared root
          }
        }
        const servedRoots = [
          scopedRoot(activeConfig?.fileSystem?.rootDir),
          scopedRoot(activeConfig?.documents?.outputDir),
        ].filter(Boolean)

        if (servedRoots.length === 0) {
          res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
          res.end(JSON.stringify({ error: { message: 'No file-serving capability is configured', type: 'not_found' } }))
          return
        }

        const url = new URL(req.url, 'http://x')
        const relPath = url.searchParams.get('path')
        if (!relPath) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
          res.end(JSON.stringify({ error: { message: 'Missing required query parameter: path', type: 'invalid_request_error' } }))
          return
        }

        // A path that escapes EVERY root is a containment violation (403); one
        // that resolves inside a root but has no file there is simply missing
        // (404). Keeping those distinct preserves the endpoint's contract.
        let fullPath = null
        let containedInSomeRoot = false
        for (const root of servedRoots) {
          let candidate
          try {
            candidate = resolveWithinRoot(root, relPath)
          } catch {
            continue // outside this root — try the next
          }
          containedInSomeRoot = true
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            fullPath = candidate
            break
          }
        }

        if (!containedInSomeRoot) {
          res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
          res.end(JSON.stringify({ error: { message: 'Path is outside the configured file roots', type: 'forbidden' } }))
          return
        }

        if (!fullPath) {
          res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
          res.end(JSON.stringify({ error: { message: 'File not found', type: 'not_found' } }))
          return
        }

        const stat = fs.statSync(fullPath)
        const fileName = path.basename(fullPath)
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': stat.size,
          'Content-Disposition': `attachment; filename="${fileName}"`,
          'Access-Control-Allow-Origin': '*',
        })
        const readStream = fs.createReadStream(fullPath)
        readStream.pipe(res)
        readStream.on('error', () => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
            res.end(JSON.stringify({ error: { message: 'Failed to read file', type: 'internal_error' } }))
          }
        })
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

        const requestHasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0
        // Redstart-specific request field: a MODE ID, never mode prose. The
        // composer validates it against MODE_IDS and drops anything unknown,
        // so a client cannot inject an instruction block by naming a mode
        // that does not exist. Deleted below before forwarding — llama-server
        // has no such parameter and must not see it.
        const requestedMode = parsed.redstart_mode
        delete parsed.redstart_mode

        // account is null when auth is off (see the posture note above) — the
        // composer degrades to a date-only session block rather than failing.
        // Surface comes from authResult — i.e. from the credential the caller
        // presented (spec §8) — never from a header. X-Redstart-Surface stays
        // accepted and inert; the connector-contract suite asserts that.
        parsed.messages = injectSystemContext([...(parsed.messages || [])], activeConfig, requestHasTools, authResult.account, requestedMode, authResult.surface, clientToolNamesIn(parsed))
        parsed = enforceToolAllowList(parsed, activeConfig)

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

    server.listen(publicPort, bindHost, () => {
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
  if (gatewayServer) {
    // Force-close live sockets before close(). server.close() only stops NEW
    // connections and waits for existing ones to end — and HTTP keep-alive means
    // an idle client holds one open indefinitely, so the port stays bound long
    // after a profile switch or shutdown says it was released. stopMcpServer()
    // already does this for the same reason.
    gatewayServer.closeAllConnections()
    gatewayServer.close()
    gatewayServer = null
  }
  activeConfig = null
}

export function updateGatewayConfig(config) {
  activeConfig = config
}

export function getGatewayPort(publicPort) {
  return gatewayServer ? publicPort : null
}
