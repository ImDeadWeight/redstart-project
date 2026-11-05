// =============================================================================
// The shell pipe — nestd under a desktop shell, driven the way a shell drives it
// =============================================================================
// Daemon split T1.3 (docs/notes/daemon-split-tauri-plan.md D2/D3). The desktop
// shell spawns `nestd --shell-pipe` and speaks JSON lines over its stdin and
// stdout. This suite is that shell: it spawns the REAL entrypoint, says hello
// with an OSCrypt key, answers the daemon's requests, and checks what a shell
// depends on:
//
//   - hello → ready, with the admin port and the first-run setup token
//   - stdout carries protocol lines only (console output went to stderr)
//   - secrets are written under the key the SHELL supplied (decrypted here
//     independently with that key), and no key file is created
//   - start-at-login goes through the shell: reconciled at boot, toggled from
//     the admin API, and reported as supported
//   - the shell can stop a model; garbage on stdin is ignored
//   - admin Shut down asks the shell to quit; the shell's 'shutdown' then
//     stops the daemon with exit 0 and a 'stopping' message carrying pids
//   - EOF on stdin, the shell dying, stops the daemon gracefully: exit 0,
//     ports released. That is the orphan the Tauri spike found, fixed.
//
// Plus the framing itself (shell-pipe.mjs) in-process: request/response,
// errors, timeouts, noise, close.
//
// SELF-SKIPS the daemon half when :19083 or :8765 is bound (Redstart running
// here), like test-daemon-smoke.mjs.
//
// Run:  node scripts/test-shell-pipe.mjs
// =============================================================================

import { spawn } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { ADMIN_PORT, BEACON_PORT } from '../daemon/ports.mjs'
import { createPeer } from '../daemon/shell-pipe.mjs'
import { startDaemonProcess } from '../daemon/daemon-host.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(here, '..')
const nestd = path.join(repoRoot, 'bin', 'nestd.mjs')
const base = `http://127.0.0.1:${ADMIN_PORT}`
const fixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'oscrypt-electron33.json'), 'utf8'))
const KEY = Buffer.from(fixture.keyBase64, 'base64')

const results = []
async function test(name, fn) {
  try {
    const detail = await fn()
    results.push({ pass: true })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ pass: false })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}
function assert(cond, message) { if (!cond) throw new Error(message) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// 1. Framing, in-process
// ---------------------------------------------------------------------------

console.log('\n-- shell-pipe framing --')

function pair() {
  const aToB = new PassThrough(), bToA = new PassThrough()
  const noiseA = [], noiseB = []
  const a = createPeer({ input: bToA, write: (l) => aToB.write(l), onNoise: (l) => noiseA.push(l) })
  const b = createPeer({ input: aToB, write: (l) => bToA.write(l), onNoise: (l) => noiseB.push(l) })
  return { a, b, aToB, bToA, noiseA, noiseB }
}

await test('a request resolves with the handler\'s value; a throw becomes the error', async () => {
  const { a, b } = pair()
  b.handle('add', ({ x, y }) => x + y)
  b.handle('fail', () => { throw new Error('nope') })
  assert(await a.request('add', { x: 2, y: 3 }) === 5, 'wrong value')
  let err = null
  try { await a.request('fail') } catch (e) { err = e }
  assert(err && err.message === 'nope', `error not carried: ${err?.message}`)
  try { await a.request('missing') } catch (e) { err = e }
  assert(/Unknown method/.test(err.message), 'unknown method not reported')
})

await test('non-protocol lines are noise, never fatal; the channel keeps working', async () => {
  const { a, b, aToB, noiseB } = pair()
  b.handle('ping', () => 'pong')
  aToB.write('hello from a stray console.log\n{"not":"ours"}\n{"rs":2,"type":"x"}\n')
  assert(await a.request('ping') === 'pong', 'channel broken by noise')
  assert(noiseB.length === 3, `expected 3 noise lines, got ${noiseB.length}`)
})

await test('a line split across chunks is reassembled', async () => {
  const { b, aToB } = pair()
  const got = []
  b.on('note', (m) => got.push(m.text))
  const line = JSON.stringify({ rs: 1, type: 'note', text: 'split' }) + '\n'
  aToB.write(line.slice(0, 7)); await sleep(5); aToB.write(line.slice(7))
  await sleep(5)
  assert(got[0] === 'split', `got ${JSON.stringify(got)}`)
})

// A peer with nobody answering: its writes go nowhere, its input is ours.
function lonePeer() {
  const input = new PassThrough()
  return { peer: createPeer({ input, write: () => {} }), input }
}

await test('🔍 close rejects pending requests and fires onClose', async () => {
  const { peer: a, input: bToA } = lonePeer()
  let closed = false
  a.onClose(() => { closed = true })
  const p = a.request('never', {}, { timeoutMs: 5000 })
  bToA.end()
  let err = null
  try { await p } catch (e) { err = e }
  assert(err && /closed/.test(err.message), `pending not rejected on close: ${err?.message}`)
  assert(closed && a.closed, 'onClose did not fire')
})

await test('an unanswered request times out', async () => {
  const { peer: a } = lonePeer()
  let err = null
  try { await a.request('silent', {}, { timeoutMs: 50 }) } catch (e) { err = e }
  assert(err && /no answer within 50 ms/.test(err.message), `no timeout: ${err?.message}`)
})

// ---------------------------------------------------------------------------
// 2. The real daemon
// ---------------------------------------------------------------------------

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port })
    s.setTimeout(500)
    s.on('connect', () => { s.destroy(); resolve(true) })
    s.on('timeout', () => { s.destroy(); resolve(false) })
    s.on('error', () => resolve(false))
  })
}

console.log('\n-- nestd --shell-pipe --')

let skip = false
for (const port of [ADMIN_PORT, BEACON_PORT]) {
  if (await portInUse(port)) {
    console.log(`  SKIP - port ${port} is already in use; is Redstart running? CI has the ports.`)
    skip = true
    break
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-shell-pipe-'))
const configDir = path.join(tmp, 'AppData', 'redstart')
const capDir = path.join(tmp, 'Documents', 'Redstart')

/** Spawn nestd as a shell would, with this test acting as the shell. */
function spawnUnderShell() {
  const child = spawn(process.execPath, [nestd, '--shell-pipe', '--config', configDir, '--capability-base', capDir], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdoutLines = [], stderr = []
  child.stderr.on('data', (b) => stderr.push(b.toString()))
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
  const peer = createPeer({
    input: child.stdout,
    write: (l) => child.stdin.write(l),
    onNoise: (l) => stdoutLines.push(l),
  })
  const received = []
  const loginSets = []
  for (const t of ['ready', 'quit-requested', 'stopping', 'event', 'notify']) peer.on(t, (m) => received.push(m))
  peer.handle('login-item-set', (p) => { loginSets.push(p); return true })
  peer.handle('trash', () => true)
  return { child, peer, exited, received, loginSets, noise: stdoutLines, stderr: () => stderr.join('') }
}

const post = (p, body, token) => fetch(base + p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
})
const call = async (channel, args, token) => {
  const res = await post('/admin/api/' + channel.replace(':', '/'), { args }, token)
  const text = await res.text()
  let json = null; try { json = JSON.parse(text) } catch {}
  return { status: res.status, text, json }
}

if (!skip) {
  let d = null
  let token = null
  try {
    d = spawnUnderShell()
    d.peer.send({ type: 'hello', key: KEY.toString('base64'), loginItem: { enabled: false }, updater: null })

    let ready = null
    await test('🔍 hello → ready, with the admin port and the first-run setup token', async () => {
      ready = await d.peer.waitFor('ready', 30_000)
      assert(ready.adminPort === ADMIN_PORT, `adminPort ${ready.adminPort}`)
      const onDisk = fs.readFileSync(path.join(configDir, 'bootstrap-token.txt'), 'utf8').trim()
      assert(ready.setupToken === onDisk, 'setup token missing or not the one on disk')
      assert(ready.modelRunning === false, 'reported a model running at boot')
      return `pid ${d.child.pid}`
    })

    await test('🔍 state lands in the directories the shell named; no key file is created', async () => {
      assert(fs.existsSync(path.join(configDir, 'tools.json')), 'tools.json not in --config')
      assert(fs.readdirSync(capDir).length > 0, 'no capability folders under --capability-base')
      assert(!fs.existsSync(path.join(configDir, 'secret.key')), 'a key file was created: the key-file provider ran')
    })

    await test('🔍 start-at-login was reconciled through the shell at boot', async () => {
      await sleep(200)
      assert(d.loginSets.length >= 1, 'the daemon never asked the shell to set the login item')
      const last = d.loginSets[d.loginSets.length - 1]
      assert(Array.isArray(last.args) && last.args.includes('--background'), `args: ${JSON.stringify(last.args)}`)
      return `openAtLogin ${last.openAtLogin}`
    })

    await test('first-run bootstrap and login work through the admin listener', async () => {
      const created = await post('/admin/bootstrap', { token: ready.setupToken, username: 'owner', password: 'shell-pipe-pw-1234' })
      assert(created.status === 200, `bootstrap ${created.status}`)
      const login = await (await post('/admin/auth/login', { username: 'owner', password: 'shell-pipe-pw-1234' })).json()
      token = login.token
      assert(token, 'no session')
    })

    await test('🔍 a secret saved through the admin API is encrypted under the SHELL\'s key', async () => {
      const r = await call('capabilities:set-postgres', [{ connectionString: 'postgres://u:p@h:5432/db' }], token)
      assert(r.status === 200 && r.json?.result?.ok, `set-postgres: ${r.text}`)
      const stored = JSON.parse(fs.readFileSync(path.join(configDir, 'tools.json'), 'utf8')).capabilities.postgres.connectionStringEnc
      assert(stored.startsWith('v1.safestorage.'), `not a safestorage value: ${stored.slice(0, 20)}`)
      const blob = Buffer.from(stored.slice('v1.safestorage.'.length), 'base64')
      assert(blob.subarray(0, 3).toString() === 'v10', 'not OSCrypt v10')
      const dec = crypto.createDecipheriv('aes-256-gcm', KEY, blob.subarray(3, 15))
      dec.setAuthTag(blob.subarray(blob.length - 16))
      const plain = Buffer.concat([dec.update(blob.subarray(15, blob.length - 16)), dec.final()]).toString()
      assert(plain === 'postgres://u:p@h:5432/db', 'decrypted to the wrong value')
      return 'independent AES-GCM decrypt with the hello key'
    })

    await test('start-at-login is supported, and toggling it from the admin API reaches the shell', async () => {
      const got = await call('admin:get-startup', [], token)
      assert(got.json?.result?.supported === true, `get-startup: ${got.text}`)
      const before = d.loginSets.length
      const set = await call('admin:set-startup', [false], token)
      assert(set.status === 200, `set-startup: ${set.text}`)
      await sleep(200)
      assert(d.loginSets.length > before && d.loginSets[d.loginSets.length - 1].openAtLogin === false, 'toggle did not reach the shell')
    })

    await test('the shell can stop the model (none running: a clean no-op)', async () => {
      assert(await d.peer.request('stop-model', {}, { timeoutMs: 10_000 }) === true, 'stop-model did not answer true')
    })

    await test('garbage on stdin is ignored and the daemon keeps serving', async () => {
      d.child.stdin.write('not json at all\n{"rs":1}\n')
      await sleep(200)
      assert(d.child.exitCode === null, 'the daemon exited on garbage')
      assert((await fetch(base + '/admin/whoami')).status === 401, 'admin listener stopped answering')
    })

    await test('🔍 stdout carried protocol lines only', async () => {
      assert(d.noise.length === 0, `non-protocol stdout lines: ${JSON.stringify(d.noise.slice(0, 3))}`)
      assert(/admin listener on 127\.0\.0\.1/.test(d.stderr()), 'console output did not go to stderr')
    })

    await test('🔍 admin Shut down asks the shell to quit; the shell\'s shutdown then exits 0', async () => {
      const r = await call('admin:shutdown', [], token)
      assert(r.status === 200, `shutdown call: ${r.status} ${r.text}`)
      await d.peer.waitFor('quit-requested', 10_000)
      d.peer.send({ type: 'shutdown' })
      const code = await d.exited
      assert(code === 0, `exit code ${code}`)
      const stopping = d.received.find((m) => m.type === 'stopping')
      assert(stopping && Array.isArray(stopping.pids), 'no stopping message with pids')
      assert(!(await portInUse(ADMIN_PORT)), 'admin port still bound after exit')
    })
    d = null

    await test('🔍 EOF on stdin (the shell died) stops the daemon gracefully: exit 0, ports released', async () => {
      const e = spawnUnderShell()
      e.peer.send({ type: 'hello', key: KEY.toString('base64'), loginItem: null, updater: null })
      await e.peer.waitFor('ready', 30_000)
      e.child.stdin.end()
      const code = await Promise.race([e.exited, sleep(15_000).then(() => 'timeout')])
      if (code === 'timeout') e.child.kill()
      assert(code === 0, `expected exit 0 after EOF, got ${code}`)
      assert(!(await portInUse(ADMIN_PORT)) && !(await portInUse(BEACON_PORT)), 'a port is still bound: the daemon outlived its shell')
      // The exit waits for the log to flush: this record was lost before.
      const log = fs.readFileSync(path.join(configDir, 'redstart.log'), 'utf8')
      assert(/"event":"shutdown","reason":"shell-pipe-closed"/.test(log), 'the shutdown record never reached redstart.log')
    })

    await test('without a login item from the shell, start-at-login reads unsupported', async () => {
      const e = spawnUnderShell()
      e.peer.send({ type: 'hello', key: KEY.toString('base64'), loginItem: null, updater: null })
      await e.peer.waitFor('ready', 30_000)
      const login = await (await post('/admin/auth/login', { username: 'owner', password: 'shell-pipe-pw-1234' })).json()
      const got = await call('admin:get-startup', [], login.token)
      e.child.stdin.end(); await e.exited
      assert(got.json?.result?.supported === false, `expected unsupported: ${got.text}`)
      assert(e.loginSets.length === 0, 'asked a shell with no login item to set one')
    })

    // The Electron shell's side of the same protocol (daemon-host.mjs), hosting
    // the real nestd: what index.mjs relies on for startup, the tray's stop,
    // and the quit path's wait.
    await test('🔍 daemon-host: ready carries the port; stop() waits for exit and reports the daemon pid', async () => {
      const notified = []
      let exitInfo = null
      const h = startDaemonProcess({
        nodePath: process.execPath,
        nestdPath: nestd,
        paths: { config: configDir, capabilityBase: capDir, resources: null },
        key: KEY,
        loginItem: null,
        updater: null,
        handlers: { trash: () => true },
        events: { onNotify: (n) => notified.push(n), onExit: (i) => { exitInfo = i } },
      })
      const ready = await h.ready
      assert(ready.adminPort === ADMIN_PORT, `ready.adminPort ${ready.adminPort}`)
      const model = await h.stopModel()
      assert(model !== undefined, 'stop-model got no answer')
      // The Tauri updater's question. A manifest name that is not a plain
      // file name never reaches a URL.
      let refused = null
      try { await h.peer.request('update-find', { currentVersion: '1.0.0', manifest: '../evil' }) } catch (e) { refused = e }
      assert(refused && /manifest file name/.test(refused.message), `update-find accepted a path: ${refused?.message}`)
      const { childPids } = await h.stop()
      assert(childPids.includes(h.pid), `stop() did not report the daemon pid: ${childPids}`)
      assert(exitInfo && exitInfo.expected === true && exitInfo.code === 0, `exit ${JSON.stringify(exitInfo)}`)
      assert(!(await portInUse(ADMIN_PORT)), 'admin port still bound after stop()')
      return `pids ${childPids.length}`
    })

    await test('🔍 daemon-host: a daemon that dies during startup rejects ready with its stderr', async () => {
      const h = startDaemonProcess({
        nodePath: process.execPath,
        nestdPath: nestd,
        // Half a path pair: nest-dir refuses it before hello is even read.
        paths: { config: configDir, capabilityBase: '', resources: null },
        key: KEY,
      })
      let err = null
      try { await h.ready } catch (e) { err = e }
      assert(err && /exited during startup/.test(err.message), `expected a startup failure, got ${err?.message}`)
      const info = await h.exited
      assert(info.expected === false, 'a startup death was reported as expected')
    })
  } finally {
    if (d && d.child.exitCode === null) d.child.kill()
  }
}

fs.rmSync(tmp, { recursive: true, force: true })
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed\n`)
if (passed !== results.length) process.exit(1)
