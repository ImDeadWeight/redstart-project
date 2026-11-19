// =============================================================================
// proxy-trust.mjs — the bundled Caddy is trusted, and nothing else (TLS plan C6)
// =============================================================================
// Pure cases over fake requests. The route-level proof (the chat login's
// rate limit keyed on it) is in test-auth.mjs; the proof that Caddy really
// overwrites both headers is in test-caddy-live.mjs.
//
// Run:  node scripts/test-proxy-trust.mjs
// =============================================================================

import {
  newProxySecret, clearProxySecret, hasProxySecret, isFromOwnProxy, clientAddress, PROXY_HEADER_NAME,
} from '../daemon/proxy-trust.mjs'
import { withoutProxySecret } from '../daemon/gateway/upstream.mjs'

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

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const req = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers })

console.log('\n-- no secret: nothing is trusted --')

test('🔍 without Nest\'s Caddy, clientAddress is the socket peer whatever the headers say', () => {
  clearProxySecret()
  const r = req('127.0.0.1', { 'x-forwarded-for': '10.0.0.9', [PROXY_HEADER_NAME]: '' })
  assert(!isFromOwnProxy(r) && clientAddress(r) === '127.0.0.1', clientAddress(r))
  assert(clientAddress(req('192.168.1.5', { 'x-forwarded-for': '1.2.3.4' })) === '192.168.1.5', 'LAN XFF trusted')
  assert(clientAddress({}) === 'unknown', 'missing socket')
})

console.log('\n-- with the secret --')

const secret = newProxySecret()

test('the secret is 32 random bytes (64 hex) and new per call', () => {
  assert(/^[0-9a-f]{64}$/.test(secret), secret)
  const second = newProxySecret()
  assert(second !== secret, 'same secret twice')
  // Restore the one the rest of this file uses.
  clearProxySecret()
  assert(!hasProxySecret(), 'clear did not clear')
})

const s = newProxySecret()

test('🔍 loopback + the secret → the first X-Forwarded-For hop', () => {
  const r = req('127.0.0.1', { [PROXY_HEADER_NAME]: s, 'x-forwarded-for': '192.168.1.20, 10.0.0.1' })
  assert(isFromOwnProxy(r) && clientAddress(r) === '192.168.1.20', clientAddress(r))
  assert(clientAddress(req('::1', { [PROXY_HEADER_NAME]: s, 'x-forwarded-for': 'fd00::5' })) === 'fd00::5', 'IPv6 loopback / ULA')
  assert(clientAddress(req('::ffff:127.0.0.1', { [PROXY_HEADER_NAME]: s, 'x-forwarded-for': '192.168.1.21' })) === '192.168.1.21', 'v4-mapped loopback')
})

test('🔍 a wrong, truncated, padded or missing secret is not the proxy', () => {
  for (const h of ['guess', s.slice(0, -1), s + '0', s.toUpperCase(), ` ${s}`, undefined]) {
    const r = req('127.0.0.1', { [PROXY_HEADER_NAME]: h, 'x-forwarded-for': '10.0.0.9' })
    assert(!isFromOwnProxy(r) && clientAddress(r) === '127.0.0.1', `header ${JSON.stringify(h)} trusted`)
  }
  const arr = req('127.0.0.1', { [PROXY_HEADER_NAME]: [s, s], 'x-forwarded-for': '10.0.0.9' })
  assert(!isFromOwnProxy(arr), 'a repeated header (array) was trusted')
})

test('🔍 the real secret from a non-loopback peer is not the proxy', () => {
  for (const peer of ['192.168.1.5', '10.0.0.1', 'fd00::1', '::ffff:192.168.1.5', undefined]) {
    const r = req(peer, { [PROXY_HEADER_NAME]: s, 'x-forwarded-for': '10.0.0.9' })
    assert(!isFromOwnProxy(r), `peer ${peer} trusted`)
  }
})

test('a forwarded value that is not an IP falls back to the socket', () => {
  for (const xff of ['', 'unknown', 'evil.example', '10.0.0.999', '<script>']) {
    const r = req('127.0.0.1', { [PROXY_HEADER_NAME]: s, 'x-forwarded-for': xff })
    assert(clientAddress(r) === '127.0.0.1', `${JSON.stringify(xff)} → ${clientAddress(r)}`)
  }
})

test('🔍 after clearProxySecret the old secret is worthless', () => {
  clearProxySecret()
  const r = req('127.0.0.1', { [PROXY_HEADER_NAME]: s, 'x-forwarded-for': '10.0.0.9' })
  assert(!isFromOwnProxy(r), 'a stopped Caddy\'s secret is still trusted')
})

console.log('\n-- the secret stays in the gateway --')

test('🔍 the passthrough to llama-server drops the secret header and keeps the rest', () => {
  const h = withoutProxySecret({ [PROXY_HEADER_NAME]: 'x', authorization: 'Bearer t', host: 'h' })
  assert(!(PROXY_HEADER_NAME in h) && h.authorization === 'Bearer t' && h.host === 'h', JSON.stringify(h))
})

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
