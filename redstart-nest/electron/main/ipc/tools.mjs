// Tools IPC namespace — built-in + user tool/group registry and live
// (no-restart) gateway/MCP config application.
//
// buildGatewayConfig lives in index.mjs and is threaded via deps; everything
// else is imported directly from the storage/gateway/definition modules.
//
// Handler bodies are exported as plain functions (Phase 1, §1.3 of the
// headless-admin-plane implementation plan) so an HTTP route can call them
// directly without dragging IPC registration in — importing this module never
// registers anything; only registerToolsHandlers() does that. Two of these
// need `deps` (buildGatewayConfig, userDataDir), so it is threaded through as
// a plain parameter, same shape as the IPC deps object.
import { handle } from './guard.mjs'
import * as path from 'path'
import { BUILTIN_TOOLS, BUILTIN_GROUPS, BUILTIN_CAPABILITIES, CLIENT_APPS } from '../tools-definitions.mjs'
import { getUserTools, getUserGroups, addUserTool, deleteUserTool, addUserGroup, deleteUserGroup } from '../tools-storage.mjs'
import { updateGatewayConfig, getGatewayPort } from '../tools-gateway.mjs'
import { updateMcpConfig, estimateActiveToolTokens } from '../mcp-server.mjs'
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

// Estimates the per-request context cost of the tool set the given profile
// config would activate — same resolution path as an actual launch.
export function estimateToolsContext(llamaConfig, { buildGatewayConfig }) {
  return estimateActiveToolTokens(buildGatewayConfig(llamaConfig))
}

export function registerToolsHandlers(deps) {
  // --- Tools ---

  handle('tools:list-all', () => listAllTools())
  handle('tools:add-tool', (_, tool) => addTool(tool))
  handle('tools:delete-tool', (_, id) => deleteTool(id))
  handle('tools:add-group', (_, group) => addGroup(group))
  handle('tools:delete-group', (_, id) => deleteGroup(id))
  handle('tools:apply-config', (_, llamaConfig) => applyToolsConfig(llamaConfig, deps))
  handle('tools:estimate-context', (_, llamaConfig) => estimateToolsContext(llamaConfig, deps))
}
