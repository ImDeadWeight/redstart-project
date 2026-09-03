// =============================================================================
// Unit tests for electron/main/admin/browse-routes.mjs — the server-side
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
  browseRoots, listDirectory, browseMkdir, browseRouteHandlers,
} from '../electron/main/admin/browse-routes.mjs'
import { isLocalOnly } from '../electron/main/ipc/transport.mjs'

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
  assert(
    result.entries.every(e => Object.keys(e).sort().join(',') === 'kind,name,readable,writable'),
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
