// Test doubles shared by the name service's suites: D1 over node:sqlite (with
// the real migrations) and a fake Cloudflare DNS API that records requests.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const here = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// D1 over node:sqlite (the subset D1 offers that the service uses)
// ---------------------------------------------------------------------------

export function d1() {
  const db = new DatabaseSync(':memory:')
  for (const f of fs.readdirSync(path.join(here, '..', 'migrations')).sort()) {
    db.exec(fs.readFileSync(path.join(here, '..', 'migrations', f), 'utf8'))
  }
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } } },
  })
  return { prepare: (sql) => stmt(sql), raw: db }
}

// ---------------------------------------------------------------------------
// A fake Cloudflare DNS API that records every request
// ---------------------------------------------------------------------------

export function fakeCloudflare({ failWith = null } = {}) {
  const records = new Map()
  const requests = []
  let seq = 0
  const ok = (result, extra = {}) => new Response(JSON.stringify({ success: true, result, ...extra }), { status: 200 })
  const impl = async (url, init = {}) => {
    const u = new URL(url)
    const body = init.body ? JSON.parse(init.body) : null
    requests.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, auth: init.headers?.Authorization })
    if (failWith) return new Response(JSON.stringify({ success: false, errors: [{ message: failWith }] }), { status: 400 })
    const m = /\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/.exec(u.pathname)
    if (!m) return new Response('{}', { status: 404 })
    const [, , rid] = m
    if (init.method === 'GET') {
      let list = [...records.values()]
      if (u.searchParams.get('name')) list = list.filter((r) => r.name === u.searchParams.get('name'))
      if (u.searchParams.get('type')) list = list.filter((r) => r.type === u.searchParams.get('type'))
      if (u.searchParams.get('name.endswith')) list = list.filter((r) => r.name.endsWith(u.searchParams.get('name.endswith')))
      if (u.searchParams.get('proxied')) list = list.filter((r) => String(!!r.proxied) === u.searchParams.get('proxied'))
      const per = Number(u.searchParams.get('per_page') ?? 100)
      return ok(list.slice(0, per), { result_info: { total_count: list.length } })
    }
    if (init.method === 'POST') { const r = { id: `r${++seq}`, ...body }; records.set(r.id, r); return ok(r) }
    if (init.method === 'PUT') { const r = { id: rid, ...body }; records.set(rid, r); return ok(r) }
    if (init.method === 'DELETE') { records.delete(rid); return ok({ id: rid }) }
    return new Response('{}', { status: 405 })
  }
  return { records, requests, impl, writes: () => requests.filter((r) => r.method !== 'GET') }
}

