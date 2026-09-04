'use strict'

// =============================================================================
// Redstart Nest — Secrets provider: daemon-owned key file
// =============================================================================
// AES-256-GCM under a 32-byte key held in a file beside Nest's other state.
// This is the headless daemon's provider — there is no keychain on an
// appliance, no DBus session, and no console to type an unlock passphrase into
// at boot.
//
// BE CLEAR ABOUT WHAT THIS IS. On its own it is honest and weak: the key sits
// in the same directory as the ciphertext, so anyone who can read that
// directory can read the secrets, and a key file there buys exactly nothing
// against them. That is deliberate and settled, not an oversight — Nest must
// NOT try to resist physical access, because possession of the box already
// confers ownership (the bootstrap token is on a label on the chassis).
// Defending here would cost real complexity to resist a threat the product
// has deliberately conceded.
//
// What makes it meaningful is underneath it: TPM-backed full-disk encryption
// (LUKS+TPM2, or BitLocker+TPM on a Windows level-3 variant), which is what
// protects a drive that leaves the box — a theft, a backup, decommissioned
// hardware. Do not build key management in here to compensate; the answer to
// "this feels weak" is FDE on the host, not application crypto with the key on
// the same disk.
//
// File permissions: 0600 at creation. On Windows that is approximated rather
// than enforced by the mode bits — the real control at level 3 is the data
// directory ACL'd to the service account.
// =============================================================================

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

export const KEYFILE_TAG = 'keyfile'
export const KEY_FILE_NAME = 'secret.key'
export const KEY_BYTES = 32

const IV_BYTES = 12
const AUTH_TAG_BYTES = 16

/**
 * @param {string} dir  Nest's config directory (platform-paths.mjs configDir()).
 */
export function keyfileProvider(dir) {
  if (!dir) throw new Error('keyfileProvider() needs a directory to hold the key file')
  const keyPath = path.join(dir, KEY_FILE_NAME)

  // Cached after the first read: this is on the path of every gateway config
  // build, and re-reading the file per secret buys nothing.
  let key = null

  function readKey() {
    if (key) return key
    let buf
    try {
      buf = fs.readFileSync(keyPath)
    } catch (err) {
      if (err.code === 'ENOENT') return null
      throw err
    }
    if (buf.length !== KEY_BYTES) {
      // Refuse rather than pad or truncate. A wrong-length key file means
      // something else wrote it, and quietly deriving a key from it would
      // produce ciphertext nothing can ever read back.
      throw new Error(`${keyPath} is not a ${KEY_BYTES}-byte key (found ${buf.length} bytes)`)
    }
    key = buf
    return key
  }

  function createKey() {
    fs.mkdirSync(dir, { recursive: true })
    const fresh = crypto.randomBytes(KEY_BYTES)
    let fd
    try {
      // 'wx', never 'w': clobbering an existing key file destroys every secret
      // already written under it, irreversibly. If another process won the race
      // we re-read theirs instead.
      fd = fs.openSync(keyPath, 'wx', 0o600)
    } catch (err) {
      if (err.code === 'EEXIST') {
        const existing = readKey()
        if (existing) return existing
      }
      throw err
    }
    try {
      fs.writeSync(fd, fresh)
    } finally {
      fs.closeSync(fd)
    }
    key = fresh
    return key
  }

  return {
    tag: KEYFILE_TAG,

    encrypt(plaintext) {
      const k = readKey() ?? createKey()
      const iv = crypto.randomBytes(IV_BYTES)
      const cipher = crypto.createCipheriv('aes-256-gcm', k, iv)
      const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
      // iv || authTag || ciphertext — all fixed-width but the last, so parsing
      // is two slices and needs no length header.
      return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')
    },

    decrypt(payload) {
      // Deliberately does NOT create a key: minting a fresh one here would
      // turn "the key file is missing" into "authentication failed", which
      // reads as corrupt data rather than as the recoverable-by-restore
      // problem it actually is.
      const k = readKey()
      if (!k) {
        throw new Error(`Cannot decrypt: no key file at ${keyPath}`)
      }
      const buf = Buffer.from(payload, 'base64')
      if (buf.length <= IV_BYTES + AUTH_TAG_BYTES) {
        throw new Error('Cannot decrypt: secret is too short to be valid ciphertext')
      }
      const iv = buf.subarray(0, IV_BYTES)
      const authTag = buf.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES)
      const ct = buf.subarray(IV_BYTES + AUTH_TAG_BYTES)
      const decipher = crypto.createDecipheriv('aes-256-gcm', k, iv)
      decipher.setAuthTag(authTag)
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
    },
  }
}
