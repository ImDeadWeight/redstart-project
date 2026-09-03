'use strict'

// =============================================================================
// Redstart Nest — desktop integration points
// =============================================================================
// The things a DESKTOP client can do that a headless daemon cannot, held as
// capabilities an entrypoint registers rather than as imports the daemon makes.
// Two of them so far: the OS recycle bin, and the login item.
//
// Why a registry and not `if (process.platform === ...)` or a try/catch around
// `import('electron')`:
//
//   1. Under plain Node the `electron` package resolves to a module with no
//      named exports, so `import { shell } from 'electron'` is an IMPORT-TIME
//      failure — a module that does it cannot be loaded at all, however
//      carefully its callers avoid calling into it. That is what stopped
//      bin/nestd.mjs booting after the 8A.2 split, and no runtime check can
//      fix it.
//
//   2. Phase 6 §6.1 already settled the shape of this question. A runtime test
//      for "am I the privileged local caller" is exactly the ambiguity that
//      killed reveal-in-explorer: nothing could distinguish "the user is
//      sitting at this machine" from "a browser somewhere on the network".
//      Registration has no such ambiguity — the process that registered the
//      capability IS the one that can perform it.
//
// ABSENCE IS A LEGITIMATE ANSWER, NOT DEGRADATION. There is no recycle bin on
// a monitor-less appliance and no login item for a service that starts at boot.
// Callers must handle absence honestly: fall back where a fallback is real
// (trash.mjs's .trash/ folder), and report it where one is not (the startup
// toggle, which says `supported: false` rather than claiming a value).
// =============================================================================

let recycleBin = null
let loginItems = null

// ---------------------------------------------------------------------------
// The OS recycle bin
// ---------------------------------------------------------------------------

/**
 * @param {((fullPath: string) => Promise<unknown>) | null} fn
 *   Electron's shell.trashItem, or null to clear (tests).
 */
export function setRecycleBin(fn) {
  recycleBin = typeof fn === 'function' ? fn : null
}

export function hasRecycleBin() {
  return typeof recycleBin === 'function'
}

/**
 * Move a path to the OS recycle bin. Rejects if there is none — callers decide
 * what absence means for them, because it does not mean the same thing for a
 * user's document as it does for a re-downloadable 40GB model.
 */
export async function moveToRecycleBin(fullPath) {
  if (!recycleBin) throw new Error('No OS recycle bin is available in this process')
  return recycleBin(fullPath)
}

// ---------------------------------------------------------------------------
// The login item (Phase 7 §7.4)
// ---------------------------------------------------------------------------

/**
 * @param {{ get(): { openAtLogin: boolean },
 *           set(settings: { openAtLogin: boolean, args: string[] }): void } | null} impl
 *   Electron's app.getLoginItemSettings / app.setLoginItemSettings, or null.
 */
export function setLoginItems(impl) {
  loginItems = (impl && typeof impl.get === 'function' && typeof impl.set === 'function') ? impl : null
}

export function getLoginItems() {
  return loginItems
}
