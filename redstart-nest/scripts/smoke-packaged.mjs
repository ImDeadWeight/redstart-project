// =============================================================================
// Packaged-build smoke test — the IPC boundary in the app that actually ships.
// =============================================================================
// Everything in scripts/test-*.mjs runs under scripts/electron-stub.mjs, where
// `app.isPackaged` is false. So the whole security suite — and every dev run —
// exercises the `http://localhost:5173` branch of renderer-location.mjs, and
// NEITHER touches the `file://` branch that ships to users.
//
// That branch fails in the worst direction. If the path comparison is wrong,
// the guard refuses every IPC call in the installed app and the launcher is
// inert: no hardware scan, no settings, no launch button. A unit test with a
// forged `isPackaged` (test-ipc-guard.mjs §4) proves the PREDICATE is right;
// only running the real binary proves the predicate is being fed the URL
// Electron actually reports.
//
// It also covers the one thing no unit test can reach: the Phase 1 navigation
// containment. `will-navigate`, `setWindowOpenHandler` and
// `will-attach-webview` are live Electron events with no stub.
//
// HOW: launch the packaged exe with --remote-debugging-port and drive its
// renderer over the Chrome DevTools Protocol, which is the only way to run
// script inside a window with contextIsolation and sandbox on. Node 22+ has a
// global WebSocket, so this needs no dependency.
//
// NOT part of `test:security` and deliberately not named `test-*.mjs`:
// scripts/test-ci-parity.mjs requires every test-*.mjs to run in CI, and CI
// does not produce a packaged build. This is a manual gate before a release.
//
// Run:  npm run build   (once)
//       node scripts/smoke-packaged.mjs
// =============================================================================

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(here, '..')

const DEBUG_PORT = 9333
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))

const results = []
let child = null

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

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

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Locate the packaged binary
// ---------------------------------------------------------------------------

const unpackedDir = path.join(repoRoot, 'release', pkg.version, 'win-unpacked')
const exePath = path.join(unpackedDir, 'Redstart Nest.exe')

if (!fs.existsSync(exePath)) {
  console.error(`\nNo packaged build at:\n  ${exePath}\n\nRun \`npm run build\` first.`)
  process.exit(2)
}

// The launcher HTML inside the asar — what createWindow() loads when packaged,
// and the string the guard must recognise.
const packagedIndex = path.join(unpackedDir, 'resources', 'app.asar', 'dist', 'index.html')
const packagedIndexUrl = pathToFileURL(packagedIndex).href

// ---------------------------------------------------------------------------
// A page an attacker could have dropped on disk. This is precisely what an
// origin-based allowlist would have accepted in a packaged build, since every
// file:// URL's origin is the string "null".
// ---------------------------------------------------------------------------

const evilPath = path.join(os.tmpdir(), 'redstart-smoke-foreign.html')
fs.writeFileSync(evilPath, '<!doctype html><title>foreign</title><h1>foreign local page</h1>')
const evilUrl = pathToFileURL(evilPath).href

// ---------------------------------------------------------------------------
// Minimal CDP client
// ---------------------------------------------------------------------------

async function cdpTargets() {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
  return await res.json()
}

async function waitForLauncherTarget(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      const targets = await cdpTargets()
      last = targets
      const page = targets.find(t => t.type === 'page' && t.url.startsWith('file:'))
      if (page?.webSocketDebuggerUrl) return page
    } catch { /* the port is not up yet */ }
    await sleep(500)
  }
  throw new Error(`no launcher page target after ${timeoutMs}ms; saw ${JSON.stringify(last)}`)
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  const pending = new Map()
  let nextId = 0
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', () => reject(new Error('CDP websocket failed')))
  })
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    const slot = pending.get(msg.id)
    if (!slot) return
    pending.delete(msg.id)
    if (msg.error) slot.reject(new Error(msg.error.message))
    else slot.resolve(msg.result)
  })
  return {
    ready,
    send(method, params = {}) {
      const id = ++nextId
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    close: () => ws.close(),
  }
}

/** Evaluate an expression in the page and return its value. */
async function evaluate(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (res.exceptionDetails) {
    const e = res.exceptionDetails
    throw new Error(e.exception?.description || e.text || 'evaluation threw')
  }
  return res.result.value
}

/** Evaluate, but hand back a thrown/rejected error as a string instead. */
async function evaluateAllowingError(cdp, expression) {
  try {
    return { ok: true, value: await evaluate(cdp, expression) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

/**
 * Call a HARDCODED function in the page, passing a runtime value in as a real
 * CDP argument instead of splicing it into a JS-source string. The two
 * navigation-containment tests below need to hand `evilUrl` to the page, and
 * building `` `location.href = ${JSON.stringify(evilUrl)}` `` — even though
 * `evilUrl` is just a `file://` URL this script builds from its own temp
 * file, never attacker input — is exactly the string-concatenation-into-code
 * shape CodeQL's js/bad-code-sanitization flags, because JSON.stringify only
 * guards against breaking out of a *string literal*, not out of the
 * surrounding expression. Runtime.callFunctionOn takes a static function
 * declaration plus an `arguments` array that CDP serializes itself, so
 * there's no source text to construct at all — the fix removes the pattern
 * rather than arguing this instance of it is safe.
 */
async function callWithArg(cdp, functionDeclaration, arg) {
  const target = await cdp.send('Runtime.evaluate', { expression: 'globalThis' })
  const res = await cdp.send('Runtime.callFunctionOn', {
    functionDeclaration,
    objectId: target.result.objectId,
    arguments: [{ value: arg }],
    awaitPromise: true,
    returnByValue: true,
  })
  if (res.exceptionDetails) {
    const e = res.exceptionDetails
    throw new Error(e.exception?.description || e.text || 'evaluation threw')
  }
  return res.result.value
}

// ---------------------------------------------------------------------------

function cleanup() {
  try { child?.kill() } catch { /* already gone */ }
  try { fs.rmSync(evilPath, { force: true }) } catch { /* ignore */ }
}

process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(130) })

console.log(`\nLaunching ${path.basename(exePath)} with CDP on ${DEBUG_PORT}…`)
console.log('(a window will open — it is closed again when the run finishes)')

// ELECTRON_RUN_AS_NODE makes an Electron binary behave as plain Node: no app,
// no window, and `import { app } from 'electron'` fails at link time with a
// confusing "Cannot read properties of undefined (reading 'exports')" from deep
// inside Node's ESM loader. Some tool environments export it. Inheriting it here
// would make a perfectly healthy build look catastrophically broken, so it is
// stripped rather than trusted.
const childEnv = { ...process.env }
if (childEnv.ELECTRON_RUN_AS_NODE) {
  delete childEnv.ELECTRON_RUN_AS_NODE
  console.log('note: ELECTRON_RUN_AS_NODE was set in this shell and has been unset for the app')
}

child = spawn(exePath, [`--remote-debugging-port=${DEBUG_PORT}`], {
  cwd: unpackedDir,
  stdio: 'ignore',
  detached: false,
  env: childEnv,
})

const page = await waitForLauncherTarget()
const cdp = connect(page.webSocketDebuggerUrl)
await cdp.ready
await cdp.send('Runtime.enable')

// ---------------------------------------------------------------------------
// §1 — the packaged renderer is where the guard thinks it is
// ---------------------------------------------------------------------------

console.log('\n-- §1 the launcher loaded from the expected location --')

// Compared case-insensitively for the same reason renderer-location.mjs
// lowercases: Windows paths are case-insensitive and Electron is not guaranteed
// to echo back the exact casing the path was built with. A case-sensitive
// compare here would fail on an app that works fine.
const sameUrl = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()

await test('🔍 the window loaded the packaged dist/index.html, not something else', () => {
  assert(
    sameUrl(page.url, packagedIndexUrl),
    `loaded ${page.url}\n        expected ${packagedIndexUrl}\n        — createWindow() and renderer-location.mjs disagree about the launcher path`
  )
  return page.url.replace(/^.*app\.asar/, '…app.asar')
})

await test('the preload ran and exposed the bridge', async () => {
  assert(await evaluate(cdp, 'typeof window.redstartAPI') === 'object', 'window.redstartAPI is missing')
})

// ---------------------------------------------------------------------------
// §2 — real IPC calls from the real packaged frame
// ---------------------------------------------------------------------------
// The load-bearing section. A wrong file:// comparison rejects every one of
// these with "Refused <channel>: sender frame is not at the launcher location",
// which is exactly the failure a dev run can never surface.

console.log('\n-- §2 guarded IPC round-trips in the packaged app --')

await test('🔍 settings:get-models-dir round-trips (the guard accepts the real frame)', async () => {
  const r = await evaluateAllowingError(cdp, 'window.redstartAPI.settings.getModelsDir()')
  assert(r.ok, `the guard REFUSED a legitimate call from the packaged launcher: ${r.error}`)
  assert(typeof r.value === 'string' && r.value, `expected a folder path, got ${JSON.stringify(r.value)}`)
  return r.value
})

await test('🔍 capabilities:get round-trips', async () => {
  const r = await evaluateAllowingError(cdp, 'window.redstartAPI.capabilities.get()')
  assert(r.ok, `refused: ${r.error}`)
  assert(r.value && typeof r.value === 'object' && 'file_system' in r.value, 'unexpected capabilities projection')
})

await test('🔍 auth:get-config round-trips', async () => {
  const r = await evaluateAllowingError(cdp, 'window.redstartAPI.auth.getConfig()')
  assert(r.ok, `refused: ${r.error}`)
  assert(typeof r.value?.authRequired === 'boolean', 'unexpected auth config shape')
})

await test('settings:get-resolved-binary still resolves a binary after the read-time check', async () => {
  // resolveBinary() now re-validates a stored serverBinPath. If that check were
  // wrong it would reject a legitimate override and silently fall through — or,
  // worse, return null and disable the launch button.
  const r = await evaluateAllowingError(cdp, 'window.redstartAPI.settings.getResolvedBinary()')
  assert(r.ok, `refused: ${r.error}`)
  return r.value ? path.basename(r.value) : 'null — no binary installed on this machine'
})

// ---------------------------------------------------------------------------
// §3 — navigation containment (Phase 1), the part with no unit coverage
// ---------------------------------------------------------------------------

console.log('\n-- §3 navigation containment --')

await test('🔍 window.open is denied', async () => {
  const before = (await cdpTargets()).filter(t => t.type === 'page').length
  const opened = await callWithArg(cdp, 'function(url) { return String(window.open(url)) }', evilUrl)
  await sleep(500)
  const after = (await cdpTargets()).filter(t => t.type === 'page').length
  assert(opened === 'null', `window.open returned ${opened} instead of null`)
  assert(after === before, `a new page target appeared (${before} -> ${after}) — the window opened anyway`)
})

await test('🔍 top-level navigation to a foreign local file is cancelled', async () => {
  // The exact case the file:// origin footgun would have allowed: a local HTML
  // file an attacker dropped on disk. Deliberately a local file rather than a
  // remote URL so the result does not depend on network reachability — an
  // offline machine would make a remote target pass vacuously.
  await callWithArg(cdp, 'function(url) { location.href = url; return 1 }', evilUrl)
  await sleep(1500)
  const url = await evaluate(cdp, 'location.href')
  assert(
    url === packagedIndexUrl,
    `the window navigated to ${url} — will-navigate did not cancel it`
  )
})

await test('🔍 navigation to a remote origin is cancelled', async () => {
  await evaluate(cdp, `(() => { location.href = 'https://example.com/'; return 1 })()`)
  await sleep(1500)
  const url = await evaluate(cdp, 'location.href')
  assert(url === packagedIndexUrl, `the window navigated to ${url}`)
})

await test('the bridge still works after the blocked navigations', async () => {
  // A cancelled navigation must not tear down the frame the guard is pinned to.
  const r = await evaluateAllowingError(cdp, 'window.redstartAPI.settings.getModelsDir()')
  assert(r.ok, `IPC broke after a blocked navigation: ${r.error}`)
})

// ---------------------------------------------------------------------------
// §4 — what the log says
// ---------------------------------------------------------------------------

console.log('\n-- §4 the log tells the operator what happened --')

// userData is `%APPDATA%\<app.getName()>`, which is package.json's `name`
// ("redstart") unless a productName is set there — electron-builder's own
// productName does not move it. Probing both candidates and taking the
// freshest log means this keeps working if that ever changes.
function findLogPath() {
  const appData = process.env.APPDATA || os.homedir()
  const candidates = ['redstart', 'Redstart Nest']
    .map(dir => path.join(appData, dir, 'redstart.log'))
    .filter(p => fs.existsSync(p))
    .map(p => ({ p, mtime: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return candidates[0]?.p ?? null
}

await test('🔍 the blocked navigations were logged, and no legitimate call was refused', async () => {
  const logPath = findLogPath()
  assert(logPath, `no redstart.log under ${process.env.APPDATA}\\{redstart, Redstart Nest}`)
  // Only this run's lines: the file is appended to across sessions.
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n')
  const startIdx = lines.map((l, i) => [l, i]).filter(([l]) => l.includes('"logger_started"')).pop()?.[1] ?? 0
  const run = lines.slice(startIdx).map(l => { try { return JSON.parse(l) } catch { return {} } })

  const denied = run.filter(r => r.event === 'navigation_denied')
  const openDenied = run.filter(r => r.event === 'window_open_denied')
  const refused = run.filter(r => r.event === 'ipc_sender_rejected')

  assert(denied.length >= 2, `expected both blocked navigations in the log, saw ${denied.length}`)
  assert(openDenied.length >= 1, 'the denied window.open was not logged')
  assert(
    refused.length === 0,
    `the guard refused ${refused.length} call(s) from the real launcher: ${JSON.stringify(refused.slice(0, 3))}`
  )
  return `${denied.length} navigations + ${openDenied.length} window.open denied, 0 false refusals`
})

// ---------------------------------------------------------------------------

cdp.close()
cleanup()

const passed = results.filter(r => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
