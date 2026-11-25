// =============================================================================
// The Redstart name service (TLS plan C12): routes, guards, housekeeping
// =============================================================================
// The real service.js on a real SQL database (node:sqlite, with the same
// migrations D1 runs), talking through the REAL dns.js client to a fake
// Cloudflare API that records every request. So the invariants are checked
// on what would actually be sent to Cloudflare:
//
//   - a credential touches only its own <id>.nest. records;
//   - nothing is written outside <id>.nest. / admin.<id>.nest. / art.<id>.nest. /
//     _acme-challenge.<id>.nest.;
//   - every record is DNS-only (proxied: false);
//   - only private addresses are published;
//   - /update speaks exactly what Caddy's acmedns plugin sends
//     (libdns/acmedns v0.5.0), and keeps the newest two TXT values;
//   - housekeeping forgets stale installs, un-proxies, and alerts at 700.
//
// Run:  npm test   (Node 22.13+; no dependencies)
// =============================================================================

import { d1, fakeCloudflare } from './harness.mjs'
import { createService, REGISTER_LIMIT, RECORD_ALERT, UNSEEN_DAYS } from '../src/service.js'
import { cloudflareDns, writable, RECORD_TTL } from '../src/dns.js'
import { isPrivateIPv4, ulaIPv6 } from '../src/net.js'
import { newId, ID_RE, sha256Hex } from '../src/ids.js'

const ZONE = 'redstartdevelopment.com'
const SERVER = 'https://names.redstartdevelopment.com'
const TOKEN = 'cf-token-must-never-appear-anywhere'

const results = []
async function test(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false, detail: err.message })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}
function assert(cond, message) { if (!cond) throw new Error(message) }

function world({ now = 1_800_000_000_000, failWith = null } = {}) {
  const db = d1()
  const cf = fakeCloudflare({ failWith })
  const clock = { t: now }
  const logs = []
  const dns = cloudflareDns({ token: TOKEN, zoneId: 'zone123', zone: ZONE, fetch: cf.impl })
  const svc = createService({ db, dns, zone: ZONE, serverUrl: SERVER, now: () => clock.t, log: (e, f) => logs.push({ e, ...f }) })
  const call = (method, p, { body, headers = {}, ip = '203.0.113.7' } = {}) =>
    svc.fetch(new Request(`${SERVER}${p}`, {
      method, headers: { 'CF-Connecting-IP': ip, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    }))
  const register = async (ip) => (await call('POST', '/v1/register', { ip })).json()
  const bearer = (inst) => ({ Authorization: `Bearer ${inst.id}.${inst.credential}` })
  // Exactly libdns/acmedns v0.5.0's updateTxtValue().
  const acme = (inst, txt, { user = inst.id, key = inst.credential, subdomain = inst.id } = {}) =>
    call('POST', '/update', { body: { subdomain, txt }, headers: { 'X-Api-User': user, 'X-Api-Key': key } })
  return { db, cf, svc, call, register, bearer, acme, clock, logs }
}

const T1 = 'Abc_def-' + 'x'.repeat(35)
const T2 = 'Bbc_def-' + 'y'.repeat(35)
const T3 = 'Cbc_def-' + 'z'.repeat(35)

/** Every write is DNS-only, under nest., for a real id. */
function assertWritesSafe(cf) {
  for (const w of cf.writes()) {
    if (w.method === 'DELETE') continue
    assert(w.body.proxied === false, `a ${w.method} body is not DNS-only: ${JSON.stringify(w.body)}`)
    assert(new RegExp(`^(?:_acme-challenge\\.|admin\\.|art\\.)?[a-z2-9]{6}\\.nest\\.${ZONE.replace('.', '\\.')}$`).test(w.body.name), `write outside <id>.nest.: ${w.body.name}`)
    assert(w.body.ttl === RECORD_TTL, `ttl ${w.body.ttl}`)
  }
}

// ---------------------------------------------------------------------------

console.log('\n-- ids, addresses, the write guard --')

await test('ids: 6 symbols from an unambiguous alphabet; a thousand draws are well spread', () => {
  const seen = new Set()
  for (let i = 0; i < 1000; i++) { const id = newId(); assert(ID_RE.test(id), id); seen.add(id) }
  assert(seen.size > 990, `only ${seen.size} distinct of 1000`)
})

await test('🔍 private IPv4 and ULA IPv6 only', () => {
  for (const ip of ['10.0.0.1', '172.16.5.4', '172.31.255.255', '192.168.0.213', '100.64.0.1']) assert(isPrivateIPv4(ip), ip)
  for (const ip of ['8.8.8.8', '172.32.0.1', '127.0.0.1', '169.254.1.1', '192.168.01.1', '100.128.0.1', '1.2.3', '', null, '10.0.0.256']) assert(!isPrivateIPv4(ip), String(ip))
  assert(ulaIPv6('FD12:3456::1') === 'fd12:3456::1', 'ULA')
  for (const ip of ['2001:db8::1', 'fe80::1', 'fc00::1', '::1', 'fd00::1::2', 'fd12:zz::1', 'fd12:1:2:3:4:5:6:7:8']) assert(ulaIPv6(ip) === null, ip)
})

await test('🔍 writable(): only this install\'s own name and admin name (A/AAAA) and its own challenge name (TXT)', () => {
  const id = 'k7f3q2'
  assert(writable({ id, zone: ZONE, type: 'A', name: `${id}.nest.${ZONE}` }), 'own A')
  assert(writable({ id, zone: ZONE, type: 'A', name: `admin.${id}.nest.${ZONE}` }), 'own admin A')
  assert(writable({ id, zone: ZONE, type: 'AAAA', name: `admin.${id}.nest.${ZONE}` }), 'own admin AAAA')
  assert(writable({ id, zone: ZONE, type: 'A', name: `art.${id}.nest.${ZONE}` }), 'own artifacts A')
  assert(writable({ id, zone: ZONE, type: 'AAAA', name: `art.${id}.nest.${ZONE}` }), 'own artifacts AAAA')
  assert(writable({ id, zone: ZONE, type: 'TXT', name: `_acme-challenge.${id}.nest.${ZONE}` }), 'own TXT')
  const refused = [
    { type: 'A', name: ZONE }, { type: 'A', name: `www.${ZONE}` }, { type: 'A', name: `nest.${ZONE}` },
    { type: 'A', name: `*.nest.${ZONE}` }, { type: 'A', name: `abcdef.nest.${ZONE}` }, { type: 'A', name: `${id}.nest.${ZONE}.evil.com` },
    { type: 'TXT', name: `${id}.nest.${ZONE}` }, { type: 'A', name: `_acme-challenge.${id}.nest.${ZONE}` },
    { type: 'TXT', name: `_acme-challenge.abcdef.nest.${ZONE}` }, { type: 'TXT', name: `_dmarc.${ZONE}` },
    { type: 'CNAME', name: `${id}.nest.${ZONE}` }, { type: 'MX', name: `${id}.nest.${ZONE}` },
    // The admin name is A/AAAA only, for this install only, one label deep only.
    { type: 'TXT', name: `admin.${id}.nest.${ZONE}` }, { type: 'TXT', name: `_acme-challenge.admin.${id}.nest.${ZONE}` },
    { type: 'A', name: `admin.abcdef.nest.${ZONE}` }, { type: 'A', name: `x.admin.${id}.nest.${ZONE}` },
    { type: 'A', name: `chat.${id}.nest.${ZONE}` }, { type: 'A', name: `*.${id}.nest.${ZONE}` },
    { type: 'CNAME', name: `admin.${id}.nest.${ZONE}` },
    { type: 'TXT', name: `art.${id}.nest.${ZONE}` }, { type: 'A', name: `x.art.${id}.nest.${ZONE}` }, { type: 'A', name: `art.abcdef.nest.${ZONE}` },
  ]
  for (const r of refused) {
    let threw = false
    try { writable({ id, zone: ZONE, ...r }) } catch { threw = true }
    assert(threw, `allowed ${r.type} ${r.name}`)
  }
  let threw = false
  try { writable({ id: 'NOT-AN-ID', zone: ZONE, type: 'A', name: `NOT-AN-ID.nest.${ZONE}` }) } catch { threw = true }
  assert(threw, 'a non-id was allowed')
  return `${refused.length + 1} refusals`
})

console.log('\n-- register --')

await test('🔍 register: id, credential once, the hostname, the acmedns block; only a hash is stored', async () => {
  const w = world()
  const res = await w.call('POST', '/v1/register')
  assert(res.status === 201, `status ${res.status}`)
  const r = await res.json()
  assert(ID_RE.test(r.id) && r.credential.length >= 40 && r.hostname === `${r.id}.nest.${ZONE}`, JSON.stringify(r))
  assert(JSON.stringify(r.acmedns) === JSON.stringify({ username: r.id, subdomain: r.id, server_url: SERVER }), JSON.stringify(r.acmedns))
  const row = w.db.raw.prepare('SELECT * FROM installs WHERE id = ?').get(r.id)
  assert(row.credential_hash === await sha256Hex(r.credential), 'stored hash is not the credential\'s SHA-256')
  assert(!JSON.stringify(w.db.raw.prepare('SELECT * FROM installs').all()).includes(r.credential), 'the credential itself is stored')
  assert(w.cf.writes().length === 0, 'registering wrote DNS before any address was set')
})

await test('🔍 register is rate-limited per network; the IP itself is never stored', async () => {
  const w = world()
  for (let i = 0; i < REGISTER_LIMIT; i++) assert((await w.call('POST', '/v1/register')).status === 201, `attempt ${i + 1}`)
  const limited = await w.call('POST', '/v1/register')
  assert(limited.status === 429 && limited.headers.get('Retry-After') === '3600', `status ${limited.status}`)
  assert((await w.call('POST', '/v1/register', { ip: '198.51.100.9' })).status === 201, 'another network was limited too')
  assert(!JSON.stringify(w.db.raw.prepare('SELECT * FROM register_attempts').all()).includes('203.0.113.7'), 'raw IP stored')
  w.clock.t += 61 * 60 * 1000
  assert((await w.call('POST', '/v1/register')).status === 201, 'the window never reopened')
})

console.log('\n-- publishing the address --')

await test('🔍 PUT /v1/ip: one DNS-only A record at <id>.nest., admin.<id>.nest. and art.<id>.nest., replaced (not added to) on a change', async () => {
  const w = world()
  const inst = await w.register()
  assert((await w.call('PUT', '/v1/ip', { body: { ipv4: '192.168.0.213' }, headers: w.bearer(inst) })).status === 200, 'set')
  const res = await w.call('PUT', '/v1/ip', { body: { ipv4: '192.168.0.50' }, headers: w.bearer(inst) })
  assert(res.status === 200, 'change')
  const body = await res.json()
  assert(body.hostname === `${inst.id}.nest.${ZONE}` && body.adminHostname === `admin.${inst.id}.nest.${ZONE}` && body.artifactsHostname === `art.${inst.id}.nest.${ZONE}`, JSON.stringify(body))
  const a = [...w.cf.records.values()].filter((r) => r.type === 'A')
  assert(a.length === 3 && a.every((r) => r.content === '192.168.0.50'), JSON.stringify(a))
  const names = a.map((r) => r.name).sort()
  assert(JSON.stringify(names) === JSON.stringify([`${inst.id}.nest.${ZONE}`, `admin.${inst.id}.nest.${ZONE}`, `art.${inst.id}.nest.${ZONE}`].sort()), JSON.stringify(names))
  assertWritesSafe(w.cf)
  assert(w.cf.requests.every((r) => r.auth === `Bearer ${TOKEN}`), 'Cloudflare not called with the API token')
})

await test('🔍 a public IPv4 or a global IPv6 is refused, and nothing is written', async () => {
  const w = world()
  const inst = await w.register()
  for (const body of [{ ipv4: '8.8.8.8' }, { ipv4: '192.168.0.2', ipv6: '2001:db8::5' }, { ipv4: '127.0.0.1' }, {}]) {
    const r = await w.call('PUT', '/v1/ip', { body, headers: w.bearer(inst) })
    assert(r.status === 400, `${JSON.stringify(body)} → ${r.status}`)
  }
  assert(w.cf.writes().length === 0, `wrote ${w.cf.writes().length} records for refused addresses`)
})

await test('a ULA IPv6 gets an AAAA beside the A; dropping it removes the AAAA', async () => {
  const w = world()
  const inst = await w.register()
  await w.call('PUT', '/v1/ip', { body: { ipv4: '10.0.0.5', ipv6: 'fd12:3456::5' }, headers: w.bearer(inst) })
  assert([...w.cf.records.values()].filter((r) => r.type === 'AAAA' && r.content === 'fd12:3456::5').length === 3, 'no AAAA on every name')
  await w.call('PUT', '/v1/ip', { body: { ipv4: '10.0.0.5' }, headers: w.bearer(inst) })
  assert(![...w.cf.records.values()].some((r) => r.type === 'AAAA'), 'AAAA kept')
  assertWritesSafe(w.cf)
})

console.log('\n-- one install cannot touch another --')

await test('🔍 wrong or someone else\'s credential: 401, nothing written', async () => {
  const w = world()
  const a = await w.register()
  const b = await w.register('198.51.100.1')
  const tries = [
    { Authorization: `Bearer ${a.id}.${b.credential}` },
    { Authorization: `Bearer ${b.id}.${a.credential}x` },
    { Authorization: `Bearer ${a.id}` },
    { Authorization: a.credential },
    {},
  ]
  for (const headers of tries) {
    const r = await w.call('PUT', '/v1/ip', { body: { ipv4: '10.0.0.9' }, headers })
    assert(r.status === 401, `${JSON.stringify(headers).slice(0, 40)} → ${r.status}`)
  }
  assert((await w.acme(a, T1, { key: b.credential })).status === 401, 'acme with another key')
  assert(w.cf.writes().length === 0, 'something was written')
})

await test('🔍 each install\'s writes land only on its own names', async () => {
  const w = world()
  const a = await w.register()
  const b = await w.register('198.51.100.1')
  await w.call('PUT', '/v1/ip', { body: { ipv4: '10.0.0.1' }, headers: w.bearer(a) })
  await w.call('PUT', '/v1/ip', { body: { ipv4: '10.0.0.2' }, headers: w.bearer(b) })
  await w.acme(a, T1)
  const byOwner = (id) => [...w.cf.records.values()].filter((r) => r.name.includes(`${id}.nest.`))
  assert(byOwner(a.id).length === 4 && byOwner(b.id).length === 3, `${byOwner(a.id).length} / ${byOwner(b.id).length}`)
  assert(byOwner(b.id).every((r) => r.content === '10.0.0.2'), 'b\'s records changed')
  assertWritesSafe(w.cf)
})

console.log('\n-- acme-dns /update (what Caddy\'s acmedns plugin sends) --')

await test('🔍 the plugin\'s exact request sets the TXT at _acme-challenge.<id>.nest. and answers 200', async () => {
  const w = world()
  const inst = await w.register()
  const r = await w.acme(inst, T1)
  assert(r.status === 200 && (await r.json()).txt === T1, `status ${r.status}`)
  const txt = [...w.cf.records.values()].filter((x) => x.type === 'TXT')
  assert(txt.length === 1 && txt[0].name === `_acme-challenge.${inst.id}.nest.${ZONE}` && txt[0].content === T1, JSON.stringify(txt))
  assertWritesSafe(w.cf)
})

await test('🔍 the newest two values are kept (the plugin never deletes); a repeat changes nothing', async () => {
  const w = world()
  const inst = await w.register()
  await w.acme(inst, T1); await w.acme(inst, T2); await w.acme(inst, T3)
  const vals = () => [...w.cf.records.values()].filter((x) => x.type === 'TXT').map((x) => x.content).sort()
  assert(JSON.stringify(vals()) === JSON.stringify([T2, T3].sort()), JSON.stringify(vals()))
  const before = w.cf.writes().length
  await w.acme(inst, T3)
  assert(w.cf.writes().length === before && JSON.stringify(vals()) === JSON.stringify([T2, T3].sort()), 'a repeated value rewrote the records')
})

await test('a wrong subdomain or a value that is not an ACME token is refused', async () => {
  const w = world()
  const inst = await w.register()
  assert((await w.acme(inst, T1, { subdomain: 'abcdef' })).status === 400, 'subdomain')
  for (const t of ['short', 'x'.repeat(44), 'has spaces in it and is forty three chars..', '"quoted"' + 'x'.repeat(35)]) {
    assert((await w.acme(inst, t)).status === 400, `txt ${t}`)
  }
  assert(w.cf.writes().length === 0, 'written anyway')
})

console.log('\n-- heartbeat, unregister --')

await test('heartbeat refreshes last_seen', async () => {
  const w = world()
  const inst = await w.register()
  w.clock.t += 10 * 86_400_000
  assert((await w.call('POST', '/v1/heartbeat', { headers: w.bearer(inst) })).status === 200, 'status')
  assert(w.db.raw.prepare('SELECT last_seen FROM installs WHERE id = ?').get(inst.id).last_seen === w.clock.t, 'last_seen')
})

await test('🔍 DELETE /v1/register removes every record and the install; the credential is dead after', async () => {
  const w = world()
  const inst = await w.register()
  await w.call('PUT', '/v1/ip', { body: { ipv4: '10.1.1.1', ipv6: 'fd00::1' }, headers: w.bearer(inst) })
  await w.acme(inst, T1)
  assert(w.cf.records.size === 7, `records ${w.cf.records.size}`) // A + AAAA on the three names, and the TXT
  assert((await w.call('DELETE', '/v1/register', { headers: w.bearer(inst) })).status === 204, 'status')
  assert(w.cf.records.size === 0, `left ${w.cf.records.size}`)
  assert((await w.call('POST', '/v1/heartbeat', { headers: w.bearer(inst) })).status === 401, 'credential still works')
})

console.log('\n-- housekeeping --')

await test(`🔍 installs unseen for ${UNSEEN_DAYS} days are forgotten, records and all; recent ones stay`, async () => {
  const w = world()
  const old = await w.register()
  await w.call('PUT', '/v1/ip', { body: { ipv4: '10.0.0.1' }, headers: w.bearer(old) })
  w.clock.t += (UNSEEN_DAYS - 1) * 86_400_000
  const fresh = await w.register('198.51.100.1')
  await w.call('PUT', '/v1/ip', { body: { ipv4: '10.0.0.2' }, headers: w.bearer(fresh) })
  w.clock.t += 2 * 86_400_000
  const rep = await w.svc.housekeeping()
  assert(rep.forgotten === 1, `forgot ${rep.forgotten}`)
  const names = [...w.cf.records.values()].map((r) => r.name)
  assert(names.length === 3 && names.every((n) => n.includes(`${fresh.id}.nest.`)), JSON.stringify(names))
})

await test('🔍 a proxied record under nest. is turned back to DNS-only and reported; one that is not an install\'s is reported as failed', async () => {
  const w = world()
  const inst = await w.register()
  await w.call('PUT', '/v1/ip', { body: { ipv4: '10.0.0.1' }, headers: w.bearer(inst) })
  const rec = [...w.cf.records.values()].find((r) => r.name === `${inst.id}.nest.${ZONE}`)
  const adm = [...w.cf.records.values()].find((r) => r.name === `admin.${inst.id}.nest.${ZONE}`)
  rec.proxied = true // someone clicked the orange cloud in the dashboard
  adm.proxied = true // on the admin name too
  w.cf.records.set('manual', { id: 'manual', type: 'A', name: `test.nest.${ZONE}`, content: '10.9.9.9', proxied: true })
  const rep = await w.svc.housekeeping()
  assert(JSON.stringify([...rep.unproxied].sort()) === JSON.stringify([rec.name, adm.name].sort()), JSON.stringify(rep))
  assert(w.cf.records.get(rec.id).proxied === false && w.cf.records.get(adm.id).proxied === false, 'still proxied')
  assert(JSON.stringify(rep.unproxyFailed) === JSON.stringify([`test.nest.${ZONE}`]), 'a foreign proxied record was not reported')
  assert(w.logs.some((l) => l.e === 'ALERT_proxied_records'), 'no alert')
})

await test(`🔍 the record-count alert fires at ${RECORD_ALERT}`, async () => {
  const w = world()
  for (let i = 0; i < RECORD_ALERT - 1; i++) w.cf.records.set(`x${i}`, { id: `x${i}`, type: 'A', name: `h${i}.${ZONE}`, content: '10.0.0.1' })
  assert((await w.svc.housekeeping()).alert === false, 'alerted early')
  w.cf.records.set('last', { id: 'last', type: 'A', name: `last.${ZONE}`, content: '10.0.0.1' })
  const rep = await w.svc.housekeeping()
  assert(rep.alert === true && rep.records === RECORD_ALERT && w.logs.some((l) => l.e === 'ALERT_record_count'), JSON.stringify(rep))
})

console.log('\n-- failures and edges --')

await test('🔍 a Cloudflare failure is a 502 with no token or Cloudflare detail in the answer', async () => {
  const w = world({ failWith: 'Authentication error' })
  const inst = await w.register()
  const r = await w.call('PUT', '/v1/ip', { body: { ipv4: '10.0.0.1' }, headers: w.bearer(inst) })
  const text = await r.text()
  assert(r.status === 502 && !text.includes(TOKEN) && !text.includes('Authentication'), `${r.status} ${text}`)
  assert(!JSON.stringify(w.logs).includes(TOKEN), 'the token reached a log line')
})

await test('health, unknown routes, oversized and malformed bodies', async () => {
  const w = world()
  const h = await w.call('GET', '/health')
  assert(h.status === 200 && (await h.text()) === 'ok', 'health')
  assert((await w.call('GET', '/v1/register')).status === 404, 'GET register')
  assert((await w.call('GET', '/')).status === 404, 'root')
  const inst = await w.register()
  assert((await w.call('PUT', '/v1/ip', { body: 'x'.repeat(5000), headers: w.bearer(inst) })).status === 400, 'oversized')
  assert((await w.call('PUT', '/v1/ip', { body: '{not json', headers: w.bearer(inst) })).status === 400, 'malformed')
})

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
