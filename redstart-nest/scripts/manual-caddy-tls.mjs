#!/usr/bin/env node
// =============================================================================
// MANUAL: issue a real certificate with the bundled Caddy (TLS plan step 2)
// =============================================================================
// Not a suite (it needs a DuckDNS account and talks to DuckDNS and Let's
// Encrypt). It runs what Nest will run: buildCaddyConfig() + the supervisor +
// the pinned binary, against a real DuckDNS name, and reports:
//
//   1. the name now points at this machine's LAN address (DuckDNS update);
//   2. Caddy obtained a certificate by DNS-01 (Let's Encrypt STAGING by
//      default, whose certificates no browser trusts; --production for real);
//   3. https://<name> over loopback with SNI presents it and answers /health.
//
// Then it keeps running so a browser or phone on the LAN can open
// https://<name>. Ctrl+C stops Caddy.
//
// The token is read from the environment, never from the command line (which
// other local users can see in the process list):
//
//   set REDSTART_DNS_TOKEN=<your DuckDNS token>        (cmd)
//   $env:REDSTART_DNS_TOKEN = '<your DuckDNS token>'    (PowerShell)
//   node scripts/manual-caddy-tls.mjs --name yourname.duckdns.org [--production]
//     [--https-port 443] [--http-port 80] [--stub]
//
// --stub serves a tiny /health on loopback instead of needing Nest running;
// without it, Nest's gateway must be up on 127.0.0.1:19080 (network mode off).
// =============================================================================

import * as crypto from 'node:crypto'
import * as http from 'node:http'
import * as path from 'node:path'
import * as tls from 'node:tls'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildCaddyConfig, PROXY_SECRET_ENV } from '../daemon/caddy-config.mjs'
import { createCaddySupervisor } from '../daemon/caddy-server.mjs'
import { getPrimaryLanIp } from '../daemon/net-interfaces.mjs'
import { stagedCaddyPath } from './fetch-caddy.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback }
const flag = (name) => process.argv.includes(name)

const name = arg('--name')
const token = process.env.REDSTART_DNS_TOKEN
const production = flag('--production')
const httpsPort = Number(arg('--https-port', '443'))
const httpPort = Number(arg('--http-port', '80'))
if (!name || !/\.duckdns\.org$/.test(name)) { console.error('--name <you>.duckdns.org is required'); process.exit(2) }
if (!token) { console.error('Set REDSTART_DNS_TOKEN to your DuckDNS token first (not on the command line).'); process.exit(2) }

const step = (s) => console.log(`\n== ${s}`)

// 1. Point the name at this machine.
step('DuckDNS: point the name at the LAN address')
const lanIp = getPrimaryLanIp(os.networkInterfaces())
if (!lanIp) { console.error('No LAN address found.'); process.exit(1) }
const sub = name.replace(/\.duckdns\.org$/, '')
const upd = await fetch(`https://www.duckdns.org/update?domains=${encodeURIComponent(sub)}&token=${encodeURIComponent(token)}&ip=${lanIp}`)
const updBody = (await upd.text()).trim()
console.log(`${name} → ${lanIp}: DuckDNS says ${updBody}`)
if (updBody !== 'OK') { console.error('DuckDNS refused the update (wrong name or token?).'); process.exit(1) }

// Upstream: Nest's gateway, or a stub.
let gatewayPort = 19080
let stubServer = null
if (flag('--stub')) {
  stubServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(req.url === '/health' ? '{"status":"ok","stub":true}' : `<h1>Redstart TLS check</h1><p>Served over ${req.headers['x-forwarded-proto'] ?? '?'} via the bundled Caddy.</p>`)
  })
  await new Promise((r) => stubServer.listen(0, '127.0.0.1', r))
  gatewayPort = stubServer.address().port
  console.log(`stub upstream on 127.0.0.1:${gatewayPort}`)
}

// 2. Caddy, exactly as Nest will run it.
step(`Caddy: obtain a certificate (${production ? "Let's Encrypt PRODUCTION" : "Let's Encrypt STAGING — browsers will warn, that's expected"})`)
const configDir = path.join(here, '..', 'deps', 'caddy-manual')
const sup = createCaddySupervisor({
  configDir,
  resolveBinary: () => stagedCaddyPath(),
  onStateChange: (s) => console.log(`  supervisor: ${s.state}${s.reason ? ` — ${s.reason}` : ''}`),
})
const config = buildCaddyConfig({
  hostname: name,
  dnsProvider: { name: 'duckdns', api_token: '{env.REDSTART_DNS_TOKEN}' },
  gatewayPort, mcpPort: 19082, httpsServing: false, requireHttps: false,
  storageDir: path.join(configDir, 'caddy', 'storage'), acmeStaging: !production, httpsPort, httpPort,
})
await sup.start({ config, secrets: { REDSTART_DNS_TOKEN: token, [PROXY_SECRET_ENV]: crypto.randomBytes(32).toString('hex') } })

const stopAll = async (code) => { await sup.stop(); stubServer?.close(); process.exit(code) }
process.on('SIGINT', () => { console.log('\nstopping Caddy'); void stopAll(0) })

const deadline = Date.now() + 10 * 60 * 1000
let lastErr = null
while (!sup.status().lastCertificateAt) {
  const s = sup.status()
  if (s.state === 'failed') { console.error(`Caddy failed: ${s.reason}`); await stopAll(1) }
  if (s.lastAcmeError && s.lastAcmeError !== lastErr) { lastErr = s.lastAcmeError; console.log(`  ACME: ${lastErr}`) }
  if (Date.now() > deadline) { console.error('No certificate within 10 minutes.'); console.error(sup.tail().slice(-10).join('\n')); await stopAll(1) }
  // A certificate already in storage from an earlier run is loaded, not re-obtained.
  if (await presented()) break
  await new Promise((r) => setTimeout(r, 3000))
}

// 3. What a client sees, over loopback with SNI (no DNS involved).
step('HTTPS over loopback with SNI')
const peer = await presented(true)
console.log(`  subject  ${peer.subject?.CN}`)
console.log(`  issuer   ${peer.issuer?.O} / ${peer.issuer?.CN}`)
console.log(`  valid    ${peer.valid_from} → ${peer.valid_to}`)
console.log(`  SAN      ${peer.subjectaltname}`)
const health = await new Promise((resolve, reject) => {
  const req = https_get('/health', resolve)
  req.on('error', reject)
})
console.log(`  /health  ${health}`)

step(`Running. Open https://${name}${httpsPort === 443 ? '' : `:${httpsPort}`} from a phone or browser on this network. Ctrl+C to stop.`)
if (!production) console.log("  (staging certificate: expect a 'not trusted' warning — that is the CA, not the setup)")

/** The certificate Caddy presents for the name, or null if there is none yet. */
function presented(detail = false) {
  return new Promise((resolve) => {
    const s = tls.connect({ host: '127.0.0.1', port: httpsPort, servername: name, rejectUnauthorized: false }, () => {
      const c = s.getPeerCertificate(); s.destroy(); resolve(c && c.subject ? (detail ? c : true) : null)
    })
    s.on('error', () => resolve(null))
    s.setTimeout(3000, () => { s.destroy(); resolve(null) })
  })
}

function https_get(urlPath, done) {
  return tls.connect({ host: '127.0.0.1', port: httpsPort, servername: name, rejectUnauthorized: production }, function () {
    this.write(`GET ${urlPath} HTTP/1.1\r\nHost: ${name}\r\nConnection: close\r\n\r\n`)
    let buf = ''
    this.on('data', (c) => { buf += c })
    this.on('end', () => done(buf.split('\r\n')[0] + ' ' + buf.split('\r\n\r\n')[1]?.slice(0, 80)))
  })
}
