// Test-only stub for the 'electron' module.
//
// Lets the real auth code (accounts-storage.mjs, which calls
// app.getPath('userData')) run under plain Node so scripts/test-auth.mjs can
// spin up the *actual* tools-gateway.mjs / mcp-server.mjs HTTP servers and
// hit them over real sockets, without needing a full Electron GUI process.
// Only 'electron' is intercepted (see auth-test-loader.mjs) — every other
// import is the real, unmodified production module.

export const app = {
  // llama-args.mjs reads app.isPackaged to pick the chat-ui static path; tests
  // run the unpackaged (dev) branch.
  isPackaged: false,
  getPath(name) {
    if (name === 'userData') {
      const dir = process.env.REDSTART_TEST_USERDATA_DIR
      if (!dir) throw new Error('REDSTART_TEST_USERDATA_DIR not set')
      return dir
    }
    return process.cwd()
  },
}

// secrets.mjs imports safeStorage at module load (transitively, via
// gateway-config.mjs -> secrets.mjs). A functional round-trip stub — no real OS
// encryption, just a reversible encoding — so any encrypt/decrypt path a test
// happens to hit still works, not merely the import.
export const safeStorage = {
  isEncryptionAvailable() {
    return true
  },
  encryptString(plaintext) {
    return Buffer.from(String(plaintext), 'utf8')
  },
  decryptString(buffer) {
    return Buffer.from(buffer).toString('utf8')
  },
}

// Recording ipcMain — lets scripts/test-ipc-contract.mjs run the REAL
// registerXHandlers() functions and observe every channel they actually
// register, including the ones built dynamically in a loop (which a static
// grep of the source cannot see). Handlers are kept callable so a test can
// invoke one directly.
export const ipcMain = {
  handlers: new Map(),
  listeners: new Map(),
  handle(channel, fn) {
    if (this.handlers.has(channel)) {
      throw new Error(`ipcMain.handle called twice for the same channel: ${channel}`)
    }
    this.handlers.set(channel, fn)
  },
  on(channel, fn) {
    if (!this.listeners.has(channel)) this.listeners.set(channel, [])
    this.listeners.get(channel).push(fn)
  },
  removeHandler(channel) {
    this.handlers.delete(channel)
  },
}

// Registration-time only — no handler under test opens a dialog or a window
// unless invoked, and the contract test never invokes those.
export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
  showMessageBox: async () => ({ response: 0 }),
}

export const BrowserWindow = {
  getAllWindows: () => [],
  getFocusedWindow: () => null,
}

export const shell = {
  openExternal: async () => {},
  openPath: async () => '',
}

export const nativeImage = {
  createFromPath: () => ({ isEmpty: () => true }),
}

export const session = {
  defaultSession: { webRequest: { onHeadersReceived() {} } },
}
