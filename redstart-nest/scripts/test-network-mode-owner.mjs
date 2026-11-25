// =============================================================================
// The network-mode owner (TLS plan C2b): the executor, fake and real
// =============================================================================
// Part 1 drives network-mode-owner.mjs with fake effects that record calls:
// order, the failed latch, retry, rollback, the stopping latch, serialisation.
//
// Part 2 is the plan's real-port test: a stub gateway + MCP server moved by
// the REAL listener-rebind.mjs, the REAL bundled Caddy under its supervisor,
// and a full local → lan-https → lan-https-fallback → local cycle, checking
// from this machine's LAN address what is reachable at each stage, and that
// nothing is left listening at the end. (Skipped without a LAN address or a
// staged Caddy; required under CI for the Caddy part.)
//
// Run:  node scripts/test-network-mode-owner.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as http from 'node:http'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { createNetworkModeOwner } from '../daemon/network-mode-owner.mjs'
import { rebindHttpServer } from '../daemon/listener-rebind.mjs'
import { createCaddySupervisor } from '../daemon/caddy-server.mjs'
import { buildCaddyConfig, PROXY_SECRET_ENV } from '../daemon/caddy-config.mjs'
import { getPrimaryLanIp } from '../daemon/net-interfaces.mjs'
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

// ---------------------------------------------------------------------------
// Part 1 — fake effects
// ---------------------------------------------------------------------------

function fakeEffects({ failOn = null, delayMs = 0 } = {}) {
  const calls = []
  const step = (name) => async (arg) => {
    calls.push(name + (typeof arg === 'string' ? `(${arg})` : arg && 'serving' in arg ? `(serving=${arg.serving})` : ''))
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    if (failOn && failOn(name, arg, calls)) throw new Error(`${name} failed`)
  }
  return {
    calls,
    effects: {
      bindDataPlane: step('bind'), startPort80: step('port80+'), stopPort80: step('port80-'),
      startCaddy: step('caddy+'), stopCaddy: step('caddy-'),
      ensureFirewall: async (rule) => { calls.push(`fw(${rule})`) },
    },
  }
}

const quiet = () => {}
const owner = (fx, over = {}) => createNetworkModeOwner({ effects: fx.effects, platform: 'win32', log: quiet, ...over })

console.log('\n-- the executor, with fake effects --')

await test('boot with network mode on, HTTPS off: today\'s lan-http, in order', async () => {
  const fx = fakeEffects(); const o = owner(fx)
  const s = await o.update({ networkMode: true, gatewayPort: 19080 })
  assert(s.state === 'lan-http' && o.dataPlaneHost() === '0.0.0.0', JSON.stringify(s))
  assert(fx.calls.join(' ') === 'bind(0.0.0.0) port80+ fw(gateway) fw(mcp) fw(content) fw(port80)', fx.calls.join(' '))
})

await test('🔍 HTTPS on: the effects run proxy-off → narrow → rule → Caddy', async () => {
  const fx = fakeEffects(); const o = owner(fx)
  await o.update({ networkMode: true })
  fx.calls.length = 0
  const s = await o.update({ tlsMode: 'own', caddyKey: 'name-a' })
  assert(s.state === 'lan-https' && o.dataPlaneHost() === '127.0.0.1', JSON.stringify(s))
  assert(fx.calls.join(' ') === 'port80- bind(127.0.0.1) fw(caddy) caddy+(serving=false)', fx.calls.join(' '))
})

await test('🔍 Caddy gives up: the fallback, once, and no restart loop afterwards', async () => {
  const fx = fakeEffects(); const o = owner(fx)
  await o.update({ networkMode: true, tlsMode: 'own', caddyKey: 'a' })
  fx.calls.length = 0
  const s = await o.caddyStatus({ state: 'failed', reason: 'Port 443 is in use by another program' })
  assert(s.state === 'lan-https-fallback' && o.dataPlaneHost() === '0.0.0.0', JSON.stringify(s))
  assert(fx.calls.join(' ') === 'caddy- bind(0.0.0.0) fw(gateway) fw(mcp) fw(content)', fx.calls.join(' '))
  fx.calls.length = 0
  await o.caddyStatus({ state: 'stopped' })
  await o.caddyStatus({ state: 'failed' })
  await o.update({})
  assert(fx.calls.length === 0, `kept acting after the fallback: ${fx.calls.join(' ')}`)
})

await test('retry from the fallback: narrow, start Caddy again', async () => {
  const fx = fakeEffects(); const o = owner(fx)
  await o.update({ networkMode: true, tlsMode: 'own', caddyKey: 'a' })
  await o.caddyStatus({ state: 'failed' })
  fx.calls.length = 0
  const s = await o.retryCaddy()
  assert(s.state === 'lan-https' && fx.calls.join(' ') === 'bind(127.0.0.1) caddy+(serving=false)', `${s.state}: ${fx.calls.join(' ')}`)
})

await test('🔍 requireHttps: Caddy giving up changes nothing (no plaintext fallback)', async () => {
  const fx = fakeEffects(); const o = owner(fx)
  await o.update({ networkMode: true, tlsMode: 'own', caddyKey: 'a', requireHttps: true })
  fx.calls.length = 0
  const s = await o.caddyStatus({ state: 'failed' })
  assert(s.state === 'lan-https' && o.dataPlaneHost() === '127.0.0.1' && fx.calls.length === 0, `${s.state} ${fx.calls.join(' ')}`)
})

await test('🔍 a failure reported DURING caddy:start is not lost (judged inside the queue)', async () => {
  let o
  const fx = fakeEffects({ failOn: (name) => { if (name === 'caddy+') void o.caddyStatus({ state: 'failed', reason: 'not found' }); return false } })
  o = owner(fx)
  await o.update({ networkMode: true, tlsMode: 'own', caddyKey: 'a' })
  await o.update({})
  assert(o.status().state === 'lan-https-fallback', `state ${o.status().state}: the synchronous failure was dropped`)
})

await test('🔍 a failed step rolls back to the previous state, through local', async () => {
  const fx = fakeEffects({ failOn: (name) => name === 'caddy+' })
  const o = owner(fx)
  await o.update({ networkMode: true })
  fx.calls.length = 0
  const s = await o.update({ tlsMode: 'own', caddyKey: 'a' })
  assert(s.state === 'lan-http' && o.dataPlaneHost() === '0.0.0.0' && s.port80Proxy, JSON.stringify(s))
  assert(/caddy\+ failed/.test(s.lastError ?? ''), `lastError ${s.lastError}`)
  assert(fx.calls.join(' ') === 'port80- bind(127.0.0.1) fw(caddy) caddy+(serving=false) bind(0.0.0.0) port80+', fx.calls.join(' '))
})

await test('🔍 if the rollback fails too, it stays local (loopback only)', async () => {
  let breakIt = false
  const fx = fakeEffects({ failOn: (name, arg) => breakIt && (name === 'caddy+' || (name === 'bind' && arg === '0.0.0.0')) })
  const o = owner(fx)
  await o.update({ networkMode: true })           // lan-http, working
  breakIt = true                                  // now Caddy fails AND re-widening fails
  const s = await o.update({ tlsMode: 'own', caddyKey: 'a' })
  assert(s.state === 'local' && o.dataPlaneHost() === '127.0.0.1' && !s.port80Proxy && !s.caddy, JSON.stringify(s))
})

await test('🔍 stopping latches: a late input cannot restart anything', async () => {
  const fx = fakeEffects(); const o = owner(fx)
  await o.update({ networkMode: true, tlsMode: 'own', caddyKey: 'a' })
  fx.calls.length = 0
  const s = await o.update({ stopping: true })
  assert(s.state === 'stopping' && fx.calls.join(' ') === 'caddy-', fx.calls.join(' '))
  fx.calls.length = 0
  await o.update({ stopping: false, networkMode: true, tlsMode: 'off' })
  await o.retryCaddy()
  assert(fx.calls.length === 0 && o.status().state === 'stopping', `acted after stopping: ${fx.calls.join(' ')}`)
})

await test('🔍 updates are serialised: two at once never interleave their steps', async () => {
  const fx = fakeEffects({ delayMs: 15 }); const o = owner(fx)
  await Promise.all([o.update({ networkMode: true }), o.update({ tlsMode: 'own', caddyKey: 'a' })])
  const seq = fx.calls.join(' ')
  assert(seq === 'bind(0.0.0.0) port80+ fw(gateway) fw(mcp) fw(content) fw(port80) port80- bind(127.0.0.1) fw(caddy) caddy+(serving=false)', seq)
})

await test('HTTPS off clears the latch, so turning it back on tries Caddy again', async () => {
  const fx = fakeEffects(); const o = owner(fx)
  await o.update({ networkMode: true, tlsMode: 'own', caddyKey: 'a' })
  await o.caddyStatus({ state: 'failed' })
  await o.update({ tlsMode: 'off' })
  const s = await o.update({ tlsMode: 'own' })
  assert(s.state === 'lan-https', s.state)
})

// ---------------------------------------------------------------------------
// One owner: nothing else may rebind the data plane or start :80 / Caddy
// ---------------------------------------------------------------------------

console.log('\n-- one owner (source scan of daemon/) --')

await test('🔍 only lan.mjs rebinds the data plane or starts the port-80 proxy or Caddy', async () => {
  const daemonDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'daemon')
  const files = []
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.mjs')) files.push(p) } }
  walk(daemonDir)
  const OWNED = /\b(rebindGateway|rebindMcpServer|startPort80Proxy|createCaddySupervisor)\s*\(/
  const DEFINES = new Set(['tools-gateway.mjs', 'mcp-server.mjs', 'port80-proxy.mjs', 'caddy-server.mjs'])
  const offenders = []
  for (const f of files) {
    const base = path.basename(f)
    if (base === 'lan.mjs' || DEFINES.has(base)) continue
    const src = fs.readFileSync(f, 'utf8').replace(/^\s*(\/\/|\*).*$/gm, '')
    if (OWNED.test(src)) offenders.push(path.relative(daemonDir, f))
  }
  assert(offenders.length === 0, `these call what only the network-mode owner may: ${offenders.join(', ')}`)
  // And the launch no longer decides the bind host itself.
  const server = fs.readFileSync(path.join(daemonDir, 'ipc', 'server.mjs'), 'utf8').replace(/^\s*(\/\/|\*).*$/gm, '')
  assert(!/'0\.0\.0\.0'/.test(server), "ipc/server.mjs names '0.0.0.0' again: the bind host is the owner's decision")
  assert(/networkOwner\.dataPlaneHost\(\)/.test(server), 'ipc/server.mjs does not take the bind host from the owner')
  return `${files.length} files`
})

// ---------------------------------------------------------------------------
// Part 2 — real sockets, real Caddy
// ---------------------------------------------------------------------------

console.log('\n-- a full cycle on real sockets, with the real Caddy --')

const LAN = getPrimaryLanIp(os.networkInterfaces())
const BIN = stagedCaddyPath()
if (!fs.existsSync(BIN) && process.env.CI) {
  results.push({ name: 'staged Caddy', pass: false, detail: `missing ${BIN} under CI` })
}

async function freePort() {
  return new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
}

function reach(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port })
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => resolve(false))
    s.setTimeout(1500, () => { s.destroy(); resolve(false) })
  })
}

if (!LAN || !fs.existsSync(BIN)) {
  console.log(`  SKIPPED: ${!LAN ? 'no LAN address on this machine' : `no staged Caddy (${BIN})`}`)
} else {
  const gwPort = await freePort()
  const mcpPort = await freePort()
  const httpPort = await freePort()
  const httpsPort = await freePort()
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-owner-live-'))
  const mk = (port, name) => new Promise((r) => { const s = http.createServer((q, a) => a.end(name)); s.listen(port, '127.0.0.1', () => r(s)) })
  let gw = await mk(gwPort, 'gateway')
  let mcp = await mk(mcpPort, 'mcp')
  let o
  const sup = createCaddySupervisor({ configDir, resolveBinary: () => BIN, restartDelaysMs: [100, 100, 100, 100], onStateChange: (s) => { void o?.caddyStatus(s) } })
  const effects = {
    async bindDataPlane(host) { gw = await rebindHttpServer(gw, host); mcp = await rebindHttpServer(mcp, host) },
    async startPort80() {}, async stopPort80() {}, async ensureFirewall() {},
    async startCaddy({ serving }) {
      const config = buildCaddyConfig({
        hostname: 'owner-live.duckdns.org', dnsProvider: { name: 'duckdns', api_token: '{env.REDSTART_DNS_TOKEN}' },
        gatewayPort: gwPort, mcpPort, httpsServing: serving, requireHttps: false, httpsPort, httpPort,
        storageDir: path.join(configDir, 'caddy', 'storage'), acmeStaging: true,
      })
      config.apps.tls.automation.policies[0].issuers[0].ca = 'http://127.0.0.1:9/directory' // no network
      await sup.start({ config, secrets: { REDSTART_DNS_TOKEN: 'x-not-real', [PROXY_SECRET_ENV]: 'live-secret-0123' } })
      const deadline = Date.now() + 15000
      while (sup.status().state === 'starting' && !sup.status().reason && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    },
    async stopCaddy() { await sup.stop() },
  }
  o = createNetworkModeOwner({ effects, platform: 'linux', log: quiet })
  const ports = () => Promise.all([reach(LAN, gwPort), reach(LAN, mcpPort), reach(LAN, httpPort), reach(LAN, httpsPort)])
  const fmt = ([g, m, h, s]) => `LAN→gateway ${g}, mcp ${m}, :80 ${h}, :443 ${s}`
  let squatter = null
  try {
    await test('local: nothing reachable from the LAN', async () => {
      const r = await ports()
      assert(r.every((x) => !x), fmt(r))
    })

    await test('🔍 lan-https: the LAN reaches Caddy only; gateway and MCP are loopback', async () => {
      const s = await o.update({ networkMode: true, tlsMode: 'own', caddyKey: 'a', gatewayPort: gwPort })
      assert(s.state === 'lan-https' && sup.status().state === 'running', `${s.state} / caddy ${sup.status().state} ${sup.status().reason ?? ''}`)
      const [g, m, h, t] = await ports()
      assert(!g && !m, `the gateway or MCP server is reachable around Caddy: ${fmt([g, m, h, t])}`)
      assert(h && t, `Caddy is not reachable: ${fmt([g, m, h, t])}`)
      const body = await new Promise((r, j) => http.get({ host: LAN, port: httpPort, headers: { host: LAN } }, (res) => { let b = ''; res.on('data', (c) => { b += c }); res.on('end', () => r(b)) }).on('error', j))
      assert(body === 'gateway', `through Caddy :80 the LAN got ${JSON.stringify(body)}`)
    })

    await test('🔍 Caddy gives up (its port taken) → fallback: Caddy down, gateway + MCP on the LAN', async () => {
      // Take Caddy's HTTP port on IPv4 and restart it: it now fails to bind.
      await sup.stop()
      squatter = net.createServer(); await new Promise((r) => squatter.listen(httpPort, '0.0.0.0', r))
      // A fresh attempt that will fail (the latch is cleared by the new key).
      await o.update({ caddyKey: 'b' })
      const deadline = Date.now() + 60000
      while (o.status().state !== 'lan-https-fallback' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250))
      assert(o.status().state === 'lan-https-fallback', `state ${o.status().state}; caddy ${sup.status().state} ${sup.status().reason}`)
      const [g, m] = await ports()
      assert(g && m, `the household is locked out in fallback: gateway ${g}, mcp ${m}`)
      return sup.status().reason?.split(' (')[0]
    })

    await test('🔍 back to local: no listener left on the LAN, Caddy stopped', async () => {
      await new Promise((r) => squatter.close(r)); squatter = null
      const s = await o.update({ networkMode: false })
      assert(s.state === 'local' && sup.status().state === 'stopped', `${s.state} / ${sup.status().state}`)
      const r = await ports()
      assert(r.every((x) => !x), fmt(r))
      assert(await reach('127.0.0.1', gwPort), 'the gateway is gone from loopback too')
    })
  } finally {
    if (squatter) squatter.close()
    await sup.stop().catch(() => {})
    gw.close(); mcp.close()
    fs.rmSync(configDir, { recursive: true, force: true })
  }
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
