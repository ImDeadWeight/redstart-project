'use strict'

// =============================================================================
// Redstart Nest — Recoverable deletion
// =============================================================================
// Shared by both things that can remove a file from a user's server storage:
// the model, via the delete_file MCP tool (fs-delete-tool.mjs), and the user,
// via the web file explorer (files-api.mjs).
//
// One implementation on purpose. A user-driven delete should be exactly as
// recoverable as a model-driven one — the person clicking a trash icon in a
// file list has no more intention of losing data than the model does, and two
// deletion paths with different semantics is how "we never destroy anything"
// quietly stops being true on one of them.
//
// Two tiers, in order:
//   1. The OS recycle bin, when the entrypoint registered one
//      (desktop-integration.mjs — Electron's shell.trashItem).
//   2. A .trash/<timestamp>/ folder inside the caller's own storage, when tier 1
//      is unavailable (the headless daemon, plain-node test runs) or fails
//      (network share, removable media, group policy).
//
// Tier 1 being absent is NOT degradation here: a monitor-less box has no
// desktop recycle bin to put anything in, and tier 2 keeps the invariant below
// true on its own.
//
// INVARIANT: nothing here destroys data. A delete that cannot be made
// recoverable FAILS and leaves the file where it was; it never falls through to
// a permanent removal. `.trash` is already in the vault provider's SKIP_DIRS, so
// trashed files do not come back as search results.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import { hasRecycleBin, moveToRecycleBin } from './desktop-integration.mjs'

export const TRASH_DIR_NAME = '.trash'

/** True when a path lies inside the root's .trash/ folder. */
export function isInTrash(rootDir, fullPath) {
  const trashRoot = path.join(path.resolve(rootDir), TRASH_DIR_NAME)
  const rel = path.relative(trashRoot, fullPath)
  return rel === '' || (!path.isAbsolute(rel) && !rel.startsWith('..'))
}

// Timestamped bucket, so two deletions of the same relative path never collide
// and the original folder structure survives for a manual restore.
function trashDestination(rootDir, fullPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const relative = path.relative(path.resolve(rootDir), fullPath)
  return path.join(path.resolve(rootDir), TRASH_DIR_NAME, stamp, relative)
}

/**
 * Move a path to the recycle bin, or to the root's .trash/ folder as a
 * fallback. Never deletes permanently.
 *
 * @param {string} rootDir  the caller's own storage root (holds the fallback)
 * @param {string} fullPath absolute path, ALREADY validated as contained
 * @returns {Promise<{ok: true, method: 'recycle-bin'|'trash-folder', hint: string}
 *                  | {ok: false, error: string}>}
 */
export async function moveToTrash(rootDir, fullPath) {
  if (hasRecycleBin()) {
    try {
      const result = await moveToRecycleBin(fullPath)
      // Electron <14 returned a boolean; current versions resolve void and
      // reject on failure. An explicit false is a failure either way.
      if (result !== false) return { ok: true, method: 'recycle-bin', hint: 'restore it from the Recycle Bin' }
    } catch {
      // A recycle bin that refuses this path must not become a real delete.
    }
  }
  const destination = trashDestination(rootDir, fullPath)
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.renameSync(fullPath, destination)
  } catch (err) {
    return { ok: false, error: `could not move it to ${TRASH_DIR_NAME}/: ${err.message}` }
  }
  const shown = path.relative(path.resolve(rootDir), destination).split(path.sep).join('/')
  return { ok: true, method: 'trash-folder', hint: `move it back from ${shown}` }
}
