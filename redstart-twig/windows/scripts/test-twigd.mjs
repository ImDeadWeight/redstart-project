// =============================================================================
// twigd under a fake shell: the pipe contract the Tauri shell relies on
// =============================================================================
// Spawns the real bin/twigd.mjs with --shell-pipe and plays the shell's part
// over stdio, the way shell/src/twigd.rs does. What is pinned here:
//
//   - `ready` arrives with the pid and the persisted folder grant;
//   - no folder means no fs_* tools, and the grant is fs:set-root, which only
//     accepts an existing absolute folder (the shell's dialog is the caller);
//   - a delete asks the SHELL for the recycle bin, and a refusal falls back
//     to .trash/, never a permanent delete;
//   - local MCP children start, talk, and are reported by pid on shutdown,
//     which is what the updater waits on before it installs;
//   - shutdown and EOF both exit 0 (exit 1 means a crash to the shell).
//
// Run:  npm test    (from redstart-twig/windows)
// =============================================================================

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPeer } from '../../../shared/shell-pipe.mjs'
import { TWIG_MANIFEST } from '../bin/twigd.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const TWIGD = path.join(here, '..', 'bin', 'twigd.mjs')
const results = []

async function test(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'twigd-test-'))
const configDir = path.join(tmp, 'config')
const grant = path.join(tmp, 'granted')
fs.mkdirSync(grant, { recursive: true })

/** A twigd and the shell side of its pipe. `onTrash` answers the recycle-bin request. */
function startTwigd({ onTrash = async () => true } = {}) {
  const child = spawn(process.execPath, [TWIGD, '--shell-pipe', '--config', configDir], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d })
  const noise = []
  const peer = createPeer({ input: child.stdout, write: (line) => child.stdin.write(line), onNoise: (l) => noise.push(l) })
  const trashCalls = []
  peer.handle('trash', async (params) => { trashCalls.push(params.path); return onTrash(params.path) })
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
  return { child, peer, noise, trashCalls, exited, stderr: () => stderr }
}

function withTimeout(promise, ms, what) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: nothing within ${ms} ms`)), ms))])
}

// A minimal stdio "MCP server": echoes each line back as a JSON-RPC result.
const echoServer = path.join(tmp, 'echo-server.mjs')
fs.writeFileSync(echoServer, `
process.stdin.setEncoding('utf8'); let buf = ''
process.stdin.on('data', (c) => { buf += c; let i
  while ((i = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1)
    const msg = JSON.parse(line); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { echoed: msg.method } }) + '\\n') } })
setInterval(() => {}, 1000)
`)

// ---------------------------------------------------------------------------
const t = startTwigd()
const ready = await withTimeout(t.peer.waitFor('ready', 10_000), 11_000, 'ready')

await test('ready carries the pid, and no folder is granted on a fresh config', () => {
  assert(ready.pid === t.child.pid, `pid ${ready.pid} vs ${t.child.pid}`)
  assert(ready.rootDir === null, `rootDir ${ready.rootDir}`)
})

await test('no folder granted: no fs_* tools, and explorer calls say why', async () => {
  const tools = await t.peer.request('fs:get-tools', {})
  assert(Array.isArray(tools.tools) && tools.tools.length === 0, `got ${tools.tools?.length} tools`)
  const browse = await t.peer.request('fs:browse', { path: '.' })
  assert(/No folder has been granted/.test(browse.error ?? ''), `browse: ${JSON.stringify(browse)}`)
})

await test('fs:set-root refuses a relative path and a folder that does not exist', async () => {
  for (const bad of ['relative/dir', path.join(tmp, 'missing')]) {
    let threw = false
    try { await t.peer.request('fs:set-root', { rootDir: bad }) } catch { threw = true }
    assert(threw, `accepted ${bad}`)
  }
  const root = await t.peer.request('fs:get-root', {})
  assert(root.rootDir === null, 'a refused grant still changed the root')
})

await test('a granted folder brings the tools, with fs_delete_file classed destructive', async () => {
  const set = await t.peer.request('fs:set-root', { rootDir: grant })
  assert(set.rootDir === grant, `set-root answered ${set.rootDir}`)
  const { tools, classes } = await t.peer.request('fs:get-tools', {})
  const names = tools.map((x) => x.function.name)
  assert(names.includes('fs_write_file') && names.includes('fs_delete_file'), names.join(','))
  assert(classes.fs_delete_file === 'destructive', `fs_delete_file is ${classes.fs_delete_file}`)
  const persisted = JSON.parse(fs.readFileSync(path.join(configDir, 'twig-fs-config.json'), 'utf8'))
  assert(persisted.rootDir === grant, 'the grant was not persisted')
  return `${tools.length} tools`
})

await test('fs:execute writes inside the grant and refuses to escape it', async () => {
  const w = await t.peer.request('fs:execute', { name: 'fs_write_file', args: { path: 'notes.md', content: 'hello' } })
  assert(!w.isError, JSON.stringify(w))
  assert(fs.readFileSync(path.join(grant, 'notes.md'), 'utf8') === 'hello', 'file not on disk')
  const out = await t.peer.request('fs:execute', { name: 'fs_write_file', args: { path: '../escaped.txt', content: 'x' } })
  assert(out.isError, 'an escaping write succeeded')
  assert(!fs.existsSync(path.join(tmp, 'escaped.txt')), 'escaped.txt exists outside the grant')
})

await test('a Files-tab delete asks the shell for the recycle bin', async () => {
  fs.writeFileSync(path.join(grant, 'bin-me.txt'), 'x')
  const r = await t.peer.request('fs:trash', { path: 'bin-me.txt' })
  assert(r.recoverable === 'recycle-bin', JSON.stringify(r))
  assert(t.trashCalls.at(-1) === path.join(grant, 'bin-me.txt'), `shell asked for ${t.trashCalls.at(-1)}`)
  assert(r.hint === 'restore it from the Recycle Bin', `hint ${r.hint}`)
})

await test('local MCP: add, list, start and a JSON-RPC round trip', async () => {
  const add = await t.peer.request('mcp-local:add', { id: 'echo', command: process.execPath, args: [echoServer] })
  assert(add.ok, JSON.stringify(add))
  const list = await t.peer.request('mcp-local:list', {})
  assert(list.length === 1 && list[0].id === 'echo' && list[0].running === false, JSON.stringify(list))
  const started = await t.peer.request('mcp-local:start', { id: 'echo' })
  assert(started.ok, JSON.stringify(started))
  const message = t.peer.waitFor('mcp-message', 5000)
  await t.peer.request('mcp-local:send', { id: 'echo', line: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) })
  const msg = await message
  assert(msg.id === 'echo' && JSON.parse(msg.line).result.echoed === 'ping', JSON.stringify(msg))
})

await test('shutdown reports the live MCP child pids and exits 0', async () => {
  const listed = await t.peer.request('mcp-local:list', {})
  assert(listed[0].running, 'echo is not running before shutdown')
  const stopping = t.peer.waitFor('stopping', 5000)
  t.peer.send({ type: 'shutdown' })
  const msg = await stopping
  assert(Array.isArray(msg.pids) && msg.pids.length === 1, `pids ${JSON.stringify(msg.pids)}`)
  const code = await withTimeout(t.exited, 5000, 'exit')
  assert(code === 0, `exit ${code}\n${t.stderr()}`)
  return `child pid ${msg.pids[0]}`
})

await test('nothing but protocol on stdout', () => {
  assert(t.noise.length === 0, `noise: ${t.noise.join(' | ').slice(0, 200)}`)
})

// ---------------------------------------------------------------------------
await test('a restart keeps the grant, and a refused recycle bin falls back to .trash/', async () => {
  const u = startTwigd({ onTrash: async () => { throw new Error('bin refused') } })
  const r = await withTimeout(u.peer.waitFor('ready', 10_000), 11_000, 'ready')
  assert(r.rootDir === grant, `rootDir after restart ${r.rootDir}`)
  fs.writeFileSync(path.join(grant, 'fallback.txt'), 'x')
  const del = await u.peer.request('fs:execute', { name: 'fs_delete_file', args: { path: 'fallback.txt' } })
  assert(!del.isError, JSON.stringify(del))
  assert(!fs.existsSync(path.join(grant, 'fallback.txt')), 'still in place')
  const trashed = fs.readdirSync(path.join(grant, '.trash'))
  assert(trashed.length === 1, 'nothing in .trash/')
  u.child.stdin.end()
  const code = await withTimeout(u.exited, 5000, 'exit on EOF')
  assert(code === 0, `EOF exit ${code}`)
})

await test('update-find picks the release carrying twig-latest.json, and the page cannot set the root', async () => {
  // In-process: the same wiring the entrypoint uses, over two PassThroughs,
  // with the GitHub call stubbed.
  const { PassThrough } = await import('node:stream')
  const { wireTwigd } = await import('../bin/twigd.mjs')
  const toTwigd = new PassThrough()
  const toShell = new PassThrough()
  const twigdSide = createPeer({ input: toTwigd, write: (l) => toShell.write(l) })
  const shellSide = createPeer({ input: toShell, write: (l) => toTwigd.write(l) })
  const asked = []
  const findUpdate = async (opts) => {
    asked.push(opts.manifest)
    return { release: { tag: '1.0.0-alpha.11', version: '1.0.0-alpha.11', feedUrl: 'https://example.invalid/dl/1.0.0-alpha.11/' } }
  }
  const wired = wireTwigd(twigdSide, { configDir: path.join(tmp, 'inproc'), exit: () => {}, findUpdate })
  const found = await shellSide.request('update-find', { currentVersion: '1.0.0-alpha.10' })
  assert(asked[0] === TWIG_MANIFEST && TWIG_MANIFEST === 'twig-latest.json', `asked for ${asked[0]}`)
  assert(found.manifestUrl === 'https://example.invalid/dl/1.0.0-alpha.11/twig-latest.json', found.manifestUrl)
  // The page-callable list is what the shell's allowlist mirrors (bridge.rs).
  assert(!wired.pageMethods.includes('fs:set-root'), 'fs:set-root is page-callable')
  assert(!wired.pageMethods.includes('update-find'), 'update-find is page-callable')

  // Two codebases, one list: the Rust allowlist must be exactly twigd's page
  // methods. A method missing there is a feature the page silently lost; one
  // extra there forwards something twigd never meant the page to have.
  const bridgeRs = fs.readFileSync(path.join(here, '..', 'shell', 'src', 'bridge.rs'), 'utf8')
  const block = /PAGE_METHODS: &\[&str\] = &\[([\s\S]*?)\];/.exec(bridgeRs)
  assert(block, 'PAGE_METHODS not found in bridge.rs')
  const rust = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort()
  const js = [...wired.pageMethods].sort()
  assert(JSON.stringify(rust) === JSON.stringify(js), `bridge.rs ${rust.join(',')}\n        twigd    ${js.join(',')}`)
  toTwigd.end()
  return `${rust.length} methods`
})

await test('an unknown method is an error, not a hang', async () => {
  const u = startTwigd()
  await withTimeout(u.peer.waitFor('ready', 10_000), 11_000, 'ready')
  let message = ''
  try { await u.peer.request('shell:run-anything', {}, { timeoutMs: 3000 }) } catch (err) { message = err.message }
  assert(/Unknown method/.test(message), `got "${message}"`)
  u.child.stdin.end()
  await withTimeout(u.exited, 5000, 'exit')
})

fs.rmSync(tmp, { recursive: true, force: true })
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
