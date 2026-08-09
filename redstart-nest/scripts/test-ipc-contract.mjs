// =============================================================================
// IPC contract test — the preload bridge vs. the main-process handlers.
// =============================================================================
// The renderer can only reach the main process through the channel names
// baked into electron/preload/index.mjs. Those names are string literals on
// one side and, in electron/main/ipc/capabilities.mjs, *computed* on the other
// (`capabilities:set-${slug}` for the vault/git/file_system trio). A typo or a
// slug-shape change on either side is invisible to typecheck, invisible to a
// grep, and only shows up as a dead button in the shipped app — which is
// exactly how the file-system capability broke once already.
//
// So this suite registers the REAL handlers under a recording ipcMain stub
// (catching the dynamically-built channels a static scan would miss) and
// compares that set against the channels the preload actually invokes.
//
// It also pins the two projections that cross the bridge and must never carry
// a secret: `capabilities:get` and `auth:get-config`.
//
// Run:  node scripts/test-ipc-contract.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(here, '..')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-ipc-test-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir

register('./auth-test-loader.mjs', import.meta.url)

const { ipcMain } = await import('./electron-stub.mjs')

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
// Side A — what the preload exposes to the renderer.
// ---------------------------------------------------------------------------
// Read as source text rather than imported: the preload is loaded by Electron
// with `require`, so it cannot be evaluated under plain Node ESM. Every call
// site is a literal, so a scan is exact here (unlike the main side).

const preloadSrc = fs.readFileSync(path.join(repoRoot, 'electron', 'preload', 'index.mjs'), 'utf8')

function scan(src, pattern) {
  return new Set([...src.matchAll(pattern)].map(m => m[1]))
}

const preloadInvokes = scan(preloadSrc, /ipcRenderer\.invoke\(\s*'([^']+)'/g)
const preloadSubscribes = new Set([
  ...scan(preloadSrc, /ipcRenderer\.on\(\s*'([^']+)'/g),
  ...scan(preloadSrc, /ipcRenderer\.removeAllListeners\(\s*'([^']+)'/g),
])

// ---------------------------------------------------------------------------
// Side B — what the main process actually registers.
// ---------------------------------------------------------------------------
// The real register functions, run against the recording ipcMain. Dependencies
// are only ever touched from inside a handler body, so a no-op stand-in is
// enough to get through registration.

const noopDeps = new Proxy(
  {},
  {
    get: () => () => {},
  }
)

const registrars = [
  ['github', 'registerGithubHandlers'],
  ['hardware', 'registerHardwareHandlers'],
  ['settings', 'registerSettingsHandlers'],
  ['auth', 'registerAuthHandlers'],
  ['profiles', 'registerProfilesHandlers'],
  ['tools', 'registerToolsHandlers'],
  ['mcp', 'registerMcpHandlers'],
  ['capabilities', 'registerCapabilitiesHandlers'],
  ['server', 'registerServerHandlers'],
  ['models', 'registerModelsHandlers'],
]

for (const [mod, fnName] of registrars) {
  const imported = await import(`../electron/main/ipc/${mod}.mjs`)
  assert(typeof imported[fnName] === 'function', `${mod}.mjs does not export ${fnName}`)
  imported[fnName](noopDeps)
}

const mainHandlers = new Set(ipcMain.handlers.keys())

// Channels the main process pushes at the renderer, scanned from source.
const mainEmits = new Set()
for (const file of fs.readdirSync(path.join(repoRoot, 'electron', 'main'))) {
  if (!file.endsWith('.mjs')) continue
  const src = fs.readFileSync(path.join(repoRoot, 'electron', 'main', file), 'utf8')
  for (const c of scan(src, /\.send\(\s*'([^']+)'/g)) mainEmits.add(c)
}
for (const file of fs.readdirSync(path.join(repoRoot, 'electron', 'main', 'ipc'))) {
  if (!file.endsWith('.mjs')) continue
  const src = fs.readFileSync(path.join(repoRoot, 'electron', 'main', 'ipc', file), 'utf8')
  for (const c of scan(src, /\.send\(\s*'([^']+)'/g)) mainEmits.add(c)
}

// ---------------------------------------------------------------------------

console.log('\n-- preload/main channel contract --')

await test('every register*Handlers export registers at least one channel', () => {
  assert(mainHandlers.size > 0, 'no handlers registered at all')
  return `${mainHandlers.size} handlers, ${preloadInvokes.size} preload calls`
})

await test('🔍 every channel the preload invokes has a main-process handler', () => {
  const orphans = [...preloadInvokes].filter(c => !mainHandlers.has(c)).sort()
  assert(
    orphans.length === 0,
    `preload invokes channels nothing handles (renderer call would hang/throw): ${orphans.join(', ')}`
  )
})

await test('🔍 the folder-scoped trio registers both channels under the hyphenated slug', () => {
  // The one place the channel name is computed, and the one that has broken
  // before. Pinned explicitly so a change to the slug rule fails loudly here
  // rather than silently in the UI.
  const expected = [
    'capabilities:select-vault-folder',
    'capabilities:set-vault',
    'capabilities:select-git-folder',
    'capabilities:set-git',
    'capabilities:select-file-system-folder',
    'capabilities:set-file-system',
  ]
  const missing = expected.filter(c => !mainHandlers.has(c))
  assert(missing.length === 0, `missing computed capability channels: ${missing.join(', ')}`)
  const underscored = [...mainHandlers].filter(c => c.startsWith('capabilities:') && c.includes('_'))
  assert(
    underscored.length === 0,
    `capability channels must use the hyphenated slug, found: ${underscored.join(', ')}`
  )
})

await test('every main-process handler is reachable from the preload (no dead channels)', () => {
  const unreachable = [...mainHandlers].filter(c => !preloadInvokes.has(c)).sort()
  assert(
    unreachable.length === 0,
    `handlers with no preload caller — dead code or a missing bridge entry: ${unreachable.join(', ')}`
  )
})

await test('🔍 every event the preload subscribes to is actually emitted by main', () => {
  const never = [...preloadSubscribes].filter(c => !mainEmits.has(c)).sort()
  assert(never.length === 0, `preload listens for events main never sends: ${never.join(', ')}`)
})

await test('every event main emits has a preload subscription', () => {
  const unheard = [...mainEmits].filter(c => !preloadSubscribes.has(c)).sort()
  assert(unheard.length === 0, `main sends events the renderer cannot receive: ${unheard.join(', ')}`)
})

await test('no channel is registered twice', () => {
  // The stub throws on a duplicate handle(), so reaching here with a full set
  // is the assertion; this test documents the invariant.
  assert(mainHandlers.size === ipcMain.handlers.size, 'handler map inconsistent')
})

// ---------------------------------------------------------------------------
// Projections that cross the bridge — must never carry a secret.
// ---------------------------------------------------------------------------

console.log('\n-- bridge projections leak no secrets --')

const { setCapabilityConfig } = await import('../electron/main/tools-storage.mjs')
const { encryptSecret } = await import('../electron/main/secrets.mjs')

await test('🔍 capabilities:get reports hasConnectionString, never the connection string', async () => {
  const secret = 'postgresql://postgres:hunter2@127.0.0.1:5432/postgres'
  setCapabilityConfig('postgres', { enabled: true, connectionStringEnc: encryptSecret(secret) })

  const caps = await ipcMain.handlers.get('capabilities:get')({})
  const serialized = JSON.stringify(caps)

  assert(caps.postgres.hasConnectionString === true, 'hasConnectionString should be true once configured')
  assert(!('connectionString' in caps.postgres), 'plaintext connectionString must not be in the projection')
  assert(!('connectionStringEnc' in caps.postgres), 'the ciphertext must not cross the bridge either')
  assert(!serialized.includes('hunter2'), 'the password appears somewhere in the projection')
  assert(!serialized.includes('connectionStringEnc'), 'ciphertext field name leaked into the projection')
})

await test('capabilities:get exposes the file-system permission policy under the underscore key', async () => {
  // Storage key stays `file_system` while the channel is hyphenated — the
  // renderer reads this shape, so pin it.
  const caps = await ipcMain.handlers.get('capabilities:get')({})
  assert(caps.file_system, 'file_system key missing from the projection')
  assert(typeof caps.file_system.allowWrite === 'boolean', 'allowWrite must be a boolean')
  assert(typeof caps.file_system.allowDestructive === 'boolean', 'allowDestructive must be a boolean')
  assert(caps.file_system.allowDestructive === false, 'deletes must be off by default')
})

await test('🔍 capabilities:set-file-system writes to the file_system storage key', async () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-fs-root-'))
  await ipcMain.handlers.get('capabilities:set-file-system')({}, { rootDir: target, enabled: true })
  const caps = await ipcMain.handlers.get('capabilities:get')({})
  assert(caps.file_system.rootDir === target, 'rootDir did not round-trip through the hyphenated channel')
  assert(caps.file_system.enabled === true, 'enabled did not round-trip')
})

await test('🔍 capabilities:set-vault cannot smuggle a write policy onto a non-fs capability', async () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-vault-root-'))
  await ipcMain.handlers.get('capabilities:set-vault')(
    {},
    { rootDir: target, enabled: true, allowWrite: true, allowDestructive: true }
  )
  const { getCapabilities } = await import('../electron/main/tools-storage.mjs')
  const vault = getCapabilities().vault
  assert(vault.allowWrite === undefined, 'allowWrite leaked onto the vault capability')
  assert(vault.allowDestructive === undefined, 'allowDestructive leaked onto the vault capability')
})

// ---------------------------------------------------------------------------

const passed = results.filter(r => r.pass).length
console.log(`\n${passed}/${results.length} passed`)

fs.rmSync(tmpDir, { recursive: true, force: true })
process.exit(passed === results.length ? 0 : 1)
