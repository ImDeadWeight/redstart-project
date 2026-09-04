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
export function applyToolsConfig(llamaConfig, { buildGatewayConfig, userDataDir }) {
  if (!getGatewayPort(llamaConfig?.port ?? 19080)) return false
  const cfg = buildGatewayConfig(llamaConfig)
  updateGatewayConfig(cfg)
  updateMcpConfig(cfg)
  // Fire-and-forget: spawning/handshaking the File System child process
  // takes a moment and this IPC call isn't awaited by its caller.
  syncFilesystemProvider(cfg.fileSystem, path.join(userDataDir, 'mcp-fs-logs'))
    .catch((err) => console.warn('[filesystem-mcp-provider] sync failed:', err.message))
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

export function toolsHandlers(deps) {
  return {
    'tools:list-all': () => listAllTools(),
    'tools:add-tool': (tool) => addTool(tool),
    'tools:delete-tool': (id) => deleteTool(id),
    'tools:add-group': (group) => addGroup(group),
    'tools:delete-group': (id) => deleteGroup(id),
    'tools:apply-config': (llamaConfig) => applyToolsConfig(llamaConfig, deps),
    'tools:estimate-context': (llamaConfig) => estimateToolsContext(llamaConfig, deps),
  }
}
