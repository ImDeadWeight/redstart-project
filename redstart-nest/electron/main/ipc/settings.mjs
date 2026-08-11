// Settings IPC namespace — server binary path and models folder.
//
// readSettings/writeSettings/resolveBinary still live in index.mjs and are
// threaded in via deps; selectBinaryDefaultPath is precomputed there so the
// picker's default folder is unaffected by this module's own __dirname.
//
// The models folder is a launcher-level path like serverBinPath — it belongs in
// settings.json, NOT in tools.json's capabilities block, because it is not a
// model-facing capability root and nothing in the MCP layer reads it.
import { dialog } from 'electron'
import { handle } from './guard.mjs'
import { binaryPathRejection, isAbsolutePath } from './validate.mjs'
import { logEvent } from '../logger.mjs'

export function registerSettingsHandlers({
  readSettings, writeSettings, resolveBinary, selectBinaryDefaultPath, resolveModelsDir,
}) {
  // --- Settings ---

  handle('settings:get-binary-path', () => {
    const s = readSettings()
    return s.serverBinPath || null
  })

  // The single most consequential value in settings.json: resolveBinary()
  // returns it and ipc/server.mjs spawns it. A falsy argument still means
  // "clear it and fall back to the bundled binary" — that is the Reset button —
  // but anything else must look like a server binary that actually exists. The
  // only legitimate source is the picker below, which cannot produce a value
  // that fails these checks.
  handle('settings:set-binary-path', (_, p) => {
    const s = readSettings()
    if (p) {
      const rejection = binaryPathRejection(p)
      if (rejection) {
        logEvent('security', 'ipc_argument_rejected', { channel: 'settings:set-binary-path', reason: rejection })
        return false
      }
      s.serverBinPath = p
    } else {
      delete s.serverBinPath
    }
    writeSettings(s)
    return true
  })

  handle('settings:select-binary', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select llama-server.exe',
      properties: ['openFile'],
      filters: [{ name: 'Executable', extensions: ['exe'] }, { name: 'All Files', extensions: ['*'] }],
      defaultPath: selectBinaryDefaultPath,
    })
    return result.canceled ? null : result.filePaths[0]
  })

  handle('settings:get-resolved-binary', () => resolveBinary())

  // --- Models folder ---
  //
  // Always returns a usable path: the user's choice if set, otherwise the
  // provisioned <Documents>\Redstart\Models default. Callers never have to
  // handle null, which is what keeps the picker's defaultPath and the
  // downloader's root from diverging.

  handle('settings:get-models-dir', () => resolveModelsDir())

  // Same shape of check as the binary path, one condition lighter: the folder
  // is a containment root for downloads, so it must be an absolute path, but it
  // does not have to exist yet — ensureModelsDir() creates it. On a rejection we
  // return the folder that IS in effect rather than the one that was refused, so
  // the UI never shows a setting that did not take.
  handle('settings:set-models-dir', (_, p) => {
    const s = readSettings()
    if (p) {
      if (!isAbsolutePath(p)) {
        logEvent('security', 'ipc_argument_rejected', {
          channel: 'settings:set-models-dir', reason: 'not an absolute path',
        })
        return resolveModelsDir()
      }
      s.modelsDir = p
    } else {
      delete s.modelsDir // fall back to the provisioned default
    }
    writeSettings(s)
    return resolveModelsDir()
  })

  handle('settings:select-models-dir', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select the folder to store models in',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: resolveModelsDir(),
    })
    return result.canceled ? null : result.filePaths[0]
  })
}
