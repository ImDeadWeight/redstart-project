// =============================================================================
// Is HTTPS working? (TLS plan C5, review R1 + R2)
// =============================================================================
//   - the SERVING verdict: certificate for the name, unexpired, trusted (or
//     staging when chosen), and Caddy's own health route answering
//   - diagnostics never touch the verdict; unreachable public DNS is "couldn't
//     check", not a failure; router rebinding is named; chat and MCP are
//     separate warnings
//   - the runner: leaving serving takes 2 failures (the 2nd 30 s later),
//     returning takes 1 pass; only transitions are reported
//   - live: the real Caddy with its INTERNAL CA (no network) presents a real
//     certificate and answers the health route; the untrusted issuer is caught
//
// Run:  node scripts/test-tls-health.mjs
// =============================================================================

import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as net from 'node:net'
import { checkServing, diagnostics, createHealthRunner, loopbackRequest, RENEWAL_WARN_DAYS } from '../daemon/tls-health.mjs'
import { TLS_HEALTH_PATH, buildCaddyConfig, PROXY_SECRET_ENV } from '../daemon/caddy-config.mjs'
import { createCaddySupervisor } from '../daemon/caddy-server.mjs'
import { stagedCaddyPath } from './fetch-caddy.mjs'

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

const NAME = 'myhouse.duckdns.org'
const NOW = Date.parse('2026-12-01T00:00:00Z')
const day = 86_400_000
const certFor = (over = {}) => ({
  subject: { CN: NAME }, subjectaltname: `DNS:${NAME}`, valid_to: new Date(NOW + 60 * day).toUTCString(),
  issuer: { O: "Let's Encrypt", CN: 'R11' }, ...over,
})

/** A fake https.request: routes by path to { status, body, headers }, or an error. */
function fakeRequest({ cert = certFor(), authorized = true, routes = {}, error = null, seen = [] } = {}) {
  return (opts, cb) => {
    const req = new EventEmitter()
    seen.push(opts)
    req.write = () => {}
    req.destroy = (e) => req.emit('error', e ?? new Error('destroyed'))
    req.end = () => setImmediate(() => {
      if (error) return req.emit('error', Object.assign(new Error(error), { code: error }))
      const r = routes[opts.path] ?? { status: 404, body: '' }
      const res = new EventEmitter()
      res.statusCode = r.status; res.headers = r.headers ?? {}
      res.setEncoding = () => {}
      res.socket = { getPeerCertificate: () => cert, authorized }
      cb(res)
      setImmediate(() => { if (r.body) res.emit('data', r.body); res.emit('end') })
    })
    return req
  }
}
const healthy = { [TLS_HEALTH_PATH]: { status: 200, body: 'ok' } }

console.log('\n-- the serving verdict --')

await test('🔍 serving: trusted cert for the name + Caddy\'s health route, over loopback with SNI', async () => {
  const seen = []
  const r = await checkServing({ name: NAME, now: () => NOW, request: fakeRequest({ routes: healthy, seen }) })
  assert(r.serving && r.cert.daysLeft === 60, JSON.stringify(r))
  assert(seen[0].host === '127.0.0.1' && seen[0].servername === NAME && seen[0].headers.host === NAME, JSON.stringify(seen[0]))
})

await test('🔍 not serving, with one sentence each', async () => {
  const cases = [
    [{ error: 'ECONNREFUSED' }, /isn't answering/],
    [{ cert: {}, routes: healthy }, /No certificate/],
    [{ cert: certFor({ subjectaltname: 'DNS:other.example' }), routes: healthy }, /not for myhouse/],
    [{ cert: certFor({ valid_to: new Date(NOW - day).toUTCString() }), routes: healthy }, /expired/],
    [{ authorized: false, routes: healthy }, /trusted authority/],
    [{ routes: { [TLS_HEALTH_PATH]: { status: 502, body: '' } } }, /answered 502/],
  ]
  for (const [opts, want] of cases) {
    const r = await checkServing({ name: NAME, now: () => NOW, request: fakeRequest(opts) })
    assert(!r.serving && want.test(r.reason ?? ''), `${JSON.stringify(opts).slice(0, 60)} → ${JSON.stringify(r)}`)
  }
  return `${cases.length} cases`
})

await test('🔍 staging: an untrusted STAGING issuer serves only when staging was chosen', async () => {
  const opts = { authorized: false, cert: certFor({ issuer: { O: '(STAGING) Let\'s Encrypt', CN: '(STAGING) Baloney Bulgur YE2' } }), routes: healthy }
  assert((await checkServing({ name: NAME, now: () => NOW, request: fakeRequest(opts) })).serving === false, 'staging accepted without being chosen')
  const r = await checkServing({ name: NAME, now: () => NOW, allowStaging: true, request: fakeRequest(opts) })
  assert(r.serving && r.cert.staging, JSON.stringify(r))
  const fake = { ...opts, cert: certFor({ issuer: { O: 'Evil Corp', CN: 'Totally Real CA' } }) }
  assert(!(await checkServing({ name: NAME, now: () => NOW, allowStaging: true, request: fakeRequest(fake) })).serving, 'staging switch accepted any untrusted issuer')
})

console.log('\n-- diagnostics inform, never decide --')

const LAN = '192.168.0.213'
const pubOk = async () => ({ answered: true, addresses: [LAN] })
const lookupOk = async () => [{ address: LAN }]
const chatAndMcp = { '/health': { status: 200, body: '{}' }, '/mcp': { status: 401, body: 'Unauthorized' } }

await test('all good: no warnings', async () => {
  const w = await diagnostics({ name: NAME, lanIp: LAN, cert: { daysLeft: 60 }, resolvePublicImpl: pubOk, lookup: lookupOk, request: fakeRequest({ routes: chatAndMcp }), fetchName: async () => ({ ok: true }) })
  assert(w.length === 0, JSON.stringify(w))
})

await test('🔍 unreachable public resolvers: "couldn\'t check", nothing worse', async () => {
  const w = await diagnostics({ name: NAME, lanIp: LAN, cert: { daysLeft: 60 }, resolvePublicImpl: async () => ({ answered: false, addresses: [] }), lookup: lookupOk, request: fakeRequest({ routes: chatAndMcp }) })
  assert(w.length === 1 && w[0].kind === 'public-dns' && /Couldn't check/.test(w[0].text), JSON.stringify(w))
})

await test('🔍 public DNS right, local DNS empty: the router\'s rebinding protection, named', async () => {
  const w = await diagnostics({ name: NAME, lanIp: LAN, cert: { daysLeft: 60 }, resolvePublicImpl: pubOk, lookup: async () => { throw new Error('ENOTFOUND') }, request: fakeRequest({ routes: chatAndMcp }) })
  const l = w.find((x) => x.kind === 'local-dns')
  assert(l && /router is blocking/.test(l.text) && /duckdns\.org/.test(l.text), JSON.stringify(w))
})

await test(`renewal warns under ${RENEWAL_WARN_DAYS} days`, async () => {
  const w = await diagnostics({ name: NAME, lanIp: LAN, cert: { daysLeft: 9 }, resolvePublicImpl: pubOk, lookup: lookupOk, request: fakeRequest({ routes: chatAndMcp }) })
  assert(w.some((x) => x.kind === 'renewal' && /9 days/.test(x.text)), JSON.stringify(w))
})

await test('🔍 no model loaded: chat warning, and MCP is not blamed for it', async () => {
  const w = await diagnostics({ name: NAME, lanIp: LAN, cert: { daysLeft: 60 }, resolvePublicImpl: pubOk, lookup: lookupOk, request: fakeRequest({ routes: { '/health': { status: 502 } } }) })
  assert(w.length === 1 && w[0].kind === 'chat', JSON.stringify(w))
})

await test('🔍 MCP: 401 or a result means the server answered; 502 is "tools are unavailable"', async () => {
  const ok200 = await diagnostics({ name: NAME, lanIp: LAN, cert: { daysLeft: 60 }, resolvePublicImpl: pubOk, lookup: lookupOk, request: fakeRequest({ routes: { '/health': { status: 200 }, '/mcp': { status: 200, body: '{}', headers: { 'mcp-session-id': 's1' } } } }) })
  assert(ok200.length === 0, JSON.stringify(ok200))
  const down = await diagnostics({ name: NAME, lanIp: LAN, cert: { daysLeft: 60 }, resolvePublicImpl: pubOk, lookup: lookupOk, request: fakeRequest({ routes: { '/health': { status: 200 }, '/mcp': { status: 502 } } }) })
  assert(down.length === 1 && down[0].kind === 'mcp' && /tools are unavailable/.test(down[0].text), JSON.stringify(down))
})

console.log('\n-- the runner: hysteresis --')

function runnerHarness(verdicts) {
  const changes = []
  const timers = []
  const r = createHealthRunner({
    check: async () => verdicts.shift() ?? { serving: true },
    onServing: (v) => changes.push(v),
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t },
    clearTimer: (t) => { if (t) t.cleared = true },
  })
  return { r, changes, timers, lastDelay: () => timers.at(-1)?.ms }
}

await test('🔍 enters serving on one pass; checks every 5 min while serving', async () => {
  const h = runnerHarness([{ serving: false }, { serving: true }])
  await h.r.start()
  assert(h.changes.length === 0 && h.lastDelay() === 30000, `not serving yet: ${h.changes} next in ${h.lastDelay()}`)
  await h.r.runNow()
  assert(JSON.stringify(h.changes) === '[true]' && h.lastDelay() === 300000, `${h.changes} next in ${h.lastDelay()}`)
})

await test('🔍 one failure while serving does not downgrade; a recheck comes in 30 s', async () => {
  const h = runnerHarness([{ serving: true }, { serving: false }, { serving: true }])
  await h.r.start(); await h.r.runNow()
  assert(JSON.stringify(h.changes) === '[true]' && h.lastDelay() === 30000, `${h.changes} next in ${h.lastDelay()}`)
  await h.r.runNow()
  assert(JSON.stringify(h.changes) === '[true]', `a single failure flipped serving: ${h.changes}`)
})

await test('🔍 two failures in a row leave serving, once', async () => {
  const h = runnerHarness([{ serving: true }, { serving: false }, { serving: false }, { serving: false }])
  await h.r.start(); await h.r.runNow(); await h.r.runNow(); await h.r.runNow()
  assert(JSON.stringify(h.changes) === '[true,false]', JSON.stringify(h.changes))
})

await test('a check that throws counts as a failure, not a crash', async () => {
  const changes = []
  const r = createHealthRunner({ check: async () => { throw new Error('boom') }, onServing: (v) => changes.push(v), setTimer: () => ({}), clearTimer: () => {} })
  const v = await r.start()
  assert(v.serving === false && /boom/.test(v.reason) && changes.length === 0, JSON.stringify(v))
})

console.log('\n-- live: the real Caddy, internal CA, no network --')

const BIN = stagedCaddyPath()
if (!fs.existsSync(BIN)) {
  if (process.env.CI) results.push({ name: 'staged Caddy', pass: false, detail: `missing ${BIN} under CI` })
  else console.log('  SKIPPED: no staged Caddy')
} else {
  const free = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
  const [httpsPort, httpPort] = [await free(), await free()]
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-tls-health-'))
  const sup = createCaddySupervisor({ configDir: dir, resolveBinary: () => BIN })
  try {
    const cfg = buildCaddyConfig({
      hostname: NAME, dnsProvider: { name: 'duckdns', api_token: '{env.REDSTART_DNS_TOKEN}' },
      gatewayPort: 1, mcpPort: 2, httpsServing: false, requireHttps: false, httpsPort, httpPort,
      storageDir: path.join(dir, 'caddy', 'storage'),
    })
    // This test's copy: Caddy's own internal CA, so a real certificate exists with no network.
    cfg.apps.tls.automation.policies[0].issuers = [{ module: 'internal' }]
    // Never let a test put Caddy's root CA into this machine's trust store
    // (on Windows that is a security prompt, and a trusted test root).
    cfg.apps.pki = { certificate_authorities: { local: { install_trust: false } } }
    await sup.start({ config: cfg, secrets: { REDSTART_DNS_TOKEN: 'not-real-token', [PROXY_SECRET_ENV]: 'live-secret-0123' } })
    const deadline = Date.now() + 20000
    let r = null
    while (Date.now() < deadline) {
      r = await loopbackRequest({ name: NAME, port: httpsPort, path: TLS_HEALTH_PATH })
      if (r.ok && r.cert?.subject) break
      await new Promise((res) => setTimeout(res, 250))
    }
    await test('🔍 Caddy itself answers the health route with 200 "ok" over TLS for the name', () => {
      assert(r?.ok && r.status === 200 && r.body === 'ok', JSON.stringify({ ok: r?.ok, status: r?.status, body: r?.body, error: r?.error }))
      return `issuer ${r.cert.issuer?.CN}`
    })
    await test('🔍 the real certificate is parsed, SAN-matched, and its untrusted issuer refused', async () => {
      const v = await checkServing({ name: NAME, port: httpsPort })
      assert(!v.serving && /trusted authority/.test(v.reason) && v.cert?.daysLeft >= 0, JSON.stringify(v))
      const staging = await checkServing({ name: NAME, port: httpsPort, allowStaging: true })
      assert(!staging.serving, 'the staging switch accepted Caddy\'s local CA')
    })
  } finally {
    await sup.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
