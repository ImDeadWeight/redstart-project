'use strict'

// =============================================================================
// Redstart Nest — Secrets provider: OSCrypt-compatible, key handed in
// =============================================================================
// The desktop daemon's provider once it runs as nestd under plain Node
// (daemon split, docs/notes/daemon-split-tauri-plan.md D1).
//
// It writes and reads EXACTLY what Electron's safeStorage wrote on Windows, so
// no secret on any existing install is migrated, and a rollback to an Electron
// build still reads anything written here. That format is Chromium's OSCrypt:
//
//   blob = "v10" | nonce (12 bytes) | AES-256-GCM ciphertext | tag (16 bytes)
//   key  = 32 bytes, stored in <userData>\Local State as
//          os_crypt.encrypted_key = base64("DPAPI" | CryptProtectData(key))
//
// and the stored payload is base64(blob), as safeStorageProvider produced it.
// The tag stays 'safestorage' for the same reason: the values on disk are
// safeStorage values, whichever process wrote them.
//
// THE KEY IS HANDED IN. This module never calls DPAPI: the shell unwraps the
// key (settled decision Q2: PowerShell from the Electron shell in T1, native
// CryptUnprotectData in the Tauri shell) and passes it to nestd over the shell
// pipe. So this file is pure crypto, testable anywhere, including on CI
// runners that have no DPAPI at all.
//
// WINDOWS ONLY in what it is compatible with. On macOS safeStorage derives an
// AES-128-CBC key from a Keychain password instead; that's a different
// provider, not this one.
// =============================================================================

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import { SAFE_STORAGE_TAG } from './secrets-safe-storage.mjs'

const VERSION_PREFIX = Buffer.from('v10', 'latin1')
const NONCE_BYTES = 12
const TAG_BYTES = 16
export const OSCRYPT_KEY_BYTES = 32

// Local State's encrypted_key starts with these five bytes before the DPAPI blob.
const DPAPI_MARKER = Buffer.from('DPAPI', 'latin1')

/**
 * The DPAPI-wrapped key from a Chromium/Electron `Local State` file, with the
 * "DPAPI" marker stripped: exactly the bytes CryptUnprotectData takes. Used by
 * the shell, which does the unwrap. Throws with a reason an admin can act on.
 */
export function readWrappedKey(localStatePath) {
  let json
  try {
    json = JSON.parse(fs.readFileSync(localStatePath, 'utf8'))
  } catch (err) {
    throw new Error(`Cannot read the secrets key file ${localStatePath}: ${err.message}`)
  }
  const encoded = json?.os_crypt?.encrypted_key
  if (typeof encoded !== 'string' || !encoded) {
    throw new Error(`${localStatePath} has no os_crypt.encrypted_key`)
  }
  const raw = Buffer.from(encoded, 'base64')
  if (!raw.subarray(0, DPAPI_MARKER.length).equals(DPAPI_MARKER)) {
    throw new Error(`${localStatePath}: encrypted_key is not DPAPI-wrapped`)
  }
  return raw.subarray(DPAPI_MARKER.length)
}

/**
 * @param {Buffer} key  the 32-byte OSCrypt key, already unwrapped by the shell
 */
export function oscryptProvider(key) {
  if (!Buffer.isBuffer(key) || key.length !== OSCRYPT_KEY_BYTES) {
    throw new Error(`oscryptProvider() needs a ${OSCRYPT_KEY_BYTES}-byte key`)
  }
  // Our own copy, so a caller zeroing or reusing its buffer cannot change it.
  const k = Buffer.from(key)

  return {
    tag: SAFE_STORAGE_TAG,
    encrypt(plaintext) {
      const nonce = crypto.randomBytes(NONCE_BYTES)
      const cipher = crypto.createCipheriv('aes-256-gcm', k, nonce)
      const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
      return Buffer.concat([VERSION_PREFIX, nonce, body, cipher.getAuthTag()]).toString('base64')
    },
    decrypt(payload) {
      const blob = Buffer.from(String(payload), 'base64')
      if (!blob.subarray(0, VERSION_PREFIX.length).equals(VERSION_PREFIX)) {
        // Chromium before v80 stored raw DPAPI blobs with no prefix. No Electron
        // version Redstart ever shipped did; say so rather than guessing.
        throw new Error('This secret is not in the OSCrypt v10 format this provider reads')
      }
      if (blob.length < VERSION_PREFIX.length + NONCE_BYTES + TAG_BYTES) {
        throw new Error('This secret is truncated')
      }
      const nonce = blob.subarray(VERSION_PREFIX.length, VERSION_PREFIX.length + NONCE_BYTES)
      const tag = blob.subarray(blob.length - TAG_BYTES)
      const body = blob.subarray(VERSION_PREFIX.length + NONCE_BYTES, blob.length - TAG_BYTES)
      const decipher = crypto.createDecipheriv('aes-256-gcm', k, nonce)
      decipher.setAuthTag(tag)
      try {
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
      } catch {
        // GCM authentication failed: the wrong key (another Windows user, a
        // replaced Local State) or a modified value. Never return garbage.
        throw new Error('This secret could not be decrypted with this install\'s key')
      }
    },
  }
}

// =============================================================================
// macOS: Chromium's os_crypt_mac, which Electron's safeStorage is on a Mac
// =============================================================================
// The secret is a password in the login Keychain (Electron creates it on
// first use: 16 random bytes, base64). The Mac shell reads it from the
// Keychain and hands it over in hello (keyFormat 'oscrypt-mac'), as the
// Windows shell hands over the DPAPI-unwrapped key. The rest is fixed by
// Chromium (components/os_crypt/sync/os_crypt_mac.mm):
//   key  = PBKDF2-HMAC-SHA1(password, "saltysalt", 1003 iterations, 16 bytes)
//   blob = "v10" + AES-128-CBC(key, iv = 16 spaces, PKCS#7)(plaintext)
// No authentication tag: a wrong key shows up as bad padding, or as
// garbage that happens to unpad.

const MAC_SALT = Buffer.from('saltysalt', 'latin1')
const MAC_ITERATIONS = 1003
const MAC_KEY_BYTES = 16
const MAC_IV = Buffer.alloc(16, 0x20)

/** @param {Buffer} password  the Keychain password's bytes, as stored */
export function oscryptMacProvider(password) {
  if (!Buffer.isBuffer(password) || password.length === 0) {
    throw new Error('oscryptMacProvider() needs the Keychain password')
  }
  const k = crypto.pbkdf2Sync(password, MAC_SALT, MAC_ITERATIONS, MAC_KEY_BYTES, 'sha1')

  return {
    tag: SAFE_STORAGE_TAG,
    encrypt(plaintext) {
      const cipher = crypto.createCipheriv('aes-128-cbc', k, MAC_IV)
      const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
      return Buffer.concat([VERSION_PREFIX, body]).toString('base64')
    },
    decrypt(payload) {
      const blob = Buffer.from(String(payload), 'base64')
      if (!blob.subarray(0, VERSION_PREFIX.length).equals(VERSION_PREFIX)) {
        throw new Error('This secret is not in the OSCrypt v10 format this provider reads')
      }
      const body = blob.subarray(VERSION_PREFIX.length)
      if (body.length === 0 || body.length % 16 !== 0) throw new Error('This secret is truncated')
      const decipher = crypto.createDecipheriv('aes-128-cbc', k, MAC_IV)
      try {
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
      } catch {
        throw new Error('This secret could not be decrypted with this install\'s key')
      }
    },
  }
}

/**
 * The provider hello asks for. Windows shells (T1 Electron, T2 Tauri) send
 * no keyFormat: the 32-byte DPAPI-unwrapped key.
 *
 * @param {Buffer} key
 * @param {'oscrypt-win'|'oscrypt-mac'|undefined} keyFormat
 */
export function providerForHello(key, keyFormat) {
  if (keyFormat === undefined || keyFormat === null || keyFormat === 'oscrypt-win') return oscryptProvider(key)
  if (keyFormat === 'oscrypt-mac') return oscryptMacProvider(key)
  throw new Error(`Unknown secrets key format from the shell: ${keyFormat}`)
}
