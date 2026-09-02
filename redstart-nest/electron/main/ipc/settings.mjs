// Settings IPC namespace — server binary path and models folder.
//
// readSettings/writeSettings/resolveBinary still live in index.mjs and are
// threaded in via deps.
//
// The models folder is a launcher-level path like serverBinPath — it belongs in
// settings.json, NOT in tools.json's capabilities block, because it is not a
// model-facing capability root and nothing in the MCP layer reads it.
//
// Handler bodies are exported as plain functions (Phase 1, §1.3 of the
// headless-admin-plane implementation plan) so an HTTP route can call them
// directly without dragging IPC registration in — importing this module never
// registers anything; only registerSettingsHandlers() does that. The two
// dialog.showOpenDialog handlers that used to live here moved to a native
// picker (Phase 4 §4.3), itself retired in Phase 6 §6.1.
import { registerAll } from './guard.mjs'
import { binaryPathRejection, isAbsolutePath } from './validate.mjs'
import { logEvent } from '../logger.mjs'

export function getBinaryPath({ readSettings }) {
  const s = readSettings()
  return s.serverBinPath || null
}

// The single most consequential value in settings.json: resolveBinary()
// returns it and ipc/server.mjs spawns it. A falsy argument still means
// "clear it and fall back to the bundled binary" — that is the Reset button —
// but anything else must look like a server binary that actually exists. The
// only legitimate source is the picker below, which cannot produce a value
// that fails these checks.
export function setBinaryPath(p, { readSettings, writeSettings }) {
  const s = readSettings()
  if (p) {
    const rejection = binaryPathRejection(p)
    if (rejection) {
      logEvent('security', 'ipc_argument_rejected', { channel: 'settings:set-binary-path', reason: rejection })
      return false
    }
    s.serverBinPath = p
  } else {
    delete s.serverBinPath
  }
  writeSettings(s)
  return true
}

// selectBinary() retired — Phase 4 §4.3 replaced it with a native picker,
// itself retired in Phase 6 §6.1. FolderPicker.tsx now calls
// admin/browse-routes.mjs's browse:list, the same as every other folder/file
// prompt in the launcher. The one thing lost along the way was the dev-build
// default path (selectBinaryDefaultPath, computed from __dirname in
// index.mjs) — the renderer has no equivalent to hand back, so the picker
// opens with no default rather than pointing at
// llama-cpp-turboquant/build/bin/Release. Documented as a deliberate,
// accepted regression rather than silently dropped.

export function getResolvedBinary({ resolveBinary }) {
  return resolveBinary()
}

// --- Models folder ---
//
// Always returns a usable path: the user's choice if set, otherwise the
// provisioned <Documents>\Redstart\Models default. Callers never have to
// handle null, which is what keeps the picker's defaultPath and the
// downloader's root from diverging.

export function getModelsDir({ resolveModelsDir }) {
  return resolveModelsDir()
}

// Same shape of check as the binary path, one condition lighter: the folder
// is a containment root for downloads, so it must be an absolute path, but it
// does not have to exist yet — ensureModelsDir() creates it. On a rejection we
// return the folder that IS in effect rather than the one that was refused, so
// the UI never shows a setting that did not take.
export function setModelsDir(p, { readSettings, writeSettings, resolveModelsDir }) {
  const s = readSettings()
  if (p) {
    if (!isAbsolutePath(p)) {
      logEvent('security', 'ipc_argument_rejected', {
        channel: 'settings:set-models-dir', reason: 'not an absolute path',
      })
      return resolveModelsDir()
    }
    s.modelsDir = p
  } else {
    delete s.modelsDir // fall back to the provisioned default
  }
  writeSettings(s)
  return resolveModelsDir()
}

// selectModelsDir() retired the same way — see the note above selectBinary().
// Its default (resolveModelsDir()) is not lost: the renderer already has it
// via settings:get-models-dir and passes it through as FolderPicker's
// `defaultPath`.

export function settingsHandlers(deps) {
  return {
    'settings:get-binary-path': () => getBinaryPath(deps),
    'settings:set-binary-path': (p) => setBinaryPath(p, deps),
    'settings:get-resolved-binary': () => getResolvedBinary(deps),

    'settings:get-models-dir': () => getModelsDir(deps),
    'settings:set-models-dir': (p) => setModelsDir(p, deps),
  }
}

export function registerSettingsHandlers(deps) {
  registerAll(settingsHandlers(deps))
}
