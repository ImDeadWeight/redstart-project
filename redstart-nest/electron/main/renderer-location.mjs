'use strict'

// =============================================================================
// Redstart Nest — where the launcher renderer is allowed to be
// =============================================================================
// One answer to "is this page the launcher UI?", shared by the two controls
// that need it:
//
//   - navigation containment (index.mjs) — refuses to take the window anywhere
//     else, because a preload script re-runs on EVERY navigation within a
//     webContents, so a navigated window inherits the whole `window.redstartAPI`
//     surface
//   - the IPC sender guard (ipc/guard.mjs) — refuses a call whose frame is not
//     sitting at this location
//
// Both must agree, and they must agree with what createWindow() actually loads;
// three independent copies of "http://localhost:5173" is how that stops being
// true. createWindow() loads from here too.
//
// THE file:// FOOTGUN. `new URL('file:///E:/…/dist/index.html').origin` is the
// string "null", and so is every other file:// URL's. An origin allowlist would
// therefore accept any local HTML file at all in a packaged build — including
// one an attacker dropped on disk. So the packaged branch compares the resolved
// PATH, and only the dev branch compares an origin.
// =============================================================================

import { app } from 'electron'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Vite's dev server. Matches the URL createWindow() loads when unpackaged. */
export const DEV_RENDERER_ORIGIN = 'http://localhost:5173'

/** The built renderer entry point, at electron-builder's `dist/index.html`. */
export function rendererIndexFile() {
  return path.join(__dirname, '..', '..', 'dist', 'index.html')
}

// Windows paths are case-insensitive, and this app is Windows-only — comparing
// case-sensitively would reject a perfectly legitimate `C:\` vs `c:\`.
function samePath(a, b) {
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))
  return norm(a) === norm(b)
}

/**
 * Is `candidate` the launcher UI itself?
 *
 * Fails closed: anything unparseable, non-string, or merely adjacent (another
 * file in dist/, another port on localhost) is not trusted.
 *
 * @param {unknown} candidate a URL string, e.g. a WebFrameMain's `.url`
 * @returns {boolean}
 */
export function isTrustedRendererUrl(candidate) {
  if (typeof candidate !== 'string' || !candidate) return false

  let parsed
  try {
    parsed = new URL(candidate)
  } catch {
    return false
  }

  if (app.isPackaged) {
    if (parsed.protocol !== 'file:') return false
    try {
      return samePath(fileURLToPath(parsed), rendererIndexFile())
    } catch {
      return false
    }
  }

  // Dev: Vite's origin. `origin` is exact here (scheme + host + port), unlike
  // in the file:// case above.
  return parsed.origin === DEV_RENDERER_ORIGIN
}
