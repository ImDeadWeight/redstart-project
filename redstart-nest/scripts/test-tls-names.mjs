// =============================================================================
// The name providers and the address watcher (TLS plan C4)
// =============================================================================
// A fake fetch records exactly what would leave the box:
//   - only a PRIVATE address is ever published (never a public one);
//   - DuckDNS gets the token in its query (its only option), deSEC in a header;
//   - only the provider's own HTTPS endpoint is called;
//   - provider answers map to one sentence; a network error never carries
//     the token;
//   - the watcher publishes once, then only when the address changes (or the
//     last attempt failed), and stops cleanly.
//
// Run:  node scripts/test-tls-names.mjs
// =============================================================================

import { nameProvider, createAddressWatcher, isPrivateIPv4, registerName, heartbeatName, releaseName, nameServiceUrl, NAME_SERVICE_URL } from '../daemon/tls-names.mjs'

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

const TOKEN = 'tok-abcdef-123456'
function fakeFetch(status, body) {
  const calls = []
  const impl = async (url, opts = {}) => { calls.push({ url: String(url), headers: opts.headers ?? {} }); return { status, text: async () => body } }
  return { calls, impl }
}

console.log('\n-- private addresses only --')

await test('🔍 isPrivateIPv4: RFC 1918 + CGNAT yes; public, loopback, link-local, junk no', () => {
  for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.0.213', '100.64.1.2']) assert(isPrivateIPv4(ip), ip)
  for (const ip of ['8.8.8.8', '172.32.0.1', '127.0.0.1', '169.254.1.1', '192.169.0.1', '100.128.0.1', '256.1.1.1', '10.0.0', '::1', 'x']) assert(!isPrivateIPv4(ip), ip)
})

await test('🔍 neither provider will publish a public address, and calls nobody trying', async () => {
  for (const provider of ['duckdns', 'desec']) {
    const f = fakeFetch(200, 'OK')
    const p = nameProvider({ provider, name: provider === 'duckdns' ? 'h.duckdns.org' : 'h.dedyn.io' })
    const r = await p.updateAddress('203.0.113.5', { token: TOKEN, fetchImpl: f.impl })
    assert(!r.ok && /not a private address/.test(r.detail) && f.calls.length === 0, `${provider}: ${JSON.stringify(r)} ${f.calls.length} calls`)
  }
})

console.log('\n-- DuckDNS --')

await test('🔍 the update goes to www.duckdns.org over HTTPS with subdomain, token, ip', async () => {
  const f = fakeFetch(200, 'OK')
  const r = await nameProvider({ provider: 'duckdns', name: 'myhouse.duckdns.org' }).updateAddress('192.168.0.213', { token: TOKEN, fetchImpl: f.impl })
  assert(r.ok, JSON.stringify(r))
  const u = new URL(f.calls[0].url)
  assert(u.origin === 'https://www.duckdns.org' && u.pathname === '/update', u.origin + u.pathname)
  assert(u.searchParams.get('domains') === 'myhouse' && u.searchParams.get('token') === TOKEN && u.searchParams.get('ip') === '192.168.0.213', u.search)
})

await test('KO and HTTP errors are one sentence each', async () => {
  const p = nameProvider({ provider: 'duckdns', name: 'myhouse.duckdns.org' })
  assert(/check the name and token/.test((await p.updateAddress('10.0.0.2', { token: TOKEN, fetchImpl: fakeFetch(200, 'KO').impl })).detail), 'KO')
  assert(/answered 500/.test((await p.updateAddress('10.0.0.2', { token: TOKEN, fetchImpl: fakeFetch(500, '').impl })).detail), '500')
})

await test('🔍 a network error never carries the token (the URL holds it)', async () => {
  const p = nameProvider({ provider: 'duckdns', name: 'myhouse.duckdns.org' })
  const r = await p.updateAddress('10.0.0.2', { token: TOKEN, fetchImpl: async (url) => { throw new Error(`fetch failed for ${url}`) } })
  assert(!r.ok && !r.detail.includes(TOKEN) && /redacted/.test(r.detail), r.detail)
})

console.log('\n-- deSEC --')

await test('🔍 the update goes to update.dedyn.io with the token in a header, not the URL', async () => {
  const f = fakeFetch(200, 'good 192.168.0.213')
  const r = await nameProvider({ provider: 'desec', name: 'myhouse.dedyn.io' }).updateAddress('192.168.0.213', { token: TOKEN, fetchImpl: f.impl })
  assert(r.ok && r.detail === 'good', JSON.stringify(r))
  const u = new URL(f.calls[0].url)
  assert(u.origin === 'https://update.dedyn.io' && u.searchParams.get('hostname') === 'myhouse.dedyn.io' && u.searchParams.get('myipv4') === '192.168.0.213', f.calls[0].url)
  assert(!f.calls[0].url.includes(TOKEN) && f.calls[0].headers.Authorization === `Token ${TOKEN}`, 'token placement')
  assert(u.searchParams.get('myipv6') === 'preserve', 'an IPv6 record would be cleared')
})

await test('deSEC: nochg is success; 401 names the token', async () => {
  const p = nameProvider({ provider: 'desec', name: 'myhouse.dedyn.io' })
  assert((await p.updateAddress('10.0.0.2', { token: TOKEN, fetchImpl: fakeFetch(200, 'nochg 10.0.0.2').impl })).ok, 'nochg')
  assert(/check the token/.test((await p.updateAddress('10.0.0.2', { token: TOKEN, fetchImpl: fakeFetch(401, 'badauth').impl })).detail), '401')
})

await test('egress names the provider and Let\'s Encrypt, nothing about conversations', () => {
  const e = nameProvider({ provider: 'desec', name: 'h.dedyn.io' }).egress()
  assert(e.some((x) => x.host === 'update.dedyn.io') && e.some((x) => /letsencrypt/.test(x.host)), JSON.stringify(e))
})

console.log('\n-- the address watcher --')

function watcherHarness(ips, results) {
  const updates = []
  let i = 0
  const timers = []
  const w = createAddressWatcher({
    getIp: () => ips[Math.min(i, ips.length - 1)],
    update: async (ip) => { updates.push(ip); return results.shift() ?? { ok: true, detail: 'OK' } },
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t },
    clearTimer: (t) => { t.cleared = true },
  })
  return { w, updates, timers, next: () => { i++ } }
}

await test('🔍 publishes at start, then only when the address changes', async () => {
  const h = watcherHarness(['192.168.0.10', '192.168.0.10', '192.168.0.11'], [])
  await h.w.start()
  await h.w.tick(); h.next(); await h.w.tick(); h.next(); await h.w.tick()
  assert(JSON.stringify(h.updates) === '["192.168.0.10","192.168.0.11"]', JSON.stringify(h.updates))
  assert(h.timers.length === 1 && h.timers[0].ms === 60000, 'interval')
})

await test('a failed publish is retried on the next tick; reset() forces one', async () => {
  const h = watcherHarness(['10.0.0.5'], [{ ok: false, detail: 'KO' }])
  await h.w.start(); await h.w.tick()
  assert(h.updates.length === 2, `retried ${h.updates.length - 1} times`)
  await h.w.tick()
  assert(h.updates.length === 2, 'kept publishing an unchanged address')
  h.w.reset(); await h.w.tick()
  assert(h.updates.length === 3, 'reset did not force a publish')
})

await test('no LAN address: nothing published; stop() clears the timer', async () => {
  const h = watcherHarness([null], [])
  await h.w.start()
  assert(h.updates.length === 0, 'published null')
  h.w.stop()
  assert(h.timers[0].cleared, 'timer left running')
})

console.log('\n-- Automatic: the Redstart name service (step 8) --')

const CRED = 'Q'.repeat(43)
function jsonFetch(status, body) {
  const calls = []
  const impl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method, headers: opts.headers ?? {}, body: opts.body ?? null })
    return { status, json: async () => body, text: async () => JSON.stringify(body) }
  }
  return { calls, impl }
}

await test('🔍 registerName: POST /v1/register; the hostname is COMPUTED from the id, not taken from the answer', async () => {
  const f = jsonFetch(201, { id: 'k7f3q2', credential: CRED, hostname: 'k7f3q2.evil.example' })
  const r = await registerName({ fetchImpl: f.impl })
  assert(r.ok && r.hostname === 'k7f3q2.nest.redstartdevelopment.com' && r.credential === CRED, JSON.stringify(r))
  assert(f.calls[0].url === `${NAME_SERVICE_URL}/v1/register` && f.calls[0].method === 'POST', JSON.stringify(f.calls[0]))
})

await test('🔍 a misbehaving service cannot hand Nest a name outside nest. or a bad credential', async () => {
  for (const body of [{ id: '../x', credential: CRED }, { id: 'k7f3q2.evil', credential: CRED }, { id: 'K7F3Q2', credential: CRED }, { id: 'k7f3q2', credential: 'short' }, { id: 'k7f3q2' }, null]) {
    const r = await registerName({ fetchImpl: jsonFetch(201, body).impl })
    assert(!r.ok, `accepted ${JSON.stringify(body)}`)
  }
  const limited = await registerName({ fetchImpl: jsonFetch(429, {}).impl })
  assert(!limited.ok && /Try again in an hour/.test(limited.error), limited.error)
})

await test('🔍 updateAddress (Automatic): PUT /v1/ip, Bearer id.credential, private only; 401 says how to recover', async () => {
  const p = nameProvider({ provider: 'redstart', name: 'k7f3q2.nest.redstartdevelopment.com' })
  const f = jsonFetch(200, {})
  assert((await p.updateAddress('192.168.0.213', { token: CRED, id: 'k7f3q2', fetchImpl: f.impl })).ok, 'ok')
  const c = f.calls[0]
  assert(c.url === `${NAME_SERVICE_URL}/v1/ip` && c.method === 'PUT' && c.headers.Authorization === `Bearer k7f3q2.${CRED}`, JSON.stringify(c))
  assert(JSON.parse(c.body).ipv4 === '192.168.0.213' && !c.url.includes(CRED), 'body / credential in the URL')
  const pub = jsonFetch(200, {})
  assert(!(await p.updateAddress('8.8.8.8', { token: CRED, id: 'k7f3q2', fetchImpl: pub.impl })).ok && pub.calls.length === 0, 'a public address was sent')
  assert(/Automatic to get a new name/.test((await p.updateAddress('10.0.0.1', { token: CRED, id: 'k7f3q2', fetchImpl: jsonFetch(401, {}).impl })).detail), '401 sentence')
})

await test('heartbeat and release: the right routes; release treats "already gone" (401) as released', async () => {
  const hb = jsonFetch(200, {})
  assert((await heartbeatName({ id: 'k7f3q2', credential: CRED, fetchImpl: hb.impl })).ok && hb.calls[0].url.endsWith('/v1/heartbeat'), 'heartbeat')
  const del = jsonFetch(204, null)
  assert((await releaseName({ id: 'k7f3q2', credential: CRED, fetchImpl: del.impl })).ok && del.calls[0].method === 'DELETE', 'release')
  assert((await releaseName({ id: 'k7f3q2', credential: CRED, fetchImpl: jsonFetch(401, {}).impl })).ok, '401 = already gone')
  assert(!(await releaseName({ id: 'k7f3q2', credential: CRED, fetchImpl: jsonFetch(502, {}).impl })).ok, '502 is not released')
  const down = await releaseName({ id: 'k7f3q2', credential: CRED, fetchImpl: async (u) => { throw new Error(`fetch failed ${u} ${CRED}`) } })
  assert(!down.ok && !down.error.includes(CRED), 'a network error carried the credential')
})

await test('Automatic egress names the name service and Let\'s Encrypt', () => {
  const e = nameProvider({ provider: 'redstart', name: 'k7f3q2.nest.redstartdevelopment.com' }).egress()
  assert(e.some((x) => x.host === 'names.redstartdevelopment.com') && e.some((x) => /letsencrypt/.test(x.host)), JSON.stringify(e))
})

await test('REDSTART_NAME_SERVICE_URL (tests / a staging copy) takes a bare origin only', () => {
  const was = process.env.REDSTART_NAME_SERVICE_URL
  try {
    process.env.REDSTART_NAME_SERVICE_URL = 'http://127.0.0.1:8799'
    assert(nameServiceUrl() === 'http://127.0.0.1:8799', 'override')
    for (const bad of ['javascript:x', 'http://a.b/path', 'ftp://x', 'http://a b']) {
      process.env.REDSTART_NAME_SERVICE_URL = bad
      assert(nameServiceUrl() === NAME_SERVICE_URL, `accepted ${bad}`)
    }
  } finally {
    if (was === undefined) delete process.env.REDSTART_NAME_SERVICE_URL
    else process.env.REDSTART_NAME_SERVICE_URL = was
  }
})

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
