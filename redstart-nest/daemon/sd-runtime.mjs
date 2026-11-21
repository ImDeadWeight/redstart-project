'use strict'

// =============================================================================
// Redstart Nest — the pinned image engine (stable-diffusion.cpp) behind
// generate_image
// =============================================================================
// Downloaded on first use, never bundled (plan decision U-IG1): the CUDA
// build is ~975 MB with its runtime, and most installs will never generate an
// image.
//
// THE PIN. One release of leejet/stable-diffusion.cpp, every asset's size and
// sha256 written below (taken from GitHub's own digests, and checked against
// local downloads on 2026-11-20). Bumping it means changing SD_RELEASE and
// every asset in one commit, then re-running a real generation (the CLI's
// flags move between releases: see sd-job.mjs's buildSdArgs).
//
// THE BUILD. CUDA on a machine with an NVIDIA GPU (2x faster than Vulkan on
// the RTX 3060: 17 s vs 37 s for Flux schnell at 1024², plan §8), Vulkan on
// every other Windows/Linux GPU (30 MB), Metal on Apple Silicon. The admin
// can force one (imageGeneration.backend in the capability config).
//
// THE FETCH. https only, github.com/leejet/stable-diffusion.cpp/releases/
// download/<this tag>/ and the GitHub release-asset hosts its redirect goes
// to; checked on every hop (http-redirects.mjs), the way model downloads are
// held to Hugging Face. Each zip is verified against its sha256 BEFORE it is
// opened, extracted flat (an entry with a path in its name is refused) into a
// staging folder, and the folder renamed into place only once the binary is
// there.
// =============================================================================

import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'
import { execFile } from 'child_process'
import { downloadFile } from './model-download.mjs'
import { readZip } from './zip.mjs'
import { logEvent } from './logger.mjs'

export const SD_RELEASE = 'master-1106-532d2c1'
const RELEASE_PATH = `/leejet/stable-diffusion.cpp/releases/download/${SD_RELEASE}/`
const RELEASE_BASE = `https://github.com${RELEASE_PATH}`

/**
 * Every build Nest can install. `assets` are extracted into one folder, in
 * order. Exported for the suite.
 */
export const SD_BUILDS = {
  'win32-x64-cuda': {
    label: 'CUDA 12 (NVIDIA)',
    binary: 'sd-cli.exe',
    assets: [
      { file: 'sd-master-532d2c1-bin-win-cuda12-x64.zip', size: 412365497, sha256: 'b087219145a382cc1b1e826318289e1f672b9bb6965977734ef0deb85fe2d03a' },
      { file: 'cudart-sd-bin-win-cu12-x64.zip', size: 563452046, sha256: 'fe20366827d357c00797eebb58244dddab7fd9a348d70090c3871004c320f38d' },
    ],
  },
  'win32-x64-vulkan': {
    label: 'Vulkan (any GPU)',
    binary: 'sd-cli.exe',
    assets: [
      { file: 'sd-master-532d2c1-bin-win-vulkan-x64.zip', size: 30312081, sha256: '3e66222c87ca27074e1fd8ce79706eef17a8aaf39949906aa1bee7e060f22ecc' },
    ],
  },
  'linux-x64-vulkan': {
    label: 'Vulkan (any GPU)',
    binary: 'sd-cli',
    assets: [
      { file: 'sd-master-532d2c1-bin-Linux-Ubuntu-26.04-x86_64-vulkan.zip', size: 42212329, sha256: 'ca30fe17f1735cdfb4c8561b75799070c25cc86a9e5438f4c0e1b163baae4e12' },
    ],
  },
  'darwin-arm64-metal': {
    label: 'Metal (Apple Silicon)',
    binary: 'sd-cli',
    assets: [
      { file: 'sd-master-532d2c1-bin-Darwin-macOS-26.7.2-arm64.zip', size: 38331254, sha256: '8146d6ffc75f8ff8f64b62a80fffee8fb714ab65e368e202084135fa07cc6f36' },
    ],
  },
}

/**
 * The build for this machine, or null where there is none.
 *
 * @param {{ platform?: string, arch?: string, nvidia?: boolean, backend?: 'auto'|'cuda'|'vulkan'|'metal' }} [opts]
 */
export function chooseSdBuild({ platform = process.platform, arch = process.arch, nvidia = false, backend = 'auto' } = {}) {
  if (platform === 'win32' && arch === 'x64') {
    if (backend === 'vulkan') return 'win32-x64-vulkan'
    if (backend === 'cuda' || (backend === 'auto' && nvidia)) return 'win32-x64-cuda'
    return 'win32-x64-vulkan'
  }
  if (platform === 'linux' && arch === 'x64') return 'linux-x64-vulkan'
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64-metal'
  return null
}

/**
 * Whether an NVIDIA GPU and driver are present: `nvidia-smi -L` runs and
 * lists a GPU. The same signal the hardware scan uses. Never throws.
 */
export function hasNvidiaGpu({ timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    try {
      execFile('nvidia-smi', ['-L'], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        resolve(!err && /^GPU \d+:/m.test(String(stdout)))
      })
    } catch {
      resolve(false)
    }
  })
}

/**
 * The only addresses the install may fetch, redirect hops included: https,
 * this release's download path on github.com, or GitHub's release-asset
 * hosts that path redirects to. Exported for the suite.
 */
export function isSdReleaseUrl(url) {
  let u
  try { u = new URL(url) } catch { return false }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false
  if (u.hostname === 'github.com') return u.pathname.startsWith(RELEASE_PATH) && !u.pathname.includes('..')
  return u.hostname === 'objects.githubusercontent.com' || u.hostname === 'release-assets.githubusercontent.com'
}

/** `<config>/runtimes/sd-<release>-<build>/` */
export function sdRuntimeDir(baseDir, buildKey) {
  return path.join(baseDir, 'runtimes', `sd-${SD_RELEASE}-${buildKey}`)
}

const INSTALL_RECORD = 'install.json'

/**
 * What is installed for `buildKey`.
 *
 * @returns {{ installed: boolean, buildKey: string, label: string, binaryPath: string|null, downloadBytes: number }}
 */
export function sdRuntimeStatus(baseDir, buildKey) {
  const build = SD_BUILDS[buildKey]
  if (!build) return { installed: false, buildKey, label: 'not available on this platform', binaryPath: null, downloadBytes: 0 }
  const dir = sdRuntimeDir(baseDir, buildKey)
  const downloadBytes = build.assets.reduce((n, a) => n + a.size, 0)
  try {
    const record = JSON.parse(fs.readFileSync(path.join(dir, INSTALL_RECORD), 'utf8'))
    const binaryPath = path.join(dir, build.binary)
    if (record.release === SD_RELEASE && record.buildKey === buildKey && fs.existsSync(binaryPath)) {
      return { installed: true, buildKey, label: build.label, binaryPath, downloadBytes }
    }
  } catch { /* not installed */ }
  return { installed: false, buildKey, label: build.label, binaryPath: null, downloadBytes }
}

// Generous: the CUDA runtime zip holds cublasLt64_12.dll, over 500 MB alone.
const ZIP_LIMITS = { maxEntries: 200, maxEntryBytes: 1024 * 1024 * 1024, maxTotalBytes: 3 * 1024 * 1024 * 1024 }

/** One zip entry name → a plain file name, or null if it is anything else. */
export function flatEntryName(name) {
  if (typeof name !== 'string' || !name) return null
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return null
  if (name === '.' || name === '..' || name.startsWith('.')) return null
  if (/^[A-Za-z]:/.test(name)) return null
  return name
}

let installing = null

/**
 * Download, verify and unpack `buildKey`. Concurrent calls share one install.
 *
 * @param {{ baseDir: string, buildKey: string, signal?: AbortSignal, onProgress?: (p: object) => void, fetchImpl?: never }} opts
 */
export function installSdRuntime(opts) {
  if (installing) return installing
  installing = doInstall(opts).finally(() => { installing = null })
  return installing
}

async function doInstall({ baseDir, buildKey, signal, onProgress }) {
  const build = SD_BUILDS[buildKey]
  if (!build) throw new Error(`No image engine build for ${buildKey}.`)
  const already = sdRuntimeStatus(baseDir, buildKey)
  if (already.installed) return already

  const finalDir = sdRuntimeDir(baseDir, buildKey)
  const downloads = path.join(baseDir, 'runtimes', 'downloads')
  const staging = `${finalDir}.staging`
  await fsp.mkdir(downloads, { recursive: true })
  await fsp.rm(staging, { recursive: true, force: true })
  await fsp.mkdir(staging, { recursive: true })

  const total = build.assets.reduce((n, a) => n + a.size, 0)
  let done = 0
  try {
    for (const asset of build.assets) {
      const zipPath = path.join(downloads, asset.file)
      await downloadFile({
        url: RELEASE_BASE + asset.file,
        destPath: zipPath,
        expectedSha256: asset.sha256,
        expectedSize: asset.size,
        signal,
        isUrlAllowed: isSdReleaseUrl,
        onChunk: (received) => onProgress?.({ state: 'downloading', receivedBytes: done + received, totalBytes: total }),
      })
      done += asset.size
      onProgress?.({ state: 'extracting', receivedBytes: done, totalBytes: total })
      const zip = readZip(await fsp.readFile(zipPath), ZIP_LIMITS)
      if (!zip.ok) throw new Error(`${asset.file}: ${zip.error}`)
      for (const [name, data] of Object.entries(zip.files)) {
        const flat = flatEntryName(name)
        if (!flat) throw new Error(`${asset.file} holds a file with a path in its name (${String(name).slice(0, 80)}); refusing it.`)
        const dest = path.join(staging, flat)
        await fsp.writeFile(dest, data)
        // zip.mjs does not carry Unix modes. Everything in these archives is
        // a program, a library or a licence text.
        if (process.platform !== 'win32') await fsp.chmod(dest, 0o755)
      }
      await fsp.rm(zipPath, { force: true })
    }
    if (!fs.existsSync(path.join(staging, build.binary))) throw new Error(`The download did not contain ${build.binary}.`)
    await fsp.writeFile(path.join(staging, INSTALL_RECORD), JSON.stringify({ release: SD_RELEASE, buildKey, installedAt: new Date().toISOString() }))
    await fsp.rm(finalDir, { recursive: true, force: true })
    await fsp.rename(staging, finalDir)
  } catch (err) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {})
    logEvent('image', 'runtime_install_failed', { buildKey, reason: err.message })
    throw err
  }
  logEvent('image', 'runtime_installed', { release: SD_RELEASE, buildKey })
  onProgress?.({ state: 'complete', receivedBytes: total, totalBytes: total })
  return sdRuntimeStatus(baseDir, buildKey)
}
