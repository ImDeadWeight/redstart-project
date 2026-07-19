// Capabilities IPC namespace — global config + folder selection for the
// built-in capability providers (Postgres, Documents, SQLite, Scholar, and the
// folder-scoped Vault/Git/File System trio).
//
// Global config, per-profile activation via tools.activeToolIds (see
// buildGatewayConfig). Secrets never round-trip to the renderer in plaintext.
// refreshLiveToolsConfig lives in index.mjs and is threaded via deps.
import { ipcMain, dialog } from 'electron'
import { getCapabilities, setCapabilityConfig } from '../tools-storage.mjs'
import { encryptSecret, decryptSecret } from '../secrets.mjs'
import { testConnection as testPostgresConnection } from '../postgres-tool.mjs'

export function registerCapabilitiesHandlers({ refreshLiveToolsConfig }) {
  // --- Capabilities ---

  ipcMain.handle('capabilities:get', () => {
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
      },
      scholar: {
        enabled: caps.scholar.enabled,
        venueFilter: caps.scholar.venueFilter,
      },
    }
  })

  ipcMain.handle('capabilities:set-postgres', (_, { connectionString, maxRows, enabled }) => {
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

  ipcMain.handle('capabilities:test-postgres', async (_, connectionString) => {
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

  ipcMain.handle('capabilities:select-documents-folder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('capabilities:set-documents-folder', (_, { outputDir, enabled }) => {
    const patch = {}
    if (typeof enabled === 'boolean') patch.enabled = enabled
    if (outputDir) patch.outputDir = outputDir
    setCapabilityConfig('documents', patch)
    refreshLiveToolsConfig()
    return { ok: true }
  })

  ipcMain.handle('capabilities:select-sqlite-folder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('capabilities:set-sqlite', (_, { rootDir, maxRows, enabled }) => {
    const patch = {}
    if (typeof enabled === 'boolean') patch.enabled = enabled
    if (typeof maxRows === 'number') patch.maxRows = maxRows
    if (rootDir) patch.rootDir = rootDir
    setCapabilityConfig('sqlite', patch)
    refreshLiveToolsConfig()
    return { ok: true }
  })

  ipcMain.handle('capabilities:set-scholar', (_, { venueFilter, enabled }) => {
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
    ipcMain.handle(`capabilities:select-${slug}-folder`, async () => {
      const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
      return result.canceled ? null : result.filePaths[0]
    })
    ipcMain.handle(`capabilities:set-${slug}`, (_, { rootDir, enabled }) => {
      const patch = {}
      if (typeof enabled === 'boolean') patch.enabled = enabled
      if (rootDir) patch.rootDir = rootDir
      setCapabilityConfig(cap, patch)     // storage key stays 'file_system'
      refreshLiveToolsConfig()
      return { ok: true }
    })
  }
}
