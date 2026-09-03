// =============================================================================
// Secrets — the provider seam, the storage format, and the back-compat promise
// =============================================================================
// Phase 8A.1 split secrets.mjs into a seam (format + routing) and two providers
// (Electron safeStorage, and a daemon-owned key file). Three things have to
// hold, and each of them can fail silently rather than loudly:
//
//   1. FAIL-CLOSED. secrets.mjs holds no crypto and has no default provider.
//      An entrypoint that forgets initSecrets() must throw, not fall back to
//      storing plaintext — the module it replaced refused to store a secret
//      when OS encryption was unavailable, and that refusal is the property
//      being preserved.
//
//   2. LEGACY VALUES STILL DECRYPT. Every secret on every install shipped so
//      far is bare base64 written by safeStorage. The new format tags values
//      with the provider that wrote them; an untagged value must therefore
//      still route to safeStorage. Getting this wrong loses every stored
//      credential on upgrade, silently, because the callers of decryptSecret
//      mostly sit behind `try`.
//
//   3. THE TAG IS UNAMBIGUOUS. The whole format rests on the claim that a bare
//      base64 blob can never begin with "v1." — '.' is not in the base64
//      alphabet. That claim is asserted here by construction rather than
//      trusted, because Phase 8B.2's DPAPI re-key will enumerate secrets by
//      their tags and a false negative there is data loss.
//
// The key file provider is exercised against real AES-256-GCM, not a stub:
// this suite deliberately imports no Electron and needs none.
//
// Run:  node scripts/test-secrets.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { keyfileProvider, KEY_FILE_NAME, KEY_BYTES, KEYFILE_TAG } from '../electron/main/secrets-keyfile.mjs'
import { safeStorageProvider, SAFE_STORAGE_TAG } from '../electron/main/secrets-safe-storage.mjs'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-secrets-'))

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

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

function throws(fn, matcher, message) {
  let threw = null
  try { fn() } catch (err) { threw = err }
  assert(threw, message || 'expected a throw, got none')
  if (matcher) {
    assert(matcher.test(threw.message), `${message || 'wrong error'} — got: ${threw.message}`)
  }
  return threw
}

// secrets.mjs keeps its provider in module state, so a case that needs an
// un-initialised module needs a fresh instance of it. A query string defeats
// the ESM module cache; nothing in the module depends on its own URL.
let freshCount = 0
function freshSecrets() {
  return import(`../electron/main/secrets.mjs?case=${++freshCount}`)
}

function newDir(name) {
  const dir = path.join(tmpRoot, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// A stand-in for Electron's safeStorage — the same reversible encoding the
// test stub uses. What is under test here is the PROVIDER wrapping it (the
// availability check, the base64 framing), not OS crypto.
function fakeSafeStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(String(s), 'utf8'),
    decryptString: (b) => Buffer.from(b).toString('utf8'),
  }
}

console.log('\n-- fail-closed --')

await test('🔒 encryptSecret throws before initSecrets() rather than storing plaintext', async () => {
  const { encryptSecret } = await freshSecrets()
  const err = throws(() => encryptSecret('hunter2'), /initSecrets/, 'encrypt did not fail closed')
  assert(!/hunter2/.test(err.message), 'the error message leaked the plaintext')
  return 'no provider, no write'
})

await test('🔒 decryptSecret throws before initSecrets()', async () => {
  const { decryptSecret } = await freshSecrets()
  throws(() => decryptSecret('v1.keyfile.abc'), /initSecrets/, 'decrypt did not fail closed')
})

await test('empty input still short-circuits to null with no provider wired', async () => {
  const { encryptSecret, decryptSecret } = await freshSecrets()
  assert(encryptSecret(null) === null, 'encryptSecret(null) should be null')
  assert(encryptSecret('') === null, 'encryptSecret("") should be null')
  assert(decryptSecret(null) === null, 'decryptSecret(null) should be null')
  assert(decryptSecret(undefined) === null, 'decryptSecret(undefined) should be null')
  return 'callers that hold no secret never need a provider'
})

await test('initSecrets rejects a malformed provider', async () => {
  const { initSecrets } = await freshSecrets()
  throws(() => initSecrets(null), /provider/, 'accepted null')
  throws(() => initSecrets({ tag: 'x' }), /provider/, 'accepted a provider with no crypto')
  throws(() => initSecrets({ tag: '', encrypt: () => '', decrypt: () => '' }), /provider/, 'accepted an empty tag')
})

await test('🔍 initSecrets rejects a tag containing a dot', async () => {
  const { initSecrets } = await freshSecrets()
  // The tag is a field in a '.'-delimited format string. A dot inside it would
  // make parseSecret() split in the wrong place and mis-attribute the value —
  // which, for 8B.2, means a secret the migration never finds.
  throws(
    () => initSecrets({ tag: 'v1.keyfile', encrypt: () => '', decrypt: () => '' }),
    /must not contain/,
    'accepted a tag that would corrupt the format'
  )
})

console.log('\n-- the key file provider (real AES-256-GCM) --')

await test('round-trips a secret', async () => {
  const { initSecrets, encryptSecret, decryptSecret } = await freshSecrets()
  initSecrets(keyfileProvider(newDir('roundtrip')))
  const stored = encryptSecret('postgres://user:pw@host/db')
  assert(decryptSecret(stored) === 'postgres://user:pw@host/db', 'did not round-trip')
  return 'plaintext survives the trip'
})

await test('🔒 the stored value is not the plaintext', async () => {
  const { initSecrets, encryptSecret } = await freshSecrets()
  initSecrets(keyfileProvider(newDir('opaque')))
  const stored = encryptSecret('hunter2')
  assert(!stored.includes('hunter2'), 'plaintext appears in the stored value')
  assert(!Buffer.from(stored.split('.').pop(), 'base64').toString('utf8').includes('hunter2'),
    'plaintext appears in the decoded payload')
})

await test('the stored value carries the keyfile tag', async () => {
  const { initSecrets, encryptSecret, parseSecret } = await freshSecrets()
  initSecrets(keyfileProvider(newDir('tagged')))
  const stored = encryptSecret('x')
  assert(stored.startsWith(`v1.${KEYFILE_TAG}.`), `not tagged: ${stored.slice(0, 20)}`)
  const parsed = parseSecret(stored)
  assert(parsed.tag === KEYFILE_TAG, `parsed tag was ${parsed.tag}`)
  assert(parsed.tagged === true, 'parseSecret did not report it as tagged')
})

await test('the key file is created once, is the right size, and is not world-readable', async () => {
  const dir = newDir('keyfile')
  const { initSecrets, encryptSecret } = await freshSecrets()
  initSecrets(keyfileProvider(dir))
  encryptSecret('a')
  const keyPath = path.join(dir, KEY_FILE_NAME)
  const before = fs.readFileSync(keyPath)
  assert(before.length === KEY_BYTES, `key is ${before.length} bytes, expected ${KEY_BYTES}`)
  encryptSecret('b')
  assert(Buffer.compare(before, fs.readFileSync(keyPath)) === 0, 'a second write replaced the key')
  if (process.platform !== 'win32') {
    // On win32 the mode bits are approximated by Node and mean little; the
    // real control there is the directory ACL (design decision 9, §8B.1).
    const mode = fs.statSync(keyPath).mode & 0o777
    assert(mode === 0o600, `key file mode is ${mode.toString(8)}, expected 600`)
  }
  return process.platform === 'win32' ? 'mode check skipped on win32' : '0600'
})

await test('🔒 two encryptions of the same plaintext differ, and both decrypt', async () => {
  const { initSecrets, encryptSecret, decryptSecret } = await freshSecrets()
  initSecrets(keyfileProvider(newDir('iv')))
  const a = encryptSecret('same')
  const b = encryptSecret('same')
  // A fresh IV per encryption. Without it, equal ciphertexts leak that two
  // config fields hold the same credential.
  assert(a !== b, 'identical ciphertext for identical plaintext — is the IV fixed?')
  assert(decryptSecret(a) === 'same' && decryptSecret(b) === 'same', 'one of them did not decrypt')
})

await test('🔒 a tampered payload is rejected, not silently decrypted', async () => {
  const { initSecrets, encryptSecret, decryptSecret } = await freshSecrets()
  initSecrets(keyfileProvider(newDir('tamper')))
  const stored = encryptSecret('trusted-value')
  const prefix = `v1.${KEYFILE_TAG}.`
  const raw = Buffer.from(stored.slice(prefix.length), 'base64')
  raw[raw.length - 1] ^= 0xff
  throws(() => decryptSecret(prefix + raw.toString('base64')), null, 'tampered ciphertext decrypted')
  return 'GCM auth tag holds'
})

await test('a too-short payload is rejected before the cipher sees it', async () => {
  const { initSecrets, encryptSecret, decryptSecret } = await freshSecrets()
  initSecrets(keyfileProvider(newDir('short')))
  // Establish the key first: the missing-key check runs ahead of the length
  // check (correctly — with no key nothing is decryptable at any length), so
  // without this the case would pass for the wrong reason.
  encryptSecret('establish the key')
  throws(() => decryptSecret(`v1.${KEYFILE_TAG}.${Buffer.from('tiny').toString('base64')}`),
    /too short/, 'accepted a payload shorter than iv+tag')
})

await test('🔍 decrypting with no key file says so, and does NOT mint a new one', async () => {
  const dir = newDir('nokey')
  const { initSecrets, decryptSecret } = await freshSecrets()
  initSecrets(keyfileProvider(dir))
  // Minting a key here would turn "the key file is missing — restore it" into
  // "authentication failed", which reads as corrupt data and sends an admin
  // looking in the wrong place.
  throws(() => decryptSecret(`v1.${KEYFILE_TAG}.${Buffer.from('x'.repeat(40)).toString('base64')}`),
    /no key file/, 'wrong error for a missing key file')
  assert(!fs.existsSync(path.join(dir, KEY_FILE_NAME)), 'decrypt created a key file')
})

await test('🔒 a wrong-length key file is refused rather than stretched', async () => {
  const dir = newDir('badkey')
  fs.writeFileSync(path.join(dir, KEY_FILE_NAME), Buffer.alloc(7))
  const { initSecrets, encryptSecret } = await freshSecrets()
  initSecrets(keyfileProvider(dir))
  throws(() => encryptSecret('x'), /not a 32-byte key/, 'accepted a malformed key file')
})

await test('an existing key file is reused, so secrets survive a restart', async () => {
  const dir = newDir('persist')
  const first = await freshSecrets()
  first.initSecrets(keyfileProvider(dir))
  const stored = first.encryptSecret('survives')
  // A second provider over the same directory is what a daemon restart looks
  // like: new process, same disk.
  const second = await freshSecrets()
  second.initSecrets(keyfileProvider(dir))
  assert(second.decryptSecret(stored) === 'survives', 'a restart could not read its own secret')
})

console.log('\n-- the safeStorage provider, and legacy values --')

await test('round-trips through the safeStorage provider', async () => {
  const { initSecrets, encryptSecret, decryptSecret } = await freshSecrets()
  initSecrets(safeStorageProvider(fakeSafeStorage()))
  const stored = encryptSecret('key-abc')
  assert(stored.startsWith(`v1.${SAFE_STORAGE_TAG}.`), `not tagged: ${stored}`)
  assert(decryptSecret(stored) === 'key-abc', 'did not round-trip')
})

await test('🔒 refuses to store when OS encryption is unavailable', async () => {
  const { initSecrets, encryptSecret } = await freshSecrets()
  initSecrets(safeStorageProvider(fakeSafeStorage({ available: false })))
  // The property the pre-Phase-8 module had, preserved: refuse rather than
  // quietly write plaintext into tools.json.
  throws(() => encryptSecret('x'), /unavailable/, 'stored a secret with no OS encryption')
})

await test('🔍 a legacy untagged value still decrypts under safeStorage', async () => {
  const { initSecrets, decryptSecret } = await freshSecrets()
  initSecrets(safeStorageProvider(fakeSafeStorage()))
  // Exactly what every install shipped so far has on disk: bare base64, no
  // tag, written by safeStorage.encryptString().
  const legacy = Buffer.from('postgres://legacy', 'utf8').toString('base64')
  assert(decryptSecret(legacy) === 'postgres://legacy', 'an existing install lost its secrets on upgrade')
  return 'upgrade path intact'
})

await test('parseSecret attributes an untagged value to safeStorage', async () => {
  const { parseSecret, LEGACY_TAG } = await freshSecrets()
  const parsed = parseSecret('c29tZS1iYXNlNjQ=')
  assert(parsed.tag === LEGACY_TAG, `attributed to ${parsed.tag}`)
  assert(parsed.tagged === false, 'reported an untagged value as tagged')
  assert(LEGACY_TAG === SAFE_STORAGE_TAG, 'the legacy tag and the safeStorage tag have drifted apart')
})

await test('🔒 base64 can never collide with the "v1." prefix', async () => {
  // The format rests on this. Assert it by construction rather than trusting
  // it: if it were false, a legacy blob could be misread as a tagged one and
  // 8B.2 would skip it during the re-key.
  const alphabet = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=')
  for (let i = 0; i < 200; i++) {
    const b64 = Buffer.from(Array.from({ length: 48 }, (_, n) => (i * 31 + n * 7) % 256)).toString('base64')
    for (const ch of b64) assert(alphabet.has(ch), `unexpected base64 character ${JSON.stringify(ch)}`)
    assert(!b64.startsWith('v1.'), `base64 output began with the format prefix: ${b64}`)
  }
  return "'.' is not in the alphabet"
})

console.log('\n-- cross-provider routing (the trap 5.3 condition) --')

await test('🔒 a value written by another provider is refused, naming both', async () => {
  const dir = newDir('cross')
  const writer = await freshSecrets()
  writer.initSecrets(keyfileProvider(dir))
  const stored = writer.encryptSecret('written-by-keyfile')

  const reader = await freshSecrets()
  reader.initSecrets(safeStorageProvider(fakeSafeStorage()))
  // This is trap 5.3 in miniature: ciphertext reaching a daemon that cannot
  // read it. The message has to name the provider that WROTE it, because that
  // is what tells an admin whether the value is recoverable at all.
  const err = throws(() => reader.decryptSecret(stored), /keyfile/, 'read another provider\'s ciphertext')
  assert(/safestorage/.test(err.message), `error did not name the running provider: ${err.message}`)
})

await test('🔍 a legacy value is refused under the keyfile provider', async () => {
  const { initSecrets, decryptSecret } = await freshSecrets()
  initSecrets(keyfileProvider(newDir('legacy-on-keyfile')))
  const legacy = Buffer.from('old-secret', 'utf8').toString('base64')
  // The headless daemon meeting a DPAPI blob. It must say so rather than
  // return garbage or a misleading auth failure — this is the exact error
  // 8B.2's dry run will collect and report per-secret.
  throws(() => decryptSecret(legacy), /safestorage/, 'did not attribute the legacy value')
})

await test('activeSecretsTag reports what is wired', async () => {
  const s = await freshSecrets()
  assert(s.activeSecretsTag() === null, 'reported a provider before init')
  s.initSecrets(keyfileProvider(newDir('active')))
  assert(s.activeSecretsTag() === KEYFILE_TAG, `reported ${s.activeSecretsTag()}`)
})

await test('a malformed tagged value is rejected', async () => {
  const { parseSecret } = await freshSecrets()
  throws(() => parseSecret('v1.nodothere'), /Malformed/, 'accepted a tagged value with no tag')
  throws(() => parseSecret('v1..payload'), /Malformed/, 'accepted an empty tag')
})

// ---------------------------------------------------------------------------

fs.rmSync(tmpRoot, { recursive: true, force: true })

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
