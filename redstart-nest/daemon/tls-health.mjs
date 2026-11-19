'use strict'

import * as https from 'node:https'
import * as dns from 'node:dns'

import { TLS_HEALTH_PATH } from './caddy-config.mjs'

// =============================================================================
// Redstart Nest — is HTTPS actually working? (TLS plan C5, review R1 + R2)
// =============================================================================
// ONE verdict controls behaviour: SERVING. It feeds the network-mode owner,
// whose Caddy config then redirects :80 to HTTPS (serving) or proxies plain
// HTTP (not). Every other check only INFORMS the panel, because a renewal
// warning or an unreachable 8.8.8.8 (common on managed networks) must never
// downgrade encryption that is working (review R1).
//
// Serving = over LOOPBACK with SNI (no DNS involved, so a resolver outage
// cannot flip it):
//   1. a certificate is presented for the name: SAN matches, not expired,
//      and trusted by Node's CA store, or issued by Let's Encrypt STAGING
//      when the admin chose staging;
//   2. Caddy's own /.well-known/redstart-tls-health answers 200 "ok" over
//      that connection. Caddy's, not the gateway's: "HTTPS works" must not
//      depend on whether a model is loaded.
//
// Diagnostics (warnings, each with one sentence for the panel):
//   renewal     certificate expires in < 14 days (renewal overdue)
//   public-dns  1.1.1.1 / 8.8.8.8 disagree with the LAN address
//               (unreachable resolvers are "couldn't check", not a failure)
//   local-dns   the system resolver does not return the LAN address while
//               public DNS does: router DNS-rebinding protection (D4)
//   name        https://<name> through the system resolver, what a phone does
//   chat        the gateway does not answer through Caddy (no model loaded)
//   mcp         the MCP server does not answer through Caddy (R2). An MCP
//               `initialize` needs a credential when login is on, and the
//               daemon holds none, so the check is that the MCP SERVER
//               answers (401 or a result), not Caddy's 502. Never a downgrade.
//
// Hysteresis (createHealthRunner): leaving serving takes 2 consecutive failed
// runs, the second 30 s after the first; returning takes 1 pass.
// =============================================================================

export const RENEWAL_WARN_DAYS = 14
const DAY = 86_400_000

/**
 * One HTTPS request to 127.0.0.1 with SNI = name. Never rejects.
 * @returns {Promise<{ ok: boolean, status?: number, body?: string, headers?: object, cert?: object, authorized?: boolean, error?: string }>}
 */
export function loopbackRequest({ name, port = 443, method = 'GET', path = '/', headers = {}, body = null, timeoutMs = 5000, request = https.request }) {
  return new Promise((resolve) => {
    let done = false
    const finish = (r) => { if (!done) { done = true; resolve(r) } }
    let req
    try {
      req = request({
        host: '127.0.0.1', port, method, path, servername: name,
        headers: { host: name, ...headers }, rejectUnauthorized: false, agent: false, timeout: timeoutMs,
      }, (res) => {
        const cert = res.socket.getPeerCertificate?.() ?? null
        const authorized = res.socket.authorized === true
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { if (text.length < 4096) text += c })
        res.on('end', () => finish({ ok: true, status: res.statusCode, body: text, headers: res.headers, cert, authorized }))
        res.on('error', (e) => finish({ ok: false, error: e.message }))
      })
    } catch (err) {
      return finish({ ok: false, error: err.message })
    }
    req.on('timeout', () => { req.destroy(new Error('timed out')) })
    req.on('error', (e) => finish({ ok: false, error: e.code ?? e.message }))
    if (body) req.write(body)
    req.end()
  })
}

const isStagingIssuer = (cert) => /STAGING/i.test(`${cert?.issuer?.CN ?? ''} ${cert?.issuer?.O ?? ''}`)

function sanIncludes(cert, name) {
  return String(cert?.subjectaltname ?? '').split(/,\s*/).some((e) => e.toLowerCase() === `dns:${name}`)
}

/**
 * The serving verdict.
 * @returns {Promise<{ serving: boolean, reason: string|null, cert: null | { validTo: string, daysLeft: number, issuer: string, staging: boolean } }>}
 */
export async function checkServing({ name, port = 443, allowStaging = false, now = Date.now, request }) {
  const r = await loopbackRequest({ name, port, path: TLS_HEALTH_PATH, request })
  if (!r.ok) return { serving: false, reason: 'HTTPS isn\'t answering yet', cert: null }
  const c = r.cert
  if (!c || !c.subject) return { serving: false, reason: 'No certificate yet', cert: null }
  const validTo = Date.parse(c.valid_to)
  const cert = {
    validTo: c.valid_to,
    daysLeft: Math.floor((validTo - now()) / DAY),
    issuer: [c.issuer?.O, c.issuer?.CN].filter(Boolean).join(' / '),
    staging: isStagingIssuer(c),
  }
  if (!sanIncludes(c, name)) return { serving: false, reason: `The certificate is not for ${name}`, cert }
  if (!(validTo > now())) return { serving: false, reason: 'The certificate has expired', cert }
  if (!r.authorized && !(allowStaging && cert.staging)) {
    return { serving: false, reason: 'The certificate is not from a trusted authority', cert }
  }
  if (r.status !== 200 || r.body !== 'ok') return { serving: false, reason: `HTTPS answered ${r.status}`, cert }
  return { serving: true, reason: null, cert }
}

/** @returns {Promise<{ answered: boolean, addresses: string[] }>} */
async function resolvePublic(name, { Resolver = dns.promises.Resolver, servers = ['1.1.1.1', '8.8.8.8'], timeoutMs = 3000 } = {}) {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 })
  resolver.setServers(servers)
  try {
    return { answered: true, addresses: await resolver.resolve4(name) }
  } catch (err) {
    // NXDOMAIN / NODATA is an ANSWER (the name has no A record); a timeout or
    // refusal is not (we could not ask).
    const answered = err?.code === 'ENOTFOUND' || err?.code === 'ENODATA'
    return { answered, addresses: [] }
  }
}

/**
 * Every check that informs but never decides.
 * @returns {Promise<Array<{ kind: string, text: string }>>}
 */
export async function diagnostics({
  name, lanIp, port = 443, cert, allowStaging = false,
  resolvePublicImpl = resolvePublic, lookup = dns.promises.lookup, request, fetchName,
}) {
  const w = []
  if (cert && cert.daysLeft < RENEWAL_WARN_DAYS) {
    w.push({ kind: 'renewal', text: `The certificate expires in ${Math.max(cert.daysLeft, 0)} days and has not renewed yet. HTTPS still works until then.` })
  }
  const pub = await resolvePublicImpl(name)
  if (!pub.answered) w.push({ kind: 'public-dns', text: "Couldn't check public DNS from this network." })
  else if (!pub.addresses.includes(lanIp)) {
    w.push({ kind: 'public-dns', text: pub.addresses.length ? `Public DNS points ${name} at ${pub.addresses[0]}, not this computer (${lanIp}). It updates within a few minutes.` : `${name} has no address in public DNS yet.` })
  }
  let local = []
  try { local = (await lookup(name, { family: 4, all: true })).map((a) => a.address) } catch { /* none */ }
  if (!local.includes(lanIp)) {
    if (pub.answered && pub.addresses.includes(lanIp)) {
      w.push({ kind: 'local-dns', text: `Your router is blocking this name. In its DNS settings, allow ${name.split('.').slice(-2).join('.')} (often called "DNS rebinding protection").` })
    } else {
      w.push({ kind: 'local-dns', text: `This computer can't look up ${name} yet.` })
    }
  } else if (fetchName) {
    const e2e = await fetchName({ name, port, allowStaging })
    if (!e2e.ok) w.push({ kind: 'name', text: `https://${name} doesn't load from this computer: ${e2e.error}` })
  }
  const chat = await loopbackRequest({ name, port, path: '/health', request })
  if (!chat.ok || chat.status === 502 || chat.status === 503) {
    w.push({ kind: 'chat', text: 'HTTPS works, but chat isn\'t running (no model is loaded).' })
  } else {
    const mcp = await loopbackRequest({
      name, port, method: 'POST', path: '/mcp', request,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'redstart-tls-health', version: '1' } } }),
    })
    const mcpAnswered = mcp.ok && (mcp.status === 401 || mcp.status === 200)
    if (!mcpAnswered) w.push({ kind: 'mcp', text: 'Chat works; tools are unavailable (the tool server isn\'t answering).' })
    else if (mcp.status === 200 && mcp.headers?.['mcp-session-id']) {
      void loopbackRequest({ name, port, method: 'DELETE', path: '/mcp', request, headers: { 'mcp-session-id': mcp.headers['mcp-session-id'] } })
    }
  }
  return w
}

/**
 * Runs checkServing (and diagnostics) on a schedule, with hysteresis, and
 * reports only TRANSITIONS of the serving verdict.
 *
 * @param {{ check: () => Promise<{ serving: boolean, reason: string|null }>, onServing: (v: boolean) => void,
 *           intervalMs?: number, retryMs?: number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} p
 */
export function createHealthRunner({ check, onServing, intervalMs = 5 * 60_000, retryMs = 30_000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let serving = false
  let failures = 0
  let timer = null
  let latest = null
  let stopped = true
  let inFlight = null

  function schedule(ms) {
    if (stopped) return
    if (timer) clearTimer(timer)
    timer = setTimer(() => { void run() }, ms)
  }

  async function run() {
    if (inFlight) return inFlight
    inFlight = (async () => {
      try {
        latest = await check()
      } catch (err) {
        latest = { serving: false, reason: err.message }
      }
      if (latest.serving) {
        failures = 0
        if (!serving) { serving = true; onServing(true) }
        schedule(intervalMs)
      } else {
        failures++
        if (serving && failures >= 2) { serving = false; onServing(false) }
        // Not serving (issuing, or the first failure while serving): look
        // again soon rather than in five minutes. Loopback requests are cheap.
        schedule(retryMs)
      }
      return latest
    })()
    try { return await inFlight } finally { inFlight = null }
  }

  return {
    start() { stopped = false; return run() },
    stop() { stopped = true; if (timer) clearTimer(timer); timer = null; failures = 0; if (serving) { serving = false } },
    runNow: run,
    serving: () => serving,
    latest: () => latest,
  }
}
