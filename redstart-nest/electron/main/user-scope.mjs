'use strict'

// =============================================================================
// Redstart Nest — Per-account storage scope
// =============================================================================
// Resolves an authenticated account to the single directory NAME that account's
// files live under, inside a capability's root:
//
//     <capability root>/user_files/<scope>/...
//
// This module produces `<scope>` and nothing else. Composing it with a root —
// and containing model-supplied paths inside the result — is the caller's job,
// done through the existing symlink-aware resolveWithinRoot (path-scope.mjs) so
// there is still exactly one containment implementation to audit.
//
// WHY IT IS KEYED ON THE ACCOUNT ID AND NOT THE USERNAME
//
// The obvious design is user_files/<username>/. It is unsafe as written:
// createAccount validates usernames for UNIQUENESS only — there is no charset
// validation anywhere in the account path. A username of "../../../etc" or
// "CON" or "x." becomes a path-traversal primitive, or an un-creatable
// directory, the moment it is used as a folder name. Server-generated ids are
// safe by construction and survive a rename.
//
// The username still appears, slugified, because an admin browsing the disk
// needs to know whose folder is whose — but it is decoration. The id is what
// makes the name unique, and the "<slug>-<id>" shape is what makes the result
// structurally incapable of colliding with a Windows reserved device name
// (CON, PRN, AUX, NUL, COM1-9, LPT1-9 — none of which contain a hyphen).
//
// AUTH-OFF IS DEFINED, NOT ACCIDENTAL
//
// authenticate() returns account: null when auth is disabled. That case gets
// its own named scope rather than being allowed to fall through to the
// capability root — a null account writing to the root is exactly the shared-
// space behaviour per-user storage exists to end, and it is what happens today
// by accident.
// =============================================================================

import * as crypto from 'crypto'
import * as fs from 'fs'
import { resolveWithinRoot } from './path-scope.mjs'

/** Folder that holds every per-account scope inside a capability root. */
export const USER_FILES_DIR = 'user_files'

/** Scope used when authentication is disabled (account is null). */
export const ANONYMOUS_SCOPE = '_local'

// Slug length cap. Long enough to stay recognisable, short enough that
// <slug>-<id> cannot push a deep path near the Windows MAX_PATH limit.
const MAX_SLUG_LENGTH = 32
const SHORT_ID_LENGTH = 8

// Reduce a username to a safe, readable directory-name fragment. Everything
// outside [a-z0-9] collapses to a hyphen, which disposes of path separators,
// "..", drive colons, NUL bytes, trailing dots/spaces (invalid on Windows) and
// unicode lookalikes in one pass. A username that is entirely punctuation
// slugifies to '' — hence the fallback, since the id alone still identifies it.
function slugifyUsername(username) {
  if (typeof username !== 'string') return 'user'
  const slug = username
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '')
  return slug || 'user'
}

// A short, safe, stable fragment of the account id. Ids are server-generated
// and already safe, but this module must not depend on that remaining true —
// an id whose sanitised form is too short to disambiguate falls back to a hash,
// which is always exactly SHORT_ID_LENGTH safe characters.
function shortId(id) {
  const raw = typeof id === 'string' ? id : String(id ?? '')
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9]+/g, '')
  if (cleaned.length >= 4) return cleaned.slice(0, SHORT_ID_LENGTH)
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, SHORT_ID_LENGTH)
}

/**
 * The directory name for an account's own storage.
 *
 * Absent identity (null/undefined) is the DEFINED auth-off case and maps to the
 * anonymous scope. An account object that exists but carries no usable id is a
 * different thing entirely — a broken invariant — and throws rather than
 * falling back: quietly bucketing it with the anonymous scope would put a real
 * user's files in a folder shared with every auth-off write and with every
 * other malformed account, which is precisely the cross-account exposure
 * per-user storage exists to close. Callers surface the throw as an isError
 * result; a loud failure for an impossible state beats a silent shared folder.
 *
 * @param {{id?: string, username?: string} | null | undefined} account
 *   The account from authenticate(); null when auth is disabled.
 * @returns {string} a single path segment — never contains a separator
 */
export function resolveUserScope(account) {
  if (account === null || account === undefined) return ANONYMOUS_SCOPE
  const id = typeof account.id === 'string' ? account.id.trim() : ''
  if (!id) {
    throw new Error('Cannot resolve a storage scope: the account has no id')
  }
  return `${slugifyUsername(account.username)}-${shortId(id)}`
}

/**
 * The scope's path RELATIVE to a capability root, e.g.
 * `user_files/patrick-a1b2c3d4`. Callers resolve this against their own root
 * through resolveWithinRoot rather than joining it themselves.
 */
export function userScopePath(account) {
  return `${USER_FILES_DIR}/${resolveUserScope(account)}`
}

/**
 * The absolute directory an account's files live in, inside a capability root.
 *
 * This is containment layer 1 of 2. It composes the existing symlink-aware
 * resolveWithinRoot rather than doing its own path arithmetic, so there is
 * still exactly ONE containment implementation in the codebase to audit:
 *
 *   layer 1 (here)        user root  must resolve inside the capability root
 *   layer 2 (callers)     model path must resolve inside the user root
 *
 * Both layers are the same function with different arguments. Two composed
 * checks over one audited primitive beats one bespoke check that has to be
 * right about everything at once.
 *
 * @param {string} capabilityRoot  admin-configured root (documents.outputDir, …)
 * @param {object|null} account    from authenticate(); null when auth is off
 * @param {{create?: boolean}} [opts]  create the folder if missing (writers do)
 */
export function resolveUserRoot(capabilityRoot, account, { create = false } = {}) {
  const userRoot = resolveWithinRoot(capabilityRoot, userScopePath(account))
  if (create) fs.mkdirSync(userRoot, { recursive: true })
  return userRoot
}

/**
 * Resolve a MODEL-SUPPLIED path inside the caller's own storage — the two
 * layers applied together, which is what every per-account tool call needs.
 *
 * Note what this makes structurally impossible rather than merely checked: a
 * path naming another account's file resolves inside the CALLER'S folder, where
 * no such file exists, and 404s. There is no comparison of "is this mine?" to
 * forget, get backwards, or skip on one of the three code paths that reach the
 * same bytes — which is exactly how the current cross-account read exists.
 */
export function resolveUserPath(capabilityRoot, account, userPath, opts) {
  return resolveWithinRoot(resolveUserRoot(capabilityRoot, account, opts), userPath)
}
