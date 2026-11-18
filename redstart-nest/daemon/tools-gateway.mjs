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
// Since master plan Phase 4 this file holds the request pipeline
// (prepareCompletion: the redstart_* fields, bans, the catalog) and the route
// table. The prompt is completion-prompt.mjs; the completions route is
// gateway/completion-route.mjs; forwarding to llama-server is
// gateway/upstream.mjs. What this file exported before, it still exports.
// =============================================================================

import * as http from 'http'
import { authenticate, roleFor, surfacePermitted } from './auth.mjs'
import { resolveEffectiveConfig } from './permissions.mjs'
import { getMcpServerRunning } from './mcp-server.mjs'
import { getExternalServers } from './tools-storage.mjs'
import { builtinCapabilityName, capabilityForTool } from './tools-definitions.mjs'
import { catalogContents, isDeferredTool } from './tool-deferral.mjs'
import { handleFilesRequest } from './files-api.mjs'
import { resolveProject, injectSystemContext, clientToolNamesIn, toolNamesIn } from './completion-prompt.mjs'
import { isCompletionRoute, handleCompletionRoute } from './gateway/completion-route.mjs'
import { passthrough } from './gateway/upstream.mjs'
import { handleAuthRoute } from './gateway/auth-routes.mjs'
import { isConversationRoute, handleConversationRoute } from './gateway/conversation-routes.mjs'
import { isMemoryRoute, handleMemoryRoute } from './gateway/memory-routes.mjs'
import { isApprovalRoute, handleApprovalRoute } from './gateway/approval-routes.mjs'
import { isTaskRoute, handleTaskRoute } from './gateway/task-routes.mjs'
import { isWorkflowRoute, handleWorkflowRoute } from './gateway/workflow-routes.mjs'
import { isProjectRoute, handleProjectRoute } from './gateway/project-routes.mjs'
import { setUpstreamPort } from './completion-activity.mjs'
import { isDocumentIndexRoute, handleDocumentIndexRoute } from './gateway/document-index-routes.mjs'
import { handlePromptRoute } from './gateway/prompt-routes.mjs'
import { handleDownloadRoute } from './gateway/download-route.mjs'
import { recordWireCost, retrievalConfigSummary, retrievalEnabled } from './tool-filter.mjs'
import { toolName } from './tool-retrieval.mjs'

// Exported from here before master plan Phase 4 split them out; importers
// keep reading them from here.
export { firstUserText, injectSystemContext } from './completion-prompt.mjs'
export { RETRIEVAL_REPORT_HEADERS, retrievalReportHeaders } from './gateway/completion-route.mjs'
export { annotateContextError, cancelUpstreamOnHangUp } from './gateway/upstream.mjs'

let gatewayServer = null

// Active tool config: set when the gateway starts, updated when profile changes.
// { allowedBaseUrls: string[], activeTools: {name,baseUrl,description}[], maxFetchTokens: number }
let activeConfig = null

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

// The credential-bound surfaces whose tool lists Redstart composes itself:
// the chat UI (a password session) and Twig (its client key). Every other
// caller keeps the post-ban list it sent unless it asks for retrieval.
const RETRIEVAL_SURFACES = new Set(['nest-chat', 'twig'])

/** Does retrieval run by default for a request on this credential's surface? */
export function retrievalSurface(surface) {
  return typeof surface === 'string' && RETRIEVAL_SURFACES.has(surface)
}

// ---------------------------------------------------------------------------
// Everything the gateway does to a completions body before it is forwarded:
// the redstart_* fields, bans, tool retrieval, the composed prompt, and the
// recorded wire cost (agent-runtime D26).
//
// Lifted out of the request handler, unchanged, so the daemon's own task loop
// (Phase 3) applies exactly what the chat page gets: one path, not a second
// copy that can drift. Nothing here touches the HTTP request or response, so
// the caller supplies what the handler used to read off them.
//
// Mutates and returns `parsed` (the handler's old behaviour), and returns the
// numbers it recorded as `wire`.
//
// @param {any} parsed the request body, already JSON-parsed
// @param {{ account: any, surface: any, effectiveConfig: any, accountId?: any, timeZone: string | null }} facts
//   account and surface come from the credential, never from the body.
//   accountId keyed per-turn selection's cache; callers still pass it, and it
//   is unused since master plan 3.3.
// @returns {Promise<{ parsed: any, wire: object }>}
// ---------------------------------------------------------------------------
export async function prepareCompletion(parsed, { account, surface, effectiveConfig, timeZone }) {
  // Redstart-specific request field: a MODE ID, never mode prose. The
  // composer validates it against MODE_IDS and drops anything unknown,
  // so a client cannot inject an instruction block by naming a mode
  // that does not exist. Deleted below before forwarding — llama-server
  // has no such parameter and must not see it.
  const requestedMode = parsed.redstart_mode
  delete parsed.redstart_mode

  // Redstart-specific request field: a PROJECT ID, never project text
  // (projects-plan D10). Resolved against the caller's own projects, so
  // a foreign or unknown id composes nothing — the same rule as modes.
  // Deleted before forwarding.
  const project = resolveProject(account ?? null, parsed.redstart_project)
  delete parsed.redstart_project

  // Redstart-specific request field: `redstart_retrieval: false` asks the
  // gateway not to narrow THIS request's tools. For a connector that sends
  // its own small, curated tool list (Dungeon Books sends ~25 notes tools)
  // and has no search_tools to recover a dropped one: a selection keyed on
  // the opening message can lose the one tool the task needs for the whole
  // conversation, and the model then tells the user it does not exist.
  // Safe to honour from any client because retrieval is an optimization,
  // never a boundary — opting out can only return the post-BAN list, so a
  // banned tool stays banned. Only the literal `false` opts out; consumed
  // either way so llama-server never sees it.
  //
  // Which requests retrieval runs on at all (master plan Phase 1): only
  // Redstart's own surfaces, by the credential (retrievalSurface), or a
  // request that asks with the literal `true`. A coding agent (Kilo Code,
  // Continue) sends its own tool list on an account-wide key, which names no
  // surface, and never sends this field; rewriting that list under it is not
  // ours to do. `true` exists for what has no surface to name: chat-ui and
  // tasks with login off, and the agent bench on an account-wide key. Asking
  // is as safe as opting out, for the same reason: retrieval only narrows
  // the post-ban list. `false` wins over the surface.
  const retrievalOptOut = parsed.redstart_retrieval === false
    || (parsed.redstart_retrieval !== true && !retrievalSurface(surface))
  delete parsed.redstart_retrieval

  // Redstart-specific request field: `redstart_retrieval_report: true` asks
  // for the names of the tools actually forwarded, as response headers
  // (retrievalReportHeaders). Only the literal `true` asks. The names go to
  // this caller alone, who sent those tools in the first place; the support
  // log stays counts-only. Consumed either way so llama-server never sees it.
  const reportRequested = parsed.redstart_retrieval_report === true
  delete parsed.redstart_retrieval_report

  // `redstart_conversation_id` and `redstart_retrieval_withhold` keyed and
  // narrowed per-turn selection, which master plan 3.3 removed. chat-ui still
  // sends the first and an older bench the second, so both are still
  // consumed, and ignored, so llama-server never sees them.
  delete parsed.redstart_conversation_id
  delete parsed.redstart_retrieval_withhold

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
  // this narrows what survives one, so it can only ever shrink the post-ban
  // list, and because it lands before the prompt is composed, the
  // capability claims still describe what the model actually received.
  //
  // On means the catalog (master plan 3.3): everything that is not deferred,
  // the same list on every turn, so the prompt prefix never changes; the
  // deferred tools are reached through search_tools and call_tool. No
  // embedder and no per-conversation state, and nothing a client sends
  // changes the list, beyond opting out.
  const toolsAfterBans = Array.isArray(parsed.tools) ? parsed.tools.length : 0
  const retrievalOn = !retrievalOptOut && retrievalEnabled(effectiveConfig.toolRetrieval)
  // What the catalog took out, by name, for the prompt's catalog line
  // (catalogContents). Post-ban, so it never names a banned tool.
  const catalogNames = []
  if (retrievalOn && Array.isArray(parsed.tools) && parsed.tools.length > 0) {
    parsed.tools = parsed.tools.filter((t) => {
      const deferred = isDeferredTool(toolName(t), effectiveConfig, capabilityForTool)
      if (deferred) catalogNames.push(toolName(t))
      return !deferred
    })
  }

  const requestHasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0

  // Did the catalog actually take anything away? Counted rather than
  // inferred from the setting: with nothing deferred in the request, it
  // removes nothing, and the prompt must not say it did.
  const toolsSent = Array.isArray(parsed.tools) ? parsed.tools.length : 0
  const toolsFiltered = toolsAfterBans > toolsSent

  parsed.messages = injectSystemContext([...(parsed.messages || [])], effectiveConfig, {
    hasTools: requestHasTools,
    account,
    mode: requestedMode, project,
    surface,
    timeZone,
    clientToolNames: clientToolNamesIn(parsed),
    // Read here, after enforceToolAllowList and the catalog have both had
    // their say, so the capability claims describe the payload
    // the model is actually about to receive.
    toolNames: toolNamesIn(parsed),
    toolsFiltered,
    catalog: catalogContents(catalogNames, capabilityForTool, builtinCapabilityName),
  })

  // What was really forwarded, recorded after every rewrite this function
  // performs. This is the only place that sees all three numbers at once
  // — what the client offered, what survived bans and retrieval, and the
  // prompt the gateway added — and the Tools tab's estimate has never
  // seen any of them.
  const wire = {
    toolsOffered,
    toolsAfterBans,
    tools: parsed.tools,
    messages: parsed.messages,
    ctxSize: effectiveConfig.ctxSize,
    filtered: retrievalOn && toolsAfterBans > 0,
    // For the caller's report only (retrievalReportHeaders). recordWireCost
    // reads counts and never these.
    report: reportRequested,
    toolNamesSent: toolNamesIn(parsed),
    toolsRemoved: toolsFiltered,
    // The settings retrieval ran with (benchmarks H1), only when it ran.
    retrievalConfig: null,
  }
  if (wire.filtered) wire.retrievalConfig = retrievalConfigSummary()
  recordWireCost(wire)

  return { parsed, wire }
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
  setUpstreamPort(internalPort)

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          // X-Redstart-Device-Id is sent by the chat-ui's DatabaseService on
          // every /conversations call; without it here, browsers block those
          // cross-origin requests at preflight. X-Redstart-Timezone rides on
          // every completions call (the user's local date, session-time.mjs).
          // Last-Event-ID: a task's event stream resumes from it (gateway/task-routes.mjs).
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Redstart-Device-Id, X-Redstart-Timezone, Last-Event-ID',
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
      // Tasks run on conversations, so they need the same storage scope.
      if ((isConversationRoute(urlPath) || isTaskRoute(urlPath)) && !accountId) {
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

      if (await handleConversationRoute(req, res, urlPath, accountId, { account: authResult.account ?? null })) return

      // The user's memories (Phase 3). authResult.account is null only with
      // auth off (an auth-on null was refused above), which is the shared
      // _local scope, the same posture as files.
      // Creating one (/remember) is checked against the narrowed config.
      if (isMemoryRoute(urlPath) && await handleMemoryRoute(req, res, urlPath, authResult.account ?? null, { config: effectiveConfig })) return
      // Approvals and standing grants (agent-runtime Phase 2). Same account
      // rule as memories: the caller's own scope, _local with auth off.
      if (isApprovalRoute(urlPath) && await handleApprovalRoute(req, res, urlPath, authResult.account ?? null)) return
      // Background tasks (agent-runtime Phase 3). The conversations scope as
      // above; the surface from the credential, for the runner's per-turn check.
      if (isTaskRoute(urlPath) && await handleTaskRoute(req, res, urlPath, {
        account: authResult.account ?? null,
        storeAccountId: accountId,
        surface: authResult.surface ?? null,
        timeZone: typeof req.headers['x-redstart-timezone'] === 'string' ? req.headers['x-redstart-timezone'] : null,
      })) return
      // Workflows (personal + org). Same account rule as memories; the org
      // write permission is checked inside the route module.
      if (isWorkflowRoute(urlPath) && await handleWorkflowRoute(req, res, urlPath, authResult.account ?? null)) return
      // Projects (personal; sharing is projects-plan D7). Same account rule.
      if (isProjectRoute(urlPath) && await handleProjectRoute(req, res, urlPath, authResult.account ?? null)) return
      if (isDocumentIndexRoute(urlPath) && await handleDocumentIndexRoute(req, res, urlPath, authResult.account ?? null)) return

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

      // Completions: rewritten, then forwarded (gateway/completion-route.mjs).
      // Account and surface from authResult, i.e. from the credential.
      if (isCompletionRoute(req)) {
        return await handleCompletionRoute(req, res, {
          internalPort,
          account: authResult.account,
          surface: authResult.surface,
          effectiveConfig,
          accountId,
          prepareCompletion,
        })
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
  setUpstreamPort(null)
}

export function updateGatewayConfig(config) {
  activeConfig = config
}

/**
 * The config one account sees, as a request from it would resolve it: the
 * running gateway's, narrowed by its role. For the daemon's task loop, which
 * has no request (agent-runtime Phase 3). Null when the gateway is not running
 * (no model loaded): there is nothing to send a completion to.
 *
 * @param {any} account null only with auth off
 */
export function effectiveConfigFor(account) {
  if (!activeConfig) return null
  return resolveEffectiveConfig(account, activeConfig, roleFor(account))
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
