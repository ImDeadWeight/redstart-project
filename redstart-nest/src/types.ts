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

// The prose the Hub's JSON has no field for, lifted out of a model card.
// `source` says WHICH card answered: 'base_model' means the description came
// from the model this GGUF was quantized from, which is the one written by the
// people who trained it; 'repo' means the quantizer's own README, which is
// usually about the conversion rather than the model.
export type ModelDescription = {
  text: string
  source: 'base_model' | 'repo'
  repoId: string
  truncated: boolean
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

/**
 * What a profile's tools cost, from both directions — see
 * electron/main/ipc/tools.mjs.
 *
 * `toolCount`/`approxTokens` estimate the tools this PROFILE would serve over
 * MCP. `observed` is what the last completion actually forwarded, which is a
 * different and larger set: the payload is composed client-side and the
 * gateway adds a system prompt on top. Null until a completion has been made,
 * and that null is meaningful — it is not the same as costing nothing.
 */
/**
 * What the Tools tab needs to render the retrieval switch honestly.
 *
 * Three separate facts, because they fail separately: the profile setting is
 * on, the embedding model is on disk, and the sidecar is running. A switch that
 * showed only the first would say "on" for a server doing no retrieval at all.
 */
export type RetrievalStatus = {
  enabled: boolean
  model: {
    label: string
    bytes: number
    present: boolean
    download: { state: string; receivedBytes: number; totalBytes: number; error: string | null }
  }
  server: { state: string; reason: string | null; pid: number | null; startedAt: number | null; port: number }
}

export type ToolContextEstimate = {
  toolCount: number
  approxTokens: number
  observed: {
    at: number
    /** Tools the client sent, before bans and before retrieval. */
    toolsOffered: number
    /** What survived the ban filter — the difference from `toolsOffered` is policy. */
    toolsAfterBans: number
    /** Tools that actually reached llama-server. */
    toolsSent: number
    toolTokens: number
    /** The composed system prompt plus the conversation. */
    promptTokens: number
    ctxSize: number | null
    /** Whether tool retrieval was switched on for that request. */
    filtered: boolean
  } | null
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
  // Tool retrieval. When on, the gateway narrows the tool list on each
  // completion to what the conversation plausibly needs, using a local
  // embedding model. Off by default and absent on every profile saved before
  // it, which reads as off — the safe direction, since the whole feature is an
  // optimization the server works without.
  retrieval?: { enabled?: boolean; relativeFloor?: number; floor?: number; margin?: number }
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
  // NOTE: control-plane exposure deliberately does NOT live here. A profile
  // describes how the MODEL runs; where the admin listener binds is a property
  // of the machine. Selecting a profile used to rebind the control plane as a
  // side effect, which put a network-exposure change behind a dropdown whose
  // label promised a model configuration. See ControlPlaneState.
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

// Reconciled against what the OS actually says
// (app.getLoginItemSettings()), not only settings.json — a user can flip
// this off from Task Manager's Startup tab behind Nest's back, so the UI
// must always show what is currently true rather than what was last set.
export type StartupState = {
  // False on a headless daemon, where "start at login" has no
  // meaning: nobody logs in, and a service's boot start belongs to the
  // supervisor, not to Nest. The UI hides the control rather than showing an
  // off switch that can never be turned on.
  supported: boolean
  startAtLogin: boolean
  error?: string
}

// networkMode defaults to true because the main use case is serving other
// devices on the home network. A toggle exists to switch to localhost-only
// (useful if the user only wants to use the chat from the same PC).
export const DEFAULT_CONFIG: LlamaConfig = {
  modelPath: '', ctxSize: 4096, batchSize: 256, threads: 4,
  gpuLayers: undefined, port: 19080, host: '0.0.0.0', networkMode: true,
  nCpuMoe: undefined, kvCache: 'balanced', additionalArgs: '',
}
