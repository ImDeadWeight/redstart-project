// =============================================================================
// Redstart Nest — shared renderer types
// =============================================================================
// Domain types shared by App.tsx, the domain hooks, and the panel/tab
// components. The IPC surface itself (RedstartAPI) lives in api/redstart.ts.
// =============================================================================

// vram/vramFree are MB; memory.total/available are GB (historical, kept so the
// existing panels don't shift units).
//
// vramFree is 0 on non-NVIDIA GPUs — the WMI fallback has no free-VRAM source.
// vram itself is also unreliable there: Win32_VideoController.AdapterRAM caps
// at 4095 MB, so a 16 GB AMD card reports as 4 GB. The Models tab shows these
// as context without drawing a conclusion from them; see the note in
// electron/main/ipc/hardware.mjs before building anything that decides.
export type HardwareSpecs = {
  cpu: { name: string; cores: number; threads: number; architecture: string; supportsAVX: boolean }
  gpu: { name: string; vram: number; vramFree: number; cudaAvailable: boolean }
  memory: { total: number; available: number }
  os: { platform: string; arch: string }
}

// --- Hugging Face model catalog ---------------------------------------------

export type CatalogModel = {
  repoId: string
  author: string
  downloads: number
  likes: number
  lastModified: string | null
  gated: boolean
  quants: string[]
  ggufFileCount: number
}

export type ModelArtifact = {
  id: string
  quantLabel: string
  quantRecognized: boolean
  files: { rfilename: string; size: number | null; sha256: string | null; shardIndex: number | null }[]
  shardTotal: number
  totalBytes: number | null
  complete: boolean
  verifiable: boolean
}

export type ModelDetail = {
  repoId: string
  author: string
  revision: string | null
  gated: boolean
  downloads: number
  likes: number
  license: string | null
  lastModified: string | null
  architecture: string | null
  paramCount: number | null
  contextLength: number | null
  chatTemplate: string | null
  experts: { total: number; active: number | null } | null
  artifacts: ModelArtifact[]
}

export type LocalModelFile = {
  name: string
  path: string
  size: number
  modified: number
  partial: boolean
}

export type DownloadProgress = {
  repoId: string
  artifactId?: string
  state: 'downloading' | 'skipped' | 'complete' | 'cancelled' | 'error'
  fileIndex?: number
  fileCount?: number
  receivedBytes?: number
  totalBytes?: number
  bytesPerSec?: number
  error?: string | null
}

export type WebFetchTool = {
  id: string
  name: string
  baseUrl?: string
  description: string
  builtIn: boolean
  kind?: 'web' | 'capability'
}

// A client application that ships its own tools (Twig today; Blueprints,
// Greenhouse, Yellowscript later). Unlike a capability, these tools do not run
// on this server — they arrive already inside the completions request, so the
// gateway's name-strip is the only control the server has over them.
export type ClientApp = {
  id: string
  name: string
  description: string
  toolNames: string[]
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
  // An admin uses this to enforce an org policy (e.g. disable write_file)
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
