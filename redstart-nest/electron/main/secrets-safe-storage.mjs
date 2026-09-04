'use strict'

// =============================================================================
// Redstart Nest — Secrets provider: Electron safeStorage
// =============================================================================
// OS-level encryption: DPAPI on Windows, Keychain on macOS, libsecret/kwallet
// on Linux. This is what every secret written before the headless split used,
// and it stays the desktop (level 2) provider — the daemon runs as the
// logged-in user there, so DPAPI works exactly as it always has and the
// re-key problem never arises.
//
// `safeStorage` is passed IN rather than imported. Two reasons, both practical:
// the entrypoint is the only thing that should decide which provider is wired,
// and importing 'electron' here would put this module
// inside an import cycle with the test stub that substitutes for it. The
// consequence is that this file — the provider itself — is plain testable
// JavaScript with no Electron dependency of its own.
//
// The tag is named for the PROVIDER, not the OS mechanism: safeStorage is DPAPI
// only on Windows, and a value written on macOS is no more readable by the
// keyfile provider than a Windows one is. Deliberately not `v1.dpapi.`, which
// would have named the mechanism instead.
// =============================================================================

export const SAFE_STORAGE_TAG = 'safestorage'

/**
 * @param {{ isEncryptionAvailable(): boolean,
 *           encryptString(s: string): Buffer,
 *           decryptString(b: Buffer): string }} safeStorage
 */
export function safeStorageProvider(safeStorage) {
  if (!safeStorage) throw new Error('safeStorageProvider() needs Electron safeStorage')

  // Checked on every call, not once at construction: availability is a runtime
  // property of the OS session (a locked-down machine, a missing keyring
  // daemon), and the original module checked it per call for that reason.
  function requireAvailable() {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-level secret encryption is unavailable on this machine')
    }
  }

  return {
    tag: SAFE_STORAGE_TAG,
    encrypt(plaintext) {
      requireAvailable()
      return safeStorage.encryptString(plaintext).toString('base64')
    },
    decrypt(payload) {
      requireAvailable()
      return safeStorage.decryptString(Buffer.from(payload, 'base64'))
    },
  }
}
