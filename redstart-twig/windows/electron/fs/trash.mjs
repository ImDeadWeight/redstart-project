'use strict'

// =============================================================================
// Redstart Twig — Recoverable deletion for the local file-system tools
// =============================================================================
// fs_delete_file used to be fs.unlinkSync: a hard, irreversible delete on the
// user's own machine, driven by a local model's judgement, with no undo. That
// recoverability gap is the whole reason this module exists — a delete the user
// can walk back is a fundamentally different risk category from one they
// cannot, and it is what makes exposing a delete tool to a model defensible.
//
// Two tiers, in order:
//   1. The OS recycle bin, via Electron's shell.trashItem().
//   2. A .trash/ folder inside the granted root, when tier 1 is unavailable
//      (plain-node runs) or fails (network drive, permissions, some shells).
//
// INVARIANT: this module never destroys anything. A delete that cannot be made
// recoverable fails instead of falling through to a permanent removal, and a
// path already inside .trash/ is refused rather than emptied. Anything that
// would break that invariant belongs behind a separate, explicitly-named tool,
// not in here.
//
// Electron is injected rather than imported: main.mjs calls setTrashImpl() at
// startup with shell.trashItem. That keeps this module (and fs-tool.mjs, which
// imports it) loadable under plain node for containment tests, and avoids a
// dynamic import('electron') — see the ESM warning in main.mjs's header, that
// crashes the app at startup.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'

const TRASH_DIR_NAME = '.trash'

// Set by main.mjs at startup. Left null under plain node, where tier 2 applies.
let trashItemImpl = null

/**
 * Register the OS-level trash implementation (Electron's shell.trashItem).
 * @param {(fullPath: string) => Promise<void|boolean>} fn
 */
export function setTrashImpl(fn) {
  trashItemImpl = typeof fn === 'function' ? fn : null
}

/** Exposed for tests: forget any registered implementation. */
export function resetTrashImpl() {
  trashItemImpl = null
}

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
 * @param {string} rootDir  the granted root (the .trash/ fallback lives here)
 * @param {string} fullPath an absolute path ALREADY validated as contained
 * @returns {Promise<{ok: true, method: 'recycle-bin'|'trash-folder', restoreHint: string}
 *                  | {ok: false, error: string}>}
 */
export async function moveToTrash(rootDir, fullPath) {
  // Refused rather than permanently deleted: emptying the trash is a different
  // operation with a different risk profile, and allowing it here would give
  // the model a name it could use to make this tool destructive after all.
  if (isInTrash(rootDir, fullPath)) {
    return {
      ok: false,
      error: `Already in ${TRASH_DIR_NAME}/. Items there are kept for recovery — remove them yourself if you are sure.`,
    }
  }

  if (trashItemImpl) {
    try {
      const result = await trashItemImpl(fullPath)
      // Electron <14 returned a boolean; current versions resolve void and
      // reject on failure. Treat an explicit false as a failure either way.
      if (result !== false) {
        return { ok: true, method: 'recycle-bin', restoreHint: 'restore it from the Recycle Bin' }
      }
    } catch {
      // Fall through to the folder fallback — a recycle bin that refuses this
      // path (network drive, removable media, policy) must not turn into a
      // permanent delete.
    }
  }

  const destination = trashDestination(rootDir, fullPath)
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.renameSync(fullPath, destination)
  } catch (err) {
    return { ok: false, error: `Could not move to ${TRASH_DIR_NAME}/: ${err.message}` }
  }
  const shownPath = path.relative(path.resolve(rootDir), destination).split(path.sep).join('/')
  return { ok: true, method: 'trash-folder', restoreHint: `move it back from ${shownPath}` }
}
