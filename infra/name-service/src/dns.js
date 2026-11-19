// The Cloudflare DNS API, behind one guard (TLS plan C12, invariants 7 + 10).
//
// Every write the service can make passes writable(): the name must be
// exactly <id>.nest.<zone> or _acme-challenge.<id>.nest.<zone> for the
// install that is asking, the type A, AAAA or TXT, and the record is always
// DNS-only (proxied: false, the grey cloud). A proxied record would route
// the household's traffic through Cloudflare and terminate TLS there, which
// is conversation data leaving the house: the exact thing this design
// exists to prevent. The body is built here, never taken from a caller, so
// nothing can ask for proxied: true.

import { ID_RE } from './ids.js'

export const SUBZONE = 'nest'
const TYPES = new Set(['A', 'AAAA', 'TXT'])
export const RECORD_TTL = 60
const COMMENT = 'redstart-name-service'

/** The device name for an id. */
export const hostnameFor = (id, zone) => `${id}.${SUBZONE}.${zone}`
export const challengeNameFor = (id, zone) => `_acme-challenge.${hostnameFor(id, zone)}`

/**
 * May the install `id` write a `type` record called `name`? Throws if not.
 * @returns {true}
 */
export function writable({ id, name, type, zone }) {
  if (!ID_RE.test(String(id))) throw new Error('refused: not an install id')
  if (!TYPES.has(type)) throw new Error(`refused: ${type} records are not written`)
  const own = hostnameFor(id, zone)
  const allowed = type === 'TXT' ? challengeNameFor(id, zone) : own
  if (name !== allowed) throw new Error(`refused: ${name} is not ${allowed}`)
  return true
}

/**
 * A client for one zone.
 * @param {{ token: string, zoneId: string, zone: string, fetch?: typeof fetch, base?: string }} p
 */
export function cloudflareDns({ token, zoneId, zone, fetch: fetchImpl = fetch, base = 'https://api.cloudflare.com/client/v4' }) {
  if (!token || !zoneId || !zone) throw new Error('cloudflareDns needs token, zoneId and zone')

  async function call(method, path, body) {
    const res = await fetchImpl(`${base}/zones/${encodeURIComponent(zoneId)}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    let json = null
    try { json = await res.json() } catch { /* not JSON */ }
    if (!res.ok || json?.success === false) {
      // Cloudflare's own error text; never the token, which is only in a header.
      const msg = json?.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`
      throw new Error(`Cloudflare DNS ${method} failed: ${msg}`)
    }
    return json
  }

  const bodyFor = ({ id, name, type, content }) => ({
    type, name, content, ttl: RECORD_TTL, proxied: false, comment: `${COMMENT} ${id}`,
  })

  return {
    zone,
    /** Records of one type at one exact name. */
    async list(name, type) {
      const q = new URLSearchParams({ name, type, per_page: '100' })
      return (await call('GET', `/dns_records?${q}`)).result ?? []
    },
    async create(rec) {
      writable({ ...rec, zone })
      return (await call('POST', '/dns_records', bodyFor(rec))).result
    },
    async update(recordId, rec) {
      writable({ ...rec, zone })
      return (await call('PUT', `/dns_records/${encodeURIComponent(recordId)}`, bodyFor(rec))).result
    },
    async remove(recordId, rec) {
      writable({ ...rec, zone })
      await call('DELETE', `/dns_records/${encodeURIComponent(recordId)}`)
    },
    /** Every record in the zone (the 1,000-record Free plan limit). */
    async countAll() {
      return (await call('GET', '/dns_records?per_page=1')).result_info?.total_count ?? 0
    },
    /** Records under nest. that are proxied: should be none, ever. */
    async listProxiedUnderSubzone() {
      const q = new URLSearchParams({ 'name.endswith': `.${SUBZONE}.${zone}`, proxied: 'true', per_page: '100' })
      return (await call('GET', `/dns_records?${q}`)).result ?? []
    },
    /** Housekeeping only: turn a proxied record back to DNS-only, keeping its content. */
    async unproxy(record) {
      const m = new RegExp(`^(?:_acme-challenge\\.)?([^.]+)\\.${SUBZONE}\\.`).exec(record.name)
      const id = m?.[1]
      return this.update(record.id, { id, name: record.name, type: record.type, content: record.content })
    },
  }
}

/**
 * Make the records of one type at one name exactly `contents` (create the
 * missing, delete the extra, update in place where it can).
 */
export async function reconcile(dns, { id, name, type, contents }) {
  const want = [...new Set(contents.filter(Boolean))]
  const have = await dns.list(name, type)
  const keep = new Set()
  for (const r of have) {
    if (want.includes(r.content) && !keep.has(r.content)) keep.add(r.content)
    else r._stale = true
  }
  const missing = want.filter((c) => !keep.has(c))
  for (const r of have.filter((x) => x._stale)) {
    const next = missing.shift()
    if (next !== undefined) await dns.update(r.id, { id, name, type, content: next })
    else await dns.remove(r.id, { id, name, type })
  }
  for (const c of missing) await dns.create({ id, name, type, content: c })
}
