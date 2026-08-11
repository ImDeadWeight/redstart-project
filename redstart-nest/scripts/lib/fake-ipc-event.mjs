// =============================================================================
// Fake webContents / frames / IpcMainInvokeEvents for the IPC suites.
// =============================================================================
// electron/main/ipc/guard.mjs validates an incoming call by identity
// (`event.sender`, `event.senderFrame`, `sender.mainFrame`) and by the frame's
// URL. All four are plain property reads, so a handler can be driven under the
// electron stub with ordinary objects — which is what lets
// scripts/test-ipc-guard.mjs forge the hostile cases rather than only assert
// the happy path.
//
// Shared by test-ipc-contract.mjs (which needs a legitimate event to reach the
// handlers it pins) and test-ipc-guard.mjs (which needs both).
//
// The URL is the dev one because scripts/electron-stub.mjs reports
// `app.isPackaged === false`; renderer-location.mjs takes its dev branch and
// compares against http://localhost:5173.
// =============================================================================

export const LAUNCHER_URL = 'http://localhost:5173/'

/**
 * A stand-in for the launcher BrowserWindow.
 * @param {string} [url] the URL the main frame reports sitting at
 */
export function makeFakeWindow(url = LAUNCHER_URL) {
  const mainFrame = { url }
  const webContents = { mainFrame }
  return { win: { webContents }, webContents, mainFrame }
}

/** An IpcMainInvokeEvent-shaped object. */
export function makeEvent(webContents, senderFrame) {
  return { sender: webContents, senderFrame }
}

/** The event a real call from `fake` would produce. */
export function trustedEventFor(fake) {
  return makeEvent(fake.webContents, fake.mainFrame)
}
