'use strict'

// =============================================================================
// Redstart Nest — resource grants: one shared root, narrowed to folders
// =============================================================================
// Vault, Git, SQLite and Shared Documents each read one admin-configured
// root, which every account with the capability saw whole. A role can now
// narrow that root to some of its folders (resource-grants-plan.md, master
// plan 6.1):
//
//   cfg.git.grants = null                   inherit: the whole root
//   cfg.git.grants = ['repos', 'archive']   these folders of it
//   cfg.git.grants = []                     narrowed to nothing
//
// A GRANT NEVER WIDENS. Grants are paths RELATIVE to the root, never
// absolute, so a role cannot name a directory the admin did not configure;
// the root is the admin's, unchanged. Composition is intersection, so a role
// applied twice is the role applied once. Which roots a role has, and
// whether a path is inside one, both go through resolveWithinRoot
// (path-scope.mjs), symlinks included: no second containment rule.
//
// THE UN-GRANTED DEFAULT, ONCE A LIST EXISTS, IS DENY. `[]` is not absent:
// it means nothing. Everything here tests `grants === null || undefined` for
// inherit, never truthiness, which is what would turn [] into everything.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import { resolveWithinRoot } from './path-scope.mjs'
import { logPolicy } from './logger.mjs'

/** The capabilities a role can narrow to folders, by their grants key. */
export const GRANTABLE = Object.freeze(['sqlite', 'git', 'vault', 'shared_documents'])
export const MAX_GRANTS_PER_CAPABILITY = 32

const inherits = (g) => g === null || g === undefined

/**
 * Is `p` a folder path a grant may name? Relative to the root, forward
 * slashes, no "..", no ".", no empty part, no dot-folder, at most 200 chars.
 *
 * @param {unknown} p
 */
export function validGrantPath(p) {
  if (typeof p !== 'string' || !p || p.length > 200) return false
  if (p.includes('\\') || p.includes('\0') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false
  return p.split('/').every((seg) => seg && seg !== '.' && seg !== '..' && !seg.startsWith('.'))
}

/** A grant as stored: trailing slashes off. Not a validator. */
export function normalizeGrant(p) {
  return String(p).trim().replace(/\/+$/, '')
}

/** Is folder `a` the same as, or inside, folder `b` (both relative)? */
function within(a, b) {
  return a === b || a.startsWith(`${b}/`)
}

/**
 * The grants left when a role's list narrows the current ones. Inherit
 * leaves the other side as it is; otherwise only folders inside both survive,
 * the narrower of each pair. Sorted and de-duplicated, so the result is a
 * function of the two lists alone and applying it twice changes nothing.
 *
 * @param {string[] | null | undefined} current
 * @param {string[] | null | undefined} next
 * @returns {string[] | null}
 */
export function intersectGrants(current, next) {
  if (inherits(next)) return inherits(current) ? null : [...current]
  const n = next.filter(validGrantPath)
  const out = new Set()
  if (inherits(current)) {
    for (const a of n) out.add(a)
  } else {
    for (const a of n) if (current.some((b) => within(a, b))) out.add(a)
    for (const b of current) if (n.some((a) => within(b, a))) out.add(b)
  }
  return canonical([...out])
}

/**
 * One form for a folder list: sorted, de-duplicated, and a folder already
 * covered by a broader one dropped ("a" and "a/x" is "a"). Without it, the
 * same access could be two different lists, and a second narrowing would
 * change the first's result (the idempotence property test found this).
 */
function canonical(list) {
  const sorted = [...new Set(list)].sort()
  return sorted.filter((a) => !sorted.some((b) => b !== a && within(a, b)))
}

/**
 * A role's grants block, checked: { [capability]: string[] } for the
 * grantable capabilities only, each list valid paths, at most
 * MAX_GRANTS_PER_CAPABILITY. Absent stays absent (inherit).
 *
 * @returns {{ ok: true, grants: Record<string, string[]> | undefined } | { ok: false, error: string }}
 */
export function validateGrants(raw) {
  if (raw === null || raw === undefined) return { ok: true, grants: undefined }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'grants must be an object of folder lists' }
  /** @type {Record<string, string[]>} */
  const out = {}
  for (const [cap, list] of Object.entries(raw)) {
    if (!GRANTABLE.includes(cap)) return { ok: false, error: `"${cap}" cannot be narrowed to folders` }
    if (list === null || list === undefined) continue
    if (!Array.isArray(list)) return { ok: false, error: `grants.${cap} must be a list of folders` }
    if (list.length > MAX_GRANTS_PER_CAPABILITY) return { ok: false, error: `at most ${MAX_GRANTS_PER_CAPABILITY} folders for ${cap}` }
    const clean = []
    for (const p of list) {
      const g = typeof p === 'string' ? normalizeGrant(p) : p
      if (!validGrantPath(g)) return { ok: false, error: `"${String(p).slice(0, 80)}" is not a folder inside the ${cap} root (relative, forward slashes, no "..")` }
      clean.push(g)
    }
    out[cap] = canonical(clean)
  }
  return { ok: true, grants: out }
}

/**
 * The folders a grants list opens, as absolute paths that exist: the root
 * itself for inherit, nothing for []. A grant that no longer exists, or that
 * resolves out of the root (a symlink moved), is dropped.
 *
 * @param {string} root
 * @param {string[] | null | undefined} grants
 * @returns {string[]}
 */
export function grantedRoots(root, grants) {
  if (inherits(grants)) return [fs.realpathSync.native(path.resolve(root))]
  const out = []
  for (const g of grants) {
    try {
      const abs = resolveWithinRoot(root, g)
      if (fs.statSync(abs).isDirectory()) out.push(abs)
    } catch { /* gone, or no longer inside the root */ }
  }
  return out
}

/**
 * The relative folders an enumeration walks: [''] (the root) for inherit,
 * the grants themselves otherwise. Walking these, rather than filtering a
 * walk of the root, is what keeps an un-granted folder's NAME out of a
 * listing (grants plan §4).
 *
 * @param {string[] | null | undefined} grants
 */
export function grantedPrefixes(grants) {
  return inherits(grants) ? [''] : [...grants]
}

/**
 * The relative folders an enumeration walks, as `grantedPrefixes` but only
 * those that exist and resolve inside the root (a grant whose folder is gone,
 * or became a link out of the root, is not walked). Walkers skip symlinked
 * folders on their own, so a link inside a granted folder cannot lead a walk
 * out of it.
 *
 * @param {string} root
 * @param {string[] | null | undefined} grants
 */
export function grantedWalkStarts(root, grants) {
  if (inherits(grants)) return ['']
  return grants.filter((g) => {
    try { return fs.statSync(resolveWithinRoot(root, g)).isDirectory() } catch { return false }
  })
}

/**
 * Record a refusal in the decision log (logger.mjs logPolicy): the
 * capability and who asked, NEVER the path or a folder name (grants plan §7).
 *
 * @param {string} capability
 * @param {{ account?: { username?: string } | null } | undefined} ctx
 */
export function noteDenied(capability, ctx) {
  logPolicy('access.denied', { account: ctx?.account?.username ?? '(auth off)', capability, decision: 'deny' })
}

/** Is a granted list narrowing anything? */
export function isNarrowed(grants) {
  return !inherits(grants)
}

/** Thrown for a path inside the root but outside every granted folder. */
export class GrantDenied extends Error {
  constructor() {
    // The same words as an escape: a caller probing folder names learns
    // nothing from which of the two refused it.
    super('Path escapes the configured root directory')
    this.denied = true
  }
}

const comparable = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)

/**
 * Resolve a model-supplied path inside the root, then require it to sit in a
 * granted folder. Throws resolveWithinRoot's error for an escape, and
 * GrantDenied (same message, `.denied`) for a path the role was not given.
 *
 * @param {string} root
 * @param {string[] | null | undefined} grants
 * @param {string} userPath
 * @returns {string} the resolved absolute path
 */
export function resolveGrantedPath(root, grants, userPath) {
  const target = resolveWithinRoot(root, userPath)
  if (inherits(grants)) return target
  const t = comparable(target)
  for (const g of grantedRoots(root, grants)) {
    const r = comparable(g)
    if (t === r || t.startsWith(r + path.sep)) return target
  }
  throw new GrantDenied()
}
