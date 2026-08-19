// =============================================================================
// Redstart Nest — renderer-side IPC bridge
// =============================================================================
// Typed access to the redstartAPI object the preload script exposes on
// window. Renderer code calls api() (throws loudly if the preload failed) or
// getAPI() (returns undefined) — nothing else touches window directly, so the
// full IPC surface is documented in exactly one place.
// =============================================================================

import type {
  HardwareSpecs, WebFetchTool, CapabilityConfig, ToolGroup,
  ExternalMcpServer, LlamaConfig, ClientApp,
  CatalogModel, ModelDetail, ModelArtifact, LocalModelFile, DownloadProgress,
} from '../types'

export type RedstartAPI = {
  hardware: {
    scan: () => Promise<HardwareSpecs>
    selectModel: () => Promise<string | null>
  }
  llama: {
    generateCommand: (config: LlamaConfig) => Promise<string>
    launch: (config: LlamaConfig) => Promise<{ success: boolean; error?: string; pid?: number }>
  }
  server: {
    stop: (config: LlamaConfig) => Promise<{ success: boolean }>
    status: (config: LlamaConfig) => Promise<{ running: boolean; health: string | null; pid?: number }>
    getIp: () => Promise<string>
    // Pushes updated tools settings (activeToolIds/disabledToolIds/
    // activeGroupIds/enabled) to an already-running server without a
    // restart. { live: false } when nothing is running to push to — not an
    // error, the next launch reads the saved profile fresh regardless.
    syncTools: (tools: LlamaConfig['tools']) => Promise<{ live: boolean }>
  }
  profiles: {
    list: () => Promise<string[]>
    save: (name: string, config: LlamaConfig) => Promise<boolean>
    load: (name: string) => Promise<LlamaConfig | null>
    delete: (name: string) => Promise<boolean>
    generateDefaults: (hardware: HardwareSpecs) => Promise<LlamaConfig[]>
  }
  tools: {
    listAll: () => Promise<{ builtinTools: WebFetchTool[], builtinGroups: ToolGroup[], builtinCapabilities: WebFetchTool[], clientApps: ClientApp[], userTools: WebFetchTool[], userGroups: ToolGroup[] }>
    addTool: (tool: Omit<WebFetchTool, 'builtIn'>) => Promise<boolean>
    deleteTool: (id: string) => Promise<boolean>
    addGroup: (group: Omit<ToolGroup, 'builtIn'>) => Promise<boolean>
    deleteGroup: (id: string) => Promise<boolean>
    applyConfig: (config: LlamaConfig) => Promise<boolean>
  }
  settings: {
    getBinaryPath: () => Promise<string | null>
    setBinaryPath: (p: string | null) => Promise<boolean>
    selectBinary: () => Promise<string | null>
    getResolvedBinary: () => Promise<string | null>
    // Always resolves to a real path — the user's choice, or the provisioned
    // <Documents>\Redstart\Models default. Never null.
    getModelsDir: () => Promise<string>
    setModelsDir: (p: string | null) => Promise<string>
    selectModelsDir: () => Promise<string | null>
  }
  models: {
    publishers: () => Promise<{ id: string; label: string; note: string }[]>
    search: (opts: { query?: string; publisher?: string; limit?: number })
      => Promise<{ ok: boolean; models?: CatalogModel[]; error?: string }>
    detail: (repoId: string) => Promise<{ ok: boolean; detail?: ModelDetail; error?: string }>
    local: () => Promise<{ ok: boolean; dir: string; files: LocalModelFile[]; error?: string }>
    diskSpace: () => Promise<{ ok: boolean; dir: string; freeBytes?: number; totalBytes?: number; error?: string }>
    revealFolder: () => Promise<string>
    deleteLocal: (name: string) => Promise<{ ok: boolean; error?: string }>
    download: (req: { repoId: string; revision: string | null; artifact: ModelArtifact })
      => Promise<{ ok: boolean; cancelled?: boolean; error?: string; result?: { modelPath: string; totalBytes: number } }>
    cancelDownload: () => Promise<{ ok: boolean; error?: string }>
    downloadStatus: () => Promise<{ active: boolean; repoId?: string; artifactId?: string }>
  }
  github: { checkReleases: () => Promise<Record<string, string>> }
  auth: {
    getConfig: () => Promise<{ authRequired: boolean; hasOwner: boolean }>
    setRequired: (required: boolean) => Promise<boolean>
    createFirstAdmin: (username: string, password: string) => Promise<{ success: boolean; error?: string; apiKey?: string; id?: string }>
  }
  mcp: {
    listExternal: () => Promise<ExternalMcpServer[]>
    // Registration is validated in the main process — an external MCP server is
    // its own trust boundary, and this IPC channel is the only way into the
    // registry. `warnings` are non-blocking cautions to surface in the UI.
    // Passing an existing `id` upserts that entry instead of creating a new
    // one — this is also how editing a server works, there is no separate
    // update channel. `apiKey` is plaintext on the wire in (like Postgres's
    // connectionString) but never comes back out — see hasApiKey on
    // ExternalMcpServer. Blank/absent on an edit keeps the existing key.
    addExternal: (server: Omit<ExternalMcpServer, 'id' | 'hasApiKey'> & { id?: string; apiKey?: string | null }) => Promise<
      { ok: true; server: ExternalMcpServer; warnings: string[] } | { ok: false; error: string }
    >
    validateExternal: (url: string) => Promise<{ ok: boolean; error?: string; warnings: string[]; isRemote?: boolean }>
    removeExternal: (id: string) => Promise<boolean>
    // `id` resolves and decrypts a saved server's key server-side — the
    // renderer never holds it. `apiKey` inline is for testing a not-yet-saved
    // value from the add/edit form.
    testExternal: (server: { id?: string; url: string; apiKey?: string | null }) => Promise<{ ok: boolean; message: string }>
  }
  capabilities: {
    get: () => Promise<CapabilityConfig>
    setPostgres: (config: { connectionString?: string; maxRows?: number; enabled?: boolean }) => Promise<{ ok: boolean; error?: string }>
    testPostgres: (connectionString?: string) => Promise<{ ok: boolean; message: string }>
    selectDocumentsFolder: () => Promise<string | null>
    setDocumentsFolder: (config: { outputDir?: string; enabled?: boolean }) => Promise<{ ok: boolean }>
    selectSqliteFolder: () => Promise<string | null>
    setSqlite: (config: { rootDir?: string; maxRows?: number; enabled?: boolean }) => Promise<{ ok: boolean }>
    estimateToolContext: (config: LlamaConfig) => Promise<{ toolCount: number; approxTokens: number }>
    selectVaultFolder: () => Promise<string | null>
    setVault: (config: { rootDir?: string; enabled?: boolean }) => Promise<{ ok: boolean }>
    selectGitFolder: () => Promise<string | null>
    setGit: (config: { rootDir?: string; enabled?: boolean }) => Promise<{ ok: boolean }>
    selectFileSystemFolder: () => Promise<string | null>
    setFileSystem: (config: { rootDir?: string; enabled?: boolean; allowWrite?: boolean; allowDestructive?: boolean }) => Promise<{ ok: boolean }>
    setScholar: (config: { venueFilter?: string; enabled?: boolean }) => Promise<{ ok: boolean }>
  }
  plugins: {
    list: () => Promise<PluginSummary[]>
    get: (id: string) => Promise<(PluginSummary & { tools: PluginToolInfo[] }) | null>
    // Fetches/resolves the source and probes it. Nothing is persisted — see
    // confirmInstall. `env` values are plaintext for this one round trip only.
    install: (req: {
      id: string
      source: { kind: 'npm'; packageName: string; version: string }
        // Phase 7 — installed via uv, not npm. Field is `identifier` (pypi's
        // own term, matches the registry API's package entries) rather than
        // `packageName`, so the source object's own shape says which
        // resolver it needs.
        | { kind: 'pypi'; identifier: string; version: string }
        | { kind: 'command'; command: string; args?: string[] }
        | { kind: 'path'; path: string }
      env?: Record<string, { value: string; isSecret: boolean }>
      timeoutMs?: number
    }) => Promise<
      { ok: true; tools: PluginToolInfo[]; resolvedCommand: string; resolvedArgs: string[]
        resolvedVersion: string | null; integrity: string | null; installDir: string | null; runAsNode: boolean }
      // Two distinct failure shapes, both real: the npm/probe pipeline
      // (electron/main/plugin-install.mjs) reports { reason, detail }; the
      // handler's own up-front validation (bad id, id already installed,
      // malformed source, ...) goes through ipc/plugins.mjs's shared
      // refuse() helper and reports { error } instead.
      | { ok: false; reason: string; detail?: string }
      | { ok: false; error: string }
    >
    cancelInstall: () => Promise<{ ok: boolean; error?: string }>
    installStatus: () => Promise<{ active: boolean; id?: string }>
    // Persists the reviewed entry. Always saved enabled:false regardless of
    // what is sent — enabling is a separate, deliberate act.
    confirmInstall: (entry: {
      id: string; displayName?: string
      source: { kind: 'npm' | 'pypi' | 'path' | 'command' } & Record<string, unknown>
      resolvedCommand: string; resolvedArgs: string[]
      resolvedVersion: string | null; integrity: string | null; installDir: string | null; runAsNode: boolean
      timeoutMs?: number
      tools: PluginToolInfo[]
      env?: Record<string, { value: string; isSecret: boolean }>
    }) => Promise<{ ok: boolean; error?: string }>
    setEnabled: (id: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>
    setClass: (id: string, toolName: string, cls: PluginToolInfo['class']) => Promise<{ ok: boolean; error?: string }>
    setClasses: (id: string, toolNames: string[], cls: PluginToolInfo['class']) => Promise<{ ok: boolean; updated?: number; error?: string }>
    uninstall: (id: string) => Promise<{ ok: boolean; folderRemoved?: boolean; error?: string }>
    test: (id: string) => Promise<{ ok: boolean; message: string }>
    search: (opts: { query?: string; cursor?: string }) => Promise<
      { ok: true; entries: RegistrySearchResult[]; nextCursor: string | null } | { ok: false; error: string }
    >
    pickFolder: () => Promise<string | null>
  }
  events: {
    onTokensPerMinute: (cb: (tpm: number) => void) => void
    offTokensPerMinute: () => void
    onServerLog: (cb: (line: string) => void) => void
    offServerLog: () => void
    onServerStopped: (cb: () => void) => void
    offServerStopped: () => void
    onModelDownloadProgress: (cb: (p: DownloadProgress) => void) => void
    offModelDownloadProgress: () => void
    onPluginInstallProgress: (cb: (p: PluginInstallProgress) => void) => void
    offPluginInstallProgress: () => void
  }
}

// --- Plugin types -------------------------------------------------------
// Kept here (not usePlugins.ts) so the IPC surface and its payload shapes live
// in one place, the same way every other namespace above does. usePlugins.ts
// re-exports these under its own names for tab/component call sites.

export type PluginSummary = {
  id: string
  displayName: string
  source: { kind: 'npm' | 'pypi' | 'path' | 'command'; packageName?: string; identifier?: string; version?: string; path?: string; command?: string } | null
  resolvedVersion: string | null
  enabled: boolean            // registry master switch (Plugins tab), NOT activeToolIds
  allowWrite: boolean
  allowDestructive: boolean
  toolCount: number
  // Of toolCount, how many actually reach tools/list right now — purely a
  // function of classification + this plugin's write/destructive policy, NOT
  // of whether any profile has activated it. A fresh install is 0 until
  // classified (every discovered tool starts 'destructive', D-b).
  advertisedCount: number
  hasSecret: boolean
  lastError: string | null
  lastErrorAt: string | null
  installedAt: string | null
  lastHandshakeAt: string | null
}

export type PluginToolInfo = {
  name: string
  description: string
  class: 'read' | 'write' | 'destructive' | 'network'
  inputSchema?: Record<string, unknown>
}

export type PluginInstallProgress = {
  id: string
  state: 'resolving' | 'installing' | 'probing' | 'done' | 'error'
  message?: string
}

export type RegistrySearchResult = {
  name: string
  description: string
  packageName?: string
  version?: string
  // Phase 7: which install source kind this result needs ('npm' vs 'pypi') —
  // the two resolvers are not interchangeable, so picking a result has to
  // route to the right one. Absent/other values (oci, mcpb, ...) never reach
  // an installable verdict, so the renderer never needs to branch on them.
  registryType?: string
  verdict: { state: 'installable' | 'needs-setup' | 'needs-runtime' | 'unsupported'; reason?: string }
  fields: { name: string; description: string; format: string; isRequired: boolean; isSecret: boolean; default?: unknown; placeholder?: string }[]
}

export const getAPI = (): RedstartAPI | undefined => (window as unknown as { redstartAPI?: RedstartAPI }).redstartAPI

export const api = (): RedstartAPI => {
  const a = getAPI()
  if (!a) throw new Error('redstartAPI not available — preload may have failed')
  return a
}
