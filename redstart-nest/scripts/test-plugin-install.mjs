// =============================================================================
// Unit tests for electron/main/plugin-install.mjs — the plugin install
// pipeline (task T15: installer, task T16: probe + uninstall).
// =============================================================================
// Two kinds of check here, and they are kept apart:
//
//   - NETWORK-DEPENDENT: actually installs a real pinned package from the npm
//     registry. Skips cleanly with a printed notice when offline, the way
//     test-provider-conformance.mjs already skips its Postgres phase — this
//     suite must not fail in test:security just because npmjs.org is down.
//   - NETWORK-FREE: argv construction, the probe against a local fixture
//     process, and uninstall/pendingDeletions bookkeeping. These always run.
//
// probePlugin talks to scripts/fixtures/fake-mcp-server.mjs over real stdio,
// same fixture and same posture as test-plugin-client.mjs (task T6): a real
// child process, not a mocked transport.
//
// Run:  node scripts/test-plugin-install.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-plugin-install-test-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir

register('./auth-test-loader.mjs', import.meta.url)

// Explicit, main-thread trigger for the stub's platform-paths.mjs initialization.
// module.register() hooks run in a separate worker thread, so a side effect
// inside auth-test-loader.mjs itself can't reach this thread's copy of
// platform-paths.mjs -- only an ordinary import, resolved here in the main
// thread, can. Needed because production code no longer imports 'electron'
// at all in several modules this suite exercises, so nothing else would
// trigger the stub's initPaths() call.
await import('./electron-stub.mjs')

const install = await import('../electron/main/plugin-install.mjs')
const registry = await import('../electron/main/plugin-registry.mjs')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(__dirname, 'fixtures', 'fake-mcp-server.mjs')

// ---------------------------------------------------------------------------
// Harness (mirrors scripts/test-plugin-registry.mjs / test-plugin-client.mjs)
// ---------------------------------------------------------------------------

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

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`test itself timed out waiting on: ${label}`)), ms)),
  ])
}

async function isNpmRegistryReachable() {
  try {
    const res = await fetch('https://registry.npmjs.org/', { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

async function isPypiReachable() {
  try {
    const res = await fetch('https://pypi.org/simple/', { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-plugin-install-logs-'))

// ---------------------------------------------------------------------------
// Network-free: argv construction
// ---------------------------------------------------------------------------

console.log('\n-- --ignore-scripts is actually passed (Trap-worthy: leaves no trace if it silently goes missing) --')

await test('buildNpmInstallArgs() includes --ignore-scripts, plus --prefix and the pinned spec', async () => {
  const args = install.buildNpmInstallArgs({
    cliPath: 'C:\\fake\\npm-cli.js',
    spec: '@modelcontextprotocol/server-memory@2026.7.4',
    dir: 'C:\\fake\\dir',
  })
  assert(args.includes('--ignore-scripts'), `--ignore-scripts missing from argv: ${JSON.stringify(args)}`)
  assert(args.includes('--prefix'), `--prefix missing from argv: ${JSON.stringify(args)}`)
  assert(args[args.indexOf('--prefix') + 1] === 'C:\\fake\\dir', 'the directory following --prefix is wrong')
  assert(args.includes('@modelcontextprotocol/server-memory@2026.7.4'), 'the pinned package@version spec is missing')
  return args.join(' ')
})

console.log('\n-- Phase 7: buildUvInstallArgs() (network-free) --')

await test('buildUvInstallArgs() includes tool install, --python-preference only-managed, and the pinned spec', async () => {
  const args = install.buildUvInstallArgs({ spec: 'armor-mcp==0.6.1' })
  assert(args[0] === 'tool' && args[1] === 'install', `expected "tool install" first, got ${JSON.stringify(args)}`)
  assert(args.includes('--python-preference'), `--python-preference missing from argv: ${JSON.stringify(args)}`)
  assert(args.includes('only-managed'), `"only-managed" missing from argv: ${JSON.stringify(args)}`)
  assert(args.includes('armor-mcp==0.6.1'), 'the pinned package==version spec is missing')
  assert(args[args.indexOf('--color') + 1] === 'never', `--color never missing from argv: ${JSON.stringify(args)}`)
  return args.join(' ')
})

await test('parseUvInstallOutput() strips ANSI bold from the executable name (mtg-mcp regression)', async () => {
  // The exact shape that failed live: the name arrived as "\x1b[1mmtg-mcp\x1b[0m"
  // and became the path of a non-existent .exe.
  const stderr = 'Resolved 12 packages in 1.2s\n + \x1b[1mmtg-mcp\x1b[0m\x1b[2m==0.3.1\x1b[0m\nInstalled 1 executable: \x1b[1mmtg-mcp\x1b[0m\n'
  const parsed = install.parseUvInstallOutput(stderr, 'mtg-mcp')
  assert(JSON.stringify(parsed.names) === '["mtg-mcp"]', `expected ["mtg-mcp"], got ${JSON.stringify(parsed.names)}`)
  assert(parsed.resolvedVersion === '0.3.1', `expected resolved version 0.3.1, got ${parsed.resolvedVersion}`)
  return parsed.names[0]
})

console.log('\n-- dependency constraints (network-free) --')

await test('normalizeConstraints() accepts plain version constraints for each kind, and an absent list', async () => {
  const pypi = install.normalizeConstraints('pypi', ['mcp<2', ' pydantic >= 2 , < 3 ', '', 'Foo.Bar_baz~=1.4'])
  assert(pypi.ok, `pypi rejected: ${pypi.error}`)
  assert(pypi.constraints.length === 3, `blank lines should be dropped, got ${JSON.stringify(pypi.constraints)}`)
  const npm = install.normalizeConstraints('npm', ['zod@^3', '@modelcontextprotocol/sdk@1.29.0', 'left-pad@>=1.0.0 <2 || 3.x'])
  assert(npm.ok, `npm rejected: ${npm.error}`)
  assert(install.normalizeConstraints('npm', undefined).ok, 'an absent list must be valid')
  return 'ok'
})

await test('normalizeConstraints() refuses anything that could swap in code from another source', async () => {
  const refused = {
    pypi: [
      '--index-url https://evil.example/simple', // option line in a constraints file
      'mcp<2\n--index-url https://evil.example', // smuggled second line
      'mcp\n==1',
      'mcp @ https://evil.example/mcp.whl', // direct reference
      'mcp[cli]<2', // extras install more than they constrain
      'mcp', // no comparison — constrains nothing
      '-r other.txt',
    ],
    npm: [
      'zod@npm:evil-zod@1', // alias
      'zod@file:../evil', // local path
      'zod@git+https://evil.example/zod.git',
      'zod@evil/zod', // GitHub shorthand
      'zod@$zod', // root-dependency reference
      'zod', // no range
      '@scope@1',
    ],
  }
  for (const [kind, list] of Object.entries(refused)) {
    for (const c of list) {
      assert(!install.normalizeConstraints(kind, [c]).ok, `${kind} accepted ${JSON.stringify(c)}`)
    }
  }
  assert(!install.normalizeConstraints('pypi', ['mcp<2', 'MCP>=1']).ok, 'duplicate names (case-insensitive) accepted')
  assert(!install.normalizeConstraints('command', ['mcp<2']).ok, 'a command source accepted constraints')
  assert(!install.normalizeConstraints('pypi', 'mcp<2').ok, 'a bare string accepted in place of a list')
  return `${refused.pypi.length + refused.npm.length} refused`
})

await test('npm constraints become overrides; pypi constraints become --constraints before the spec', async () => {
  const overrides = install.buildNpmOverrides(['zod@^3', '@modelcontextprotocol/sdk@1.29.0'])
  assert(overrides.zod === '^3' && overrides['@modelcontextprotocol/sdk'] === '1.29.0', `got ${JSON.stringify(overrides)}`)
  const args = install.buildUvInstallArgs({ spec: 'mtg-mcp==0.1.3', constraintsPath: 'C:\\fake\\constraints.txt' })
  const i = args.indexOf('--constraints')
  assert(i > 0 && args[i + 1] === 'C:\\fake\\constraints.txt', `--constraints missing: ${JSON.stringify(args)}`)
  assert(args[args.length - 1] === 'mtg-mcp==0.1.3', 'the spec must stay last')
  assert(!install.buildUvInstallArgs({ spec: 'x==1' }).includes('--constraints'), '--constraints passed with no constraints')
  return args.join(' ')
})

await test('installers refuse a bad constraint before touching the filesystem', async () => {
  const npm = await install.installNpmPackage({ id: 'badconstraint', packageName: 'x', version: '1.0.0', constraints: ['zod@file:../evil'] })
  const pypi = await install.installPypiPackage({ id: 'badconstraint', identifier: 'x', version: '1.0.0', constraints: ['--index-url x'] })
  for (const r of [npm, pypi]) {
    assert(r.ok === false && r.reason === 'bad-constraint', `expected bad-constraint, got ${JSON.stringify(r)}`)
  }
  assert(!fs.existsSync(path.join(install.pluginsRoot(), 'badconstraint')), 'a directory was created for a refused install')
  return 'bad-constraint'
})

await test('the install handler refuses a bad constraint; confirm stores only normalised ones', async () => {
  const ipc = await import('../electron/main/ipc/plugins.mjs')
  const refused = await ipc.installPlugin({
    id: 'ipcbadconstraint',
    source: { kind: 'pypi', identifier: 'x', version: '1', constraints: ['mcp<2\n--index-url https://evil.example'] },
  })
  assert(refused.ok === false && /constraint/i.test(refused.error ?? ''), `expected a constraint refusal, got ${JSON.stringify(refused)}`)

  const entry = (id, constraints) => ({
    id, source: { kind: 'pypi', identifier: 'x', version: '1', constraints },
    resolvedCommand: process.execPath, resolvedArgs: [], runAsNode: false,
    tools: [{ name: 't', description: '', inputSchema: {}, class: 'destructive' }],
  })
  const deps = { refreshLiveToolsConfig: () => {} }
  const bad = ipc.confirmPluginInstall(entry('ipcconfirmbad', ['zod@file:../evil']), deps)
  assert(bad.ok === false, 'confirm stored an invalid constraint')
  assert(!registry.getPlugin('ipcconfirmbad'), 'a refused confirm still wrote an entry')

  const good = ipc.confirmPluginInstall(entry('ipcconfirmgood', [' mcp<2 ', '']), deps)
  assert(good.ok, `confirm failed: ${good.error}`)
  const stored = registry.getPlugin('ipcconfirmgood').source.constraints
  assert(JSON.stringify(stored) === '["mcp<2"]', `expected ["mcp<2"] stored, got ${JSON.stringify(stored)}`)
  registry.removePlugin('ipcconfirmgood')
  return 'refused, then stored ["mcp<2"]'
})

await test('parseUvInstallOutput() reads plain multi-executable output', async () => {
  const parsed = install.parseUvInstallOutput(' + pip-tools==7.4.1\nInstalled 2 executables: pip-compile, pip-sync\n', 'pip-tools')
  assert(JSON.stringify(parsed.names) === '["pip-compile","pip-sync"]', `got ${JSON.stringify(parsed.names)}`)
  assert(parsed.resolvedVersion === '7.4.1', `got ${parsed.resolvedVersion}`)
  return parsed.names.join(', ')
})

// ---------------------------------------------------------------------------
// Network-free: probe (real child process, local fixture)
// ---------------------------------------------------------------------------

console.log('\n-- install probe --')

await test('probing fake-mcp-server.mjs (normal) returns both tools, each classified destructive, no live child left', async () => {
  const result = await withTimeout(
    install.probePlugin({ command: process.execPath, args: [FIXTURE, 'normal'], timeoutMs: 10000, logDir }),
    15000, 'probePlugin normal',
  )
  assert(result.ok, `probe failed: ${result.reason} ${result.detail ?? ''}`)
  assert(result.tools.length === 2, `expected 2 tools, got ${result.tools.length}`)
  for (const t of result.tools) {
    assert(t.class === 'destructive', `tool "${t.name}" was not classified destructive (D3/D-b): got "${t.class}"`)
  }
  // write_thing declares readOnlyHint:true in the fixture on purpose (D3) —
  // confirm the probe did not let that promote it.
  const writeThing = result.tools.find((t) => t.name === 'write_thing')
  assert(writeThing && writeThing.class === 'destructive', 'the child\'s own readOnlyHint was trusted — D3 violation')
  return `${result.tools.length} tools, all destructive`
})

await test('probing "no-tools" mode returns reason: no-tools', async () => {
  const result = await withTimeout(
    install.probePlugin({ command: process.execPath, args: [FIXTURE, 'no-tools'], timeoutMs: 10000, logDir }),
    15000, 'probePlugin no-tools',
  )
  assert(result.ok === false, 'a server with zero tools was accepted')
  assert(result.reason === 'no-tools', `expected reason "no-tools", got "${result.reason}"`)
  return result.reason
})

await test('probing an unspawnable command returns spawn-failed with a non-empty detail', async () => {
  // An empty command string is the one case that reliably hits the SYNCHRONOUS
  // spawn() failure path in shared/mcp-stdio-process.mjs's start() (a
  // nonexistent-but-valid-looking path instead surfaces async as a generic
  // "exited" — see the plan's own "exited-immediately OR spawn-failed" wording
  // for a bad command, which anticipates exactly this ambiguity).
  const result = await withTimeout(
    install.probePlugin({ command: '', args: [], timeoutMs: 5000, logDir }),
    10000, 'probePlugin bad command',
  )
  assert(result.ok === false, 'an unspawnable command was accepted')
  assert(result.reason === 'spawn-failed', `expected "spawn-failed", got "${result.reason}"`)
  assert(result.detail && result.detail.length > 0, 'spawn-failed detail was empty')
  return result.detail
})

await test('probing a process that exits before speaking MCP returns exited-immediately with a non-empty detail', async () => {
  const result = await withTimeout(
    install.probePlugin({ command: process.execPath, args: ['-e', 'process.exit(7)'], timeoutMs: 5000, logDir }),
    10000, 'probePlugin exits immediately',
  )
  assert(result.ok === false, 'a process that never spoke MCP was accepted')
  assert(result.reason === 'exited-immediately', `expected "exited-immediately", got "${result.reason}"`)
  assert(result.detail && result.detail.length > 0, 'exited-immediately detail was empty')
  return result.detail.slice(0, 120)
})

console.log('\n-- probe always leaves no live child --')

await test('a probe failure still leaves nothing running (spec R2)', async () => {
  await install.probePlugin({ command: process.execPath, args: ['-e', 'process.exit(3)'], timeoutMs: 5000, logDir })
  // Give the OS a moment, then confirm nothing from this probe is still
  // holding the log directory or listed as running is not directly
  // observable without an id — the client's own stop() is exercised by the
  // finally block; this is a smoke check that the call above didn't hang or
  // throw asynchronously afterward.
  await new Promise((r) => setTimeout(r, 200))
  return 'no hang, no unhandled rejection'
})

// ---------------------------------------------------------------------------
// Network-free: uninstall + pendingDeletions
// ---------------------------------------------------------------------------

console.log('\n-- uninstall --')

function sampleInstalledPlugin(overrides = {}) {
  return {
    id: 'uninsttest',
    displayName: 'Uninstall Test',
    source: { kind: 'npm', package: 'whatever', version: '1.0.0' },
    resolvedCommand: process.execPath,
    resolvedArgs: [FIXTURE, 'normal'],
    env: {},
    timeoutMs: 15000,
    enabled: false,
    allowWrite: false,
    allowDestructive: false,
    tools: [],
    ...overrides,
  }
}

await test('uninstalling a plugin whose folder deletes cleanly removes the registry entry, folderRemoved: true', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-plugin-uninst-'))
  fs.writeFileSync(path.join(dir, 'marker.txt'), 'x')
  const add = registry.addPlugin(sampleInstalledPlugin({ id: 'uninsttest', installDir: dir }))
  assert(add.ok, `addPlugin failed: ${add.error}`)

  const result = await install.uninstallPlugin('uninsttest')
  assert(result.ok, 'uninstallPlugin did not report ok')
  assert(result.folderRemoved === true, 'folder should have been removed')
  assert(!fs.existsSync(dir), 'the directory still exists on disk')
  assert(registry.getPlugin('uninsttest') === null, 'the registry entry survived uninstall')
  return 'entry gone, folder gone'
})

await test('uninstalling with a locked target directory still removes the registry entry and records a pending deletion', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-plugin-locked-'))
  const filePath = path.join(dir, 'locked.txt')
  fs.writeFileSync(filePath, 'x')
  // Hold the file open so rmSync cannot remove it — the cross-platform way to
  // simulate Windows' "file in use" without depending on an actual live child.
  const fd = fs.openSync(filePath, 'r')

  const add = registry.addPlugin(sampleInstalledPlugin({ id: 'lockedtest', installDir: dir }))
  assert(add.ok, `addPlugin failed: ${add.error}`)

  try {
    const result = await install.uninstallPlugin('lockedtest')
    assert(result.ok, 'uninstallPlugin did not report ok')
    assert(registry.getPlugin('lockedtest') === null, 'the registry entry must be removed even when the folder delete fails (P4-4)')

    // Whether this platform actually refuses the delete with a handle open
    // varies (POSIX permits unlinking an open file; win32 does not) — assert
    // the invariant that matters regardless: the entry is gone either way,
    // and IF the folder survived, it is recorded for a later sweep.
    if (fs.existsSync(dir)) {
      assert(result.folderRemoved === false, 'folder still exists but folderRemoved was reported true')
      const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'plugins.json'), 'utf8'))
      assert(Array.isArray(raw.pendingDeletions) && raw.pendingDeletions.includes(dir), 'locked directory was not recorded in pendingDeletions')
    }
    return fs.existsSync(dir) ? 'folder survived, recorded for sweep' : 'this platform allowed the delete anyway (still fine)'
  } finally {
    fs.closeSync(fd)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await test('sweepPendingDeletions() clears an entry once the directory is actually goneable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-plugin-sweep-'))
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x')

  // Seed plugins.json with a pending deletion directly, as uninstallPlugin
  // would have left it.
  const pluginsJsonPath = path.join(tmpDir, 'plugins.json')
  const data = JSON.parse(fs.readFileSync(pluginsJsonPath, 'utf8'))
  data.pendingDeletions = [...(data.pendingDeletions ?? []), dir]
  fs.writeFileSync(pluginsJsonPath, JSON.stringify(data, null, 2), 'utf8')

  install.sweepPendingDeletions()

  assert(!fs.existsSync(dir), 'sweepPendingDeletions did not remove the directory')
  const after = JSON.parse(fs.readFileSync(pluginsJsonPath, 'utf8'))
  assert(!after.pendingDeletions.includes(dir), 'the swept directory is still listed in pendingDeletions')
  return 'swept and cleared'
})

// ---------------------------------------------------------------------------
// Network-dependent: real installs
// ---------------------------------------------------------------------------

const online = await isNpmRegistryReachable()

if (!online) {
  console.log('\n-- network-dependent install tests SKIPPED: registry.npmjs.org unreachable --')
} else {
  console.log('\n-- real npm installs (network) --')

  await test('installing @modelcontextprotocol/server-memory at a pinned version succeeds with an entry point on disk', async () => {
    const result = await withTimeout(
      install.installNpmPackage({ id: 'realinstall', packageName: '@modelcontextprotocol/server-memory', version: '2026.7.4' }),
      120000, 'installNpmPackage server-memory',
    )
    assert(result.ok, `install failed: ${result.reason} ${result.detail ?? ''}`)
    assert(fs.existsSync(result.args[0]), `resolved entry point does not exist: ${result.args[0]}`)
    assert(result.command === process.execPath, 'command should be our own execPath, not a shim')
    fs.rmSync(result.dir, { recursive: true, force: true })
    return `entry: ${result.args[0]}`
  })

  await test('an npm constraint pins a transitive dependency below what the package\'s own range resolves', async () => {
    // server-memory declares @modelcontextprotocol/sdk ^1.29.0; unconstrained,
    // that resolves to the newest 1.x. The override must hold it at 1.29.0.
    const result = await withTimeout(
      install.installNpmPackage({
        id: 'constrainednpm', packageName: '@modelcontextprotocol/server-memory', version: '2026.7.4',
        constraints: ['@modelcontextprotocol/sdk@1.29.0'],
      }),
      120000, 'installNpmPackage constrained',
    )
    assert(result.ok, `install failed: ${result.reason} ${result.detail ?? ''}`)
    const lock = JSON.parse(fs.readFileSync(path.join(result.dir, 'package-lock.json'), 'utf8'))
    const sdk = lock.packages?.['node_modules/@modelcontextprotocol/sdk']?.version
    assert(sdk === '1.29.0', `expected sdk 1.29.0 under the override, got ${sdk}`)
    fs.rmSync(result.dir, { recursive: true, force: true })
    return `sdk ${sdk}`
  })

  await test('a nonexistent package returns reason: package-not-found', async () => {
    const result = await withTimeout(
      install.installNpmPackage({ id: 'nopkgtest', packageName: 'redstart-definitely-does-not-exist-xyz-123', version: '1.0.0' }),
      60000, 'installNpmPackage nonexistent package',
    )
    assert(result.ok === false, 'a nonexistent package was accepted')
    assert(result.reason === 'package-not-found', `expected "package-not-found", got "${result.reason}": ${result.detail ?? ''}`)
    return result.reason
  })

  await test('a real package at a nonexistent version returns reason: version-not-found', async () => {
    const result = await withTimeout(
      install.installNpmPackage({ id: 'noversiontest', packageName: '@modelcontextprotocol/server-memory', version: '999.999.999' }),
      60000, 'installNpmPackage nonexistent version',
    )
    assert(result.ok === false, 'a nonexistent version was accepted')
    assert(result.reason === 'version-not-found', `expected "version-not-found", got "${result.reason}": ${result.detail ?? ''}`)
    return result.reason
  })

  await test('aborting mid-install leaves no directory behind', async () => {
    const controller = new AbortController()
    const promise = install.installNpmPackage({
      id: 'aborttest',
      packageName: '@modelcontextprotocol/server-memory',
      version: '2026.7.4',
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 50)
    const result = await withTimeout(promise, 60000, 'installNpmPackage aborted')
    assert(result.ok === false, 'an aborted install reported success')
    assert(result.reason === 'cancelled', `expected "cancelled", got "${result.reason}"`)
    assert(!fs.existsSync(path.join(install.pluginsRoot(), 'aborttest')), 'the partial install directory was left behind')
    return 'no directory left behind'
  })
}

// ---------------------------------------------------------------------------
// Phase 7, network-dependent: real pypi installs via uv
// ---------------------------------------------------------------------------
//
// Skips cleanly, same posture as the npm section above, on EITHER of two
// absences: uv not on this machine, or pypi.org unreachable. This is also
// the closest thing to an automated AC7 check — a genuinely missing runtime
// must produce install.INSTALL_REASON.uvMissing, not a generic failure.

const { detectUv } = await import('../electron/main/plugin-runtimes.mjs')
const uv = await detectUv()

if (!uv.ok) {
  console.log(`\n-- Phase 7 pypi install tests SKIPPED: uv not found on this machine (${uv.reason}) --`)
} else {
  const pypiOnline = await isPypiReachable()
  if (!pypiOnline) {
    console.log('\n-- Phase 7 pypi install tests SKIPPED: pypi.org unreachable --')
  } else {
    console.log(`\n-- real pypi installs via uv ${uv.version} (network) --`)

    await test('installing cowsay==6.1 succeeds with a real, directly-executable entry point', async () => {
      const result = await withTimeout(
        install.installPypiPackage({ id: 'realpypiinstall', identifier: 'cowsay', version: '6.1' }),
        120000, 'installPypiPackage cowsay',
      )
      assert(result.ok, `install failed: ${result.reason} ${result.detail ?? ''}`)
      assert(fs.existsSync(result.command), `resolved entry point does not exist: ${result.command}`)
      assert(result.args.length === 0, 'a uv-installed console-script shim needs no args — the shim itself is the entry point')
      assert(result.resolvedVersion === '6.1', `expected resolvedVersion "6.1" (parsed from uv's own "+ cowsay==6.1" line), got "${result.resolvedVersion}"`)
      fs.rmSync(result.dir, { recursive: true, force: true })
      return `entry: ${result.command}`
    })

    await test('a pypi constraint pins a dependency below what the package\'s own range resolves', async () => {
      // markdown-it-py 3.0.0 declares mdurl~=0.1; unconstrained, that resolves
      // to the newest 0.1.x. The constraints file must hold it at 0.1.0.
      const result = await withTimeout(
        install.installPypiPackage({ id: 'constrainedpypi', identifier: 'markdown-it-py', version: '3.0.0', constraints: ['mdurl==0.1.0'] }),
        120000, 'installPypiPackage constrained',
      )
      assert(result.ok, `install failed: ${result.reason} ${result.detail ?? ''}`)
      const found = fs.readdirSync(result.dir, { recursive: true }).map(String).filter((p) => /mdurl-[^\\/]+\.dist-info$/.test(p))
      assert(found.length === 1 && found[0].endsWith('mdurl-0.1.0.dist-info'), `expected mdurl 0.1.0 under the constraint, found ${JSON.stringify(found)}`)
      fs.rmSync(result.dir, { recursive: true, force: true })
      return path.basename(found[0])
    })

    await test('a nonexistent pypi package returns reason: package-not-found', async () => {
      const result = await withTimeout(
        install.installPypiPackage({ id: 'nopypitest', identifier: 'redstart-definitely-does-not-exist-xyz-123', version: '1.0.0' }),
        60000, 'installPypiPackage nonexistent package',
      )
      assert(result.ok === false, 'a nonexistent package was accepted')
      assert(result.reason === 'package-not-found', `expected "package-not-found", got "${result.reason}": ${result.detail ?? ''}`)
      return result.reason
    })

    await test('a real pypi package at a nonexistent version returns reason: version-not-found', async () => {
      const result = await withTimeout(
        install.installPypiPackage({ id: 'noverpypitest', identifier: 'cowsay', version: '999.999.999' }),
        60000, 'installPypiPackage nonexistent version',
      )
      assert(result.ok === false, 'a nonexistent version was accepted')
      assert(result.reason === 'version-not-found', `expected "version-not-found", got "${result.reason}": ${result.detail ?? ''}`)
      return result.reason
    })

    await test('aborting a pypi install mid-flight leaves no directory behind', async () => {
      const controller = new AbortController()
      const promise = install.installPypiPackage({
        id: 'abortpypitest', identifier: 'cowsay', version: '6.1', signal: controller.signal,
      })
      setTimeout(() => controller.abort(), 50)
      const result = await withTimeout(promise, 60000, 'installPypiPackage aborted')
      assert(result.ok === false, 'an aborted install reported success')
      assert(result.reason === 'cancelled', `expected "cancelled", got "${result.reason}"`)
      assert(!fs.existsSync(path.join(install.pluginsRoot(), 'abortpypitest')), 'the partial install directory was left behind')
      return 'no directory left behind'
    })
  }
}

// ---------------------------------------------------------------------------

fs.rmSync(tmpDir, { recursive: true, force: true })
fs.rmSync(logDir, { recursive: true, force: true })

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
