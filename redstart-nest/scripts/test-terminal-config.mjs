// =============================================================================
// The terminal's executable allowlist (agent-runtime plan D16, D17; P4-a, P4-b)
// =============================================================================
// Every entry is resolved once, when the list is saved, to an absolute path.
// These tests build fake PATH layouts in a temp folder, so they need no real
// git or npm, and run the Windows rules on any OS by passing the platform:
//   - a real program is found on PATH and stored by absolute path
//   - a program that exists only as a .cmd/.bat is refused (D17)
//   - npm and npx become the node beside them plus the CLI script (P4-b)
//   - a missing name, a relative path, a duplicate name are refused
//   - an entry whose file has gone drops out of the live list
//   - capabilities:set-terminal refuses the whole save on one bad entry, and
//     buildGatewayConfig carries the network-exposure flag and the live list
//
// Run:  node scripts/test-terminal-config.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-terminal-config-'))
process.env.REDSTART_TEST_USERDATA_DIR = path.join(tmp, 'userdata')
fs.mkdirSync(process.env.REDSTART_TEST_USERDATA_DIR, { recursive: true })
register('./auth-test-loader.mjs', import.meta.url)
await import('./electron-stub.mjs')

const { resolveExecutable, resolveExecutableList, liveExecutables, entryName } = await import('../daemon/terminal-config.mjs')
const { setTerminalConfig, getCapabilitiesConfig } = await import('../daemon/ipc/capabilities.mjs')
const { buildGatewayConfig } = await import('../daemon/gateway-config.mjs')
const { setCapabilityConfig } = await import('../daemon/tools-storage.mjs')

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
function assert(cond, message) { if (!cond) throw new Error(message) }

function touch(file, { exec = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '#!/bin/sh\n')
  if (exec && process.platform !== 'win32') fs.chmodSync(file, 0o755)
  return file
}

const winA = path.join(tmp, 'winA')
const winB = path.join(tmp, 'winB')
const win = { pathEnv: [winA, winB].join(';'), pathExt: '.COM;.EXE;.BAT;.CMD', platform: 'win32' }
touch(path.join(winA, 'git.cmd'))              // a shim earlier on PATH ...
touch(path.join(winB, 'git.exe'))              // ... and the real program later
touch(path.join(winA, 'yarn.cmd'))             // only a shim
touch(path.join(winA, 'npm.cmd'))
touch(path.join(winA, 'npx.cmd'))
touch(path.join(winA, 'node.exe'))
touch(path.join(winA, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
touch(path.join(winA, 'node_modules', 'npm', 'bin', 'npx-cli.js'))
const winNoCli = path.join(tmp, 'winNoCli')
touch(path.join(winNoCli, 'npm.cmd'))
touch(path.join(winNoCli, 'node.exe'))

console.log('\nterminal config\n')

await test('a program on PATH resolves to its absolute path (host platform)', () => {
  const bin = path.join(tmp, 'hostbin')
  const file = touch(path.join(bin, process.platform === 'win32' ? 'tool.exe' : 'tool'))
  const r = resolveExecutable('tool', { pathEnv: bin, pathExt: '.EXE', platform: process.platform })
  assert(r.ok, r.reason)
  assert(r.file === file && r.name === 'tool' && r.prefixArgs.length === 0, JSON.stringify(r))
  return r.file
})

await test('Windows: the real .exe wins over a .cmd shim earlier on PATH', () => {
  const r = resolveExecutable('git', win)
  assert(r.ok && r.file === path.join(winB, 'git.exe') && r.name === 'git', JSON.stringify(r))
})

await test('Windows: a program that is only a .cmd shim is refused (D17)', () => {
  const r = resolveExecutable('yarn', win)
  assert(!r.ok && /batch file/.test(r.reason), JSON.stringify(r))
  const abs = resolveExecutable(path.join(winA, 'yarn.cmd'), win)
  assert(!abs.ok && /batch file/.test(abs.reason), 'an absolute .cmd path was accepted')
})

await test('npm and npx resolve to node + the CLI script, never the shim (P4-b)', () => {
  const npm = resolveExecutable('npm', win)
  assert(npm.ok, npm.reason)
  assert(npm.file === path.join(winA, 'node.exe'), `file ${npm.file}`)
  assert(npm.prefixArgs.length === 1 && npm.prefixArgs[0] === path.join(winA, 'node_modules', 'npm', 'bin', 'npm-cli.js'), JSON.stringify(npm.prefixArgs))
  assert(npm.name === 'npm', npm.name)
  const npx = resolveExecutable('npx', win)
  assert(npx.ok && npx.prefixArgs[0].endsWith('npx-cli.js'), JSON.stringify(npx))
  const byPath = resolveExecutable(path.join(winA, 'npm.cmd'), win)
  assert(byPath.ok && byPath.file === npm.file, 'npm.cmd by absolute path did not resolve the same way')
})

await test('npm without its CLI script beside it is refused with the reason', () => {
  const r = resolveExecutable('npm', { ...win, pathEnv: winNoCli })
  assert(!r.ok && /CLI script/.test(r.reason), JSON.stringify(r))
})

await test('a name not on PATH, a relative path, an empty entry are refused', () => {
  for (const [entry, re] of [['nosuch', /not found/], ['bin/git', /relative path/], ['', /empty/], ['..\\git', /relative path/], ['git;calc', /not a program name/]]) {
    const r = resolveExecutable(entry, win)
    assert(!r.ok && re.test(r.reason), `${JSON.stringify(entry)}: ${JSON.stringify(r)}`)
  }
  const missing = resolveExecutable(path.join(tmp, 'gone', process.platform === 'win32' ? 'x.exe' : 'x'), { platform: process.platform })
  assert(!missing.ok && /not an executable/.test(missing.reason), JSON.stringify(missing))
})

await test('entry names drop the Windows extension and case', () => {
  assert(entryName('C:\\Program Files\\Git\\cmd\\Git.EXE', 'win32') === 'git', 'win32')
  assert(entryName('/usr/bin/git', 'linux') === 'git', 'posix')
})

await test('a list is refused whole on one bad entry, and on two entries with one name', () => {
  const ok = resolveExecutableList(['git', 'npm'], win)
  assert(ok.ok && ok.executables.map((e) => e.name).join() === 'git,npm', JSON.stringify(ok))
  const bad = resolveExecutableList(['git', 'yarn'], win)
  assert(!bad.ok && /batch file/.test(bad.reason), JSON.stringify(bad))
  const dup = resolveExecutableList(['git', path.join(winB, 'git.exe')], win)
  assert(!dup.ok && /both called/.test(dup.reason), JSON.stringify(dup))
  assert(!resolveExecutableList('git', win).ok, 'a string was taken as a list')
})

await test('the live list drops an entry whose program has gone', () => {
  const keep = touch(path.join(tmp, 'live', 'keep'))
  const drop = touch(path.join(tmp, 'live', 'drop'))
  const stored = [
    { name: 'keep', file: keep, prefixArgs: [], dir: path.dirname(keep) },
    { name: 'drop', file: drop, prefixArgs: [], dir: path.dirname(drop) },
    { name: 'npm', file: keep, prefixArgs: [path.join(tmp, 'live', 'no-cli.js')], dir: path.dirname(keep) },
  ]
  fs.rmSync(drop)
  const live = liveExecutables(stored)
  assert(live.length === 1 && live[0].name === 'keep', JSON.stringify(live))
  assert(liveExecutables([{ name: 'x', file: path.join(winA, 'yarn.cmd'), prefixArgs: [] }], 'win32').length === 0, 'a stored .cmd counted as live')
})

// ---- capabilities:set-terminal + buildGatewayConfig -------------------------

const realBin = path.dirname(process.execPath)
const refresh = { refreshLiveToolsConfig: () => {} }

await test('set-terminal stores the resolved list and refuses a bad one whole', () => {
  const r = setTerminalConfig({ executables: [process.execPath] }, refresh)
  assert(r.ok, JSON.stringify(r))
  const status = getCapabilitiesConfig().terminal
  assert(status.executables.length === 1 && status.executables[0].file === process.execPath && !status.executables[0].missing, JSON.stringify(status.executables))
  const bad = setTerminalConfig({ executables: [process.execPath, 'definitely-not-a-program-xyz'] }, refresh)
  assert(!bad.ok && /not found/.test(bad.error), JSON.stringify(bad))
  assert(getCapabilitiesConfig().terminal.executables.length === 1, 'a refused save changed the list')
})

await test('set-terminal checks bounds and folders', () => {
  assert(!setTerminalConfig({ maxTimeoutS: 0 }, refresh).ok, 'maxTimeoutS 0 accepted')
  assert(!setTerminalConfig({ defaultTimeoutS: 900, maxTimeoutS: 600 }, refresh).ok, 'default above max accepted')
  assert(!setTerminalConfig({ outputCapBytes: 10 }, refresh).ok, 'a tiny output cap accepted')
  assert(!setTerminalConfig({ extraDirs: ['relative/dir'] }, refresh).ok, 'a relative folder accepted')
  assert(!setTerminalConfig({ extraDirs: [path.join(tmp, 'no-such-dir')] }, refresh).ok, 'a missing folder accepted')
  assert(setTerminalConfig({ extraDirs: [tmp], defaultTimeoutS: 30 }, refresh).ok, 'a good save refused')
  assert(!setTerminalConfig('nope', refresh).ok, 'a non-object accepted')
})

await test('buildGatewayConfig: on only when active, Documents set and a program listed; carries network exposure', () => {
  const docs = path.join(tmp, 'Documents')
  fs.mkdirSync(docs, { recursive: true })
  setCapabilityConfig('documents', { outputDir: docs })
  const llama = (ids, networkMode) => ({ networkMode, tools: { enabled: true, activeToolIds: ids } })
  const on = buildGatewayConfig(llama(['terminal'], false)).terminal
  assert(on.enabled && on.executables.length === 1 && on.networkExposed === false && on.documentsRoot === docs, JSON.stringify(on))
  assert(on.defaultTimeoutS === 30 && on.extraDirs[0] === tmp, 'settings not carried')
  assert(buildGatewayConfig(llama(['terminal'], true)).terminal.networkExposed === true, 'network mode not carried')
  assert(!buildGatewayConfig(llama([], false)).terminal.enabled, 'on without the card active')
  assert(!buildGatewayConfig({ tools: { enabled: false } }).terminal.enabled, 'on with tools off')
  setCapabilityConfig('documents', { outputDir: null })
  assert(!buildGatewayConfig(llama(['terminal'], false)).terminal.enabled, 'on without Documents')
  return `node from ${realBin}`
})

console.log('\n' + '='.repeat(60))
const passed = results.filter((r) => r.pass).length
console.log(`${passed}/${results.length} passed`)
console.log('='.repeat(60) + '\n')
fs.rmSync(tmp, { recursive: true, force: true })
if (passed !== results.length) process.exit(1)
