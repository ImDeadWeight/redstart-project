// The Redstart name service: routes (TLS plan C12).
//
//   POST   /v1/register   none (rate-limited)  mint an id + credential (returned once)
//   PUT    /v1/ip         Bearer credential    publish the LAN address(es)
//   POST   /update        X-Api-User/-Key      acme-dns: set the challenge TXT
//   POST   /v1/heartbeat  Bearer credential    "still here" (weekly)
//   DELETE /v1/register   Bearer credential    remove every record, forget the install
//   GET    /health                             "ok"
//
// /update is exactly the acme-dns protocol Caddy's acmedns plugin speaks
// (libdns/acmedns v0.5.0: POST {server_url}/update, headers X-Api-User and
// X-Api-Key, body {"subdomain","txt"}, expects 200). The plugin never
// deletes, so the newest two TXT values are KEPT, as acme-dns does; a wildcard
// or a renewal overlapping an issuance needs two at once.
//
// Invariants (each a test): a credential touches only its own records
// (dns.js writable()); only private addresses (net.js); every record DNS-only;
// nothing is ever written outside <id>.nest. (its admin.<id>.nest. A/AAAA
// included: the admin panel's name, the same address as the device name).
//
// Pure apart from `db` (D1, or node:sqlite in the tests) and `dns`
// (dns.js, or a fake): createService takes both.

import { newId, newCredential, sha256Hex, sameHex, ID_RE } from './ids.js'
import { isPrivateIPv4, ulaIPv6 } from './net.js'
import { hostnameFor, adminHostnameFor, challengeNameFor, reconcile } from './dns.js'

export const REGISTER_LIMIT = 5
export const REGISTER_WINDOW_MS = 60 * 60 * 1000
export const UNSEEN_DAYS = 180
export const RECORD_ALERT = 700
const DAY = 86_400_000
/** An ACME DNS-01 value: base64url of a SHA-256, 43 characters. */
const ACME_TXT_RE = /^[A-Za-z0-9_-]{43}$/
const MAX_BODY = 4096

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
})
const err = (status, error, headers) => json(status, { error }, headers)

async function readJson(req) {
  const text = await req.text()
  if (text.length > MAX_BODY) return null
  try { return text ? JSON.parse(text) : {} } catch { return null }
}

/**
 * @param {{ db: any, dns: any, zone: string, serverUrl: string, now?: () => number, log?: (event: string, fields?: object) => void }} p
 */
export function createService({ db, dns, zone, serverUrl, now = Date.now, log = () => {} }) {
  /** The install a Bearer credential (or acme-dns key pair) belongs to, or null. */
  async function authenticate(id, credential) {
    if (!ID_RE.test(String(id ?? '')) || typeof credential !== 'string' || credential.length < 20 || credential.length > 100) return null
    const row = await db.prepare('SELECT * FROM installs WHERE id = ?').bind(id).first()
    if (!row) return null
    return sameHex(await sha256Hex(credential), row.credential_hash) ? row : null
  }

  /** Bearer "<id>.<credential>": one header carries both, so no lookup by hash is needed. */
  async function bearer(req) {
    const m = /^Bearer ([a-z0-9]+)\.([A-Za-z0-9_-]+)$/.exec(req.headers.get('Authorization') ?? '')
    return m ? authenticate(m[1], m[2]) : null
  }

  async function register(req) {
    const t = now()
    const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown'
    const bucket = (await sha256Hex(`register:${ip}`)).slice(0, 16)
    await db.prepare('DELETE FROM register_attempts WHERE at < ?').bind(t - REGISTER_WINDOW_MS).run()
    const recent = await db.prepare('SELECT COUNT(*) AS n FROM register_attempts WHERE bucket = ?').bind(bucket).first()
    if ((recent?.n ?? 0) >= REGISTER_LIMIT) {
      log('register_rate_limited')
      return err(429, 'Too many registrations from this network. Try again in an hour.', { 'Retry-After': '3600' })
    }
    await db.prepare('INSERT INTO register_attempts (bucket, at) VALUES (?, ?)').bind(bucket, t).run()

    const credential = newCredential()
    const hash = await sha256Hex(credential)
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = newId()
      const r = await db.prepare('INSERT OR IGNORE INTO installs (id, credential_hash, created_at, last_seen) VALUES (?, ?, ?, ?)')
        .bind(id, hash, t, t).run()
      if ((r.meta?.changes ?? 0) === 1) {
        log('registered', { id })
        return json(201, {
          id,
          credential,
          hostname: hostnameFor(id, zone),
          // What Nest gives Caddy's acmedns plugin (tls-names.mjs, step 8).
          acmedns: { username: id, subdomain: id, server_url: serverUrl },
        })
      }
    }
    return err(503, 'Could not allocate a name. Try again.')
  }

  async function setIp(req, install) {
    const body = await readJson(req)
    if (!body || typeof body !== 'object') return err(400, 'Expected a JSON body.')
    const ipv4 = body.ipv4 ?? null
    if (!isPrivateIPv4(ipv4)) return err(400, 'ipv4 must be a private address (10/8, 172.16/12, 192.168/16, 100.64/10).')
    let ipv6 = null
    if (body.ipv6 !== undefined && body.ipv6 !== null && body.ipv6 !== '') {
      ipv6 = ulaIPv6(body.ipv6)
      if (!ipv6) return err(400, 'ipv6 must be a unique-local address (fd00::/8). A global address is never published.')
    }
    const name = hostnameFor(install.id, zone)
    const adminName = adminHostnameFor(install.id, zone)
    // The device name and the admin panel's name always carry the same
    // address: one machine, two names, one wildcard certificate.
    for (const n of [name, adminName]) {
      await reconcile(dns, { id: install.id, name: n, type: 'A', contents: [ipv4] })
      await reconcile(dns, { id: install.id, name: n, type: 'AAAA', contents: ipv6 ? [ipv6] : [] })
    }
    await db.prepare('UPDATE installs SET ipv4 = ?, ipv6 = ?, last_seen = ? WHERE id = ?').bind(ipv4, ipv6, now(), install.id).run()
    return json(200, { hostname: name, adminHostname: adminName, ipv4, ipv6 })
  }

  async function acmeUpdate(req) {
    const install = await authenticate(req.headers.get('X-Api-User'), req.headers.get('X-Api-Key'))
    if (!install) return err(401, 'Unauthorized')
    const body = await readJson(req)
    if (!body || body.subdomain !== install.id) return err(400, 'subdomain must be this install\'s id.')
    const txt = body.txt
    if (typeof txt !== 'string' || !ACME_TXT_RE.test(txt)) return err(400, 'txt must be an ACME DNS-01 value.')
    const [txt1, txt2] = txt === install.txt1 ? [install.txt1, install.txt2] : [txt, install.txt1]
    await reconcile(dns, { id: install.id, name: challengeNameFor(install.id, zone), type: 'TXT', contents: [txt1, txt2] })
    await db.prepare('UPDATE installs SET txt1 = ?, txt2 = ?, last_seen = ? WHERE id = ?').bind(txt1, txt2 ?? null, now(), install.id).run()
    log('acme_txt_set', { id: install.id })
    // acme-dns answers with the value it stored.
    return json(200, { txt })
  }

  async function heartbeat(install) {
    await db.prepare('UPDATE installs SET last_seen = ? WHERE id = ?').bind(now(), install.id).run()
    return json(200, { ok: true })
  }

  /** Every record the install owns, then the install. Also housekeeping's. */
  async function forget(id) {
    for (const name of [hostnameFor(id, zone), adminHostnameFor(id, zone)]) {
      await reconcile(dns, { id, name, type: 'A', contents: [] })
      await reconcile(dns, { id, name, type: 'AAAA', contents: [] })
    }
    await reconcile(dns, { id, name: challengeNameFor(id, zone), type: 'TXT', contents: [] })
    await db.prepare('DELETE FROM installs WHERE id = ?').bind(id).run()
  }

  async function fetchHandler(req) {
    const url = new URL(req.url)
    const route = `${req.method} ${url.pathname}`
    try {
      if (route === 'GET /health') return new Response('ok', { headers: { 'Cache-Control': 'no-store' } })
      if (route === 'POST /v1/register') return await register(req)
      if (route === 'POST /update') return await acmeUpdate(req)
      if (route === 'PUT /v1/ip' || route === 'POST /v1/heartbeat' || route === 'DELETE /v1/register') {
        const install = await bearer(req)
        if (!install) return err(401, 'Unauthorized')
        if (route === 'PUT /v1/ip') return await setIp(req, install)
        if (route === 'POST /v1/heartbeat') return await heartbeat(install)
        await forget(install.id)
        log('unregistered', { id: install.id })
        return new Response(null, { status: 204 })
      }
      return err(404, 'Not found')
    } catch (e) {
      log('error', { route, message: e?.message })
      return err(502, 'The name service could not complete that. Try again shortly.')
    }
  }

  /**
   * The scheduled job: forget installs unseen for 180 days, flip any proxied
   * record under nest. back to DNS-only (and report it), and alert when the
   * zone nears Cloudflare Free's 1,000-record limit.
   */
  async function housekeeping() {
    const report = { forgotten: 0, unproxied: [], unproxyFailed: [], records: 0, alert: false }
    const stale = await db.prepare('SELECT id FROM installs WHERE last_seen < ?').bind(now() - UNSEEN_DAYS * DAY).all()
    for (const { id } of stale.results ?? []) {
      try { await forget(id); report.forgotten++ } catch (e) { log('forget_failed', { id, message: e.message }) }
    }
    for (const r of await dns.listProxiedUnderSubzone()) {
      try { await dns.unproxy(r); report.unproxied.push(r.name) } catch (e) { report.unproxyFailed.push(r.name); log('unproxy_failed', { name: r.name, message: e.message }) }
    }
    report.records = await dns.countAll()
    report.alert = report.records >= RECORD_ALERT
    if (report.unproxied.length || report.unproxyFailed.length) log('ALERT_proxied_records', { unproxied: report.unproxied, failed: report.unproxyFailed })
    if (report.alert) log('ALERT_record_count', { records: report.records, limit: 1000 })
    return report
  }

  return { fetch: fetchHandler, housekeeping }
}
