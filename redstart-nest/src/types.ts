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
  // Whether an API key is stored for this server — never the key itself. The
  // key is encrypted at rest (electron/main/secrets.mjs, OS-level) and the
  // main process never sends the ciphertext or plaintext back to the
  // renderer, same as Postgres's hasConnectionString. Sent as
  // `Authorization: Bearer <apiKey>` on the connection test.
  hasApiKey: boolean
}

export type ProfileTools = {
  enabled: boolean
  activeGroupIds: string[]
  activeToolIds: string[]
  maxFetchTokens: number
  whitelistEnabled?: boolean  // default true; false = model may fetch any public http(s) URL (LAN/private always blocked)
  // Web Access (web_fetch + web_search) on/off for this profile. Absent means
  // enabled: web access predates this flag and was unconditionally on, so every
  // profile saved before it must keep working. That is why this is a boolean
  // read as `!== false` rather than membership in activeToolIds like the
  // capabilities — an absent array entry would read as "off" and silently
  // disable web access for every existing profile.
  webAccessEnabled?: boolean
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
  // Whether THIS profile wants the control plane (admin listener) reachable
  // on the network when it's selected — separate from networkMode (the data
  // plane) for the same reason ControlPlaneState is its own type: a control
  // plane on the LAN by default is a real security decision (see
  // headless-admin-plane-plan.md decision 4/19), not one to make silently
  // for every install. Tying it to profiles instead of a bare global default
  // means "my home profile opens the admin panel to the LAN, my laptop-only
  // profile doesn't" without a first-run prompt. Undefined (older saved
  // profiles, or one never touched this session) means "leave the current
  // exposure alone" — only a profile that explicitly saved a value ever
  // changes it on load.
  exposeControlPlane?: boolean
}

export type ServerState = 'stopped' | 'starting' | 'running' | 'stopping'

// Where the admin listener (the control plane) is bound. Separate from
// networkMode on purpose: that is the DATA plane's exposure, read only at
// server launch, while this is the control plane's and takes effect the moment
// it changes. `exposed` is the one fact the UI warns on.
export type ControlPlaneState = {
  running: boolean
  bindHost: string | null
  port: number
  exposed: boolean
}

// Phase 7 §7.4. Reconciled against what the OS actually says
// (app.getLoginItemSettings()), not only settings.json — a user can flip
// this off from Task Manager's Startup tab behind Nest's back, so the UI
// must always show what is currently true rather than what was last set.
export type StartupState = {
  startAtLogin: boolean
}

// networkMode defaults to true because the main use case is serving other
// devices on the home network. A toggle exists to switch to localhost-only
// (useful if the user only wants to use the chat from the same PC).
export const DEFAULT_CONFIG: LlamaConfig = {
  modelPath: '', ctxSize: 4096, batchSize: 256, threads: 4,
  gpuLayers: undefined, port: 19080, host: '0.0.0.0', networkMode: true,
  nCpuMoe: undefined, kvCache: 'balanced', additionalArgs: '',
}
