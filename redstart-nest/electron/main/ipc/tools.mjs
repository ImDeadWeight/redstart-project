// Tools IPC namespace — built-in + user tool/group registry and live
// (no-restart) gateway/MCP config application.
//
// buildGatewayConfig lives in index.mjs and is threaded via deps; everything
// else is imported directly from the storage/gateway/definition modules.
//
// Handler bodies are exported as plain functions so an HTTP route can call them
// directly without dragging IPC registration in — importing this module never
// registers anything; only registerToolsHandlers() does that. Two of these
// need `deps` (buildGatewayConfig, userDataDir), so it is threaded through as
// a plain parameter, same shape as the IPC deps object.
import * as path from 'path'
import { BUILTIN_TOOLS, BUILTIN_GROUPS, BUILTIN_CAPABILITIES, CLIENT_APPS } from '../tools-definitions.mjs'
import { getUserTools, getUserGroups, addUserTool, deleteUserTool, addUserGroup, deleteUserGroup } from '../tools-storage.mjs'
import { updateGatewayConfig, getGatewayPort } from '../tools-gateway.mjs'
import { updateMcpConfig, estimateActiveToolTokens } from '../mcp-server.mjs'
import { observedWireCost } from '../tool-filter.mjs'
import { EMBED_MODEL, embedModelPath, hasEmbedModel, ensureEmbedModel } from '../embed-model.mjs'
import { startEmbedServer, stopEmbedServer, embedServerStatus } from '../embed-server.mjs'
import { syncFilesystemProvider } from '../filesystem-mcp-provider.mjs'

export function listAllTools() {
  return {
    builtinTools:        BUILTIN_TOOLS,
    builtinGroups:       BUILTIN_GROUPS,
    builtinCapabilities: BUILTIN_CAPABILITIES,
    // Client applications that supply their own tools. Not capabilities this
    // server provides — the set the Banned Tools control exists to moderate.
    clientApps:          CLIENT_APPS,
    userTools:           getUserTools(),
    userGroups:          getUserGroups(),
  }
}

export function addTool(tool) {
  return addUserTool(tool)
}

export function deleteTool(id) {
  return deleteUserTool(id)
}

export function addGroup(group) {
  return addUserGroup(group)
}

export function deleteGroup(id) {
  return deleteUserGroup(id)
}

// Apply a live tool config change without restarting the server. Called when
// the user saves a profile that has tools configured while the server is
// already running.
export function applyToolsConfig(llamaConfig, deps) {
  const { buildGatewayConfig, userDataDir } = deps
  if (!getGatewayPort(llamaConfig?.port ?? 19080)) return false
  const cfg = buildGatewayConfig(llamaConfig)
  updateGatewayConfig(cfg)
  updateMcpConfig(cfg)
  // Fire-and-forget: spawning/handshaking the File System child process
  // takes a moment and this IPC call isn't awaited by its caller.
  syncFilesystemProvider(cfg.fileSystem, path.join(userDataDir, 'mcp-fs-logs'))
    .catch((err) => console.warn('[filesystem-mcp-provider] sync failed:', err.message))
  // Same shape, and for the same reason: the retrieval switch has a 67 MB
  // download and a child process behind it, and neither may hold up a settings
  // save. A failure leaves the sidecar down, which the gateway already treats
  // as "forward the full tool list".
  try {
    syncRetrieval(llamaConfig, deps)
  } catch (err) {
    console.warn('[retrieval] could not apply the retrieval setting:', err.message)
  }
  return true
}

/**
 * What a profile's tools cost, from both directions.
 *
 * `toolCount`/`approxTokens` are the CONFIGURATION-TIME estimate: the tools
 * this config would serve over MCP, resolved the same way an actual launch
 * resolves them. It is a hint about a profile, and it under-counts a real
 * request by construction — the completions payload is composed client-side
 * (live MCP connections, health-check tools, a client app's own local tools)
 * and the gateway then adds a system prompt the client never counted.
 *
 * `observed` is the OTHER number: what the last completion actually forwarded.
 * Null until one has been. The two are reported side by side rather than
 * reconciled into one, because they measure different things and a single
 * number would have to be wrong about one of them.
 */
export function estimateToolsContext(llamaConfig, { buildGatewayConfig }) {
  return {
    ...estimateActiveToolTokens(buildGatewayConfig(llamaConfig)),
    observed: observedWireCost(),
  }
}

// ---------------------------------------------------------------------------
// Tool retrieval
// ---------------------------------------------------------------------------
// Enabling retrieval needs three things to happen that a profile field alone
// cannot do: the 67 MB embedding model has to exist on disk, the sidecar has to
// be running, and the gateway has to be told. This is where the first two are
// arranged, so the UI is one switch rather than a checklist.
//
// Downloading on enable rather than behind a separate button is deliberate:
// there is exactly one thing a user can want after switching this on, and a
// second click that can only ever be pressed is a step, not a choice.

/** @type {{ state: string, receivedBytes: number, totalBytes: number, error: string|null }} */
let modelDownload = { state: 'idle', receivedBytes: 0, totalBytes: EMBED_MODEL.size, error: null }

/**
 * Everything the Tools tab needs to render the retrieval switch honestly: is it
 * on for this profile, is the model here, is the sidecar up.
 */
export function retrievalStatus(llamaConfig, { resolveModelsDir }) {
  return {
    enabled: llamaConfig?.tools?.retrieval?.enabled === true,
    model: {
      label: EMBED_MODEL.label,
      bytes: EMBED_MODEL.size,
      present: hasEmbedModel(resolveModelsDir()),
      download: modelDownload,
    },
    server: embedServerStatus(),
  }
}

/**
 * Make the running system match `tools.retrieval.enabled`.
 *
 * Never throws and never blocks the caller on a 67 MB transfer: the download
 * runs detached and its progress is read back through retrievalStatus(). A
 * failure leaves retrieval off in practice while the profile field stays on,
 * which is the honest state — the gateway is already built to forward the full
 * tool list whenever the sidecar cannot answer.
 */
export function syncRetrieval(llamaConfig, {
  resolveModelsDir, ensureModelsDir, resolveBinary, userDataDir,
  // Test seams. Production passes neither; the suite injects both so it can
  // drive this without a 67 MB transfer and without spawning anything.
  fetchModel = ensureEmbedModel, startServer = startEmbedServer,
}) {
  const wanted = llamaConfig?.tools?.retrieval?.enabled === true
  if (!wanted) {
    stopEmbedServer({ configDir: userDataDir })
    return { enabled: false }
  }

  const modelsDir = resolveModelsDir()
  if (hasEmbedModel(modelsDir)) {
    startServer({ resolveBinary, configDir: userDataDir, modelPath: embedModelPath(modelsDir) })
      .catch(err => console.warn('[retrieval] could not start the embedding server:', err.message))
    return { enabled: true, downloading: false }
  }

  if (modelDownload.state === 'downloading') return { enabled: true, downloading: true }

  ensureModelsDir()
  modelDownload = { state: 'downloading', receivedBytes: 0, totalBytes: EMBED_MODEL.size, error: null }
  fetchModel({
    modelsDir,
    onProgress: (p) => { modelDownload.receivedBytes = p.receivedBytes ?? 0 },
  }).then(async (modelPath) => {
    if (!modelPath) {
      modelDownload = { ...modelDownload, state: 'failed', error: 'the embedding model could not be downloaded' }
      return
    }
    modelDownload = { ...modelDownload, state: 'ready', receivedBytes: EMBED_MODEL.size, error: null }
    await startServer({ resolveBinary, configDir: userDataDir, modelPath })
  }).catch(err => {
    modelDownload = { ...modelDownload, state: 'failed', error: err?.message ?? 'unknown error' }
  })
  return { enabled: true, downloading: true }
}

export function toolsHandlers(deps) {
  return {
    'tools:list-all': () => listAllTools(),
    'tools:add-tool': (tool) => addTool(tool),
    'tools:delete-tool': (id) => deleteTool(id),
    'tools:add-group': (group) => addGroup(group),
    'tools:delete-group': (id) => deleteGroup(id),
    'tools:apply-config': (llamaConfig) => applyToolsConfig(llamaConfig, deps),
    'tools:estimate-context': (llamaConfig) => estimateToolsContext(llamaConfig, deps),
    'tools:retrieval-status': (llamaConfig) => retrievalStatus(llamaConfig, deps),
    'tools:sync-retrieval': (llamaConfig) => syncRetrieval(llamaConfig, deps),
  }
}
