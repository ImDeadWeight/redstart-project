// Settings IPC namespace — server binary path get/set/select/resolve.
//
// readSettings/writeSettings/resolveBinary still live in index.mjs and are
// threaded in via deps; selectBinaryDefaultPath is precomputed there so the
// picker's default folder is unaffected by this module's own __dirname.
import { ipcMain, dialog } from 'electron'

export function registerSettingsHandlers({ readSettings, writeSettings, resolveBinary, selectBinaryDefaultPath }) {
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
}
