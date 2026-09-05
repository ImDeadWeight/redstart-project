// =============================================================================
// Redstart Nest — renderer-side control-plane API
// =============================================================================
// The type every RedstartAPI method lives under, and typed access to the
// installed implementation (api/http.ts). Renderer code calls api() (throws
// loudly if no session is installed yet) or getAPI() (returns undefined) —
// the full API surface is documented in exactly one place.
// =============================================================================

import type {
  HardwareSpecs, WebFetchTool, CapabilityConfig, ToolGroup, ToolContextEstimate, RetrievalStatus,
  ExternalMcpServer, LlamaConfig, ClientApp, ControlPlaneState, StartupState,
  CatalogModel, ModelDetail, ModelDescription, ModelArtifact, LocalModelFile, DownloadProgress,
} from '../types'

export type RedstartAPI = {
  hardware: {
    scan: () => Promise<HardwareSpecs>
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
  // The control plane's own exposure — read-only from the launcher.
  admin: {
    getControlPlane: () => Promise<ControlPlaneState>
    // The full status endpoint — active profile is
    // deliberately absent, see the comment above getFullStatus() in
    // ipc/admin.mjs for why; the model path is absent on the same privacy
    // stance server.mjs already takes for the event log.
    getStatus: () => Promise<{
      running: boolean
      pid: number | null
      startedAt: number | null
      uptimeMs: number | null
      lastError: string | null
      port: number | null
      networkMode: boolean | null
      gateway: { port: number | null }
      mcp: { running: boolean }
      adminListener: ControlPlaneState
    }>
    // Rebinds the control plane immediately — an admin
    // flipping this may be doing it to recover access, so it never waits for
    // a restart. `host` is a bind address, not a boolean;
    // NetworkPanel.tsx's exposure toggle only ever sends '127.0.0.1' or '0.0.0.0'.
    // Rejected addresses (and a failed bind) restore the previous one and
    // report why in `error`; `state` is always the listener's state after
    // the call, success or not, so the caller never has to re-fetch.
    setBindHost: (host: string) => Promise<{ ok: boolean; error?: string; state: ControlPlaneState }>
    // Reconciled against the OS's own login-item record, not
    // just settings.json — see StartupState's own comment for why.
    getStartup: () => Promise<StartupState>
    // Owner-gated like every control-plane route. Persists to settings.json
    // AND calls app.setLoginItemSettings() so a later launch (background or
    // not) and the Startup toggle here never disagree with Windows' own
    // Task Manager view of it.
    setStartup: (startAtLogin: boolean) => Promise<StartupState>
    // The only way to stop the daemon now that the window no
    // longer means anything. Owner-gated. The daemon answers 200 and
    // THEN quits on the next tick, so this always resolves before the
    // connection drops — a caller does not need to treat a network error
    // here as ambiguous between "it worked" and "it crashed".
    shutdown: () => Promise<{ ok: boolean }>
  }
  // The FolderPicker.tsx mechanism — one component behind
  // all nine former per-site pickers. Native picking (pickNative) is retired
  // along with IPC — roots/list/mkdir is the only picker there
  // is now, used identically by every caller.
  browse: {
    roots: () => Promise<{ path: string; label: string }[]>
    // readable/writable are the daemon's own access() probe on
    // each path - best-effort and not a promise (a share can drop, and on
    // Windows W_OK reflects the read-only attribute rather than the ACL), but
    // a definite `false` is what lets the picker refuse a folder the daemon
    // cannot use while the admin is still looking at it.
    list: (opts: { path: string }) => Promise<{ path: string; parent: string | null; entries: { name: string; kind: 'directory'; readable?: boolean; writable?: boolean }[]; reason?: string; readable?: boolean; writable?: boolean }>
    mkdir: (opts: { path: string; name: string }) => Promise<{ ok: boolean; path?: string; error?: string }>
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
    retrievalStatus: (config: LlamaConfig) => Promise<RetrievalStatus>
    syncRetrieval: (config: LlamaConfig) => Promise<{ enabled: boolean; downloading?: boolean }>
  }
  settings: {
    getBinaryPath: () => Promise<string | null>
    setBinaryPath: (p: string | null) => Promise<boolean>
    getResolvedBinary: () => Promise<string | null>
    // Always resolves to a real path — the user's choice, or the provisioned
    // <Documents>\Redstart\Models default. Never null.
    getModelsDir: () => Promise<string>
    setModelsDir: (p: string | null) => Promise<string>
  }
  models: {
    publishers: () => Promise<{ id: string; label: string; note: string }[]>
    search: (opts: { query?: string; publisher?: string; limit?: number })
      => Promise<{ ok: boolean; models?: CatalogModel[]; error?: string }>
    detail: (repoId: string) => Promise<{ ok: boolean; detail?: ModelDetail; error?: string }>
    describe: (repoId: string) => Promise<{ ok: boolean; description?: ModelDescription | null; error?: string }>
    local: () => Promise<{ ok: boolean; dir: string; files: LocalModelFile[]; error?: string }>
    diskSpace: () => Promise<{ ok: boolean; dir: string; freeBytes?: number; totalBytes?: number; error?: string }>
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
    setDocumentsFolder: (config: { outputDir?: string; enabled?: boolean }) => Promise<{ ok: boolean }>
    setSqlite: (config: { rootDir?: string; maxRows?: number; enabled?: boolean }) => Promise<{ ok: boolean }>
    estimateToolContext: (config: LlamaConfig) => Promise<ToolContextEstimate>
    setVault: (config: { rootDir?: string; enabled?: boolean }) => Promise<{ ok: boolean }>
    setGit: (config: { rootDir?: string; enabled?: boolean }) => Promise<{ ok: boolean }>
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
        // Installed via uv, not npm. Field is `identifier` (pypi's
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
    // Display only. The id — the ban handle and the tools' namespace prefix —
    // is deliberately not renameable; see setPluginDisplayName in ipc/plugins.mjs.
    setDisplayName: (id: string, displayName: string) => Promise<{ ok: boolean; error?: string; displayName?: string }>
    setClass: (id: string, toolName: string, cls: PluginToolInfo['class']) => Promise<{ ok: boolean; error?: string }>
    setClasses: (id: string, toolNames: string[], cls: PluginToolInfo['class']) => Promise<{ ok: boolean; updated?: number; error?: string }>
    uninstall: (id: string) => Promise<{ ok: boolean; folderRemoved?: boolean; error?: string }>
    test: (id: string) => Promise<{ ok: boolean; message: string }>
    search: (opts: { query?: string; cursor?: string }) => Promise<
      { ok: true; entries: RegistrySearchResult[]; nextCursor: string | null } | { ok: false; error: string }
    >
  }
  events: {
    onTokensPerMinute: (cb: (tpm: number) => void) => void
    offTokensPerMinute: () => void
    onServerLog: (cb: (line: string) => void) => void
    offServerLog: () => void
    onServerStopped: (cb: () => void) => void
    offServerStopped: () => void
    // Broadcast to every SSE subscriber on a successful launch, from
    // whichever client launched it — see useServerLifecycle.ts, which is
    // the only thing this is for: a client that did NOT launch the server
    // (a second tab, or the Electron window while admingate launches from a
    // phone) has no other way to learn a launch just happened. Mirrors
    // server:stopped, which already covered the reverse direction.
    onServerStarted: (cb: () => void) => void
    offServerStarted: () => void
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
  /** The registry's canonical reverse-DNS identifier, e.g. io.github.artokun/comfyui-mcp. */
  name: string
  /** What a person should see: the registry's own `title` where it has one, else derived. */
  suggestedDisplayName: string
  description: string
  packageName?: string
  version?: string
  // Which install source kind this result needs ('npm' vs 'pypi') —
  // the two resolvers are not interchangeable, so picking a result has to
  // route to the right one. Absent/other values (oci, mcpb, ...) never reach
  // an installable verdict, so the renderer never needs to branch on them.
  registryType?: string
  verdict: { state: 'installable' | 'needs-setup' | 'needs-runtime' | 'unsupported'; reason?: string }
  fields: { name: string; description: string; format: string; isRequired: boolean; isSecret: boolean; default?: unknown; placeholder?: string }[]
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
// ONE implementation of the type above now: api/http.ts, installed by
// AdminGate.tsx once it has a session. Every caller — a browser tab, the
// Electron window — is an HTTP client of the admin listener; there is no
// second transport to choose between any more.
//
// This module used to also hold a preload-bridge implementation
// (`window.redstartAPI`, set only inside Electron) and the
// activeTransport()/isRemote()/isDaemonLocal() predicates that branched on
// which one was live. All retired with the bridge itself — "the Electron UI
// is a client of the daemon, like Twig."

let httpApi: RedstartAPI | undefined

/**
 * Install the HTTP implementation.
 *
 * Called once by the shell after it has a session. Kept as an injection rather
 * than constructed here so this module stays free of session handling — a
 * detail that only exists for one of the two transports.
 */
export const setHttpAPI = (impl: RedstartAPI | undefined): void => { httpApi = impl }

export const getAPI = (): RedstartAPI | undefined => httpApi

export const api = (): RedstartAPI => {
  const a = getAPI()
  if (!a) throw new Error('No transport available — no session has been established yet')
  return a
}
