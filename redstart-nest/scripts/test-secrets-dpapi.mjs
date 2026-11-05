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

const { oscryptProvider, readWrappedKey, OSCRYPT_KEY_BYTES } = await import('../electron/main/secrets-dpapi.mjs')
const { SAFE_STORAGE_TAG } = await import('../electron/main/secrets-safe-storage.mjs')
const secrets = await import('../electron/main/secrets.mjs')

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

fs.rmSync(tmp, { recursive: true, force: true })

const passed = results.filter(r => r.pass).length
console.log(`\n${passed}/${results.length} passed\n`)
if (passed !== results.length) process.exit(1)
