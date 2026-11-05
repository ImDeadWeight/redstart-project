// =============================================================================
// The OSCrypt-compatible secrets provider: reads what Electron wrote.
// =============================================================================
// The daemon split (docs/notes/daemon-split-tauri-plan.md D1) moves the desktop
// daemon off Electron. Every install has secrets that Electron's safeStorage
// wrote; this provider must read them with NO migration, and an Electron build
// must still read what it writes.
//
// The fixture is real: scripts/fixtures/oscrypt-electron33.json holds a blob
// that Electron 33.4.11's safeStorage.encryptString produced on Windows, and
// the throwaway key that run used (unwrapped from its Local State with DPAPI).
// Every decrypt here uses a provider CONSTRUCTED FRESH from that key, which
// is how a daemon starting up meets it. The 8B re-key lesson: an instance that
// just did the writing proves nothing.
//
// Run:  node scripts/test-secrets-dpapi.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'


const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'oscrypt-electron33.json'), 'utf8'))
const KEY = Buffer.from(fixture.keyBase64, 'base64')

const { oscryptProvider, oscryptMacProvider, providerForHello, readWrappedKey, OSCRYPT_KEY_BYTES } = await import('../daemon/secrets-dpapi.mjs')
const { SAFE_STORAGE_TAG } = await import('../daemon/secrets-safe-storage.mjs')
const secrets = await import('../daemon/secrets.mjs')

const results = []
async function test(name, fn) {
  try {
    const detail = await fn()
    results.push({ pass: true })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ pass: false })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}
function assert(cond, message) { if (!cond) throw new Error(message) }
function throws(fn, pattern) {
  try { fn() } catch (err) { return pattern ? pattern.test(err.message) : true }
  return false
}

console.log('\n-- compatibility with what Electron wrote --')

await test('🔍 a blob Electron 33 safeStorage wrote decrypts with a freshly constructed provider', () => {
  const plain = oscryptProvider(Buffer.from(fixture.keyBase64, 'base64')).decrypt(fixture.blobBase64)
  assert(plain === fixture.plaintext, `got ${JSON.stringify(plain)}`)
  return `Electron ${fixture.electron}`
})

await test('🔍 the same value as stored on disk (tagged), through secrets.mjs', () => {
  secrets.initSecrets(oscryptProvider(KEY))
  const stored = `v1.${SAFE_STORAGE_TAG}.${fixture.blobBase64}`
  assert(secrets.decryptSecret(stored) === fixture.plaintext, 'tagged safeStorage value not read')
  return 'v1.safestorage.<blob>'
})

await test('🔍 an untagged pre-Phase-8 value reads too (it is attributed to safestorage)', () => {
  secrets.initSecrets(oscryptProvider(KEY))
  assert(secrets.decryptSecret(fixture.blobBase64) === fixture.plaintext, 'legacy untagged value not read')
})

await test('🔍 writes keep the safestorage tag and the v10 layout, so an Electron build can read them back', () => {
  secrets.initSecrets(oscryptProvider(KEY))
  const stored = secrets.encryptSecret('postgres://u:p@h/db')
  const { tag, payload } = secrets.parseSecret(stored)
  assert(tag === SAFE_STORAGE_TAG, `tag ${tag}`)
  const blob = Buffer.from(payload, 'base64')
  assert(blob.subarray(0, 3).toString('latin1') === 'v10', 'not a v10 blob')
  assert(blob.length === 3 + 12 + Buffer.byteLength('postgres://u:p@h/db') + 16, `unexpected layout, ${blob.length} bytes`)
  // Decrypt independently of the provider: plain AES-256-GCM, Chromium's way.
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, blob.subarray(3, 15))
  d.setAuthTag(blob.subarray(blob.length - 16))
  const plain = Buffer.concat([d.update(blob.subarray(15, blob.length - 16)), d.final()]).toString()
  assert(plain === 'postgres://u:p@h/db', 'independent decrypt disagreed')
  // And a second, fresh provider reads it.
  assert(oscryptProvider(Buffer.from(KEY)).decrypt(payload) === 'postgres://u:p@h/db', 'fresh provider could not read a write')
})

console.log('\n-- refusals --')

await test('🔍 the wrong key is refused, never returns garbage', () => {
  const other = oscryptProvider(crypto.randomBytes(OSCRYPT_KEY_BYTES))
  assert(throws(() => other.decrypt(fixture.blobBase64), /could not be decrypted/), 'a wrong key did not refuse')
})

await test('🔍 a tampered byte anywhere is refused', () => {
  const p = oscryptProvider(KEY)
  const blob = Buffer.from(fixture.blobBase64, 'base64')
  for (const i of [5, 20, blob.length - 1]) {
    const bad = Buffer.from(blob); bad[i] ^= 0x01
    assert(throws(() => p.decrypt(bad.toString('base64'))), `a flip at byte ${i} decrypted`)
  }
})

await test('non-v10 and truncated payloads are refused with a reason', () => {
  const p = oscryptProvider(KEY)
  assert(throws(() => p.decrypt(Buffer.from('xyz-not-oscrypt').toString('base64')), /v10/), 'non-v10 accepted')
  assert(throws(() => p.decrypt(Buffer.from('v10short').toString('base64')), /truncated/), 'truncated accepted')
})

await test('a key that is not 32 bytes is refused at construction', () => {
  assert(throws(() => oscryptProvider(Buffer.alloc(16))), '16-byte key accepted')
  assert(throws(() => oscryptProvider('not a buffer')), 'a string key accepted')
})

await test('the provider keeps its own copy of the key', () => {
  const k = Buffer.from(KEY)
  const p = oscryptProvider(k)
  k.fill(0)
  assert(p.decrypt(fixture.blobBase64) === fixture.plaintext, 'zeroing the caller\'s buffer broke the provider')
})

console.log('\n-- Local State (the shell reads the wrapped key from it) --')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-oscrypt-'))

await test('readWrappedKey strips the DPAPI marker and nothing else', () => {
  const dpapiBlob = crypto.randomBytes(200)
  const file = path.join(tmp, 'Local State')
  fs.writeFileSync(file, JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), dpapiBlob]).toString('base64') }, other: 1 }))
  assert(readWrappedKey(file).equals(dpapiBlob), 'wrapped key bytes differ')
})

await test('a Local State without a DPAPI key is refused with the file named', () => {
  const none = path.join(tmp, 'none.json'); fs.writeFileSync(none, '{}')
  const notDpapi = path.join(tmp, 'plain.json'); fs.writeFileSync(notDpapi, JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('v10xxxx').toString('base64') } }))
  assert(throws(() => readWrappedKey(none), /encrypted_key/), 'missing key not refused')
  assert(throws(() => readWrappedKey(notDpapi), /not DPAPI/), 'non-DPAPI key not refused')
  assert(throws(() => readWrappedKey(path.join(tmp, 'absent')), /absent/), 'missing file not named')
})

// ---------------------------------------------------------------------------
// macOS: os_crypt_mac (Electron safeStorage on a Mac)
// ---------------------------------------------------------------------------
// No Mac here, so no blob written by real Electron. Instead a second,
// independent implementation of Chromium's parameters through WebCrypto
// (PBKDF2 + AES-CBC from crypto.subtle) encrypts, and the provider must
// decrypt it, and vice versa. A wrong salt, iteration count, key length, IV
// or prefix in either fails this.
console.log('\n-- 🔍 macOS: os_crypt_mac --')

const subtle = globalThis.crypto.subtle
async function chromiumMacKey(password) {
  const base = await subtle.importKey('raw', password, 'PBKDF2', false, ['deriveKey'])
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-1', salt: new TextEncoder().encode('saltysalt'), iterations: 1003 },
    base, { name: 'AES-CBC', length: 128 }, false, ['encrypt', 'decrypt'])
}
const IV = new Uint8Array(16).fill(0x20)
// What Electron stores: 16 random bytes, base64 (24 characters).
const KEYCHAIN_PASSWORD = Buffer.from('q2b1Wv7Kc6hJ9QZ0x4R3sA==', 'latin1')

await test('🔍 a v10 blob made to Chromium\'s macOS parameters decrypts', async () => {
  const k = await chromiumMacKey(KEYCHAIN_PASSWORD)
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv: IV }, k, new TextEncoder().encode('postgres://u:p@h/db')))
  const blob = Buffer.concat([Buffer.from('v10'), Buffer.from(ct)]).toString('base64')
  const plain = oscryptMacProvider(KEYCHAIN_PASSWORD).decrypt(blob)
  assert(plain === 'postgres://u:p@h/db', `got ${JSON.stringify(plain)}`)
})

await test('🔍 what the provider writes, Chromium\'s parameters read', async () => {
  const blob = Buffer.from(oscryptMacProvider(KEYCHAIN_PASSWORD).encrypt('sk-live-123'), 'base64')
  assert(blob.subarray(0, 3).toString() === 'v10', 'no v10 prefix')
  const k = await chromiumMacKey(KEYCHAIN_PASSWORD)
  const pt = await subtle.decrypt({ name: 'AES-CBC', iv: IV }, k, blob.subarray(3))
  assert(new TextDecoder().decode(pt) === 'sk-live-123', 'independent decrypt disagrees')
})

await test('a different Keychain password does not read it', () => {
  const blob = oscryptMacProvider(KEYCHAIN_PASSWORD).encrypt('x'.repeat(40))
  let out = null
  try { out = oscryptMacProvider(Buffer.from('another-password')).decrypt(blob) } catch { out = null }
  assert(out !== 'x'.repeat(40), 'decrypted with the wrong password')
})

await test('hello picks the provider: no keyFormat is Windows, oscrypt-mac is the Mac, anything else is refused', () => {
  const winKey = crypto.randomBytes(OSCRYPT_KEY_BYTES)
  const win = providerForHello(winKey, undefined)
  assert(oscryptProvider(winKey).decrypt(win.encrypt('w')) === 'w', 'Windows provider not chosen')
  const mac = providerForHello(KEYCHAIN_PASSWORD, 'oscrypt-mac')
  assert(oscryptMacProvider(KEYCHAIN_PASSWORD).decrypt(mac.encrypt('m')) === 'm', 'Mac provider not chosen')
  let err = null
  try { providerForHello(winKey, 'plaintext') } catch (e) { err = e }
  assert(err && /Unknown secrets key format/.test(err.message), 'an unknown format was accepted')
})

fs.rmSync(tmp, { recursive: true, force: true })

const passed = results.filter(r => r.pass).length
console.log(`\n${passed}/${results.length} passed\n`)
if (passed !== results.length) process.exit(1)
