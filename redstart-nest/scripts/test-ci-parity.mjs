// =============================================================================
// CI parity — every local security suite must also gate merges.
// =============================================================================
// `npm run test:security` and .github/workflows/ci.yml list the suites
// independently, so they drift: a suite added to the npm script but not to the
// workflow still passes locally while silently not gating a single pull
// request. That had already happened to six suites before this check existed.
//
// Run:  node scripts/test-ci-parity.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(here, '..')
const workflow = path.join(repoRoot, '..', '.github', 'workflows', 'ci.yml')

const results = []

function test(name, fn) {
  try {
    const detail = fn()
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

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const testSecurity = pkg.scripts?.['test:security'] ?? ''

// Suites the npm script runs, in the two forms it uses them.
const scriptSuites = new Set(
  [...testSecurity.matchAll(/node (scripts\/[\w.-]+\.mjs)/g)].map(m => m[1])
)
const scriptRunsChatUiVitest = /npm --prefix src\/chat-ui run test:security/.test(testSecurity)

console.log('\n-- test:security vs .github/workflows/ci.yml --')

test('the CI workflow exists where this check expects it', () => {
  assert(fs.existsSync(workflow), `no workflow at ${workflow}`)
})

const ci = fs.existsSync(workflow) ? fs.readFileSync(workflow, 'utf8') : ''
const ciSuites = new Set([...ci.matchAll(/node (scripts\/[\w.-]+\.mjs)/g)].map(m => m[1]))

test('🔍 every suite in test:security is also a step in CI', () => {
  assert(scriptSuites.size > 0, 'parsed no suites out of test:security — has the script format changed?')
  const missing = [...scriptSuites].filter(s => !ciSuites.has(s)).sort()
  assert(
    missing.length === 0,
    `these run locally but do NOT gate pull requests — add a step to ci.yml: ${missing.join(', ')}`
  )
  return `${scriptSuites.size} suites`
})

test('every suite CI runs is also in test:security (so it runs before a push)', () => {
  const missing = [...ciSuites].filter(s => !scriptSuites.has(s)).sort()
  assert(
    missing.length === 0,
    `CI runs suites that test:security does not — add them to package.json: ${missing.join(', ')}`
  )
})

test('🔍 every referenced suite file actually exists', () => {
  const broken = [...new Set([...scriptSuites, ...ciSuites])]
    .filter(s => !fs.existsSync(path.join(repoRoot, s)))
    .sort()
  assert(broken.length === 0, `referenced but missing: ${broken.join(', ')}`)
})

test('the chat-ui vitest security project runs in both places', () => {
  assert(scriptRunsChatUiVitest, 'test:security no longer runs the chat-ui vitest suite')
  assert(
    /npm --prefix src\/chat-ui run test:security/.test(ci),
    'CI no longer runs the chat-ui vitest security suite'
  )
})

test('every scripts/test-*.mjs file is wired into test:security', () => {
  // A suite nobody runs is a suite nobody maintains.
  const onDisk = fs
    .readdirSync(path.join(repoRoot, 'scripts'))
    .filter(f => f.startsWith('test-') && f.endsWith('.mjs'))
    .map(f => `scripts/${f}`)
  const orphans = onDisk.filter(s => !scriptSuites.has(s)).sort()
  assert(orphans.length === 0, `test files that nothing runs: ${orphans.join(', ')}`)
  return `${onDisk.length} files`
})

const passed = results.filter(r => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
