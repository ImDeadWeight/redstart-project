'use strict'

// =============================================================================
// Redstart Nest — the pinned Python runtime (Pyodide) behind run_python
// =============================================================================
// Two things live here: WHAT is installed (one Pyodide release and a fixed
// package set, every byte hash-pinned) and WHICH NODE runs it.
//
// THE PIN. The lock file's sha256 and the four core files' sha256 are written
// below. Each wheel's sha256 comes from that lock, which is trusted only after
// its own hash matched (Phase 1.0 checked every wheel against it). jsDelivr's
// /pyodide/v<ver>/full/ was checked byte-identical to the npm tarball. Bumping
// Pyodide means changing VERSION and these hashes in one commit, AND re-running
// scripts/test-python-sandbox.mjs: an escape in 1.0 came from a Pyodide
// internal (initializeNodeSockFS) that a new release could reintroduce under
// another name.
//
// THE NODE. The sandbox's network denial is Node's permission model, and Node
// only has a network permission from 25. nestd runs on the bundled Node 26 in
// the desktop app, so process.execPath is right there. A dev tree or a headless
// box may run a system Node 24, and on that runtime the sandbox would have no
// network denial at all. So: the daemon's own Node if it qualifies, else the
// staged deps/node binary (dev trees), else UNAVAILABLE. There is deliberately
// no fallback to the weaker sandbox. See chat-tooling-plan.md §R.
// =============================================================================

import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { downloadFile } from './model-download.mjs'
import { logEvent } from './logger.mjs'

export const PYODIDE_VERSION = '314.0.7'
export const PYTHON_VERSION = '3.14.2'
const CDN_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`

/**
 * The only addresses the runtime install may fetch, redirect hops included:
 * https, this host, this version's directory. Anything else is refused before
 * a request is made (http-redirects.mjs), the same way model downloads are
 * held to Hugging Face. Exported for the suite.
 */
export function isPyodideCdnUrl(url) {
  let u
  try { u = new URL(url) } catch { return false }
  return u.protocol === 'https:' && u.hostname === 'cdn.jsdelivr.net' && !u.username && !u.password && !u.port
    && u.pathname.startsWith(`/pyodide/v${PYODIDE_VERSION}/full/`) && !u.pathname.includes('..')
}

export const LOCK_FILE = { name: 'pyodide-lock.json', size: 119077, sha256: '5dc2fc119108bc148c7457dc86e7675b5c87e1cafd420b9c34c1eaef7b36c010' }

export const CORE_FILES = [
  { name: 'pyodide.mjs', size: 17931, sha256: '6f1d60f7bf529beb300f0f47983c921d3982363640ba20af0e38efdddbc66109' },
  { name: 'pyodide.asm.mjs', size: 1250344, sha256: 'f7cdc8ece80678ceb712f8e65ebe6d3a83203a180c399865f49612a051693635' },
  { name: 'pyodide.asm.wasm', size: 9598218, sha256: 'cc36e3cab04fdfc9a63ff13eb52eae2b911bf46c025cc7b281f394bd3de1d5e6' },
  { name: 'python_stdlib.zip', size: 2545637, sha256: 'fa1957e5777068fc4f7437f96d860ae2fbe9c19732ba06c84e004ec16dd7dd7a' },
]

/** What the model is told it has. Their dependency closure is installed too. */
export const TOP_LEVEL_PACKAGES = ['numpy', 'pandas', 'matplotlib']

// The closure, written out rather than walked at install time, so the installed
// set is reviewable in a diff. scripts/test-python-sandbox.mjs asserts it equals
// the lock's closure of TOP_LEVEL_PACKAGES.
export const INSTALLED_PACKAGES = [
  'numpy', 'pandas', 'python-dateutil', 'six', 'pytz',
  'matplotlib', 'contourpy', 'cycler', 'fonttools', 'kiwisolver', 'packaging', 'pillow', 'pyparsing',
]

/** Approximate download, for the Tools tab. Core 13.4 MB + wheels 16.6 MB. */
export const APPROX_DOWNLOAD_BYTES = 30 * 1024 * 1024
/** Measured in Phase 1.0: RSS of one kernel with all three packages imported. */
export const APPROX_KERNEL_RSS_BYTES = 457 * 1024 * 1024

export const MIN_NODE_MAJOR_WITH_NET_PERMISSION = 25

/** `<config>/runtimes/pyodide-<ver>/` */
export function runtimeDir(baseDir) {
  return path.join(baseDir, 'runtimes', `pyodide-${PYODIDE_VERSION}`)
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** The lock, parsed, once its hash has matched. Throws otherwise. */
export function readVerifiedLock(dir) {
  const file = path.join(dir, LOCK_FILE.name)
  if (sha256File(file) !== LOCK_FILE.sha256) throw new Error(`${LOCK_FILE.name} does not match its pin`)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/** Every file the runtime needs, with its expected hash. Requires a verified lock. */
export function expectedFiles(lock) {
  const wheels = INSTALLED_PACKAGES.map((name) => {
    const entry = lock.packages?.[name]
    if (!entry?.file_name || !entry?.sha256) throw new Error(`The pinned lock has no entry for ${name}`)
    return { name: entry.file_name, sha256: entry.sha256 }
  })
  return [...CORE_FILES, ...wheels]
}

/**
 * Is the runtime fully present and intact? Hashes every file (≈30 MB, well
 * under a second), so it is called at install and at kernel start, never per
 * request.
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function verifyRuntime(dir) {
  try {
    if (!fs.existsSync(path.join(dir, LOCK_FILE.name))) return { ok: false, reason: 'not installed' }
    const lock = readVerifiedLock(dir)
    for (const f of expectedFiles(lock)) {
      const full = path.join(dir, f.name)
      if (!fs.existsSync(full)) return { ok: false, reason: `missing ${f.name}` }
      if (sha256File(full) !== f.sha256) return { ok: false, reason: `${f.name} does not match its pin` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err.message }
  }
}

// One check per process: the answer cannot change while it runs.
let cachedRuntimeOk = new Map()

/** verifyRuntime, cached per directory after the first success. */
export function runtimeReady(dir) {
  if (cachedRuntimeOk.get(dir)) return { ok: true }
  const result = verifyRuntime(dir)
  if (result.ok) cachedRuntimeOk.set(dir, true)
  return result
}

/**
 * Download whatever is missing and verify all of it. Each file goes through
 * model-download's .part staging, resume and sha256 check, so an interrupted
 * install resumes and a corrupted byte is refused rather than installed.
 */
export async function installRuntime(dir, { signal, onProgress, fetchBase = CDN_BASE, isUrlAllowed = isPyodideCdnUrl } = {}) {
  await fsp.mkdir(dir, { recursive: true })
  logEvent('python', 'runtime_install_started', { version: PYODIDE_VERSION })
  const lockPath = path.join(dir, LOCK_FILE.name)
  if (!fs.existsSync(lockPath) || sha256File(lockPath) !== LOCK_FILE.sha256) {
    if (fs.existsSync(lockPath)) await fsp.rm(lockPath, { force: true })
    await downloadFile({ url: fetchBase + LOCK_FILE.name, destPath: lockPath, expectedSha256: LOCK_FILE.sha256, expectedSize: LOCK_FILE.size, signal, isUrlAllowed })
  }
  const files = expectedFiles(readVerifiedLock(dir))
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    const dest = path.join(dir, f.name)
    if (fs.existsSync(dest)) {
      if (sha256File(dest) === f.sha256) continue
      await fsp.rm(dest, { force: true })
    }
    onProgress?.({ fileIndex: i, fileCount: files.length, name: f.name })
    await downloadFile({ url: fetchBase + f.name, destPath: dest, expectedSha256: f.sha256, expectedSize: f.size, signal, isUrlAllowed })
  }
  cachedRuntimeOk.delete(dir)
  const result = verifyRuntime(dir)
  logEvent('python', result.ok ? 'runtime_installed' : 'runtime_install_failed', { version: PYODIDE_VERSION, reason: result.ok ? undefined : result.reason })
  if (!result.ok) throw new Error(`Python runtime failed verification: ${result.reason}`)
  return result
}

// ---------------------------------------------------------------------------
// Which Node runs the child
// ---------------------------------------------------------------------------

function nodeMajor(versionString) {
  const m = /^v?(\d+)\./.exec(versionString || '')
  return m ? Number(m[1]) : 0
}

const here = path.dirname(fileURLToPath(import.meta.url))
// deps/node is gitignored and staged by scripts/stage-node.mjs. In a packaged
// install it does not exist, and process.execPath IS that binary.
const STAGED_NODE = path.join(here, '..', 'deps', 'node', process.platform === 'win32' ? 'node.exe' : 'node')

let cachedNode

/**
 * The Node binary the sandbox child runs on, or why there is none.
 *
 * @returns {{ ok: true, execPath: string, version: string, source: 'daemon'|'staged' }
 *         | { ok: false, reason: string }}
 */
export function resolvePythonNode({ execPath = process.execPath, version = process.version, staged = STAGED_NODE, refresh = false } = {}) {
  if (cachedNode && !refresh) return cachedNode
  if (nodeMajor(version) >= MIN_NODE_MAJOR_WITH_NET_PERMISSION) {
    cachedNode = { ok: true, execPath, version, source: 'daemon' }
    return cachedNode
  }
  if (fs.existsSync(staged)) {
    try {
      const stagedVersion = execFileSync(staged, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim()
      if (nodeMajor(stagedVersion) >= MIN_NODE_MAJOR_WITH_NET_PERMISSION) {
        cachedNode = { ok: true, execPath: staged, version: stagedVersion, source: 'staged' }
        return cachedNode
      }
    } catch { /* fall through to unavailable */ }
  }
  cachedNode = {
    ok: false,
    reason: `run_python needs Node ${MIN_NODE_MAJOR_WITH_NET_PERMISSION} or newer for its network sandbox; this server runs on Node ${version}. The desktop app bundles Node 26; a headless install must run nestd on Node 26.`,
  }
  return cachedNode
}

/** The sandboxed entrypoint the child runs. */
export const CHILD_SCRIPT = path.join(here, 'python-child.mjs')
