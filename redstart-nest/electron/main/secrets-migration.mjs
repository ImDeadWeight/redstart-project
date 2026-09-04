'use strict'

// =============================================================================
// Redstart Nest — re-keying stored secrets
// =============================================================================
// The one step in this whole area that can destroy user data silently, so the
// shape of it is deliberate everywhere.
//
// THE CONSTRAINT: Electron's safeStorage is DPAPI on
// Windows, and DPAPI is bound to the USER ACCOUNT. Ciphertext written by the
// logged-in user cannot be decrypted by a service account. So an install that
// converts to level 3 must decrypt and re-encrypt **while still running as the
// original user** — afterwards is too late, permanently, and the failure is
// silent because almost every caller of decryptSecret() sits behind a `try`.
//
// WHAT THIS MODULE IS NOT. It does not register a service, does not change
// where a running daemon reads from, and never runs at startup. It produces a
// converted tree; a human then points a service at it. Automating the switch
// is what would turn a recoverable step into an unattended one, and the whole
// value here is that a person can look at the dry run first and stop.
//
// ORDER OF OPERATIONS, and each step exists because of a specific way this
// goes wrong:
//
//   1. FIND    a structural walk for secrets. Generic, not a list of the three
//              fields that exist today — a fourth added later must not be
//              invisible to the migration, because the failure mode of missing
//              one is silent permanent loss.
//   2. PLAN    decrypt every one with the OLD provider and report, writing
//              nothing. A secret that cannot be read is named individually.
//   3. APPLY   copy the tree, re-encrypting on the way, into a target that
//              must be empty.
//   4. VERIFY  decrypt every secret back OUT of the target with the NEW
//              provider. A migration that writes something unreadable and
//              reports success is the exact disaster this is guarding against.
//
// The source tree is never modified and never deleted. Recovery from a failed
// conversion is "point at the old directory again", which needs no tooling and
// no explanation.
//
// A NOTE ON THE PROVIDER TAG, correcting an earlier claim about it.
// The earlier claim said the tag turns "find every blob the old provider wrote" into
// a query rather than a hand-audit of schemas. Half right: finding the FIELDS
// is still structural, and that is what findSecrets() below does. What the tag
// actually bought is the other half, and it is the half that matters here —
// for each blob found, WHICH provider wrote it, including for blobs this
// process cannot decrypt. Without it those are indistinguishable from
// corruption, and an admin would have no way to tell "this needs re-entering"
// from "this file is damaged".
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import { parseSecret } from './secrets.mjs'
import { KEY_FILE_NAME } from './secrets-keyfile.mjs'

// Nest's own state files. Only these are parsed as JSON looking for secrets;
// everything else in the tree is copied byte-for-byte.
const STATE_FILES = [
  'tools.json',    // postgres connectionStringEnc, externalServers[].apiKeyEnc
  'plugins.json',  // per-plugin envEnc maps
  'settings.json',
  'profiles.json',
  'accounts.json',
  'roles.json',
  'prompt-blocks.json',
]

/**
 * Anything whose key ends in `Enc` and whose value is a string.
 *
 * Structural on purpose. The alternative — naming the three fields that exist
 * today — means a secret added in six months is silently skipped by a
 * migration that reports success, and the credential is gone with no error
 * anywhere. A generic rule over-collects at worst (a non-secret field someone
 * names `somethingEnc`), and over-collecting is loud: it fails the dry run.
 */
function walkForSecrets(node, trail, out) {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkForSecrets(item, [...trail, String(i)], out))
    return
  }
  if (!node || typeof node !== 'object') return
  for (const [key, value] of Object.entries(node)) {
    if (!key.endsWith('Enc')) {
      if (value && typeof value === 'object') walkForSecrets(value, [...trail, key], out)
      continue
    }
    // A key ending in `Enc` marks encrypted material — which may be ONE value
    // or a MAP of them. plugins.json's `envEnc` is the second shape:
    // { TOKEN: <ciphertext>, OTHER: <ciphertext> }, keyed by environment
    // variable name. The first version of this walk only matched the string
    // case, so every plugin env secret was invisible to the migration: found
    // by scripts/test-secrets-migration.mjs before this shipped, and it is
    // precisely the silent permanent loss the generic walk exists to prevent.
    // Being marked as encrypted is a property of the CONTAINER's name, not of
    // the leaf's.
    if (typeof value === 'string') {
      if (value) out.push({ pointer: [...trail, key], value })
    } else if (value && typeof value === 'object') {
      for (const [inner, innerValue] of Object.entries(value)) {
        if (typeof innerValue === 'string' && innerValue) {
          out.push({ pointer: [...trail, key, inner], value: innerValue })
        }
      }
    }
  }
}

/**
 * Every encrypted value in a config directory, with the provider that wrote it.
 *
 * @returns {Array<{ file: string, pointer: string[], tag: string, value: string }>}
 */
export function findSecrets(dir) {
  const found = []
  for (const file of STATE_FILES) {
    const full = path.join(dir, file)
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(full, 'utf8'))
    } catch {
      // Absent or unparseable. Not this module's problem to report: an
      // unparseable state file is already handled (and preserved) by
      // json-store.mjs, and a file that holds no readable JSON holds no
      // readable secrets either.
      continue
    }
    const raw = []
    walkForSecrets(parsed, [], raw)
    for (const item of raw) {
      let tag
      try {
        tag = parseSecret(item.value).tag
      } catch {
        tag = 'unparseable'
      }
      found.push({ file, pointer: item.pointer, tag, value: item.value })
    }
  }
  return found
}


/**
 * Decrypt one found secret with `from`, refusing a blob `from` did not write.
 *
 * The tag check is the point, and its absence was a real bug caught by
 * scripts/test-secrets-migration.mjs: without it, a value written by a
 * DIFFERENT provider gets handed to `from` anyway. A provider that happens to
 * accept the bytes then "succeeds", and applyRekey() re-encrypts the garbage
 * it got back — silent corruption of a secret that was previously fine. The
 * realistic way in is a partially converted install, which is exactly the
 * tree someone runs this against twice.
 *
 * secrets.mjs's decryptSecret() enforces the same rule for the same reason;
 * this mirrors it rather than reimplementing the judgement.
 */
function decryptWith(from, secret) {
  const { tag, payload } = parseSecret(secret.value)
  if (tag !== from.tag) {
    throw new Error(`written by the "${tag}" provider, not "${from.tag}"`)
  }
  const plaintext = from.decrypt(payload)
  if (typeof plaintext !== 'string') throw new Error('decrypted to a non-string')
  return plaintext
}

/**
 * The dry run. Decrypts everything with `from` and reports; writes nothing,
 * touches nothing, and is not optional before applyRekey().
 *
 * A secret that cannot be decrypted — the original Windows account is gone, or
 * the ciphertext was written by a different provider — is reported INDIVIDUALLY
 * and does not make the conversion impossible. That is deliberate: refusing to
 * convert at all would leave an admin whose one stale credential blocks
 * everything with no path forward except a wipe. They re-enter that one.
 *
 * @returns {{ total: number, readable: number, unreadable: Array<{file,pointer,tag,reason}>, byTag: Record<string,number> }}
 */
export function planRekey({ dir, from }) {
  const secrets = findSecrets(dir)
  const unreadable = []
  const byTag = {}
  let readable = 0

  for (const s of secrets) {
    byTag[s.tag] = (byTag[s.tag] ?? 0) + 1
    try {
      decryptWith(from, s)
      readable++
    } catch (err) {
      // The reason, never the value. A dry-run report is something an admin
      // pastes into a support conversation.
      unreadable.push({ file: s.file, pointer: s.pointer.join('.'), tag: s.tag, reason: err.message })
    }
  }

  return { total: secrets.length, readable, unreadable, byTag }
}

function setAtPointer(root, pointer, value) {
  let node = root
  for (const step of pointer.slice(0, -1)) node = node[step]
  node[pointer.at(-1)] = value
}

/**
 * Copy `sourceDir` to `targetDir`, re-encrypting every secret from `from` to
 * `to` on the way, then verify the result is readable.
 *
 * The target must not already exist, or must be empty. Converting twice, or
 * into a directory another install owns, is a way to lose the tree that WAS
 * good — and this module's entire safety story is that the source survives.
 *
 * @returns {{ ok: boolean, error?: string, migrated: number, skipped: Array, verified: number }}
 */
export function applyRekey({ sourceDir, targetDir, from, to }) {
  if (path.resolve(sourceDir) === path.resolve(targetDir)) {
    return { ok: false, error: 'The target must be a different directory from the source.', migrated: 0, skipped: [], verified: 0 }
  }
  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
    return { ok: false, error: `The target directory is not empty: ${targetDir}`, migrated: 0, skipped: [], verified: 0 }
  }

  const plan = planRekey({ dir: sourceDir, from })

  // Build every rewritten file in memory first. Nothing is written until all
  // the decryption that is going to succeed has succeeded — so a provider that
  // fails halfway leaves a target that was never created rather than one
  // holding half a config.
  const rewritten = new Map()
  const skipped = []
  // Exactly what this run re-encrypted, keyed by location. Verification below
  // checks THESE and nothing else — see the comment there.
  const migratedPointers = new Set()
  let migrated = 0

  for (const file of STATE_FILES) {
    const full = path.join(sourceDir, file)
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(full, 'utf8'))
    } catch {
      continue
    }
    const secrets = []
    walkForSecrets(parsed, [], secrets)
    if (!secrets.length) continue

    for (const s of secrets) {
      try {
        const plaintext = decryptWith(from, s)
        setAtPointer(parsed, s.pointer, `v1.${to.tag}.${to.encrypt(plaintext)}`)
        migratedPointers.add(`${file}:${s.pointer.join('.')}`)
        migrated++
      } catch (err) {
        // Left EXACTLY as it was, not dropped and not blanked. The value is
        // useless to the new install, but deleting it would also delete the
        // evidence that a credential used to be configured there — which is
        // what tells an admin what to re-enter.
        skipped.push({ file, pointer: s.pointer.join('.'), reason: err.message })
      }
    }
    rewritten.set(file, JSON.stringify(parsed, null, 2))
  }

  // Copy the whole tree, then overwrite the files that changed. Copying
  // everything matters: a state file this module does not parse is still state
  // the daemon needs, and a migration that moves only the secrets produces an
  // install that has credentials and nothing else.
  try {
    fs.mkdirSync(targetDir, { recursive: true })
    fs.cpSync(sourceDir, targetDir, {
      recursive: true,
      // NEVER copy the source's key file. It is the source's crypto identity,
      // not state — and copying it lands ON TOP of the key `to` just created,
      // so every value re-encrypted a moment ago becomes unreadable.
      //
      // This bug shipped in the first version of this module and the unit
      // tests did not catch it, because they migrate FROM safeStorage (a tree
      // with no key file, so nothing clobbers anything). It showed up the
      // first time the operator CLI was run keyfile -> keyfile. Worse, the
      // migration still reported "verified": the provider had the new key
      // cached in memory, so verification read through the cache and never
      // touched the file that had just been overwritten. That combination —
      // a verified success over a tree the daemon cannot read — is precisely
      // the disaster this module exists to prevent, and it got within one
      // manual run of shipping.
      filter: (src) => path.basename(src) !== KEY_FILE_NAME,
    })
    for (const [file, contents] of rewritten) {
      fs.writeFileSync(path.join(targetDir, file), contents, 'utf8')
    }
  } catch (err) {
    return { ok: false, error: `Could not write the new directory: ${err.message}`, migrated: 0, skipped, verified: 0 }
  }

  // VERIFY, against the target, with the NEW provider. Writing something the
  // new provider cannot read and reporting success is the precise disaster
  // this whole module exists to prevent, and it is not hypothetical: a key
  // file that failed to persist would produce exactly that.
  let verified = 0
  const unverifiable = []
  for (const s of findSecrets(targetDir)) {
    // Only what this run wrote. Matching on the tag instead was wrong and the
    // suite caught it: a SKIPPED secret can already carry the new provider's
    // tag (a partially converted install is the realistic way in), and trying
    // to verify a blob this run never re-encrypted fails the whole migration
    // over a value that was already unreadable before it started — and which
    // was deliberately preserved rather than touched.
    if (!migratedPointers.has(`${s.file}:${s.pointer.join('.')}`)) continue
    try {
      to.decrypt(parseSecret(s.value).payload)
      verified++
    } catch (err) {
      unverifiable.push(`${s.file}:${s.pointer.join('.')} (${err.message})`)
    }
  }

  if (unverifiable.length) {
    return {
      ok: false,
      error: `The new directory could not be read back: ${unverifiable.join('; ')}. The original is untouched at ${sourceDir}.`,
      migrated, skipped, verified,
    }
  }
  if (verified !== migrated) {
    return {
      ok: false,
      error: `Re-encrypted ${migrated} secrets but only ${verified} were found in the new directory. The original is untouched at ${sourceDir}.`,
      migrated, skipped, verified,
    }
  }

  return { ok: true, migrated, skipped, verified, planned: plan.total }
}
