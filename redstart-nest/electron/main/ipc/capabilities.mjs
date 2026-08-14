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
import { dialog } from 'electron'
import { handle } from './guard.mjs'
import { getCapabilities, setCapabilityConfig } from '../tools-storage.mjs'
import { encryptSecret, decryptSecret } from '../secrets.mjs'
import { testConnection as testPostgresConnection } from '../postgres-tool.mjs'
import { isPlainObject, isAbsolutePath, optional } from './validate.mjs'
import { logEvent } from '../logger.mjs'

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

export function registerCapabilitiesHandlers({ refreshLiveToolsConfig }) {
  // --- Capabilities ---

  handle('capabilities:get', () => {
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
    }
  })

  handle('capabilities:set-postgres', (_, config) => {
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
  })

  handle('capabilities:test-postgres', async (_, connectionString) => {
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
  })

  handle('capabilities:select-documents-folder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  handle('capabilities:set-documents-folder', (_, config) => {
    const bad = checkConfig('capabilities:set-documents-folder', config, 'outputDir')
    if (bad) return refuse('capabilities:set-documents-folder', bad)
    const { outputDir, enabled } = config
    const patch = {}
    if (typeof enabled === 'boolean') patch.enabled = enabled
    if (outputDir) patch.outputDir = outputDir
    setCapabilityConfig('documents', patch)
    refreshLiveToolsConfig()
    return { ok: true }
  })

  handle('capabilities:select-sqlite-folder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  handle('capabilities:set-sqlite', (_, config) => {
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
  })

  handle('capabilities:set-scholar', (_, config) => {
    const bad = checkConfig('capabilities:set-scholar', config)
    if (bad) return refuse('capabilities:set-scholar', bad)
    const { venueFilter, enabled } = config
    const patch = {}
    if (typeof enabled === 'boolean') patch.enabled = enabled
    if (venueFilter !== undefined) patch.venueFilter = String(venueFilter || '').trim() || null
    setCapabilityConfig('scholar', patch)
    refreshLiveToolsConfig()
    return { ok: true }
  })

  // Vault, Git, and File System share the folder-scoped capability shape: pick a
  // folder, toggle enabled. One generic pair of handlers keeps them uniform. The
  // channel slug is hyphenated (file_system -> file-system) to match the preload;
  // the storage key stays the underscore form.
  for (const cap of ['vault', 'git', 'file_system']) {
    const slug = cap.replace(/_/g, '-')   // file_system -> file-system; vault/git unchanged
    handle(`capabilities:select-${slug}-folder`, async () => {
      const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
      return result.canceled ? null : result.filePaths[0]
    })
    handle(`capabilities:set-${slug}`, (_, config) => {
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
    })
  }
}
