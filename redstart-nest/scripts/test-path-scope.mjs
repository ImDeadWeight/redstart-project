// =============================================================================
// Unit tests for electron/main/path-scope.mjs — the shared containment check
// used by every file-based MCP capability provider.
// =============================================================================
// Pure Node, no Electron dependency (path-scope.mjs imports only fs/path).
// Same tiny harness style as scripts/test-auth.mjs.
//
// Run:  node scripts/test-path-scope.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveWithinRoot, tryResolveWithinRoot } from '../electron/main/path-scope.mjs'

// ---------------------------------------------------------------------------
// Harness (mirrors scripts/test-auth.mjs)
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

function expectThrow(fn, why) {
  try { fn() } catch { return }
  throw new Error(`expected throw: ${why}`)
}

// ---------------------------------------------------------------------------
// Fixture: root dir with a file, a subdir, and a sibling "outside" dir
// ---------------------------------------------------------------------------

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-path-scope-'))
const root = path.join(base, 'root')
const outside = path.join(base, 'outside')
fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
fs.mkdirSync(outside, { recursive: true })
fs.writeFileSync(path.join(root, 'a.txt'), 'a')
fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'b')
fs.writeFileSync(path.join(outside, 'secret.txt'), 's')

console.log('\n--- resolveWithinRoot: containment ---')

await test('relative path inside root resolves', () => {
  const p = resolveWithinRoot(root, 'a.txt')
  if (!fs.existsSync(p)) throw new Error(`resolved to missing file: ${p}`)
})

await test('nested relative path resolves', () => {
  resolveWithinRoot(root, path.join('sub', 'b.txt'))
})

await test('nonexistent target inside root is allowed (write case)', () => {
  const p = resolveWithinRoot(root, path.join('sub', 'new-report.docx'))
  if (!p.startsWith(fs.realpathSync.native(root))) throw new Error('escaped')
})

await test('root itself ("." ) resolves', () => {
  resolveWithinRoot(root, '.')
})

await test('absolute path inside root is accepted', () => {
  resolveWithinRoot(root, path.join(root, 'a.txt'))
})

await test('"../" traversal is rejected', () => {
  expectThrow(() => resolveWithinRoot(root, path.join('..', 'outside', 'secret.txt')), '.. escape')
})

await test('deep "../.." traversal is rejected', () => {
  expectThrow(() => resolveWithinRoot(root, 'sub/../../outside/secret.txt'), 'nested .. escape')
})

await test('absolute path outside root is rejected', () => {
  expectThrow(() => resolveWithinRoot(root, path.join(outside, 'secret.txt')), 'absolute escape')
})

await test('prefix-sibling dir is rejected (root vs root-extra)', () => {
  // Guards against naive startsWith(root) without a trailing separator:
  // "…/root-extra" starts with "…/root" as a string but is NOT inside it.
  const sibling = root + '-extra'
  fs.mkdirSync(sibling, { recursive: true })
  expectThrow(() => resolveWithinRoot(root, sibling), 'prefix-sibling escape')
})

await test('NUL byte in path is rejected', () => {
  expectThrow(() => resolveWithinRoot(root, 'a\0.txt'), 'NUL byte')
})

await test('non-string path is rejected', () => {
  expectThrow(() => resolveWithinRoot(root, 42), 'non-string')
})

await test('missing root throws a config error', () => {
  expectThrow(() => resolveWithinRoot(path.join(base, 'does-not-exist'), 'a.txt'), 'missing root')
})

await test('null root throws a config error', () => {
  expectThrow(() => resolveWithinRoot(null, 'a.txt'), 'null root')
})

if (process.platform === 'win32') {
  console.log('\n--- win32 specifics ---')

  await test('other-drive path is rejected', () => {
    // Any drive letter other than the temp dir's own.
    const drive = root[0].toLowerCase() === 'c' ? 'D:' : 'C:'
    expectThrow(() => resolveWithinRoot(root, `${drive}\\Windows\\system.ini`), 'other drive')
  })

  await test('case-differing path inside root is accepted', () => {
    resolveWithinRoot(root, 'A.TXT') // NTFS is case-insensitive; must not false-reject
  })
}

console.log('\n--- symlink escape (junction) ---')

// A junction inside the root pointing outside it — the exact hole a lexical
// resolve()+startsWith() check does not catch. Junctions need no privileges
// on Windows; on POSIX use a plain symlink.
const linkPath = path.join(root, 'link-out')
let linkMade = false
try {
  fs.symlinkSync(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  linkMade = true
} catch (err) {
  console.log(`  (skipping symlink tests — could not create link: ${err.message})`)
}

if (linkMade) {
  await test('path through an inside->outside symlink is rejected', () => {
    expectThrow(() => resolveWithinRoot(root, path.join('link-out', 'secret.txt')), 'symlink escape')
  })

  await test('nonexistent file under the escaping symlink is still rejected', () => {
    expectThrow(() => resolveWithinRoot(root, path.join('link-out', 'new.txt')), 'symlink escape, missing leaf')
  })
}

console.log('\n--- tryResolveWithinRoot ---')

await test('returns the path on success', () => {
  if (tryResolveWithinRoot(root, 'a.txt') === null) throw new Error('unexpected null')
})

await test('returns null on escape instead of throwing', () => {
  if (tryResolveWithinRoot(root, '../outside/secret.txt') !== null) throw new Error('expected null')
})

await test('still throws on missing root (config error, not model input)', () => {
  expectThrow(() => tryResolveWithinRoot(path.join(base, 'nope'), 'a.txt'), 'config error passthrough')
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

fs.rmSync(base, { recursive: true, force: true })

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
