'use strict'

// =============================================================================
// Redstart Nest — argument shapes for the mutating IPC channels
// =============================================================================
// A hardening layer, NOT the trust boundary. guard.mjs is what stops an
// untrusted sender; this is what stops a TRUSTED sender from sending nonsense —
// a renderer bug, a refactor that changes an argument's type, a value that
// arrived from the network and was never checked.
//
// Applied only where a call CHANGES STATE. Schema-ing a read-only handler like
// `models:publishers` buys nothing and is where this kind of work stalls.
//
// Hand-rolled rather than zod: `dependencies` is a short list of lean packages
// that all ship inside the installer, and this repo already hand-rolls its
// primitives by preference (path-scope.mjs, external-mcp-url.mjs, the PNG
// encoder in index.mjs). A schema library for a handful of call sites does not
// earn its place in the shipped bundle.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'

/** Objects only — arrays and null are the two things `typeof x === 'object'` lies about. */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

export function isAbsolutePath(value) {
  return isNonEmptyString(value) && path.isAbsolute(value)
}

/** Absent (undefined/null) is fine; present means it must satisfy `check`. */
export function optional(value, check) {
  return value === undefined || value === null || check(value)
}

/**
 * The head of the escalation chain: this string becomes `spawn()`'s first
 * argument by way of resolveBinary(). Three independent conditions, because
 * each blocks a different thing — a non-string breaks the settings file, a
 * non-.exe is not a thing Windows would launch as a server, and a path that
 * does not exist is one an attacker could create later.
 *
 * @returns {string|null} the reason to refuse, or null if acceptable.
 */
export function binaryPathRejection(value) {
  if (!isNonEmptyString(value)) return 'A binary path must be a non-empty string.'
  if (!path.isAbsolute(value)) return 'A binary path must be absolute.'
  if (path.extname(value).toLowerCase() !== '.exe') return 'A server binary must be an .exe.'
  try {
    if (!fs.statSync(value).isFile()) return 'That path is not a file.'
  } catch {
    return 'That file does not exist.'
  }
  return null
}
