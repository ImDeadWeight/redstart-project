// Capabilities IPC namespace — global config + folder selection for the
// built-in capability providers (Postgres, Documents, SQLite, Scholar, and the
// folder-scoped Vault/Git/File System trio).
//
// Global config, per-profile activation via tools.activeToolIds (see
// buildGatewayConfig). Secrets never round-trip to the renderer in plaintext.
// NOTE: every setter below still accepts an `enabled` boolean and still stores
// it, but nothing gates on it any more — the UI's Enable/Disable writes to the
// profile's activeToolIds instead. The parameter is kept because stored
// tools.json files and test fixtures still carry it. Do not remove it.
// refreshLiveToolsConfig lives in index.mjs and is threaded via deps.
//
// Handler bodies are exported as plain functions so an HTTP route can call them
// directly without dragging IPC registration in — importing this module never
// registers anything; only registerCapabilitiesHandlers() does that. The
// folder-scoped trio's (vault/git/file_system) computed-channel-name
// registration loop is unchanged for the setters — scripts/test-ipc-contract.mjs
// specifically exercises that shape. The matching selectXFolder() dialogs
// are retired, replaced by a native picker that itself retired — FolderPicker.tsx
// now only ever uses admin/browse-routes.mjs.
import { getCapabilities, setCapabilityConfig } from '../tools-storage.mjs'
import { encryptSecret, decryptSecret } from '../secrets.mjs'
import { testConnection as testPostgresConnection } from '../postgres-tool.mjs'
import { isPlainObject, isAbsolutePath, optional } from './validate.mjs'
import { isHttpUrl } from '../web-search-engines.mjs'
import { logEvent } from '../logger.mjs'
import { configDir } from '../platform-paths.mjs'
import {
  runtimeDir, verifyRuntime, installRuntime, resolvePythonNode,
  PYODIDE_VERSION, PYTHON_VERSION, TOP_LEVEL_PACKAGES, APPROX_DOWNLOAD_BYTES, APPROX_KERNEL_RSS_BYTES,
} from '../python-runtime.mjs'

// Every setter below takes one config object and destructures it directly.
// Destructuring a non-object throws a bare TypeError out through the IPC
// channel; this says what actually happened and leaves the stored config
// untouched. A capability root is a containment boundary for a model-facing
// tool, so a relative one — which would resolve against whatever cwd the main
// process happens to have — is refused rather than normalized.
function checkConfig(channel, config, rootField) {
  if (!isPlainObject(config)) return `${channel} expects a config object.`
  if (rootField && !optional(config[rootField], isAbsolutePath)) {
    return `${rootField} must be an absolute path.`
  }
  return null
}

function refuse(channel, reason) {
  logEvent('security', 'ipc_argument_rejected', { channel, reason })
  return { ok: false, error: reason }
}

export function getCapabilitiesConfig() {
  const caps = getCapabilities()
  return {
    postgres: {
      enabled: caps.postgres.enabled,
      hasConnectionString: !!caps.postgres.connectionStringEnc,
      maxRows: caps.postgres.maxRows,
    },
    documents: {
      enabled: caps.documents.enabled,
      outputDir: caps.documents.outputDir,
    },
    sqlite: {
      enabled: caps.sqlite.enabled,
      rootDir: caps.sqlite.rootDir,
      maxRows: caps.sqlite.maxRows,
    },
    vault: {
      enabled: caps.vault.enabled,
      rootDir: caps.vault.rootDir,
    },
    git: {
      enabled: caps.git.enabled,
      rootDir: caps.git.rootDir,
    },
    file_system: {
      enabled: caps.file_system.enabled,
      rootDir: caps.file_system.rootDir,
      // Permission policy — writes on by default, deletes off (see
      // DEFAULT_CAPABILITIES). Surfaced so the UI can show/toggle them.
      allowWrite: caps.file_system.allowWrite !== false,
      allowDestructive: caps.file_system.allowDestructive === true,
    },
    scholar: {
      enabled: caps.scholar.enabled,
      venueFilter: caps.scholar.venueFilter,
    },
    // Where each general web search engine lives. Which one a profile uses is
    // the profile's tools.webSearchEngine. The Brave key is reported as
    // present/absent only, like Postgres's connection string.
    web_search: {
      searxngUrl: caps.web_search.searxngUrl,
      hasBraveApiKey: !!caps.web_search.braveApiKeyEnc,
    },
    python: pythonStatus(caps.python),
  }
}

// What the Tools tab needs to say about run_python: whether it CAN run here
// (the Node check is the sandbox's network denial, see python-runtime.mjs),
// whether the runtime is installed, and what a kernel costs.
function pythonStatus(cfg) {
  const node = resolvePythonNode()
  const runtime = verifyRuntime(runtimeDir(configDir()))
  return {
    maxKernels: cfg.maxKernels,
    timeoutS: cfg.timeoutS,
    workspaceCapMb: cfg.workspaceCapMb,
    accountCapMb: cfg.accountCapMb,
    pyodideVersion: PYODIDE_VERSION,
    pythonVersion: PYTHON_VERSION,
    packages: TOP_LEVEL_PACKAGES,
    runtimeInstalled: runtime.ok,
    runtimeProblem: runtime.ok || runtime.reason === 'not installed' ? null : runtime.reason,
    installing: pythonInstall !== null,
    approxDownloadBytes: APPROX_DOWNLOAD_BYTES,
    approxKernelBytes: APPROX_KERNEL_RSS_BYTES,
    sandboxAvailable: node.ok,
    sandboxProblem: node.ok ? null : node.reason,
    sandboxNode: node.ok ? node.version : null,
  }
}

// Settings for run_python. Bounds are the plan's: timeout ≤ 120 s, and a
// kernel cap small enough that ≈457 MB each stays sane.
export function setPythonConfig(config, { refreshLiveToolsConfig }) {
  const channel = 'capabilities:set-python'
  const bad = checkConfig(channel, config)
  if (bad) return refuse(channel, bad)
  const patch = {}
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi
  const { maxKernels, timeoutS, workspaceCapMb, accountCapMb } = config
  if (maxKernels !== undefined) { if (!int(maxKernels, 1, 8)) return refuse(channel, 'maxKernels must be an integer from 1 to 8.'); patch.maxKernels = maxKernels }
  if (timeoutS !== undefined) { if (!int(timeoutS, 1, 120)) return refuse(channel, 'timeoutS must be an integer from 1 to 120.'); patch.timeoutS = timeoutS }
  if (workspaceCapMb !== undefined) { if (!int(workspaceCapMb, 1, 100000)) return refuse(channel, 'workspaceCapMb must be a positive integer.'); patch.workspaceCapMb = workspaceCapMb }
  if (accountCapMb !== undefined) { if (!int(accountCapMb, 1, 1000000)) return refuse(channel, 'accountCapMb must be a positive integer.'); patch.accountCapMb = accountCapMb }
  setCapabilityConfig('python', patch)
  refreshLiveToolsConfig()
  return { ok: true }
}

// One install at a time. A second click while one runs joins it.
let pythonInstall = null

export async function installPythonRuntime({ refreshLiveToolsConfig }) {
  if (!resolvePythonNode().ok) return { ok: false, error: resolvePythonNode().reason }
  if (!pythonInstall) {
    pythonInstall = installRuntime(runtimeDir(configDir()))
      .then(() => ({ ok: true }), (err) => ({ ok: false, error: err.message }))
      .finally(() => { pythonInstall = null })
  }
  const result = await pythonInstall
  if (result.ok) refreshLiveToolsConfig()
  return result
}

export function setPostgresConfig(config, { refreshLiveToolsConfig }) {
  const bad = checkConfig('capabilities:set-postgres', config)
  if (bad) return refuse('capabilities:set-postgres', bad)
  const { connectionString, maxRows, enabled } = config
  const patch = {}
  if (typeof enabled === 'boolean') patch.enabled = enabled
  if (typeof maxRows === 'number') patch.maxRows = maxRows
  if (connectionString) {
    try {
      patch.connectionStringEnc = encryptSecret(connectionString)
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }
  setCapabilityConfig('postgres', patch)
  refreshLiveToolsConfig()
  return { ok: true }
}

export async function testPostgresConfig(connectionString) {
  let target = connectionString
  if (!target) {
    const caps = getCapabilities()
    if (!caps.postgres.connectionStringEnc) return { ok: false, message: 'No connection string configured' }
    try {
      target = decryptSecret(caps.postgres.connectionStringEnc)
    } catch (err) {
      return { ok: false, message: err.message }
    }
  }
  return await testPostgresConnection(target)
}

// selectDocumentsFolder() / selectSqliteFolder() / selectFolderScopedFolder()
// are retired, and the native picker they were replaced by itself retired.
// FolderPicker.tsx calls admin/browse-routes.mjs's browse:list instead of a
// dedicated dialog per capability.

export function setDocumentsFolder(config, { refreshLiveToolsConfig }) {
  const bad = checkConfig('capabilities:set-documents-folder', config, 'outputDir')
  if (bad) return refuse('capabilities:set-documents-folder', bad)
  const { outputDir, enabled } = config
  const patch = {}
  if (typeof enabled === 'boolean') patch.enabled = enabled
  if (outputDir) patch.outputDir = outputDir
  setCapabilityConfig('documents', patch)
  refreshLiveToolsConfig()
  return { ok: true }
}

export function setSqliteConfig(config, { refreshLiveToolsConfig }) {
  const bad = checkConfig('capabilities:set-sqlite', config, 'rootDir')
  if (bad) return refuse('capabilities:set-sqlite', bad)
  const { rootDir, maxRows, enabled } = config
  const patch = {}
  if (typeof enabled === 'boolean') patch.enabled = enabled
  if (typeof maxRows === 'number') patch.maxRows = maxRows
  if (rootDir) patch.rootDir = rootDir
  setCapabilityConfig('sqlite', patch)
  refreshLiveToolsConfig()
  return { ok: true }
}

export function setScholarConfig(config, { refreshLiveToolsConfig }) {
  const bad = checkConfig('capabilities:set-scholar', config)
  if (bad) return refuse('capabilities:set-scholar', bad)
  const { venueFilter, enabled } = config
  const patch = {}
  if (typeof enabled === 'boolean') patch.enabled = enabled
  if (venueFilter !== undefined) patch.venueFilter = String(venueFilter || '').trim() || null
  setCapabilityConfig('scholar', patch)
  refreshLiveToolsConfig()
  return { ok: true }
}

// The general web search engines' connection (chat-tooling Phase 4b).
//   searxngUrl    an http(s) base URL, or '' / null to clear
//   braveApiKey   a new key (encrypted before it is stored); absent = keep
//   clearBraveApiKey  true removes the stored key
// The SearXNG URL is refused unless it's http(s): it's the one URL in this
// feature that an admin types, and it gets no SSRF guard (it may well be on
// the LAN), so at least its scheme is pinned.
export function setWebSearchConfig(config, { refreshLiveToolsConfig }) {
  const channel = 'capabilities:set-web-search'
  const bad = checkConfig(channel, config)
  if (bad) return refuse(channel, bad)
  const { searxngUrl, braveApiKey, clearBraveApiKey } = config
  const patch = {}
  if (searxngUrl !== undefined) {
    const trimmed = String(searxngUrl ?? '').trim()
    if (trimmed && !isHttpUrl(trimmed)) return refuse(channel, 'searxngUrl must be an http(s) URL.')
    patch.searxngUrl = trimmed || null
  }
  if (clearBraveApiKey === true) {
    patch.braveApiKeyEnc = null
  } else if (typeof braveApiKey === 'string' && braveApiKey.trim()) {
    try {
      patch.braveApiKeyEnc = encryptSecret(braveApiKey.trim())
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }
  setCapabilityConfig('web_search', patch)
  refreshLiveToolsConfig()
  return { ok: true }
}

// Vault, Git, and File System share the folder-scoped capability shape: pick a
// folder, toggle enabled. The channel slug is hyphenated (file_system ->
// file-system) to match the preload; the storage key stays the underscore
// form. The shared picker (selectFolderScopedFolder) retired with the rest —
// see the note above setDocumentsFolder().
export function setFolderScopedCapability(cap, config, { refreshLiveToolsConfig }) {
  const slug = cap.replace(/_/g, '-')
  const channel = `capabilities:set-${slug}`
  const bad = checkConfig(channel, config, 'rootDir')
  if (bad) return refuse(channel, bad)
  const { rootDir, enabled, allowWrite, allowDestructive } = config
  const patch = {}
  if (typeof enabled === 'boolean') patch.enabled = enabled
  if (rootDir) patch.rootDir = rootDir
  // File System carries a write/destructive permission policy; vault/git do
  // not, so only thread these through for that capability.
  if (cap === 'file_system') {
    if (typeof allowWrite === 'boolean') patch.allowWrite = allowWrite
    if (typeof allowDestructive === 'boolean') patch.allowDestructive = allowDestructive
  }
  setCapabilityConfig(cap, patch)     // storage key stays 'file_system'
  refreshLiveToolsConfig()
  return { ok: true }
}

export function capabilitiesHandlers(deps) {
  const handlers = {
    'capabilities:get': () => getCapabilitiesConfig(),
    'capabilities:set-postgres': (config) => setPostgresConfig(config, deps),
    'capabilities:test-postgres': async (connectionString) => testPostgresConfig(connectionString),
    'capabilities:set-documents-folder': (config) => setDocumentsFolder(config, deps),
    'capabilities:set-sqlite': (config) => setSqliteConfig(config, deps),
    'capabilities:set-scholar': (config) => setScholarConfig(config, deps),
    'capabilities:set-web-search': (config) => setWebSearchConfig(config, deps),
    'capabilities:set-python': (config) => setPythonConfig(config, deps),
    'capabilities:install-python': async () => installPythonRuntime(deps),
  }

  // Built in a loop, and that is exactly why the contract tests scan the real
  // table rather than the source: a computed channel name is invisible to a grep
  // and this trio has broken that way once already.
  for (const cap of ['vault', 'git', 'file_system']) {
    const slug = cap.replace(/_/g, '-')   // file_system -> file-system; vault/git unchanged
    handlers[`capabilities:set-${slug}`] = (config) => setFolderScopedCapability(cap, config, deps)
  }

  return handlers
}
