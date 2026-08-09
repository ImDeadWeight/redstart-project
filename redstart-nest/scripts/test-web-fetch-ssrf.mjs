// =============================================================================
// web_fetch SSRF guard — the model must not be able to reach the local network.
// =============================================================================
// With the whitelist ON, web_fetch is confined to approved domains and that is
// the primary control. With it OFF the tool may fetch any PUBLIC http(s) URL —
// and "public" has to mean the address as well as the name.
//
// Two halves, tested separately:
//
//   1. The literal check — what the URL SAYS. Rejects loopback, RFC1918,
//      link-local, .local names, IPv6 loopback/ULA, and non-http schemes.
//      Hermetic: no DNS, no network.
//
//   2. The resolution check — what the hostname RESOLVES to. A public name
//      pointed at 192.168.x.x walks straight past half 1, and needs no
//      attacker-controlled DNS to do it, just a hostile or careless record.
//      Needs real DNS, so those cases self-skip when offline.
//
// The range table itself (isPrivateAddress) is exported and driven directly,
// because both halves share it and a disagreement between them would be a hole.
//
// Run:  node scripts/test-web-fetch-ssrf.mjs
// =============================================================================

import { register } from 'node:module'
import * as dns from 'node:dns/promises'

register('./auth-test-loader.mjs', import.meta.url)

const webFetch = await import('../electron/main/web-fetch-tool.mjs')
const { isPrivateAddress, callTool } = webFetch

// Whitelist OFF — the posture this suite exists to test. With it on, the
// approved-domain list is the control and these URLs never get near a socket.
const OPEN_CONFIG = {
  webFetch: {
    enabled: true,
    whitelistEnabled: false,
    allowedBaseUrls: [],
    activeTools: [],
    maxFetchTokens: 500,
  },
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

const denied = (result) =>
  result?.isError === true && /Access denied/i.test(result.content?.[0]?.text ?? '')

async function fetchUrl(url) {
  return callTool('web_fetch', { url }, OPEN_CONFIG, { account: null })
}

// ---------------------------------------------------------------------------
// 1. The shared range table
// ---------------------------------------------------------------------------

console.log('\n-- private address ranges (shared by both halves of the guard) --')

await test('🔍 every private / loopback / link-local range is recognised', () => {
  const mustBePrivate = [
    '127.0.0.1', '127.1.2.3',        // loopback
    '10.0.0.1', '10.255.255.255',    // RFC1918 /8
    '172.16.0.1', '172.31.255.255',  // RFC1918 /12
    '192.168.0.1', '192.168.1.1',    // RFC1918 /16
    '169.254.1.1',                   // link-local / APIPA
    '0.0.0.0',                       // "this host"
    '::1',                           // IPv6 loopback
    'fe80::1',                       // IPv6 link-local
    'fc00::1', 'fd12:3456::1',       // IPv6 unique-local
    '::ffff:192.168.0.1',            // IPv4-mapped IPv6
  ]
  for (const addr of mustBePrivate) {
    assert(isPrivateAddress(addr), `${addr} was NOT classified private`)
  }
  return `${mustBePrivate.length} addresses`
})

await test('public addresses are not swept up by the ranges', () => {
  const mustBePublic = [
    '8.8.8.8', '1.1.1.1',
    '172.15.0.1', '172.32.0.1',  // just outside the /12
    '192.169.0.1', '191.168.0.1', // near-misses on the /16
    '11.0.0.1',
    '2606:4700::1111',            // public IPv6
  ]
  for (const addr of mustBePublic) {
    assert(!isPrivateAddress(addr), `${addr} was wrongly classified private`)
  }
  return `${mustBePublic.length} addresses`
})

// ---------------------------------------------------------------------------
// 2. Literal hostnames — hermetic
// ---------------------------------------------------------------------------

console.log('\n-- literal hostnames (no DNS involved) --')

await test('🔍 loopback and private literals are refused', async () => {
  const targets = [
    'http://127.0.0.1:19080/v1/chat/completions', // the gateway itself
    'http://127.0.0.1:19081/health',              // llama-server
    'http://localhost:19082/sse',                 // the MCP transport
    'http://192.168.1.1/',                        // a router admin page
    'http://10.0.0.5/',
    'http://172.16.0.1/',
    'http://169.254.169.254/latest/meta-data/',   // cloud metadata endpoint
    'http://[::1]:19080/',
    'http://redstart.local:19080/',
  ]
  for (const url of targets) {
    assert(denied(await fetchUrl(url)), `NOT refused: ${url}`)
  }
  return `${targets.length} targets refused`
})

await test('non-http(s) schemes are refused', async () => {
  for (const url of ['file:///C:/Windows/win.ini', 'ftp://example.com/x', 'gopher://example.com/']) {
    assert(denied(await fetchUrl(url)), `NOT refused: ${url}`)
  }
  return 'file/ftp/gopher'
})

// ---------------------------------------------------------------------------
// 3. Resolution — needs real DNS, self-skips offline
//
// sslip.io answers any <ip>.sslip.io with that IP, which is the cleanest way to
// get a genuinely PUBLIC hostname that resolves into private space — exactly
// the shape the literal check cannot see.
// ---------------------------------------------------------------------------

console.log('\n-- hostnames that resolve into private space --')

let dnsAvailable = false
try {
  const probe = await dns.lookup('127.0.0.1.sslip.io', { all: true })
  dnsAvailable = probe.some(r => r.address === '127.0.0.1')
} catch {
  dnsAvailable = false
}

if (!dnsAvailable) {
  console.log('  ..  - skipped: no internet DNS, or sslip.io did not resolve as expected')
} else {
  await test('🔍 a PUBLIC hostname resolving to loopback is refused', async () => {
    const result = await fetchUrl('http://127.0.0.1.sslip.io/')
    assert(denied(result), `not refused — got: ${result?.content?.[0]?.text?.slice(0, 120)}`)
    return 'literal check passes it, resolution check catches it'
  })

  await test('🔍 a PUBLIC hostname resolving into RFC1918 is refused', async () => {
    const result = await fetchUrl('http://192.168.0.1.sslip.io/')
    assert(denied(result), `not refused — got: ${result?.content?.[0]?.text?.slice(0, 120)}`)
    return '192.168.0.1 via public DNS'
  })

  await test('a hostname that does not resolve is refused, not attempted', async () => {
    const result = await fetchUrl('http://this-name-should-not-exist-redstart-test.invalid/')
    assert(denied(result), 'an unresolvable host should fail as policy, not as a network error')
    return 'fails closed'
  })
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
