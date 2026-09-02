'use strict'

// =============================================================================
// Redstart Nest — renderer → main IPC sender validation
// =============================================================================
// Every `ipcMain.handle` in this app runs main-process code on behalf of a
// renderer. Two of those channels chain into arbitrary local code execution:
//
//   settings:set-binary-path  →  settings.serverBinPath = "C:\evil.exe"
//   llama:launch              →  resolveBinary() returns it → spawn(...)
//
// No dialog, no consent, no user interaction. That is the blast radius this
// module exists to bound, and it is why the check FAILS CLOSED — an unset
// trusted window rejects rather than waves through.
//
// Handlers register through `handle()` here instead of `ipcMain.handle`
// directly. scripts/test-ipc-guard.mjs fails the build if any module goes back
// to the raw call, because a wrapper every handler *remembers* to use is a
// convention, not an invariant.
//
// WHY THE URL CHECK IS NOT REDUNDANT WITH THE IDENTITY CHECK. This is the
// detail implementations of this pattern usually get wrong.
// `webContents.mainFrame` still resolves to the current main frame AFTER a
// cross-origin navigation — so `event.sender === trustedWebContents` and
// `event.senderFrame === event.sender.mainFrame` both still pass for a window
// that has been navigated somewhere hostile. Only the frame's URL pins the
// origin. (Navigation containment in index.mjs is the other half of this: it
// stops the navigation, this stops the call if one ever happens anyway.)
//
// Electron 33 note: `WebFrameMain.origin` postdates this version, and would be
// the wrong test anyway — every file:// URL's origin is the string "null". We
// read `.url` and compare in renderer-location.mjs.
// =============================================================================

import { ipcMain } from 'electron'
import { logEvent } from '../logger.mjs'
import { isTrustedRendererUrl } from '../renderer-location.mjs'

let trustedWebContents = null

/**
 * Pin the one window allowed to make IPC calls. Called from createWindow()
 * before the first load. Passing null (or nothing) un-pins it, which returns
 * the guard to its fail-closed state.
 */
export function setTrustedWindow(win) {
  trustedWebContents = win?.webContents ?? null
}

/**
 * @returns {string|null} the reason to refuse, or null if the sender is trusted.
 */
export function senderRejectionReason(event) {
  // Fail closed. An unset trusted window means startup has not reached
  // createWindow() — there is no legitimate caller yet.
  if (!trustedWebContents) return 'no trusted window is registered'
  if (!event || event.sender !== trustedWebContents) return 'sender is not the launcher window'

  // Both of these throw (not return null) once the underlying frame or
  // webContents has been destroyed, which is a real race on window teardown.
  let frame
  let mainFrame
  try {
    frame = event.senderFrame
    mainFrame = event.sender.mainFrame
  } catch {
    return 'sender frame has been destroyed'
  }

  // Null senderFrame means the frame is already gone. It is NOT "no frame,
  // therefore nothing to check".
  if (!frame) return 'sender frame is gone'
  if (frame !== mainFrame) return 'sender is a subframe'

  let url
  try {
    url = frame.url
  } catch {
    return 'sender frame has been destroyed'
  }
  if (!isTrustedRendererUrl(url)) return 'sender frame is not at the launcher location'

  return null
}

/**
 * Drop-in replacement for `ipcMain.handle` that validates the sender first.
 *
 * The wrapper owns `event`, so handler bodies and their `(_, arg)` signatures
 * are unchanged — every call site is a mechanical rename.
 */
export function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    const reason = senderRejectionReason(event)
    if (reason) {
      // Never a silent reject: a refused call and a broken handler look
      // identical from the renderer, and triage needs to tell them apart.
      logEvent('security', 'ipc_sender_rejected', { channel, reason })
      throw new Error(`Refused ${channel}: ${reason}`)
    }
    return fn(event, ...args)
  })
}

/**
 * Bind a whole handler table to ipcMain.
 *
 * The table's functions take their arguments directly — no leading `event` —
 * because the other consumer of the same table is an HTTP route, which has no
 * event to pass. The `(event, ...args)` shape stops at this line, which is where
 * it belongs: `event` exists to be checked, and it is checked here.
 *
 * See ipc/transport.mjs for why the table is the source and both transports are
 * readers, rather than the HTTP surface being derived from what IPC registered.
 */
export function registerAll(handlers) {
  for (const [channel, fn] of Object.entries(handlers)) {
    handle(channel, (_event, ...args) => fn(...args))
  }
}
