// =============================================================================
// Nest's Automatic provider against the REAL name service (TLS step 8)
// =============================================================================
// The two halves of Product B, tested together: Nest's own client code
// (redstart-nest/daemon/tls-names.mjs, tls-settings.mjs) over HTTP against
// this service's own service.js (node:sqlite for D1, the fake Cloudflare API).
// Lives here because Nest's tests may not import another area's code
// (test-boundaries.mjs); this side may import Nest's.
//
//   - register → the computed hostname is the one the service writes;
//   - the acmedns block Nest gives Caddy is the one the service tells an
//     install to use;
//   - publish, heartbeat, release; the credential is dead after release.
//
// Run:  npm test   (part of it)
// =============================================================================

import * as http from 'node:http'
import * as net from 'node:net'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { d1, fakeCloudflare } from './harness.mjs'
import { createService } from '../src/service.js'
import { cloudflareDns } from '../src/dns.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const nest = (p) => pathToFileURL(path.join(here, '..', '..', '..', 'redstart-nest', 'daemon', p)).href

const free = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const port = await free()
const SERVER = `http://127.0.0.1:${port}`
process.env.REDSTART_NAME_SERVICE_URL = SERVER // before Nest's modules read it

const { registerName, heartbeatName, releaseName, nameProvider } = await import(nest('tls-names.mjs'))
const { withRedstart, tlsRuntime, readTls } = await import(nest('tls-settings.mjs'))

const results = []
async function test(name, fn) {
  try { const d = await fn(); results.push({ pass: true }); console.log(`  ok  - ${name}${d ? `  (${d})` : ''}`) } catch (err) { results.push({ pass: false, name, detail: err.message }); console.log(`FAIL  - ${name}\n        ${err.message}`) }
}
function assert(c, m) { if (!c) throw new Error(m) }

const ZONE = 'redstartdevelopment.com'
const cf = fakeCloudflare()
const svc = createService({ db: d1(), dns: cloudflareDns({ token: 't', zoneId: 'z', zone: ZONE, fetch: cf.impl }), zone: ZONE, serverUrl: SERVER })
const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks)
  const r = await svc.fetch(new Request(`${SERVER}${req.url}`, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }))
  res.writeHead(r.status, Object.fromEntries(r.headers))
  res.end(Buffer.from(await r.arrayBuffer()))
})
await new Promise((r) => server.listen(port, '127.0.0.1', r))

console.log('\n-- Nest\'s Automatic provider ⇄ the name service --')

let reg
await test('🔍 Nest registers; its computed hostname is the one the service hands out', async () => {
  reg = await registerName()
  assert(reg.ok, JSON.stringify(reg))
  const raw = await (await fetch(`${SERVER}/v1/register`, { method: 'POST', headers: { 'CF-Connecting-IP': '198.51.100.2' } })).json()
  assert(reg.hostname === `${reg.id}.nest.${ZONE}` && raw.hostname === `${raw.id}.nest.${ZONE}`, `${reg.hostname} / ${raw.hostname}`)
})

await test('🔍 the acmedns block Nest gives Caddy matches what the service tells an install', async () => {
  const settings = withRedstart({ tls: { mode: 'redstart' } }, reg, { encrypt: (s) => `enc:${s}` })
  const t = tlsRuntime(settings, { decrypt: (s) => s.slice(4) })
  assert(t && t.dnsProvider.username === reg.id && t.dnsProvider.subdomain === reg.id && t.dnsProvider.server_url === SERVER, JSON.stringify(t?.dnsProvider))
  assert(t.secrets.REDSTART_DNS_TOKEN === reg.credential && t.dnsProvider.password === '{env.REDSTART_DNS_TOKEN}', 'the credential is not passed by env')
  assert(readTls(settings).automatic.hostname === reg.hostname, 'the panel would show another name')
  // And /update accepts exactly that block's credentials (what Caddy will send).
  const up = await fetch(`${SERVER}/update`, { method: 'POST', headers: { 'X-Api-User': t.dnsProvider.username, 'X-Api-Key': t.secrets.REDSTART_DNS_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ subdomain: t.dnsProvider.subdomain, txt: 'A'.repeat(43) }) })
  assert(up.status === 200, `/update with Nest's block → ${up.status}`)
})

await test('🔍 Nest publishes the LAN address through the service: one DNS-only A record at its name', async () => {
  const r = await nameProvider({ provider: 'redstart', name: reg.hostname }).updateAddress('192.168.0.213', { token: reg.credential, id: reg.id })
  assert(r.ok, JSON.stringify(r))
  const a = [...cf.records.values()].filter((x) => x.type === 'A' && x.name === reg.hostname)
  assert(a.length === 1 && a[0].content === '192.168.0.213' && a[0].proxied === false, JSON.stringify(a))
})

await test('heartbeat is accepted', async () => {
  const r = await heartbeatName({ id: reg.id, credential: reg.credential })
  assert(r.ok, JSON.stringify(r))
})

await test('🔍 release removes every record; the credential is dead after, and a second release still counts as released', async () => {
  const r = await releaseName({ id: reg.id, credential: reg.credential })
  assert(r.ok && r.status === 204, JSON.stringify(r))
  assert(![...cf.records.values()].some((x) => x.name.includes(`${reg.id}.nest.`)), 'records left behind')
  assert(!(await heartbeatName({ id: reg.id, credential: reg.credential })).ok, 'credential still works')
  assert((await releaseName({ id: reg.id, credential: reg.credential })).ok, 'a repeat release was an error')
  const after = await nameProvider({ provider: 'redstart', name: reg.hostname }).updateAddress('192.168.0.213', { token: reg.credential, id: reg.id })
  assert(!after.ok && /new name/.test(after.detail), after.detail)
})

server.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
