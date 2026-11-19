// =============================================================================
// Nest is never on the open internet (the 2026-11-19 exposure check)
// =============================================================================
// The user asked to be 100% sure HTTPS does not expose Nest to the internet.
// Checking found one real path: Caddy listened on IPv6 ([::]), the test
// machine has seven GLOBAL IPv6 addresses, and Windows' own "allow this app"
// prompt had added a rule for any remote address. Only the router's IPv6
// firewall stood in the way. This suite pins every guarantee that keeps Nest
// LAN-only, so none of them can quietly come back:
//
//   1. every listener in the daemon names its host: a bare listen(port) is
//      dual-stack in Node, i.e. every IPv6 address;
//   2. no listener binds an IPv6 wildcard;
//   3. Caddy listens on tcp4 only, in every mode;
//   4. the control plane refuses "::" and public addresses, at set time AND
//      at boot;
//   5. Nest's firewall rules admit the local subnet only;
//   6. nothing asks a router to forward a port (no UPnP / NAT-PMP code or
//      dependencies), so IPv4 stays behind the router's NAT;
//   7. HTTPS never needs an inbound connection from the internet: the HTTP
//      and TLS-ALPN challenges are off (DNS-01 only);
//   8. names point at private addresses only (the name service refuses
//      public ones: infra/name-service tests; tls-names refuses them before
//      sending).
// The live half (Caddy refusing this machine's real global IPv6 addresses)
// is in test-caddy-live.mjs.
//
// Run:  node scripts/test-lan-exposure.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCaddyConfig } from '../daemon/caddy-config.mjs'
import { bindHostRejection } from '../daemon/admin-listener.mjs'
import { isPrivateIPv4 } from '../daemon/tls-names.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const NEST = path.join(here, '..')
const REPO = path.join(NEST, '..')

const results = []
function test(name, fn) {
  try { const d = fn(); results.push({ pass: true }); console.log(`  ok  - ${name}${d ? `  (${d})` : ''}`) } catch (err) { results.push({ pass: false, name, detail: err.message }); console.log(`FAIL  - ${name}\n        ${err.message}`) }
}
function assert(c, m) { if (!c) throw new Error(m) }

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
function sources(dir, exts = ['.mjs', '.js', '.ts']) {
  const out = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'bundle' || e.name === 'target' || e.name === 'dist') continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (exts.includes(path.extname(e.name))) out.push(p)
    }
  }
  walk(dir)
  return out
}
const DAEMON = sources(path.join(NEST, 'daemon'))

console.log('\n-- listeners --')

test('🔍 every listen() in the daemon names a host (a bare listen(port) is dual-stack: every IPv6 address)', () => {
  const offenders = []
  let n = 0
  for (const f of DAEMON) {
    const src = stripComments(fs.readFileSync(f, 'utf8'))
    for (const m of src.matchAll(/\.listen\(([^)]*)/g)) {
      n++
      const args = m[1].split(',').map((a) => a.trim())
      const host = args[1] ?? ''
      // A literal host, or a variable that is the host (bindHost, host).
      const ok = /^'(127\.0\.0\.1|0\.0\.0\.0)'$/.test(host) || /^(bindHost|host)$/.test(host)
      if (!ok) offenders.push(`${path.relative(NEST, f)}: .listen(${m[1].slice(0, 40)})`)
    }
  }
  assert(n >= 6, `found only ${n} listen() calls: has the scan stopped matching?`)
  assert(offenders.length === 0, `listeners without an explicit IPv4/loopback host: ${offenders.join('; ')}`)
  return `${n} listeners`
})

test('🔍 no IPv6 wildcard bind anywhere in the daemon (\'::\' or [::] as a host)', () => {
  const hits = []
  for (const f of DAEMON) {
    const src = stripComments(fs.readFileSync(f, 'utf8'))
    if (/listen\([^)]*['"`](::|\[::\])['"`]/.test(src) || /tcp6\//.test(src)) hits.push(path.relative(NEST, f))
  }
  assert(hits.length === 0, `IPv6 wildcard in: ${hits.join(', ')}`)
})

test('🔍 Caddy listens on tcp4 only, in every mode, on both ports', () => {
  for (const httpsServing of [true, false]) for (const requireHttps of [true, false]) {
    const cfg = buildCaddyConfig({
      hostname: 'k7f3q2.nest.redstartdevelopment.com', dnsProvider: { name: 'duckdns', api_token: '{env.T}' },
      gatewayPort: 19080, mcpPort: 19082, httpsServing, requireHttps, storageDir: '/s',
    })
    for (const [name, s] of Object.entries(cfg.apps.http.servers)) {
      assert(s.listen.length > 0 && s.listen.every((a) => /^tcp4\/0\.0\.0\.0:\d+$/.test(a)), `${name}: ${s.listen}`)
    }
  }
})

console.log('\n-- the control plane --')

test('🔍 "::" and public addresses are refused for the admin listener', () => {
  for (const h of ['::', '2600:8800:4d06:7400::4e1a', '8.8.8.8']) assert(bindHostRejection(h) !== null, `${h} accepted`)
  assert(bindHostRejection('0.0.0.0') === null && bindHostRejection('192.168.0.213') === null, 'a LAN bind refused')
})

test('🔍 a stored adminBindHost is re-checked at boot and falls back to loopback', () => {
  const src = stripComments(fs.readFileSync(path.join(NEST, 'daemon', 'daemon.mjs'), 'utf8'))
  assert(/bindHostRejection\(bindHost\)[\s\S]{0,300}bindHost = DEFAULT_ADMIN_BIND_HOST/.test(src), 'boot binds a stored value without checking it')
})

test('🔍 with HTTPS on, the admin panel is never plain HTTP on the LAN (boot, the toggle, and every HTTPS change)', () => {
  const daemonSrc = stripComments(fs.readFileSync(path.join(NEST, 'daemon', 'daemon.mjs'), 'utf8'))
  assert(/bindHost = effectiveAdminBindHost\(bindHost, readTls\(settings\)\.mode\)/.test(daemonSrc), 'boot binds the configured admin address without the HTTPS rule')
  const adminSrc = stripComments(fs.readFileSync(path.join(NEST, 'daemon', 'ipc', 'admin.mjs'), 'utf8'))
  assert(/effectiveAdminBindHost\(bindHost, readTls\(before\)\.mode\)/.test(adminSrc) && /startAdminListener\(\{ bindHost: effective, port \}\)/.test(adminSrc), 'the toggle binds the configured address directly')
  const tlsSrc = stripComments(fs.readFileSync(path.join(NEST, 'daemon', 'ipc', 'tls.mjs'), 'utf8'))
  const i = tlsSrc.indexOf("if (v.next.mode !== 'off') await syncAdminBind")
  const j = tlsSrc.indexOf('await applyTlsSettings({ clearFailure: true })')
  const k = tlsSrc.indexOf("if (v.next.mode === 'off') await syncAdminBind")
  assert(i > 0 && j > i && k > j, 'tls:set must narrow the admin listener BEFORE Caddy starts, and widen it only AFTER Caddy stopped')
  const cfg = buildCaddyConfig({
    hostname: 'k7f3q2.nest.redstartdevelopment.com', dnsProvider: { name: 'duckdns', api_token: '{env.T}' },
    gatewayPort: 19080, mcpPort: 19082, httpsServing: false, requireHttps: false, storageDir: '/s', adminPort: 19083,
  })
  assert(cfg.apps.http.servers.admin.listen.every((a) => a.startsWith('tcp4/')), 'the :8443 admin server listens on IPv6')
})

console.log('\n-- the firewall and the router --')

test('🔍 Nest\'s firewall rules admit the local subnet only, and are named so the narrower rule is created', () => {
  const src = stripComments(fs.readFileSync(path.join(NEST, 'daemon', 'firewall.mjs'), 'utf8'))
  const add = /'add', 'rule',[\s\S]*?\(err\) =>/.exec(src)?.[0] ?? ''
  assert(/'remoteip=localsubnet'/.test(add), 'the netsh add rule arguments do not restrict remoteip')
  assert(/RULE_SUFFIX = ' \(LAN only\)'/.test(src) && (src.match(/\$\{RULE_SUFFIX\}/g) ?? []).length >= 2, 'a rule kept an old name')
})

test('🔍 nothing asks a router to forward a port (no UPnP / NAT-PMP / PCP code or dependencies)', () => {
  const PORTMAP = /\b(upnp|nat-?pmp|portmapper|port[-_ ]?mapping|nat-upnp|ssdp)\b/i
  const files = [...DAEMON, ...sources(path.join(NEST, 'src')), ...sources(path.join(REPO, 'shared')), ...sources(path.join(REPO, 'redstart-twig', 'desktop', 'daemon'))]
  const code = files.filter((f) => PORTMAP.test(stripComments(fs.readFileSync(f, 'utf8')))).map((f) => path.relative(REPO, f))
  assert(code.length === 0, `port-mapping code in: ${code.join(', ')}`)
  for (const pkg of [path.join(NEST, 'package.json'), path.join(REPO, 'redstart-twig', 'desktop', 'package.json')]) {
    const deps = Object.keys({ ...JSON.parse(fs.readFileSync(pkg, 'utf8')).dependencies })
    const bad = deps.filter((d) => PORTMAP.test(d))
    assert(bad.length === 0, `${path.relative(REPO, pkg)} depends on ${bad.join(', ')}`)
  }
  return `${files.length} files`
})

console.log('\n-- certificates and names --')

test('🔍 HTTPS needs no inbound connection from the internet: DNS-01 only', () => {
  const cfg = buildCaddyConfig({
    hostname: 'k7f3q2.nest.redstartdevelopment.com', dnsProvider: { name: 'duckdns', api_token: '{env.T}' },
    gatewayPort: 19080, mcpPort: 19082, httpsServing: true, requireHttps: false, storageDir: '/s',
  })
  const ch = cfg.apps.tls.automation.policies[0].issuers[0].challenges
  assert(ch.http.disabled === true && ch['tls-alpn'].disabled === true && ch.dns, JSON.stringify(ch))
})

test('🔍 certificate verification is never switched off (daemon and scripts)', () => {
  // CodeQL, 2026-11-19: tls-health.mjs used to switch it off and redo the
  // checks by hand. Staging certificates are now verified against Let's
  // Encrypt's staging roots instead (tls-health.mjs trustFor).
  const files = [...DAEMON, ...sources(path.join(NEST, 'scripts'))]
  const hits = files.filter((f) => /rejectUnauthorized:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/.test(stripComments(fs.readFileSync(f, 'utf8'))))
    .filter((f) => path.basename(f) !== 'test-lan-exposure.mjs')
  assert(hits.length === 0, `verification switched off in: ${hits.map((f) => path.relative(NEST, f)).join(', ')}`)
})

test('🔍 names only ever point at private addresses (Nest refuses before sending)', () => {
  for (const ip of ['8.8.8.8', '203.0.113.9', '2600::1']) assert(!isPrivateIPv4(ip), ip)
  assert(isPrivateIPv4('192.168.0.213'), 'LAN address refused')
})

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) { for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`); process.exit(1) }
