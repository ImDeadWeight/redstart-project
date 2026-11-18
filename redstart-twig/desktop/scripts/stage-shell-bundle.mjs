#!/usr/bin/env node
// =============================================================================
// Stage what Twig's Tauri installer ships beside the shell
// =============================================================================
// Windows and macOS (Apple Silicon). Builds shell/bundle/resources/
// (gitignored), the layout shell/src/paths.rs resolves at
// <resource_dir>/resources:
//
//   node/node(.exe), node/LICENSE    the pinned Node 26, staged by Nest's
//                                    scripts/stage-node.mjs (one pin for both)
//   app/twigd/bin, app/twigd/daemon  twigd, three levels below resources/ as in
//   shared/*.mjs                     the checkout, so `../../../shared` resolves
//   chat-ui/                         what the shell's `twig` protocol serves
//   LICENSE.txt (the repo's LICENSE), THIRD-PARTY-NOTICES.md,
//   TRADEMARKS.md, licenses/rust-licenses.json
//
// twigd has no npm dependencies: everything it imports is in this repo.
// Anything missing is an error, so an installer never silently lacks a part.
//
// Run after: `npm --prefix ../../redstart-nest/src/chat-ui run build`,
// `node ../../redstart-nest/scripts/stage-node.mjs`, and
// `node ../../redstart-nest/scripts/rust-licenses.mjs --shell shell --out licenses/rust-licenses.json`.
// (`npm run build` does all of that.)
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { stagedBinaryPath, STAGE_DIR } from '../../../redstart-nest/scripts/stage-node.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const TWIG = path.join(here, '..')
const REPO = path.join(TWIG, '..', '..')
export const BUNDLE_DIR = path.join(TWIG, 'shell', 'bundle', 'resources')

function need(p) {
  if (!fs.existsSync(p)) throw new Error(`Missing build input: ${path.relative(REPO, p)}`)
  return p
}

function copyDir(from, to, filter = () => true) {
  fs.cpSync(need(from), to, { recursive: true, filter: (src) => fs.statSync(src).isDirectory() || filter(src) })
}

const MACHO_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca])
function isMachO(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const head = Buffer.alloc(4)
    return fs.readSync(fd, head, 0, 4, 0) === 4 && MACHO_MAGIC.has(head.readUInt32BE(0))
  } finally {
    fs.closeSync(fd)
  }
}

/** macOS: Apple Silicon runs nothing unsigned; node gets an ad-hoc signature. */
function adhocSignMachO(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) adhocSignMachO(full)
    else if (isMachO(full)) execFileSync('codesign', ['--force', '--sign', '-', full], { stdio: 'inherit' })
  }
}

export function stage() {
  const win = process.platform === 'win32'
  if (!win && process.platform !== 'darwin') throw new Error('The Tauri shell ships for Windows and macOS only')
  fs.rmSync(BUNDLE_DIR, { recursive: true, force: true })
  fs.mkdirSync(BUNDLE_DIR, { recursive: true })
  const out = (...p) => path.join(BUNDLE_DIR, ...p)

  fs.mkdirSync(out('node'))
  fs.copyFileSync(need(stagedBinaryPath(process.platform)), out('node', win ? 'node.exe' : 'node'))
  if (!win) fs.chmodSync(out('node', 'node'), 0o755)
  fs.copyFileSync(need(path.join(STAGE_DIR, 'LICENSE')), out('node', 'LICENSE'))

  const mjs = (p) => p.endsWith('.mjs')
  copyDir(path.join(TWIG, 'bin'), out('app', 'twigd', 'bin'), mjs)
  copyDir(path.join(TWIG, 'daemon'), out('app', 'twigd', 'daemon'), mjs)
  copyDir(path.join(REPO, 'shared'), out('shared'), mjs)
  copyDir(path.join(REPO, 'redstart-nest', 'src', 'chat-ui', 'dist'), out('chat-ui'))
  need(out('chat-ui', 'index.html'))

  fs.copyFileSync(need(path.join(REPO, 'LICENSE')), out('LICENSE.txt'))
  fs.copyFileSync(need(path.join(REPO, 'THIRD-PARTY-NOTICES.md')), out('THIRD-PARTY-NOTICES.md'))
  fs.copyFileSync(need(path.join(REPO, 'TRADEMARKS.md')), out('TRADEMARKS.md'))
  fs.mkdirSync(out('licenses'))
  fs.copyFileSync(need(path.join(TWIG, 'licenses', 'rust-licenses.json')), out('licenses', 'rust-licenses.json'))

  if (!win) adhocSignMachO(BUNDLE_DIR)
  console.log(`Staged ${path.relative(REPO, BUNDLE_DIR)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { stage() } catch (err) { console.error(err.message); process.exit(1) }
}
