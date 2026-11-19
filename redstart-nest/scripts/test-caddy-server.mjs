// =============================================================================
// The bundled Caddy's supervisor (TLS plan C2)
// =============================================================================
// caddy-server.mjs with a fake spawn and hand-driven timers, so the restart
// policy runs without waiting real seconds. What is pinned:
//
//   - the binary is found only in the bundled / dev / install locations;
//   - the child's environment is an allowlist plus REDSTART_* secrets;
//   - a config containing a secret value is refused before it touches disk;
//   - secret values are scrubbed from every kept log line;
//   - starting → running only on Caddy's own "serving initial configuration";
//   - backoff 1 s, 2 s, 5 s, 30 s; the 5th failure in 5 min is `failed`, with
//     the port sentence when the cause was a port in use;
//   - stop() resolves only after the process exited, and never restarts;
//   - nothing throws: a missing binary is a status.
//
// Run:  node scripts/test-caddy-server.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  createCaddySupervisor, caddyBinaryCandidates, caddyEnv, caddyPaths, scrub, classifyCaddyLine,
  explainFailure, nextRestartDelay, CADDY_PID_FILE,
} from '../daemon/caddy-server.mjs'

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

const tick = () => new Promise((r) => setImmediate(r))

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A child process that does what the test tells it to. */
function fakeChild() {
  const c = new EventEmitter()
  c.stdout = new PassThrough()
  c.stderr = new PassThrough()
  c.pid = undefined                // no pid: nothing here may ever signal a real process
  c.killed = false
  c.kill = () => { c.killed = true; setImmediate(() => c.emit('exit', null, 'SIGTERM')) }
  c.say = async (obj) => { c.stdout.write((typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n'); await tick(); await tick() }
  c.crash = async (code = 1) => { c.emit('exit', code, null); await tick() }
  return c
}

function harness({ binary = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-caddy-'))
  const bin = path.join(dir, 'caddy.exe')
  if (binary) fs.writeFileSync(bin, '')
  const spawned = []
  const timers = []
  const changes = []
  let clock = 1_000_000
  const sup = createCaddySupervisor({
    configDir: dir,
    resolveBinary: () => bin,
    onStateChange: (s) => changes.push(s),
    spawn: (file, args, opts) => { const c = fakeChild(); spawned.push({ file, args, opts, child: c }); return c },
    now: () => clock,
    setTimer: (fn, ms) => { const t = { fn, ms, done: false }; timers.push(t); return t },
    clearTimer: (t) => { if (t) t.done = true },
    stopTimeoutMs: 4321,   // distinct from every backoff delay, so the harness can tell the timers apart
    baseEnv: { SystemRoot: 'C:\\Windows', PATH: '/bin', OPENAI_API_KEY: 'sk-nest-own', REDSTART_UNRELATED: 'x' },
  })
  const restartTimers = () => timers.filter((t) => !t.done && t.ms !== 4321)
  const fireRestart = async () => {
    const t = restartTimers().at(-1)
    assert(t, 'no restart scheduled')
    t.done = true
    t.fn()
    await tick()
    return t.ms
  }
  return { dir, bin, sup, spawned, timers, changes, restartTimers, fireRestart, advance: (ms) => { clock += ms }, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

const CONFIG = { admin: { disabled: true }, apps: { tls: { x: '{env.REDSTART_DNS_TOKEN}' } } }
const SECRETS = { REDSTART_DNS_TOKEN: 'dns-token-0123456789', REDSTART_PROXY_SECRET: 'proxy-secret-abcdef' }
const READY = { level: 'info', logger: 'http', msg: 'serving initial configuration' }
const PORT_TAKEN_WIN = 'Error: loading initial config: loading new config: http app module: start: listening on :443: listen tcp :443: bind: Only one usage of each socket address (protocol/network address/port) is normally permitted.'

// ---------------------------------------------------------------------------

console.log('\n-- pure helpers --')

await test('🔍 binary: bundled when packaged, deps/caddy in dev, then the install bin/; never PATH', () => {
  const packaged = caddyBinaryCandidates({ packaged: true, resourcesDir: 'R', nestRoot: 'N', configDir: 'C', platform: 'win32' })
  assert(packaged[0] === path.join('R', 'bin', 'caddy.exe'), packaged[0])
  assert(!packaged.some((p) => p.startsWith('N')), 'packaged build looks in the dev tree')
  const dev = caddyBinaryCandidates({ packaged: false, nestRoot: 'N', configDir: 'C', platform: 'linux' })
  assert(dev[0] === path.join('N', 'deps', 'caddy', 'caddy') && dev[1] === path.join('C', 'bin', 'caddy'), dev.join(','))
  assert(dev.includes(path.join('/usr/lib/redstart/bin', 'caddy')), 'no system install path on Linux')
  assert(dev.every((p) => path.isAbsolute(p) || /^[NCR]/.test(p)), 'a bare name would be a PATH lookup')
})

await test('🔍 child env: allowlist + REDSTART_* secrets only', () => {
  const env = caddyEnv({ base: { SystemRoot: 'S', OPENAI_API_KEY: 'k', AWS_SECRET_ACCESS_KEY: 'a', HOME: '/h' }, secrets: { REDSTART_DNS_TOKEN: 't0ken' } })
  assert(env.SystemRoot === 'S' && env.HOME === '/h' && env.REDSTART_DNS_TOKEN === 't0ken', JSON.stringify(env))
  assert(!('OPENAI_API_KEY' in env) && !('AWS_SECRET_ACCESS_KEY' in env), "Nest's own environment leaked into Caddy")
  let threw = false
  try { caddyEnv({ secrets: { PATH: '/evil' } }) } catch { threw = true }
  assert(threw, 'a "secret" may not overwrite PATH')
  threw = false
  try { caddyEnv({ secrets: { REDSTART_X: '' } }) } catch { threw = true }
  assert(threw, 'an empty secret was accepted')
})

await test('scrub replaces every occurrence of every secret', () => {
  const s = scrub('GET https://www.duckdns.org/update?token=abcd1234&x=abcd1234 p=zz', ['abcd1234', 'zz'])
  assert(s === 'GET https://www.duckdns.org/update?token=[redacted]&x=[redacted] p=zz', s)
})

await test('classifies Caddy log lines', () => {
  assert(classifyCaddyLine(JSON.stringify(READY)).kind === 'ready', 'ready')
  assert(classifyCaddyLine('{"level":"info","logger":"tls.obtain","msg":"certificate obtained successfully","identifier":"a.duckdns.org"}').kind === 'cert_obtained', 'obtained')
  assert(classifyCaddyLine('{"level":"info","logger":"tls.renew","msg":"certificate renewed successfully"}').kind === 'cert_renewed', 'renewed')
  const e = classifyCaddyLine('{"level":"error","logger":"tls.obtain","msg":"could not get certificate from issuer","error":"HTTP 429 rateLimited"}')
  assert(e.kind === 'acme_error' && /429/.test(e.msg), e.msg)
  assert(classifyCaddyLine(PORT_TAKEN_WIN).kind === 'error', 'plain-text Error:')
  assert(classifyCaddyLine('{"level":"info","msg":"using config from file"}').kind === 'other', 'other')
})

await test('explains port-in-use (Windows and Linux wording) and permission failures in one sentence', () => {
  assert(explainFailure(PORT_TAKEN_WIN) === 'Port 443 is in use by another program', explainFailure(PORT_TAKEN_WIN))
  const lin = 'Error: loading initial config: ... listen tcp :80: bind: address already in use'
  assert(explainFailure(lin) === 'Port 80 is in use by another program', explainFailure(lin))
  assert(explainFailure('listen tcp :443: bind: permission denied') === "Caddy isn't allowed to use port 443", 'permission')
  assert(/^Caddy stopped/.test(explainFailure(null)), 'no line')
})

await test('🔍 backoff 1 s, 2 s, 5 s, 30 s; the 5th failure in 5 minutes gives up; old failures age out', () => {
  const now = 10_000_000
  const seq = [1, 2, 3, 4].map((n) => nextRestartDelay(Array.from({ length: n }, () => now), now))
  assert(JSON.stringify(seq) === '[1000,2000,5000,30000]', JSON.stringify(seq))
  assert(nextRestartDelay(Array(5).fill(now), now) === null, '5 in the window must give up')
  assert(nextRestartDelay([now - 6 * 60_000, now - 6 * 60_000, now - 6 * 60_000, now - 6 * 60_000, now], now) === 1000, 'failures older than 5 minutes still count')
})

console.log('\n-- the supervisor --')

await test('🔍 start: config written without secrets, env carries them, starting → running on Caddy\'s ready line', async () => {
  const h = harness()
  try {
    const s = await h.sup.start({ config: CONFIG, secrets: SECRETS })
    assert(s.state === 'starting', `state ${s.state}`)
    const { configFile, storageDir } = caddyPaths(h.dir)
    const text = fs.readFileSync(configFile, 'utf8')
    assert(!text.includes(SECRETS.REDSTART_DNS_TOKEN) && text.includes('{env.REDSTART_DNS_TOKEN}'), 'config file content')
    assert(fs.existsSync(storageDir), 'storage dir not created')
    const sp = h.spawned[0]
    assert(sp.file === h.bin && JSON.stringify(sp.args) === JSON.stringify(['run', '--config', configFile]), `${sp.file} ${sp.args}`)
    assert(sp.opts.env.REDSTART_DNS_TOKEN === SECRETS.REDSTART_DNS_TOKEN && sp.opts.env.REDSTART_PROXY_SECRET === SECRETS.REDSTART_PROXY_SECRET, 'secrets not in env')
    assert(!('OPENAI_API_KEY' in sp.opts.env) && !('REDSTART_UNRELATED' in sp.opts.env), 'unlisted env passed through')
    await sp.child.say({ level: 'info', msg: 'using config from file' })
    assert(h.sup.status().state === 'starting', 'running before Caddy said so')
    await sp.child.say(READY)
    assert(h.sup.status().state === 'running', `state ${h.sup.status().state}`)
    assert(h.changes.map((c) => c.state).join(',') === 'starting,running', h.changes.map((c) => c.state).join(','))
    await h.sup.stop()
  } finally { h.cleanup() }
})

await test('🔍 a config holding a secret value is refused, and nothing is written or spawned', async () => {
  const h = harness()
  try {
    const s = await h.sup.start({ config: { apps: { token: SECRETS.REDSTART_DNS_TOKEN } }, secrets: SECRETS })
    assert(s.state === 'failed' && /secret/.test(s.reason), JSON.stringify(s))
    assert(h.spawned.length === 0, 'spawned anyway')
    assert(!fs.existsSync(caddyPaths(h.dir).configFile), 'written anyway')
  } finally { h.cleanup() }
})

await test('🔍 secret values never survive into the kept log tail or the ACME error', async () => {
  const h = harness()
  try {
    await h.sup.start({ config: CONFIG, secrets: SECRETS })
    const c = h.spawned[0].child
    await c.say({ level: 'error', logger: 'tls.obtain', msg: 'could not get certificate from issuer', error: `GET https://www.duckdns.org/update?domains=x&token=${SECRETS.REDSTART_DNS_TOKEN}: 401` })
    const joined = h.sup.tail().join('\n') + h.sup.status().lastAcmeError
    assert(!joined.includes(SECRETS.REDSTART_DNS_TOKEN), 'token kept in the log tail')
    assert(/\[redacted\]/.test(h.sup.status().lastAcmeError), h.sup.status().lastAcmeError)
    await h.sup.stop()
  } finally { h.cleanup() }
})

await test('🔍 crash loop: restarts at 1, 2, 5, 30 s, then `failed` with the port sentence', async () => {
  const h = harness()
  try {
    await h.sup.start({ config: CONFIG, secrets: SECRETS })
    const delays = []
    for (let i = 0; i < 5; i++) {
      const c = h.spawned.at(-1).child
      c.stderr.write(PORT_TAKEN_WIN + '\n')
      await tick(); await tick()
      await c.crash(1)
      h.advance(1000)
      if (i < 4) delays.push(await h.fireRestart())
    }
    assert(JSON.stringify(delays) === '[1000,2000,5000,30000]', JSON.stringify(delays))
    assert(h.spawned.length === 5, `spawned ${h.spawned.length}`)
    const s = h.sup.status()
    assert(s.state === 'failed' && /^Port 443 is in use by another program/.test(s.reason), JSON.stringify(s))
    assert(h.restartTimers().length === 0, 'still scheduling restarts after giving up')
  } finally { h.cleanup() }
})

await test('🔍 stop() resolves only after the process exited, and never restarts it', async () => {
  const h = harness()
  try {
    await h.sup.start({ config: CONFIG, secrets: SECRETS })
    const c = h.spawned[0].child
    await c.say(READY)
    let exited = false
    c.on('exit', () => { exited = true })
    await h.sup.stop()
    assert(c.killed && exited, 'stop() returned before the exit (C2b would rebind a port still held)')
    assert(h.sup.status().state === 'stopped', h.sup.status().state)
    assert(h.restartTimers().length === 0, 'a deliberate stop scheduled a restart')
    assert(!fs.existsSync(path.join(h.dir, CADDY_PID_FILE)), 'pid file left behind')
    await h.sup.stop()   // idempotent
  } finally { h.cleanup() }
})

await test('stop() during a pending restart cancels it', async () => {
  const h = harness()
  try {
    await h.sup.start({ config: CONFIG, secrets: SECRETS })
    await h.spawned[0].child.crash(1)
    assert(h.restartTimers().length === 1, 'no restart pending')
    await h.sup.stop()
    assert(h.restartTimers().length === 0 && h.sup.status().state === 'stopped', 'restart survived stop')
  } finally { h.cleanup() }
})

await test('start() while running replaces the process (config change = restart, no admin API)', async () => {
  const h = harness()
  try {
    await h.sup.start({ config: CONFIG, secrets: SECRETS })
    await h.spawned[0].child.say(READY)
    await h.sup.start({ config: { ...CONFIG, v: 2 }, secrets: SECRETS })
    assert(h.spawned.length === 2 && h.spawned[0].child.killed, 'old process not stopped first')
    assert(JSON.parse(fs.readFileSync(caddyPaths(h.dir).configFile, 'utf8')).v === 2, 'new config not written')
    await h.sup.stop()
  } finally { h.cleanup() }
})

await test('🔍 a missing binary is a status, not a throw', async () => {
  const h = harness({ binary: false })
  try {
    const s = await h.sup.start({ config: CONFIG, secrets: SECRETS })
    assert(s.state === 'failed' && /not found/.test(s.reason), JSON.stringify(s))
    assert(h.spawned.length === 0, 'spawned a missing binary')
  } finally { h.cleanup() }
})

await test('a throwing onStateChange listener does not break supervision', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-caddy-'))
  try {
    fs.writeFileSync(path.join(dir, 'c'), '')
    const sup = createCaddySupervisor({
      configDir: dir, resolveBinary: () => path.join(dir, 'c'), onStateChange: () => { throw new Error('listener bug') },
      spawn: () => fakeChild(), baseEnv: {},
    })
    const s = await sup.start({ config: CONFIG, secrets: SECRETS })
    assert(s.state === 'starting', s.state)
    await sup.stop()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
