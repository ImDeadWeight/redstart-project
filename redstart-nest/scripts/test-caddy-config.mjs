// =============================================================================
// The bundled Caddy's configuration — security invariants (TLS plan C3)
// =============================================================================
// buildCaddyConfig() is pure, so every invariant the plan lists for it is an
// assertion over its output, for every combination of the two switches that
// change it (httpsServing, requireHttps):
//
//   - every upstream is loopback;
//   - every proxied request SETS the proxy-secret header from {env.*};
//   - the admin API is disabled and config is not persisted;
//   - no secret literal is ever accepted into the output;
//   - /mcp goes to the MCP server and nothing else does;
//   - :80 redirects exactly when httpsServing, and serves the refusal page
//     instead of proxying when requireHttps;
//   - only the hostname has a TLS connection policy (no other SNI answers),
//     plus admin.<hostname> when the admin panel has its own name;
//   - the admin name: loopback admin upstream on :443 by Host, a wildcard
//     certificate and never its own, and on :80 only a redirect or a refusal;
//   - DNS-01 only.
//
// Run:  node scripts/test-caddy-config.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { stagedCaddyPath } from './fetch-caddy.mjs'
import {
  buildCaddyConfig, checkDnsProvider, TLS_HEALTH_PATH, PROXY_HEADER, PROXY_SECRET_ENV, ACME_PRODUCTION, ACME_STAGING,
  adminHostnameFor,
  contentHostnameFor,
  CONTENT_HTTPS_PORT,
} from '../daemon/caddy-config.mjs'

const results = []

function test(name, fn) {
  try {
    const detail = fn()
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

function throws(fn, pattern, message) {
  try { fn() } catch (err) {
    assert(!pattern || pattern.test(err.message), `${message}: threw the wrong error: ${err.message}`)
    return
  }
  throw new Error(`${message}: did not throw`)
}

const BASE = Object.freeze({
  hostname: 'redstart-test.duckdns.org',
  dnsProvider: { name: 'duckdns', api_token: '{env.REDSTART_DNS_TOKEN}' },
  gatewayPort: 19080,
  mcpPort: 19082,
  httpsServing: true,
  requireHttps: false,
  storageDir: 'C:\\nest\\config\\caddy\\storage',
})

const COMBOS = [
  { httpsServing: true, requireHttps: false },
  { httpsServing: false, requireHttps: false },
  { httpsServing: true, requireHttps: true },
  { httpsServing: false, requireHttps: true },
]

const build = (over = {}) => buildCaddyConfig({ ...BASE, ...over })
const label = (c) => `serving=${c.httpsServing} require=${c.requireHttps}`

/** Every object in the tree that matches pred. */
function findAll(node, pred, out = []) {
  if (node && typeof node === 'object') {
    if (!Array.isArray(node) && pred(node)) out.push(node)
    for (const v of Object.values(node)) findAll(v, pred, out)
  }
  return out
}

/** :443's routes after Caddy's own health route. */
const proxiedRoutes = (cfg) => servers(cfg).https.routes[0].handle[0].routes.filter((r) => !r.match?.[0]?.path?.includes(TLS_HEALTH_PATH))
const proxies = (cfg) => findAll(cfg, (n) => n.handler === 'reverse_proxy')
const servers = (cfg) => cfg.apps.http.servers

console.log('\n-- upstreams and the proxy secret --')

test('🔍 every upstream is loopback, in every mode', () => {
  let n = 0
  for (const c of COMBOS) {
    for (const p of proxies(build(c))) {
      for (const u of p.upstreams) {
        assert(/^127\.0\.0\.1:\d+$/.test(u.dial), `${label(c)}: upstream ${u.dial} is not loopback`)
        n++
      }
    }
  }
  return `${n} upstreams`
})

test('🔍 every proxied request SETS the secret header from the environment', () => {
  for (const c of COMBOS) {
    for (const p of proxies(build(c))) {
      const set = p.headers?.request?.set?.[PROXY_HEADER]
      assert(Array.isArray(set) && set.length === 1 && set[0] === `{env.${PROXY_SECRET_ENV}}`,
        `${label(c)}: a reverse_proxy without ${PROXY_HEADER} = {env.${PROXY_SECRET_ENV}} — the gateway could not tell it from a direct LAN caller`)
      assert(!p.headers.request.add, 'add would keep a client-sent copy alongside ours')
    }
  }
})

test('🔍 no trusted_proxies: Caddy replaces client-sent X-Forwarded-* rather than appending to them', () => {
  for (const c of COMBOS) {
    const cfg = build(c)
    assert(findAll(cfg, (n) => 'trusted_proxies' in n).length === 0, `${label(c)}: trusted_proxies present`)
    for (const s of Object.values(servers(cfg))) assert(!s.trusted_proxies && !s.client_ip_headers, 'server trusts a client IP header')
  }
})

test('🔍 streaming is not buffered (flush_interval -1)', () => {
  for (const p of proxies(build())) assert(p.flush_interval === -1, `flush_interval ${p.flush_interval}`)
})

console.log('\n-- routes --')

test('🔍 /mcp and /mcp/* go to the MCP server; everything else to the gateway', () => {
  for (const c of COMBOS.filter((x) => !x.requireHttps || x.httpsServing)) {
    const cfg = build(c)
    const sub = proxiedRoutes(cfg)
    assert(JSON.stringify(sub[0].match) === JSON.stringify([{ path: ['/mcp', '/mcp/*'] }]), 'first route is not /mcp')
    assert(sub[0].handle[0].upstreams[0].dial === '127.0.0.1:19082', '/mcp not to the MCP port')
    assert(!sub[1].match && sub[1].handle[0].upstreams[0].dial === '127.0.0.1:19080', 'catch-all not to the gateway')
    const mcpDials = proxies(cfg).filter((p) => p.upstreams[0].dial.endsWith(':19082'))
    assert(mcpDials.length === (c.httpsServing ? 1 : 2), `${label(c)}: MCP upstream appears ${mcpDials.length} times`)
  }
})

test('🔍 :443 answers only for the hostname (SNI policy + host matcher + strict SNI)', () => {
  const https = servers(build()).https
  assert(JSON.stringify(https.tls_connection_policies) === JSON.stringify([{ match: { sni: [BASE.hostname] } }]),
    'a connection policy without an SNI match would complete a handshake for any name')
  assert(JSON.stringify(https.routes[0].match) === JSON.stringify([{ host: [BASE.hostname] }]), 'route not host-matched')
  assert(https.routes.length === 1, 'a second route on :443')
  assert(https.strict_sni_host === true, 'strict_sni_host off: Host could differ from SNI')
  assert(JSON.stringify(https.listen) === JSON.stringify(['tcp4/0.0.0.0:443']), `listen ${https.listen}`)
})

test('🔍 :80 redirects exactly when httpsServing', () => {
  for (const c of COMBOS) {
    const r = servers(build(c)).http.routes
    const redirects = findAll(r, (n) => n.handler === 'static_response' && n.status_code === 308)
    assert((redirects.length === 1) === c.httpsServing, `${label(c)}: ${redirects.length} redirects`)
    if (c.httpsServing) {
      assert(redirects[0].headers.Location[0] === `https://${BASE.hostname}{http.request.uri}`,
        `redirect target ${redirects[0].headers.Location[0]} — must be the hostname, never the Host header`)
      assert(proxies({ r }).length === 0, 'a redirecting :80 must not also proxy')
    }
  }
})

test('🔍 requireHttps: :80 refuses instead of proxying while HTTPS is not serving', () => {
  const r = servers(build({ httpsServing: false, requireHttps: true })).http.routes
  assert(proxies({ r }).length === 0, 'requireHttps still proxies plain HTTP')
  const page = findAll(r, (n) => n.handler === 'static_response')[0]
  assert(page?.status_code === 503 && /HTTPS isn't working/.test(page.body), 'no refusal page')
})

test('🔍 fallback (not serving, not required): :80 proxies the same routes', () => {
  const cfg = build({ httpsServing: false, requireHttps: false })
  const plain = servers(cfg).http.routes
  const sub = proxiedRoutes(cfg)
  assert(JSON.stringify(plain) === JSON.stringify(sub), ':80 fallback routes differ from :443')
})

test('🔍 Caddy answers its own health route on :443 only, before any proxy', () => {
  for (const c of COMBOS) {
    const cfg = build(c)
    const first = servers(cfg).https.routes[0].handle[0].routes[0]
    assert(JSON.stringify(first.match) === JSON.stringify([{ path: [TLS_HEALTH_PATH] }]), `${label(c)}: health route is not first`)
    assert(first.handle[0].handler === 'static_response' && first.handle[0].status_code === 200, 'not a static 200')
    assert(!JSON.stringify(servers(cfg).http).includes(TLS_HEALTH_PATH), ':80 answers the HTTPS health route: plain HTTP could then pass for HTTPS')
  }
})

test('🔍 the admin panel over HTTPS (:8443): only when asked, loopback upstream, the proxy secret, never on plain :80', () => {
  for (const c of COMBOS) {
    assert(!('admin' in servers(build(c))), `${label(c)}: an admin server without adminPort`)
    const s = servers(build({ ...c, adminPort: 19083 }))
    const admin = s.admin
    assert(admin, `${label(c)}: no admin server`)
    assert(JSON.stringify(admin.listen) === JSON.stringify(['tcp4/0.0.0.0:8443']), `listen ${admin.listen}`)
    assert(JSON.stringify(admin.tls_connection_policies) === JSON.stringify([{ match: { sni: [BASE.hostname] } }]) && admin.strict_sni_host === true, 'not SNI-bound to the name')
    const p = proxies({ admin })
    assert(p.length === 1 && p[0].upstreams[0].dial === '127.0.0.1:19083', `upstream ${JSON.stringify(p.map((x) => x.upstreams))}`)
    assert(p[0].headers.request.set[PROXY_HEADER][0] === `{env.${PROXY_SECRET_ENV}}`, 'admin requests carry no proxy secret')
    assert(!JSON.stringify(s.http).includes(':19083') && !JSON.stringify(s.https).includes(':19083'), `${label(c)}: the admin listener is reachable through :80 or :443`)
  }
})

const ADMIN_NAME = adminHostnameFor(BASE.hostname)
const withAdminName = (c = {}) => build({ ...c, adminPort: 19083, adminHostname: ADMIN_NAME })

test('🔍 the admin panel on its own name (admin.<hostname>): :443 by Host to the loopback admin listener, the proxy secret', () => {
  assert(ADMIN_NAME === `admin.${BASE.hostname}`, ADMIN_NAME)
  for (const c of COMBOS) {
    const s = servers(withAdminName(c))
    assert(JSON.stringify(s.https.tls_connection_policies) === JSON.stringify([{ match: { sni: [BASE.hostname, ADMIN_NAME] } }]), `${label(c)}: SNI ${JSON.stringify(s.https.tls_connection_policies)}`)
    assert(s.https.strict_sni_host === true, 'strict SNI off')
    const [first, second] = s.https.routes
    assert(JSON.stringify(first.match) === JSON.stringify([{ host: [ADMIN_NAME] }]) && first.terminal === true, `first route ${JSON.stringify(first.match)}`)
    assert(first.handle.length === 1 && first.handle[0].upstreams[0].dial === '127.0.0.1:19083', `admin upstream ${JSON.stringify(first.handle)}`)
    assert(first.handle[0].headers.request.set[PROXY_HEADER][0] === `{env.${PROXY_SECRET_ENV}}`, 'admin-name requests carry no proxy secret')
    assert(JSON.stringify(second.match) === JSON.stringify([{ host: [BASE.hostname] }]), 'the device name lost its route')
    assert(!JSON.stringify(second).includes(':19083'), 'the admin listener is reachable under the device name on :443')
    assert(s.admin && JSON.stringify(s.admin.listen) === JSON.stringify(['tcp4/0.0.0.0:8443']), ':8443 is gone (it stays, for bookmarks and own names)')
  }
})

test('🔍 the admin name rides on a wildcard certificate: *.<hostname> managed, admin.<hostname> never asked for itself', () => {
  // A certificate for admin.<hostname> itself would be challenged at
  // _acme-challenge.admin.<hostname>, which the name service never writes.
  const cfg = withAdminName()
  assert(JSON.stringify(cfg.apps.tls.certificates?.automate) === JSON.stringify([`*.${BASE.hostname}`]), JSON.stringify(cfg.apps.tls.certificates))
  assert(JSON.stringify(cfg.apps.tls.automation.policies[0].subjects) === JSON.stringify([BASE.hostname, `*.${BASE.hostname}`]), JSON.stringify(cfg.apps.tls.automation.policies[0].subjects))
  assert(JSON.stringify(servers(cfg).https.automatic_https.skip_certificates) === JSON.stringify([ADMIN_NAME]), JSON.stringify(servers(cfg).https.automatic_https))
  assert(servers(cfg).https.automatic_https.disable_redirects === true, 'redirects re-enabled')
  const dns = cfg.apps.tls.automation.policies[0].issuers[0].challenges
  assert(dns.http.disabled && dns['tls-alpn'].disabled && dns.dns, 'not DNS-01 only')
  // Without it, nothing changes.
  const plain = build({ adminPort: 19083 })
  assert(!plain.apps.tls.certificates && JSON.stringify(plain.apps.tls.automation.policies[0].subjects) === JSON.stringify([BASE.hostname]), 'a wildcard without the admin name')
  assert(!('skip_certificates' in servers(plain).https.automatic_https), 'skip_certificates without the admin name')
})

test('🔍 on :80 the admin name only redirects to HTTPS (serving) or is refused: never proxied in plain text', () => {
  for (const c of COMBOS) {
    const http = servers(withAdminName(c)).http
    const first = http.routes[0]
    assert(JSON.stringify(first.match) === JSON.stringify([{ host: [ADMIN_NAME] }]) && first.terminal === true, `${label(c)}: admin name is not matched first on :80`)
    const h = first.handle[0]
    assert(h.handler === 'static_response', `${label(c)}: admin name on :80 is ${h.handler}`)
    if (c.httpsServing) assert(h.status_code === 308 && h.headers.Location[0] === `https://${ADMIN_NAME}{http.request.uri}`, `${label(c)}: ${JSON.stringify(h)}`)
    else assert(h.status_code === 503, `${label(c)}: ${h.status_code}`)
    assert(!JSON.stringify(http).includes(':19083'), `${label(c)}: the admin listener is reachable over plain :80`)
  }
})

test('the admin name is refused without adminPort, or when it is not admin.<hostname>', () => {
  throws(() => build({ adminHostname: ADMIN_NAME }), /needs adminPort/, 'no adminPort')
  for (const bad of ['admin.example.com', `x.admin.${BASE.hostname}`, `chat.${BASE.hostname}`, BASE.hostname, '*.' + BASE.hostname]) {
    throws(() => build({ adminPort: 19083, adminHostname: bad }), /adminHostname must be/, bad)
  }
})

console.log('\n-- artifact content (artifacts plan D9) --')

const CONTENT_NAME = contentHostnameFor(BASE.hostname)
const withContent = (c = {}) => build({ ...c, contentPort: 19085 })
const withContentName = (c = {}) => build({ ...c, contentPort: 19085, contentHostname: CONTENT_NAME })

test('🔍 content over HTTPS (:8444): only when asked, the device name, loopback content listener only', () => {
  for (const c of COMBOS) {
    assert(!('content' in servers(build(c))), `${label(c)}: a content server without contentPort`)
    const s = servers(withContent(c))
    assert(s.content && JSON.stringify(s.content.listen) === JSON.stringify([`tcp4/0.0.0.0:${CONTENT_HTTPS_PORT}`]), `listen ${s.content?.listen}`)
    assert(JSON.stringify(s.content.tls_connection_policies) === JSON.stringify([{ match: { sni: [BASE.hostname] } }]) && s.content.strict_sni_host === true, 'not SNI-bound')
    const p = proxies({ content: s.content })
    assert(p.length === 1 && p[0].upstreams[0].dial === '127.0.0.1:19085', `upstream ${JSON.stringify(p.map((x) => x.upstreams))}`)
    for (const other of ['http', 'https']) assert(!JSON.stringify(s[other]).includes(':19085'), `${label(c)}: content reachable through ${other}`)
    assert(!JSON.stringify(s.content).includes(':19080') && !JSON.stringify(s.content).includes(':19082'), 'the gateway or MCP reachable on the content origin')
  }
})

test('🔍 content on its own name (art.<hostname>): :443 by Host, under the wildcard, never asked for itself', () => {
  assert(CONTENT_NAME === `art.${BASE.hostname}`, CONTENT_NAME)
  const cfg = withContentName()
  const s = servers(cfg)
  assert(JSON.stringify(s.https.tls_connection_policies) === JSON.stringify([{ match: { sni: [BASE.hostname, CONTENT_NAME] } }]), JSON.stringify(s.https.tls_connection_policies))
  const route = s.https.routes.find((r) => JSON.stringify(r.match) === JSON.stringify([{ host: [CONTENT_NAME] }]))
  assert(route && route.terminal && route.handle[0].upstreams[0].dial === '127.0.0.1:19085', JSON.stringify(route))
  const device = s.https.routes.find((r) => JSON.stringify(r.match) === JSON.stringify([{ host: [BASE.hostname] }]))
  assert(device && !JSON.stringify(device).includes(':19085'), 'content reachable under the device name on :443')
  assert(JSON.stringify(cfg.apps.tls.certificates?.automate) === JSON.stringify([`*.${BASE.hostname}`]), 'no wildcard')
  assert(JSON.stringify(s.https.automatic_https.skip_certificates) === JSON.stringify([CONTENT_NAME]), JSON.stringify(s.https.automatic_https))
  // With the admin name as well: one wildcard, both names skipped, both routed.
  const both = build({ adminPort: 19083, adminHostname: ADMIN_NAME, contentPort: 19085, contentHostname: CONTENT_NAME })
  assert(JSON.stringify(servers(both).https.automatic_https.skip_certificates) === JSON.stringify([ADMIN_NAME, CONTENT_NAME]), 'both names not skipped')
  assert(JSON.stringify(both.apps.tls.automation.policies[0].subjects) === JSON.stringify([BASE.hostname, `*.${BASE.hostname}`]), 'subjects')
})

test('🔍 on :80 the content name only redirects to HTTPS or is refused; artifact pages are never plain text through Caddy', () => {
  for (const c of COMBOS) {
    const http = servers(withContentName(c)).http
    const first = http.routes[0]
    assert(JSON.stringify(first.match) === JSON.stringify([{ host: [CONTENT_NAME] }]), `${label(c)}: content name not matched first`)
    const h = first.handle[0]
    if (c.httpsServing) assert(h.status_code === 308 && h.headers.Location[0] === `https://${CONTENT_NAME}{http.request.uri}`, JSON.stringify(h))
    else assert(h.status_code === 503, `${label(c)}: ${h.status_code}`)
    assert(!JSON.stringify(http).includes(':19085'), `${label(c)}: the content listener is reachable over plain :80`)
  }
})

test('the content name is refused without contentPort, or when it is not art.<hostname>', () => {
  throws(() => build({ contentHostname: CONTENT_NAME }), /needs contentPort/, 'no contentPort')
  for (const bad of ['art.example.com', `x.art.${BASE.hostname}`, ADMIN_NAME, BASE.hostname]) {
    throws(() => build({ contentPort: 19085, contentHostname: bad }), /contentHostname must be/, bad)
  }
})

test('Caddy adds no redirects of its own; :80 runs no automatic HTTPS', () => {
  const s = servers(build())
  assert(s.https.automatic_https?.disable_redirects === true, ':443 automatic redirects not disabled')
  assert(s.http.automatic_https?.disable === true, ':80 automatic HTTPS not disabled')
})

test('🔍 IPv4 only, bound explicitly: never IPv6 (global addresses face the internet), never one dual-stack socket', () => {
  // A bare ':80' on Windows loses IPv4 silently to whoever holds 0.0.0.0:80.
  for (const [name, s] of Object.entries(servers(build()))) {
    const p = name === 'https' ? 443 : 80
    assert(JSON.stringify(s.listen) === JSON.stringify([`tcp4/0.0.0.0:${p}`]), `${name}: listen ${s.listen}`)
    assert(s.listen.every((addr) => addr.startsWith('tcp4/') && !addr.includes('[')), `${name} listens on IPv6: ${s.listen}`)
  }
})

test('HTTP/3 is off (no UDP listener to firewall)', () => {
  for (const s of Object.values(servers(build()))) {
    assert(JSON.stringify(s.protocols) === JSON.stringify(['h1', 'h2']), `protocols ${s.protocols}`)
  }
})

console.log('\n-- admin, storage, certificates --')

test('🔍 the admin API is disabled and config is not persisted', () => {
  for (const c of COMBOS) {
    const cfg = build(c)
    assert(cfg.admin?.disabled === true, `${label(c)}: admin API enabled — an unauthenticated localhost:2019 config endpoint`)
    assert(cfg.admin.config?.persist === false, 'autosave on')
    assert(!('listen' in cfg.admin), 'admin listen set')
  }
})

test('storage is the directory given (config/caddy, excluded from backups by C2)', () => {
  const s = build().storage
  assert(s.module === 'file_system' && s.root === BASE.storageDir, JSON.stringify(s))
})

test('🔍 DNS-01 only, for the hostname only; production by default, staging on request', () => {
  const pol = build().apps.tls.automation.policies
  assert(pol.length === 1 && JSON.stringify(pol[0].subjects) === JSON.stringify([BASE.hostname]), 'subjects')
  const iss = pol[0].issuers
  assert(iss.length === 1 && iss[0].module === 'acme' && iss[0].ca === ACME_PRODUCTION, 'issuer')
  assert(iss[0].challenges.http.disabled === true && iss[0].challenges['tls-alpn'].disabled === true, 'HTTP / TLS-ALPN challenge enabled')
  assert(iss[0].challenges.dns.provider.name === 'duckdns', 'dns provider')
  assert(build({ acmeStaging: true }).apps.tls.automation.policies[0].issuers[0].ca === ACME_STAGING, 'staging not selected')
})

console.log('\n-- no secret in the output --')

test('🔍 a literal credential in the DNS provider block is refused', () => {
  throws(() => build({ dnsProvider: { name: 'duckdns', api_token: 'abcd-1234' } }), /placeholder/, 'literal api_token')
  throws(() => build({ dnsProvider: { name: 'desec', token: 'x{env.A}' } }), /placeholder/, 'placeholder with a prefix')
  throws(() => build({ dnsProvider: { name: 'acmedns', password: '{env.lower}' } }), /placeholder/, 'lower-case env name')
  throws(() => build({ dnsProvider: { name: 'acmedns', password: { env: 'X' } } }), /string/, 'non-string field')
  // Non-credential fields may be literals (the acmedns server URL, a username).
  const ok = build({ dnsProvider: { name: 'acmedns', username: 'k7f3q2', password: '{env.REDSTART_DNS_KEY}', server_url: 'https://ns.example' } })
  assert(ok.apps.tls.automation.policies[0].issuers[0].challenges.dns.provider.username === 'k7f3q2', 'username dropped')
})

test('🔍 the serialised config holds no value that is not a placeholder where a secret goes', () => {
  const text = JSON.stringify(build({ dnsProvider: { name: 'desec', token: '{env.REDSTART_DNS_TOKEN}' } }))
  for (const m of text.matchAll(/"(\w*(?:token|password|secret|key)\w*)":"([^"]*)"/gi)) {
    assert(/^\{env\.[A-Z0-9_]+\}$/.test(m[2]), `${m[1]} = ${m[2]}`)
  }
  assert(!/REDSTART_PROXY_SECRET"/.test(text.replace(/\{env\.REDSTART_PROXY_SECRET\}/g, '')), 'secret name outside a placeholder')
})

test('checkDnsProvider returns a copy, so a caller cannot mutate the config after the check', () => {
  const p = { name: 'duckdns', api_token: '{env.T}' }
  const out = checkDnsProvider(p)
  assert(out !== p && out.api_token === '{env.T}', 'same object returned')
})

console.log('\n-- input validation --')

test('rejects bad hostnames, ports and switches', () => {
  for (const h of ['', 'localhost', 'UPPER.duckdns.org', 'a..b', '-x.duckdns.org', 'x.duckdns.org.', '192.168.1.50 ', 'a b.c']) {
    throws(() => build({ hostname: h }), /hostname/, `hostname ${JSON.stringify(h)}`)
  }
  throws(() => build({ gatewayPort: 0 }), /port/, 'port 0')
  throws(() => build({ mcpPort: 70000 }), /port/, 'port 70000')
  throws(() => build({ httpsServing: 'yes' }), /boolean/, 'string switch')
  throws(() => build({ storageDir: '' }), /storageDir/, 'empty storage')
  throws(() => build({ dnsProvider: { name: '../x' } }), /module/, 'provider name')
})

console.log('\n-- the real binary accepts it --')

test('🔍 `caddy validate` accepts every mode (staged binary; required under CI)', () => {
  const bin = stagedCaddyPath()
  if (!fs.existsSync(bin)) {
    assert(!process.env.CI, `CI must stage Caddy first (node scripts/fetch-caddy.mjs); ${bin} is missing`)
    return 'SKIPPED locally: run node scripts/fetch-caddy.mjs'
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-caddy-validate-'))
  let n = 0
  try {
    for (const c of COMBOS) {
      for (const dnsProvider of [
        BASE.dnsProvider,
        { name: 'desec', token: '{env.REDSTART_DNS_TOKEN}' },
        { name: 'acmedns', username: 'k7f3q2', password: '{env.REDSTART_DNS_TOKEN}', subdomain: 'k7f3q2', server_url: 'https://ns.example.invalid' },
      ]) {
        const file = path.join(dir, 'caddy.json')
        // Automatic (acmedns) also with the admin panel on its own name.
        const variants = dnsProvider.name === 'acmedns'
          ? [{}, { adminPort: 19083, adminHostname: ADMIN_NAME }, { adminPort: 19083, adminHostname: ADMIN_NAME, contentPort: 19085, contentHostname: CONTENT_NAME }]
          : [{}, { contentPort: 19085 }]
        for (const v of variants) {
          fs.writeFileSync(file, JSON.stringify(build({ ...c, ...v, dnsProvider, acmeStaging: true, storageDir: path.join(dir, 'storage') })))
          try {
            execFileSync(bin, ['validate', '--config', file], {
              env: { ...process.env, REDSTART_DNS_TOKEN: 'placeholder', [PROXY_SECRET_ENV]: 'placeholder' },
              stdio: 'pipe',
            })
          } catch (err) {
            throw new Error(`${label(c)} ${dnsProvider.name}${v.adminHostname ? ' +admin name' : ''}${v.contentPort ? ' +content' : ''}: ${String(err.stderr || err.message).trim().split('\n').pop()}`)
          }
          n++
        }
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  return `${n} configs`
})

test('the output is plain JSON (round-trips unchanged)', () => {
  for (const c of COMBOS) {
    const cfg = build(c)
    assert(JSON.stringify(JSON.parse(JSON.stringify(cfg))) === JSON.stringify(cfg), label(c))
  }
})

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
