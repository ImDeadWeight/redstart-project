// =============================================================================
// Artifact content origin, view tokens and routes (artifacts plan §8, §12)
// =============================================================================
// Artifact pages are model-written script. They must never run on the chat
// app's origin, where the login token is. Pinned here:
//
//   - the main gateway refuses /a/ outright (before the public-asset rule)
//   - a view token reaches only its artifact and revision; a forged, tampered
//     or expired one reaches nothing; a draft token only its holder's draft
//   - access is re-checked per request: revoking it stops an issued token
//   - every content response, errors and redirects included, carries the
//     sandbox CSP, no-referrer, nosniff, no-store, ACAO *, and
//     frame-ancestors = the asking page's origin or 'none'
//   - an origin that could smuggle a CSP directive never reaches the header
//   - the reporter is injected only when the token asks
//   - routes: unreadable → 404, readable but not editable → 403; the view
//     URL is on the content origin; source is text/plain, never HTML
//   - the content origin per LAN state (artifact-origin.mjs)
//
// Run:  node scripts/test-artifacts-content.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import { Readable } from 'node:stream'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-artifacts-content-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir
register('./auth-test-loader.mjs', import.meta.url)
await import('./electron-stub.mjs')

const auth = await import('../daemon/auth.mjs')
const accounts = await import('../daemon/accounts-storage.mjs')
const store = await import('../daemon/artifacts-storage.mjs')
const tokens = await import('../daemon/artifact-view-tokens.mjs')
const content = await import('../daemon/artifact-content.mjs')
const { contentOriginFor } = await import('../daemon/artifact-origin.mjs')
const { handleArtifactRoute, isArtifactRoute } = await import('../daemon/gateway/artifact-routes.mjs')
const { startGateway, stopGateway } = await import('../daemon/tools-gateway.mjs')
const { readZip } = await import('../daemon/zip.mjs')

const results = []
async function test(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}
function assert(cond, message) { if (!cond) throw new Error(message) }
const ok = (r) => { if (!r.ok) throw new Error(JSON.stringify(r)); return r }

auth.setAuthRequired(true)
auth.createOwner({ username: 'owner', password: 'owner-pass-1' })
const OWNER = accounts.listAccounts().find((a) => a.tier === 'owner')
const mk = (username) => accounts.findById(auth.createAccount(OWNER, { username, password: 'pass-1234', roleIds: ['full-access'] }).account.id)
const ALICE = mk('alice')
const BOB = mk('bob')
const EVE = mk('eve')

const PAGE = '<!doctype html><html><head><title>Mock</title><link rel="stylesheet" href="site.css"></head><body><h1>Hi</h1><script src="js/app.js"></script></body></html>'
const A = ok(store.createArtifact(ALICE, { title: 'Dashboard', files: [{ path: 'index.html', content: PAGE }, { path: 'site.css', content: 'h1{}' }, { path: 'js/app.js', content: 'console.log(1)' }] }, { sealNow: true })).artifact
const B = ok(store.createArtifact(ALICE, { title: 'Other', files: [{ path: 'index.html', content: '<p>other</p>' }] }, { sealNow: true })).artifact
ok(store.setArtifactAccess(ALICE, A.id, { members: [{ type: 'account', id: BOB.id, role: 'viewer' }] }))

// --- harness ---------------------------------------------------------------

function fakeRes() {
  return {
    status: 0, headers: {}, body: Buffer.alloc(0), headersSent: false,
    writeHead(s, h = {}) { this.status = s; this.headers = { ...this.headers, ...h }; this.headersSent = true; return this },
    setHeader(k, v) { this.headers[k] = v },
    end(b) { this.body = b === undefined ? Buffer.alloc(0) : Buffer.isBuffer(b) ? b : Buffer.from(String(b)) },
  }
}
function contentGet(url, { method = 'GET', now } = {}) {
  const res = fakeRes()
  content.handleContentRequest({ method, url }, res, now ? { now } : {})
  return res
}
async function route(method, urlPath, account, body, headers = { host: '127.0.0.1:19080' }) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [])
  req.method = method; req.headers = headers; req.url = urlPath
  const res = fakeRes()
  const handled = await handleArtifactRoute(req, res, urlPath.split('?')[0], account)
  const text = res.body.toString('utf8')
  let json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { handled, status: res.status, headers: res.headers, json, text, body: res.body }
}
const tokenFor = (over = {}) => tokens.issueViewToken({ artifactId: A.id, revision: 1, accountKey: ALICE.id, origin: 'http://127.0.0.1:19080', ...over }).token
const SECURITY_HEADERS = ['Content-Security-Policy', 'Referrer-Policy', 'X-Content-Type-Options', 'Cache-Control', 'Access-Control-Allow-Origin', 'Permissions-Policy']
function assertSecured(res, where) {
  for (const h of SECURITY_HEADERS) assert(res.headers[h], `${where}: no ${h}`)
  const csp = res.headers['Content-Security-Policy']
  assert(csp.startsWith('sandbox allow-scripts allow-forms allow-modals;'), `${where}: CSP does not start with the sandbox: ${csp}`)
  assert(!/allow-same-origin|allow-top-navigation|allow-popups/.test(csp), `${where}: CSP sandbox too loose`)
  assert(res.headers['Referrer-Policy'] === 'no-referrer' && res.headers['X-Content-Type-Options'] === 'nosniff', `${where}: referrer/nosniff`)
  assert(/no-store/.test(res.headers['Cache-Control']), `${where}: cacheable`)
  assert(!('Set-Cookie' in res.headers), `${where}: sets a cookie`)
}

console.log('\n-- view tokens --')

await test('a token serves its artifact\'s files at its revision, with the content type', async () => {
  const t = tokenFor()
  const html = contentGet(`/a/${t}/index.html`)
  assert(html.status === 200 && html.body.toString() === PAGE && /text\/html/.test(html.headers['Content-Type']), `${html.status} ${html.headers['Content-Type']}`)
  const js = contentGet(`/a/${t}/js/app.js`)
  assert(js.status === 200 && /javascript/.test(js.headers['Content-Type']), `js ${js.status}`)
  const root = contentGet(`/a/${t}/`)
  assert(root.status === 302 && root.headers.Location === `/a/${t}/index.html`, `root ${root.status} ${root.headers.Location}`)
  const head = contentGet(`/a/${t}/index.html`, { method: 'HEAD' })
  assert(head.status === 200 && head.body.length === 0, 'HEAD carries a body')
})

await test('🔍 a token reaches only its own artifact and revision', async () => {
  const t = tokenFor()
  assert(contentGet(`/a/${t}/../${B.id}/index.html`).status === 404, 'traversal to another artifact')
  assert(contentGet(`/a/${t}/%2e%2e/record.json`).status === 404, 'encoded traversal')
  assert(contentGet(`/a/${tokenFor({ revision: 2 })}/index.html`).status === 404, 'a revision past head')
  const other = tokenFor({ artifactId: B.id })
  assert(contentGet(`/a/${other}/index.html`).body.toString() === '<p>other</p>', 'B\'s token does not serve B')
})

await test('🔍 forged, tampered and expired tokens reach nothing', async () => {
  const t = tokenFor()
  const [body, sig] = t.split('.')
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString())
  const tampered = `${Buffer.from(JSON.stringify({ ...payload, a: B.id })).toString('base64url')}.${sig}`
  for (const [label, bad] of [['tampered', tampered], ['no signature', body], ['wrong signature', `${body}.${'A'.repeat(43)}`], ['garbage', 'x.y']]) {
    const r = contentGet(`/a/${bad}/index.html`)
    assert(r.status === 403 || r.status === 404, `${label}: ${r.status}`)
    assert(!r.body.toString().includes('other') && !r.body.toString().includes('Mock'), `${label} served content`)
  }
  const expired = tokens.issueViewToken({ artifactId: A.id, revision: 1, accountKey: ALICE.id, now: Date.now() - 2 * 3600 * 1000 }).token
  assert(contentGet(`/a/${expired}/index.html`).status === 403, 'expired token served')
  assert(tokens.verifyViewToken(t, { now: Date.now() + tokens.VIEW_TOKEN_TTL_S * 1000 + 1 }) === null, 'verify ignores expiry')
})

await test('🔍 access is re-checked per request: removing someone stops their issued token', async () => {
  const t = tokenFor({ accountKey: BOB.id })
  assert(contentGet(`/a/${t}/index.html`).status === 200, 'bob\'s token does not work')
  ok(store.setArtifactAccess(ALICE, A.id, { members: [] }))
  assert(contentGet(`/a/${t}/index.html`).status === 404, 'bob\'s token still works after he was removed')
  ok(store.setArtifactAccess(ALICE, A.id, { members: [{ type: 'account', id: BOB.id, role: 'viewer' }] }))
  const eve = tokenFor({ accountKey: EVE.id })
  assert(contentGet(`/a/${eve}/index.html`).status === 404, 'a token for someone with no access served')
})

await test('🔍 a draft token shows only its holder\'s draft', async () => {
  ok(store.writeArtifactFile(ALICE, A.id, 'index.html', '<p>draft</p>', { conversationId: 'c1' }))
  const mine = tokenFor({ revision: 'draft' })
  assert(contentGet(`/a/${mine}/index.html`).body.toString() === '<p>draft</p>', 'holder cannot see the draft')
  const bobs = tokenFor({ revision: 'draft', accountKey: BOB.id })
  assert(contentGet(`/a/${bobs}/index.html`).status === 404, 'another account saw the draft')
  assert(contentGet(`/a/${tokenFor()}/index.html`).body.toString() === PAGE, 'the revision changed under the draft')
  ok(store.sealArtifact(ALICE, A.id, { conversationId: 'c1' }))
})

console.log('\n-- headers --')

await test('🔍 every response carries the content headers: 200, 302, 403, 404, 405, 400', async () => {
  const t = tokenFor()
  const cases = [
    ['200', contentGet(`/a/${t}/index.html`)], ['302', contentGet(`/a/${t}/`)], ['403', contentGet('/a/x.y/index.html')],
    ['404 path', contentGet(`/a/${t}/missing.html`)], ['404 route', contentGet('/admin')], ['405', contentGet(`/a/${t}/index.html`, { method: 'POST' })],
    ['400', contentGet('/a/%E0%A4%A/index.html')],
  ]
  for (const [label, r] of cases) assertSecured(r, label)
  assert(cases[5][1].status === 405 && cases[6][1].status === 400, 'status codes')
  return `${cases.length} responses`
})

await test('🔍 frame-ancestors is the asking page\'s origin, or none; an origin with a directive in it never gets there', async () => {
  const framed = contentGet(`/a/${tokenFor()}/index.html`).headers['Content-Security-Policy']
  assert(/frame-ancestors http:\/\/127\.0\.0\.1:19080$/.test(framed), framed)
  const none = contentGet(`/a/${tokenFor({ origin: null })}/index.html`).headers['Content-Security-Policy']
  assert(/frame-ancestors 'none'$/.test(none), none)
  for (const bad of ["http://x; script-src *", 'http://a.com http://evil.com', "'self'", '*', 'javascript:alert(1)', 'http://x/path', 'https://x:99999999']) {
    assert(!tokens.isEmbedderOrigin(bad), `accepted ${bad}`)
    const csp = contentGet(`/a/${tokenFor({ origin: bad })}/index.html`).headers['Content-Security-Policy']
    assert(/frame-ancestors 'none'$/.test(csp), `${bad} → ${csp}`)
  }
  for (const good of ['https://abc123.nest.redstartdevelopment.com', 'http://192.168.0.5:19080', 'http://twig.localhost', 'twig://localhost', 'http://[::1]:19080']) {
    assert(tokens.isEmbedderOrigin(good), `refused ${good}`)
  }
})

await test('the reporter is injected first in <head> only when the token asks for it', async () => {
  const plain = contentGet(`/a/${tokenFor()}/index.html`).body.toString()
  assert(!plain.includes('redstart-artifact'), 'reporter without report=1')
  const checked = contentGet(`/a/${tokenFor({ report: true })}/index.html`).body.toString()
  assert(/^<!doctype html><html><head><script>\(function\(\)\{/.test(checked) && checked.includes('redstart-artifact'), checked.slice(0, 120))
  const css = contentGet(`/a/${tokenFor({ report: true })}/site.css`).body.toString()
  assert(css === 'h1{}', 'reporter injected into CSS')
})

console.log('\n-- the main origin --')

await test('🔍 the main gateway refuses /a/ before anything else can answer it', async () => {
  const port = 41000 + Math.floor(Math.random() * 2000)
  await startGateway(port, { tools: {} })
  try {
    for (const p of [`/a/${tokenFor()}/index.html`, '/a/', '/a']) {
      const r = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: p }, (res) => { let b = ''; res.on('data', (c) => { b += c }); res.on('end', () => resolve({ status: res.statusCode, body: b })) }).on('error', reject)
      })
      assert(r.status === 404 && !r.body.includes('Mock'), `${p}: ${r.status} ${r.body.slice(0, 80)}`)
    }
  } finally { stopGateway() }
})

console.log('\n-- routes --')

await test('routes are recognised; an unreadable id is 404 everywhere, a view-only write is 403', async () => {
  for (const p of ['/artifacts', `/artifacts/${A.id}`, `/artifacts/${A.id}/view`, `/artifacts/${A.id}/revisions/1/restore`, `/artifacts/${A.id}/source/index.html`, `/artifacts/${A.id}/export.zip`]) assert(isArtifactRoute(p), p)
  assert(!isArtifactRoute('/artifacts/not-a-uuid') && !isArtifactRoute('/artifactsx'), 'loose route match')
  for (const [m, p, body] of [['GET', `/artifacts/${A.id}`], ['POST', `/artifacts/${A.id}/view`, {}], ['GET', `/artifacts/${A.id}/revisions`], ['PATCH', `/artifacts/${A.id}`, { title: 'x' }], ['PUT', `/artifacts/${A.id}/access`, { members: [] }], ['DELETE', `/artifacts/${A.id}`], ['GET', `/artifacts/${A.id}/export.zip`], ['GET', `/artifacts/${A.id}/source/index.html`]]) {
    const r = await route(m, p, EVE, body)
    assert(r.status === 404, `${m} ${p} for an outsider: ${r.status}`)
  }
  for (const [m, p, body] of [['PATCH', `/artifacts/${A.id}`, { title: 'x' }], ['PUT', `/artifacts/${A.id}/access`, { members: [] }], ['DELETE', `/artifacts/${A.id}`], ['POST', `/artifacts/${A.id}/transfer`, { accountId: BOB.id }], ['POST', `/artifacts/${A.id}/revisions/1/restore`]]) {
    const r = await route(m, p, BOB, body)
    assert(r.status === 403, `${m} ${p} for a viewer: ${r.status}`)
  }
})

await test('view: a URL on the content origin with a token, framed by the asking page', async () => {
  const r = await route('POST', `/artifacts/${A.id}/view`, BOB, {}, { host: '192.168.0.5:19080', origin: 'http://192.168.0.5:19080' })
  assert(r.status === 200, JSON.stringify(r.json))
  const u = new URL(r.json.url)
  assert(u.origin === 'http://192.168.0.5:19085' && /^\/a\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\/index\.html$/.test(u.pathname), r.json.url)
  const served = contentGet(u.pathname)
  assert(served.status === 200 && /frame-ancestors http:\/\/192\.168\.0\.5:19080$/.test(served.headers['Content-Security-Policy']), 'the URL does not serve, or is not framed by the asker')
  assert(r.json.revision === store.getArtifact(BOB, A.id).head && r.json.expiresAt > Date.now(), JSON.stringify(r.json))
  const empty = ok(store.createArtifact(ALICE, { title: 'Empty' })).artifact
  assert((await route('POST', `/artifacts/${empty.id}/view`, ALICE, {})).status === 404, 'an empty artifact has a view')
})

await test('source is text/plain and nosniff, never HTML on the main origin; export.zip holds the files', async () => {
  const r = await route('GET', `/artifacts/${A.id}/source/index.html`, BOB)
  assert(r.status === 200 && r.headers['Content-Type'] === 'text/plain; charset=utf-8' && r.headers['X-Content-Type-Options'] === 'nosniff', JSON.stringify(r.headers))
  assert(/sandbox/.test(r.headers['Content-Security-Policy']), 'source has no sandbox CSP')
  const z = await route('GET', `/artifacts/${A.id}/export.zip`, BOB)
  assert(z.status === 200 && z.headers['Content-Type'] === 'application/zip', `${z.status}`)
  const unzipped = readZip(z.body, { maxEntries: 300, maxEntryBytes: 1e7, maxTotalBytes: 2e7 })
  assert(unzipped.ok, JSON.stringify(unzipped))
  const names = Object.keys(unzipped.files).sort()
  assert(JSON.stringify(names) === JSON.stringify(['index.html', 'js/app.js', 'site.css']), JSON.stringify(names))
  assert(unzipped.files['index.html'].equals(ok(store.readArtifactFile(BOB, A.id, 'index.html')).data), 'zip content differs from head')
})

await test('list, get, rename, share, restore, seal through the routes; page links are Nest\'s', async () => {
  const list = await route('GET', '/artifacts?scope=shared', BOB)
  assert(list.json.artifacts.some((a) => a.id === A.id && a.role === 'viewer' && a.ownerName === 'alice'), JSON.stringify(list.json))
  const got = await route('GET', `/artifacts/${A.id}`, ALICE, null, { host: 'nest.local:19080', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'abc.nest.redstartdevelopment.com' })
  assert(got.json.url === `https://abc.nest.redstartdevelopment.com/#/artifacts/${A.id}` && got.json.files.length === 3 && got.json.entry === 'index.html', JSON.stringify(got.json))
  assert((await route('PATCH', `/artifacts/${A.id}`, ALICE, { title: 'Dash 2' })).json.title === 'Dash 2', 'rename')
  const restored = await route('POST', `/artifacts/${A.id}/revisions/1/restore`, ALICE)
  assert(restored.status === 200 && restored.json.revision === 3, JSON.stringify(restored.json))
  const revs = await route('GET', `/artifacts/${A.id}/revisions`, BOB)
  assert(revs.json.revisions[0].restoredFrom === 1 && revs.json.revisions[0].byName === 'alice', JSON.stringify(revs.json))
  ok(store.writeArtifactFile(ALICE, A.id, 'site.css', 'h1{color:red}', { conversationId: 'c9' }))
  const other = await route('POST', `/artifacts/${A.id}/seal`, ALICE, { conversationId: 'c8' })
  assert(other.json.sealed === false, 'sealed another chat\'s draft')
  const sealed = await route('POST', `/artifacts/${A.id}/seal`, ALICE, { conversationId: 'c9' })
  assert(sealed.json.sealed === true && sealed.json.revision === 4, JSON.stringify(sealed.json))
  const made = await route('POST', '/artifacts', ALICE, { title: 'From the UI', files: [{ path: 'index.html', content: '<p>x</p>' }] })
  assert(made.status === 201 && made.json.head === 1, JSON.stringify(made.json))
})

console.log('\n-- the content origin per LAN state --')

await test('direct: the Host the app used, on the content port, in every state', async () => {
  const t = { state: 'local', hostname: null, automatic: false, serving: false, contentNamePublished: false }
  assert(contentOriginFor({ host: '127.0.0.1:19080' }, t, 19085).origin === 'http://127.0.0.1:19085', 'local')
  assert(contentOriginFor({ host: '192.168.0.5' }, { ...t, state: 'lan-http' }, 19085).origin === 'http://192.168.0.5:19085', 'port-80 proxy')
  assert(contentOriginFor({ host: '[::1]:19080' }, t, 19085).origin === 'http://[::1]:19085', 'ipv6 literal')
  assert(contentOriginFor({ host: 'evil.com/x' }, t, 19085).origin === 'http://127.0.0.1:19085', 'a bad Host header became a URL')
})

await test('through Nest\'s Caddy: art.<name> once published, else <name>:8444; plain HTTP before HTTPS works, none', async () => {
  const t = { state: 'lan-https', hostname: 'abc.nest.redstartdevelopment.com', automatic: true, serving: true, contentNamePublished: true }
  const via = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'abc.nest.redstartdevelopment.com', host: 'abc.nest.redstartdevelopment.com' }
  assert(contentOriginFor(via, t, 19085).origin === 'https://art.abc.nest.redstartdevelopment.com', 'published art name')
  assert(contentOriginFor(via, { ...t, contentNamePublished: false }, 19085).origin === 'https://abc.nest.redstartdevelopment.com:8444', 'unpublished art name')
  assert(contentOriginFor({ ...via }, { ...t, automatic: false, hostname: 'me.duckdns.org' }, 19085).origin === null, 'another name through HTTPS')
  const own = { ...t, automatic: false, hostname: 'me.duckdns.org' }
  assert(contentOriginFor({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'me.duckdns.org' }, own, 19085).origin === 'https://me.duckdns.org:8444', 'own name')
  const plain = contentOriginFor({ 'x-forwarded-proto': 'http', host: '192.168.0.5' }, { ...t, serving: false }, 19085)
  assert(plain.origin === null && /HTTPS is working/.test(plain.reason), JSON.stringify(plain))
})

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
fs.rmSync(tmpDir, { recursive: true, force: true })
if (failed.length) process.exit(1)
