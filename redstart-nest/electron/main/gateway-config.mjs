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
import { BUILTIN_TOOLS, BUILTIN_GROUPS, expandDisabledToolIds } from './tools-definitions.mjs'
import { getUserTools, getUserGroups, getCapabilities } from './tools-storage.mjs'
import { updateGatewayConfig, getGatewayPort } from './tools-gateway.mjs'
import { updateMcpConfig } from './mcp-server.mjs'
import { decryptSecret } from './secrets.mjs'

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
      file_system: { enabled: false },
      git:       { enabled: false },
      scholar: { enabled: false },
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
      activeTools.push({ name: tool.name, baseUrl: tool.baseUrl, description: tool.description || '' })
    }
  }

  // Capability providers (Postgres, Documents) are only active for this
  // profile when BOTH the admin has configured+enabled them globally AND
  // this profile's activeToolIds includes them — same relationship
  // externalServers already have to profiles, extended with a per-profile flag.
  const capabilities = getCapabilities()

  const postgresWanted = toolIdSet.has('postgres') && capabilities.postgres.enabled && !!capabilities.postgres.connectionStringEnc
  let postgresConnectionString = null
  if (postgresWanted) {
    try {
      postgresConnectionString = decryptSecret(capabilities.postgres.connectionStringEnc)
    } catch (err) {
      console.warn('Failed to decrypt Postgres connection string:', err.message)
    }
  }

  const documentsWanted = toolIdSet.has('documents') && capabilities.documents.enabled && !!capabilities.documents.outputDir
  const sqliteWanted = toolIdSet.has('sqlite') && capabilities.sqlite.enabled && !!capabilities.sqlite.rootDir
  const vaultWanted = toolIdSet.has('vault') && capabilities.vault.enabled && !!capabilities.vault.rootDir
  const gitWanted = toolIdSet.has('git') && capabilities.git.enabled && !!capabilities.git.rootDir
  const fileSystemWanted = toolIdSet.has('file_system') && capabilities.file_system.enabled && !!capabilities.file_system.rootDir
  const scholarWanted = toolIdSet.has('scholar') && capabilities.scholar.enabled

  return {
    disabledTools,
    webFetch: {
      enabled: true,
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
    file_system: {
      enabled: fileSystemWanted,
      rootDir: capabilities.file_system.rootDir,
    },
    scholar: {
      enabled: scholarWanted,
      venueFilter: capabilities.scholar.venueFilter,
      // PDFs land in the Documents folder so read_document can pick them up.
      saveDir: capabilities.documents.outputDir,
    },
  }
}

// Re-resolves and pushes tool config to the already-running gateway/MCP
// server — used after a capability's global config changes (connection
// string, output folder) so a change takes effect without a full restart.
// No-op if the server isn't running or no profile has been launched yet.
export function createRefreshLiveToolsConfig(serverState) {
  return function refreshLiveToolsConfig() {
    if (!serverState.lastConfig) return
    if (!getGatewayPort(serverState.lastConfig.port ?? 19080)) return
    const cfg = buildGatewayConfig(serverState.lastConfig)
    updateGatewayConfig(cfg)
    updateMcpConfig(cfg)
  }
}
