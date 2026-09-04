// =============================================================================
// Daemon smoke test — nestd boots, serves, and stops, with no Electron
// =============================================================================
// The first test in this tree that runs the ACTUAL daemon rather than its
// modules. Every other suite imports pieces and drives them directly, which is
// what makes them fast and precise and also what makes them blind to the one
// question Phase 8A exists to answer: does `node bin/nestd.mjs` come up on a
// machine with no display, no Electron and no window manager?
//
// It spawns the real entrypoint against a temp directory and talks to it over
// real sockets. What it pins:
//
//   1. IT BOOTS AT ALL. This is not hypothetical — the 8A.2 split left four
//      modules importing Electron bindings at module top, and under plain Node
//      `import { shell } from 'electron'` is an IMPORT-time failure. The daemon
//      loaded fine inside Electron and could not load outside it, and no
//      module-level suite could have noticed.
//   2. IT STARTS NO MODEL. §7.0's ground rule: starting the daemon is never
//      starting a model. A boot that spawned llama-server would be a serious
//      regression on an appliance that boots unattended.
//   3. THE CONTROL PLANE IS GATED. An unauthenticated call gets 401, before
//      and after bootstrap.
//   4. FIRST-RUN WORKS END TO END. Token minted on disk -> POST /admin/bootstrap
//      -> login -> an authenticated call. The manual-verification backlog from
//      Phases 6 and 7 has "drive first-run setup on a real build" in it; this
//      automates the headless half of that.
//   5. THE EXIT CODES. `admin:shutdown` exits 0; a daemon that cannot bind the
//      control plane exits 1. Under a supervisor (§8B.3) those two numbers are
//      the difference between "comes back" and "stays down": get them backwards
//      and the admin UI's Shut Down button becomes one systemd undoes a second
//      later. Nothing else in the tree checks them and they are trivially easy
//      to break from either entrypoint.
//
//      NOT covered here: the crash path's own exit 1 (§7.4a's
//      uncaughtException/unhandledRejection handlers). Provoking a real crash
//      inside a real nestd needs a hook in production code that exists only for
//      this test, and a test-only backdoor into the crash path of a daemon is a
//      worse thing to own than the gap. The startup-failure branch below shares
//      the same exit code and the same supervisor consequence; the handler
//      itself is covered by scripts/test-logging.mjs at the describeCrash()
//      level. Recorded as a gap rather than papered over.
//
// SELF-SKIPS when :19083 or :8765 is already bound — i.e. when Redstart is
// running on this machine. Both ports are fixed in production (ports.mjs, so a
// client can find the daemon without being told), so a developer with the app
// open cannot run this and CI is where it actually gates. Same convention the
// Postgres and live-web cases already use.
//
// Run:  node scripts/test-daemon-smoke.mjs
// =============================================================================

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADMIN_PORT, BEACON_PORT } from '../electron/main/ports.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(here, '..')
const nestd = path.join(repoRoot, 'bin', 'nestd.mjs')
const base = `http://127.0.0.1:${ADMIN_PORT}`

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

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.setTimeout(500)
    socket.on('connect', () => { socket.destroy(); resolve(true) })
    socket.on('timeout', () => { socket.destroy(); resolve(false) })
    socket.on('error', () => resolve(false))
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------

console.log('\n-- daemon smoke (bin/nestd.mjs) --')

for (const port of [ADMIN_PORT, BEACON_PORT]) {
  if (await portInUse(port)) {
    console.log(`  SKIP - port ${port} is already in use; is Redstart running?`)
    console.log('         This suite needs the daemon\'s fixed ports to itself. CI has them.')
    console.log('\n0/0 passed (skipped)')
    process.exit(0)
  }
}

const nestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-daemon-smoke-'))

/**
 * Start nestd and wait until it answers. Returns a handle carrying the child
 * plus a promise for its eventual exit code — the exit code being half of what
 * this suite exists to check.
 */
function startDaemon(dir, extraEnv = {}) {
  const child = spawn(process.execPath, [nestd, '--dir', dir], {
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = []
  child.stdout.on('data', (b) => output.push(b.toString()))
  child.stderr.on('data', (b) => output.push(b.toString()))
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }))
  })
  return { child, output, exited, text: () => output.join('') }
}

async function waitForListening(handle, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (handle.child.exitCode !== null) {
      throw new Error(`the daemon exited (${handle.child.exitCode}) before listening:\n${handle.text()}`)
    }
    if (await portInUse(ADMIN_PORT)) return
    await sleep(200)
  }
  throw new Error(`the daemon never listened on ${ADMIN_PORT}:\n${handle.text()}`)
}

const get = (p, token) => fetch(base + p, {
  headers: token ? { Authorization: `Bearer ${token}` } : {},
})
const post = (p, body, token) => fetch(base + p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
})
// The dispatcher wants { args: [...] } — a bare array is refused, which is
// the same envelope src/api/http.ts sends.
const callMethod = (channel, args, token) =>
  post('/admin/api/' + channel.replace(':', '/'), { args }, token)

// A response body can only be read once, and a failure message that reads it
// eagerly consumes it before the assertion that would have used it. Read it
// once here and hand back both halves.
async function read(res) {
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not JSON — `text` is the message */ }
  return { status: res.status, text, json }
}

let daemon = null
let ownerToken = null

try {
  daemon = startDaemon(nestDir)
  await waitForListening(daemon)

  await test('the daemon boots with no Electron, no display, and no window', async () => {
    // The whole point of Phase 8A. If this throws, waitForListening already
    // printed the daemon's own output, which is where the reason will be.
    assert(daemon.child.exitCode === null, 'the daemon exited during startup')
    return `pid ${daemon.child.pid}`
  })

  await test('it serves the admin bundle', async () => {
    // CI never runs `vite build`, so dist/ is usually absent there and the
    // allowlist is legitimately empty (test-admin-listener.mjs pins that an
    // unbuilt tree yields an empty allowlist rather than an error). Assert
    // whichever answer is correct for this tree rather than requiring a build
    // step this suite does not otherwise need — with the unbuilt case still
    // asserting something real: that the gate, not a 404, is what answers.
    const res = await get('/')
    if (!fs.existsSync(path.join(repoRoot, 'dist', 'index.html'))) {
      assert(res.status === 401, `unbuilt tree should fall through to the gate, got ${res.status}`)
      return 'dist/ not built — gate answers instead'
    }
    assert(res.status === 200, `expected 200 for the bundle, got ${res.status}`)
  })

  await test('🔒 an unauthenticated control-plane call is refused', async () => {
    const res = await get('/admin/whoami')
    assert(res.status === 401, `expected 401 with no credentials, got ${res.status}`)
  })

  await test('🔒 the daemon started NO model', async () => {
    // §7.0's ground rule, and the one regression that would be worst on an
    // appliance that boots unattended: login/boot starts the daemon, never
    // a model. The pid file is written by process-supervision.mjs the moment
    // a llama-server is spawned, so its absence is the honest check.
    const pidFile = path.join(nestDir, 'config', 'llama-server.pid')
    assert(!fs.existsSync(pidFile), 'a llama-server pid file exists — the boot started a model')
  })

  await test('🔒 config and capability data land in two separate subtrees', async () => {
    // Phase 8B.1, and the reason this is checked against a REAL daemon rather
    // than only against the pure rule: the layout is whatever the entrypoint
    // passes to initPaths(), so a suite that only tests the rule would not
    // notice bin/nestd.mjs handing it a different one.
    //
    // Design 3.5: config is small and always wanted in a backup, capability
    // folders hold user content and restore differently; and 3.2's last-resort
    // reset ("delete accounts.json") must never sit next to a user's
    // documents. Both fail silently if the trees merge.
    const configDir = path.join(nestDir, 'config')
    const dataDir = path.join(nestDir, 'data')
    assert(fs.existsSync(configDir), `no config subtree at ${configDir}`)
    // Nest's own state is in config/, and nowhere else.
    assert(fs.existsSync(path.join(configDir, 'tools.json')), 'tools.json is not in config/')
    assert(!fs.existsSync(path.join(nestDir, 'tools.json')), 'tools.json leaked into the nest root')
    // The five folder-scoped capabilities are provisioned under data/, which
    // at level 3 is a tree the service account already owns - so the default
    // case needs no ACL grant anywhere (design 3.5's conclusion).
    assert(fs.existsSync(dataDir), `no data subtree at ${dataDir} - were capability folders provisioned?`)
    const provisioned = fs.readdirSync(dataDir, { withFileTypes: true }).filter(e => e.isDirectory())
    assert(provisioned.length > 0, 'data/ exists but no capability folders were provisioned into it')
    // And they really are separate trees, not one inside the other.
    assert(!fs.existsSync(path.join(configDir, 'data')), 'data/ ended up inside config/')
    return `${provisioned.length} capability folders under data/`
  })

  await test('🔍 the daemon records its own pid, so it can be stopped without Task Manager', async () => {
    // The tray's "Quit Redstart" is the desktop's answer; headless there is no
    // tray, so this file is what `npm run daemon:stop` signals and what
    // `daemon:status` reads. Written LAST, after the control-plane bind, so a
    // second daemon that fails to bind cannot overwrite a live one's entry.
    const pidPath = path.join(nestDir, 'config', 'nestd.pid')
    assert(fs.existsSync(pidPath), `no daemon pid file at ${pidPath}`)
    const record = JSON.parse(fs.readFileSync(pidPath, 'utf8'))
    assert(record.pid === daemon.child.pid,
      `pid file says ${record.pid}, the daemon is ${daemon.child.pid}`)
    assert(typeof record.execPath === 'string' && record.execPath,
      'no execPath recorded — nothing could tell this pid from a recycled one')
    return `pid ${record.pid}`
  })

  await test('the bootstrap token was minted on disk at first run', async () => {
    const tokenPath = path.join(nestDir, 'config', 'bootstrap-token.txt')
    assert(fs.existsSync(tokenPath), `no bootstrap token at ${tokenPath}`)
    const token = fs.readFileSync(tokenPath, 'utf8').trim()
    assert(token.length >= 16, `implausibly short token: ${JSON.stringify(token)}`)
    return `${token.length} chars`
  })

  await test('🔍 first-run bootstrap creates the owner, and login returns a session', async () => {
    // The headless half of the manual first-run verification Phases 6 and 7
    // both left open. On an appliance this is the flow that reads the token
    // off a chassis label (§3.2); here it reads the same file the Electron
    // client reads.
    const token = fs.readFileSync(path.join(nestDir, 'config', 'bootstrap-token.txt'), 'utf8').trim()
    const created = await read(await post('/admin/bootstrap', {
      token, username: 'owner', password: 'smoke-test-pw-1234',
    }))
    assert(created.status === 200, `bootstrap failed (${created.status}): ${created.text}`)

    const login = await read(await post('/admin/auth/login', {
      username: 'owner', password: 'smoke-test-pw-1234',
    }))
    assert(login.status === 200, `login failed (${login.status}): ${login.text}`)
    ownerToken = login.json?.token
    assert(typeof ownerToken === 'string' && ownerToken, `no session token: ${login.text}`)
  })

  await test('🔍 an authenticated control-plane method round-trips', async () => {
    assert(ownerToken, 'no session from the previous case')
    const res = await read(await callMethod('admin:get-control-plane', [], ownerToken))
    assert(res.status === 200, `expected 200, got ${res.status}: ${res.text}`)
    assert(res.json?.result, `no result in ${res.text}`)
    assert(res.json.result.port === ADMIN_PORT, `daemon reports port ${res.json.result.port}`)
  })

  await test('🔒 start-at-login reports unsupported on a headless daemon', async () => {
    // 8A.5's honesty rule, checked against the REAL entrypoint rather than a
    // cleared capability in a unit test: nestd registers no login item, so the
    // toggle must say so rather than answer false as though it were a setting.
    const res = await read(await callMethod('admin:get-startup', [], ownerToken))
    assert(res.status === 200, `expected 200, got ${res.status}: ${res.text}`)
    assert(res.json?.result?.supported === false, `expected supported:false, got ${res.text}`)
  })

  await test('🔍 the headless daemon can find a server binary to launch', async () => {
    // Not "can it load a model" — that needs gigabytes and a GPU. This is the
    // step before: does resolveBinary() find llama-server from a plain-Node
    // daemon, given the POSIX/Windows candidate list 8A.3 rewrote? If it
    // cannot, every launch from a headless install fails at the first hurdle,
    // and nothing else in this suite would notice.
    const res = await read(await callMethod('settings:get-resolved-binary', [], ownerToken))
    assert(res.status === 200, `expected 200, got ${res.status}: ${res.text}`)
    const resolved = res.json?.result
    // A checkout without a built llama-server is a legitimate state (CI is
    // one), so absence is reported rather than failed — what must hold is that
    // the daemon ANSWERS the question rather than throwing, and that when it
    // does find one it is a real path.
    if (!resolved || (typeof resolved === 'object' && !resolved.path)) {
      return 'no llama-server built in this tree'
    }
    const binaryPath = typeof resolved === 'string' ? resolved : resolved.path
    assert(path.isAbsolute(binaryPath), `not an absolute path: ${binaryPath}`)
    assert(fs.existsSync(binaryPath), `resolved a binary that does not exist: ${binaryPath}`)
    return path.basename(binaryPath)
  })

  await test('🔍 the SSE feed opens and replays', async () => {
    // Phase 5's live feed, over a real socket. The first event is always the
    // ring-buffer replay, so a reconnecting client sees history rather than an
    // empty terminal — that is what makes it assertable without provoking a
    // log line first.
    const controller = new AbortController()
    // fetch() + a stream reader, not EventSource — the listener authenticates
    // on the Authorization header only, which native EventSource cannot send.
    // That is the same thing src/api/http.ts does, and this is the first test
    // that proves it works against the real listener over a real socket.
    const res = await fetch(`${base}/admin/events`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
      signal: controller.signal,
    })
    assert(res.status === 200, `expected 200, got ${res.status}`)
    assert(/text\/event-stream/.test(res.headers.get('content-type') ?? ''),
      `not an event stream: ${res.headers.get('content-type')}`)
    const reader = res.body.getReader()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const { value } = await reader.read()
      const chunk = new TextDecoder().decode(value ?? new Uint8Array())
      assert(chunk.startsWith('data: '), `unexpected first chunk: ${JSON.stringify(chunk.slice(0, 80))}`)
      const event = JSON.parse(chunk.slice('data: '.length).split('\n')[0])
      assert(event.type === 'replay', `expected a replay event first, got ${JSON.stringify(event)}`)
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  })

  await test('🔍 the status readout carries a version handshake', async () => {
    // Phase 8A.6 (trap 5.7). Checked against the real daemon because that is
    // the only place the API revision is computed from the table actually
    // registered — a unit test can only check the function that computes it.
    const res = await read(await callMethod('admin:get-status', [], ownerToken))
    assert(res.status === 200, `expected 200, got ${res.status}: ${res.text}`)
    const version = res.json?.result?.version
    assert(version, `no version block: ${res.text}`)
    assert(typeof version.app === 'string' && version.app !== 'unknown',
      `the daemon could not read its own package.json: ${JSON.stringify(version)}`)
    assert(typeof version.apiRevision === 'string' && version.apiRevision.length === 12,
      `unexpected apiRevision: ${JSON.stringify(version)}`)
    return `${version.app} / ${version.apiRevision}`
  })

  await test('🔒 a second daemon refuses to start and exits 1', async () => {
    // 8A.2's adminBindFailureIsFatal decision, checked for real. On the
    // desktop a failed control-plane bind is survivable (there is a window to
    // notice); headless it is not, because the process already holding
    // :19083 is the one actually in charge and a second daemon owning nothing
    // has no way to tell anyone. Exit 1 is right here even though nothing
    // crashed: a supervisor SHOULD retry, since the usual cause is a
    // slow-releasing socket from the previous run.
    const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-daemon-second-'))
    const second = startDaemon(secondDir)
    const { code } = await second.exited
    assert(code === 1, `a daemon that could not bind exited ${code}, expected 1`)
    assert(/fail|EADDRINUSE|listen/i.test(second.text()),
      `the bind failure was not reported:
${second.text()}`)
    fs.rmSync(secondDir, { recursive: true, force: true })
    return 'exit 1'
  })

  await test('🔍 admin:shutdown stops the daemon and exits 0', async () => {
    // THE CONTRACT (§8A.2, §8B.3). 0 means a human meant it: a supervisor must
    // leave it down. The response also has to arrive before the socket closes,
    // or a caller cannot tell a successful shutdown from a crash.
    const res = await read(await callMethod('admin:shutdown', [], ownerToken))
    assert(res.status === 200, `shutdown did not answer 200, got ${res.status}: ${res.text}`)
    const { code, signal } = await daemon.exited
    assert(signal === null, `the daemon was signalled (${signal}) rather than exiting on its own`)
    assert(code === 0, `deliberate shutdown exited ${code}, expected 0 — a supervisor would restart this`)
    return 'exit 0'
  })

  await test('the port is released and the pid file is gone', async () => {
    // Both are what a restart depends on. A daemon that exits without
    // releasing :19083 makes its own next start fail.
    assert(!(await portInUse(ADMIN_PORT)), `${ADMIN_PORT} is still bound after shutdown`)
    assert(!fs.existsSync(path.join(nestDir, 'config', 'llama-server.pid')),
      'a llama-server pid file survived shutdown')
    // The daemon's OWN pid file goes too, on a clean exit. A stale one left
    // behind would make `daemon:status` report a daemon that is not there.
    assert(!fs.existsSync(path.join(nestDir, 'config', 'nestd.pid')),
      'the daemon pid file survived a clean shutdown')
  })

} finally {
  if (daemon && daemon.child.exitCode === null) {
    daemon.child.kill()
    await Promise.race([daemon.exited, sleep(5000)])
  }
  fs.rmSync(nestDir, { recursive: true, force: true })
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
