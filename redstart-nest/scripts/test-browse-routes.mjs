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
  // No key anywhere in the shape carries file content — the type itself is
  // { name, kind }, so this also documents the contract for future readers.
  assert(result.entries.every(e => Object.keys(e).sort().join(',') === 'kind,name'), 'an entry carried extra fields')
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

fs.rmSync(base, { recursive: true, force: true })

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
