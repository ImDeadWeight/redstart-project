// Browse IPC namespace — the ONE native file/folder dialog, generic over the
// nine call sites that used to each carry their own dialog.showOpenDialog.
//
// Phase 4 (§4.3 of the headless-admin-plane implementation plan) replaces
// hardware:select-model, settings:select-binary, settings:select-models-dir,
// capabilities:select-{documents,sqlite,vault,git,file-system}-folder and
// plugins:pick-folder with this single channel plus FolderPicker.tsx, which
// calls it when isDaemonLocal() and admin/browse-routes.mjs's browse:list
// otherwise — so no call site branches on transport, and there is exactly one
// place left where a dialog opens on the machine the daemon happens to be
// running on (trap 5.2 — never the caller's machine, which is what the old
// per-site channels could not tell apart from a browser).
//
// A DEFAULT PATH THE RENDERER CANNOT KNOW: the binary picker used to default
// into the dev build's own `llama-cpp-turboquant/build/bin/Release` folder,
// computed from `__dirname` in the main process (index.mjs's
// selectBinaryDefaultPath). The renderer has no equivalent to hand back here —
// it is a main-process-only path — so that one convenience default is gone
// with the consolidation. Every other former default (the models dir, a
// capability's current root) is already something a hook reads over the API
// and can pass through as `defaultPath` explicitly.
//
// Handler bodies are exported as plain functions (Phase 1, §1.3), same shape
// as every other ipc/*.mjs module.
import { dialog } from 'electron'
import { registerAll } from './guard.mjs'
import { localOnly } from './transport.mjs'

/**
 * @param {object} opts
 * @param {'file'|'directory'} opts.mode
 * @param {string} [opts.title]
 * @param {string[]} [opts.extensions] file mode only, e.g. ['gguf']
 * @param {string} [opts.extensionLabel] filter label, e.g. 'GGUF Models'
 * @param {string} [opts.defaultPath]
 * @param {boolean} [opts.allowCreate] directory mode only — offers *New Folder*
 */
export async function pickNative(opts) {
  const { mode, title, extensions, extensionLabel, defaultPath, allowCreate } = opts ?? {}

  if (mode === 'file') {
    const filters = extensions?.length
      ? [{ name: extensionLabel || 'Files', extensions }, { name: 'All Files', extensions: ['*'] }]
      : undefined
    const result = await dialog.showOpenDialog({
      title, properties: ['openFile'], filters, defaultPath: defaultPath || undefined,
    })
    return result.canceled ? null : result.filePaths[0]
  }

  const properties = ['openDirectory']
  if (allowCreate) properties.push('createDirectory')
  const result = await dialog.showOpenDialog({ title, properties, defaultPath: defaultPath || undefined })
  return result.canceled ? null : result.filePaths[0]
}

export function browseHandlers() {
  return {
    // Browses whichever machine is running this process. Always local-only —
    // this IS the local-picker mechanism, not a stand-in awaiting one.
    'browse:pick-native': localOnly(async (opts) => pickNative(opts)),
  }
}

export function registerBrowseHandlers() {
  registerAll(browseHandlers())
}
