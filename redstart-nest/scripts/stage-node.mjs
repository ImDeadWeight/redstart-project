#!/usr/bin/env node
// =============================================================================
// Stage the pinned Node runtime the desktop shell runs nestd on
// =============================================================================
// The daemon split (docs/notes/daemon-split-tauri-plan.md D8): on the desktop,
// the daemon runs as `nestd --shell-pipe` under a bundled Node 26, not under
// Electron's Node 20. This downloads that one pinned build into
// deps/node/ (gitignored), where stage-shell-bundle.mjs picks it up.
//
// PINNED BY HASH, not just by version: the sha256 below was copied from
// nodejs.org's SHASUMS256.txt for this release, and a download that doesn't
// match is refused. Bumping Node means changing VERSION and the hashes, in one
// commit, on purpose.
//
//   node scripts/stage-node.mjs            stage for this platform
//   node scripts/stage-node.mjs --check    exit 0 if already staged and intact
// =============================================================================

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const NODE_VERSION = '26.13.0'

// From https://nodejs.org/dist/v26.13.0/SHASUMS256.txt (fetched 2026-11-05).
const ARCHIVES = {
  'win32-x64': { file: `node-v${NODE_VERSION}-win-x64.zip`, sha256: 'dcc60d59a0746999f99064a01c020445d54d84228c691cdbf25b49ac3b59150a', binary: 'node.exe' },
  'darwin-arm64': { file: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`, sha256: 'd38bd5e5a2ddce6bbb5ce45e46e208337da4d51fffe611e567fd32073d6439f6', binary: 'bin/node' },
  'linux-x64': { file: `node-v${NODE_VERSION}-linux-x64.tar.xz`, sha256: 'd28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997', binary: 'bin/node' },
}

const here = path.dirname(fileURLToPath(import.meta.url))
export const STAGE_DIR = path.join(here, '..', 'deps', 'node')

export function stagedBinaryPath(platform = process.platform) {
  return path.join(STAGE_DIR, platform === 'win32' ? 'node.exe' : 'node')
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

async function stage() {
  const key = `${process.platform}-${process.arch}`
  const spec = ARCHIVES[key]
  if (!spec) throw new Error(`No pinned Node ${NODE_VERSION} build for ${key}`)
  const target = stagedBinaryPath()
  const marker = path.join(STAGE_DIR, 'VERSION')

  if (fs.existsSync(target) && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === `${NODE_VERSION} ${spec.sha256}`) {
    console.log(`Node ${NODE_VERSION} already staged at ${target}`)
    return
  }
  if (process.argv.includes('--check')) throw new Error(`Node ${NODE_VERSION} is not staged (run: node scripts/stage-node.mjs)`)

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-stage-node-'))
  try {
    const archive = path.join(work, spec.file)
    const url = `https://nodejs.org/dist/v${NODE_VERSION}/${spec.file}`
    console.log(`Downloading ${url}`)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`)
    fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()))
    const got = sha256(archive)
    if (got !== spec.sha256) throw new Error(`sha256 mismatch for ${spec.file}: expected ${spec.sha256}, got ${got}`)

    // Windows 10+ and every Unix runner ship a tar that reads zip and tar.xz.
    // On Windows, the SYSTEM tar (bsdtar) by full path: Git Bash's GNU tar
    // often comes first on PATH and reads "C:" as a remote host.
    const extract = path.join(work, 'x')
    fs.mkdirSync(extract)
    const tar = process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar'
    execFileSync(tar, ['-xf', archive, '-C', extract], { stdio: 'inherit' })
    const top = path.join(extract, path.basename(spec.file).replace(/\.(zip|tar\.gz|tar\.xz)$/, ''))
    const from = path.join(top, spec.binary)
    if (!fs.existsSync(from)) throw new Error(`${spec.binary} not found in ${spec.file}`)

    fs.mkdirSync(STAGE_DIR, { recursive: true })
    fs.copyFileSync(from, target)
    if (process.platform !== 'win32') fs.chmodSync(target, 0o755)
    // Node's licence travels with the binary it covers.
    const license = path.join(top, 'LICENSE')
    if (fs.existsSync(license)) fs.copyFileSync(license, path.join(STAGE_DIR, 'LICENSE'))
    fs.writeFileSync(marker, `${NODE_VERSION} ${spec.sha256}\n`)
    console.log(`Staged Node ${NODE_VERSION} at ${target}`)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stage().catch((err) => { console.error(err.message); process.exit(1) })
}
