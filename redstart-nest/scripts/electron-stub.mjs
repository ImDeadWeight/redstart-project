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
