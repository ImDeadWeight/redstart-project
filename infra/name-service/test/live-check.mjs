#!/usr/bin/env node
// =============================================================================
// MANUAL: the DEPLOYED name service, end to end, with the real Caddy (step 7)
// =============================================================================
// Against https://names.redstartdevelopment.com (or --server <url>):
//   1. register one install;
//   2. publish a PRIVATE test address (10.255.255.1, unused) and see the A
//      record in public DNS (1.1.1.1);
//   3. the pinned bundled Caddy, configured by Nest's own buildCaddyConfig
//      with the acmedns provider pointed at the service, obtains a
//      certificate from Let's Encrypt STAGING: the challenge TXT is set by
//      the service in REAL DNS, and LE validates it;
//   4. ALWAYS unregister at the end, so no test records are left.
//
// Writes real (DNS-only, private) records to the zone for a minute or two.
// Uses one of the 5 registrations/hour this network has.
//
//   node test/live-check.mjs
// =============================================================================

import * as dns from 'node:dns'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const NEST = path.join(here, '..', '..', '..', 'redstart-nest')
const nestUrl = (...p) => pathToFileURL(path.join(...p)).href
const { buildCaddyConfig, PROXY_SECRET_ENV } = await import(nestUrl(NEST, 'daemon', 'caddy-config.mjs'))
const { createCaddySupervisor } = await import(nestUrl(NEST, 'daemon', 'caddy-server.mjs'))
const { stagedCaddyPath } = await import(nestUrl(NEST, 'scripts', 'fetch-caddy.mjs'))

const i = process.argv.indexOf('--server')
const SERVER = i > 0 ? process.argv[i + 1] : 'https://names.redstartdevelopment.com'
const TEST_IP = '10.255.255.1'
const BIN = stagedCaddyPath()
if (!fs.existsSync(BIN)) { console.error(`No staged Caddy at ${BIN}`); process.exit(2) }

const resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 })
resolver.setServers(['1.1.1.1'])
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms, every = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) { try { const v = await fn(); if (v) return v } catch { /* not yet */ } await wait(every) }
  return null
}
const step = (s) => console.log(`\n== ${s}`)

step(`register at ${SERVER}`)
const regRes = await fetch(`${SERVER}/v1/register`, { method: 'POST' })
if (regRes.status !== 201) { console.error(`register: ${regRes.status} ${await regRes.text()}`); process.exit(1) }
const reg = await regRes.json()
const auth = { Authorization: `Bearer ${reg.id}.${reg.credential}` }
console.log(`  ${reg.hostname}`)

const free = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-live-'))
const sup = createCaddySupervisor({ configDir: dir, resolveBinary: () => BIN, onStateChange: (s) => console.log(`  caddy: ${s.state}${s.reason ? ` (${s.reason})` : ''}`) })
const results = {}
try {
  step(`publish ${TEST_IP} (private, unused)`)
  const ip = await fetch(`${SERVER}/v1/ip`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ ipv4: TEST_IP }) })
  console.log(`  PUT /v1/ip → ${ip.status}`)
  results.a = await until(async () => (await resolver.resolve4(reg.hostname)).includes(TEST_IP), 90_000)
  console.log(`  public DNS (1.1.1.1): ${results.a ? `${reg.hostname} → ${TEST_IP}` : 'not visible within 90 s'}`)

  const pub = await fetch(`${SERVER}/v1/ip`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ ipv4: '8.8.8.8' }) })
  results.publicRefused = pub.status === 400
  console.log(`  a public address → ${pub.status} (refused: ${results.publicRefused})`)

  step('the real Caddy obtains a STAGING certificate through the service')
  const [httpsPort, httpPort] = [await free(), await free()]
  const config = buildCaddyConfig({
    hostname: reg.hostname,
    dnsProvider: { name: 'acmedns', username: reg.acmedns.username, password: '{env.REDSTART_DNS_TOKEN}', subdomain: reg.acmedns.subdomain, server_url: reg.acmedns.server_url },
    gatewayPort: 1, mcpPort: 2, httpsServing: false, requireHttps: false, httpsPort, httpPort, acmeStaging: true,
    storageDir: path.join(dir, 'caddy', 'storage'),
  })
  await sup.start({ config, secrets: { REDSTART_DNS_TOKEN: reg.credential, [PROXY_SECRET_ENV]: 'live-check-secret-0123' } })
  let lastErr = null
  results.cert = await until(async () => {
    const s = sup.status()
    if (s.lastAcmeError && s.lastAcmeError !== lastErr) { lastErr = s.lastAcmeError; console.log(`  acme: ${lastErr.slice(0, 160)}`) }
    return s.lastCertificateAt ? true : null
  }, 6 * 60_000, 2000)
  console.log(`  certificate: ${results.cert ? 'OBTAINED (Let\'s Encrypt staging, DNS-01 via the name service)' : 'not within 6 minutes'}`)
} finally {
  await sup.stop()
  step('unregister (always)')
  const del = await fetch(`${SERVER}/v1/register`, { method: 'DELETE', headers: auth })
  results.unregistered = del.status === 204
  console.log(`  DELETE /v1/register → ${del.status}`)
  fs.rmSync(dir, { recursive: true, force: true })
}

const pass = results.a && results.publicRefused && results.cert && results.unregistered
console.log(`\n${pass ? 'PASS' : 'FAIL'}: ${JSON.stringify(results)}`)
process.exit(pass ? 0 : 1)
