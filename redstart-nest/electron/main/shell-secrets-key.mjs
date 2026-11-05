'use strict'

// =============================================================================
// Redstart Nest — the secrets key, as the desktop shell finds it (Windows)
// =============================================================================
// SHELL-SIDE ONLY. The daemon never calls DPAPI (settled decision Q2); the shell
// unwraps the OSCrypt key and hands it to nestd in hello (shell-mode.mjs). In
// T1 the shell is Electron and DPAPI is reached through PowerShell's
// ProtectedData. T2's Tauri shell calls CryptUnprotectData natively, against
// THE SAME FILE this writes.
//
// THE KEY IS PINNED IN A NEST-OWNED FILE, `secrets-key.json` in the config dir,
// in Local State's own shape: { os_crypt: { encrypted_key: base64("DPAPI"|blob) } }.
// Found while building T1 and measured on Electron 33:
//   - a fresh install has NO key in Local State while Electron runs. Chromium
//     writes Local State only at exit, so a shell reading it at first launch
//     would find nothing;
//   - Chromium may create an os_crypt key in Local State on its own (it
//     encrypts cookies with it), so on a new install Local State can later
//     hold a DIFFERENT key from the one Nest's secrets use.
// So Local State is consulted ONCE, to carry an existing install's key over, and
// never again:
//
//   secrets-key.json exists    → use it (every run after the first)
//   else Local State has a key → copy that wrapped key into secrets-key.json
//                                (existing install: same key, nothing re-keyed)
//   else                       → generate 32 bytes, DPAPI-wrap, write the file
//
// The wrapped key on disk is bound to this Windows account by DPAPI, as before:
// a config backup restored under another account cannot decrypt secrets. That
// was already true of Local State.
// =============================================================================

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { readWrappedKey, OSCRYPT_KEY_BYTES } from './secrets-dpapi.mjs'

export const SECRETS_KEY_FILE = 'secrets-key.json'
const LOCAL_STATE_FILE = 'Local State'
const DPAPI_MARKER = Buffer.from('DPAPI', 'latin1')

/**
 * DPAPI through PowerShell (T1 only; Tauri does it natively). CurrentUser
 * scope, no extra entropy: exactly what Chromium's OSCrypt uses, which is
 * what makes a copied Local State key interchangeable with one wrapped here.
 */
export const powershellDpapi = {
  unprotect(wrapped) { return runProtectedData('Unprotect', wrapped) },
  protect(raw) { return runProtectedData('Protect', raw) },
}

function runProtectedData(op, input) {
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$b = [Convert]::FromBase64String([Console]::In.ReadToEnd())',
    `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${op}($b, $null, 'CurrentUser'))`,
  ].join('; ')
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    input: Buffer.from(input).toString('base64'),
    windowsHide: true,
    timeout: 30_000,
  })
  return Buffer.from(out.toString().trim(), 'base64')
}

function writeKeyFile(file, wrapped, source) {
  const body = {
    os_crypt: { encrypted_key: Buffer.concat([DPAPI_MARKER, wrapped]).toString('base64') },
    source,
    createdAt: new Date().toISOString(),
    note: 'Redstart Nest secrets key, DPAPI-wrapped for this Windows account. Deleting this file makes every stored secret unreadable.',
  }
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/**
 * The unwrapped 32-byte OSCrypt key for the install whose config is `configDir`.
 *
 * @param {string} configDir
 * @param {{ protect(b: Buffer): Buffer, unprotect(b: Buffer): Buffer }} [dpapi]
 * @returns {{ key: Buffer, source: 'pinned' | 'local-state' | 'generated' }}
 */
export function resolveSecretsKey(configDir, dpapi = powershellDpapi) {
  const pinned = path.join(configDir, SECRETS_KEY_FILE)
  const unwrap = (wrapped) => {
    const key = dpapi.unprotect(wrapped)
    if (key.length !== OSCRYPT_KEY_BYTES) throw new Error(`The secrets key unwrapped to ${key.length} bytes, not ${OSCRYPT_KEY_BYTES}`)
    return key
  }

  if (fs.existsSync(pinned)) {
    return { key: unwrap(readWrappedKey(pinned)), source: 'pinned' }
  }

  fs.mkdirSync(configDir, { recursive: true })
  const localState = path.join(configDir, LOCAL_STATE_FILE)
  let carried = null
  if (fs.existsSync(localState)) {
    try { carried = readWrappedKey(localState) } catch { carried = null }
  }
  if (carried) {
    // Unwrap BEFORE pinning: a Local State key this account cannot open must
    // fail loudly here, not be pinned and fail on every later run.
    const key = unwrap(carried)
    writeKeyFile(pinned, carried, 'local-state')
    return { key, source: 'local-state' }
  }

  const key = crypto.randomBytes(OSCRYPT_KEY_BYTES)
  writeKeyFile(pinned, dpapi.protect(key), 'generated')
  return { key, source: 'generated' }
}
