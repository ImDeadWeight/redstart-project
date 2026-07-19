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
  ExternalMcpServer, LlamaConfig,
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
  }
  profiles: {
    list: () => Promise<string[]>
    save: (name: string, config: LlamaConfig) => Promise<boolean>
    load: (name: string) => Promise<LlamaConfig | null>
    delete: (name: string) => Promise<boolean>
    generateDefaults: (hardware: HardwareSpecs) => Promise<LlamaConfig[]>
  }
  tools: {
    listAll: () => Promise<{ builtinTools: WebFetchTool[], builtinGroups: ToolGroup[], builtinCapabilities: WebFetchTool[], userTools: WebFetchTool[], userGroups: ToolGroup[] }>
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
  }
  github: { checkReleases: () => Promise<Record<string, string>> }
  auth: {
    getConfig: () => Promise<{ authRequired: boolean; hasOwner: boolean }>
    setRequired: (required: boolean) => Promise<boolean>
    createFirstAdmin: (username: string, password: string) => Promise<{ success: boolean; error?: string; apiKey?: string; id?: string }>
  }
  mcp: {
    listExternal: () => Promise<ExternalMcpServer[]>
    addExternal: (server: Omit<ExternalMcpServer, 'id'>) => Promise<ExternalMcpServer>
    removeExternal: (id: string) => Promise<boolean>
    testExternal: (url: string) => Promise<{ ok: boolean; message: string }>
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
  events: {
    onTokensPerMinute: (cb: (tpm: number) => void) => void
    offTokensPerMinute: () => void
    onServerLog: (cb: (line: string) => void) => void
    offServerLog: () => void
    onServerStopped: (cb: () => void) => void
    offServerStopped: () => void
  }
}

export const getAPI = (): RedstartAPI | undefined => (window as unknown as { redstartAPI?: RedstartAPI }).redstartAPI

export const api = (): RedstartAPI => {
  const a = getAPI()
  if (!a) throw new Error('redstartAPI not available — preload may have failed')
  return a
}
