#!/usr/bin/env node
// =============================================================================
// The Tauri installer's release assets, and both update manifests
// =============================================================================
// After `tauri build` (daemon split T3). Puts three files in <outDir>:
//
//   Redstart-Nest-Setup-<version>.exe   the NSIS installer, renamed to the
//                                       name every release has used (GitHub
//                                       rewrites spaces in asset names)
//   nest-latest.json                    what the Tauri shell's updater reads:
//                                       the version, the installer URL, and
//                                       its minisign signature (.sig from the
//                                       build, made with the CI secret key)
//   nest.yml                            what ELECTRON installs read
//                                       (electron-updater's generic provider):
//                                       the same installer and its sha512.
//                                       This is the bridge. An Electron
//                                       install updates to the Tauri
//                                       installer, whose hooks replace it.
//
// Both manifests point at the same file. update-feed.mjs picks a release by
// which manifest it carries, so Electron installs look for nest.yml and
// Tauri installs for nest-latest.json. Keep publishing nest.yml for a few
// releases after the bridge, for installs that skip one (T4 retires it).
//
//   node scripts/make-shell-manifests.mjs <version> <installer.exe> <outDir>
//   (expects <installer.exe>.sig beside the installer)
// =============================================================================

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { UPDATE_REPO, feedUrlForTag } from '../electron/main/update-feed.mjs'

export const installerName = (version) => `Redstart-Nest-Setup-${version}.exe`

/** Tauri's static update manifest (tauri-plugin-updater). */
export function tauriManifest({ version, signature, url, pubDate, notes = '' }) {
  return {
    version,
    notes,
    pub_date: pubDate,
    platforms: {
      // The updater tries "<os>-<arch>-<installer>" then "<os>-<arch>".
      'windows-x86_64': { signature, url },
    },
  }
}

/**
 * electron-updater's latest.yml shape, written by hand (no YAML dependency:
 * every value here is a version, a file name, a base64 hash, a number or an
 * ISO date, none of which need quoting beyond the date).
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

export function makeManifests({ version, installer, outDir, now = new Date(), repo = UPDATE_REPO }) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Not a version: ${version}`)
  const sigPath = `${installer}.sig`
  if (!fs.existsSync(installer)) throw new Error(`No installer at ${installer}`)
  if (!fs.existsSync(sigPath)) throw new Error(`No signature at ${sigPath}: was TAURI_SIGNING_PRIVATE_KEY set for the build?`)

  fs.mkdirSync(outDir, { recursive: true })
  const file = installerName(version)
  const target = path.join(outDir, file)
  fs.copyFileSync(installer, target)

  const bytes = fs.readFileSync(target)
  const sha512 = crypto.createHash('sha512').update(bytes).digest('base64')
  const iso = now.toISOString()

  const manifest = tauriManifest({
    version,
    signature: fs.readFileSync(sigPath, 'utf8').trim(),
    // The release is tagged with the version (release.yml, `gh release create`).
    url: feedUrlForTag(version, repo) + file,
    pubDate: iso,
  })
  fs.writeFileSync(path.join(outDir, 'nest-latest.json'), JSON.stringify(manifest, null, 2) + '\n')
  fs.writeFileSync(path.join(outDir, 'nest.yml'), electronYml({ version, file, sha512, size: bytes.length, releaseDate: iso }))
  return { file, sha512, size: bytes.length }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, installer, outDir] = process.argv.slice(2)
  try {
    const r = makeManifests({ version, installer, outDir })
    console.log(`Wrote ${r.file} (${r.size} bytes), nest-latest.json and nest.yml to ${outDir}`)
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}
