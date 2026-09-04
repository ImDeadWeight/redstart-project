// =============================================================================
// Re-keying stored secrets (trap 5.3) — the step that can lose data silently
// =============================================================================
// Design §3.1's constraint: safeStorage is DPAPI on Windows and DPAPI is bound
// to the user account, so an install that converts to a service account must
// decrypt and re-encrypt WHILE STILL RUNNING AS THE ORIGINAL USER. Afterwards
// is too late, permanently — and the failure is silent, because almost every
// caller of decryptSecret() sits behind a `try`.
//
// That silence is why this suite is written the way it is. Nearly every case
// below asserts something about a FAILURE path rather than the happy one: what
// survives when a secret cannot be read, what is left behind when the write
// fails, what happens when the target already holds someone else's install.
// A migration that works on the good day and eats a credential on the bad one
// is worse than no migration, because it will be trusted.
//
// Both providers are real here — safeStorage stands in as a reversible
// encoding (the same one the Electron stub uses), the key file provider is
// genuine AES-256-GCM against a temp directory.
//
// Run:  node scripts/test-secrets-migration.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { findSecrets, planRekey, applyRekey } from '../electron/main/secrets-migration.mjs'
import { safeStorageProvider } from '../electron/main/secrets-safe-storage.mjs'
import { keyfileProvider } from '../electron/main/secrets-keyfile.mjs'
import { parseRekeyArgs, providerAvailability, formatPlan } from './rekey-secrets.mjs'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-rekey-'))

const results = []

function test(name, fn) {
  try {
    const detail = fn()
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

let caseCount = 0
function newDir(name) {
  const dir = path.join(tmpRoot, `${++caseCount}-${name}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// The old provider: a stand-in for Electron safeStorage, reversible so the
// suite can stage ciphertext without an Electron process.
function oldProvider({ available = true } = {}) {
  return safeStorageProvider({
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(String(s), 'utf8'),
    decryptString: (b) => Buffer.from(b).toString('utf8'),
  })
}

/** A config directory holding the three secret shapes that exist today. */
function stageSource({ legacyUntagged = false } = {}) {
  const dir = newDir('source')
  const from = oldProvider()
  const enc = (v) => (legacyUntagged
    // Exactly what every install shipped before Phase 8A has on disk: bare
    // base64 with no provider tag.
    ? from.encrypt(v)
    : `v1.${from.tag}.${from.encrypt(v)}`)

  fs.writeFileSync(path.join(dir, 'tools.json'), JSON.stringify({
    capabilities: { postgres: { enabled: true, connectionStringEnc: enc('postgres://u:p@host/db') } },
    externalServers: [
      { id: 'a', url: 'https://a.example', apiKeyEnc: enc('key-aaa') },
      { id: 'b', url: 'https://b.example', apiKeyEnc: enc('key-bbb') },
    ],
  }, null, 2))
  fs.writeFileSync(path.join(dir, 'plugins.json'), JSON.stringify({
    plugins: [{ id: 'p1', envEnc: { TOKEN: enc('plugin-token'), OTHER: enc('plugin-other') } }],
  }, null, 2))
  // Not a secret-bearing file, and it must still arrive in the new tree.
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ modelsDir: 'D:/models' }, null, 2))
  // Not a file this module parses at all, and it must STILL arrive: a
  // migration that moves only what it understands produces an install with
  // credentials and nothing else.
  fs.writeFileSync(path.join(dir, 'redstart.log'), 'a log line\n')
  fs.mkdirSync(path.join(dir, 'plugins', 'p1'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'plugins', 'p1', 'manifest.json'), '{}')
  return dir
}

console.log('\n-- finding secrets --')

test('🔍 finds every encrypted value across the state files', () => {
  const found = findSecrets(stageSource())
  // 1 postgres + 2 external MCP keys + 2 plugin env values.
  assert(found.length === 5, `expected 5 secrets, found ${found.length}: ${JSON.stringify(found.map(f => f.pointer.join('.')))}`)
  const files = new Set(found.map(f => f.file))
  assert(files.has('tools.json') && files.has('plugins.json'), `missed a file: ${[...files]}`)
})

test('🔒 the walk is structural, so a secret in an unforeseen shape is still found', () => {
  // The point of not hand-listing the three fields that exist today: a fourth
  // added in six months must not be silently skipped by a migration that then
  // reports success. Over-collecting is loud (it fails the dry run); missing
  // one is silent permanent loss.
  const dir = newDir('unforeseen')
  const from = oldProvider()
  fs.writeFileSync(path.join(dir, 'tools.json'), JSON.stringify({
    somethingNobodyPlanned: { nested: [{ deeply: { futureCredentialEnc: `v1.${from.tag}.${from.encrypt('x')}` } }] },
  }))
  const found = findSecrets(dir)
  assert(found.length === 1, `a nested unforeseen secret was missed: ${JSON.stringify(found)}`)
  assert(found[0].pointer.join('.') === 'somethingNobodyPlanned.nested.0.deeply.futureCredentialEnc',
    `wrong pointer: ${found[0].pointer.join('.')}`)
})

test('reports which provider wrote each secret, including untagged legacy', () => {
  // This is what the Phase 8A.1 tag actually bought — not finding the fields
  // (that is structural), but knowing what wrote each one, including for blobs
  // this process cannot decrypt. Without it, those are indistinguishable from
  // corruption.
  const tagged = findSecrets(stageSource())
  assert(tagged.every(s => s.tag === 'safestorage'), `unexpected tags: ${JSON.stringify(tagged.map(s => s.tag))}`)
  const legacy = findSecrets(stageSource({ legacyUntagged: true }))
  assert(legacy.every(s => s.tag === 'safestorage'),
    `pre-Phase-8 ciphertext was misattributed: ${JSON.stringify(legacy.map(s => s.tag))}`)
})

test('a missing or unparseable state file is skipped, not fatal', () => {
  const dir = newDir('torn')
  fs.writeFileSync(path.join(dir, 'tools.json'), '{"capabilities": {"postgres"')
  assert(findSecrets(dir).length === 0, 'a torn file produced secrets')
})

console.log('\n-- the dry run --')

test('🔍 reports what is readable without writing anything', () => {
  const dir = stageSource()
  const before = fs.readdirSync(dir).sort().join(',')
  const plan = planRekey({ dir, from: oldProvider() })
  assert(plan.total === 5, `expected 5, got ${plan.total}`)
  assert(plan.readable === 5, `expected all readable, got ${plan.readable}`)
  assert(plan.unreadable.length === 0, JSON.stringify(plan.unreadable))
  assert(fs.readdirSync(dir).sort().join(',') === before, 'the dry run changed the directory')
})

test('🔒 an unreadable secret is named individually and does NOT abort the plan', () => {
  // The realistic bad case: the original Windows account is gone, so DPAPI
  // cannot decrypt one stored value. Refusing to convert at all would leave
  // that admin with no path forward but a wipe; naming it lets them re-enter
  // exactly one credential.
  const dir = stageSource()
  const tools = JSON.parse(fs.readFileSync(path.join(dir, 'tools.json'), 'utf8'))
  tools.externalServers[0].apiKeyEnc = 'v1.keyfile.bm90LXJlYWxseS1rZXlmaWxlLWNpcGhlcnRleHQ='
  fs.writeFileSync(path.join(dir, 'tools.json'), JSON.stringify(tools, null, 2))

  const plan = planRekey({ dir, from: oldProvider() })
  assert(plan.total === 5, `expected 5 secrets, got ${plan.total}`)
  assert(plan.readable === 4, `expected 4 readable, got ${plan.readable}`)
  assert(plan.unreadable.length === 1, JSON.stringify(plan.unreadable))
  assert(plan.unreadable[0].pointer === 'externalServers.0.apiKeyEnc', JSON.stringify(plan.unreadable[0]))
  assert(plan.byTag.keyfile === 1, `byTag did not attribute the foreign blob: ${JSON.stringify(plan.byTag)}`)
})

test('🔒 the dry run never puts a decrypted value in its report', () => {
  // A dry-run report is something an admin pastes into a support conversation.
  const dir = stageSource()
  const plan = planRekey({ dir, from: oldProvider() })
  const serialized = JSON.stringify(plan)
  assert(!serialized.includes('postgres://'), 'the report leaked a connection string')
  assert(!serialized.includes('key-aaa'), 'the report leaked an API key')
})

console.log('\n-- applying --')

test('🔍 re-encrypts every secret under the new provider and verifies it', () => {
  const source = stageSource()
  const target = path.join(newDir('applied'), 'config')
  const to = keyfileProvider(target)
  const result = applyRekey({ sourceDir: source, targetDir: target, from: oldProvider(), to })
  assert(result.ok, `migration failed: ${result.error}`)
  assert(result.migrated === 5, `migrated ${result.migrated}`)
  assert(result.verified === 5, `verified ${result.verified}`)

  // Read one back the long way, to prove the value survived rather than merely
  // that something decryptable is present.
  const tools = JSON.parse(fs.readFileSync(path.join(target, 'tools.json'), 'utf8'))
  const stored = tools.capabilities.postgres.connectionStringEnc
  assert(stored.startsWith('v1.keyfile.'), `not re-tagged: ${stored.slice(0, 20)}`)
  assert(to.decrypt(stored.slice('v1.keyfile.'.length)) === 'postgres://u:p@host/db', 'the value changed')
})

test('🔒 the source tree is untouched', () => {
  // The entire safety story: recovery from a failed conversion is "point at
  // the old directory again", which needs no tooling and no explanation.
  const source = stageSource()
  const beforeTools = fs.readFileSync(path.join(source, 'tools.json'), 'utf8')
  const target = path.join(newDir('untouched'), 'config')
  applyRekey({ sourceDir: source, targetDir: target, from: oldProvider(), to: keyfileProvider(target) })
  assert(fs.readFileSync(path.join(source, 'tools.json'), 'utf8') === beforeTools,
    'the migration modified the source tree')
})

test('🔍 everything else in the tree comes too, parsed or not', () => {
  // A migration that moves only the secrets produces an install that has
  // credentials and nothing else.
  const source = stageSource()
  const target = path.join(newDir('whole'), 'config')
  applyRekey({ sourceDir: source, targetDir: target, from: oldProvider(), to: keyfileProvider(target) })
  assert(fs.existsSync(path.join(target, 'settings.json')), 'settings.json did not come across')
  assert(fs.readFileSync(path.join(target, 'redstart.log'), 'utf8') === 'a log line\n', 'the log did not come across')
  assert(fs.existsSync(path.join(target, 'plugins', 'p1', 'manifest.json')), 'a nested directory did not come across')
  assert(JSON.parse(fs.readFileSync(path.join(target, 'settings.json'), 'utf8')).modelsDir === 'D:/models',
    'a non-secret value was altered')
})

test('🔒 an unreadable secret is left exactly as it was, not dropped or blanked', () => {
  // Deleting it would also delete the evidence that a credential used to be
  // configured there — which is what tells an admin what to re-enter.
  const source = stageSource()
  const tools = JSON.parse(fs.readFileSync(path.join(source, 'tools.json'), 'utf8'))
  const foreign = 'v1.keyfile.bm90LXJlYWxseS1rZXlmaWxlLWNpcGhlcnRleHQ='
  tools.externalServers[0].apiKeyEnc = foreign
  fs.writeFileSync(path.join(source, 'tools.json'), JSON.stringify(tools, null, 2))

  const target = path.join(newDir('skipped'), 'config')
  const result = applyRekey({ sourceDir: source, targetDir: target, from: oldProvider(), to: keyfileProvider(target) })
  assert(result.ok, `migration failed: ${result.error}`)
  assert(result.migrated === 4, `migrated ${result.migrated}, expected 4`)
  assert(result.skipped.length === 1, JSON.stringify(result.skipped))
  const out = JSON.parse(fs.readFileSync(path.join(target, 'tools.json'), 'utf8'))
  assert(out.externalServers[0].apiKeyEnc === foreign, 'the unreadable secret was altered or removed')
  assert(out.externalServers[1].apiKeyEnc.startsWith('v1.keyfile.'), 'a readable sibling was not migrated')
})

console.log('\n-- refusals --')

test('🔒 a non-empty target is refused', () => {
  // Converting twice, or into a directory another install owns, is a way to
  // lose the tree that WAS good.
  const source = stageSource()
  const target = newDir('occupied')
  fs.writeFileSync(path.join(target, 'accounts.json'), '{"accounts":[]}')
  const result = applyRekey({ sourceDir: source, targetDir: target, from: oldProvider(), to: keyfileProvider(target) })
  assert(!result.ok, 'overwrote a populated directory')
  assert(/not empty/.test(result.error), result.error)
  assert(fs.readFileSync(path.join(target, 'accounts.json'), 'utf8') === '{"accounts":[]}',
    'the occupant was modified')
})

test('🔒 the same directory for source and target is refused', () => {
  const source = stageSource()
  const result = applyRekey({ sourceDir: source, targetDir: source, from: oldProvider(), to: keyfileProvider(source) })
  assert(!result.ok, 'migrated a directory onto itself')
})

test('🔒 verification catches a target that cannot be read back', () => {
  // The precise disaster this module exists to prevent: writing something the
  // new provider cannot read and reporting success. Staged by handing the
  // migration a provider whose decrypt always fails — the shape of a key file
  // that failed to persist.
  const source = stageSource()
  const target = path.join(newDir('unverifiable'), 'config')
  const brokenTo = {
    tag: 'keyfile',
    encrypt: (v) => Buffer.from(String(v)).toString('base64'),
    decrypt: () => { throw new Error('key file is gone') },
  }
  const result = applyRekey({ sourceDir: source, targetDir: target, from: oldProvider(), to: brokenTo })
  assert(!result.ok, 'reported success for a tree it could not read back')
  assert(/could not be read back/.test(result.error), result.error)
  // And it points at the recovery, because that is the sentence someone needs
  // at the moment they read this.
  assert(result.error.includes(source), `the error does not name the surviving original: ${result.error}`)
})

test('🔒 a failure leaves the source intact and recoverable', () => {
  const source = stageSource()
  const before = fs.readFileSync(path.join(source, 'tools.json'), 'utf8')
  const target = path.join(newDir('failed'), 'config')
  applyRekey({
    sourceDir: source, targetDir: target, from: oldProvider(),
    to: { tag: 'keyfile', encrypt: () => 'x', decrypt: () => { throw new Error('nope') } },
  })
  assert(fs.readFileSync(path.join(source, 'tools.json'), 'utf8') === before,
    'a failed migration damaged the source')
})

console.log('\n-- the round trip that matters --')

test('🔍 a real keyfile daemon can read what a safeStorage install wrote', () => {
  // End to end, with no stubs on the receiving side: after the conversion, a
  // brand-new keyfileProvider over the target directory — which is what nestd
  // constructs at startup — decrypts the values the old install stored.
  const source = stageSource({ legacyUntagged: true })
  const target = path.join(newDir('endtoend'), 'config')
  const result = applyRekey({ sourceDir: source, targetDir: target, from: oldProvider(), to: keyfileProvider(target) })
  assert(result.ok, `migration failed: ${result.error}`)

  const daemonProvider = keyfileProvider(target)
  const plugins = JSON.parse(fs.readFileSync(path.join(target, 'plugins.json'), 'utf8'))
  const stored = plugins.plugins[0].envEnc.TOKEN
  assert(daemonProvider.decrypt(stored.slice('v1.keyfile.'.length)) === 'plugin-token',
    'the daemon could not read a migrated plugin secret')
  return 'pre-Phase-8 ciphertext survives the conversion'
})

console.log('\n-- keyfile to keyfile, verified the way a daemon reads --')

test('🔒 the source key file is never copied into the target', () => {
  // This bug shipped in the first version of this module. fs.cpSync copied the
  // source's secret.key ON TOP of the key the target provider had just
  // created, so every value re-encrypted moments earlier became unreadable.
  const source = newDir('keysrc')
  const sourceProvider = keyfileProvider(source)
  fs.writeFileSync(path.join(source, 'tools.json'), JSON.stringify({
    capabilities: { postgres: { connectionStringEnc: `v1.keyfile.${sourceProvider.encrypt('postgres://old')}` } },
  }, null, 2))

  const target = path.join(newDir('keydst'), 'config')
  const result = applyRekey({ sourceDir: source, targetDir: target, from: sourceProvider, to: keyfileProvider(target) })
  assert(result.ok, `migration failed: ${result.error}`)

  const sourceKey = fs.readFileSync(path.join(source, 'secret.key'))
  const targetKey = fs.readFileSync(path.join(target, 'secret.key'))
  assert(Buffer.compare(sourceKey, targetKey) !== 0,
    'the target is using the SOURCE key file — the copy clobbered the new one')
})

test('🔒 a FRESH provider over the target can read what was written', () => {
  // The assertion that would have caught the bug above, and the reason it is
  // phrased this way: applyRekey's own verification uses the provider it was
  // handed, which had the new key CACHED IN MEMORY. It read through the cache
  // and never touched the key file that had just been overwritten — so it
  // reported "verified" over a tree the daemon could not open.
  //
  // A daemon starting up has no cache. It constructs a provider from whatever
  // is on disk, which is what this does.
  const source = newDir('freshsrc')
  const sourceProvider = keyfileProvider(source)
  fs.writeFileSync(path.join(source, 'tools.json'), JSON.stringify({
    capabilities: { postgres: { connectionStringEnc: `v1.keyfile.${sourceProvider.encrypt('postgres://value')}` } },
  }, null, 2))
  fs.writeFileSync(path.join(source, 'plugins.json'), JSON.stringify({
    plugins: [{ id: 'p1', envEnc: { TOKEN: `v1.keyfile.${sourceProvider.encrypt('tok')}` } }],
  }, null, 2))

  const target = path.join(newDir('freshdst'), 'config')
  const result = applyRekey({ sourceDir: source, targetDir: target, from: sourceProvider, to: keyfileProvider(target) })
  assert(result.ok, `migration failed: ${result.error}`)

  const asDaemonWould = keyfileProvider(target)
  const tools = JSON.parse(fs.readFileSync(path.join(target, 'tools.json'), 'utf8'))
  const stored = tools.capabilities.postgres.connectionStringEnc
  assert(asDaemonWould.decrypt(stored.slice('v1.keyfile.'.length)) === 'postgres://value',
    'a daemon reading the migrated tree from disk could not decrypt it')

  const plugins = JSON.parse(fs.readFileSync(path.join(target, 'plugins.json'), 'utf8'))
  assert(asDaemonWould.decrypt(plugins.plugins[0].envEnc.TOKEN.slice('v1.keyfile.'.length)) === 'tok',
    'a daemon could not decrypt a migrated plugin secret')
  return 'the case the in-memory key cache hid'
})

console.log('\n-- the operator CLI (scripts/rekey-secrets.mjs) --')

test('🔒 refuses to run under plain node against a safeStorage tree', () => {
  // The refusal that matters most. Reporting "0 of 12 secrets readable" from a
  // plain-node process is technically accurate and completely misleading: it
  // looks exactly like a corrupted install, and the reasonable conclusion from
  // it — "the credentials are gone, start over" — is wrong and destructive.
  const denied = providerAvailability('safestorage', false)
  assert(denied.ok === false, 'plain node claimed it could read DPAPI ciphertext')
  assert(/electron/i.test(denied.error), `the refusal does not say what to do: ${denied.error}`)

  assert(providerAvailability('safestorage', true).ok, 'refused under Electron')
  // keyfile ciphertext needs no keychain, so plain node is fine there.
  assert(providerAvailability('keyfile', false).ok, 'refused a keyfile source under plain node')
})

test('🔒 refuses source and target being the same directory', () => {
  const args = parseRekeyArgs(['--source', '/nest/config', '--target', '/nest/config'])
  assert(args.error, 'accepted a migration onto itself')
})

test('both directories are required, and named', () => {
  assert(parseRekeyArgs([]).error, 'accepted no arguments')
  assert(/source/.test(parseRekeyArgs(['--target', '/b']).error), 'did not name the missing --source')
  assert(/target/.test(parseRekeyArgs(['--source', '/a']).error), 'did not name the missing --target')
})

test('a flag with no value is refused rather than swallowing the next flag', () => {
  // `--source --apply` must not resolve a directory called "--apply".
  const args = parseRekeyArgs(['--source', '--apply', '--target', '/b'])
  assert(args.error, `swallowed the next flag as a value: ${JSON.stringify(args)}`)
})

test('unknown arguments are refused, never ignored', () => {
  // Ignoring a typo'd flag on a tool that writes a directory is how somebody
  // runs the apply step believing they ran the dry run.
  assert(parseRekeyArgs(['--source', '/a', '--target', '/b', '--aply']).error, 'ignored a misspelled flag')
})

test('🔒 the dry run is the default; --apply is explicit', () => {
  assert(parseRekeyArgs(['--source', '/a', '--target', '/b']).apply === false,
    'defaulted to writing')
  assert(parseRekeyArgs(['--source', '/a', '--target', '/b', '--apply']).apply === true,
    '--apply did not take effect')
})

test('--from accepts only the two real providers', () => {
  assert(parseRekeyArgs(['--source', '/a', '--target', '/b', '--from', 'dpapi']).error,
    'accepted a provider name that does not exist')
  assert(!parseRekeyArgs(['--source', '/a', '--target', '/b', '--from', 'keyfile']).error, 'refused keyfile')
})

test('the plan summary never contains a decrypted value', () => {
  const dir = stageSource()
  const rendered = formatPlan(planRekey({ dir, from: oldProvider() }))
  assert(!rendered.includes('postgres://'), 'the printed summary leaked a connection string')
  assert(!rendered.includes('key-aaa'), 'the printed summary leaked an API key')
  assert(/secrets found:\s+5/.test(rendered), `unexpected summary:\n${rendered}`)
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
