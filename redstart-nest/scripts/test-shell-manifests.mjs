// =============================================================================
// The Tauri release assets and both update manifests (make-shell-manifests.mjs)
// =============================================================================
// The bridge release lives or dies on these two files: nest.yml is what
// every Electron install reads, and nest-latest.json is what every Tauri
// install reads after it. Both must name the same installer, and each must be
// what its updater accepts.
//
// Run:  node scripts/test-shell-manifests.mjs
// =============================================================================

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { makeManifests, installerName } from './make-shell-manifests.mjs'
import { pickUpdateRelease } from '../electron/main/update-feed.mjs'

const results = []
function test(name, fn) {
  try {
    const detail = fn()
    results.push({ name, pass: true })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}
function assert(cond, message) { if (!cond) throw new Error(message) }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-manifests-'))
const built = path.join(tmp, 'Redstart Nest_1.0.0-alpha.7_x64-setup.exe')
fs.writeFileSync(built, Buffer.from('MZ fake installer bytes'))
fs.writeFileSync(`${built}.sig`, 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQ==\n')
const out = path.join(tmp, 'out')
const now = new Date('2026-11-05T21:00:00.000Z')
const r = makeManifests({ version: '1.0.0-alpha.7', installer: built, outDir: out, now })

test('🔍 the installer keeps the asset name every release has used', () => {
  assert(r.file === 'Redstart-Nest-Setup-1.0.0-alpha.7.exe' && r.file === installerName('1.0.0-alpha.7'), r.file)
  assert(fs.existsSync(path.join(out, r.file)), 'not copied')
})

test('🔍 nest-latest.json carries the signature and a URL inside this release', () => {
  const m = JSON.parse(fs.readFileSync(path.join(out, 'nest-latest.json'), 'utf8'))
  assert(m.version === '1.0.0-alpha.7', `version ${m.version}`)
  const p = m.platforms['windows-x86_64']
  assert(p.signature === 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQ==', 'signature not the .sig contents (trimmed)')
  assert(p.url === 'https://github.com/ImDeadWeight/redstart-project/releases/download/1.0.0-alpha.7/Redstart-Nest-Setup-1.0.0-alpha.7.exe', p.url)
  assert(m.pub_date === now.toISOString(), 'pub_date')
})

test('🔍 nest.yml names the same file, with its real sha512 and size (the bridge)', () => {
  const yml = fs.readFileSync(path.join(out, 'nest.yml'), 'utf8')
  const bytes = fs.readFileSync(path.join(out, r.file))
  const sha = crypto.createHash('sha512').update(bytes).digest('base64')
  assert(yml.includes(`version: 1.0.0-alpha.7\n`), 'version line')
  assert(yml.includes(`  - url: ${r.file}\n    sha512: ${sha}\n    size: ${bytes.length}\n`), 'files entry')
  assert(yml.includes(`path: ${r.file}\nsha512: ${sha}\n`), 'path/sha512')
  assert(yml.includes(`releaseDate: '${now.toISOString()}'`), 'releaseDate')
})

test('🔍 a bridge release is found by BOTH updaters', () => {
  const release = { tag_name: '1.0.0-alpha.7', draft: false, assets: fs.readdirSync(out).map((name) => ({ name })) }
  assert(pickUpdateRelease([release], { currentVersion: '1.0.0-alpha.6' })?.tag === '1.0.0-alpha.7', 'Electron (nest.yml) misses it')
  assert(pickUpdateRelease([release], { currentVersion: '1.0.0-alpha.6', manifest: 'nest-latest.json' })?.tag === '1.0.0-alpha.7', 'Tauri misses it')
})

test('a build without a signature is refused, not published unsigned', () => {
  fs.rmSync(`${built}.sig`)
  let err = null
  try { makeManifests({ version: '1.0.0-alpha.7', installer: built, outDir: path.join(tmp, 'o2'), now }) } catch (e) { err = e }
  assert(err && /No signature/.test(err.message), `expected a refusal, got ${err?.message}`)
})

fs.rmSync(tmp, { recursive: true, force: true })
const passed = results.filter((x) => x.pass).length
console.log(`\n${passed}/${results.length} passed\n`)
if (passed !== results.length) process.exit(1)
