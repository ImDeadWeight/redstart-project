// Tools IPC namespace — built-in + user tool/group registry and live
// (no-restart) gateway/MCP config application.
//
// buildGatewayConfig lives in index.mjs and is threaded via deps; everything
// else is imported directly from the storage/gateway/definition modules.
import { ipcMain } from 'electron'
import { BUILTIN_TOOLS, BUILTIN_GROUPS, BUILTIN_CAPABILITIES } from '../tools-definitions.mjs'
import { getUserTools, getUserGroups, addUserTool, deleteUserTool, addUserGroup, deleteUserGroup } from '../tools-storage.mjs'
import { updateGatewayConfig, getGatewayPort } from '../tools-gateway.mjs'
import { updateMcpConfig, estimateActiveToolTokens } from '../mcp-server.mjs'

export function registerToolsHandlers({ buildGatewayConfig }) {
  // --- Tools ---

  ipcMain.handle('tools:list-all', () => {
    return {
      builtinTools:        BUILTIN_TOOLS,
      builtinGroups:       BUILTIN_GROUPS,
      builtinCapabilities: BUILTIN_CAPABILITIES,
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
    return true
  })

  // Estimates the per-request context cost of the tool set the given profile
  // config would activate — same resolution path as an actual launch.
  ipcMain.handle('tools:estimate-context', (_, llamaConfig) => {
    return estimateActiveToolTokens(buildGatewayConfig(llamaConfig))
  })
}
