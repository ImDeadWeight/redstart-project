// =============================================================================
// The tls settings and the tls:* control-plane methods (TLS plan C9)
// =============================================================================
//   - validation: modes, providers, names, tokens, booleans; Automatic refused
//   - the token is encrypted at rest, never returned, kept when a save omits
//     it, and dropped when the provider changes
//   - the re-key tool finds tls.own.tokenEnc (the Phase 8B lesson: a secret
//     the walk cannot see is silently lost on a re-key)
//   - 80/443 are reserved for Caddy while HTTPS is on
//   - tlsRuntime / caddyKeyOf: what Caddy gets, and when it restarts
//   - tls:set end to end through the real handler, with the owner wired
//
// Run:  node scripts/test-tls-settings.mjs
// =============================================================================

import { registerElectronStub } from './electron-stub-hooks.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-tls-settings-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmp
registerElectronStub()
await import('./electron-stub.mjs')

const {
  validateTlsPatch, applyTlsPatch, readTls, tlsRuntime, caddyKeyOf, caddyDnsFor, normaliseName,
} = await import('../daemon/tls-settings.mjs')
const { serverPortRejection } = await import('../daemon/ipc/validate.mjs')
const { initSecrets, encryptSecret, decryptSecret } = await import('../daemon/secrets.mjs')
const { keyfileProvider } = await import('../daemon/secrets-keyfile.mjs')
const { findSecrets } = await import('../daemon/secrets-migration.mjs')
const { checkDnsProvider } = await import('../daemon/caddy-config.mjs')

initSecrets(keyfileProvider(tmp))

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
function assert(cond, message) { if (!cond) throw new Error(message) }

const TOKEN = 'c0ffee00-1111-2222-3333-444455556666'
const own = (over = {}) => ({ mode: 'own', provider: 'duckdns', name: 'myhouse', token: TOKEN, ...over })
const save = (patch, settings = {}) => {
  const v = validateTlsPatch(patch, settings)
  if (!v.ok) throw new Error(v.error)
  return applyTlsPatch(settings, v.next, { encrypt: encryptSecret })
}

console.log('\n-- validation --')

await test('🔍 accepted: Automatic (no name or token needed), own (DuckDNS, deSEC) and off', () => {
  assert(validateTlsPatch(own(), {}).ok, 'duckdns')
  assert(validateTlsPatch(own({ provider: 'desec', name: 'myhouse.dedyn.io' }), {}).ok, 'desec')
  assert(validateTlsPatch({ mode: 'off' }, {}).ok, 'off')
  const r = validateTlsPatch({ mode: 'redstart' }, {})
  assert(r.ok && r.next.mode === 'redstart' && r.next.consentAsked === true, JSON.stringify(r))
  assert(!validateTlsPatch({ mode: 'on' }, {}).ok, 'unknown mode')
})

await test('consentAsked: set by answering (any HTTPS choice, or "Not now"), never cleared by a client', () => {
  assert(validateTlsPatch({ consentAsked: true }, {}).next.consentAsked === true, '"Not now"')
  assert(validateTlsPatch({ mode: 'off' }, {}).next.consentAsked === false, 'a plain Off save answered the question')
  assert(!validateTlsPatch({ consentAsked: false }, {}).ok, 'a client cleared it')
})

await test('names: a bare DuckDNS subdomain gets its suffix; bad names are refused with a sentence', () => {
  assert(normaliseName('duckdns', ' MyHouse ') === 'myhouse.duckdns.org', normaliseName('duckdns', ' MyHouse '))
  for (const bad of ['my_house', 'a.b.duckdns.org', 'myhouse.duckdns.com', '-x', 'x'.repeat(64)]) {
    const r = validateTlsPatch(own({ name: bad }), {})
    assert(!r.ok && /yourname\.duckdns\.org/.test(r.error), `${bad}: ${JSON.stringify(r)}`)
  }
  assert(!validateTlsPatch(own({ provider: 'desec', name: 'nodot' }), {}).ok, 'desec without a dot')
})

await test('🔍 tokens: required for own, shape-checked, unknown fields refused', () => {
  assert(!validateTlsPatch(own({ token: undefined }), {}).ok, 'no token, nothing stored')
  for (const t of ['short', 'has space inside it', 'x'.repeat(201), '<script>alert(1)</script>']) {
    assert(!validateTlsPatch(own({ token: t }), {}).ok, `token ${JSON.stringify(t)} accepted`)
  }
  assert(!validateTlsPatch({ ...own(), tokenEnc: 'x' }, {}).ok, 'a client may not write tokenEnc directly')
  assert(!validateTlsPatch({ mode: 'off', requireHttps: 'yes' }, {}).ok, 'non-boolean switch')
})

console.log('\n-- the token at rest --')

await test('🔍 stored encrypted, never in readTls(), and it decrypts back', () => {
  const s = save(own())
  const text = JSON.stringify(s)
  assert(!text.includes(TOKEN), 'the token is in settings.json in the clear')
  assert(typeof s.tls.own.tokenEnc === 'string' && decryptSecret(s.tls.own.tokenEnc) === TOKEN, 'does not decrypt back')
  const view = readTls(s)
  assert(!JSON.stringify(view).includes(TOKEN) && !('tokenEnc' in view) && view.hasToken === true, JSON.stringify(view))
})

await test('🔍 a save without a token keeps the stored one; a provider change drops it', () => {
  const s1 = save(own())
  const s2 = save({ requireHttps: true }, s1)
  assert(s2.tls.own.tokenEnc === s1.tls.own.tokenEnc && s2.tls.requireHttps === true, 'token lost on an unrelated save')
  const r = validateTlsPatch({ provider: 'desec', name: 'myhouse.dedyn.io' }, s1)
  assert(!r.ok && /deSEC token/.test(r.error), `switching provider kept the DuckDNS token: ${JSON.stringify(r)}`)
  const s3 = save({ mode: 'off', provider: 'desec' }, s1)
  assert(!s3.tls.own.tokenEnc, 'token kept across a provider change')
})

await test('🔍 the re-key tool finds tls.own.tokenEnc (or a re-key would silently lose it)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-tls-rekey-'))
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(save(own())))
    const found = findSecrets(dir)
    assert(found.some((f) => f.file === 'settings.json' && f.pointer.join('.') === 'tls.own.tokenEnc'), JSON.stringify(found.map((f) => f.pointer)))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

console.log('\n-- what Caddy gets --')

await test('tlsRuntime: the name, the placeholder-only dns block, the token in secrets; null when off or unusable', () => {
  const s = save(own({ acmeStaging: true }))
  const t = tlsRuntime(s, { decrypt: decryptSecret })
  assert(t.hostname === 'myhouse.duckdns.org' && t.secrets.REDSTART_DNS_TOKEN === TOKEN && t.acmeStaging === true, JSON.stringify({ ...t, token: '…', secrets: '…' }))
  checkDnsProvider(t.dnsProvider) // throws on a literal credential
  checkDnsProvider(caddyDnsFor('desec'))
  assert(tlsRuntime(save({ mode: 'off' }), { decrypt: decryptSecret }) === null, 'off')
  assert(tlsRuntime(s, { decrypt: () => { throw new Error('foreign key') } }) === null, 'undecryptable token must be null, not a throw')
})

await test('🔍 caddyKeyOf changes with anything in Caddy\'s config, never contains the token', () => {
  const s = save(own())
  const k = caddyKeyOf(s)
  assert(k && !k.includes(TOKEN.slice(0, 8)), k)
  assert(caddyKeyOf(save({ requireHttps: true }, s)) !== k, 'requireHttps changes the :80 page')
  assert(caddyKeyOf(save({ acmeStaging: true }, s)) !== k, 'staging changes the CA')
  assert(caddyKeyOf(save({ name: 'other' }, s)) !== k, 'name')
  assert(caddyKeyOf(save({ token: 'another-token-12345678' }, s)) !== k, 'token')
  assert(caddyKeyOf(save({}, s)) === k, 'a no-op save restarted Caddy')
  assert(caddyKeyOf(save({ mode: 'off' })) === '', 'off has no key')
})

await test('🔍 while HTTPS is on, 80 and 443 are Caddy\'s', () => {
  assert(serverPortRejection(443) === null && serverPortRejection(80) === null, 'reserved with HTTPS off')
  assert(/the bundled Caddy/.test(serverPortRejection(443, { httpsFronted: true }) ?? ''), '443')
  assert(/the bundled Caddy/.test(serverPortRejection(78, { httpsFronted: true }) ?? ''), '78 puts the MCP server on 80')
  assert(serverPortRejection(19080, { httpsFronted: true }) === null, 'the default port')
})

console.log('\n-- tls:set through the real handler --')

const { setTls, getTls } = await import('../daemon/ipc/tls.mjs')
const { initLan } = await import('../daemon/lan.mjs')
let disk = {}
const deps = { readSettings: () => structuredClone(disk), writeSettings: (s) => { disk = structuredClone(s) } }
initLan({ configDir: tmp, readSettings: deps.readSettings, writeSettings: deps.writeSettings, decrypt: decryptSecret })

await test('🔍 a rejected save writes nothing and says why', async () => {
  const r = await setTls({ mode: 'own', provider: 'duckdns', name: 'bad_name', token: TOKEN }, deps)
  assert(!r.ok && /duckdns\.org/.test(r.error) && JSON.stringify(disk) === '{}', JSON.stringify(r))
})

await test('🔍 an accepted save stores the token encrypted and the answer never contains it', async () => {
  const r = await setTls({ mode: 'own', provider: 'duckdns', name: 'myhouse', token: TOKEN }, deps)
  assert(r.ok, JSON.stringify(r))
  assert(!JSON.stringify(disk).includes(TOKEN), 'plaintext token on disk')
  assert(!JSON.stringify(r).includes(TOKEN) && !JSON.stringify(getTls()).includes(TOKEN), 'the token came back to the client')
  assert(r.status.settings.hasToken && r.status.settings.name === 'myhouse.duckdns.org', JSON.stringify(r.status.settings))
  assert(r.status.egress.some((e) => e.host === 'www.duckdns.org'), 'egress does not name the provider')
})

await test('🔍 with network mode off nothing starts (a loopback-only install calls out to nobody)', () => {
  const s = getTls()
  assert(s.state === 'local' && (s.caddy?.state ?? 'stopped') === 'stopped' && !s.address, JSON.stringify({ state: s.state, caddy: s.caddy, address: s.address }))
})

await test('a gateway port of 443 cannot be combined with HTTPS', async () => {
  disk = { ...disk, discovery: { networkMode: true, gatewayPort: 443 } }
  const r = await setTls({ requireHttps: true }, deps)
  assert(!r.ok && /bundled Caddy/.test(r.error), JSON.stringify(r))
  disk = { ...disk, discovery: undefined }
})

console.log('\n-- Automatic (step 8) --')

const { readRedstart, withRedstart, withoutRedstart } = await import('../daemon/tls-settings.mjs')
const CRED = 'C'.repeat(43)
const registered = () => withRedstart(save({ mode: 'redstart' }), { id: 'k7f3q2', credential: CRED }, { encrypt: encryptSecret, now: 5 })

await test('🔍 the registration: credential encrypted, never in readTls(), hostname DERIVED from the id', () => {
  const s = registered()
  assert(!JSON.stringify(s).includes(CRED), 'credential in the clear')
  const view = readTls(s)
  assert(view.automatic?.hostname === 'k7f3q2.nest.redstartdevelopment.com' && !JSON.stringify(view).includes(CRED) && !JSON.stringify(view).includes('credentialEnc'), JSON.stringify(view))
  const forged = { ...s, tls: { ...s.tls, redstart: { ...s.tls.redstart, id: 'x.evil' } } }
  assert(readRedstart(forged) === null, 'a stored id that is not an id was accepted')
  let threw = false
  try { withRedstart({}, { id: 'evil.com', credential: CRED }, { encrypt: encryptSecret }) } catch { threw = true }
  assert(threw, 'stored a non-id')
})

await test('🔍 a save of any other field keeps the registration (applyTlsPatch must not drop it)', () => {
  const s = registered()
  const after = save({ requireHttps: true }, s)
  assert(after.tls.redstart?.credentialEnc === s.tls.redstart.credentialEnc, 'the registration was dropped by an unrelated save')
  assert(readRedstart(withoutRedstart(after)) === null, 'withoutRedstart left it')
})

await test('🔍 tlsRuntime: acmedns at the name service, id as user and subdomain, the credential by env only', () => {
  const t = tlsRuntime(registered(), { decrypt: decryptSecret })
  assert(t.provider === 'redstart' && t.hostname === 'k7f3q2.nest.redstartdevelopment.com' && t.secrets.REDSTART_DNS_TOKEN === CRED, JSON.stringify({ ...t, token: '…', secrets: '…' }))
  assert(JSON.stringify(t.dnsProvider) === JSON.stringify({ name: 'acmedns', username: 'k7f3q2', password: '{env.REDSTART_DNS_TOKEN}', subdomain: 'k7f3q2', server_url: 'https://names.redstartdevelopment.com' }), JSON.stringify(t.dnsProvider))
  checkDnsProvider(t.dnsProvider)
  assert(tlsRuntime(save({ mode: 'redstart' }), { decrypt: decryptSecret }) === null, 'Automatic before registering must be null (lan.mjs registers first)')
})

await test('🔍 the re-key tool finds tls.redstart.credentialEnc', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-tls-rekey2-'))
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(registered()))
    assert(findSecrets(dir).some((f) => f.pointer.join('.') === 'tls.redstart.credentialEnc'), 'not found')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

await test('caddyKey: registering does not change it (no restart mid-start); staging and requireHttps do', () => {
  const before = caddyKeyOf(save({ mode: 'redstart' }))
  assert(caddyKeyOf(registered()) === before, 'registration changed the key: Caddy would restart right after its first start')
  assert(caddyKeyOf(save({ mode: 'redstart', acmeStaging: true })) !== before, 'staging')
  assert(caddyKeyOf(save({ mode: 'redstart' })) !== caddyKeyOf(save(own())), 'own vs Automatic')
})

await test('🔍 the admin panel over HTTPS: proxied only with HTTPS on AND exposure asked for; the Caddy key follows it', async () => {
  const { adminProxied } = await import('../daemon/tls-settings.mjs')
  const on = save(own())
  assert(adminProxied({ ...on, adminBindHost: '0.0.0.0' }) === true, 'HTTPS on + exposed')
  assert(adminProxied({ ...on, adminBindHost: '127.0.0.1' }) === false && adminProxied(on) === false, 'not exposed')
  assert(adminProxied({ ...save({ mode: 'off' }), adminBindHost: '0.0.0.0' }) === false, 'HTTPS off: the admin panel is not proxied')
  assert(caddyKeyOf({ ...on, adminBindHost: '0.0.0.0' }) !== caddyKeyOf(on), 'turning exposure on would not restart Caddy with the :8443 route')
  const t = tlsRuntime({ ...on, adminBindHost: '0.0.0.0' }, { decrypt: decryptSecret })
  assert(t.adminProxied === true, 'runtime does not carry it')
})

await test('🔍 choosing Automatic with network mode OFF calls no name service (invariant 6)', async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, ...rest) => { calls.push(String(url)); return realFetch(url, ...rest) }
  try {
    disk = {}
    const r = await setTls({ mode: 'redstart' }, deps)
    assert(r.ok && r.status.state === 'local', JSON.stringify(r).slice(0, 200))
    assert(!calls.some((u) => /redstartdevelopment|duckdns|dedyn|letsencrypt/.test(u)), `called out: ${calls.join(', ')}`)
    assert(!readRedstart(disk), 'registered with network mode off')
  } finally {
    globalThis.fetch = realFetch
  }
})

await test('Automatic → Off with nothing registered is a plain save', async () => {
  const r = await setTls({ mode: 'off' }, deps)
  assert(r.ok && readTls(disk).mode === 'off' && readTls(disk).consentAsked === true, JSON.stringify(readTls(disk)))
})

fs.rmSync(tmp, { recursive: true, force: true })

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
