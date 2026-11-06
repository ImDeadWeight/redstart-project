#!/usr/bin/env node
// =============================================================================
// The Tauri builds' release assets, and both update manifests
// =============================================================================
// After `tauri build` (daemon split T3). Each platform's build job writes
// its assets plus a FRAGMENT of the Tauri manifest. The release job, which
// has every platform's files, merges the fragments into nest-latest.json.
//
// windows  Redstart-Nest-Setup-<v>.exe      the NSIS installer, renamed to
//                                           the name every release has used
//                                           (GitHub rewrites spaces)
//          nest-latest.windows-x86_64.json  fragment: URL + minisign signature
//          nest.yml                         what ELECTRON installs read
//                                           (electron-updater's generic
//                                           provider): the same installer and
//                                           its sha512. This is the bridge.
// macos    Redstart-Nest-<v>-arm64.dmg      what a person downloads
//          Redstart-Nest-<v>-arm64.app.tar.gz
//                                           what the updater downloads
//          nest-latest.darwin-aarch64.json  fragment
// merge    nest-latest.json                 from the fragments in <outDir>,
//                                           which are then removed
//
// update-feed.mjs picks a release by the manifest it carries: Electron
// installs look for nest.yml, Tauri installs for nest-latest.json. Keep
// publishing nest.yml for a few releases after the bridge (T4 retires it).
// Electron on a Mac never self-updated (Squirrel.Mac needs a Developer ID),
// so there is no Mac nest.yml. Mac users move to the Tauri app by
// installing the .dmg once.
//
//   node scripts/make-shell-manifests.mjs windows <version> <setup.exe> <outDir>
//   node scripts/make-shell-manifests.mjs macos <version> <app.dmg> <app.tar.gz> <outDir>
//   node scripts/make-shell-manifests.mjs merge <outDir>
// (every updater artifact needs its <file>.sig beside it)
// =============================================================================

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { UPDATE_REPO, feedUrlForTag } from '../../shared/update-feed.mjs'

export const MANIFEST = 'nest-latest.json'
export const installerName = (version) => `Redstart-Nest-Setup-${version}.exe`
export const dmgName = (version) => `Redstart-Nest-${version}-arm64.dmg`
export const macUpdateName = (version) => `Redstart-Nest-${version}-arm64.app.tar.gz`
const fragmentName = (platformKey) => `nest-latest.${platformKey}.json`

function checkVersion(version) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) throw new Error(`Not a version: ${version}`)
}

function readSig(artifact) {
  const sigPath = `${artifact}.sig`
  if (!fs.existsSync(artifact)) throw new Error(`No build output at ${artifact}`)
  if (!fs.existsSync(sigPath)) throw new Error(`No signature at ${sigPath}: was TAURI_SIGNING_PRIVATE_KEY set for the build?`)
  return fs.readFileSync(sigPath, 'utf8').trim()
}

function writeFragment(outDir, { version, platformKey, signature, url }) {
  fs.writeFileSync(path.join(outDir, fragmentName(platformKey)),
    JSON.stringify({ version, platformKey, signature, url }, null, 2) + '\n')
}

/**
 * electron-updater's latest.yml shape, written by hand (no YAML dependency:
 * every value is a version, a file name, a base64 hash, a number or an ISO
 * date, and only the date needs quoting).
 */
export function electronYml({ version, file, sha512, size, releaseDate }) {
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${file}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${file}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    '',
  ].join('\n')
}

export function windowsAssets({ version, installer, outDir, now = new Date(), repo = UPDATE_REPO }) {
  checkVersion(version)
  const signature = readSig(installer)
  fs.mkdirSync(outDir, { recursive: true })
  const file = installerName(version)
  fs.copyFileSync(installer, path.join(outDir, file))
  const bytes = fs.readFileSync(path.join(outDir, file))
  const sha512 = crypto.createHash('sha512').update(bytes).digest('base64')
  // The release is tagged with the version (release.yml, `gh release create`).
  writeFragment(outDir, { version, platformKey: 'windows-x86_64', signature, url: feedUrlForTag(version, repo) + file })
  fs.writeFileSync(path.join(outDir, 'nest.yml'),
    electronYml({ version, file, sha512, size: bytes.length, releaseDate: now.toISOString() }))
  return { file, sha512, size: bytes.length }
}

export function macosAssets({ version, dmg, appTarGz, outDir, repo = UPDATE_REPO }) {
  checkVersion(version)
  const signature = readSig(appTarGz)
  if (!fs.existsSync(dmg)) throw new Error(`No build output at ${dmg}`)
  fs.mkdirSync(outDir, { recursive: true })
  fs.copyFileSync(dmg, path.join(outDir, dmgName(version)))
  fs.copyFileSync(appTarGz, path.join(outDir, macUpdateName(version)))
  writeFragment(outDir, { version, platformKey: 'darwin-aarch64', signature, url: feedUrlForTag(version, repo) + macUpdateName(version) })
  return { dmg: dmgName(version), update: macUpdateName(version) }
}

/** Tauri's static manifest from every fragment in outDir. All must agree on the version. */
export function mergeManifests({ outDir, now = new Date(), notes = '' }) {
  const fragments = fs.readdirSync(outDir).filter((f) => /^nest-latest\.[a-z0-9_-]+\.json$/.test(f))
  if (fragments.length === 0) throw new Error(`No manifest fragments in ${outDir}`)
  const platforms = {}
  let version = null
  for (const f of fragments) {
    const frag = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'))
    if (version && frag.version !== version) throw new Error(`Fragments disagree on the version: ${version} vs ${frag.version}`)
    version = frag.version
    // The updater tries "<os>-<arch>-<installer>" then "<os>-<arch>".
    platforms[frag.platformKey] = { signature: frag.signature, url: frag.url }
  }
  const manifest = { version, notes, pub_date: now.toISOString(), platforms }
  fs.writeFileSync(path.join(outDir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n')
  for (const f of fragments) fs.rmSync(path.join(outDir, f))
  return manifest
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...a] = process.argv.slice(2)
  try {
    if (mode === 'windows') {
      const r = windowsAssets({ version: a[0], installer: a[1], outDir: a[2] })
      console.log(`Wrote ${r.file} (${r.size} bytes), nest.yml and the windows fragment to ${a[2]}`)
    } else if (mode === 'macos') {
      const r = macosAssets({ version: a[0], dmg: a[1], appTarGz: a[2], outDir: a[3] })
      console.log(`Wrote ${r.dmg}, ${r.update} and the macOS fragment to ${a[3]}`)
    } else if (mode === 'merge') {
      const m = mergeManifests({ outDir: a[0] })
      console.log(`Wrote ${MANIFEST} for ${m.version}: ${Object.keys(m.platforms).join(', ')}`)
    } else {
      throw new Error('usage: make-shell-manifests.mjs windows|macos|merge …')
    }
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}
