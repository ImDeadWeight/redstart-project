// Test-only stub for the 'electron' module.
//
// Lets the real auth code (accounts-storage.mjs, which used to call
// app.getPath('userData') directly) run under plain Node so scripts/test-auth.mjs
// can spin up the *actual* tools-gateway.mjs / mcp-server.mjs HTTP servers and
// hit them over real sockets, without needing a full Electron GUI process.
// Only 'electron' is intercepted (see auth-test-loader.mjs) — every other
// import is the real, unmodified production module.

import { initPaths } from '../electron/main/platform-paths.mjs'
import { initSecrets } from '../electron/main/secrets.mjs'
import { setLoginItems } from '../electron/main/desktop-integration.mjs'
import { safeStorageProvider } from '../electron/main/secrets-safe-storage.mjs'
import * as path from 'node:path'

// Phase 7 §7.4's login-item state — a plain in-memory stand-in for what
// Windows itself would track. Starts false, same as a real fresh Windows
// install where nothing has ever registered a login item.
let loginItemSettings = { openAtLogin: false, args: [] }

export const app = {
  // Nothing in production reads this any more (Phase 8A.5 moved llama-args.mjs
  // onto platform-paths' isPackaged()); kept because index.mjs, which no suite
  // loads, still branches on it and a stub that lies about its shape is worse
  // than one carrying a field nobody reads.
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
// so this mirrors that ordering rather than adding a new one. A suite that
// loads this stub without ever touching storage and never sets the var gets
// initPaths() left deliberately uncalled, matching the getPath('userData')
// lazy-throw above rather than failing eagerly for a path nothing in it needs.
// (test-llama-args.mjs used to be such a suite and no longer is: Phase 8A.5
// moved buildArgs() off app.isPackaged and onto the paths module's
// isPackaged(), so it now sets the var like everyone else.)
if (process.env.REDSTART_TEST_USERDATA_DIR) {
  const dir = process.env.REDSTART_TEST_USERDATA_DIR
  initPaths({
    config: dir,
    capabilityBase: path.join(dir, 'Redstart'),
    isPackaged: false,
  })
}

// A functional round-trip stub — no real OS encryption, just a reversible
// encoding — so any encrypt/decrypt path a test happens to hit still works.
//
// Phase 8A.1 moved secrets.mjs behind a provider seam, so this is no longer
// needed merely to satisfy an import: production code takes safeStorage as an
// argument now (secrets-safe-storage.mjs) and this stub stands in for the real
// Electron object at the one place an entrypoint passes it. It is still
// exported in case a suite wants it directly.
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

// Phase 8A.1 — secrets.mjs is fail-closed: an entrypoint must wire a provider
// before anything reads or writes a credential. index.mjs does this in main();
// for suites, this stub is the equivalent seam, so it does the same thing with
// the same provider factory the desktop entrypoint uses. Unconditional (unlike
// initPaths above), because the safeStorage provider needs no directory.
//
// The dedicated round-trip coverage is scripts/test-secrets.mjs, which drives
// the real key file provider against real crypto rather than this encoding.
initSecrets(safeStorageProvider(safeStorage))

// Phase 8A.5 — the login-item capability, wired the same way index.mjs wires
// it, so suites that exercise the §7.4 startup toggle keep observing this
// stub's in-memory login-item state through app.getLoginItemSettings().
//
// The RECYCLE BIN is deliberately NOT registered: plain node has no recycle
// bin, so leaving it absent is the honest stand-in and it exercises the
// fallback path (trash.mjs's .trash/ folder) that the boundary suites can
// actually observe. That was already true of the old stub, whose
// shell.trashItem returned false for the same reason.
setLoginItems({
  get: () => app.getLoginItemSettings(),
  set: (settings) => app.setLoginItemSettings(settings),
})

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
