// =============================================================================
// Unit tests for electron/main/plugin-registry-api.mjs — the official MCP
// registry client (task T18).
// =============================================================================
// FIXTURE-DRIVEN, NEVER LIVE NETWORK. A suite inside test:security must not
// fail because registry.modelcontextprotocol.io is down — see the plan's own
// constraint on this suite. verdictFor()/formFieldsFor() are pure functions
// tested directly against recorded scripts/fixtures/registry-*.json; the one
// searchRegistry() test stubs global.fetch rather than calling out.
//
// No Electron dependency in the module under test, so this runs under plain
// node — same posture as scripts/test-plugin-client.mjs.
//
// Run:  node scripts/test-plugin-registry-api.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { searchRegistry, verdictFor, formFieldsFor, VERDICT, REGISTRY_BASE } from '../electron/main/plugin-registry-api.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(__dirname, 'fixtures')

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'))
}

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

console.log('\n-- verdictFor(): one case per state --')

await test('a pinned npm package with no required fields is installable', async () => {
  const v = verdictFor(loadFixture('registry-installable.json'))
  assert(v.state === VERDICT.installable, `expected installable, got ${JSON.stringify(v)}`)
  assert(v.packageRef?.registryType === 'npm', 'packageRef should be the npm package')
  return v.state
})

await test('a pinned npm package with an isRequired env var is needs-setup', async () => {
  const v = verdictFor(loadFixture('registry-needs-setup.json'))
  assert(v.state === VERDICT.needsSetup, `expected needs-setup, got ${JSON.stringify(v)}`)
  return v.state
})

await test('🔍 a pinned pypi-only package is installable (Phase 7 — was needs-runtime before this resolver landed)', async () => {
  const v = verdictFor(loadFixture('registry-needs-runtime-python.json'))
  assert(v.state === VERDICT.installable, `expected installable, got ${JSON.stringify(v)}`)
  assert(v.packageRef?.registryType === 'pypi', `expected the pypi package chosen, got ${v.packageRef?.registryType}`)
  return v.state
})

await test('🔍 a pypi package with no version pin is unsupported, reason unpinned (D5 applies identically to pypi)', async () => {
  const v = verdictFor({
    server: {
      packages: [{ registryType: 'pypi', identifier: 'some-pypi-mcp-server', version: 'latest', transport: { type: 'stdio' } }],
    },
  })
  assert(v.state === VERDICT.unsupported, `expected unsupported, got ${JSON.stringify(v)}`)
  assert(v.reason === 'unpinned', `expected reason "unpinned", got "${v.reason}"`)
  return `${v.state}/${v.reason}`
})

await test('an oci-only package is unsupported, reason docker', async () => {
  const v = verdictFor(loadFixture('registry-unsupported-oci.json'))
  assert(v.state === VERDICT.unsupported, `expected unsupported, got ${JSON.stringify(v)}`)
  assert(v.reason === 'docker', `expected reason "docker", got "${v.reason}"`)
  return `${v.state}/${v.reason}`
})

await test('an mcpb-only package is unsupported, reason bundle', async () => {
  const v = verdictFor(loadFixture('registry-unsupported-mcpb.json'))
  assert(v.state === VERDICT.unsupported, `expected unsupported, got ${JSON.stringify(v)}`)
  assert(v.reason === 'bundle', `expected reason "bundle", got "${v.reason}"`)
  return `${v.state}/${v.reason}`
})

await test('a remote-only entry (no packages[]) is unsupported, reason remote', async () => {
  const v = verdictFor(loadFixture('registry-unsupported-remote.json'))
  assert(v.state === VERDICT.unsupported, `expected unsupported, got ${JSON.stringify(v)}`)
  assert(v.reason === 'remote', `expected reason "remote", got "${v.reason}"`)
  return `${v.state}/${v.reason}`
})

await test('an unpinned npm package (version "latest") is unsupported, reason unpinned', async () => {
  const v = verdictFor(loadFixture('registry-unsupported-unpinned.json'))
  assert(v.state === VERDICT.unsupported, `expected unsupported, got ${JSON.stringify(v)}`)
  assert(v.reason === 'unpinned', `expected reason "unpinned", got "${v.reason}"`)
  return `${v.state}/${v.reason}`
})

await test('a deprecated entry is unsupported, reason inactive', async () => {
  const v = verdictFor(loadFixture('registry-unsupported-inactive.json'))
  assert(v.state === VERDICT.unsupported, `expected unsupported, got ${JSON.stringify(v)}`)
  assert(v.reason === 'inactive', `expected reason "inactive", got "${v.reason}"`)
  return `${v.state}/${v.reason}`
})

await test('an unrecognised registryType is unsupported, reason unknown-runtime — not dropped', async () => {
  const v = verdictFor(loadFixture('registry-unknown-runtime.json'))
  assert(v.state === VERDICT.unsupported, `expected unsupported, got ${JSON.stringify(v)}`)
  assert(v.reason === 'unknown-runtime', `expected reason "unknown-runtime", got "${v.reason}"`)
  return `${v.state}/${v.reason}`
})

console.log('\n-- verdictFor(): multi-package entries pick the best offered runtime --')

await test('npm beats oci even when listed second', async () => {
  const v = verdictFor(loadFixture('registry-multi-package-prefers-npm.json'))
  assert(v.state === VERDICT.installable, `expected installable, got ${JSON.stringify(v)}`)
  assert(v.packageRef?.registryType === 'npm', `expected the npm package chosen, got ${v.packageRef?.registryType}`)
  return 'npm chosen over oci'
})

await test('pypi beats oci and mcpb when no npm package is offered, and is now installable itself (Phase 7)', async () => {
  const v = verdictFor(loadFixture('registry-multi-package-picks-best.json'))
  assert(v.state === VERDICT.installable, `expected installable, got ${JSON.stringify(v)}`)
  assert(v.packageRef?.registryType === 'pypi', `expected the pypi package chosen, got ${v.packageRef?.registryType}`)
  return 'pypi chosen over oci/mcpb'
})

console.log('\n-- verdictFor(): never throws --')

await test('a malformed entry (packages not an array, unrecognised $schema) does not throw', async () => {
  const v = verdictFor(loadFixture('registry-malformed.json'))
  assert(v && typeof v.state === 'string', `expected a verdict object, got ${JSON.stringify(v)}`)
  return v.state
})

await test('a completely empty entry does not throw', async () => {
  const v = verdictFor({})
  assert(v && typeof v.state === 'string', `expected a verdict object, got ${JSON.stringify(v)}`)
  return v.state
})

await test('null/undefined input does not throw', async () => {
  assert(typeof verdictFor(null).state === 'string', 'null input threw or returned a bad shape')
  assert(typeof verdictFor(undefined).state === 'string', 'undefined input threw or returned a bad shape')
  return 'both handled'
})

// ---------------------------------------------------------------------------

console.log('\n-- formFieldsFor(): fail-safe masking --')

await test('a field flagged isSecret is masked', async () => {
  const v = verdictFor(loadFixture('registry-needs-setup.json'))
  const { fields } = formFieldsFor(v.packageRef)
  const key = fields.find((f) => f.name === 'GCS_PRIVATE_KEY')
  assert(key, 'GCS_PRIVATE_KEY missing from generated fields')
  assert(key.isSecret === true, 'a field with isSecret:true was not masked')
  return 'masked via flag'
})

await test('a field named like a secret but with NO isSecret flag is still masked (fail-safe)', async () => {
  const v = verdictFor(loadFixture('registry-needs-setup.json'))
  const { fields } = formFieldsFor(v.packageRef)
  const token = fields.find((f) => f.name === 'GCS_API_TOKEN')
  assert(token, 'GCS_API_TOKEN missing from generated fields')
  assert(token.isSecret === true, 'a *_TOKEN field with no isSecret flag was NOT masked — this is the exact caution the plan calls out')
  return 'masked via name pattern despite missing flag'
})

await test('a plain, non-secret-looking field is not masked', async () => {
  const v = verdictFor(loadFixture('registry-installable.json'))
  const { fields } = formFieldsFor(v.packageRef)
  const logLevel = fields.find((f) => f.name === 'LOG_LEVEL')
  assert(logLevel, 'LOG_LEVEL missing from generated fields')
  assert(logLevel.isSecret === false, 'a plain field was masked for no reason')
  assert(logLevel.default === 'info', 'default value did not pass through')
  return 'not masked, default preserved'
})

await test('isRequired passes through so the form can block submission', async () => {
  const v = verdictFor(loadFixture('registry-needs-setup.json'))
  const { fields } = formFieldsFor(v.packageRef)
  const bucket = fields.find((f) => f.name === 'GCS_BUCKET')
  assert(bucket?.isRequired === true, 'isRequired did not pass through')
  return 'isRequired preserved'
})

await test('formFieldsFor(undefined) returns an empty field list rather than throwing', async () => {
  const { fields } = formFieldsFor(undefined)
  assert(Array.isArray(fields) && fields.length === 0, 'expected an empty array')
  return 'empty, no throw'
})

// ---------------------------------------------------------------------------
// searchRegistry() — fetch is stubbed, never real network.
// ---------------------------------------------------------------------------

console.log('\n-- searchRegistry(): parsing (fetch stubbed, no live network) --')

const realFetch = globalThis.fetch

async function withStubbedFetch(handler, fn) {
  globalThis.fetch = handler
  try {
    return await fn()
  } finally {
    globalThis.fetch = realFetch
  }
}

await test('a successful response returns entries + nextCursor, and hits REGISTRY_BASE', async () => {
  let calledUrl = null
  const body = loadFixture('registry-search-response.json')
  const result = await withStubbedFetch(
    async (url) => {
      calledUrl = String(url)
      return { ok: true, status: 200, json: async () => body }
    },
    () => searchRegistry({ query: 'filesystem' }),
  )
  assert(calledUrl.startsWith(REGISTRY_BASE), `did not call REGISTRY_BASE: ${calledUrl}`)
  assert(calledUrl.includes('search=filesystem'), `search query missing from URL: ${calledUrl}`)
  assert(calledUrl.includes('version=latest'), `version=latest missing from URL: ${calledUrl}`)
  assert(result.entries.length === 2, `expected 2 entries, got ${result.entries?.length}`)
  assert(result.nextCursor === 'opaque-cursor-value', `nextCursor not parsed: ${JSON.stringify(result)}`)
  return `${result.entries.length} entries, cursor: ${result.nextCursor}`
})

await test('a network failure returns { error }, never throws', async () => {
  const result = await withStubbedFetch(
    async () => { throw new Error('getaddrinfo ENOTFOUND registry.modelcontextprotocol.io') },
    () => searchRegistry({ query: 'anything' }),
  )
  assert(typeof result.error === 'string' && result.error.length > 0, `expected an error string, got ${JSON.stringify(result)}`)
  return result.error
})

await test('a non-OK HTTP status returns { error }, never throws', async () => {
  const result = await withStubbedFetch(
    async () => ({ ok: false, status: 503 }),
    () => searchRegistry({ query: 'anything' }),
  )
  assert(typeof result.error === 'string' && result.error.includes('503'), `expected an error mentioning 503, got ${JSON.stringify(result)}`)
  return result.error
})

await test('a response with no "servers" array degrades to an empty list, not an error (schema drift)', async () => {
  const result = await withStubbedFetch(
    async () => ({ ok: true, status: 200, json: async () => ({ somethingElse: true }) }),
    () => searchRegistry({ query: 'anything' }),
  )
  assert(Array.isArray(result.entries) && result.entries.length === 0, `expected an empty entries array, got ${JSON.stringify(result)}`)
  assert(result.error === undefined, 'a missing servers array should not be reported as an error')
  return 'empty entries, no error'
})

// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
