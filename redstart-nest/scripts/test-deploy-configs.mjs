// =============================================================================
// Deployment configs — the properties deploy/ must keep, checked as text.
// =============================================================================
// Nothing in CI can run Caddy, HAProxy, WireGuard or Authelia, so this suite
// does not prove any of these files WORK. It proves something narrower and
// still worth having: that the properties the design rests on are present in
// the files, and that the files agree with each other and with the code.
//
//   deploy/Caddyfile               the LAN proxy: both planes, loopback upstreams
//   deploy/front-door/Caddyfile    the internet-facing proxy: chat UI only,
//                                  behind Authelia, on the tunnel address only
//   deploy/front-door/haproxy.cfg  the VPS relay: raw TCP, never decrypts
//   deploy/front-door/wireguard/   the tunnel: each end routes the other's
//                                  /32 and nothing more
//   deploy/front-door/authelia/    the portal: default deny, no inline secrets
//
// The sharp edge is the front door. One line — a reverse_proxy to the admin
// port, an `ssl` keyword on the VPS, an AllowedIPs of 0.0.0.0/0 — turns it from
// "the internet reaches a login portal" into "the internet reaches the control
// plane" or "the VPS reads everything", and each of those looks like an
// innocent edit in review.
//
// Ports come from ports.mjs rather than being restated, so a port change in
// the code fails here instead of leaving deploy/ pointing at the old one.
//
// Run:  node scripts/test-deploy-configs.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADMIN_PORT, DEFAULT_GATEWAY_PORT, serverPortFamily } from '../electron/main/ports.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const deployDir = path.join(here, '..', '..', 'deploy')
const frontDoor = path.join(deployDir, 'front-door')

const GATEWAY_PORT = DEFAULT_GATEWAY_PORT
const MCP_PORT = serverPortFamily(GATEWAY_PORT).find(p => p.what === 'the built-in MCP server').port

const results = []

function test(name, fn) {
  try {
    const detail = fn()
    results.push({ name, pass: true })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

function read(...parts) {
  return fs.readFileSync(path.join(...parts), 'utf8')
}

// ---------------------------------------------------------------------------
// Minimal parsers. Each file is checked with only as much structure as the
// assertions need; a full grammar would be a second implementation to trust.
// ---------------------------------------------------------------------------

/** Drops `#` comments — the commentary in these files names the very things the
 *  assertions forbid ("19083 does not appear here"), so only live config counts. */
function stripComments(text) {
  return text
    .split(/\r?\n/)
    .map(line => line.replace(/(^|\s)#.*$/, ''))
    .join('\n')
}

/** Top-level Caddyfile blocks: [{ address, body }]. The global options block
 *  has an empty address. Braces inside a body are matched, not counted flat. */
function caddyBlocks(text) {
  const src = stripComments(text)
  const blocks = []
  let i = 0
  while (i < src.length) {
    const open = src.indexOf('{', i)
    if (open === -1) break
    const address = src.slice(i, open).trim()
    let depth = 1
    let j = open + 1
    while (j < src.length && depth > 0) {
      if (src[j] === '{') depth++
      else if (src[j] === '}') depth--
      j++
    }
    blocks.push({ address, body: src.slice(open + 1, j - 1) })
    i = j
  }
  return blocks
}

/** `reverse_proxy <upstream>` targets in a Caddyfile body. */
function upstreams(body) {
  return [...body.matchAll(/reverse_proxy\s+(\S+)/g)].map(m => m[1])
}

/** The upstream inside `handle <matcher> { ... }`, or null. */
function handleUpstream(body, matcher) {
  const m = body.match(new RegExp(`handle\\s+${matcher.replace(/\//g, '\\/')}\\s*\\{([^}]*)\\}`))
  return m ? upstreams(m[1])[0] ?? null : null
}

/** WireGuard: { Interface: {...}, Peer: {...} } — one peer per file here. */
function wgConf(text) {
  const out = {}
  let section = null
  for (const line of stripComments(text).split('\n')) {
    const header = line.match(/^\s*\[(\w+)\]\s*$/)
    if (header) { section = header[1]; out[section] = {}; continue }
    const kv = line.match(/^\s*(\w+)\s*=\s*(.+?)\s*$/)
    if (kv && section) out[section][kv[1]] = kv[2]
  }
  return out
}

const isLoopback = upstream => /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(upstream)
const portOf = upstream => Number(upstream.split(':').pop())
const bareAddress = cidr => cidr.split('/')[0]

// ---------------------------------------------------------------------------

const lan = caddyBlocks(read(deployDir, 'Caddyfile'))
const front = caddyBlocks(read(frontDoor, 'Caddyfile'))
const frontSites = front.filter(b => b.address !== '')
const frontGlobal = front.find(b => b.address === '')
const haproxy = stripComments(read(frontDoor, 'haproxy.cfg'))
const wgHome = wgConf(read(frontDoor, 'wireguard', 'wg-home.conf'))
const wgVps = wgConf(read(frontDoor, 'wireguard', 'wg-vps.conf'))
const authelia = stripComments(read(frontDoor, 'authelia', 'configuration.yml'))
const autheliaUsers = stripComments(read(frontDoor, 'authelia', 'users_database.yml'))

const homeTunnel = bareAddress(wgHome.Interface?.Address ?? '')
const vpsTunnel = bareAddress(wgVps.Interface?.Address ?? '')

// ---------------------------------------------------------------------------
console.log('\n-- deploy/Caddyfile (the LAN proxy) --')

test('every upstream is on loopback — the proxy is the only thing on the network', () => {
  const all = lan.flatMap(b => upstreams(b.body))
  assert(all.length > 0, 'parsed no reverse_proxy lines — has the file format changed?')
  const wide = all.filter(u => !isLoopback(u))
  assert(wide.length === 0, `non-loopback upstreams: ${wide.join(', ')}`)
  return `${all.length} upstreams`
})

test('the two planes are separate sites, on the ports ports.mjs names', () => {
  const admin = lan.filter(b => upstreams(b.body).some(u => portOf(u) === ADMIN_PORT))
  const data = lan.filter(b => upstreams(b.body).some(u => portOf(u) === GATEWAY_PORT))
  assert(admin.length === 1, `expected one control-plane site (:${ADMIN_PORT}), found ${admin.length}`)
  assert(data.length === 1, `expected one data-plane site (:${GATEWAY_PORT}), found ${data.length}`)
  assert(admin[0] !== data[0], 'the control plane and the data plane share a site')
})

test('🔍 the data-plane site routes /mcp to the built-in MCP server (gateway + 2)', () => {
  // builtInMcpUrl() advertises <proxy origin>/mcp behind a proxy. Without this
  // route that URL 404s and the chat UI's built-in tools never connect.
  const data = lan.find(b => upstreams(b.body).some(u => portOf(u) === GATEWAY_PORT))
  const mcp = handleUpstream(data.body, '/mcp')
  assert(mcp, 'no `handle /mcp` block in the data-plane site')
  assert(portOf(mcp) === MCP_PORT, `/mcp goes to :${portOf(mcp)}, the MCP server is on :${MCP_PORT}`)
})

// ---------------------------------------------------------------------------
console.log('\n-- deploy/front-door/Caddyfile (internet-facing) --')

test('🔍 the control plane is not reachable through the front door at all', () => {
  const all = front.flatMap(b => upstreams(b.body))
  assert(!all.some(u => portOf(u) === ADMIN_PORT), `a site proxies the admin port :${ADMIN_PORT}`)
  const live = front.map(b => b.body).join('\n')
  assert(!live.includes(String(ADMIN_PORT)), `:${ADMIN_PORT} appears in live config`)
})

test('every upstream is on loopback', () => {
  const all = front.flatMap(b => upstreams(b.body))
  assert(all.length > 0, 'parsed no reverse_proxy lines — has the file format changed?')
  const wide = all.filter(u => !isLoopback(u))
  assert(wide.length === 0, `non-loopback upstreams: ${wide.join(', ')}`)
})

test('🔍 every site binds the home tunnel address only, the one wg-home.conf assigns', () => {
  // A site with no bind listens on every interface, the LAN included.
  assert(homeTunnel, 'wg-home.conf has no Interface Address')
  assert(frontSites.length >= 2, `expected the portal and the chat site, found ${frontSites.length}`)
  for (const site of frontSites) {
    const bind = site.body.match(/^\s*bind\s+(.+)$/m)
    assert(bind, `${site.address} has no bind directive`)
    assert(bind[1].trim() === homeTunnel, `${site.address} binds ${bind[1].trim()}, the tunnel is ${homeTunnel}`)
  }
  return homeTunnel
})

test('🔍 the PROXY protocol is accepted from the VPS tunnel address only', () => {
  assert(frontGlobal, 'no global options block')
  const pp = frontGlobal.body.match(/proxy_protocol\s*\{([^}]*)\}/)
  assert(pp, 'no proxy_protocol listener wrapper — every client would share one address')
  const allowed = [...pp[1].matchAll(/allow\s+(.+)$/gm)].flatMap(m => m[1].trim().split(/\s+/))
  assert(
    allowed.length === 1 && allowed[0] === `${vpsTunnel}/32`,
    `allow is ${JSON.stringify(allowed)}; it must be exactly ${vpsTunnel}/32 (wg-vps.conf)`
  )
})

test('HTTP/3 is not advertised — the relay forwards TCP only', () => {
  const protocols = frontGlobal?.body.match(/protocols\s+(.+)$/m)
  assert(protocols, 'no protocols line; Caddy enables h3 by default')
  assert(!/\bh3\b/.test(protocols[1]), `protocols: ${protocols[1].trim()}`)
})

test('🔍 every certificate comes over DNS-01, never tls internal or an HTTP challenge', () => {
  // The names point at the VPS, so an HTTP challenge is answerable BY the VPS.
  const live = front.map(b => b.body).join('\n')
  assert(!/tls\s+internal/.test(live), 'tls internal on an internet-facing site')
  for (const site of frontSites) {
    assert(/tls\s*\{[^}]*\bdns\s+\S+/.test(site.body), `${site.address} does not use a DNS challenge`)
  }
})

test('🔍 the chat site checks Authelia before anything reaches Nest', () => {
  const chat = frontSites.find(b => upstreams(b.body).some(u => portOf(u) === GATEWAY_PORT))
  assert(chat, `no site proxies the gateway :${GATEWAY_PORT}`)
  const auth = chat.body.indexOf('forward_auth')
  assert(auth !== -1, `${chat.address} has no forward_auth`)
  const firstProxy = chat.body.search(/reverse_proxy/)
  assert(auth < firstProxy, 'a reverse_proxy precedes forward_auth in the chat site')
  assert(!/basic_auth/.test(chat.body), 'basic_auth collides with the chat UI\'s own Bearer header')
  return chat.address
})

test('the chat site routes /mcp to the built-in MCP server (gateway + 2)', () => {
  const chat = frontSites.find(b => upstreams(b.body).some(u => portOf(u) === GATEWAY_PORT))
  const mcp = handleUpstream(chat.body, '/mcp')
  assert(mcp && portOf(mcp) === MCP_PORT, `/mcp goes to ${mcp}, the MCP server is on :${MCP_PORT}`)
})

// ---------------------------------------------------------------------------
console.log('\n-- deploy/front-door/haproxy.cfg (the VPS relay) --')

test('🔍 the VPS never terminates TLS — no ssl, crt or key anywhere', () => {
  const found = haproxy.match(/\b(ssl|crt|crt-list|ca-file|key)\b/)
  assert(!found, `"${found?.[1]}" in haproxy.cfg: the VPS would hold a key and could read everything`)
})

test('it relays raw TCP', () => {
  assert(/^\s*mode\s+tcp\s*$/m.test(haproxy), 'no `mode tcp`')
  assert(!/^\s*mode\s+http\b/m.test(haproxy), '`mode http` parses the traffic, which needs it decrypted')
})

test('🔍 it forwards to the home tunnel address on 443, with the PROXY protocol', () => {
  const servers = [...haproxy.matchAll(/^\s*server\s+\S+\s+(\S+)(.*)$/gm)]
  assert(servers.length === 1, `expected one server line, found ${servers.length}`)
  const [, target, options] = servers[0]
  assert(target === `${homeTunnel}:443`, `forwards to ${target}, home is ${homeTunnel}:443`)
  assert(/\bsend-proxy-v2\b/.test(options), 'no send-proxy-v2: Caddy and Authelia would see one client')
})

test('it listens on 443 and nothing else', () => {
  const binds = [...haproxy.matchAll(/^\s*bind\s+(\S+)/gm)].map(m => m[1])
  assert(binds.length === 1 && /:443$/.test(binds[0]), `binds: ${binds.join(', ')}`)
})

// ---------------------------------------------------------------------------
console.log('\n-- deploy/front-door/wireguard/ (the tunnel) --')

test('🔍 each end routes the other end\'s /32 and nothing more', () => {
  // 0.0.0.0/0 at home turns the front door into a VPN client that sends all of
  // the machine's traffic through the VPS. Anything wider than /32 at the VPS
  // makes the rest of the home network routable from it.
  assert(wgHome.Peer?.AllowedIPs === `${vpsTunnel}/32`, `home AllowedIPs: ${wgHome.Peer?.AllowedIPs}`)
  assert(wgVps.Peer?.AllowedIPs === `${homeTunnel}/32`, `VPS AllowedIPs: ${wgVps.Peer?.AllowedIPs}`)
})

test('home starts the tunnel and keeps it open; the VPS only listens', () => {
  assert(wgHome.Peer?.Endpoint, 'home has no Endpoint to connect out to')
  assert(Number(wgHome.Peer?.PersistentKeepalive) > 0, 'no PersistentKeepalive: an idle NAT mapping expires')
  assert(!wgVps.Peer?.Endpoint, 'the VPS has an Endpoint for home — that needs an open port at home')
  assert(wgVps.Interface?.ListenPort, 'the VPS has no ListenPort')
})

test('🔍 no real key material is committed anywhere in deploy/', () => {
  const placeholder = v => /^<[A-Z0-9_]+>$/.test(v ?? '')
  for (const [name, conf] of [['wg-home.conf', wgHome], ['wg-vps.conf', wgVps]]) {
    assert(placeholder(conf.Interface?.PrivateKey), `${name} PrivateKey is not a placeholder`)
    assert(placeholder(conf.Peer?.PublicKey), `${name} PublicKey is not a placeholder`)
  }
  // A WireGuard key is 32 bytes of base64: 43 characters and a trailing '='.
  const files = []
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else files.push(p)
    }
  }
  walk(deployDir)
  const leaked = files.filter(f => /(^|[^A-Za-z0-9+/])[A-Za-z0-9+/]{43}=/.test(fs.readFileSync(f, 'utf8')))
  assert(leaked.length === 0, `key-shaped strings in: ${leaked.map(f => path.relative(deployDir, f)).join(', ')}`)
  return `${files.length} files scanned`
})

// ---------------------------------------------------------------------------
console.log('\n-- deploy/front-door/authelia/ (the portal) --')

test('🔍 anything not named is refused (default_policy: deny)', () => {
  const m = authelia.match(/default_policy:\s*'?(\w+)'?/)
  assert(m?.[1] === 'deny', `default_policy is ${m?.[1]}`)
})

test('🔍 the chat site Caddy serves is the one Authelia guards, with two factors', () => {
  const chat = frontSites.find(b => upstreams(b.body).some(u => portOf(u) === GATEWAY_PORT))
  const rule = authelia.match(new RegExp(`domain:\\s*'?${chat.address.replace(/\./g, '\\.')}'?\\s*\\n\\s*policy:\\s*'?(\\w+)'?`))
  assert(rule, `no access_control rule for ${chat.address}`)
  assert(rule[1] === 'two_factor', `${chat.address} policy is ${rule[1]}`)
})

test('the portal Caddy serves is the one Authelia redirects to', () => {
  const portal = frontSites.find(b => upstreams(b.body).some(u => portOf(u) === 9091))
  assert(portal, 'no site proxies Authelia')
  const url = authelia.match(/authelia_url:\s*'?https:\/\/([^'\s/]+)/)
  assert(url?.[1] === portal.address, `authelia_url host ${url?.[1]}, Caddy serves ${portal.address}`)
})

test('Authelia listens on loopback, where Caddy\'s forward_auth points', () => {
  const addr = authelia.match(/address:\s*'?tcp:\/\/([^'/]+)\/?'?/)
  assert(addr && isLoopback(addr[1]), `Authelia server address: ${addr?.[1]}`)
  const chat = frontSites.find(b => /forward_auth/.test(b.body))
  const target = chat.body.match(/forward_auth\s+(\S+)/)[1]
  assert(target === addr[1], `forward_auth targets ${target}, Authelia is on ${addr[1]}`)
})

test('🔍 no secret is written inline — each comes from a _FILE variable', () => {
  // [ \t], not \s: `password:` with a nested block under it (the hashing
  // algorithm) is a key, not a value, and \s would read the next line as one.
  const inline = authelia.match(/^[ \t]*(jwt_secret|secret|encryption_key|password):[ \t]*\S+/m)
  assert(!inline, `inline ${inline?.[1]} in configuration.yml`)
  const hash = autheliaUsers.match(/password:\s*'?([^'\s]+)'?/)
  assert(/^<[A-Z0-9_]+>$/.test(hash?.[1] ?? ''), 'users_database.yml holds something other than a placeholder')
})

// ---------------------------------------------------------------------------

const failed = results.filter(r => !r.pass).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
