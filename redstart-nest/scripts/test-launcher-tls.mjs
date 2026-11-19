// =============================================================================
// The launcher's "Secure address" logic: addresses + the status line (C7/C8)
// =============================================================================
// The two pure modules behind the panel, imported as TypeScript (Node strips
// erasable types natively):
//
//   addresses.ts  the HTTPS name leads, and goes in the QR code, ONLY while
//                 serving; the IP is labelled "not encrypted" and loses its
//                 port once Caddy owns :80; sslip disappears once a name exists;
//                 with HTTPS off the list is exactly what it was before
//   tlsStatus.ts  one sentence per state, in priority order; staging is
//                 called out; the egress sentence names the provider and says
//                 nothing about conversations leaves
//
// Run:  node scripts/test-launcher-tls.mjs
// =============================================================================

import { buildAddresses } from '../src/launcher/panels/addresses.ts'
import { tlsStatusLine, egressSentence } from '../src/launcher/panels/tlsStatus.ts'

const results = []
function test(name, fn) {
  try {
    const detail = fn()
    results.push({ name, pass: true, detail })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false, detail: err.message })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}
function assert(cond, message) { if (!cond) throw new Error(message) }

const IP = '192.168.0.213'
const NAME = 'myhouse.duckdns.org'

console.log('\n-- addresses --')

test('🔍 HTTPS off: exactly the old list (IP with port, then sslip)', () => {
  const a = buildAddresses(IP, 19080)
  assert(a.map((x) => x.key).join(',') === 'ip,sslip' && a[0].url === `http://${IP}:19080`, JSON.stringify(a))
})

test('🔍 serving: the HTTPS name first (so it is the QR), the IP "not encrypted", no sslip', () => {
  const a = buildAddresses(IP, 19080, { name: NAME, serving: true })
  assert(a.map((x) => x.key).join(',') === 'https,ip', a.map((x) => x.key).join(','))
  assert(a[0].url === `https://${NAME}`, a[0].url)
  assert(a[1].url === `http://${IP}` && /Not encrypted/.test(a[1].note), `${a[1].url} / ${a[1].note}`)
})

test('🔍 set up but not serving yet: no https row, so the QR never points at a name that does not work', () => {
  const a = buildAddresses(IP, 19080, { name: NAME, serving: false })
  assert(a[0].key === 'ip' && !a.some((x) => x.key === 'https' || x.key === 'sslip'), a.map((x) => x.key).join(','))
  assert(/Works until the secure address is ready/.test(a[0].note), a[0].note)
  const req = buildAddresses(IP, 19080, { name: NAME, serving: false, requireHttps: true })
  assert(/Switched off/.test(req[0].note), `requireHttps: the IP row still promises it works: ${req[0].note}`)
})

test('no LAN address: only the HTTPS name, when serving', () => {
  assert(buildAddresses('', 19080).length === 0, 'empty')
  assert(buildAddresses('127.0.0.1', 19080, { name: NAME, serving: true }).map((x) => x.key).join(',') === 'https', 'loopback')
})

console.log('\n-- the status line --')

const base = (over = {}) => ({
  settings: { mode: 'own', provider: 'duckdns', name: NAME, hasToken: true, requireHttps: false, acmeStaging: false },
  state: 'lan-https', lastError: null, caddy: { state: 'running', reason: null, lastAcmeError: null, lastCertificateAt: 1 },
  serving: true, health: { serving: true, reason: null, cert: { validTo: '', daysLeft: 60, issuer: "Let's Encrypt", staging: false } },
  warnings: [], address: null, switching: null, lastSwitchFailure: null, egress: [], ...over,
})
const set = (over) => ({ ...base().settings, ...over })

test('🔍 one sentence per state, the right tone', () => {
  const rows = [
    [null, true, 'off', /Loading/],
    [base({ settings: set({ mode: 'off' }) }), true, 'off', /without encryption/],
    [base({ state: 'local' }), false, 'off', /Turn on Local network/],
    [base({ lastError: 'HTTPS is not configured' }), true, 'error', /Couldn't apply.*not configured/],
    [base({ lastSwitchFailure: 'b.duckdns.org didn\'t start working' }), true, 'warn', /didn't start working/],
    [base({ state: 'lan-https-fallback', caddy: { state: 'failed', reason: 'Port 443 is in use by another program' } }), true, 'warn', /Port 443 is in use.*plain HTTP/],
    [base({ caddy: { state: 'failed', reason: 'Port 80 is in use' }, settings: set({ requireHttps: true }), serving: false }), true, 'error', /can't connect until it works/],
    [base({ switching: { name: 'b.duckdns.org', deadline: 0 } }), true, 'progress', /Switching to b\.duckdns\.org/],
    [base({ serving: false, caddy: { state: 'running', lastAcmeError: 'HTTP 429 rateLimited' } }), true, 'progress', /429/],
    [base({ serving: false }), true, 'progress', /usually under a minute/],
    [base(), true, 'ok', /^Ready\.$/],
  ]
  for (const [s, nm, tone, re] of rows) {
    const l = tlsStatusLine(s, nm)
    assert(l.tone === tone && re.test(l.text), `${JSON.stringify(s?.state)} ${s?.lastError ?? ''} → ${l.tone}: ${l.text}`)
  }
  return `${rows.length} rows`
})

test('staging certificates are called out, so a browser warning is not a surprise', () => {
  const l = tlsStatusLine(base({ health: { serving: true, reason: null, cert: { staging: true } } }), true)
  assert(l.tone === 'ok' && /browsers will warn/.test(l.text), l.text)
})

test('🔍 the egress sentence names the provider and promises nothing about conversations leaves', () => {
  const e = egressSentence(base())
  assert(/DuckDNS/.test(e) && /Let's Encrypt/.test(e) && /Nothing about your conversations/.test(e), e)
  assert(/deSEC/.test(egressSentence(base({ settings: set({ provider: 'desec' }) }))), 'deSEC')
  assert(egressSentence(base({ settings: set({ mode: 'off' }) })) === '', 'off sends nothing')
})

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
