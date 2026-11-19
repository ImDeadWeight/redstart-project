// =============================================================================
// Twig trusts a beacon's HTTPS origin only if it names the responding IP
// =============================================================================
// TLS plan C7 / security invariant 9. Nest's beacon adds `origin` while its
// HTTPS is serving. Twig has always built its URL from the RESPONDING IP and
// never from anything the server says; that property is kept by using the
// origin only when its name resolves to that same IP. A spoofed beacon
// therefore cannot send Twig anywhere it could not already send it with its
// own address.
//
// Real HTTP beacons on loopback; DNS is injected.
//
// Run:  node scripts/test-beacon-origin.mjs
// =============================================================================

import * as http from 'node:http'
import { probeBeacon, verifiedOrigin } from '../daemon/network.mjs'

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
function assert(cond, message) { if (!cond) throw new Error(message) }

const lookupTo = (map) => async (name) => {
  if (!(name in map)) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
  return map[name].map((address) => ({ address, family: 4 }))
}

async function beacon(payload) {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) }
}

console.log('\n-- verifiedOrigin --')

await test('🔍 accepted only when the name resolves to the responding IP', async () => {
  const lookup = lookupTo({ 'myhouse.duckdns.org': ['192.168.0.213'] })
  assert(await verifiedOrigin('https://myhouse.duckdns.org', '192.168.0.213', { lookup }) === 'https://myhouse.duckdns.org', 'right IP refused')
  assert(await verifiedOrigin('https://myhouse.duckdns.org', '192.168.0.99', { lookup }) === null, 'a name pointing elsewhere was trusted')
  assert(await verifiedOrigin('https://unknown.example', '192.168.0.213', { lookup }) === null, 'an unresolvable name was trusted')
})

await test('🔍 a spoofed beacon naming someone else\'s host gains nothing', async () => {
  const lookup = lookupTo({ 'bank.example': ['203.0.113.10'] })
  assert(await verifiedOrigin('https://bank.example', '192.168.0.66', { lookup }) === null, 'phishing origin trusted')
})

await test('🔍 only a bare https origin is even looked up', async () => {
  let asked = 0
  const lookup = async () => { asked++; return [{ address: '192.168.0.213' }] }
  for (const bad of ['http://myhouse.duckdns.org', 'https://myhouse.duckdns.org/x', 'https://myhouse.duckdns.org:444', 'https://u@h.example', 'javascript:x', null, 7]) {
    assert(await verifiedOrigin(bad, '192.168.0.213', { lookup }) === null, `${bad} accepted`)
  }
  assert(asked === 0, `malformed origins reached DNS ${asked} times`)
})

console.log('\n-- probeBeacon --')

await test('no origin: the URL is built from the responding IP and port, as before', async () => {
  const b = await beacon({ app: 'redstart-nest', running: true, port: 19080 })
  try {
    const s = await probeBeacon('127.0.0.1', 1000, b.port)
    assert(s?.url === 'http://127.0.0.1:19080' && !s.secure, JSON.stringify(s))
  } finally { await b.close() }
})

await test('🔍 a verified origin becomes the URL; an unverified one is ignored', async () => {
  const b = await beacon({ app: 'redstart-nest', running: true, port: 80, origin: 'https://myhouse.duckdns.org' })
  try {
    const ok = await probeBeacon('127.0.0.1', 1000, b.port, { lookup: lookupTo({ 'myhouse.duckdns.org': ['127.0.0.1'] }) })
    assert(ok?.url === 'https://myhouse.duckdns.org' && ok.secure === true, JSON.stringify(ok))
    const no = await probeBeacon('127.0.0.1', 1000, b.port, { lookup: lookupTo({ 'myhouse.duckdns.org': ['10.9.9.9'] }) })
    assert(no?.url === 'http://127.0.0.1' && !no.secure, `unverified origin used: ${JSON.stringify(no)}`)
  } finally { await b.close() }
})

await test('port 80 (Nest behind Caddy) gives a URL without a port', async () => {
  const b = await beacon({ app: 'redstart-nest', running: true, port: 80 })
  try {
    const s = await probeBeacon('127.0.0.1', 1000, b.port)
    assert(s?.url === 'http://127.0.0.1', JSON.stringify(s))
  } finally { await b.close() }
})

await test('not Nest, or not running: nothing found', async () => {
  for (const payload of [{ app: 'other', running: true, port: 1 }, { app: 'redstart-nest', running: false, port: 1, origin: 'https://x.example' }]) {
    const b = await beacon(payload)
    try { assert(await probeBeacon('127.0.0.1', 1000, b.port) === null, JSON.stringify(payload)) } finally { await b.close() }
  }
})

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
