'use strict'

// =============================================================================
// Redstart Nest — server-side directory browser (Phase 4, §4.2)
// =============================================================================
// The native `dialog.showOpenDialog` pickers browse the CLIENT's disk (trap
// 5.2, headless-admin-plane-plan.md §5) — correct while Electron and the
// daemon share a box, wrong the moment a browser or a remote launcher is the
// caller. These three methods are the daemon-side replacement: a directory
// listing exposed as ordinary control-plane methods, on the regular admin API
// table, so they inherit the listener's owner-only gate rather than growing
// one of their own (api-routes.mjs's "THE GATE IS NOT HERE").
//
// SCOPING — the open question the implementation plan left genuinely open,
// closed here as (a): NO SCOPE. `path-scope.mjs` answers "is this path inside
// that configured root", which is the wrong question for a picker whose whole
// job is choosing a root — there is nothing to be inside of yet. The caller is
// always the Owner (the listener's gate), who can already set
// `settings.serverBinPath` to any path and have it SPAWNED (validate.mjs calls
// that "the head of the escalation chain") — a directory listing grants
// strictly less than what the Owner already holds. Revisit at level 3 (the
// service account, headless-admin-plane-plan.md §3.5), where the daemon's own
// filesystem reach is narrowed by the OS and the question changes shape.
//
// Whichever way that is decided, two rules hold regardless and are enforced
// below: `browse:list` never returns anything but names and kind (never file
// contents, never a symlink's target path), and it never lists what a symlink
// points to — see the comment at listDirectory() for why that falls out of
// `withFileTypes` for free rather than needing a check.
// =============================================================================

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// --- roots -------------------------------------------------------------

// Windows has no single filesystem root — "where do I start browsing from" is
// answered by enumerating drive letters. No native dependency needed (rule 1):
// a bare existence check on each of the 26 possible roots is cheap and exact.
function windowsRoots() {
  const roots = []
  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
    const letter = String.fromCharCode(code)
    const drive = `${letter}:\\`
    if (fs.existsSync(drive)) roots.push({ path: drive, label: drive })
  }
  return roots
}

function posixRoots() {
  const roots = [{ path: '/', label: '/' }]
  const home = os.homedir()
  if (home && home !== '/') roots.push({ path: home, label: `${home} (home)` })
  return roots
}

export function browseRoots() {
  return process.platform === 'win32' ? windowsRoots() : posixRoots()
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
export function listDirectory(targetPath) {
  if (typeof targetPath !== 'string' || !targetPath) {
    return { path: targetPath ?? '', parent: null, entries: [], reason: 'No path given' }
  }

  let dirents
  try {
    dirents = fs.readdirSync(targetPath, { withFileTypes: true })
  } catch (err) {
    // The access flags belong on THIS path too, and leaving them off was a real
    // bug: an unreadable directory is the exact case Phase 8B.6 exists to
    // report, and it is the one branch that was answering `undefined` instead
    // of `false`. FolderPicker only warns on `readable === false` and only
    // blocks selection on the same test, so an admin on a box where this fires
    // — a level-3 service account pointed at a share it was never granted — got
    // no warning and could select the folder anyway, which is precisely the
    // "accepted at selection, fails later inside a tool call" outcome the
    // feature was built to prevent.
    return {
      path: targetPath,
      parent: parentOf(targetPath),
      entries: [],
      reason: err.code || err.message,
      ...accessOf(targetPath),
    }
  }

  const entries = dirents
    .filter(d => d.isDirectory() && !d.name.startsWith('.')) // hidden entries excluded
    .map(d => ({ name: d.name, kind: 'directory', ...accessOf(path.join(targetPath, d.name)) }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return { path: targetPath, parent: parentOf(targetPath), entries, ...accessOf(targetPath) }
}

/**
 * Phase 8B.6 - can this daemon actually USE this folder?
 *
 * Design section 3.5's one hard requirement about tool folders: the picker
 * must report an unreadable folder as unreadable AT SELECTION TIME, rather
 * than accepting the path and failing later inside a tool call - where the
 * error reaches the user as a confused model rather than as a permissions
 * problem. That is the failure this exists to prevent; it is not about
 * hiding folders.
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
    'browse:list': (opts) => listDirectory(opts?.path),
    'browse:mkdir': (opts) => browseMkdir(opts ?? {}),
  }
}
