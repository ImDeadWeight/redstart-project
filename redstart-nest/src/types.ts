// =============================================================================
// Redstart Nest — shared renderer types
// =============================================================================
// Domain types shared by App.tsx, the domain hooks, and the panel/tab
// components. The IPC surface itself (RedstartAPI) lives in api/redstart.ts.
// =============================================================================

export type HardwareSpecs = {
  cpu: { name: string; cores: number; threads: number; architecture: string; supportsAVX: boolean }
  gpu: { name: string; vram: number; cudaAvailable: boolean }
  memory: { total: number; available: number }
  os: { platform: string; arch: string }
}

export type WebFetchTool = {
  id: string
  name: string
  baseUrl?: string
  description: string
  builtIn: boolean
  kind?: 'web' | 'capability'
}

export type CapabilityConfig = {
  postgres: { enabled: boolean; hasConnectionString: boolean; maxRows: number }
  documents: { enabled: boolean; outputDir: string | null }
  sqlite: { enabled: boolean; rootDir: string | null; maxRows: number }
  vault: { enabled: boolean; rootDir: string | null }
  git: { enabled: boolean; rootDir: string | null }
  file_system: { enabled: boolean; rootDir: string | null; allowWrite: boolean; allowDestructive: boolean }
  scholar: { enabled: boolean; venueFilter: string | null }
}

export type ToolGroup = {
  id: string
  name: string
  description: string
  toolIds: string[]
  builtIn: boolean
}

export type ExternalMcpServer = {
  id: string
  name: string
  url: string
  enabled: boolean
}

export type ProfileTools = {
  enabled: boolean
  activeGroupIds: string[]
  activeToolIds: string[]
  maxFetchTokens: number
  whitelistEnabled?: boolean  // default true; false = model may fetch any public http(s) URL (LAN/private always blocked)
  // Server-enforced tool bans. Tool names listed here are removed from the
  // model's vocabulary for every client (gateway strips them from the
  // completions request), regardless of a user's local enable/disable toggle.
  // An admin uses this to enforce an org policy (e.g. disable fs_write_file)
  // that non-technical staff cannot override client-side.
  disabledToolIds: string[]
}

export type LlamaConfig = {
  modelPath: string
  ctxSize: number
  batchSize: number
  threads: number
  gpuLayers?: number
  port: number
  host: string
  networkMode?: boolean
  nCpuMoe?: number
  priority?: 'high'
  noMmap?: boolean
  kvCache?: 'off' | 'conservative' | 'balanced' | 'aggressive'
  additionalArgs?: string
  tools?: ProfileTools
  advertisedHost?: string
}

export type ServerState = 'stopped' | 'starting' | 'running' | 'stopping'

// networkMode defaults to true because the main use case is serving other
// devices on the home network. A toggle exists to switch to localhost-only
// (useful if the user only wants to use the chat from the same PC).
export const DEFAULT_CONFIG: LlamaConfig = {
  modelPath: '', ctxSize: 4096, batchSize: 256, threads: 4,
  gpuLayers: undefined, port: 19080, host: '0.0.0.0', networkMode: true,
  advertisedHost: 'redstart.local',
  nCpuMoe: undefined, kvCache: 'balanced', additionalArgs: '',
}
