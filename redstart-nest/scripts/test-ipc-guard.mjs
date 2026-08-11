// =============================================================================
// IPC sender guard — the renderer → main trust boundary.
// =============================================================================
// Two invariants, and the second is worthless without the first.
//
// 1. NO HANDLER OPTS OUT. Every channel registers through
//    electron/main/ipc/guard.mjs, never through `ipcMain.handle` directly. A
//    wrapper each handler *remembers* to use is a convention; a check that
//    fails the build is an invariant. Deliberately a static scan rather than a
//    global monkey-patch of ipcMain at startup — patching would give the same
//    guarantee invisibly, and it would fight the recording stub in
//    scripts/electron-stub.mjs that the IPC suites are built on.
//
// 2. THE GUARD ACTUALLY REJECTS. Handlers are driven with forged events:
//    wrong webContents, a subframe, a frame that has been navigated away, a
//    destroyed frame, and the fail-closed case where no window is pinned at
//    all.
//
// The canonical target is `settings:set-binary-path` because it is the head of
// the escalation chain this boundary exists to break:
//
//    settings:set-binary-path  →  settings.serverBinPath = "C:\evil.exe"
//    llama:launch              →  resolveBinary() returns it → spawn(...)
//
// so every rejection here also asserts that settings.json on disk is UNCHANGED.
// A guard that refuses the call but writes the value anyway would pass a
// return-value assertion and fail the actual security property.
//
// The last section covers the argument shapes (ipc/validate.mjs) that stop a
// *trusted* sender from sending nonsense — a different layer from the guard,
// checked here because it protects the same channels.
//
// Run:  node scripts/test-ipc-guard.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(here, '..')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-ipc-guard-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir

register('./auth-test-loader.mjs', import.meta.url)

const { ipcMain } = await import('./electron-stub.mjs')
const { setTrustedWindow } = await import('../electron/main/ipc/guard.mjs')
const { makeFakeWindow, makeEvent, trustedEventFor } = await import('./lib/fake-ipc-event.mjs')

// ---------------------------------------------------------------------------
// Tiny test harness (same shape as the sibling suites)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// §1 — no handler registers outside the guard
// ---------------------------------------------------------------------------

console.log('\n-- §1 every handler goes through the guard --')

const mainDir = path.join(repoRoot, 'electron', 'main')

function mainProcessSources() {
  const files = []
  for (const dir of [mainDir, path.join(mainDir, 'ipc')]) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.mjs')) continue
      files.push({ rel: path.relative(repoRoot, path.join(dir, name)), src: fs.readFileSync(path.join(dir, name), 'utf8') })
    }
  }
  return files
}

// Comments in guard.mjs and elsewhere legitimately NAME the raw call while
// explaining why it must not be used, so prose is stripped before scanning.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

await test('🔍 no module calls ipcMain.handle directly — guard.mjs is the only registrar', () => {
  const offenders = mainProcessSources()
    .filter(f => f.rel !== path.join('electron', 'main', 'ipc', 'guard.mjs'))
    .filter(f => /ipcMain\s*\.\s*handle\s*\(/.test(stripComments(f.src)))
    .map(f => f.rel)
  assert(
    offenders.length === 0,
    `these register IPC handlers without sender validation — import { handle } from './guard.mjs' instead: ${offenders.join(', ')}`
  )
})

await test('🔍 no module registers a bare ipcMain.on listener', () => {
  // `handle` is the only registration form the guard wraps. An `ipcMain.on`
  // listener would be a channel with no sender check and no way to reject,
  // which is why there are currently none and why there must stay none.
  const offenders = mainProcessSources()
    .filter(f => /ipcMain\s*\.\s*on\s*\(/.test(stripComments(f.src)))
    .map(f => f.rel)
  assert(offenders.length === 0, `unguarded ipcMain.on listeners: ${offenders.join(', ')}`)
})

await test('guard.mjs is the module that owns the raw call', () => {
  const src = fs.readFileSync(path.join(mainDir, 'ipc', 'guard.mjs'), 'utf8')
  assert(/ipcMain\s*\.\s*handle\s*\(/.test(stripComments(src)), 'guard.mjs no longer registers anything')
})

// ---------------------------------------------------------------------------
// §2 — the guard rejects untrusted senders
// ---------------------------------------------------------------------------
// Real settings read/write against the temp userData dir, so a rejection can be
// checked against the FILE rather than only against the return value.

const settingsPath = path.join(tmpDir, 'settings.json')

function readSettings() {
  if (!fs.existsSync(settingsPath)) return {}
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')) } catch { return {} }
}

function writeSettings(data) {
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf8')
}

// A real file that passes ipc/validate.mjs's checks, so the happy path is
// exercised end to end rather than short-circuiting on validation.
const goodBinary = path.join(tmpDir, 'llama-server.exe')
fs.writeFileSync(goodBinary, 'MZ')

const { registerSettingsHandlers } = await import('../electron/main/ipc/settings.mjs')
registerSettingsHandlers({
  readSettings,
  writeSettings,
  resolveBinary: () => null,
  selectBinaryDefaultPath: tmpDir,
  resolveModelsDir: () => tmpDir,
})

const setBinaryPath = ipcMain.handlers.get('settings:set-binary-path')
assert(typeof setBinaryPath === 'function', 'settings:set-binary-path did not register')

const EVIL = 'C:\\evil.exe'

/** Invoke with a forged event and assert both the refusal and the file. */
async function expectRejected(event, why) {
  const before = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : null
  let threw = false
  try {
    await setBinaryPath(event, EVIL)
  } catch (err) {
    threw = true
    assert(/^Refused settings:set-binary-path:/.test(err.message), `rejected for the wrong reason: ${err.message}`)
  }
  assert(threw, `${why} was ACCEPTED — the escalation chain is open`)
  const after = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : null
  assert(after === before, `${why} was refused but settings.json changed anyway`)
  assert(readSettings().serverBinPath !== EVIL, `${why} still wrote serverBinPath`)
}

console.log('\n-- §2 sender validation --')

// FIRST, before any window is pinned — the fail-closed case. Ordering matters:
// once setTrustedWindow() runs there is no way back to this state.
await test('🔍 with no trusted window registered at all, every call is refused (fails closed)', async () => {
  await expectRejected(trustedEventFor(makeFakeWindow()), 'a call before setTrustedWindow()')
})

const launcher = makeFakeWindow()
setTrustedWindow(launcher.win)

await test('🔍 a forged sender (a different webContents) is refused', async () => {
  const other = makeFakeWindow()
  await expectRejected(trustedEventFor(other), 'a call from another webContents')
})

await test('🔍 a subframe of the trusted window is refused', async () => {
  // An iframe inside the launcher — same webContents, different frame. This is
  // the case a plain `event.sender` check misses.
  const subframe = { url: 'https://evil.example/embedded' }
  await expectRejected(makeEvent(launcher.webContents, subframe), 'a call from a subframe')
})

await test('🔍 the right sender at the WRONG URL is refused (the post-navigation case)', async () => {
  // webContents.mainFrame still resolves to the current main frame after a
  // cross-origin navigation, so identity alone still passes here. Only the URL
  // check catches it — this is the assertion that proves step 5 of the guard is
  // not redundant with step 2.
  const navigated = makeFakeWindow('https://evil.example/')
  setTrustedWindow(navigated.win)
  try {
    await expectRejected(trustedEventFor(navigated), 'a call from a navigated window')
  } finally {
    setTrustedWindow(launcher.win)
  }
})

await test('🔍 a null senderFrame is refused, not waved through', async () => {
  // Null means the frame is already destroyed. It is NOT "no frame, therefore
  // nothing to validate".
  await expectRejected(makeEvent(launcher.webContents, null), 'a call with no sender frame')
})

await test('a senderFrame that throws on access (destroyed frame) is refused', async () => {
  const event = {
    sender: launcher.webContents,
    get senderFrame() { throw new Error('Object has been destroyed') },
  }
  await expectRejected(event, 'a call whose frame access throws')
})

await test('🔍 the real launcher window is let through and the write lands', async () => {
  const ok = await setBinaryPath(trustedEventFor(launcher), goodBinary)
  assert(ok === true, 'the legitimate call did not report success')
  assert(readSettings().serverBinPath === goodBinary, 'the legitimate call did not write serverBinPath')
})

// ---------------------------------------------------------------------------
// §3 — argument shapes (ipc/validate.mjs)
// ---------------------------------------------------------------------------
// A different layer from the guard: these stop a TRUSTED sender from sending
// nonsense. Checked on the same channels because they protect the same paths.

console.log('\n-- §3 argument validation on the mutating channels --')

const trusted = trustedEventFor(launcher)

await test('🔍 set-binary-path refuses a path that is not an existing .exe', async () => {
  for (const bad of [EVIL, path.join(tmpDir, 'notes.txt'), 'llama-server.exe', 42, {}]) {
    const before = readSettings().serverBinPath
    const ok = await setBinaryPath(trusted, bad)
    assert(ok === false, `accepted ${JSON.stringify(bad)} as a server binary`)
    assert(readSettings().serverBinPath === before, `writing ${JSON.stringify(bad)} changed serverBinPath`)
  }
  return '5 rejected'
})

await test('set-binary-path still accepts a falsy value as "clear it" (the Reset button)', async () => {
  const ok = await setBinaryPath(trusted, null)
  assert(ok === true, 'clearing the binary path was refused')
  assert(readSettings().serverBinPath === undefined, 'the cleared path is still in settings.json')
  // Put it back so later assertions are not reading a half-cleared file.
  await setBinaryPath(trusted, goodBinary)
})

await test('🔍 set-models-dir refuses a relative path and reports the folder still in effect', async () => {
  const setModelsDir = ipcMain.handlers.get('settings:set-models-dir')
  const result = await setModelsDir(trusted, 'Models\\..\\..\\Windows')
  assert(result === tmpDir, 'a rejected models dir did not report the folder actually in effect')
  assert(readSettings().modelsDir === undefined, 'a relative models dir was written to settings.json')
})

const { registerAuthHandlers } = await import('../electron/main/ipc/auth.mjs')
registerAuthHandlers()

await test('🔍 auth:set-required refuses anything that is not literally true or false', async () => {
  const setRequired = ipcMain.handlers.get('auth:set-required')
  for (const bad of ['', 0, 'false', null, undefined, {}]) {
    assert(await setRequired(trusted, bad) === false, `accepted ${JSON.stringify(bad)} as an auth flag`)
  }
  assert(await setRequired(trusted, true) === true, 'a real boolean was refused')
  return '6 rejected'
})

const { registerMcpHandlers } = await import('../electron/main/ipc/mcp.mjs')
registerMcpHandlers({ getConfiguredPort: () => 19080 })

await test('🔍 mcp:test-external runs the same URL validation as mcp:add-external', async () => {
  // The live finding this suite was written alongside: the probe fetched a
  // renderer-supplied URL from the main process without ever calling
  // validateExternalMcpUrl. Main-process SSRF that bypassed the control
  // entirely. Each of these must be refused BEFORE any fetch happens.
  const testExternal = ipcMain.handlers.get('mcp:test-external')
  const refused = [
    'file:///C:/Windows/win.ini',   // scheme the validator exists to refuse
    'http://127.0.0.1:19081/sse',   // Nest's own llama-server port
    'not a url',
    '',
  ]
  for (const url of refused) {
    const res = await testExternal(trusted, url)
    assert(res.ok === false, `probed ${JSON.stringify(url)} instead of refusing it`)
    assert(typeof res.message === 'string' && res.message, `no reason given for ${JSON.stringify(url)}`)
  }
  return `${refused.length} refused`
})

await test('🔍 mcp:test-external does not throw on a non-string argument', async () => {
  // It called url.endsWith() on an unchecked value, so `undefined` threw a
  // TypeError out through the channel instead of returning a result.
  const testExternal = ipcMain.handlers.get('mcp:test-external')
  for (const bad of [undefined, null, 42, {}, ['http://x/sse']]) {
    const res = await testExternal(trusted, bad)
    assert(res.ok === false, `accepted ${JSON.stringify(bad)} as a URL`)
  }
  return '5 handled'
})

await test('mcp:add-external refuses a non-object server', async () => {
  const addExternal = ipcMain.handlers.get('mcp:add-external')
  for (const bad of [undefined, null, 'http://10.0.0.5:9000/sse', 42]) {
    const res = await addExternal(trusted, bad)
    assert(res.ok === false, `accepted ${JSON.stringify(bad)} as a server record`)
  }
  return '4 rejected'
})

// ---------------------------------------------------------------------------
// §3b — the binary path is checked on the way OUT as well as in
// ---------------------------------------------------------------------------
// settings.json is an ordinary file on disk. Every value written by a build
// predating the write-side check above is still sitting in real installs, and
// resolveBinary() is what hands it to spawn(). Checking only on the way in
// would leave those stored values trusted forever.
//
// resolveBinary() itself lives in index.mjs and cannot be imported — doing so
// boots the Electron app — so this covers the predicate directly and asserts
// the wiring by source scan.

console.log('\n-- §3b stored binary paths are re-checked at read time --')

const { binaryPathRejection } = await import('../electron/main/ipc/validate.mjs')

await test('🔍 binaryPathRejection accepts a real .exe and refuses everything else', () => {
  assert(binaryPathRejection(goodBinary) === null, 'a real absolute .exe was refused')
  const bad = [
    ['C:\\evil.exe', 'a path that does not exist'],
    [path.join(tmpDir, 'notes.txt'), 'a file that is not an .exe'],
    [tmpDir, 'a directory'],
    ['llama-server.exe', 'a relative path'],
    ['', 'an empty string'],
    [null, 'null'],
    [42, 'a number'],
    [{ toString: () => goodBinary }, 'an object that stringifies to a valid path'],
  ]
  for (const [value, what] of bad) {
    assert(typeof binaryPathRejection(value) === 'string', `${what} was accepted as a server binary`)
  }
  return `${bad.length} refused`
})

await test('🔍 resolveBinary() runs the check before returning a stored override', () => {
  const src = stripComments(fs.readFileSync(path.join(mainDir, 'index.mjs'), 'utf8'))
  const fn = src.slice(src.indexOf('function resolveBinary()'))
  assert(fn.startsWith('function resolveBinary()'), 'resolveBinary() is gone — this check needs updating')
  const body = fn.slice(0, fn.indexOf('\n}'))
  assert(
    /binaryPathRejection\s*\(/.test(body),
    'resolveBinary() returns settings.serverBinPath without re-validating it — a value stored by an older build reaches spawn() unchecked'
  )
})

// ---------------------------------------------------------------------------
// §4 — the trusted location, in BOTH builds
// ---------------------------------------------------------------------------
// Everything above runs the dev branch, because the electron stub reports
// `isPackaged: false`. The packaged branch is the one that ships and the one
// nobody can smoke-test from a dev run — and it fails in the worst possible
// direction: if the path comparison is wrong, EVERY IPC call in the installed
// app is refused and the launcher is inert. So it is driven directly here by
// flipping the stub's flag.

console.log('\n-- §4 trusted renderer location (dev and packaged) --')

const { app } = await import('./electron-stub.mjs')
const { isTrustedRendererUrl, rendererIndexFile, DEV_RENDERER_ORIGIN } =
  await import('../electron/main/renderer-location.mjs')
const { pathToFileURL } = await import('node:url')

const indexUrl = pathToFileURL(rendererIndexFile()).href

async function asPackaged(fn) {
  app.isPackaged = true
  try { await fn() } finally { app.isPackaged = false }
}

await test('dev: only Vite\'s origin is the launcher', () => {
  assert(isTrustedRendererUrl(`${DEV_RENDERER_ORIGIN}/`), 'the dev server URL is not trusted')
  assert(isTrustedRendererUrl(`${DEV_RENDERER_ORIGIN}/index.html`), 'a path under the dev origin is not trusted')
  assert(!isTrustedRendererUrl('http://localhost:5174/'), 'another localhost port is trusted')
  assert(!isTrustedRendererUrl('https://localhost:5173/'), 'a scheme change is trusted')
  assert(!isTrustedRendererUrl(indexUrl), 'the packaged file is trusted in a dev build')
})

await test('🔍 packaged: the real dist/index.html is trusted and the app is not bricked', async () => {
  await asPackaged(() => {
    assert(isTrustedRendererUrl(indexUrl), `loadFile(${rendererIndexFile()}) would be REFUSED — every IPC call fails in the installed app`)
  })
})

await test('🔍 packaged: no OTHER file:// URL is trusted (every file origin is "null")', async () => {
  await asPackaged(() => {
    // The footgun this branch exists for: `new URL(fileUrl).origin` is the
    // string "null" for all of these, so an origin allowlist would accept every
    // one — including an HTML file an attacker dropped on disk.
    const siblings = [
      pathToFileURL(path.join(path.dirname(rendererIndexFile()), 'evil.html')).href,
      pathToFileURL(path.join(repoRoot, 'index.html')).href,
      pathToFileURL(path.join(os.tmpdir(), 'index.html')).href,
      'file:///C:/Users/Public/index.html',
    ]
    for (const url of siblings) {
      assert(new URL(url).origin === 'null', `precondition failed: ${url} has a real origin`)
      assert(!isTrustedRendererUrl(url), `a foreign local file is trusted: ${url}`)
    }
    assert(!isTrustedRendererUrl(`${DEV_RENDERER_ORIGIN}/`), 'the dev server is trusted in a packaged build')
  })
  return '4 refused'
})

await test('packaged: a query or fragment on the launcher URL still matches', async () => {
  // fileURLToPath reads the pathname only, so neither survives to the compare.
  // Asserted rather than assumed — a mismatch here would brick the app the
  // first time anything appended a hash.
  await asPackaged(() => {
    assert(isTrustedRendererUrl(`${indexUrl}?v=2`), 'a query string broke the match')
    assert(isTrustedRendererUrl(`${indexUrl}#/tools`), 'a fragment broke the match')
  })
})

await test('packaged: a drive-letter case difference still matches on Windows', async () => {
  // Windows paths are case-insensitive and Electron is not guaranteed to hand
  // back the same casing the path was built with.
  if (process.platform !== 'win32') return 'skipped — not Windows'
  await asPackaged(() => {
    assert(isTrustedRendererUrl(indexUrl.replace(/^file:\/\/\/([A-Za-z]):/, (m, d) => `file:///${d.toLowerCase()}:`)),
      'a lowercase drive letter broke the match')
  })
})

await test('garbage is refused in both builds rather than throwing', async () => {
  const junk = [null, undefined, '', 42, {}, 'not a url', 'javascript:alert(1)', 'data:text/html,<h1>x']
  for (const v of junk) assert(!isTrustedRendererUrl(v), `dev build trusted ${JSON.stringify(v)}`)
  await asPackaged(() => {
    for (const v of junk) assert(!isTrustedRendererUrl(v), `packaged build trusted ${JSON.stringify(v)}`)
  })
  return `${junk.length} values, both builds`
})

// ---------------------------------------------------------------------------

const passed = results.filter(r => r.pass).length
console.log(`\n${passed}/${results.length} passed`)

fs.rmSync(tmpDir, { recursive: true, force: true })
process.exit(passed === results.length ? 0 : 1)
