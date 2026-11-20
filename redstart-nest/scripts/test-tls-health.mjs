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
import { checkServing, diagnostics, createHealthRunner, loopbackRequest, RENEWAL_WARN_DAYS, trustFor, letsEncryptStagingRoots, tlsErrorReason } from '../daemon/tls-health.mjs'
import { TLS_HEALTH_PATH, buildCaddyConfig, PROXY_SECRET_ENV, adminHostnameFor } from '../daemon/caddy-config.mjs'
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

await test('🔍 verification is ON for every check; staging roots are trusted only when staging was chosen', async () => {
  const seen = []
  await checkServing({ name: NAME, now: () => NOW, request: fakeRequest({ routes: healthy, seen }) })
  await checkServing({ name: NAME, now: () => NOW, allowStaging: true, request: fakeRequest({ routes: healthy, seen }) })
  assert(seen.every((o) => o.rejectUnauthorized === true), 'a check ran with certificate verification switched off')
  assert(seen[0].ca === undefined, 'staging roots trusted without staging being chosen')
  const roots = letsEncryptStagingRoots()
  assert(Array.isArray(seen[1].ca) && roots.every((r) => seen[1].ca.includes(r)) && seen[1].ca.length > roots.length, 'staging: not Node\'s roots PLUS the staging roots')
  assert(trustFor({ allowStaging: false }) === undefined, 'trustFor(false)')
})

await test('🔍 the staging roots are the two Let\'s Encrypt publishes, pinned by fingerprint', async () => {
  const { X509Certificate } = await import('node:crypto')
  const fps = letsEncryptStagingRoots().map((pem) => new X509Certificate(pem).fingerprint256).sort()
  const want = [
    'E7:05:70:A9:89:F8:56:5A:AB:DF:7C:AE:27:AB:D1:62:18:72:D6:A3:F8:11:E3:FE:F2:7E:3D:BA:02:91:21:98', // (STAGING) Pretend Pear X1
    '9B:2A:33:9F:E6:A3:E8:55:85:C4:CD:75:53:6C:B8:C1:CF:7C:D6:03:B9:A6:4B:EC:25:21:85:8A:E4:8D:A8:5D', // (STAGING) Bogus Broccoli X2
  ].sort()
  assert(JSON.stringify(fps) === JSON.stringify(want), `staging roots changed: ${fps.join(', ')}`)
})

await test('verification failures become the panel\'s sentences', () => {
  const rows = [
    ['CERT_HAS_EXPIRED', /expired/], ['ERR_TLS_CERT_ALTNAME_INVALID', /not for myhouse/], ['SELF_SIGNED_CERT_IN_CHAIN', /trusted authority/],
    ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', /trusted authority/], ['ECONNREFUSED', /isn't answering/], ['ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR', /No certificate yet/],
  ]
  for (const [code, re] of rows) assert(re.test(tlsErrorReason(code, NAME)), `${code} → ${tlsErrorReason(code, NAME)}`)
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
  const [httpsPort, httpPort, adminHttpsPort] = [await free(), await free(), await free()]
  // A stand-in for the admin listener on loopback, recording what reaches it.
  const adminSeen = []
  const { createServer } = await import('node:http')
  const adminStub = createServer((req, res) => { adminSeen.push({ url: req.url, secret: req.headers['x-redstart-proxy'] }); res.end('admin-stub') })
  await new Promise((r) => adminStub.listen(0, '127.0.0.1', r))
  const adminPort = adminStub.address().port
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-tls-health-'))
  const sup = createCaddySupervisor({ configDir: dir, resolveBinary: () => BIN })
  try {
    const cfg = buildCaddyConfig({
      hostname: NAME, dnsProvider: { name: 'duckdns', api_token: '{env.REDSTART_DNS_TOKEN}' },
      gatewayPort: 1, mcpPort: 2, httpsServing: false, requireHttps: false, httpsPort, httpPort, adminPort, adminHttpsPort,
      adminHostname: adminHostnameFor(NAME),
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
    let ca
    while (Date.now() < deadline) {
      // Verified against Caddy's own local root (this test's CA), never with verification off.
      const rootFile = path.join(dir, 'caddy', 'storage', 'pki', 'authorities', 'local', 'root.crt')
      ca = fs.existsSync(rootFile) ? fs.readFileSync(rootFile, 'utf8') : undefined
      r = await loopbackRequest({ name: NAME, port: httpsPort, path: TLS_HEALTH_PATH, ca })
      if (r.ok && r.cert?.subject) break
      await new Promise((res) => setTimeout(res, 250))
    }
    await test('🔍 Caddy itself answers the health route with 200 "ok" over TLS for the name', () => {
      assert(r?.ok && r.status === 200 && r.body === 'ok', JSON.stringify({ ok: r?.ok, status: r?.status, body: r?.body, error: r?.error }))
      return `issuer ${r.cert.issuer?.CN}`
    })
    await test('🔍 the admin panel over HTTPS: Caddy carries it to the loopback listener, with the proxy secret', async () => {
      const a = await loopbackRequest({ name: NAME, port: adminHttpsPort, path: '/admin/api/x', ca })
      assert(a.ok && a.status === 200 && a.body === 'admin-stub', JSON.stringify({ ok: a.ok, status: a.status, body: a.body, error: a.error }))
      assert(adminSeen.at(-1)?.url === '/admin/api/x' && adminSeen.at(-1)?.secret === 'live-secret-0123', JSON.stringify(adminSeen.at(-1)))
      const plain = await new Promise((resolve) => {
        const r = (http80) => http80.get({ host: '127.0.0.1', port: adminHttpsPort, path: '/' }, (res) => { res.resume(); resolve(res.statusCode) }).on('error', () => resolve('refused'))
        import('node:http').then(r)
      })
      assert(plain !== 200, `plain HTTP to the admin port answered ${plain}`)
    })

    await test('🔍 the admin panel on its own name: :443 by Host to the loopback listener, on the WILDCARD certificate', async () => {
      const ADMIN = adminHostnameFor(NAME)
      let a = null
      const until = Date.now() + 20000
      while (Date.now() < until) {
        a = await loopbackRequest({ name: ADMIN, port: httpsPort, path: '/admin/api/y', ca })
        if (a.ok) break
        await new Promise((res) => setTimeout(res, 250))
      }
      assert(a?.ok && a.status === 200 && a.body === 'admin-stub', JSON.stringify({ ok: a?.ok, status: a?.status, body: a?.body, error: a?.error }))
      assert(adminSeen.at(-1)?.url === '/admin/api/y' && adminSeen.at(-1)?.secret === 'live-secret-0123', JSON.stringify(adminSeen.at(-1)))
      // The certificate is *.<name>, never one of admin.<name>'s own (whose
      // challenge the name service could not answer).
      const san = String(a.cert?.subjectaltname ?? '')
      assert(san.split(/,\s*/).includes(`DNS:*.${NAME}`) && !san.includes(`DNS:${ADMIN}`), `SAN ${san}`)
      // The device name still serves the chat side, not the admin listener.
      const before = adminSeen.length
      const chat = await loopbackRequest({ name: NAME, port: httpsPort, path: '/admin/api/z', ca })
      assert(chat.ok && adminSeen.length === before, `the device name reached the admin listener (${JSON.stringify(adminSeen.at(-1))})`)
      // Plain :80 under the admin name: refused (HTTPS not serving here), never proxied.
      const plain = await new Promise((resolve) => {
        import('node:http').then((http80) => http80.get({ host: '127.0.0.1', port: httpPort, path: '/admin/api/w', headers: { host: ADMIN } }, (res) => { res.resume(); resolve(res.statusCode) }).on('error', () => resolve('refused')))
      })
      assert(plain === 503 && adminSeen.length === before, `plain :80 under the admin name answered ${plain}`)
      return san
    })

    await test('🔍 the real certificate from an untrusted issuer is refused by verification itself', async () => {
      const v = await checkServing({ name: NAME, port: httpsPort })
      assert(!v.serving && /trusted authority/.test(v.reason), JSON.stringify(v))
      const staging = await checkServing({ name: NAME, port: httpsPort, allowStaging: true })
      assert(!staging.serving, 'the staging switch accepted Caddy\'s local CA')
    })
  } finally {
    await sup.stop()
    adminStub.close()
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
