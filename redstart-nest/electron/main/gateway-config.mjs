// Tool gateway config builder + live-refresh.
//
// buildGatewayConfig resolves a profile's tool settings (group/tool IDs, plus
// the globally-configured capability providers) into the flat config the
// gateway and MCP server consume. It is pure over its inputs — every
// collaborator is imported directly, so it takes no injected deps.
//
// createRefreshLiveToolsConfig closes over the live `serverState` (owned by
// index.mjs) and returns the no-arg refreshLiveToolsConfig used as a dep by the
// capabilities/tools IPC handlers, so a capability config change takes effect on
// an already-running server without a restart.
//
// Note: tools-gateway.mjs RUNS the gateway (proxy, auth, allow-list, system
// context) and CONSUMES this config; this module PRODUCES it. No overlap.
import * as path from 'path'
import { BUILTIN_TOOLS, BUILTIN_GROUPS, expandDisabledToolIds } from './tools-definitions.mjs'
import { getUserTools, getUserGroups, getCapabilities } from './tools-storage.mjs'
import { updateGatewayConfig, getGatewayPort } from './tools-gateway.mjs'
import { updateMcpConfig } from './mcp-server.mjs'
import { syncFilesystemProvider } from './filesystem-mcp-provider.mjs'
import { decryptSecret } from './secrets.mjs'
import { listPlugins } from './plugin-registry.mjs'
import { syncPluginProviders, stopAllPlugins } from './plugin-provider.mjs'

export function buildGatewayConfig(llamaConfig) {
  const toolSettings = llamaConfig?.tools

  // Server-enforced tool bans. The admin disables capability/tool IDs at the
  // profile level; expand them to the concrete MCP function names the model
  // sees so the gateway can strip them from every completions request.
  const disabledTools = expandDisabledToolIds(toolSettings?.disabledToolIds)

  const allTools = [
    ...BUILTIN_TOOLS.map(t => ({ ...t, builtIn: true })),
    ...getUserTools(),
  ]
  const allGroups = [
    ...BUILTIN_GROUPS.map(g => ({ ...g, builtIn: true })),
    ...getUserGroups(),
  ]

  if (!toolSettings?.enabled) {
    return {
      disabledTools,
      webFetch: { enabled: false, whitelistEnabled: true, allowedBaseUrls: [], activeTools: [], maxFetchTokens: 2000 },
      postgres: { enabled: false },
      documents: { enabled: false },
      sqlite: { enabled: false },
      vault:     { enabled: false },
      fileSystem: { enabled: false },
      git:       { enabled: false },
      scholar: { enabled: false },
      ...Object.fromEntries(listPlugins().map((p) => [p.id, { enabled: false, isPlugin: true }])),
    }
  }

  const toolIdSet = new Set(toolSettings.activeToolIds || [])

  // Add all tool IDs from active groups
  for (const groupId of (toolSettings.activeGroupIds || [])) {
    const group = allGroups.find(g => g.id === groupId)
    if (group) group.toolIds.forEach(id => toolIdSet.add(id))
  }

  const allowedBaseUrls = []
  const activeTools = []
  for (const id of toolIdSet) {
    const tool = allTools.find(t => t.id === id)
    if (tool?.baseUrl) {
      allowedBaseUrls.push(tool.baseUrl)
      // `id` rides along so a role can narrow the web sources it permits by id
      // (permissions.mjs). Without it the only handle on a source here is its
      // display name or base URL, neither of which is a stable identifier.
      activeTools.push({ id: tool.id, name: tool.name, baseUrl: tool.baseUrl, description: tool.description || '' })
    }
  }

  // A capability is active for this profile when its card is enabled for the
  // profile (activeToolIds) AND it has whatever it needs to run (a folder or a
  // connection string). The stored per-capability `enabled` flag is vestigial —
  // it still exists in tools.json for back-compat but no longer gates anything;
  // the card's Enable/Disable button writes to activeToolIds instead.
  const capabilities = getCapabilities()

  const postgresWanted = toolIdSet.has('postgres') && !!capabilities.postgres.connectionStringEnc
  let postgresConnectionString = null
  if (postgresWanted) {
    try {
      postgresConnectionString = decryptSecret(capabilities.postgres.connectionStringEnc)
    } catch (err) {
      console.warn('Failed to decrypt Postgres connection string:', err.message)
    }
  }

  const documentsWanted = toolIdSet.has('documents') && !!capabilities.documents.outputDir
  const sqliteWanted = toolIdSet.has('sqlite') && !!capabilities.sqlite.rootDir
  const vaultWanted = toolIdSet.has('vault') && !!capabilities.vault.rootDir
  const gitWanted = toolIdSet.has('git') && !!capabilities.git.rootDir
  const fileSystemWanted = toolIdSet.has('file_system') && !!capabilities.file_system.rootDir
  const scholarWanted = toolIdSet.has('scholar')

  return {
    disabledTools,
    webFetch: {
      // Absent webAccessEnabled means enabled — see ProfileTools.webAccessEnabled
      // in src/types.ts for why this is `!== false` and not an activeToolIds check.
      enabled: toolSettings.webAccessEnabled !== false,
      // Per-profile toggle: with the whitelist OFF the model may fetch any
      // public http(s) URL (private/LAN addresses always blocked in the
      // provider). Defaults to ON — restriction is the out-of-box posture.
      whitelistEnabled: toolSettings.whitelistEnabled !== false,
      allowedBaseUrls,
      activeTools,
      maxFetchTokens: toolSettings.maxFetchTokens ?? 2000,
    },
    postgres: {
      enabled: postgresWanted && !!postgresConnectionString,
      connectionString: postgresConnectionString,
      maxRows: capabilities.postgres.maxRows,
    },
    documents: {
      enabled: documentsWanted,
      outputDir: capabilities.documents.outputDir,
    },
    sqlite: {
      enabled: sqliteWanted,
      rootDir: capabilities.sqlite.rootDir,
      maxRows: capabilities.sqlite.maxRows,
      maxFileBytes: capabilities.sqlite.maxFileBytes,
    },
    vault: {
      enabled: vaultWanted,
      rootDir: capabilities.vault.rootDir,
    },
    git: {
      enabled: gitWanted,
      rootDir: capabilities.git.rootDir,
    },
    // NOTE: camelCase `fileSystem` — the filesystem provider and the gateway's
    // /files/download endpoint both read cfg.fileSystem (matching the webFetch
    // convention). Emitting snake_case here silently disabled the whole
    // capability in production (tools never advertised, calls rejected).
    fileSystem: {
      enabled: fileSystemWanted,
      rootDir: capabilities.file_system.rootDir,
      // Permission policy consumed by the MCP tools/call gate. Default posture:
      // writes on, deletes off (see DEFAULT_CAPABILITIES.file_system).
      allowWrite: capabilities.file_system.allowWrite !== false,
      allowDestructive: capabilities.file_system.allowDestructive === true,
    },
    scholar: {
      enabled: scholarWanted,
      venueFilter: capabilities.scholar.venueFilter,
      // PDFs land in the Documents folder so read_document can pick them up.
      saveDir: capabilities.documents.outputDir,
    },
    // Plugins are capabilities (decision D1), so they obey the same two-key
    // model as every built-in: enabled in the registry by an admin AND
    // activated for this profile via activeToolIds. `isPlugin` is what tells
    // the policy gate in mcp-server.mjs to apply per-plugin write/destructive
    // policy rather than the File System rules.
    ...Object.fromEntries(listPlugins().map((p) => [p.id, {
      enabled: p.enabled === true && toolIdSet.has(p.id),
      isPlugin: true,
      allowWrite: p.allowWrite === true,
      allowDestructive: p.allowDestructive === true,
    }])),
  }
}

// Re-resolves and pushes tool config to the already-running gateway/MCP
// server — used after a capability's global config changes (connection
// string, output folder) so a change takes effect without a full restart.
// No-op if the server isn't running or no profile has been launched yet.
export function createRefreshLiveToolsConfig(serverState, userDataDir) {
  return function refreshLiveToolsConfig() {
    if (!serverState.lastConfig) return
    if (!getGatewayPort(serverState.lastConfig.port ?? 19080)) return
    const cfg = buildGatewayConfig(serverState.lastConfig)
    updateGatewayConfig(cfg)
    updateMcpConfig(cfg)
    // Fire-and-forget: the File System child process takes a moment to spawn
    // and handshake, and this refresh path isn't awaited by its callers.
    syncFilesystemProvider(cfg.fileSystem, path.join(userDataDir, 'mcp-fs-logs'))
      .catch((err) => console.warn('[filesystem-mcp-provider] sync failed:', err.message))
    // Terminates the child of any plugin that has just been disabled. Registry
    // state alone does not kill a process.
    syncPluginProviders(cfg)
  }
}
