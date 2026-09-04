'use strict'

// =============================================================================
// Redstart Nest — Secrets
// =============================================================================
// The handful of values in tools.json / mcp.json / plugins that are actual
// credentials (a Postgres connection string, an external MCP API key, a
// plugin's env values) rather than whitelist/config data. Ciphertext is stored
// as a string in JSON; decryption only ever happens daemon-side and plaintext
// is never returned to a client.
//
// This module no longer knows HOW anything is encrypted. It holds
// the seam and the storage format; a provider supplies the crypto:
//
//   electron/main/secrets-safe-storage.mjs   Electron safeStorage (DPAPI on
//                                            Windows). The desktop entrypoint.
//   electron/main/secrets-keyfile.mjs        AES-256-GCM under a daemon-owned
//                                            key file. The headless entrypoint.
//
// Why the seam exists: safeStorage is Electron-only, and the appliance gets
// a daemon-owned key instead. `secrets.mjs` was the single hardest blocker to
// running this code under plain Node — it sits on the daemon's critical path
// via gateway-config.mjs, so nothing boots without it.
//
// Fail-closed, exactly like platform-paths.mjs: reading before initSecrets()
// is a startup-order bug, not a condition to paper over with a default. And as
// before, if encryption is unavailable we refuse to store the secret rather
// than silently falling back to plaintext — that refusal now lives inside
// whichever provider is in use.
//
// -----------------------------------------------------------------------------
// The storage format, and why it changed
// -----------------------------------------------------------------------------
// Values used to be bare base64 with no record of what wrote them. New values
// are tagged:
//
//     v1.<provider tag>.<base64 payload>
//
// An untagged value is safeStorage-written legacy, because that is the only
// thing that has ever written a secret in this codebase. That inference is
// safe rather than a guess: '.' is not in the base64 alphabet, so a bare
// base64 blob can never begin with "v1." by accident.
//
// This exists for the DPAPI re-key. A Windows install converting
// to a service account must decrypt every secret while still running as the
// original user, and a tag turns "find every blob the old provider wrote" into
// a query instead of a hand-audit of every config file's schema looking for
// fields whose names happen to end in `Enc`. One string operation now; the
// alternative later is the step most able to lose user data
// silently.
// =============================================================================

const FORMAT_PREFIX = 'v1.'

// The tag untagged (pre-Phase-8) ciphertext is attributed to. Kept here rather
// than imported from the provider so that reading a legacy value does not
// depend on the safeStorage module being loadable at all — which, on the
// headless daemon, it is not.
export const LEGACY_TAG = 'safestorage'

let provider = null

/**
 * Wire the crypto. Called once by an entrypoint, before anything reads or
 * writes a secret — index.mjs (safeStorage) or bin/nestd.mjs (key file).
 *
 * A provider is { tag, encrypt(plaintext) -> base64, decrypt(base64) -> plaintext }.
 */
export function initSecrets(p) {
  if (!p || typeof p.tag !== 'string' || !p.tag
      || typeof p.encrypt !== 'function' || typeof p.decrypt !== 'function') {
    throw new Error('initSecrets() needs a provider: { tag, encrypt, decrypt }')
  }
  if (p.tag.includes('.')) {
    // The tag is a field in a '.'-delimited format string; a '.' inside it
    // would make parseSecret() split in the wrong place.
    throw new Error(`initSecrets(): provider tag must not contain '.' (got "${p.tag}")`)
  }
  provider = p
}

function requireProvider() {
  if (!provider) {
    throw new Error(
      'Secrets used before initSecrets() — the entrypoint must wire a provider at startup'
    )
  }
  return provider
}

/** Which provider is wired, or null if none is. For diagnostics and 8B.2. */
export function activeSecretsTag() {
  return provider ? provider.tag : null
}

/**
 * Split a stored value into { tag, payload } without decrypting it.
 *
 * Exported because the re-key migration needs to enumerate secrets and
 * report, per value, which provider wrote it — including ones the current
 * provider cannot read.
 */
export function parseSecret(ciphertext) {
  const value = String(ciphertext)
  if (!value.startsWith(FORMAT_PREFIX)) {
    return { tag: LEGACY_TAG, payload: value, tagged: false }
  }
  const rest = value.slice(FORMAT_PREFIX.length)
  const dot = rest.indexOf('.')
  if (dot <= 0) {
    throw new Error('Malformed secret: tagged with no provider tag')
  }
  return { tag: rest.slice(0, dot), payload: rest.slice(dot + 1), tagged: true }
}

export function encryptSecret(plaintext) {
  if (!plaintext) return null
  const p = requireProvider()
  return `${FORMAT_PREFIX}${p.tag}.${p.encrypt(String(plaintext))}`
}

export function decryptSecret(ciphertextValue) {
  if (!ciphertextValue) return null
  const p = requireProvider()
  const { tag, payload } = parseSecret(ciphertextValue)
  if (tag !== p.tag) {
    // Not a crash to paper over: this is precisely the trap-5.3 condition —
    // ciphertext written by a different provider (or by the same OS user under
    // a different account) reaching a daemon that cannot read it. Say which
    // provider wrote it and which is running, because that message is what an
    // admin needs in order to know whether the value is recoverable at all.
    throw new Error(
      `This secret was written by the "${tag}" provider but "${p.tag}" is running; it cannot be decrypted here`
    )
  }
  return p.decrypt(payload)
}
