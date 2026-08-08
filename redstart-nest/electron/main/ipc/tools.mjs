// Tools IPC namespace — built-in + user tool/group registry and live
// (no-restart) gateway/MCP config application.
//
// buildGatewayConfig lives in index.mjs and is threaded via deps; everything
// else is imported directly from the storage/gateway/definition modules.
import { ipcMain } from 'electron'
import * as path from 'path'
import { BUILTIN_TOOLS, BUILTIN_GROUPS, BUILTIN_CAPABILITIES, CLIENT_APPS } from '../tools-definitions.mjs'
import { getUserTools, getUserGroups, addUserTool, deleteUserTool, addUserGroup, deleteUserGroup } from '../tools-storage.mjs'
import { updateGatewayConfig, getGatewayPort } from '../tools-gateway.mjs'
import { updateMcpConfig, estimateActiveToolTokens } from '../mcp-server.mjs'
import { syncFilesystemProvider } from '../filesystem-mcp-provider.mjs'

export function registerToolsHandlers({ buildGatewayConfig, userDataDir }) {
  // --- Tools ---

  ipcMain.handle('tools:list-all', () => {
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
  })

  ipcMain.handle('tools:add-tool', (_, tool) => addUserTool(tool))
  ipcMain.handle('tools:delete-tool', (_, id) => deleteUserTool(id))
  ipcMain.handle('tools:add-group', (_, group) => addUserGroup(group))
  ipcMain.handle('tools:delete-group', (_, id) => deleteUserGroup(id))

  // Apply a live tool config change without restarting the server.
  // Called when the user saves a profile that has tools configured while the
  // server is already running.
  ipcMain.handle('tools:apply-config', (_, llamaConfig) => {
    if (!getGatewayPort(llamaConfig?.port ?? 19080)) return false
    const cfg = buildGatewayConfig(llamaConfig)
    updateGatewayConfig(cfg)
    updateMcpConfig(cfg)
    // Fire-and-forget: spawning/handshaking the File System child process
    // takes a moment and this IPC call isn't awaited by its caller.
    syncFilesystemProvider(cfg.fileSystem, path.join(userDataDir, 'mcp-fs-logs'))
      .catch((err) => console.warn('[filesystem-mcp-provider] sync failed:', err.message))
    return true
  })

  // Estimates the per-request context cost of the tool set the given profile
  // config would activate — same resolution path as an actual launch.
  ipcMain.handle('tools:estimate-context', (_, llamaConfig) => {
    return estimateActiveToolTokens(buildGatewayConfig(llamaConfig))
  })
}
