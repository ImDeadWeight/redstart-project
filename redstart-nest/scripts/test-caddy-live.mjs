// =============================================================================
// The bundled Caddy, live: the real binary, the real supervisor, stub upstreams
// =============================================================================
// test-caddy-config.mjs proves what the generated config SAYS; this proves
// what the pinned Caddy DOES with it. Things the plan says must be "asserted
// in tests, not assumed":
//
//   - a client-sent X-Forwarded-For is replaced, not appended to (no
//     trusted_proxies), so proxy-trust.mjs can read the first hop;
//   - a client-sent X-Redstart-Proxy is overwritten with the real secret;
//   - an SSE stream reaches the client as written (Caddy also flushes
//     text/event-stream by itself; flush_interval -1 covers other streams);
//   - /mcp reaches the MCP upstream, everything else the gateway;
//   - :80 redirects / proxies / refuses per httpsServing and requireHttps;
//   - with no certificate yet, a TLS handshake fails closed: no self-signed
//     or internal-CA fallback (the SNI policy itself is test-caddy-config's);
//   - stop() leaves no listener behind.
//
// No network: high ports on loopback, and the ACME CA in this test's copy of
// the config points at a dead loopback port, so no certificate is requested
// and no DNS provider is ever called. (Issuance itself is the manual check,
// scripts/manual-caddy-tls.mjs, with a real DuckDNS name.)
//
// Needs the staged binary (node scripts/fetch-caddy.mjs). Under CI a missing
// binary fails; locally it skips.
//
// Run:  node scripts/test-caddy-live.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as http from 'node:http'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import * as tls from 'node:tls'
import * as crypto from 'node:crypto'
import { buildCaddyConfig, PROXY_HEADER, PROXY_SECRET_ENV } from '../daemon/caddy-config.mjs'
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

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const BIN = stagedCaddyPath()
if (!fs.existsSync(BIN)) {
  if (process.env.CI) {
    console.log(`FAIL  - the pinned Caddy is not staged at ${BIN} (CI must run node scripts/fetch-caddy.mjs first)`)
    process.exit(1)
  }
  console.log(`\nSKIPPED: no staged Caddy at ${BIN}. Run: node scripts/fetch-caddy.mjs\n`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const HOST = 'nest-live-test.duckdns.org'
const SECRET = crypto.randomBytes(32).toString('hex')

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
    s.on('error', reject)
  })
}

/** A loopback upstream that records what it was sent. */
async function stub(name) {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers })
    if (req.url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write('data: one\n\n')
      setTimeout(() => { res.write('data: two\n\n'); res.end() }, 600)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ upstream: name }))
  })
  const port = await freePort()
  await new Promise((r) => server.listen(port, '127.0.0.1', r))
  return { port, seen, close: () => new Promise((r) => server.close(r)) }
}

function get(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers: { host: HOST, ...headers } }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('timeout')))
  })
}

async function canBind(port) {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(port, '0.0.0.0', () => s.close(() => resolve(true)))
  })
}

const gateway = await stub('gateway')
const mcp = await stub('mcp')
const httpPort = await freePort()
const httpsPort = await freePort()
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-caddy-live-'))
const states = []
const sup = createCaddySupervisor({ configDir, resolveBinary: () => BIN, onStateChange: (s) => states.push(s.state) })

function config({ httpsServing, requireHttps }) {
  const cfg = buildCaddyConfig({
    hostname: HOST,
    dnsProvider: { name: 'duckdns', api_token: '{env.REDSTART_DNS_TOKEN}' },
    gatewayPort: gateway.port, mcpPort: mcp.port,
    httpsServing, requireHttps, httpsPort, httpPort, acmeStaging: true,
    storageDir: path.join(configDir, 'caddy', 'storage'),
  })
  // This test's copy only: an ACME directory nothing listens on, so Caddy
  // never requests a certificate or calls DuckDNS.
  cfg.apps.tls.automation.policies[0].issuers[0].ca = 'http://127.0.0.1:9/directory'
  return cfg
}

async function startWith(opts) {
  await sup.start({ config: config(opts), secrets: { REDSTART_DNS_TOKEN: 'not-a-real-token', [PROXY_SECRET_ENV]: SECRET } })
  const deadline = Date.now() + 15000
  while (sup.status().state !== 'running') {
    if (sup.status().state === 'failed' || Date.now() > deadline) {
      throw new Error(`Caddy did not start: ${sup.status().state} ${sup.status().reason ?? ''}\n${sup.tail().slice(-5).join('\n')}`)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}

// ---------------------------------------------------------------------------

try {
  console.log(`\n-- fallback mode (HTTPS not serving): :${httpPort} proxies --`)

  await test('🔍 the real binary starts on the generated config and the supervisor sees it ready', async () => {
    await startWith({ httpsServing: false, requireHttps: false })
    assert(states.includes('starting') && states.at(-1) === 'running', states.join(','))
    return `pid ${sup.status().pid}`
  })

  await test('🔍 a forged X-Redstart-Proxy is overwritten with the launch secret', async () => {
    const r = await get(httpPort, '/health', { [PROXY_HEADER]: 'forged-by-a-lan-client' })
    assert(r.status === 200 && JSON.parse(r.body).upstream === 'gateway', `${r.status} ${r.body}`)
    const h = gateway.seen.at(-1).headers[PROXY_HEADER.toLowerCase()]
    assert(h === SECRET, `upstream saw ${PROXY_HEADER}: ${h}`)
  })

  await test('🔍 a client-sent X-Forwarded-For is replaced with the real peer, not appended to', async () => {
    await get(httpPort, '/whoami', { 'x-forwarded-for': '6.6.6.6', 'x-forwarded-host': 'evil.example' })
    const h = gateway.seen.at(-1).headers
    assert(h['x-forwarded-for'] === '127.0.0.1', `X-Forwarded-For reached the gateway as ${JSON.stringify(h['x-forwarded-for'])}`)
    assert(h['x-forwarded-host'] === HOST, `X-Forwarded-Host reached the gateway as ${JSON.stringify(h['x-forwarded-host'])}`)
  })

  await test('🔍 /mcp and /mcp/* reach the MCP upstream; /mcpx does not', async () => {
    for (const p of ['/mcp', '/mcp/session']) {
      const r = await get(httpPort, p)
      assert(JSON.parse(r.body).upstream === 'mcp', `${p} → ${r.body}`)
      assert(mcp.seen.at(-1).headers[PROXY_HEADER.toLowerCase()] === SECRET, `${p}: MCP upstream got no secret`)
    }
    assert(JSON.parse((await get(httpPort, '/mcpx')).body).upstream === 'gateway', '/mcpx went to MCP')
  })

  await test('🔍 SSE is flushed as written, not buffered until the response ends', async () => {
    const t0 = Date.now()
    const firstAt = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: httpPort, path: '/sse', headers: { host: HOST } }, (res) => {
        res.once('data', () => resolve(Date.now() - t0))
        res.on('error', reject)
      }).on('error', reject)
    })
    assert(firstAt < 450, `first event arrived after ${firstAt} ms; the upstream sent it at ~0 ms and the second at 600 ms`)
    return `first event after ${firstAt} ms`
  })

  await test('🔍 with no certificate yet, TLS fails closed (no self-signed fallback)', async () => {
    const err = await new Promise((resolve) => {
      const s = tls.connect({ host: '127.0.0.1', port: httpsPort, servername: HOST, rejectUnauthorized: false }, () => { s.destroy(); resolve(null) })
      s.on('error', (e) => resolve(e))
      s.setTimeout(5000, () => { s.destroy(); resolve(new Error('timeout')) })
    })
    assert(err, 'a handshake completed with no issued certificate: Caddy served a fallback certificate')
    return err.code ?? err.message.slice(0, 60)
  })

  console.log('\n-- HTTPS serving: :80 redirects --')

  await test('🔍 :80 sends a 308 to https://<hostname><uri> and proxies nothing', async () => {
    await startWith({ httpsServing: true, requireHttps: false })
    const before = gateway.seen.length
    const r = await get(httpPort, '/chat?x=1', { host: '192.168.1.50' })
    assert(r.status === 308, `status ${r.status}`)
    assert(r.headers.location === `https://${HOST}:${httpsPort}/chat?x=1`, `Location ${r.headers.location}`)
    assert(gateway.seen.length === before, 'the redirect also reached the gateway')
  })

  console.log('\n-- requireHttps while not serving: :80 refuses --')

  await test('🔍 503 refusal page, nothing proxied', async () => {
    await startWith({ httpsServing: false, requireHttps: true })
    const before = gateway.seen.length
    const r = await get(httpPort, '/')
    assert(r.status === 503 && /HTTPS isn't working/.test(r.body), `${r.status} ${r.body.slice(0, 80)}`)
    assert(gateway.seen.length === before, 'requireHttps still proxied')
  })

  console.log('\n-- a port another process holds on IPv4 only --')

  await test('🔍 is reported as "in use", not silently split (found on the first real run, Windows)', async () => {
    await sup.stop()
    const squatter = net.createServer()
    await new Promise((r) => squatter.listen(httpPort, '0.0.0.0', r))
    try {
      await sup.start({ config: config({ httpsServing: false, requireHttps: false }), secrets: { REDSTART_DNS_TOKEN: 'not-a-real-token', [PROXY_SECRET_ENV]: SECRET } })
      const deadline = Date.now() + 15000
      while (!/in use/.test(sup.status().reason ?? '') && sup.status().state !== 'running' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
      }
      const s = sup.status()
      assert(s.state !== 'running', 'Caddy came up while another process held IPv4 :' + httpPort + ' — IPv4 clients would reach that process')
      assert(new RegExp(`^Port ${httpPort} is in use by another program`).test(s.reason ?? ''), `reason: ${s.reason}`)
      return s.reason.split(' —')[0]
    } finally {
      await sup.stop()
      await new Promise((r) => squatter.close(r))
    }
  })

  console.log('\n-- stop --')

  await test('🔍 stop() returns with both ports free', async () => {
    await sup.stop()
    assert(sup.status().state === 'stopped', sup.status().state)
    assert(await canBind(httpPort), `:${httpPort} still held after stop()`)
    assert(await canBind(httpsPort), `:${httpsPort} still held after stop()`)
  })

  await test('the config on disk never held the secret', () => {
    const text = fs.readFileSync(path.join(configDir, 'caddy', 'caddy.json'), 'utf8')
    assert(!text.includes(SECRET) && !text.includes('not-a-real-token'), 'a secret value is in caddy.json')
  })
} finally {
  await sup.stop().catch(() => {})
  await gateway.close()
  await mcp.close()
  fs.rmSync(configDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
