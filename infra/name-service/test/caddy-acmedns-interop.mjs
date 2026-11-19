#!/usr/bin/env node
// =============================================================================
// MANUAL: the REAL Caddy acmedns plugin against the name service (TLS step 7)
// =============================================================================
// The plan's condition for the name service: tested with Caddy's own acmedns
// plugin, not only with requests written to look like it. This runs:
//
//   - the service (service.js) on a local HTTP port, with node:sqlite for D1
//     and the fake Cloudflare API (nothing is written to real DNS);
//   - the pinned bundled Caddy (redstart-nest/deps/caddy, from fetch-caddy),
//     configured by Nest's own buildCaddyConfig with the acmedns provider
//     pointed at that port, issuing from Let's Encrypt STAGING.
//
// Caddy opens a staging order, gets a DNS-01 challenge, and calls the
// service's /update itself. The check: the challenge TXT lands at
// _acme-challenge.<id>.nest.redstartdevelopment.com with a valid ACME value.
// Validation cannot succeed (the fake DNS is not public), and is not the
// point: the plugin-to-service protocol is.
//
// Needs network (Let's Encrypt staging). Not part of CI.
//
//   node test/caddy-acmedns-interop.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as http from 'node:http'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { d1, fakeCloudflare } from './harness.mjs'
import { createService } from '../src/service.js'
import { cloudflareDns } from '../src/dns.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const NEST = path.join(here, '..', '..', '..', 'redstart-nest')
const nestUrl = (...p) => pathToFileURL(path.join(...p)).href
const { buildCaddyConfig, PROXY_SECRET_ENV } = await import(nestUrl(NEST, 'daemon', 'caddy-config.mjs'))
const { createCaddySupervisor } = await import(nestUrl(NEST, 'daemon', 'caddy-server.mjs'))
const { stagedCaddyPath } = await import(nestUrl(NEST, 'scripts', 'fetch-caddy.mjs'))

const ZONE = 'redstartdevelopment.com'
const BIN = stagedCaddyPath()
if (!fs.existsSync(BIN)) { console.error(`No staged Caddy at ${BIN}: run node redstart-nest/scripts/fetch-caddy.mjs`); process.exit(2) }

const free = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const [svcPort, httpsPort, httpPort] = [await free(), await free(), await free()]
const SERVER = `http://127.0.0.1:${svcPort}`

// The service, with fakes for D1 and Cloudflare, behind a plain HTTP server.
const cf = fakeCloudflare()
const updates = []
const svc = createService({
  db: d1(),
  dns: cloudflareDns({ token: 'interop-fake-token', zoneId: 'z', zone: ZONE, fetch: cf.impl }),
  zone: ZONE, serverUrl: SERVER,
  log: (e) => { if (e === 'acme_txt_set') console.log('  service: /update accepted') },
})
const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks)
  if (req.url === '/update') updates.push({ headers: { user: req.headers['x-api-user'], hasKey: !!req.headers['x-api-key'], ct: req.headers['content-type'] }, body: body.toString() })
  const r = await svc.fetch(new Request(`${SERVER}${req.url}`, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }))
  res.writeHead(r.status, Object.fromEntries(r.headers))
  res.end(Buffer.from(await r.arrayBuffer()))
})
await new Promise((r) => server.listen(svcPort, '127.0.0.1', r))

const reg = await (await fetch(`${SERVER}/v1/register`, { method: 'POST' })).json()
console.log(`registered ${reg.hostname}`)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-interop-'))
const sup = createCaddySupervisor({ configDir: dir, resolveBinary: () => BIN, onStateChange: (s) => console.log(`  caddy: ${s.state}${s.reason ? ` (${s.reason})` : ''}`) })
let code = 1
try {
  const config = buildCaddyConfig({
    hostname: reg.hostname,
    // Exactly what Nest will give Caddy in step 8 (tls-names redstart provider).
    dnsProvider: { name: 'acmedns', username: reg.acmedns.username, password: '{env.REDSTART_DNS_TOKEN}', subdomain: reg.acmedns.subdomain, server_url: reg.acmedns.server_url },
    gatewayPort: 1, mcpPort: 2, httpsServing: false, requireHttps: false, httpsPort, httpPort, acmeStaging: true,
    storageDir: path.join(dir, 'caddy', 'storage'),
  })
  await sup.start({ config, secrets: { REDSTART_DNS_TOKEN: reg.credential, [PROXY_SECRET_ENV]: 'interop-secret-0123' } })

  const want = `_acme-challenge.${reg.hostname}`
  const deadline = Date.now() + 120_000
  let txt = null
  while (Date.now() < deadline) {
    txt = [...cf.records.values()].find((r) => r.type === 'TXT' && r.name === want)
    if (txt) break
    if (sup.status().state === 'failed') break
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!txt) {
    console.error(`FAIL: no TXT at ${want} within 2 minutes. Caddy's last lines:\n${sup.tail().slice(-8).join('\n')}`)
  } else {
    const u = updates[0]
    const body = JSON.parse(u.body)
    const ok = /^[A-Za-z0-9_-]{43}$/.test(txt.content) && txt.proxied === false && u.headers.user === reg.id && u.headers.hasKey && body.subdomain === reg.id && body.txt === txt.content
    console.log(ok
      ? `PASS: the real acmedns plugin set ${want} = ${txt.content.slice(0, 8)}… (DNS-only), with X-Api-User=${u.headers.user}, subdomain=${body.subdomain}`
      : `FAIL: unexpected request or record: ${JSON.stringify({ u: { ...u, body }, txt })}`)
    code = ok ? 0 : 1
  }
} finally {
  await sup.stop()
  server.close()
  fs.rmSync(dir, { recursive: true, force: true })
}
process.exit(code)
