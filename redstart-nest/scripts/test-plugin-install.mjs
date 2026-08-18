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
//   - NETWORK-FREE: argv construction. Always runs.
//
// Run:  node scripts/test-plugin-install.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-plugin-install-test-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir

register('./auth-test-loader.mjs', import.meta.url)

const install = await import('../electron/main/plugin-install.mjs')

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

fs.rmSync(tmpDir, { recursive: true, force: true })

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
