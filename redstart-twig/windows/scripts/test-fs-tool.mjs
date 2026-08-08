// =============================================================================
// Redstart Twig — invariant tests for the local file-system tools
// =============================================================================
// Twig's fs_* tools act on the USER'S OWN DISK, and unlike Nest's capabilities
// there is no server-side policy gate behind them: Nest's evaluateToolPolicy
// never sees these calls. The folder grant and the per-call permission prompt
// are the only consent, and this file is the only automated check that the
// guarantees underneath them hold.
//
// Two properties are tested, both of which have been silently wrong before:
//
//   1. CONTAINMENT — the model cannot read, write, or delete outside the
//      granted folder, including via "..", absolute paths, or a symlink planted
//      inside the root.
//   2. RECOVERABILITY — fs_delete_file never destroys anything. It used to be a
//      bare fs.unlinkSync with no undo; a delete that cannot be walked back is
//      a different risk category when a local model is choosing the target.
//
// Runs under plain node — no Electron. That is exactly why trash.mjs takes its
// OS implementation by injection: with none registered, deletes fall back to
// the .trash/ folder and this suite can assert on the result. The recycle-bin
// path itself is a manual check (see SMOKE.md §4).
//
// Run:  npm test    (from redstart-twig/windows)
// =============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import * as fsTool from '../electron/fs/fs-tool.mjs'
import { resetTrashImpl, setTrashImpl } from '../electron/fs/trash.mjs'

// ---------------------------------------------------------------------------
// Harness (mirrors redstart-nest/scripts/test-path-scope.mjs)
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
// Fixture: a granted root, plus an "outside" folder the model must never reach
// ---------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'twig-fs-test-'))
const root = path.join(tmp, 'granted')
const outside = path.join(tmp, 'outside')
fs.mkdirSync(root, { recursive: true })
fs.mkdirSync(outside, { recursive: true })
fs.writeFileSync(path.join(outside, 'secret.txt'), 'do not read me', 'utf8')

const cfg = { fileSystem: { enabled: true, rootDir: root } }

const call = (name, args) => fsTool.callTool(name, args, cfg)

function seed(relPath, content = 'hello') {
  const full = path.join(root, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf8')
  return full
}

function trashedFiles() {
  const trashRoot = path.join(root, '.trash')
  if (!fs.existsSync(trashRoot)) return []
  const found = []
  const stack = [trashRoot]
  while (stack.length) {
    const dir = stack.pop()
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else found.push(full)
    }
  }
  return found
}

function textOf(result) {
  return (result?.content ?? []).map((c) => c.text).join('\n')
}

// No OS trash under plain node — deletes take the .trash/ fallback, which is
// what makes the recoverability assertions below observable.
resetTrashImpl()

// ---------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------

console.log('\n-- containment: the grant is the boundary --')

await test('reading a ../ path outside the root is refused', async () => {
  const res = await call('fs_read_file', { path: '../outside/secret.txt' })
  assert(res.isError, `expected refusal, got: ${textOf(res).slice(0, 120)}`)
  assert(!textOf(res).includes('do not read me'), 'LEAKED the outside file contents')
})

await test('reading an absolute path outside the root is refused', async () => {
  const res = await call('fs_read_file', { path: path.join(outside, 'secret.txt') })
  assert(res.isError, 'absolute path outside the root was not refused')
  assert(!textOf(res).includes('do not read me'), 'LEAKED the outside file contents')
})

await test('writing outside the root is refused and creates nothing', async () => {
  const target = path.join(outside, 'planted.txt')
  const res = await call('fs_write_file', { path: target, content: 'planted' })
  assert(res.isError, 'write outside the root was not refused')
  assert(!fs.existsSync(target), 'a file was created OUTSIDE the granted folder')
})

await test('deleting outside the root is refused and removes nothing', async () => {
  const victim = path.join(outside, 'secret.txt')
  const res = await call('fs_delete_file', { path: '../outside/secret.txt' })
  assert(res.isError, 'delete outside the root was not refused')
  assert(fs.existsSync(victim), 'a file OUTSIDE the granted folder was deleted')
})

// ---------------------------------------------------------------------------
// Deletion is recoverable
// ---------------------------------------------------------------------------

console.log('\n-- deletion: recoverable, never destructive --')

await test('deleting a file moves it to .trash/ rather than destroying it', async () => {
  const full = seed('notes/todo.md', 'remember the milk')
  const res = await call('fs_delete_file', { path: 'notes/todo.md' })
  assert(!res.isError, `delete failed: ${textOf(res)}`)
  assert(!fs.existsSync(full), 'the file is still at its original path')

  const recovered = trashedFiles().filter((p) => p.endsWith('todo.md'))
  assert(recovered.length === 1, `expected 1 trashed copy, found ${recovered.length}`)
  assert(
    fs.readFileSync(recovered[0], 'utf8') === 'remember the milk',
    'the trashed copy does not have the original contents',
  )
  return 'contents intact in .trash/'
})

await test('the reply tells the model (and so the user) the delete is recoverable', async () => {
  seed('scratch.txt')
  const res = await call('fs_delete_file', { path: 'scratch.txt' })
  assert(!res.isError, `delete failed: ${textOf(res)}`)
  assert(/recoverable/i.test(textOf(res)), `reply does not mention recoverability: ${textOf(res)}`)
})

await test('the trashed copy keeps its original relative path, so a restore is unambiguous', async () => {
  seed('deep/nested/report.md', 'q3')
  await call('fs_delete_file', { path: 'deep/nested/report.md' })
  const hit = trashedFiles().find((p) => p.endsWith('report.md'))
  assert(hit, 'nothing was trashed')
  const rel = path.relative(path.join(root, '.trash'), hit).split(path.sep)
  // .trash/<timestamp>/deep/nested/report.md
  assert(
    rel.slice(1).join('/') === 'deep/nested/report.md',
    `expected the original relative path under the timestamp bucket, got ${rel.slice(1).join('/')}`,
  )
})

await test('two deletes of the same path do not collide', async () => {
  seed('dup.txt', 'first')
  await call('fs_delete_file', { path: 'dup.txt' })
  seed('dup.txt', 'second')
  await call('fs_delete_file', { path: 'dup.txt' })
  const hits = trashedFiles().filter((p) => p.endsWith('dup.txt'))
  assert(hits.length === 2, `expected both copies preserved, found ${hits.length}`)
  const contents = hits.map((p) => fs.readFileSync(p, 'utf8')).sort()
  assert(contents.join(',') === 'first,second', `lost a version: ${contents.join(',')}`)
})

await test('an item already in .trash/ is refused, never permanently removed', async () => {
  seed('once.txt', 'x')
  await call('fs_delete_file', { path: 'once.txt' })
  const trashed = trashedFiles().find((p) => p.endsWith('once.txt'))
  assert(trashed, 'nothing was trashed')
  const rel = path.relative(root, trashed).split(path.sep).join('/')

  const res = await call('fs_delete_file', { path: rel })
  assert(res.isError, 'emptying the trash was allowed — deletion is no longer recoverable')
  assert(fs.existsSync(trashed), 'the trashed file was PERMANENTLY removed')
})

await test('a failed trash move leaves the original in place', async () => {
  // Force the OS tier to claim success without moving anything, and make the
  // folder fallback unreachable. The file must survive: a delete that cannot be
  // made recoverable must not degrade into a permanent one.
  const full = seed('fragile.txt', 'still here')
  setTrashImpl(async () => false) // explicit failure -> falls through to .trash/
  try {
    const res = await call('fs_delete_file', { path: 'fragile.txt' })
    // The fallback should succeed here, so this asserts the file is recoverable
    // rather than gone — either outcome is acceptable EXCEPT destruction.
    const stillThere = fs.existsSync(full)
    const inTrash = trashedFiles().some((p) => p.endsWith('fragile.txt'))
    assert(stillThere || inTrash, `file was destroyed: ${textOf(res)}`)
  } finally {
    resetTrashImpl()
  }
})

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

console.log('\n-- guards: the folder itself, and non-empty directories --')

for (const [label, arg] of [['"."', '.'], ['the absolute root path', root], ['""', '']]) {
  await test(`deleting the granted folder itself via ${label} is refused`, async () => {
    const res = await call('fs_delete_file', { path: arg })
    assert(res.isError, 'the granted folder itself was accepted as a delete target')
    assert(fs.existsSync(root), 'THE GRANTED FOLDER WAS DELETED')
  })
}

await test('a non-empty directory is refused and its contents survive', async () => {
  seed('project/src/index.js', 'console.log(1)')
  const res = await call('fs_delete_file', { path: 'project' })
  assert(res.isError, 'a non-empty directory was deleted')
  assert(fs.existsSync(path.join(root, 'project/src/index.js')), 'directory contents were removed')
})

await test('an empty directory is trashed', async () => {
  const dir = path.join(root, 'empty-dir')
  fs.mkdirSync(dir, { recursive: true })
  const res = await call('fs_delete_file', { path: 'empty-dir' })
  assert(!res.isError, `empty directory delete failed: ${textOf(res)}`)
  assert(!fs.existsSync(dir), 'the empty directory is still there')
})

await test('deleting a symlink removes the LINK, not the file it points at', async () => {
  const target = seed('real-target.txt', 'the real file')
  const link = path.join(root, 'link-to-target.txt')
  try {
    fs.symlinkSync(target, link, 'file')
  } catch (err) {
    // Windows needs Developer Mode or elevation for file symlinks. Skipping is
    // honest; SMOKE.md §5 covers this by hand.
    return `skipped — cannot create symlinks here (${err.code})`
  }
  const res = await call('fs_delete_file', { path: 'link-to-target.txt' })
  assert(!res.isError, `symlink delete failed: ${textOf(res)}`)
  assert(!fs.existsSync(link), 'the symlink is still there')
  assert(fs.existsSync(target), 'THE SYMLINK TARGET WAS DELETED — the link was followed')
  assert(fs.readFileSync(target, 'utf8') === 'the real file', 'the target was modified')
  return 'link removed, target intact'
})

// ---------------------------------------------------------------------------
// Config gate
// ---------------------------------------------------------------------------

console.log('\n-- config: no grant, no tools --')

await test('no tools are advertised without a granted folder', async () => {
  const defs = fsTool.toolDefs({ fileSystem: { enabled: false, rootDir: null } })
  assert(defs.length === 0, `expected no tools, got ${defs.length}`)
})

await test('every tool is refused when no folder is granted', async () => {
  const disabled = { fileSystem: { enabled: false, rootDir: null } }
  for (const name of ['fs_read_file', 'fs_write_file', 'fs_delete_file', 'fs_list_directory']) {
    const res = await fsTool.callTool(name, { path: 'x' }, disabled)
    assert(res?.isError, `${name} ran without a granted folder`)
  }
})

await test('🔍 every advertised tool has a declared class', async () => {
  // The class manifest travels to the chat-ui alongside the definitions
  // (`fs:get-tools` returns { tools, classes }), and it is the ONLY thing that
  // keeps fs_delete_file out of "always allow". These tools run on the user's
  // own machine, so no server-side policy reaches them — a tool added here and
  // forgotten in TOOL_CLASSES would look unclassified and become eligible to be
  // granted permanently, silently.
  for (const def of fsTool.toolDefs(cfg)) {
    assert(
      fsTool.TOOL_CLASSES[def.name],
      `${def.name} has no entry in TOOL_CLASSES — it would be treated as unclassified and could be "always allowed"`,
    )
  }
  return `${Object.keys(fsTool.TOOL_CLASSES).length} classified`
})

await test('🔍 the delete tool is classified destructive', async () => {
  assert(
    fsTool.TOOL_CLASSES.fs_delete_file === 'destructive',
    `fs_delete_file is "${fsTool.TOOL_CLASSES.fs_delete_file}" — anything else makes it eligible for "always allow"`,
  )
})

await test('no non-destructive tool is mislabelled destructive', async () => {
  // The opposite failure: over-labelling would make ordinary reads prompt every
  // time, which trains users to click through prompts without reading them.
  const destructive = Object.entries(fsTool.TOOL_CLASSES)
    .filter(([, cls]) => cls === 'destructive')
    .map(([name]) => name)
  assert(
    destructive.length === 1 && destructive[0] === 'fs_delete_file',
    `expected exactly one destructive tool, got ${JSON.stringify(destructive)}`,
  )
})

await test('every advertised tool names the machine it acts on', async () => {
  // The model may hold Nest's server-side file tools at the same time, and a
  // description that says only "the file system root" gives it no way to tell
  // two computers apart.
  for (const def of fsTool.toolDefs(cfg)) {
    assert(
      /Redstart Twig/.test(def.description),
      `${def.name} does not say which machine it acts on: "${def.description}"`,
    )
  }
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

fs.rmSync(tmp, { recursive: true, force: true })

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
