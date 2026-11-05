// =============================================================================
// Where the desktop shell gets the secrets key, and why Local State is read once
// =============================================================================
// shell-secrets-key.mjs pins the OSCrypt key in a Nest-owned file. This suite
// pins the selection rules, with a fake DPAPI so they run anywhere:
//
//   - an existing install's Local State key is carried over unchanged (same
//     key, so no secret is re-keyed);
//   - a fresh install gets a generated key. Measured: Electron leaves Local
//     State without a key until it exits, so this is the first-run path;
//   - after the first run, ONLY the pinned file counts: a different key
//     appearing in Local State later (Chromium makes one for cookies) must
//     not change the secrets key;
//   - a carried key that cannot be unwrapped fails before anything is pinned.
//
// On Windows it also runs the REAL PowerShell DPAPI path end to end.
//
// Run:  node scripts/test-shell-secrets-key.mjs
// =============================================================================

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveSecretsKey, powershellDpapi, SECRETS_KEY_FILE } from '../daemon/shell-secrets-key.mjs'

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

// A stand-in for DPAPI: reversible, and refuses blobs it did not make.
const MAGIC = Buffer.from('FAKEDPAPI')
const fakeDpapi = {
  protect: (b) => Buffer.concat([MAGIC, Buffer.from(b).map((x) => x ^ 0x5a)]),
  unprotect: (b) => {
    if (!b.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not ours')
    return Buffer.from(b.subarray(MAGIC.length)).map((x) => x ^ 0x5a)
  },
}
const localStateWith = (dir, rawKey) => fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify({
  os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), fakeDpapi.protect(rawKey)]).toString('base64') },
  browser: { other: true },
}))

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-shellkey-'))
let n = 0
const fresh = () => { const d = path.join(root, `c${n++}`); fs.mkdirSync(d); return d }

console.log('\n-- selecting the key --')

await test('🔍 an existing install\'s Local State key is carried over unchanged, and pinned', () => {
  const dir = fresh()
  const original = crypto.randomBytes(32)
  localStateWith(dir, original)
  const r = resolveSecretsKey(dir, fakeDpapi)
  assert(r.source === 'local-state' && r.key.equals(original), `source ${r.source}, key changed: ${!r.key.equals(original)}`)
  const pinned = JSON.parse(fs.readFileSync(path.join(dir, SECRETS_KEY_FILE), 'utf8'))
  assert(pinned.source === 'local-state', 'pinned file does not record its source')
  assert(fs.existsSync(path.join(dir, 'Local State')), 'Local State was touched')
})

await test('🔍 a fresh install (no key in Local State) gets a generated key, pinned', () => {
  const dir = fresh()
  fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify({ browser: {} })) // Electron's first-run state
  const r = resolveSecretsKey(dir, fakeDpapi)
  assert(r.source === 'generated' && r.key.length === 32, `source ${r.source}`)
  const again = resolveSecretsKey(dir, fakeDpapi)
  assert(again.source === 'pinned' && again.key.equals(r.key), 'second run did not return the same key from the pinned file')
})

await test('🔍 once pinned, a different key appearing in Local State is ignored', () => {
  const dir = fresh()
  const first = resolveSecretsKey(dir, fakeDpapi) // generated
  localStateWith(dir, crypto.randomBytes(32)) // Chromium later makes its own cookie key
  const later = resolveSecretsKey(dir, fakeDpapi)
  assert(later.source === 'pinned' && later.key.equals(first.key), 'Local State changed the secrets key after pinning')
})

await test('a carried key this account cannot unwrap fails, and nothing is pinned', () => {
  const dir = fresh()
  fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify({
    os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), crypto.randomBytes(40)]).toString('base64') },
  }))
  let threw = false
  try { resolveSecretsKey(dir, fakeDpapi) } catch { threw = true }
  assert(threw, 'an unreadable carried key did not fail')
  assert(!fs.existsSync(path.join(dir, SECRETS_KEY_FILE)), 'an unreadable key was pinned')
})

await test('an unwrapped key of the wrong length is refused', () => {
  const dir = fresh()
  localStateWith(dir, crypto.randomBytes(16))
  let threw = null
  try { resolveSecretsKey(dir, fakeDpapi) } catch (e) { threw = e }
  assert(threw && /16 bytes/.test(threw.message), `not refused: ${threw?.message}`)
})

await test('no config dir yet: it is created, and a key generated', () => {
  const dir = path.join(root, 'not-yet', 'redstart')
  const r = resolveSecretsKey(dir, fakeDpapi)
  assert(r.source === 'generated' && fs.existsSync(path.join(dir, SECRETS_KEY_FILE)), 'not created')
})

if (process.platform === 'win32') {
  console.log('\n-- the real DPAPI (Windows) --')
  await test('🔍 PowerShell ProtectedData: generate, pin, and read back the same key', () => {
    const dir = fresh()
    const r = resolveSecretsKey(dir, powershellDpapi)
    const again = resolveSecretsKey(dir, powershellDpapi)
    assert(r.source === 'generated' && again.source === 'pinned' && again.key.equals(r.key), 'real DPAPI round trip failed')
    return 'CurrentUser scope'
  })
  await test('a Local State key wrapped by real DPAPI is carried over', () => {
    const dir = fresh()
    const raw = crypto.randomBytes(32)
    fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify({
      os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), powershellDpapi.protect(raw)]).toString('base64') },
    }))
    const r = resolveSecretsKey(dir, powershellDpapi)
    assert(r.source === 'local-state' && r.key.equals(raw), 'real carried key differs')
  })
} else {
  console.log('\n  SKIP - real DPAPI cases (not Windows)')
}

fs.rmSync(root, { recursive: true, force: true })
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed\n`)
if (passed !== results.length) process.exit(1)
