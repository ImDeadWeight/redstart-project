'use strict'

// =============================================================================
// Redstart Nest — where the HTTPS name comes from (TLS plan C4)
// =============================================================================
// One interface per provider:
//
//   hostname()               the name certificates are issued for
//   updateAddress(ip, opts)  point the name at the LAN address
//   egress()                 what this sends off the box (C10, /egress)
//
// The Caddy dns block lives in tls-settings.mjs (caddyDnsFor), beside the
// settings it is derived from.
//
// Product A ships two: DuckDNS and deSEC, both "my own name", the admin's
// account and token. "redstart" (Automatic, C12) is plan step 8.
//
// Only PRIVATE addresses are ever published: the LAN IPv4 from
// getPrimaryLanIp(), which already skips Hyper-V / WSL / VPN adapters, and
// never a global IPv6 (that is reachable from outside: a different threat
// model, D7). The token travels only to the provider's own HTTPS endpoint,
// and any error text is scrubbed of it before it is returned or logged.
// =============================================================================

const PRIVATE_V4 = [
  [0x0a000000, 0xff000000], // 10/8
  [0xac100000, 0xfff00000], // 172.16/12
  [0xc0a80000, 0xffff0000], // 192.168/16
  [0x64400000, 0xffc00000], // 100.64/10 (CGNAT, Tailscale)
]

export function isPrivateIPv4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip))
  if (!m) return false
  const parts = m.slice(1).map(Number)
  if (parts.some((p) => p > 255)) return false
  const n = ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
  return PRIVATE_V4.some(([net, mask]) => ((n & mask) >>> 0) === net)
}

const scrubbed = (text, token) => (token ? String(text).split(token).join('[redacted]') : String(text))

async function getText(url, { headers = {}, fetchImpl, timeoutMs }) {
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  return { status: res.status, body: (await res.text()).trim() }
}

/**
 * @param {{ provider: 'duckdns'|'desec', name: string }} p
 */
export function nameProvider({ provider, name }) {
  if (provider === 'duckdns') {
    const sub = name.replace(/\.duckdns\.org$/, '')
    return {
      kind: 'duckdns',
      hostname: () => name,
      egress: () => [
        { host: 'www.duckdns.org', purpose: 'Points your DuckDNS name at this computer\'s LAN address when it changes' },
        { host: 'acme-v02.api.letsencrypt.org', purpose: 'Issues and renews the HTTPS certificate (about every 60 days)' },
      ],
      /** DuckDNS answers "OK" or "KO" (bad token or name). The token can only go in the query string. */
      async updateAddress(ip, { token, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
        if (!isPrivateIPv4(ip)) return { ok: false, detail: `refusing to publish ${ip}: not a private address` }
        const url = `https://www.duckdns.org/update?domains=${encodeURIComponent(sub)}&token=${encodeURIComponent(token)}&ip=${encodeURIComponent(ip)}`
        try {
          const r = await getText(url, { fetchImpl, timeoutMs })
          if (r.status === 200 && r.body === 'OK') return { ok: true, detail: 'OK' }
          return { ok: false, detail: r.body === 'KO' ? 'DuckDNS refused the update: check the name and token' : `DuckDNS answered ${r.status}` }
        } catch (err) {
          return { ok: false, detail: scrubbed(`couldn't reach DuckDNS: ${err.message}`, token) }
        }
      },
    }
  }
  if (provider === 'desec') {
    return {
      kind: 'desec',
      hostname: () => name,
      egress: () => [
        { host: 'update.dedyn.io', purpose: 'Points your deSEC name at this computer\'s LAN address when it changes' },
        { host: 'desec.io', purpose: 'Sets the record that proves the name is yours, for the certificate' },
        { host: 'acme-v02.api.letsencrypt.org', purpose: 'Issues and renews the HTTPS certificate (about every 60 days)' },
      ],
      /** deSEC's dyndns endpoint: "good" or "nochg" on success; the token goes in a header. */
      async updateAddress(ip, { token, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
        if (!isPrivateIPv4(ip)) return { ok: false, detail: `refusing to publish ${ip}: not a private address` }
        const url = `https://update.dedyn.io/?hostname=${encodeURIComponent(name)}&myipv4=${encodeURIComponent(ip)}&myipv6=preserve`
        try {
          const r = await getText(url, { headers: { Authorization: `Token ${token}` }, fetchImpl, timeoutMs })
          if (r.status === 200 && /^(good|nochg)\b/.test(r.body)) return { ok: true, detail: r.body.split(/\s/)[0] }
          return { ok: false, detail: r.status === 401 ? 'deSEC refused the update: check the token' : `deSEC answered ${r.status}` }
        } catch (err) {
          return { ok: false, detail: scrubbed(`couldn't reach deSEC: ${err.message}`, token) }
        }
      },
    }
  }
  if (provider === 'redstart') {
    // name here is the registration (tls-settings.mjs readRedstart): { id, hostname }.
    return {
      kind: 'redstart',
      hostname: () => name,
      egress: () => [
        { host: new URL(nameServiceUrl()).host, purpose: "Redstart's name service: this computer's LAN address when it changes, a weekly \"still here\", and the record that proves the name for the certificate" },
        { host: 'acme-v02.api.letsencrypt.org', purpose: 'Issues and renews the HTTPS certificate (about every 60 days)' },
      ],
      async updateAddress(ip, { token, id, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
        if (!isPrivateIPv4(ip)) return { ok: false, detail: `refusing to publish ${ip}: not a private address` }
        try {
          const res = await fetchImpl(`${nameServiceUrl()}/v1/ip`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${id}.${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ipv4: ip }),
            signal: AbortSignal.timeout(timeoutMs),
          })
          if (res.status === 200) {
            // artifactsName: the service also publishes art.<id> (2026-11-25),
            // so Nest may serve artifacts there; an older service does not say so.
            let body = null
            try { body = await res.json() } catch { /* not JSON: an older service */ }
            const artifactsName = typeof body?.artifactsHostname === 'string' ? body.artifactsHostname : null
            return { ok: true, detail: 'published', artifactsName }
          }
          if (res.status === 401) return { ok: false, detail: 'the name service no longer knows this computer: switch HTTPS off and back to Automatic to get a new name' }
          return { ok: false, detail: `the name service answered ${res.status}` }
        } catch (err) {
          return { ok: false, detail: scrubbed(`couldn't reach the name service: ${err.message}`, token) }
        }
      },
    }
  }
  throw new Error(`unknown name provider ${provider}`)
}

// ---------------------------------------------------------------------------
// The Redstart name service (TLS plan C12 / step 8): register, heartbeat, release
// ---------------------------------------------------------------------------
// infra/name-service/ is the server half, live at names.redstartdevelopment.com.
// Every call here happens only while network mode is on and HTTPS is
// "Automatic" (lan.mjs): a loopback-only install never calls it (invariant 6).

export const NAME_SERVICE_URL = 'https://names.redstartdevelopment.com'
export const NAME_ZONE = 'redstartdevelopment.com'
const ID_RE = /^[abcdefghijkmnpqrstuvwxyz23456789]{6}$/
const CREDENTIAL_RE = /^[A-Za-z0-9_-]{40,100}$/

/** The service's base URL. REDSTART_NAME_SERVICE_URL is for tests and a staging copy only. */
export function nameServiceUrl() {
  const o = process.env.REDSTART_NAME_SERVICE_URL
  return typeof o === 'string' && /^https?:\/\/[^\s/]+$/.test(o) ? o : NAME_SERVICE_URL
}

/**
 * Register this install: a new random name and its credential.
 * The hostname is COMPUTED from the id, never taken from the answer, so a
 * misbehaving service cannot hand Nest a name outside nest.<zone>.
 * @returns {Promise<{ ok: true, id: string, hostname: string, credential: string } | { ok: false, error: string }>}
 */
export async function registerName({ fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  let res
  try {
    res = await fetchImpl(`${nameServiceUrl()}/v1/register`, { method: 'POST', signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    return { ok: false, error: `Couldn't reach the name service: ${err.message}` }
  }
  if (res.status === 429) return { ok: false, error: 'The name service is limiting registrations from this network. Try again in an hour.' }
  if (res.status !== 201) return { ok: false, error: `The name service answered ${res.status}.` }
  let body
  try { body = await res.json() } catch { return { ok: false, error: 'The name service sent an answer Nest does not understand.' } }
  if (!ID_RE.test(String(body?.id)) || !CREDENTIAL_RE.test(String(body?.credential))) {
    return { ok: false, error: 'The name service sent an answer Nest does not understand.' }
  }
  return { ok: true, id: body.id, hostname: `${body.id}.nest.${NAME_ZONE}`, credential: body.credential }
}

/** "Still here": keeps the name from being forgotten after 180 days unseen. */
export async function heartbeatName({ id, credential, fetchImpl = fetch, timeoutMs = 15000 }) {
  try {
    const res = await fetchImpl(`${nameServiceUrl()}/v1/heartbeat`, {
      method: 'POST', headers: { Authorization: `Bearer ${id}.${credential}` }, signal: AbortSignal.timeout(timeoutMs),
    })
    return { ok: res.status === 200, status: res.status }
  } catch (err) {
    return { ok: false, error: scrubbed(err.message, credential) }
  }
}

/** Give the name back: the service deletes every record it holds for it. */
export async function releaseName({ id, credential, fetchImpl = fetch, timeoutMs = 15000 }) {
  try {
    const res = await fetchImpl(`${nameServiceUrl()}/v1/register`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${id}.${credential}` }, signal: AbortSignal.timeout(timeoutMs),
    })
    // 401: already gone (forgotten, or released before). Nothing left to give back.
    return { ok: res.status === 204 || res.status === 401, status: res.status }
  } catch (err) {
    return { ok: false, error: scrubbed(err.message, credential) }
  }
}

/**
 * Keep the name pointed at the LAN address: once now, then every intervalMs,
 * calling update() only when the address CHANGED (or the last update failed).
 *
 * @param {{ getIp: () => string|null, update: (ip: string) => Promise<{ ok: boolean, detail: string }>,
 *           onResult?: (r: object) => void, intervalMs?: number, setTimer?: typeof setInterval, clearTimer?: typeof clearInterval }} p
 */
export function createAddressWatcher({ getIp, update, onResult = () => {}, intervalMs = 60_000, setTimer = setInterval, clearTimer = clearInterval }) {
  let published = null
  let timer = null
  let running = false

  async function tick() {
    if (running) return
    running = true
    try {
      const ip = getIp()
      if (!ip || ip === published) return
      const r = await update(ip)
      if (r.ok) published = ip
      onResult({ ip, ...r })
    } finally {
      running = false
    }
  }

  return {
    start() {
      if (timer) return tick()
      timer = setTimer(() => { void tick() }, intervalMs)
      return tick()
    },
    stop() {
      if (timer) clearTimer(timer)
      timer = null
      published = null
    },
    /** Force the next tick to publish (a name or token change). */
    reset() { published = null },
    tick,
    published: () => published,
  }
}
