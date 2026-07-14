'use strict'

// =============================================================================
// Redstart Nest — Secrets
// =============================================================================
// Wraps Electron's safeStorage (OS-level encryption — DPAPI on Windows) for
// the handful of values in tools.json that are actual credentials (currently:
// the Postgres connection string) rather than whitelist/config data. Ciphertext
// is stored as base64 in JSON; decryption only ever happens in the main process.
//
// If OS encryption is unavailable (safeStorage.isEncryptionAvailable() false —
// rare, but possible in some locked-down environments), we refuse to store the
// secret rather than silently falling back to plaintext.
// =============================================================================

import { safeStorage } from 'electron'

export function encryptSecret(plaintext) {
  if (!plaintext) return null
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-level secret encryption is unavailable on this machine')
  }
  return safeStorage.encryptString(plaintext).toString('base64')
}

export function decryptSecret(ciphertextBase64) {
  if (!ciphertextBase64) return null
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-level secret encryption is unavailable on this machine')
  }
  return safeStorage.decryptString(Buffer.from(ciphertextBase64, 'base64'))
}
