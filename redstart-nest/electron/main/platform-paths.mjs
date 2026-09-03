'use strict'

// =============================================================================
// Redstart Nest — platform paths seam
// =============================================================================
// Every module that needs to know "where does data live" asks HERE instead of
// asking Electron's `app.getPath` directly. That is the seam the daemon
// extraction depends on: on the appliance there is no Electron to ask, and the
// answer has to come from somewhere that has never heard of it.
// `logger.mjs` already demonstrated this shape — it takes a directory as a
// plain argument and imports nothing from Electron — this module generalises
// it to everywhere else that currently reaches for `app.getPath`.
//
// TWO PURPOSES, NEVER ONE DIRECTORY. This is not a convenience split:
//
//   configDir()         Nest's own state — accounts, roles, tools, plugins,
//                        profiles, settings, logs. Small, always wanted in a
//                        backup, and what §3.2's last-resort reset
//                        (stop the daemon, delete accounts.json, re-bootstrap)
//                        operates on.
//
//   capabilityBaseDir()  Base folder for the five folder-scoped capabilities
//                        (documents, sqlite, vault, git, file_system — see
//                        ensureDefaultCapabilityFolders in tools-storage.mjs).
//                        USER CONTENT, not Nest state. Potentially large,
//                        optional in a config-only backup.
//
// Collapsing these into one directory is the mistake this module exists to
// prevent: a config reset must never be able to wander into a user's
// documents, and a backup has to be able to treat "my settings" and "my
// files" as different questions. See headless-admin-plane-plan.md §3.5.
//
// Fail-closed: reading before initPaths() has run is a
// startup-ordering bug, not a condition to paper over with a default —
// silently falling back to somewhere plausible is exactly how state quietly
// ends up split across two directories.
// =============================================================================

import * as path from 'path'

let paths = null

/**
 * @param {object} input
 * @param {string} input.config          Nest's own state directory.
 * @param {string} input.capabilityBase  Base for the folder-scoped capabilities.
 * @param {boolean} input.isPackaged     Packaged-build mode, not a path — kept
 *   here for convenience (every caller of the paths module tends to want both),
 *   but deliberately not folded into the same concept: the daemon will always
 *   want the paths and may not care about packaging at all.
 */
export function initPaths({ config, capabilityBase, isPackaged }) {
  if (typeof config !== 'string' || !config) throw new Error('initPaths: config must be a non-empty string')
  if (typeof capabilityBase !== 'string' || !capabilityBase) throw new Error('initPaths: capabilityBase must be a non-empty string')
  const overlap = subtreeRejection(config, capabilityBase)
  if (overlap) throw new Error(`initPaths: ${overlap}`)
  paths = { config, capabilityBase, isPackaged: !!isPackaged }
}

/**
 * Phase 8B.1 - the two directories must be separate subtrees, and this refuses
 * at startup rather than letting them quietly collapse.
 *
 * Design section 3.5 gives two reasons and both fail SILENTLY if they merge,
 * which is why this is a hard error rather than a warning:
 *
 *   Backups. Config is small and always wanted; capability folders hold user
 *   content that may be enormous and has different restore semantics. One tree
 *   makes that distinction impossible to express.
 *
 *   The reset path. Section 3.2's last resort is "stop the daemon, delete
 *   accounts.json, start over". A config reset must never be adjacent to a
 *   user's documents in the filesystem - that is a foot-gun for someone moving
 *   fast during an incident, which is exactly when that path gets used.
 *
 * Nesting counts, not just equality: a config directory inside the capability
 * base puts accounts.json somewhere a capability can enumerate, and a
 * capability base inside config puts a user's documents inside the tree the
 * reset deletes. Both directions are refused.
 *
 * @returns {string|null} the reason to refuse, or null
 */
export function subtreeRejection(config, capabilityBase) {
  const a = path.resolve(config)
  const b = path.resolve(capabilityBase)
  // Case-insensitive on win32, matching path-scope.mjs's own normalisation.
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)
  if (norm(a) === norm(b)) {
    return 'config and capabilityBase must not be the same directory (design 3.5)'
  }
  const contains = (parent, child) => {
    const rel = path.relative(norm(parent), norm(child))
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  }
  if (contains(a, b)) return 'capabilityBase must not sit inside config (design 3.5)'
  if (contains(b, a)) return 'config must not sit inside capabilityBase (design 3.5)'
  return null
}

function requirePaths() {
  if (!paths) throw new Error('platform-paths: initPaths() has not been called yet — this is a startup-ordering bug, not a runtime condition to handle')
  return paths
}

/** Nest's own state: accounts, roles, tools, plugins, profiles, settings, logs. */
export function configDir() {
  return requirePaths().config
}

/** Base directory for the folder-scoped capabilities. Never the same as configDir(). */
export function capabilityBaseDir() {
  return requirePaths().capabilityBase
}

export function isPackaged() {
  return requirePaths().isPackaged
}
