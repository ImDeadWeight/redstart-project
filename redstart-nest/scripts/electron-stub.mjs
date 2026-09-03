// Test-only stub for the 'electron' module.
//
// Lets the real auth code (accounts-storage.mjs, which used to call
// app.getPath('userData') directly) run under plain Node so scripts/test-auth.mjs
// can spin up the *actual* tools-gateway.mjs / mcp-server.mjs HTTP servers and
// hit them over real sockets, without needing a full Electron GUI process.
// Only 'electron' is intercepted (see auth-test-loader.mjs) — every other
// import is the real, unmodified production module.

import { initPaths } from '../electron/main/platform-paths.mjs'
import * as path from 'node:path'

// Phase 7 §7.4's login-item state — a plain in-memory stand-in for what
// Windows itself would track. Starts false, same as a real fresh Windows
// install where nothing has ever registered a login item.
let loginItemSettings = { openAtLogin: false, args: [] }

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
  getLoginItemSettings() {
    return { ...loginItemSettings }
  },
  setLoginItemSettings(settings) {
    loginItemSettings = { openAtLogin: !!settings?.openAtLogin, args: settings?.args ?? [] }
  },
}

// Production code no longer calls app.getPath directly — it goes through
// platform-paths.mjs's configDir()/capabilityBaseDir(), which need initPaths()
// to have run before anything reads them (fail-closed by design). Every
// suite that needs storage already sets
// REDSTART_TEST_USERDATA_DIR before its `register()` call resolves this stub,
// so this mirrors that ordering rather than adding a new one. A handful of
// suites (test-llama-args.mjs, test-web-fetch-ssrf.mjs) load this stub without
// ever touching storage and never set the var — for those, initPaths() is
// deliberately left uncalled here, matching the getPath('userData') lazy-throw
// above rather than failing eagerly for a path nothing in that suite needs.
if (process.env.REDSTART_TEST_USERDATA_DIR) {
  const dir = process.env.REDSTART_TEST_USERDATA_DIR
  initPaths({
    config: dir,
    capabilityBase: path.join(dir, 'Redstart'),
    isPackaged: false,
  })
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

// ipcMain / dialog / session retired from this stub in Phase 6 §6.2 —
// production code stopped importing them from 'electron' (IPC retired,
// dialog.showOpenDialog retired in §6.1) and the two suites that exercised
// them (test-ipc-contract.mjs, test-ipc-guard.mjs) retired with IPC itself.

export const BrowserWindow = {
  getAllWindows: () => [],
  getFocusedWindow: () => null,
}

export const shell = {
  openExternal: async () => {},
  openPath: async () => '',
  // No real recycle bin under plain node. Returning false (the "failed"
  // signal Electron <14 used) makes fs-delete-tool fall through to its
  // .trash/ folder fallback — which is the path the boundary suites can
  // actually observe, since a file in the OS bin is not inspectable from a
  // test. The recycle-bin tier itself is covered by manual smoke testing.
  trashItem: async () => false,
}

export const nativeImage = {
  createFromPath: () => ({ isEmpty: () => true }),
}
