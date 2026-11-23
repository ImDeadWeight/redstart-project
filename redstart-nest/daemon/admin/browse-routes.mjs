'use strict'

// =============================================================================
// Redstart Nest — server-side directory browser
// =============================================================================
// The native `dialog.showOpenDialog` pickers browse the CLIENT's disk —
// correct while Electron and the daemon share a box, wrong the moment a
// browser or a remote launcher is the caller. These three methods are the
// daemon-side replacement: a directory listing exposed as ordinary
// control-plane methods, on the regular admin API table, so they inherit the
// listener's owner-only gate rather than growing one of their own
// (api-routes.mjs's "THE GATE IS NOT HERE").
//
// SCOPING: NO SCOPE, deliberately. `path-scope.mjs` answers "is this path
// inside that configured root", which is the wrong question for a picker
// whose whole job is choosing a root — there is nothing to be inside of yet.
// The caller is always the Owner (the listener's gate), who can already set
// `settings.serverBinPath` to any path and have it SPAWNED (validate.mjs calls
// that "the head of the escalation chain") — a directory listing grants
// strictly less than what the Owner already holds. Revisit once the daemon
// can run as a dedicated service account, where the daemon's own filesystem
// reach is narrowed by the OS and the question changes shape.
//
// Whichever way that is decided, two rules hold regardless and are enforced
// below: `browse:list` never returns anything but names, kind, access flags and
// size/date metadata (never file contents, never a symlink's target path —
// see SIZE AND DATE at listDirectory()), and it never lists what a symlink
// points to — see the comment at listDirectory() for why that falls out of
// `withFileTypes` for free rather than needing a check.
// =============================================================================

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// --- roots (the picker's sidebar) ---------------------------------------
//
// Not just "where can browsing start" any more: the picker's sidebar of
// places. Each root is { path, label, group, kind } plus, for a drive, `free`
// and `total` bytes. Groups, in the order returned:
//   'library' — model folders other tools keep (Hugging Face cache, LM
//               Studio), listed only when they exist. Both live in hidden
//               folders the listing never shows, so without this they were
//               reachable only by pasting a path.
//   'quick'   — Home, Desktop, Documents, Downloads.
//   'drive'   — drive letters on Windows; on macOS the startup disk plus
//               each volume under /Volumes; on Linux `/` plus /media, /mnt.
//
// ONLY EXISTENCE IS CHECKED, never contents. That matters on macOS: reading
// inside Desktop, Documents or Downloads is what triggers the privacy (TCC)
// prompt, and a sidebar that asked for three folders before the admin had
// clicked anything would be a sidebar of permission dialogs. A stat of the
// folder itself does not.

function isDir(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

// statfs on a drive that is gone (a pulled USB stick, a dropped share) throws,
// which simply leaves the numbers off.
function spaceOf(p) {
  try {
    const s = fs.statfsSync(p)
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }
  } catch {
    return {}
  }
}

// Windows redirects Desktop and Documents into OneDrive when backup is on;
// look there too before deciding the folder is not there.
function knownFolder(home, name) {
  const direct = path.join(home, name)
  if (isDir(direct)) return direct
  if (process.platform === 'win32') {
    for (const od of [process.env.OneDrive, process.env.OneDriveConsumer, path.join(home, 'OneDrive')]) {
      if (od && isDir(path.join(od, name))) return path.join(od, name)
    }
  }
  return null
}

function quickRoots(home) {
  if (!home || !isDir(home)) return []
  const roots = [{ path: home, label: 'Home', group: 'quick', kind: 'home' }]
  for (const name of ['Desktop', 'Documents', 'Downloads']) {
    const p = knownFolder(home, name)
    if (p) roots.push({ path: p, label: name, group: 'quick', kind: 'folder' })
  }
  return roots
}

// HF_HUB_CACHE, then HF_HOME/hub, then the default — the order huggingface_hub
// itself resolves them. LM Studio moved its folder once; both are checked.
function libraryRoots(home) {
  const roots = []
  const hf = process.env.HF_HUB_CACHE
    || (process.env.HF_HOME ? path.join(process.env.HF_HOME, 'hub') : home && path.join(home, '.cache', 'huggingface', 'hub'))
  if (hf && isDir(hf)) roots.push({ path: hf, label: 'Hugging Face cache', group: 'library', kind: 'library' })
  if (home) {
    const lms = [path.join(home, '.lmstudio', 'models'), path.join(home, '.cache', 'lm-studio', 'models')].find(isDir)
    if (lms) roots.push({ path: lms, label: 'LM Studio', group: 'library', kind: 'library' })
  }
  return roots
}

// Windows has no single filesystem root — drive letters are enumerated. No
// native dependency needed (rule 1): a bare existence check on each of the 26
// possible roots is cheap and exact.
function windowsDrives() {
  const roots = []
  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
    const drive = `${String.fromCharCode(code)}:\\`
    if (fs.existsSync(drive)) roots.push({ path: drive, label: `${drive.slice(0, 2)} drive`, group: 'drive', kind: 'drive', ...spaceOf(drive) })
  }
  return roots
}

// /Volumes holds one entry per mounted volume, and the startup disk appears
// there as a symlink back to `/`. That symlink is how the startup disk gets
// its real name ("Macintosh HD") rather than a bare "/"; it is then skipped so
// the same disk is not listed twice. Other symlinks are skipped too — a
// volume is a mount point, which is a real directory.
//
// The two folders are parameters only so scripts/test-browse-routes.mjs can
// exercise this on a machine that is not a Mac; the daemon calls it bare.
export function macDrives(volumesDir = '/Volumes', bootRoot = '/') {
  let bootName = 'Startup disk'
  const volumes = []
  const realBoot = (() => { try { return fs.realpathSync(bootRoot) } catch { return bootRoot } })()
  try {
    for (const d of fs.readdirSync(volumesDir, { withFileTypes: true })) {
      if (d.name.startsWith('.')) continue
      const full = path.join(volumesDir, d.name)
      if (d.isSymbolicLink()) {
        try { if (fs.realpathSync(full) === realBoot) bootName = d.name } catch {}
        continue
      }
      if (d.isDirectory()) volumes.push({ path: full, label: d.name, group: 'drive', kind: 'drive', ...spaceOf(full) })
    }
  } catch {}
  return [{ path: bootRoot, label: bootName, group: 'drive', kind: 'drive', ...spaceOf(bootRoot) }, ...volumes]
}

// Where desktop Linux mounts removable media: /media/<user>/<label> (udisks),
// or /media/<label> and /mnt/<label> by hand.
function linuxDrives() {
  const roots = [{ path: '/', label: 'Computer', group: 'drive', kind: 'drive', ...spaceOf('/') }]
  const user = os.userInfo().username
  for (const dir of [path.join('/media', user), '/media', '/mnt']) {
    let dirents = []
    try { dirents = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const d of dirents) {
      const full = path.join(dir, d.name)
      if (!d.isDirectory() || d.name.startsWith('.') || full === path.join('/media', user)) continue
      if (roots.some(r => r.path === full)) continue
      roots.push({ path: full, label: d.name, group: 'drive', kind: 'drive', ...spaceOf(full) })
    }
  }
  return roots
}

export function browseRoots() {
  const home = os.homedir()
  const drives = process.platform === 'win32' ? windowsDrives()
    : process.platform === 'darwin' ? macDrives()
      : linuxDrives()
  return [...libraryRoots(home), ...quickRoots(home), ...drives]
}

// --- list ----------------------------------------------------------------

// A directory one level "above" a root (a drive letter, or POSIX `/`) is not a
// place this browser goes — there is nothing to browse to. path.dirname('/')
// and path.dirname('C:\\') both return their own argument unchanged, which is
// the signal used here rather than a hand-maintained root list.
function parentOf(target) {
  const parent = path.dirname(target)
  return parent === target ? null : parent
}

/**
 * List the directories inside `target`. Never throws — an unreadable path is
 * a completely normal thing for an admin to click on (a permissions-denied
 * folder, a disconnected network share), so it resolves to an empty listing
 * with a `reason` instead.
 *
 * SYMLINKS: `fs.readdirSync(..., { withFileTypes: true })` reports the type
 * of the DIRECTORY ENTRY itself, not of whatever it resolves to — a symlink's
 * Dirent.isDirectory() is false even when it points at a directory. So a
 * symlink is excluded by the same `isDirectory()` check that picks out real
 * subdirectories, with no separate symlink check needed: this listing never
 * follows one out of `target`, by construction rather than by a guard that
 * could be forgotten.
 */
/**
 * FILES (opt-in). With `opts.extensions` (e.g. ['gguf']) the listing also
 * returns matching FILES as `kind: 'file'` entries, so a file picker can show
 * the .gguf it is looking for instead of making the admin type its name. Same
 * shape as a directory entry: a name, access flags, `modified`, and for a file
 * its `size` — never contents, never a symlink target. Without `extensions`
 * the listing is directories-only, exactly as before.
 *
 * `opts.allFiles` (with `extensions`) lists every file, each carrying
 * `match: true|false`, so the picker's "Only .gguf files" switch can be turned
 * off to see what else is in a folder. A non-matching file is shown, never
 * selectable.
 *
 * `opts.showHidden` includes dot-prefixed entries (~/.cache, ~/.lmstudio).
 * Off by default, as before.
 *
 * SIZE AND DATE. A file's size in bytes and an entry's modification time (ms)
 * are metadata, not contents: the Owner sees them in any file manager on the
 * same machine, and a 7 GB quant versus a 2 GB one is exactly what an admin
 * choosing a model needs to see. A symlinked file reports its TARGET's size
 * (stat follows the link) and still never the target's path. A folder gets no
 * item count: counting means reading inside every subfolder, which on macOS
 * is a privacy prompt per protected folder before anything was clicked.
 *
 * A symlink IS listed when it resolves to a matching regular file. That is a
 * deliberate exception to the directory rule above: the Hugging Face cache
 * (and tools that share it, like LM Studio's imports) stores every model as a
 * symlink into a blobs folder, so skipping symlinked files made those models
 * impossible to pick. A file is a leaf — listing its NAME cannot walk the
 * browser out of `target`, which is the thing the directory rule exists to
 * prevent — and its target path is still never returned.
 *
 * 'exe' is the one platform-dependent extension: on Windows it matches .exe;
 * elsewhere executables have no extension, so it matches any file with an
 * execute bit (what llama-server is on macOS and Linux).
 */
function isFileEntry(fullPath, dirent) {
  if (dirent.isFile()) return true
  if (!dirent.isSymbolicLink()) return false
  try { return fs.statSync(fullPath).isFile() } catch { return false }
}

function matchesExtension(fullPath, name, extensions) {
  const lower = name.toLowerCase()
  return extensions.some(ext => {
    if (ext === 'exe' && process.platform !== 'win32') {
      return !lower.includes('.') && canAccess(fullPath, fs.constants.X_OK)
    }
    return lower.endsWith(`.${ext}`)
  })
}

function normalizeExtensions(extensions) {
  if (!Array.isArray(extensions)) return null
  const clean = extensions
    .filter(e => typeof e === 'string')
    .map(e => e.trim().replace(/^\./, '').toLowerCase())
    .filter(e => e && /^[a-z0-9]+$/.test(e))
  return clean.length ? clean : null
}

// macOS privacy protection (TCC) guards Desktop, Documents, Downloads,
// iCloud Drive and removable volumes per app. A denial arrives as EPERM even
// though access() still says readable, so the raw code meant nothing to the
// person looking at it — say what it is and where to fix it.
function reasonFor(err) {
  if (process.platform === 'darwin' && err.code === 'EPERM') {
    return 'macOS blocked access to this folder. Allow Redstart in System Settings → Privacy & Security → Files and Folders (or Full Disk Access), then try again.'
  }
  return err.code || err.message
}

export function listDirectory(targetPath, opts = {}) {
  if (typeof targetPath !== 'string' || !targetPath) {
    return { path: targetPath ?? '', parent: null, entries: [], reason: 'No path given' }
  }
  const extensions = normalizeExtensions(opts?.extensions)

  let dirents
  try {
    dirents = fs.readdirSync(targetPath, { withFileTypes: true })
  } catch (err) {
    // The access flags belong on THIS path too, and leaving them off was a real
    // bug: an unreadable directory is exactly the case this route exists to
    // report, and it is the one branch that was answering `undefined` instead
    // of `false`. FolderPicker only warns on `readable === false` and only
    // blocks selection on the same test, so an admin on a box where this fires
    // — a service account pointed at a share it was never granted — got no
    // warning and could select the folder anyway, which is precisely the
    // "accepted at selection, fails later inside a tool call" outcome this
    // route exists to prevent.
    return {
      path: targetPath,
      parent: parentOf(targetPath),
      entries: [],
      reason: reasonFor(err),
      ...accessOf(targetPath),
      // A listing that just failed with a permission error is unreadable,
      // whatever access() claims (macOS TCC answers R_OK yes, readdir no).
      ...(err.code === 'EPERM' || err.code === 'EACCES' ? { readable: false } : {}),
    }
  }

  const visible = d => opts?.showHidden === true || !d.name.startsWith('.') // hidden entries excluded by default
  const entries = dirents
    .filter(d => d.isDirectory() && visible(d))
    .map(d => {
      const full = path.join(targetPath, d.name)
      return { name: d.name, kind: 'directory', ...accessOf(full), ...statOf(full, false) }
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  if (extensions) {
    const allFiles = opts?.allFiles === true
    const files = []
    for (const d of dirents) {
      if (!visible(d)) continue
      const full = path.join(targetPath, d.name)
      if (!isFileEntry(full, d)) continue
      const match = matchesExtension(full, d.name, extensions)
      if (!match && !allFiles) continue
      files.push({ name: d.name, kind: 'file', ...accessOf(full), ...statOf(full, true), ...(allFiles ? { match } : {}) })
    }
    files.sort((a, b) => a.name.localeCompare(b.name))
    entries.push(...files)
  }

  return { path: targetPath, parent: parentOf(targetPath), entries, ...accessOf(targetPath) }
}

/**
 * Can this daemon actually USE this folder?
 *
 * The one hard requirement about tool folders: the picker must report an
 * unreadable folder as unreadable AT SELECTION TIME, rather than accepting
 * the path and failing later inside a tool call - where the error reaches
 * the user as a confused model rather than as a permissions problem. That is
 * the failure this exists to prevent; it is not about hiding folders.
 *
 * Only bites at level 3, where an unprivileged service account is pointed at
 * a mounted share or an existing repository it was never granted. At level 2
 * the daemon is the logged-in user and this is true of everything they can
 * see, so it simply never fires - which is why it costs nothing to have now.
 *
 * BEST-EFFORT, AND SAYING SO MATTERS. access() answers for the calling
 * process at this instant; a share can drop, a grant can change, and on
 * Windows W_OK reflects the read-only attribute rather than the ACL that
 * actually decides. So a `true` here is not a promise - the operation itself
 * stays authoritative. What it reliably catches is the case that matters: a
 * definite NO, surfaced while the admin is still looking at the picker.
 *
 * Read and write are reported separately rather than collapsed. Most
 * capability roots are written to (Documents, SQLite, Vault, the models
 * folder), but a read-only mount is a legitimate thing to point the File
 * System or Git capability at, so "not writable" is information for the UI
 * to warn with, not grounds for the daemon to refuse.
 */
// `modified` for every entry, `size` for a file only (see the SIZE AND DATE
// note above listDirectory). A stat that fails leaves them off rather than
// dropping the entry: the name is still worth showing.
function statOf(target, withSize) {
  try {
    const s = fs.statSync(target)
    return { modified: Math.round(s.mtimeMs), ...(withSize ? { size: s.size } : {}) }
  } catch {
    return {}
  }
}

function accessOf(target) {
  return { readable: canAccess(target, fs.constants.R_OK), writable: canAccess(target, fs.constants.W_OK) }
}

function canAccess(target, mode) {
  try {
    fs.accessSync(target, mode)
    return true
  } catch {
    return false
  }
}

// --- mkdir -----------------------------------------------------------------

// Documents and SQLite pass `createDirectory: true` to the native dialog
// (New Folder); a browser has no equivalent affordance, so this stands in for
// it. Scoped to "one new folder directly under an existing, already-browsed
// path" — a bare name, never a path — which is enough for that affordance and
// nothing more.
function mkdirNameRejection(name) {
  if (typeof name !== 'string' || !name.trim()) return 'A folder name is required.'
  if (name === '.' || name === '..') return 'Not a valid folder name.'
  if (name.includes('/') || name.includes('\\')) return 'A folder name cannot contain a path separator.'
  if (name.includes('\0')) return 'A folder name contains an invalid character.'
  return null
}

export function browseMkdir({ path: parentPath, name }) {
  if (typeof parentPath !== 'string' || !parentPath) return { ok: false, error: 'A path is required.' }
  const rejection = mkdirNameRejection(name)
  if (rejection) return { ok: false, error: rejection }

  const target = path.join(parentPath, name)
  try {
    fs.mkdirSync(target)
  } catch (err) {
    return { ok: false, error: err.code === 'EEXIST' ? 'That folder already exists.' : (err.message || 'Could not create the folder') }
  }
  return { ok: true, path: target }
}

// --- table -----------------------------------------------------------------

export function browseRouteHandlers() {
  return {
    'browse:roots': () => browseRoots(),
    'browse:list': (opts) => listDirectory(opts?.path, {
      extensions: opts?.extensions, allFiles: opts?.allFiles, showHidden: opts?.showHidden,
    }),
    'browse:mkdir': (opts) => browseMkdir(opts ?? {}),
  }
}
