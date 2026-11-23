// =============================================================================
// Unit tests for daemon/admin/browse-routes.mjs — the server-side
// directory browser that replaces the native pickers over HTTP (Phase 4 §4.2).
// =============================================================================
// Pure Node, no Electron dependency (browse-routes.mjs imports only fs/os/path).
// Same tiny harness style as scripts/test-path-scope.mjs.
//
// Run:  node scripts/test-browse-routes.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  browseRoots, listDirectory, browseMkdir, browseRouteHandlers, macDrives,
} from '../daemon/admin/browse-routes.mjs'
import { isLocalOnly } from '../daemon/ipc/transport.mjs'

// ---------------------------------------------------------------------------
// Harness (mirrors scripts/test-path-scope.mjs)
// ---------------------------------------------------------------------------

const results = []

async function test(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true, detail })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false, detail: err.message })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

// ---------------------------------------------------------------------------
// Fixture: root dir with subdirs, a file, a hidden dir, and (POSIX) a symlink
// pointing outside.
// ---------------------------------------------------------------------------

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-browse-'))
const root = path.join(base, 'root')
const outside = path.join(base, 'outside')
fs.mkdirSync(path.join(root, 'Alpha'), { recursive: true })
fs.mkdirSync(path.join(root, 'beta'), { recursive: true })
fs.mkdirSync(path.join(root, '.hidden'), { recursive: true })
fs.mkdirSync(outside, { recursive: true })
fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret contents')
fs.writeFileSync(path.join(root, 'a-file.txt'), 'not a directory')

let symlinkSupported = false
try {
  fs.symlinkSync(outside, path.join(root, 'escape-link'), 'dir')
  symlinkSupported = true
} catch {
  // Symlinks need elevation on some Windows configs — the assertion below is
  // skipped rather than failed when this environment cannot create one.
}

// ---------------------------------------------------------------------------
// browse:roots
// ---------------------------------------------------------------------------

console.log('\n--- browseRoots ---')

await test('returns at least one root, each with a path and a label', () => {
  const roots = browseRoots()
  assert(Array.isArray(roots) && roots.length > 0, 'expected at least one root')
  for (const r of roots) {
    assert(typeof r.path === 'string' && r.path, `root missing a path: ${JSON.stringify(r)}`)
    assert(typeof r.label === 'string' && r.label, `root missing a label: ${JSON.stringify(r)}`)
  }
  return `${roots.length} root(s)`
})

await test('roots come grouped: libraries, then quick folders, then drives', () => {
  const roots = browseRoots()
  const order = { library: 0, quick: 1, drive: 2 }
  for (const r of roots) assert(r.group in order, `unknown group on ${JSON.stringify(r)}`)
  for (let i = 1; i < roots.length; i++) {
    assert(order[roots[i - 1].group] <= order[roots[i].group], `out of order: ${roots[i - 1].label} before ${roots[i].label}`)
  }
  assert(roots.some(r => r.group === 'drive'), 'no drives')
  const home = roots.find(r => r.kind === 'home')
  assert(home && home.path === os.homedir(), `Home should be ${os.homedir()}, got ${home?.path}`)
  for (const r of roots) {
    assert(fs.statSync(r.path).isDirectory(), `${r.path} listed but not a directory`)
  }
})

await test('a drive answers with free and total bytes', () => {
  const drive = browseRoots().find(r => r.group === 'drive' && typeof r.total === 'number')
  assert(drive, 'no drive reported its size')
  assert(drive.free >= 0 && drive.free <= drive.total, `free ${drive.free} / total ${drive.total}`)
})

await test('HF_HUB_CACHE, when set to a real folder, appears as the Hugging Face library', () => {
  const hub = path.join(base, 'hf-hub')
  fs.mkdirSync(hub, { recursive: true })
  const before = process.env.HF_HUB_CACHE
  process.env.HF_HUB_CACHE = hub
  try {
    const lib = browseRoots().filter(r => r.group === 'library')
    assert(lib.some(r => r.path === hub && r.label === 'Hugging Face cache'), `got ${JSON.stringify(lib)}`)
    process.env.HF_HUB_CACHE = path.join(base, 'no-such-hub')
    assert(!browseRoots().some(r => r.path === process.env.HF_HUB_CACHE), 'a missing cache folder was listed')
  } finally {
    if (before === undefined) delete process.env.HF_HUB_CACHE
    else process.env.HF_HUB_CACHE = before
  }
})

// macOS's /Volumes, staged: the startup disk is a symlink back to `/` (here,
// a fake root), each other volume a real directory. Runs on every platform —
// directory junctions stand in for the symlink on Windows.
await test('macOS drives: the startup disk takes its /Volumes name and is not listed twice', () => {
  const fakeRoot = path.join(base, 'mac-root')
  const volumes = path.join(base, 'mac-volumes')
  fs.mkdirSync(fakeRoot, { recursive: true })
  fs.mkdirSync(path.join(volumes, 'USB Stick'), { recursive: true })
  fs.mkdirSync(path.join(volumes, '.timemachine'), { recursive: true })
  try {
    fs.symlinkSync(fakeRoot, path.join(volumes, 'Macintosh HD'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    return 'skipped — could not create a link in this environment'
  }
  const drives = macDrives(volumes, fakeRoot)
  assert(drives[0].path === fakeRoot && drives[0].label === 'Macintosh HD', `startup disk: ${JSON.stringify(drives[0])}`)
  const labels = drives.map(d => d.label)
  assert(labels.includes('USB Stick'), `volumes: ${labels.join(', ')}`)
  assert(labels.filter(l => l === 'Macintosh HD').length === 1, 'the startup disk was listed twice')
  assert(!labels.includes('.timemachine'), 'a hidden volume was listed')
  assert(drives.every(d => d.group === 'drive' && d.kind === 'drive'), 'a drive lacked its group/kind')
})

await test('macOS drives: no /Volumes still gives the startup disk', () => {
  const drives = macDrives(path.join(base, 'no-volumes-here'), path.join(base, 'mac-root'))
  assert(drives.length === 1 && drives[0].label === 'Startup disk', JSON.stringify(drives))
})

// ---------------------------------------------------------------------------
// browse:list
// ---------------------------------------------------------------------------

console.log('\n--- listDirectory ---')

await test('lists directories only, sorted, never file contents', () => {
  const result = listDirectory(root)
  assert(result.reason === undefined, `unexpected reason: ${result.reason}`)
  const names = result.entries.map(e => e.name)
  assert(!names.includes('a-file.txt'), 'a plain file was listed as browsable')
  assert(names.includes('Alpha') && names.includes('beta'), `expected Alpha and beta, got ${names.join(', ')}`)
  assert(result.entries.every(e => e.kind === 'directory'), 'a non-directory entry leaked through')
  // No key anywhere in the shape carries file content. Kept as an exact-set
  // check rather than loosened to a subset: the point is that a future field
  // has to come and change this line deliberately, which is what would make
  // someone notice they were about to add `size` or a symlink `target`.
  //
  // Phase 8B.6 added `readable`/`writable`, and this is that deliberate
  // change. They are booleans about ACCESS, not about content — the
  // invariant this line guards (never file contents, never a symlink's
  // target) is untouched.
  //
  // The file-explorer pass (2026-11-23) added `modified`, and this is that
  // deliberate change too: a timestamp is metadata, not content. A folder
  // gets no size (and no item count — see SIZE AND DATE in browse-routes).
  assert(
    result.entries.every(e => Object.keys(e).sort().join(',') === 'kind,modified,name,readable,writable'),
    'an entry carried unexpected fields',
  )
  const sorted = [...names].sort((a, b) => a.localeCompare(b))
  assert(JSON.stringify(names) === JSON.stringify(sorted), `not sorted: ${names.join(', ')}`)
})

await test('excludes hidden (dot-prefixed) entries', () => {
  const result = listDirectory(root)
  assert(!result.entries.some(e => e.name === '.hidden'), 'a hidden directory was listed')
})

await test('a symlink pointing outside the directory is not followed', () => {
  if (!symlinkSupported) return 'skipped — could not create a symlink in this environment'
  const result = listDirectory(root)
  assert(!result.entries.some(e => e.name === 'escape-link'),
    'a symlink was listed as a browsable directory — it could lead outside root')
})

await test('an unreadable path resolves to an empty listing with a reason, never a throw', () => {
  const missing = path.join(base, 'does-not-exist')
  const result = listDirectory(missing)
  assert(Array.isArray(result.entries) && result.entries.length === 0, 'expected an empty listing')
  assert(typeof result.reason === 'string' && result.reason, 'expected a reason string')
  assert(result.path === missing, 'path echoed back does not match')
})

await test('a non-string path does not throw', () => {
  for (const bad of [undefined, null, 42, {}]) {
    const result = listDirectory(bad)
    assert(Array.isArray(result.entries) && result.entries.length === 0, `${JSON.stringify(bad)} did not resolve to an empty listing`)
  }
})

await test('parent is null at a root, non-null one level in', () => {
  const nested = listDirectory(path.join(root, 'Alpha'))
  assert(nested.parent === root, `expected parent ${root}, got ${nested.parent}`)

  const platformRoot = process.platform === 'win32' ? path.parse(root).root : '/'
  const atRoot = listDirectory(platformRoot)
  assert(atRoot.parent === null, `expected no parent above ${platformRoot}, got ${atRoot.parent}`)
})

// ---------------------------------------------------------------------------
// browse:mkdir
// ---------------------------------------------------------------------------

console.log('\n--- listDirectory: files (opt-in) ---')

// A model picker has to SHOW the .gguf it is looking for. Before this, file
// mode listed folders only and asked the admin to type the file name, which
// is how a Mac user ended up unable to pick a model outside the models folder.
const filesDir = path.join(base, 'files')
fs.mkdirSync(path.join(filesDir, 'sub'), { recursive: true })
fs.writeFileSync(path.join(filesDir, 'model-a.gguf'), 'GGUF')
fs.writeFileSync(path.join(filesDir, 'Model-B.GGUF'), 'GGUF')
fs.writeFileSync(path.join(filesDir, 'notes.txt'), 'not a model')
fs.writeFileSync(path.join(filesDir, '.hidden.gguf'), 'GGUF')
const blob = path.join(outside, 'blob-1234')
fs.writeFileSync(blob, 'GGUF')
let fileLinkSupported = false
try {
  fs.symlinkSync(blob, path.join(filesDir, 'linked.gguf'), 'file')
  fs.symlinkSync(outside, path.join(filesDir, 'dir-link.gguf'), 'dir')
  fileLinkSupported = true
} catch {}

await test('without extensions the listing is directories only, as before', () => {
  const result = listDirectory(filesDir)
  assert(result.entries.every(e => e.kind === 'directory'), 'a file appeared without being asked for')
})

await test('with extensions, matching files are listed after folders, case-insensitively', () => {
  const result = listDirectory(filesDir, { extensions: ['gguf'] })
  const files = result.entries.filter(e => e.kind === 'file').map(e => e.name)
  assert(files.includes('model-a.gguf') && files.includes('Model-B.GGUF'), `got ${files.join(', ')}`)
  assert(!files.includes('notes.txt'), 'a non-matching file was listed')
  assert(!files.includes('.hidden.gguf'), 'a hidden file was listed')
  assert(result.entries[0].kind === 'directory', 'folders should come first')
  assert(
    result.entries.every(e => Object.keys(e).sort().join(',') === (e.kind === 'file'
      ? 'kind,modified,name,readable,size,writable'
      : 'kind,modified,name,readable,writable')),
    'an entry carried unexpected fields (contents or a link target)',
  )
})

await test('a file reports its size in bytes and a modification time; a folder only the time', () => {
  const result = listDirectory(filesDir, { extensions: ['gguf'] })
  const file = result.entries.find(e => e.name === 'model-a.gguf')
  assert(file.size === 4, `expected 4 bytes, got ${file.size}`)
  assert(typeof file.modified === 'number' && Math.abs(file.modified - Date.now()) < 3_600_000, `odd modified: ${file.modified}`)
  const dir = result.entries.find(e => e.name === 'sub')
  assert(dir.size === undefined, 'a folder carried a size')
  assert(typeof dir.modified === 'number', 'a folder carried no modified time')
})

await test('allFiles lists every file with a match flag; without it, only matches', () => {
  const all = listDirectory(filesDir, { extensions: ['gguf'], allFiles: true })
  const notes = all.entries.find(e => e.name === 'notes.txt')
  assert(notes && notes.match === false, `notes.txt: ${JSON.stringify(notes)}`)
  assert(all.entries.find(e => e.name === 'model-a.gguf')?.match === true, 'a matching file lacked match: true')
  assert(!all.entries.some(e => e.name === '.hidden.gguf'), 'allFiles should not imply hidden files')
  const only = listDirectory(filesDir, { extensions: ['gguf'] })
  assert(only.entries.every(e => e.match === undefined), 'match leaked into a listing that did not ask for it')
})

await test('allFiles without extensions is ignored: still folders only', () => {
  const result = listDirectory(filesDir, { allFiles: true })
  assert(result.entries.every(e => e.kind === 'directory'), 'allFiles listed files with no extensions given')
})

await test('showHidden includes dot entries, off by default', () => {
  const off = listDirectory(root)
  assert(!off.entries.some(e => e.name === '.hidden'), 'a hidden directory was listed by default')
  const on = listDirectory(root, { showHidden: true })
  assert(on.entries.some(e => e.name === '.hidden'), 'showHidden did not include .hidden')
  const files = listDirectory(filesDir, { extensions: ['gguf'], showHidden: true })
  assert(files.entries.some(e => e.name === '.hidden.gguf'), 'showHidden did not include a hidden matching file')
})

await test('showHidden still never follows a symlinked directory', () => {
  if (!symlinkSupported) return 'skipped — could not create a symlink in this environment'
  const result = listDirectory(root, { showHidden: true })
  assert(!result.entries.some(e => e.name === 'escape-link'), 'showHidden let a symlinked directory through')
})

await test('a symlinked model reports its target\'s size, never its target\'s path', () => {
  if (!fileLinkSupported) return 'symlinks not creatable here'
  const result = listDirectory(filesDir, { extensions: ['gguf'] })
  const linked = result.entries.find(e => e.name === 'linked.gguf')
  assert(linked.size === 4, `expected the blob's 4 bytes, got ${linked.size}`)
  assert(!JSON.stringify(result).includes('blob-1234') && !JSON.stringify(result).includes(outside), 'the target path leaked')
})

await test('browse:list forwards allFiles and showHidden through the route table', () => {
  const table = browseRouteHandlers()
  const all = table['browse:list']({ path: filesDir, extensions: ['gguf'], allFiles: true })
  assert(all.entries.some(e => e.name === 'notes.txt'), 'the route dropped allFiles')
  const hidden = table['browse:list']({ path: root, showHidden: true })
  assert(hidden.entries.some(e => e.name === '.hidden'), 'the route dropped showHidden')
})

await test('a symlink to a matching FILE is listed (Hugging Face cache), a symlink to a directory is not', () => {
  if (!fileLinkSupported) return 'symlinks not creatable here'
  const result = listDirectory(filesDir, { extensions: ['gguf'] })
  const names = result.entries.map(e => e.name)
  assert(names.includes('linked.gguf'), 'a symlinked model file was hidden')
  assert(!names.includes('dir-link.gguf'), 'a symlink to a directory was listed')
  assert(!JSON.stringify(result).includes('blob-1234'), 'the symlink target leaked into the listing')
})

await test('junk extensions are ignored rather than trusted', () => {
  const result = listDirectory(filesDir, { extensions: ['../x', 42, ''] })
  assert(result.entries.every(e => e.kind === 'directory'), 'junk extensions produced file entries')
})

await test('"exe" matches executables without an extension off Windows', () => {
  if (process.platform === 'win32') return 'Windows matches .exe instead'
  const bin = path.join(filesDir, 'llama-server')
  fs.writeFileSync(bin, '#!/bin/sh\n')
  fs.chmodSync(bin, 0o755)
  const names = listDirectory(filesDir, { extensions: ['exe'] }).entries.filter(e => e.kind === 'file').map(e => e.name)
  assert(names.includes('llama-server'), `got ${names.join(', ')}`)
  assert(!names.includes('notes.txt'), 'a non-executable was listed')
})

await test('browse:list forwards extensions through the route table', () => {
  const result = browseRouteHandlers()['browse:list']({ path: filesDir, extensions: ['gguf'] })
  assert(result.entries.some(e => e.kind === 'file'), 'the route dropped extensions')
})

console.log('\n--- browseMkdir ---')

await test('creates a new folder directly under an existing path', () => {
  const result = browseMkdir({ path: root, name: 'New Folder' })
  assert(result.ok === true, `expected ok, got ${JSON.stringify(result)}`)
  assert(fs.existsSync(path.join(root, 'New Folder')), 'the folder was not actually created')
})

await test('refuses a name containing a separator', () => {
  for (const name of ['a/b', 'a\\b', '/etc', 'C:\\x']) {
    const result = browseMkdir({ path: root, name })
    assert(result.ok === false, `${JSON.stringify(name)} was accepted`)
  }
})

await test('refuses "." and ".."', () => {
  for (const name of ['.', '..']) {
    const result = browseMkdir({ path: root, name })
    assert(result.ok === false, `${JSON.stringify(name)} was accepted`)
  }
})

await test('refuses an empty or missing name', () => {
  for (const name of ['', '   ', undefined, null]) {
    const result = browseMkdir({ path: root, name })
    assert(result.ok === false, `${JSON.stringify(name)} was accepted`)
  }
})

await test('a duplicate name is a clean refusal, not a throw', () => {
  const result = browseMkdir({ path: root, name: 'Alpha' })
  assert(result.ok === false, 'creating an already-existing folder should fail')
})

// ---------------------------------------------------------------------------
// browse:* is an ordinary, routable admin-API namespace
// ---------------------------------------------------------------------------

console.log('\n--- table shape ---')

await test('every browse method is routable, never local-only', () => {
  // This is the property the design leans on: browse:* has no gate of its
  // own because it never opts out of the listener's — asserted here rather
  // than only trusted, per the plan's "assert it anyway".
  const table = browseRouteHandlers()
  const names = Object.keys(table)
  assert(JSON.stringify(names.sort()) === JSON.stringify(['browse:list', 'browse:mkdir', 'browse:roots']),
    `unexpected method set: ${names.join(', ')}`)
  for (const name of names) {
    assert(!isLocalOnly(table[name]), `${name} was marked local-only — it is the replacement FOR local-only`)
  }
})

await test('scoping: (a) no scope — the table takes no root/deps argument', () => {
  // Pins the §4.2 decision itself: browseRouteHandlers() is a bare function with no
  // configured-root dependency threaded in, unlike every capability provider
  // that DOES have one (path-scope.mjs). If this ever grows a required dep,
  // that is the scoping decision being revisited — which is fine, but should
  // be a deliberate edit here, not a silent signature change.
  assert(browseRouteHandlers.length === 0, 'browseRouteHandlers() started taking arguments')
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n--- access reporting (Phase 8B.6) ---')

await test('the listing reports whether the daemon can read and write the target', () => {
  // Design §3.5's one hard requirement about tool folders: an unreadable
  // folder must be reported as unreadable AT SELECTION TIME, rather than
  // accepted and then failing later inside a tool call — where the error
  // reaches the user as a confused model rather than as a permissions problem.
  const result = listDirectory(root)
  assert(result.readable === true, `a readable directory reported ${result.readable}`)
  assert(typeof result.writable === 'boolean', `writable was ${typeof result.writable}`)
})

await test('every entry carries its own access flags', () => {
  // Per-entry, not just per-target: the admin selects a folder from this list,
  // so "can I use that one" has to be answerable before they click into it.
  const result = listDirectory(root)
  assert(result.entries.length > 0, 'no entries to check')
  for (const e of result.entries) {
    assert(typeof e.readable === 'boolean', `${e.name} has no readable flag`)
    assert(typeof e.writable === 'boolean', `${e.name} has no writable flag`)
  }
})

// EVERY PLATFORM, and that is the point of it. The chmod-staged test below is
// the realistic case, but it can only be staged on POSIX — so the error branch
// of listDirectory() went unexercised on the machine this is developed on, and
// shipped returning no access flags at all. A path that does not exist takes
// exactly the same branch and needs no permissions to stage, which makes the
// contract "the error branch answers the access question too" checkable
// wherever the suite runs, rather than only on the Linux CI runner.
await test('🔍 the error branch reports access too, not just the success branch', () => {
  const missing = path.join(base, 'no-such-directory-anywhere')
  const result = listDirectory(missing)
  assert(result.reason, 'a missing directory gave no reason')
  assert(result.readable === false, `readable was ${result.readable} — undefined means the UI never warns`)
  assert(result.writable === false, `writable was ${result.writable}`)
  return 'a listing that failed still answers "can I use this?"'
})

await test('🔒 an unreadable directory is reported as unreadable, not as an error', () => {
  // The distinguishing case. A directory that cannot be read is a completely
  // ordinary thing for an admin to be looking at — it must produce a listing
  // that says so, not a throw and not an empty success that reads as "this
  // folder is fine and happens to be empty".
  const denied = path.join(base, 'denied')
  fs.mkdirSync(denied, { recursive: true })
  if (process.platform === 'win32') {
    // chmod cannot remove read access on win32 (it maps to the read-only
    // attribute, which does not gate reading at all), so the deny case is
    // staged on POSIX only and runs for real on the Linux CI runner. The
    // REPORTING shape above is checked on both.
    return 'not stageable on win32; runs on CI'
  }
  fs.chmodSync(denied, 0o000)
  try {
    const result = listDirectory(denied)
    assert(result.readable === false, 'an unreadable directory reported readable')
    assert(Array.isArray(result.entries), 'no entries array on an unreadable listing')
    assert(result.entries.length === 0, 'an unreadable directory returned entries')
    assert(result.reason, 'an unreadable directory gave no reason')
  } finally {
    // Restore, or the temp-tree cleanup at the foot of this file cannot
    // remove it and the suite leaks a directory per run.
    fs.chmodSync(denied, 0o700)
  }
})

await test('an unreadable CHILD is listed and flagged, never hidden', () => {
  // Shown rather than filtered out: a folder the daemon cannot read is still a
  // real folder, and the admin may be about to go and grant access to it.
  // Hiding it would leave them hunting for something their own file manager
  // shows them.
  if (process.platform === 'win32') return 'not stageable on win32; runs on CI'
  const parent = path.join(base, 'with-denied-child')
  const child = path.join(parent, 'locked')
  fs.mkdirSync(child, { recursive: true })
  fs.chmodSync(child, 0o000)
  try {
    const entry = listDirectory(parent).entries.find(e => e.name === 'locked')
    assert(entry, 'the unreadable child was hidden from the listing')
    assert(entry.readable === false, `the unreadable child reported readable: ${JSON.stringify(entry)}`)
  } finally {
    fs.chmodSync(child, 0o700)
  }
})

fs.rmSync(base, { recursive: true, force: true })

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
