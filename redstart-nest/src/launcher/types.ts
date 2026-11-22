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
// daemon/ipc/hardware.mjs before building anything that decides.
export type HardwareSpecs = {
  cpu: { name: string; cores: number; threads: number; architecture: string; supportsAVX: boolean }
  // unifiedMemory: Apple Silicon — the GPU shares system RAM, so vram is the
  // share of memory.total the GPU may use, not a separate pool.
  gpu: { name: string; vram: number; vramFree: number; cudaAvailable: boolean; unifiedMemory?: boolean }
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
  /** The repo ships a vision projector (mmproj). Absent from an older daemon. */
  vision?: boolean
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
  /** The vision projector downloaded with this quant, or null for a text-only repo. Absent from an older daemon. */
  projector?: { rfilename: string; size: number | null; sha256: string | null } | null
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
  /** The document-search embedding model — not a chat model. Absent from an older daemon. */
  embedding?: boolean
  /** Shard 2..N of a split GGUF — not a loadable path on its own. Absent from an older daemon. */
  extraShard?: boolean
  /** A vision projector (mmproj) — loaded with its model, not on its own. Absent from an older daemon. */
  projector?: boolean
  /** The projector this model launches with (--mmproj), or null. Absent from an older daemon. */
  visionProjector?: string | null
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
 * daemon/ipc/tools.mjs.
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
 * on, the embedding model is on disk, and the sidecar is answering (its state
 * is 'starting' between spawn and the first healthy /health). A switch that
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
  /** What the RUNNING gateway is doing — only equals `enabled` once the profile has been saved. */
  applied: { gatewayUp: boolean; enabled: boolean }
}

export type ToolContextEstimate = {
  toolCount: number
  approxTokens: number
  /**
   * The most recent completion the daemon forwarded, from ANY account — one
   * observation, overwritten per request, never a series. See recordWireCost.
   */
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
    /** Whether tool retrieval (the catalog) was switched on for that request. */
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
  web_search: { searxngUrl: string | null; hasBraveApiKey: boolean }
  python: PythonCapabilityStatus
  // Shared Documents (master plan 6.2): searched by search_documents for
  // every account its role's grants allow. null: none chosen.
  shared_documents?: { rootDir: string | null }
  deferral: DeferralEntry[]
}

// Catalog-only per capability (master plan Phase 3.1): reached through
// search_tools and call_tool instead of sitting in the prompt. Only takes
// effect while the profile's tool retrieval is on.
export type DeferralEntry = {
  id: string
  name: string
  plugin: boolean
  byDefault: boolean
  overridden: boolean
  deferred: boolean
}

// run_python (chat-tooling Phase 1). Settings plus what the server can say
// about running it: sandboxAvailable is false on a Node without the network
// permission (daemon/python-runtime.mjs), and the tool is then never served.
export type PythonCapabilityStatus = {
  maxKernels: number
  timeoutS: number
  workspaceCapMb: number
  accountCapMb: number
  pyodideVersion: string
  pythonVersion: string
  packages: string[]
  runtimeInstalled: boolean
  runtimeProblem: string | null
  installing: boolean
  approxDownloadBytes: number
  approxKernelBytes: number
  sandboxAvailable: boolean
  sandboxProblem: string | null
  sandboxNode: string | null
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
  // key is encrypted at rest (daemon/secrets.mjs, OS-level) and the
  // main process never sends the ciphertext or plaintext back to the
  // renderer, same as Postgres's hasConnectionString. Sent as
  // `Authorization: Bearer <apiKey>` on the connection test.
  hasApiKey: boolean
}

export type WebSearchEngine = 'none' | 'searxng' | 'brave'

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
  // General web search engine for web_search's "web" source. Absent = 'none':
  // off is the default (chat-tooling plan D1). The engine's connection (SearXNG
  // URL, Brave key) is global, in CapabilityConfig.web_search.
  webSearchEngine?: WebSearchEngine
  // Server-enforced tool bans. Tool names listed here are removed from the
  // model's vocabulary for every client (gateway strips them from the
  // completions request), regardless of a user's local enable/disable toggle.
  // An admin uses this to enforce an org policy (e.g. disable write_file)
  // that non-technical staff cannot override client-side.
  disabledToolIds: string[]
  // Tool retrieval. When on, the gateway keeps the catalog-only (deferred)
  // tools out of every completion's list, the same list on every turn, and the
  // model reaches them through search_tools and call_tool (master plan 3.3).
  // ON by default since 2026-11-18: absent reads as on, and only an explicit
  // `false` turns it off (retrievalOnFor). `enabled` is the only field; older
  // per-turn fields on a saved profile are ignored.
  retrieval?: { enabled?: boolean }
  // The automatic memory review (agent-runtime 8.3). `think` lets the model
  // reason before it answers: measured to help some models (Ornith 9B) and not
  // others (Qwen3-4B), so it is per profile. Absent reads as off.
  memoryReview?: { think?: boolean }
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
  // With HTTPS on, "reachable on the network" is carried by the bundled Caddy:
  // the listener is on loopback and other devices use httpsUrl (null until
  // HTTPS faces the LAN).
  viaHttps?: boolean
  httpsUrl?: string | null
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

// The desktop shell's auto-updater (shell/src/update.rs), as
// admin:get-update reports it and update:status events push it.
export type UpdateStatus = {
  state: 'idle' | 'checking' | 'downloading' | 'ready' | 'error'
  // The update's version, once one has been found.
  version: string | null
  error: string | null
  // When the last check finished (ms since epoch), whatever it found.
  checkedAt: number | null
}

export type UpdateState = UpdateStatus & {
  // False wherever this install does not update itself: a headless daemon
  // (a source checkout), a dev run, macOS. The UI hides the control, as it
  // does for start-at-login.
  supported: boolean
  // settings.json's autoUpdate. Governs the automatic checks only; "Check
  // now" runs either way.
  enabled: boolean
  currentVersion: string
}

// networkMode defaults to true because the main use case is serving other
// devices on the home network. A toggle exists to switch to localhost-only
// (useful if the user only wants to use the chat from the same PC).
export const DEFAULT_CONFIG: LlamaConfig = {
  modelPath: '', ctxSize: 4096, batchSize: 256, threads: 4,
  gpuLayers: undefined, port: 19080, host: '0.0.0.0', networkMode: true,
  nCpuMoe: undefined, kvCache: 'balanced', additionalArgs: '',
}

/**
 * Does this profile want tool retrieval (the catalog)? On by default since
 * 2026-11-18: absent reads as on, and only an explicit `false` turns it off.
 * The daemon's rule is the same (daemon/tool-filter.mjs retrievalOnFor).
 */
export function retrievalOnFor(tools?: ProfileTools): boolean {
  return tools?.retrieval?.enabled !== false
}

// HTTPS on the LAN (TLS plan C8/C9; daemon/lan.mjs lanStatus()). The token is
// never part of this: only whether one is stored.
export type TlsProvider = 'duckdns' | 'desec'
export type TlsMode = 'off' | 'own' | 'redstart'
export type TlsSettingsView = {
  mode: TlsMode
  provider: TlsProvider
  name: string
  hasToken: boolean
  requireHttps: boolean
  acmeStaging: boolean
  // Automatic: the name, once registered (it registers when HTTPS first starts).
  automatic: { hostname: string } | null
  // The one-time consent screen has been answered.
  consentAsked: boolean
}
export type TlsLanState = 'local' | 'lan-http' | 'lan-https' | 'lan-https-fallback' | 'stopping'
export type TlsStatus = {
  settings: TlsSettingsView | null
  state: TlsLanState
  lastError: string | null
  caddy: { state: 'stopped' | 'starting' | 'running' | 'failed'; reason: string | null; lastAcmeError: string | null; lastCertificateAt: number | null } | null
  serving: boolean
  health: { serving: boolean; reason: string | null; cert: { validTo: string; daysLeft: number; issuer: string; staging: boolean } | null } | null
  warnings: { kind: string; text: string }[]
  address: { ip: string; ok: boolean; detail: string; at: number } | null
  switching: { name: string; deadline: number } | null
  lastSwitchFailure: string | null
  egress: { host: string; purpose: string }[]
}
export type TlsPatch = Partial<{ mode: TlsMode; provider: TlsProvider; name: string; token: string; requireHttps: boolean; acmeStaging: boolean; consentAsked: true }>

// ---------------------------------------------------------------------------
// Image generation (ipc/image-generation.mjs)
// ---------------------------------------------------------------------------

export type ImageModelEntry = {
  file: string
  repoId: string
  revision: string
  rfilename: string
  family: string
  familyLabel: string
  bytes: number
  ready: boolean
  missingCompanions: string[]
}

export type ImageFamily = {
  id: string
  label: string
  note: string
  defaults: { steps: number; cfgScale: number; sampler: string; width: number; height: number }
  companionBytes: number
}

export type ImageGenerationStatus = {
  enabled: boolean
  model: string | null
  backend: 'auto' | 'cuda' | 'vulkan' | 'metal'
  timeoutS: number
  models: ImageModelEntry[]
  families: ImageFamily[]
  engine: {
    release: string
    nvidia: boolean
    buildKey: string | null
    label: string | null
    installed: boolean
    downloadBytes: number
    installing: boolean
    available: string[]
  }
  downloading: { repoId: string; rfilename: string } | null
  publishers: { id: string; label: string; note: string }[]
  busy: { reason: string; since: number; paused: boolean } | null
}

export type ImageCatalogModel = { repoId: string; author: string; downloads: number; likes: number; lastModified: string | null; gated: boolean; weightFileCount: number; quants: string[] }

export type ImageRepoDetail = {
  ok: boolean
  error?: string
  repoId: string
  revision: string | null
  gated: boolean
  downloads: number
  likes: number
  license: string | null
  baseModels: string[]
  family: string | null
  description: ModelDescription | null
  files: { rfilename: string; size: number | null; sha256: string | null; quantLabel: string; quantRecognized: boolean }[]
}

export type ImageProgress = { phase: string; step?: number; steps?: number; image?: number; count?: number }
export type ImageTransferProgress = { state: string; receivedBytes?: number; totalBytes?: number; file?: string; error?: string | null }
