// =============================================================================
// Unit tests for electron/main/plugin-runtimes.mjs — npm/uv detection.
// =============================================================================
// npmCliPathCandidates() is exported specifically so this suite can assert
// BOTH real layouts without depending on which one happens to be true on the
// machine running the test — the bug this suite exists to pin only showed up
// on this branch's first-ever CI run (Linux), never having been exercised
// outside local Windows dev: detectNpm() derived only the Windows ZIP
// layout (node_modules/npm beside node.exe), which does not exist on any
// POSIX install (Linux distro packages, Homebrew, nvm, GitHub Actions'
// setup-node all use <prefix>/bin/node + sibling <prefix>/lib/node_modules/
// npm/...). Every real npm-dependent plugin-install test failed on CI as a
// result, even though the same code had run cleanly on Windows for weeks.
//
// No Electron dependency in this module, so this runs under plain node —
// same posture as test-plugin-registry-api.mjs.
//
// Run:  node scripts/test-plugin-runtimes.mjs
// =============================================================================

import * as path from 'node:path'
import { npmCliPathCandidates, detectNode, detectNpm, detectUv, RUNTIME_REASON } from '../electron/main/plugin-runtimes.mjs'

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

// ---------------------------------------------------------------------------

console.log('\n-- npmCliPathCandidates(): both real layouts, not just one --')

await test('🔍 a Windows-style node execPath yields the ZIP-distribution candidate (node_modules beside node.exe)', async () => {
  const candidates = npmCliPathCandidates('C:\\Program Files\\nodejs\\node.exe')
  const expected = path.join('C:\\Program Files\\nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  assert(candidates.includes(expected), `expected ${expected} among ${JSON.stringify(candidates)}`)
})

await test('🔍 a POSIX-style node execPath (<prefix>/bin/node) yields the sibling <prefix>/lib/node_modules candidate — this is the exact layout that was missing before, and the reason every real-npm-install test failed on CI', async () => {
  const candidates = npmCliPathCandidates('/opt/hostedtoolcache/node/22.23.2/x64/bin/node')
  const expected = path.join('/opt/hostedtoolcache/node/22.23.2/x64/bin', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  assert(candidates.includes(expected), `expected ${expected} among ${JSON.stringify(candidates)}`)
})

await test('exactly two candidates are offered, in a stable order (Windows layout tried first)', async () => {
  const candidates = npmCliPathCandidates('/usr/local/bin/node')
  assert(candidates.length === 2, `expected 2 candidates, got ${candidates.length}`)
  assert(candidates[0].includes('node_modules') && !candidates[0].includes('lib'), 'Windows-layout candidate should come first')
})

console.log('\n-- live detection on this machine --')

await test('detectNode() finds a real node on this machine\'s PATH (the test runner itself proves one exists)', async () => {
  const node = await detectNode()
  assert(node.ok, `detectNode() failed on a machine that is, by definition, running node: ${node.reason}`)
  return `${node.execPath} (${node.version})`
})

await test('🔍 detectNpm() finds real npm on THIS machine, whichever layout applies here — the actual regression check', async () => {
  const npm = await detectNpm()
  assert(npm.ok, `detectNpm() failed on a machine running these tests via npm: ${npm.reason}`)
  return `${npm.cliPath} (${npm.version})`
})

await test('detectUv() never throws, whether or not uv happens to be installed here', async () => {
  const uv = await detectUv()
  if (uv.ok) {
    assert(typeof uv.execPath === 'string' && uv.execPath, 'ok:true but execPath missing')
    return `found: ${uv.execPath} (${uv.version})`
  }
  assert(uv.reason === RUNTIME_REASON.uvNotFound, `expected reason "${RUNTIME_REASON.uvNotFound}", got "${uv.reason}"`)
  return 'not found (acceptable — uv is optional)'
})

// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
