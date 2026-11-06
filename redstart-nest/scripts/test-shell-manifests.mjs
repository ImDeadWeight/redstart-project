// =============================================================================
// The Tauri release assets and both update manifests (make-shell-manifests.mjs)
// =============================================================================
// The bridge release lives or dies on these files: nest.yml is what every
// Electron install reads, and nest-latest.json is what every Tauri install
// reads after it. Each must be what its updater accepts, and the merged
// Tauri manifest must carry both platforms from builds made on different
// machines.
//
// Run:  node scripts/test-shell-manifests.mjs
// =============================================================================

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { windowsAssets, macosAssets, mergeManifests, installerName, dmgName, macUpdateName } from './make-shell-manifests.mjs'
import { pickUpdateRelease } from '../../shared/update-feed.mjs'

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

const V = '1.0.0-alpha.7'
const BASE = `https://github.com/ImDeadWeight/redstart-project/releases/download/${V}/`
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-manifests-'))
const now = new Date('2026-11-05T21:00:00.000Z')
const make = (name, body, sig) => {
  const p = path.join(tmp, name)
  fs.writeFileSync(p, Buffer.from(body))
  if (sig) fs.writeFileSync(`${p}.sig`, `${sig}\n`)
  return p
}
const setup = make(`Redstart Nest_${V}_x64-setup.exe`, 'MZ fake installer bytes', 'V0lOU0lH')
const dmg = make(`Redstart Nest_${V}_aarch64.dmg`, 'fake dmg')
const tgz = make('Redstart Nest.app.tar.gz', 'fake app tarball', 'TUFDU0lH')

// Each build job writes into its own folder; the release job's download
// merges them into one.
const winOut = path.join(tmp, 'win'), macOut = path.join(tmp, 'mac'), rel = path.join(tmp, 'release')
const w = windowsAssets({ version: V, installer: setup, outDir: winOut, now })
const m = macosAssets({ version: V, dmg, appTarGz: tgz, outDir: macOut })
fs.mkdirSync(rel)
for (const d of [winOut, macOut]) for (const f of fs.readdirSync(d)) fs.copyFileSync(path.join(d, f), path.join(rel, f))
const manifest = mergeManifests({ outDir: rel, now })

test('🔍 asset names: the Windows installer keeps the name every release has used', () => {
  assert(w.file === installerName(V) && w.file === `Redstart-Nest-Setup-${V}.exe`, w.file)
  assert(m.dmg === dmgName(V) && m.update === macUpdateName(V), JSON.stringify(m))
  for (const f of [w.file, m.dmg, m.update]) assert(fs.existsSync(path.join(rel, f)), `${f} missing`)
})

test('🔍 nest-latest.json carries both platforms, each signed, each inside this release', () => {
  assert(manifest.version === V && manifest.pub_date === now.toISOString(), 'version/pub_date')
  const win = manifest.platforms['windows-x86_64'], mac = manifest.platforms['darwin-aarch64']
  assert(win?.signature === 'V0lOU0lH' && win.url === BASE + installerName(V), JSON.stringify(win))
  assert(mac?.signature === 'TUFDU0lH' && mac.url === BASE + macUpdateName(V), JSON.stringify(mac))
  const onDisk = JSON.parse(fs.readFileSync(path.join(rel, 'nest-latest.json'), 'utf8'))
  assert(JSON.stringify(onDisk) === JSON.stringify(manifest), 'file differs from the returned manifest')
  assert(!fs.readdirSync(rel).some((f) => /^nest-latest\..+\.json$/.test(f)), 'fragments were published too')
})

test('🔍 nest.yml names the Windows installer with its real sha512 and size (the bridge)', () => {
  const yml = fs.readFileSync(path.join(rel, 'nest.yml'), 'utf8')
  const bytes = fs.readFileSync(path.join(rel, w.file))
  const sha = crypto.createHash('sha512').update(bytes).digest('base64')
  assert(yml.includes(`version: ${V}\n`), 'version line')
  assert(yml.includes(`  - url: ${w.file}\n    sha512: ${sha}\n    size: ${bytes.length}\n`), 'files entry')
  assert(yml.includes(`path: ${w.file}\nsha512: ${sha}\n`), 'path/sha512')
  assert(yml.includes(`releaseDate: '${now.toISOString()}'`), 'releaseDate')
})

test('🔍 the release is found by BOTH updaters', () => {
  const release = { tag_name: V, draft: false, assets: fs.readdirSync(rel).map((name) => ({ name })) }
  assert(pickUpdateRelease([release], { currentVersion: '1.0.0-alpha.6' })?.tag === V, 'Electron (nest.yml) misses it')
  assert(pickUpdateRelease([release], { currentVersion: '1.0.0-alpha.6', manifest: 'nest-latest.json' })?.tag === V, 'Tauri misses it')
})

test('fragments from different versions are refused, not merged', () => {
  const d = path.join(tmp, 'mixed')
  fs.mkdirSync(d)
  fs.writeFileSync(path.join(d, 'nest-latest.windows-x86_64.json'), JSON.stringify({ version: V, platformKey: 'windows-x86_64', signature: 's', url: 'u' }))
  fs.writeFileSync(path.join(d, 'nest-latest.darwin-aarch64.json'), JSON.stringify({ version: '1.0.0-alpha.8', platformKey: 'darwin-aarch64', signature: 's', url: 'u' }))
  let err = null
  try { mergeManifests({ outDir: d, now }) } catch (e) { err = e }
  assert(err && /disagree/.test(err.message), `expected a refusal, got ${err?.message}`)
})

test('a build without a signature is refused, not published unsigned', () => {
  fs.rmSync(`${setup}.sig`)
  fs.rmSync(`${tgz}.sig`)
  for (const run of [
    () => windowsAssets({ version: V, installer: setup, outDir: path.join(tmp, 'o1'), now }),
    () => macosAssets({ version: V, dmg, appTarGz: tgz, outDir: path.join(tmp, 'o2') }),
  ]) {
    let err = null
    try { run() } catch (e) { err = e }
    assert(err && /No signature/.test(err.message), `expected a refusal, got ${err?.message}`)
  }
})

fs.rmSync(tmp, { recursive: true, force: true })
const passed = results.filter((x) => x.pass).length
console.log(`\n${passed}/${results.length} passed\n`)
if (passed !== results.length) process.exit(1)
