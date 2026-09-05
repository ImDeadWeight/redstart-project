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
import { authenticate, roleFor, surfacePermitted } from './auth.mjs'
import { resolveEffectiveConfig } from './permissions.mjs'
import { getMcpServerRunning } from './mcp-server.mjs'
import { getExternalServers } from './tools-storage.mjs'
import { CLIENT_APP_TOOL_NAMES } from './tools-definitions.mjs'
import { handleFilesRequest } from './files-api.mjs'
import { composePrompt } from './system-prompt.mjs'
import { getPromptBlocks } from './prompt-storage.mjs'
import { handleAuthRoute } from './gateway/auth-routes.mjs'
import { isConversationRoute, handleConversationRoute } from './gateway/conversation-routes.mjs'
import { handlePromptRoute } from './gateway/prompt-routes.mjs'
import { handleDownloadRoute } from './gateway/download-route.mjs'
import { filterRequestTools, estimateMessagesTokens, recordWireCost } from './tool-filter.mjs'

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
function buildSystemContext(config, facts) {
  const { prompt } = composePrompt({
    config,
    externalServers: getExternalServers(),
    admin: getPromptBlocks(),
    ...facts,
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
  const present = new Set(toolNamesIn(parsed))
  const local = []
  for (const names of Object.values(CLIENT_APP_TOOL_NAMES)) {
    for (const name of names) if (present.has(name)) local.push(name)
  }
  return local
}

// Every tool name in the payload, in both shapes the gateway sees: OpenAI's
// { function: { name } } on the wire and MCP's flat { name }.
//
// This is what the capability claims are substantiated against. It must be read
// AFTER bans and retrieval have both run — config says what an admin enabled,
// and since retrieval can narrow a payload without changing any config, config
// is no longer evidence that the model received anything in particular.
function toolNamesIn(parsed) {
  if (!Array.isArray(parsed?.tools)) return []
  const names = []
  for (const tool of parsed.tools) {
    const name = typeof tool === 'object' && tool !== null ? tool.function?.name : tool?.name
    if (typeof name === 'string' && name) names.push(name)
  }
  return names
}

// The composed prompt is PREPENDED to any client-supplied system message, so
// client text lands after the precedence clause and is thereby subordinated to
// admin policy (spec §4). Phase 7 stops accepting client system prose
// altogether; until then this ordering is what makes the floor hold.
function injectSystemContext(messages, config, facts) {
  const context = buildSystemContext(config, facts)
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
//
// TWO KINDS OF ENTRY ARRIVE IN disabledTools, and the difference is deliberate:
//
//   org-wide bans  — an admin's profile.tools.disabledToolIds, which CAN name a
//                    client app ('twig' -> its 8 fs_* names, see CLIENT_APPS).
//   role narrowing — the per-account layer, which expands only over Redstart's
//                    OWN capabilities and so never names a client-app tool.
//
// That asymmetry is the design, not an omission. Twig's tools act on the user's
// own PC, and writing files there is the entire point of Twig; an admin
// restricting what an account may do to the SERVER must not reach across and
// disable the user's local editor. A role withholding file_system therefore
// strips Redstart's read_text_file/write_file and leaves Twig's fs_read_file
// and fs_write_file untouched — they are unknown to CAPABILITY_TOOL_NAMES and
// fall through this filter by construction. Banning a client app stays an
// org-wide decision.
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

// ---------------------------------------------------------------------------
// Context-exceeded diagnosis.
//
// llama-server rejects a prompt larger than n_ctx with HTTP 400 and
// { error: { type: 'exceed_context_size_error', message, n_prompt_tokens,
// n_ctx } } — and in streaming mode too, because an error that is the FIRST
// result is deliberately returned as a non-stream response rather than an SSE
// frame (server-context.cpp, "in streaming mode, the first error must be
// treated as non-stream response"). A prompt too large to process always fails
// before the first token, so this rejection is always the first result.
//
// So the numbers do reach the client. What no client can know is WHY, and the
// answer is usually the same one: every enabled tool's full JSON schema rides
// on every request, so one plugin advertising forty tools can spend more of the
// window than the conversation does. llama-server cannot say that — it never
// saw a tool list, only a rendered prompt — and each client would otherwise
// have to reinvent the explanation. The gateway is the one place that knows
// both halves, so it annotates the message here, once, for every client.
//
// The count is of what was actually FORWARDED (post-ban, and post-retrieval
// when that lands), so the number quoted is the one that was really spent.
// Same chars/4 heuristic as estimateActiveToolTokens — a diagnosis, not an
// accounting.
// ---------------------------------------------------------------------------
function toolCostOf(parsed) {
  const tools = Array.isArray(parsed?.tools) ? parsed.tools : []
  if (tools.length === 0) return null
  return { count: tools.length, approxTokens: Math.ceil(JSON.stringify(tools).length / 4) }
}

export function annotateContextError(body, cost) {
  // Anything unrecognised is returned byte-identical: this must never be able
  // to turn an upstream error into a different one, or a parse failure into a
  // gateway failure.
  if (!cost) return body
  let parsedBody
  try { parsedBody = JSON.parse(body) } catch { return body }
  if (parsedBody?.error?.type !== 'exceed_context_size_error') return body
  if (typeof parsedBody.error.message !== 'string') return body

  const { count, approxTokens } = cost
  parsedBody.error.message +=
    ` About ${approxTokens.toLocaleString()} of those tokens are the ${count} tool definition${count === 1 ? '' : 's'}` +
    ' sent with this request — every enabled tool\'s full schema is included in every message.' +
    ' Turning off tools you are not using, or raising the context size, both free up room.'
  return JSON.stringify(parsedBody)
}

function forwardModified(res, internalPort, parsed) {
  const payload = JSON.stringify(parsed)
  const toolCost = toolCostOf(parsed)
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
    // A 400 is small, complete, and never a stream — buffer it so the tool cost
    // can be added to the message. Every other status is piped exactly as
    // before, so nothing about the streaming path changes.
    if (proxyRes.statusCode === 400 && toolCost) {
      let raw = ''
      proxyRes.setEncoding('utf8')
      proxyRes.on('data', chunk => { raw += chunk })
      proxyRes.on('end', () => {
        const out = annotateContextError(raw, toolCost)
        const headers = withoutUpstreamCors(proxyRes.headers)
        // The body length changed, so the upstream's own value would truncate
        // the response. Drop every spelling of it and let Node recompute.
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === 'content-length') delete headers[key]
        }
        res.writeHead(400, { ...headers, 'Access-Control-Allow-Origin': '*' })
        res.end(out)
      })
      // A truncated error response must still terminate the client's request.
      proxyRes.on('error', () => { if (!res.writableEnded) res.end(raw) })
      return
    }

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
      if (isConversationRoute(urlPath) && !accountId) {
        res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: { message: 'Unauthorized — no account or device ID', type: 'auth_error' } }))
        return
      }

      // May this credential's app reach the server at all? Checked immediately
      // after authentication and before any route, because it is a property of
      // the caller rather than of what they asked for. Surface is taken from
      // authResult — i.e. from the credential — never from a header.
      if (!surfacePermitted(authResult.account, authResult.surface)) {
        res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: { message: 'This account is not permitted to connect from this application', type: 'permission_error' } }))
        return
      }

      // The caller's own view of the server's tool config — activeConfig
      // narrowed by their role (permissions.mjs). Every route below takes THIS,
      // not activeConfig, so a restricted account gets a consistent answer
      // wherever it asks: the tools offered to the model, the system prompt
      // describing them, the ban list the UI renders, and the file explorer all
      // agree. Resolved per request so a role edit lands on the next call.
      const effectiveConfig = resolveEffectiveConfig(
        authResult.account,
        activeConfig,
        roleFor(authResult.account),
      )

      if (await handlePromptRoute(req, res, urlPath, effectiveConfig, authResult.account)) return

      if (await handleConversationRoute(req, res, urlPath, accountId)) return

      // MCP server discovery — the chat-ui fetches this at startup to
      // auto-configure its MCP connections, so servers are managed centrally
      // in Redstart Nest instead of per-device in each client's settings.
      // The built-in server's URL is derived from the Host header the client
      // used to reach us, so it works for both localhost and LAN clients.
      if (req.method === 'GET' && urlPath === '/redstart/mcp-servers') {
        const host = (req.headers.host || `127.0.0.1:${publicPort}`).split(':')[0]
        const servers = []
        if (getMcpServerRunning()) {
          servers.push({ name: 'Redstart Built-in', url: `http://${host}:${publicPort + 2}/mcp` })
        }
        for (const s of getExternalServers()) {
          if (s.enabled) servers.push({ name: s.name, url: s.url })
        }
        // Server-enforced tool bans — the chat-ui intersects these with the
        // user's own enable/disable toggles so a banned tool can't be locally
        // re-enabled. The gateway is the real enforcement point; this is UX.
        // Per-account, so a restricted user's toggle list matches what the MCP
        // server will actually serve them rather than the server-wide set.
        const disabledTools = getDisabledToolNames(effectiveConfig)
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
          // Narrowed, so the web file explorer obeys the same role policy the
          // model does. A role that withholds File System does not hand the
          // account a browsable view of the server's files by another door.
          config: effectiveConfig,
          account: authResult.account ?? null,
        })
        if (handled) return
      }

      // Serve files created by the File System capability (write_file, etc.)
      // Auth + path containment enforced — the resolved path must stay within the
      // configured fileSystem.rootDir, same as the MCP provider.
      if (req.method === 'GET' && urlPath === '/files/download') {
        return handleDownloadRoute(req, res, effectiveConfig)
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

        // Redstart-specific request field: a MODE ID, never mode prose. The
        // composer validates it against MODE_IDS and drops anything unknown,
        // so a client cannot inject an instruction block by naming a mode
        // that does not exist. Deleted below before forwarding — llama-server
        // has no such parameter and must not see it.
        const requestedMode = parsed.redstart_mode
        delete parsed.redstart_mode

        // BANS FIRST, PROMPT SECOND — and every value the prompt is derived
        // from is read AFTER this line. The capability claims must describe
        // what the model actually received this turn, which is the payload the
        // ban filter left behind, not the one the client sent. Composing first
        // broke that in two ways: an org-wide ban on a client app
        // (disabledToolIds naming 'twig') still produced the locality block
        // telling the model it could reach the user's own files, having taken
        // the names from the pre-ban array; and a ban that stripped every tool
        // left `enforceToolAllowList` deleting `parsed.tools` entirely while
        // hasTools was still true, claiming the whole capability section
        // against a payload carrying no tools at all. Both are the
        // substantiation rule in system-prompt.mjs — a claim is made only when
        // the request substantiates it — and the rule can only hold if the
        // request has already been narrowed.
        const toolsOffered = Array.isArray(parsed.tools) ? parsed.tools.length : 0

        parsed = enforceToolAllowList(parsed, effectiveConfig)

        // RETRIEVAL THIRD, and strictly between the two. Bans are a boundary;
        // this is a selection over what survives one, so it can only ever
        // shrink the post-ban list — and because it lands before the prompt is
        // composed, the capability claims still describe what the model
        // actually received. Off by default, and a failure of any kind returns
        // the array by identity, so `parsed.tools` is unchanged.
        //
        // The budget is measured on the WIRE, not from the Tools tab's
        // estimate: that estimator walks the providers Nest would serve over
        // MCP, while parsed.tools is composed client-side and is a different
        // set. Reserving the messages plus a pins-only prompt gives a LOWER
        // bound on the non-tool cost, which is what breaks the circularity of
        // budgeting for a prompt that does not exist yet.
        const toolsAfterBans = Array.isArray(parsed.tools) ? parsed.tools.length : 0
        if (Array.isArray(parsed.tools) && parsed.tools.length > 0) {
          const pinsOnlyPrompt = injectSystemContext(
            [...(parsed.messages || [])], effectiveConfig,
            {
              hasTools: true,
              account: authResult.account,
              mode: requestedMode,
              surface: authResult.surface,
              clientToolNames: [],
              toolNames: [],
              toolsFiltered: false,
            },
          )
          parsed.tools = await filterRequestTools({
            tools: parsed.tools,
            messages: parsed.messages || [],
            accountId,
            settings: effectiveConfig.toolRetrieval,
            ctxSize: effectiveConfig.ctxSize,
            reservedTokens: estimateMessagesTokens(pinsOnlyPrompt),
          })
        }

        const requestHasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0

        // Did retrieval actually take anything away? Counted rather than
        // inferred from the setting, because filterRequestTools fails open and
        // because selectTools returns a fresh array even when it kept
        // everything — an identity check would report a subset that is not one.
        const toolsSent = Array.isArray(parsed.tools) ? parsed.tools.length : 0
        const toolsFiltered = toolsAfterBans > toolsSent

        // account is null when auth is off (see the posture note above) — the
        // composer degrades to a date-only session block rather than failing.
        // Surface comes from authResult — i.e. from the credential the caller
        // presented (spec §8) — never from a header. X-Redstart-Surface stays
        // accepted and inert; the connector-contract suite asserts that.
        parsed.messages = injectSystemContext([...(parsed.messages || [])], effectiveConfig, {
          hasTools: requestHasTools,
          account: authResult.account,
          mode: requestedMode,
          surface: authResult.surface,
          clientToolNames: clientToolNamesIn(parsed),
          // Read here, after enforceToolAllowList and filterRequestTools have
          // both had their say, so the capability claims describe the payload
          // the model is actually about to receive.
          toolNames: toolNamesIn(parsed),
          toolsFiltered,
        })

        // What was really forwarded, recorded after every rewrite this block
        // performs. This is the only place that sees all three numbers at once
        // — what the client offered, what survived bans and retrieval, and the
        // prompt the gateway added — and the Tools tab's estimate has never
        // seen any of them.
        recordWireCost({
          toolsOffered,
          toolsAfterBans,
          tools: parsed.tools,
          messages: parsed.messages,
          ctxSize: effectiveConfig.ctxSize,
          filtered: toolsAfterBans > 0 && effectiveConfig.toolRetrieval?.enabled === true,
        })

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

/**
 * Is the RUNNING gateway filtering tools?
 *
 * Deliberately distinct from what the profile says. A profile field only
 * reaches the gateway when the profile is saved and applied, so the two can
 * legitimately disagree — and a switch that reported the profile while the
 * server was still using the previous settings would be lying about the thing
 * the user actually wants to know.
 */
export function gatewayToolRetrieval() {
  return {
    gatewayUp: gatewayServer !== null,
    enabled: activeConfig?.toolRetrieval?.enabled === true,
  }
}

export function getGatewayPort(publicPort) {
  return gatewayServer ? publicPort : null
}
