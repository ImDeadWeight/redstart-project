// Settings IPC namespace — server binary path and models folder.
//
// readSettings/writeSettings/resolveBinary still live in index.mjs and are
// threaded in via deps; selectBinaryDefaultPath is precomputed there so the
// picker's default folder is unaffected by this module's own __dirname.
//
// The models folder is a launcher-level path like serverBinPath — it belongs in
// settings.json, NOT in tools.json's capabilities block, because it is not a
// model-facing capability root and nothing in the MCP layer reads it.
import { ipcMain, dialog } from 'electron'

export function registerSettingsHandlers({
  readSettings, writeSettings, resolveBinary, selectBinaryDefaultPath, resolveModelsDir,
}) {
  // --- Settings ---

  ipcMain.handle('settings:get-binary-path', () => {
    const s = readSettings()
    return s.serverBinPath || null
  })

  ipcMain.handle('settings:set-binary-path', (_, p) => {
    const s = readSettings()
    if (p) s.serverBinPath = p
    else delete s.serverBinPath
    writeSettings(s)
    return true
  })

  ipcMain.handle('settings:select-binary', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select llama-server.exe',
      properties: ['openFile'],
      filters: [{ name: 'Executable', extensions: ['exe'] }, { name: 'All Files', extensions: ['*'] }],
      defaultPath: selectBinaryDefaultPath,
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('settings:get-resolved-binary', () => resolveBinary())

  // --- Models folder ---
  //
  // Always returns a usable path: the user's choice if set, otherwise the
  // provisioned <Documents>\Redstart\Models default. Callers never have to
  // handle null, which is what keeps the picker's defaultPath and the
  // downloader's root from diverging.

  ipcMain.handle('settings:get-models-dir', () => resolveModelsDir())

  ipcMain.handle('settings:set-models-dir', (_, p) => {
    const s = readSettings()
    if (p) s.modelsDir = p
    else delete s.modelsDir // fall back to the provisioned default
    writeSettings(s)
    return resolveModelsDir()
  })

  ipcMain.handle('settings:select-models-dir', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select the folder to store models in',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: resolveModelsDir(),
    })
    return result.canceled ? null : result.filePaths[0]
  })
}
