'use strict'

// =============================================================================
// Redstart Nest — Shared path containment for MCP capability providers
// =============================================================================
// Every file-based capability (Documents today; SQLite, PDF reader, vault,
// filesystem manager next) confines the model to one admin-configured root
// directory. This module is the single implementation of that containment so
// there is exactly one place to audit and one place to fix.
//
// Threat model: the model (or a prompt-injected tool call) supplies a path or
// filename trying to reach outside the configured root — via "..", absolute
// paths, drive-qualified Windows paths, or a symlink planted inside the root
// that points elsewhere. A plain resolve()+startsWith() check catches the
// first three but NOT the symlink case, which is why containment is checked
// against the real (symlink-resolved) filesystem path, not the lexical one.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'

// Windows filesystems are case-insensitive; a containment check that compares
// paths case-sensitively could be bypassed with "E:\ROOT\..\..". Normalize
// case on win32 only — POSIX paths stay case-sensitive.
function comparable(p) {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

// Resolves symlinks on the deepest ancestor of `p` that actually exists.
// The target file itself may not exist yet (e.g. a document about to be
// created), but every escape has to travel through some existing directory —
// so realpath-ing the existing portion is sufficient to expose symlinks.
function realpathDeepestExisting(p) {
  let current = p
  const tail = []
  // Walk up until we find something that exists (the root of a valid config
  // always exists, so this terminates before the filesystem root in practice).
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) return p // nothing exists on this drive — leave lexical
    tail.unshift(path.basename(current))
    current = parent
  }
  return path.join(fs.realpathSync.native(current), ...tail)
}

/**
 * Resolve `userPath` (relative or absolute, model-supplied) against `root`
 * (admin-configured) and verify the result stays inside `root` — including
 * through symlinks. Returns the resolved absolute path on success.
 * Throws on any escape; callers translate that into an MCP isError result.
 *
 * `root` must exist. The final target may or may not exist (works for both
 * read tools and about-to-write tools).
 */
export function resolveWithinRoot(root, userPath) {
  if (!root || typeof root !== 'string') {
    throw new Error('No root directory configured')
  }
  if (typeof userPath !== 'string') {
    throw new Error('Path must be a string')
  }
  // NUL bytes can truncate paths at the native layer — reject outright.
  if (userPath.includes('\0')) {
    throw new Error('Path contains an invalid character')
  }

  const realRoot = fs.realpathSync.native(path.resolve(root)) // throws if root missing — config error, let it surface

  // Resolve the candidate lexically first (handles "..", absolute input,
  // and win32 drive-qualified paths in one step)...
  const lexical = path.resolve(realRoot, userPath)
  // ...then resolve symlinks along whatever part of it exists.
  const real = realpathDeepestExisting(lexical)

  const rootCmp = comparable(realRoot)
  const realCmp = comparable(real)
  if (realCmp !== rootCmp && !realCmp.startsWith(rootCmp + path.sep)) {
    throw new Error('Path escapes the configured root directory')
  }
  return real
}

/**
 * Convenience wrapper for providers: returns the resolved path, or null if
 * the path escapes — for call sites that prefer branching over try/catch.
 * Configuration errors (missing/invalid root) still throw.
 */
export function tryResolveWithinRoot(root, userPath) {
  try {
    return resolveWithinRoot(root, userPath)
  } catch (err) {
    if (err.message === 'Path escapes the configured root directory' ||
        err.message === 'Path contains an invalid character' ||
        err.message === 'Path must be a string') {
      return null
    }
    throw err
  }
}
