// =============================================================================
// Model pause/resume suite — suspendModel / resumeModel in daemon/ipc/server.mjs
// and the pause state in daemon/completion-activity.mjs.
// =============================================================================
// Image generation frees the GPU by pausing the chat model. What has to hold:
//
//   - a pause kills ONLY the llama-server child: the gateway and the MCP
//     server stay listening (the image tool's own answer goes back through
//     the MCP server), and nobody is told the server stopped
//   - while paused the upstream port reads null (tasks wait, the memory
//     review idles), status says 'suspended', and Launch is refused
//   - resume restarts the SAME config, restores the port, and wakes everyone
//     waiting on whenModelReady() with true
//   - Stop while paused wins: the resume finds nothing to do, waiters get false
//   - a resume that fails ends in a full stop, but only after a delay, so the
//     image tool's answer is not cut off by the stop's connection teardown
//
// node stands in for llama-server: a tiny HTTP server on port+1 answering
// /health, which is what resume waits for. Run: node scripts/test-model-suspend.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { registerElectronStub } from './electron-stub-hooks.mjs'

const results = []
async function test(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false, err })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-model-suspend-'))
process.env.REDSTART_TEST_USERDATA_DIR = dir
registerElectronStub()
await import('./electron-stub.mjs')
const { launchServer, stopServer, suspendModel, resumeModel, getServerStatus } = await import('../daemon/ipc/server.mjs')
const { getFullStatus } = await import('../daemon/ipc/admin.mjs')
const { getUpstreamPort, modelSuspension, whenModelReady } = await import('../daemon/completion-activity.mjs')
const { subscribeToEvents } = await import('../daemon/event-broker.mjs')
const { initProcessLog } = await import('../daemon/process-log.mjs')
initProcessLog(dir)

const STUB_GATEWAY_CONFIG = {
  disabledTools: [],
  webFetch: { enabled: false, whitelistEnabled: true, allowedBaseUrls: [], activeTools: [], maxFetchTokens: 2000 },
  postgres: { enabled: false }, documents: { enabled: false }, sqlite: { enabled: false }, vault: { enabled: false },
  fileSystem: { enabled: false }, git: { enabled: false }, scholar: { enabled: false },
}

const PORT = 48480
const CONFIG = { port: PORT, networkMode: false, tools: { enabled: false }, modelPath: 'fake.gguf' }

// A llama-server stand-in: answers /health on port+1 after `delayMs`.
const fakeLlama = (config, delayMs = 0) => ['-e',
  `setTimeout(() => require('http').createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(q.url === '/props' ? { modalities: { vision: false } } : { status: 'ok' })) }).listen(${config.port + 1}, '127.0.0.1'), ${delayMs})`]

function makeDeps(buildArgs = (c) => fakeLlama(c)) {
  return {
    serverState: { process: null, ema: 0, lastConfig: null },
    resolveBinary: () => process.execPath,
    buildArgs,
    parseEvalTokensPerSec: () => null,
    buildGatewayConfig: () => STUB_GATEWAY_CONFIG,
    userDataDir: dir,
    readSettings: () => ({}),
    writeSettings: () => {},
  }
}

function listening(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1')
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => resolve(false))
  })
}
async function untilHealthy(port, ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true } catch {}
    await sleep(100)
  }
  return false
}
async function stopAndWait(deps) {
  const child = deps.serverState.process
  await stopServer(deps)
  if (child && child.exitCode === null) await new Promise((r) => child.once('exit', r))
}

const events = []
subscribeToEvents((channel) => { if (channel.startsWith('server:') && channel !== 'server:log' && channel !== 'server:tpm') events.push(channel) })

// ---------------------------------------------------------------------------
console.log('\n-- pause --')

await test('🔍 a pause kills only the model: gateway and MCP server keep listening, nobody hears "stopped"', async () => {
  const deps = makeDeps()
  try {
    const launch = await launchServer(CONFIG, deps)
    assert(launch.success, launch.error)
    assert(await untilHealthy(PORT + 1), 'fake model never came up')
    const pid = deps.serverState.process.pid
    events.length = 0
    const r = await suspendModel(deps)
    assert(r.ok, JSON.stringify(r))
    assert(deps.serverState.process === null, 'the child is still recorded')
    assert(!(await listening(PORT + 1)), 'the model port still answers: the child was not killed')
    assert(await listening(PORT), 'the GATEWAY went down with the model')
    assert(await listening(PORT + 2), 'the MCP SERVER went down with the model')
    assert(!events.includes('server:stopped'), `published ${events.join(', ')}`)
    assert(events.includes('server:suspended'), 'no server:suspended event')
    assert(deps.serverState.lastConfig === CONFIG, 'lastConfig was dropped; the resume has nothing to start')
    return `pid ${pid} gone, ports ${PORT} and ${PORT + 2} still up`
  } finally {
    await stopAndWait(deps)
  }
})

await test('🔍 while paused: upstream port null, status suspended (still running), Launch refused', async () => {
  const deps = makeDeps()
  try {
    assert((await launchServer(CONFIG, deps)).success, 'launch')
    assert(await untilHealthy(PORT + 1), 'fake model never came up')
    assert(getUpstreamPort() === PORT + 1, `upstream ${getUpstreamPort()} before the pause`)
    await suspendModel(deps, { reason: 'image generation' })
    assert(getUpstreamPort() === null, `upstream ${getUpstreamPort()} while paused`)
    assert(modelSuspension()?.reason === 'image generation', JSON.stringify(modelSuspension()))
    const st = await getServerStatus(CONFIG, deps)
    assert(st.running === true && st.health === 'suspended', JSON.stringify(st))
    const full = getFullStatus(deps)
    assert(full.running === true && full.suspended?.reason === 'image generation', JSON.stringify({ running: full.running, suspended: full.suspended }))
    const again = await launchServer(CONFIG, deps)
    assert(again.success === false && /paused/i.test(again.error), JSON.stringify(again))
    assert((await suspendModel(deps)).already === true, 'a second pause did not report already-paused')
  } finally {
    await stopAndWait(deps)
  }
})

await test('a pause with no model running says so and changes nothing', async () => {
  const deps = makeDeps()
  const r = await suspendModel(deps)
  assert(r.ok === false && r.notRunning === true, JSON.stringify(r))
  assert(modelSuspension() === null, 'a pause was recorded with nothing to pause')
})

// ---------------------------------------------------------------------------
console.log('\n-- resume --')

await test('🔍 resume starts the same config, restores the port, and wakes the waiters', async () => {
  const deps = makeDeps((c) => fakeLlama(c, 300))
  try {
    assert((await launchServer(CONFIG, deps)).success, 'launch')
    assert(await untilHealthy(PORT + 1), 'fake model never came up')
    const firstPid = deps.serverState.process.pid
    await suspendModel(deps)
    const waiting = whenModelReady(30000)
    events.length = 0
    const r = await resumeModel(deps)
    assert(r.ok && typeof r.ms === 'number', JSON.stringify(r))
    assert(await waiting === true, 'a waiter was not told the model is back')
    assert(deps.serverState.process && deps.serverState.process.pid !== firstPid, 'no new process')
    assert(deps.serverState.lastConfig === CONFIG, 'resumed with a different config')
    assert(deps.serverState.suspended === null && modelSuspension() === null, 'still marked paused')
    assert(getUpstreamPort() === PORT + 1, `upstream ${getUpstreamPort()} after resume`)
    assert(await untilHealthy(PORT + 1, 2000), 'the resumed model does not answer')
    assert(events.includes('server:resumed') && !events.includes('server:started'), events.join(', '))
    return `${r.ms} ms to healthy`
  } finally {
    await stopAndWait(deps)
  }
})

await test('a resume with nothing paused is a no-op', async () => {
  const r = await resumeModel(makeDeps())
  assert(r.ok && r.skipped, JSON.stringify(r))
})

await test('whenModelReady times out to false, and is immediately true when nothing is paused', async () => {
  assert(await whenModelReady(10) === true, 'not paused, yet not ready')
  const deps = makeDeps()
  try {
    assert((await launchServer(CONFIG, deps)).success, 'launch')
    assert(await untilHealthy(PORT + 1), 'fake model never came up')
    await suspendModel(deps)
    assert(await whenModelReady(50) === false, 'a timed-out wait said ready')
    const ac = new AbortController()
    const p = whenModelReady(30000, ac.signal)
    ac.abort()
    assert(await p === false, 'an aborted wait said ready')
  } finally {
    await stopAndWait(deps)
  }
})

// ---------------------------------------------------------------------------
console.log('\n-- stop and failure --')

await test('🔍 Stop while paused wins: no resume, waiters told false, "stopped" published', async () => {
  const deps = makeDeps()
  assert((await launchServer(CONFIG, deps)).success, 'launch')
  assert(await untilHealthy(PORT + 1), 'fake model never came up')
  await suspendModel(deps)
  const waiting = whenModelReady(30000)
  events.length = 0
  await stopServer(deps)
  assert(await waiting === false, 'a waiter was told the model is back after Stop')
  assert(events.includes('server:stopped'), `published ${events.join(', ')}`)
  const r = await resumeModel(deps)
  assert(r.skipped === true, `the resume ran after Stop: ${JSON.stringify(r)}`)
  assert(deps.serverState.process === null, 'a model is running after Stop')
  assert(!(await listening(PORT)), 'the gateway survived Stop')
})

await test('🔍 a resume that fails ends in a full stop, after a delay that lets the tool answer', async () => {
  let crash = false
  // The second spawn (the resume) exits at once with an error.
  const deps = makeDeps((c) => crash ? ['-e', 'process.exit(3)'] : fakeLlama(c))
  assert((await launchServer(CONFIG, deps)).success, 'launch')
  assert(await untilHealthy(PORT + 1), 'fake model never came up')
  await suspendModel(deps)
  crash = true
  const waiting = whenModelReady(30000)
  const r = await resumeModel(deps, { readyTimeoutMs: 5000 })
  assert(r.ok === false && /did not come back|code 3/.test(r.error), JSON.stringify(r))
  assert(await waiting === false, 'a waiter was told the model is back')
  assert(deps.serverState.lastError, 'no lastError recorded')
  assert(await listening(PORT + 2), 'the MCP server was torn down at once, cutting off the tool answer')
  await sleep(3500)
  assert(!(await listening(PORT)) && !(await listening(PORT + 2)), 'the failed resume never stopped the server')
  return r.error
})

await test('a pause and a Stop requested together are ordered, not interleaved', async () => {
  const deps = makeDeps()
  assert((await launchServer(CONFIG, deps)).success, 'launch')
  assert(await untilHealthy(PORT + 1), 'fake model never came up')
  const [p, s] = await Promise.all([suspendModel(deps), stopServer(deps)])
  assert(p.ok && s.success, JSON.stringify({ p, s }))
  assert(deps.serverState.suspended === null && deps.serverState.process === null, 'left paused or running after Stop')
  assert(modelSuspension() === null, 'pause state survived Stop')
})

// ---------------------------------------------------------------------------
console.log('\n-- draining, and holding requests at the gateway --')

const http = await import('node:http')
const { holdWhilePaused } = await import('../daemon/gateway/model-hold.mjs')

await test('🔍 the pause holds new requests FIRST, then waits for replies already streaming, then kills', async () => {
  const deps = makeDeps()
  try {
    assert((await launchServer(CONFIG, deps)).success, 'launch')
    assert(await untilHealthy(PORT + 1), 'fake model never came up')
    let streaming = 1
    const t0 = Date.now()
    const pausing = suspendModel(deps, { inFlight: () => streaming })
    await sleep(50)
    assert(modelSuspension() !== null, 'new requests are not held while the pause drains')
    assert(deps.serverState.process !== null, 'the model was killed with a reply still streaming')
    await sleep(250)
    streaming = 0
    const r = await pausing
    assert(r.ok && Date.now() - t0 >= 300, `${JSON.stringify(r)} after ${Date.now() - t0} ms`)
    assert(deps.serverState.process === null, 'not killed after the drain')
  } finally {
    await stopAndWait(deps)
  }
})

await test('🔍 a reply that will not finish within the drain time: the GPU is not taken, and nothing changes', async () => {
  const deps = makeDeps()
  try {
    assert((await launchServer(CONFIG, deps)).success, 'launch')
    assert(await untilHealthy(PORT + 1), 'fake model never came up')
    const pid = deps.serverState.process.pid
    const r = await suspendModel(deps, { inFlight: () => 1, drainTimeoutMs: 200 })
    assert(r.ok === false && r.busy === true, JSON.stringify(r))
    assert(deps.serverState.process?.pid === pid && deps.serverState.suspended == null, 'the model was paused anyway')
    assert(modelSuspension() === null && getUpstreamPort() === PORT + 1, 'pause state or port not restored')
  } finally {
    await stopAndWait(deps)
  }
})

await test('🔍 a request to the gateway during the pause waits, and is answered once the model is back', async () => {
  const deps = makeDeps((c) => fakeLlama(c, 200))
  try {
    assert((await launchServer(CONFIG, deps)).success, 'launch')
    assert(await untilHealthy(PORT + 1), 'fake model never came up')
    await suspendModel(deps)
    const t0 = Date.now()
    const held = fetch(`http://127.0.0.1:${PORT}/index.html`).then(async (r) => ({ status: r.status, ms: Date.now() - t0 }))
    await sleep(400)
    const r = await resumeModel(deps)
    assert(r.ok, JSON.stringify(r))
    const got = await held
    assert(got.status === 200 && got.ms >= 400, `held request: ${JSON.stringify(got)}`)
    return `answered after ${got.ms} ms`
  } finally {
    await stopAndWait(deps)
  }
})

// holdWhilePaused on its own server, so the 503 shapes and the hang-up can be
// driven with short timeouts.
let lastHold = null
const holdServer = http.createServer(async (req, res) => {
  lastHold = await holdWhilePaused(req, res, { holdMs: Number(new URL(req.url, 'http://x').searchParams.get('hold') || 100) })
  if (lastHold) res.end('forwarded')
})
await new Promise((r) => holdServer.listen(0, '127.0.0.1', r))
const holdUrl = (p) => `http://127.0.0.1:${holdServer.address().port}${p}`

await test('🔍 a hold that runs out answers 503: OpenAI-shaped for the API, text for a page', async () => {
  const deps = makeDeps()
  try {
    assert((await launchServer(CONFIG, deps)).success, 'launch')
    assert(await untilHealthy(PORT + 1), 'fake model never came up')
    await suspendModel(deps)
    const api = await fetch(holdUrl('/v1/chat/completions?hold=80'), { method: 'POST', body: '{}' })
    const body = await api.json()
    assert(api.status === 503 && body.error?.type === 'model_paused' && api.headers.get('retry-after'), `${api.status} ${JSON.stringify(body)}`)
    const page = await fetch(holdUrl('/index.html?hold=80'))
    assert(page.status === 503 && /paused/.test(await page.text()), `page: ${page.status}`)
  } finally {
    await stopAndWait(deps)
  }
  const after = await fetch(holdUrl('/index.html'))
  assert(await after.text() === 'forwarded', 'not paused, yet held')
})

await test('a client that hangs up stops waiting', async () => {
  const deps = makeDeps()
  try {
    assert((await launchServer(CONFIG, deps)).success, 'launch')
    assert(await untilHealthy(PORT + 1), 'fake model never came up')
    await suspendModel(deps)
    lastHold = null
    const ac = new AbortController()
    const p = fetch(holdUrl('/index.html?hold=30000'), { signal: ac.signal }).catch(() => 'aborted')
    await sleep(100)
    ac.abort()
    await p
    await sleep(100)
    assert(lastHold === false, `the hold did not end on hang-up (${lastHold})`)
  } finally {
    await stopAndWait(deps)
  }
})

await test('🔍 Stop during a hold answers the held request at once, saying the model is not running', async () => {
  const deps = makeDeps()
  assert((await launchServer(CONFIG, deps)).success, 'launch')
  assert(await untilHealthy(PORT + 1), 'fake model never came up')
  await suspendModel(deps)
  const t0 = Date.now()
  const held = fetch(holdUrl('/v1/chat/completions?hold=30000'), { method: 'POST', body: '{}' })
  await sleep(100)
  await stopServer(deps)
  const res = await held
  const body = await res.json()
  assert(res.status === 503 && /not running/.test(body.error.message) && Date.now() - t0 < 5000, `${res.status} ${body.error?.message}`)
})

holdServer.close()

// ---------------------------------------------------------------------------

await sleep(200)
fs.rmSync(dir, { recursive: true, force: true })
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
