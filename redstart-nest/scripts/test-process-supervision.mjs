// =============================================================================
// Process supervision — reap by PID, never by name.
// =============================================================================
// killOrphanedServers() used to run `taskkill /F /IM llama-server.exe` at every
// startup and quit, killing every llama-server on the machine — including one
// started in a terminal for unrelated work. process-supervision.mjs replaces it
// with PID tracking: a startup reap only ever acts on the specific pid Nest
// itself recorded, and only after verifying the live process at that pid still
// looks like the binary that was launched.
//
// The security-critical property is the refusal, not the reap: PID reuse is
// real, and killing a recycled pid on nothing more than a matching number would
// be the exact class of bug being fixed here. These tests exercise that refusal
// against a real, currently-running process (this very script), which is the
// only thing that can be relied on to exist without spawning a fake
// llama-server binary.
//
// Run:  node scripts/test-process-supervision.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { register } from 'node:module'
import {
  writePidFile,
  readPidFile,
  deletePidFile,
  isLikelyOurProcess,
  reapStaleProcess,
} from '../electron/main/process-supervision.mjs'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-proc-sup-'))

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

console.log('\n-- pid file round trip --')

await test('writePidFile then readPidFile returns what was written', () => {
  writePidFile(tmpDir, { pid: 4242, binaryPath: 'C:\\fake\\llama-server.exe', startedAt: 123 })
  const record = readPidFile(tmpDir)
  assert(record?.pid === 4242, `expected pid 4242, got ${JSON.stringify(record)}`)
  assert(record.binaryPath === 'C:\\fake\\llama-server.exe', 'binaryPath round-tripped')
  deletePidFile(tmpDir)
})

await test('readPidFile on a missing file returns null, not a throw', () => {
  const record = readPidFile(tmpDir)
  assert(record === null, `expected null, got ${JSON.stringify(record)}`)
})

await test('readPidFile on a malformed pid file returns null (torn write, same shape as json-store)', () => {
  fs.writeFileSync(path.join(tmpDir, 'llama-server.pid'), '{not json')
  const record = readPidFile(tmpDir)
  assert(record === null, `expected null on corrupt file, got ${JSON.stringify(record)}`)
  deletePidFile(tmpDir)
})

await test('deletePidFile on an already-absent file does not throw', () => {
  deletePidFile(tmpDir) // no file present at this point
})

console.log('\n-- 🔍 the refusal: verify before kill --')

await test('🔍 a live pid with the WRONG expected binary name is refused', async () => {
  // process.pid is this very script — genuinely alive, so a name check is the
  // only thing standing between this test and killing itself.
  const isMatch = await isLikelyOurProcess(process.pid, '/definitely/not/this/process/name-xyz')
  assert(isMatch === false, 'expected refusal on a name mismatch, got a match')
})

await test('🔍 a pid that does not exist at all is refused, not treated as a match', async () => {
  // A pid vanishingly unlikely to be assigned to anything right now.
  const isMatch = await isLikelyOurProcess(999999, 'llama-server.exe')
  assert(isMatch === false, 'expected refusal for a nonexistent pid')
})

console.log('\n-- reapStaleProcess: end to end --')

await test('no pid file present: no-op, does not throw', async () => {
  await reapStaleProcess(tmpDir)
})

await test('🔍 a pid file naming the WRONG binary for a live pid is cleared but nothing is killed', async () => {
  // This process is alive (process.pid), but the recorded binary name will
  // never match "node" (or node.exe), so reapStaleProcess must not act on it —
  // and this test process must still be alive after the call to prove it.
  writePidFile(tmpDir, {
    pid: process.pid,
    binaryPath: '/not/actually/llama-server.exe',
    startedAt: Date.now(),
  })
  await reapStaleProcess(tmpDir)
  assert(readPidFile(tmpDir) === null, 'pid file should be cleared regardless of outcome')
  // If reapStaleProcess had matched and killed, this line would never run.
  assert(process.pid > 0, 'this process must still be alive')
})

await test('a pid file for a process that no longer exists is cleared without error', async () => {
  writePidFile(tmpDir, { pid: 999999, binaryPath: 'llama-server.exe', startedAt: Date.now() })
  await reapStaleProcess(tmpDir)
  assert(readPidFile(tmpDir) === null, 'pid file should be cleared')
})

// =============================================================================
// Phase 7 §7.6 — concurrent launch/stop serialisation (trap 5.5)
// =============================================================================
// An always-on daemon reachable from the tray, a browser and the Electron
// window at once makes concurrent llama:launch/server:stop calls routine, not
// a race someone has to contrive. ipc/server.mjs guards both with an
// in-flight-promise pattern; these tests exercise that guard end to end with
// a real spawned process (node itself standing in for llama-server.exe —
// what matters is that exactly one gets spawned, not what the binary is) —
// no Electron import is needed to reach it, per the module notes above
// launchServer/stopServer in ipc/server.mjs.

console.log('\n-- 🔍 Phase 7 §7.6: concurrent launch/stop serialisation --')

const concurrencyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-server-concurrency-'))

// ipc/server.mjs pulls in filesystem-mcp-provider.mjs -> trash.mjs, which
// (unlike the rest of server.mjs's dependency graph) does import 'electron'
// for its Recycle Bin support — unreachable here since fileSystem stays
// disabled throughout, but still resolved at import time. Same stub-loader
// dance as test-network-binding.mjs: register() must run before the module
// graph is resolved, so these become dynamic imports rather than static
// ones at the top of the file. REDSTART_TEST_USERDATA_DIR set first because
// electron-stub.mjs's initPaths() call reads it as soon as it is imported.
process.env.REDSTART_TEST_USERDATA_DIR = concurrencyDir
register('./auth-test-loader.mjs', import.meta.url)
await import('./electron-stub.mjs')
const { launchServer, stopServer } = await import('../electron/main/ipc/server.mjs')
const { initProcessLog } = await import('../electron/main/process-log.mjs')
initProcessLog(concurrencyDir)

// A minimal but valid buildGatewayConfig() result — every capability
// disabled, so startGateway/startMcpServer/syncFilesystemProvider have
// nothing to do beyond binding their own sockets. Same shape
// gateway-config.mjs's own "tools not enabled" branch returns.
const STUB_GATEWAY_CONFIG = {
  disabledTools: [],
  webFetch: { enabled: false, whitelistEnabled: true, allowedBaseUrls: [], activeTools: [], maxFetchTokens: 2000 },
  postgres: { enabled: false },
  documents: { enabled: false },
  sqlite: { enabled: false },
  vault: { enabled: false },
  fileSystem: { enabled: false },
  git: { enabled: false },
  scholar: { enabled: false },
}

// Well clear of Nest's own fixed ports (19080-19083, 8765, see ports.mjs) —
// this is the gateway's public port; port+2 is claimed for the MCP server.
// networkMode: false throughout, so neither the gateway/MCP binds nor
// discovery.mjs's startDiscovery() ever touch anything beyond loopback —
// startDiscovery() with networkMode false just calls stopDiscovery(), a
// no-op here.
const CONCURRENCY_PORT = 48380

function makeConcurrencyDeps() {
  return {
    serverState: { process: null, ema: 0, lastConfig: null },
    // node itself stands in for llama-server.exe — a real, long-lived child
    // process is what the guard actually has to serialize against.
    resolveBinary: () => process.execPath,
    buildArgs: () => ['-e', 'setInterval(() => {}, 60000)'],
    parseEvalTokensPerSec: () => null,
    buildGatewayConfig: () => STUB_GATEWAY_CONFIG,
    ensureFirewallRule: () => {},
    userDataDir: concurrencyDir,
    readSettings: () => ({}),
    writeSettings: () => {},
  }
}

const CONCURRENCY_CONFIG = { port: CONCURRENCY_PORT, networkMode: false, tools: { enabled: false } }

// stopServer() (like production) kills the child and returns without waiting
// for it to actually exit — fine for the daemon, but this test directory gets
// rm'd once the suite finishes, and the killed node process's own trailing
// stdout/stderr data can otherwise arrive after that, tripping process-log.mjs's
// appendLine() against an already-deleted directory. Waiting out the real
// 'exit' event here is test hygiene, not a behavior this suite is asserting.
async function stopAndWaitForExit(deps) {
  const child = deps.serverState.process
  const result = await stopServer(deps)
  if (child && child.exitCode === null) {
    await new Promise((resolve) => child.once('exit', resolve))
  }
  return result
}

await test('🔍 two concurrent launchServer() calls spawn exactly one child process', async () => {
  const deps = makeConcurrencyDeps()
  try {
    const [first, second] = await Promise.all([
      launchServer(CONCURRENCY_CONFIG, deps),
      launchServer(CONCURRENCY_CONFIG, deps),
    ])
    assert(first.success, `first launch failed: ${first.error}`)
    assert(second.success, `second launch failed: ${second.error}`)
    assert(first.pid === second.pid, `expected both callers to get the SAME pid, got ${first.pid} and ${second.pid}`)
    assert(deps.serverState.process?.pid === first.pid, 'serverState should hold exactly the one spawned process')
    return `pid ${first.pid}, shared by both callers`
  } finally {
    await stopAndWaitForExit(deps)
  }
})

await test('a launch requested while one is already running is refused, not queued', async () => {
  const deps = makeConcurrencyDeps()
  try {
    const first = await launchServer(CONCURRENCY_CONFIG, deps)
    assert(first.success, `first launch failed: ${first.error}`)
    const second = await launchServer(CONCURRENCY_CONFIG, deps)
    assert(second.success === false, 'a second, sequential launch while one is running should be refused')
    assert(/already running/i.test(second.error || ''), `expected an "already running" refusal, got ${JSON.stringify(second.error)}`)
  } finally {
    await stopAndWaitForExit(deps)
  }
})

await test('🔍 two concurrent stopServer() calls share one in-flight stop', async () => {
  const deps = makeConcurrencyDeps()
  const launch = await launchServer(CONCURRENCY_CONFIG, deps)
  assert(launch.success, `launch failed: ${launch.error}`)
  const child = deps.serverState.process
  const [a, b] = await Promise.all([stopServer(deps), stopServer(deps)])
  assert(a.success && b.success, 'both stop calls should report success')
  assert(deps.serverState.process === null, 'serverState.process should be cleared after stop')
  if (child && child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve))
})

/** Is anything listening on this loopback port? */
function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const settle = (open) => { socket.destroy(); resolve(open) }
    socket.setTimeout(1000)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

// The gap the two per-kind guards above did NOT close. `serverState.process` is
// assigned synchronously right after spawn(), but startGateway() and
// startMcpServer() are awaited AFTER it — so a stop arriving in that window
// used to run stopGateway() against a gateway that had not started yet, kill
// the child, and then watch the launch resume and bind the gateway anyway.
// The child was dead, the UI said stopped, and the public port was still open
// in front of nothing.
//
// The port is what makes this observable: serverState.process ends up null
// either way, so asserting on it would pass against the bug. A closed port is
// the difference between "the stop won" and "the stop ran too early".
await test('🔍 a stop racing a launch runs after it — no gateway left in front of nothing', async () => {
  const deps = makeConcurrencyDeps()
  const child = []
  try {
    const [launch, stop] = await Promise.all([
      launchServer(CONCURRENCY_CONFIG, deps).then((r) => { child.push(deps.serverState.process); return r }),
      stopServer(deps),
    ])
    assert(launch.success, `launch failed: ${launch.error}`)
    assert(stop.success, `stop failed: ${stop.error}`)
    assert(deps.serverState.process === null, 'the stop should have run last, leaving nothing running')
    assert(!(await portIsOpen(CONCURRENCY_PORT)), `the gateway is still listening on ${CONCURRENCY_PORT} after the stop`)
    return 'the stop queued behind the launch and tore down what it had started'
  } finally {
    const spawned = child[0]
    if (spawned && spawned.exitCode === null) await new Promise((resolve) => spawned.once('exit', resolve))
  }
})

fs.rmSync(concurrencyDir, { recursive: true, force: true })

console.log('\n' + '='.repeat(60))
const passed = results.filter(r => r.pass).length
console.log(`${passed}/${results.length} passed`)
console.log('='.repeat(60) + '\n')

fs.rmSync(tmpDir, { recursive: true, force: true })

if (passed !== results.length) process.exit(1)
