#!/usr/bin/env node
// =============================================================================
// Stage what the Tauri installer ships beside the shell (daemon split T3)
// =============================================================================
// Builds shell/bundle/resources/ (gitignored), the layout shell/src/paths.rs
// resolves at <resource_dir>/resources. It is Electron's old `resources/`,
// so the daemon's own lookups (resources/bin, resources/chat-ui,
// resources/elevate.exe, ../../../shared) work unchanged:
//
//   node/node.exe, node/LICENSE      the pinned Node 26 (stage-node.mjs)
//   app/bin, app/electron/main       nestd and the daemon
//   app/dist                         the launcher the admin listener serves
//   app/node_modules                 production dependencies only (npm ci)
//   shared/*.mjs                     ../../../shared from app/electron/main
//   chat-ui/                         the chat UI llama-server serves
//   bin/                             llama-server + the DLLs it loads
//   elevate.exe                      firewall rules with UAC
//   LICENSE.txt, THIRD-PARTY-NOTICES.md, licenses/
//
// Run after the builds it copies from: `npm run build:chat`, `vite build`,
// `npm run license:gen`, `node scripts/stage-node.mjs`, and the llama-server
// staging the release workflow does. Anything missing is an error. An
// installer that silently lacks llama-server is the failure test-packaging
// exists to stop.
//
//   node scripts/stage-shell-bundle.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { stagedBinaryPath } from './stage-node.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const NEST = path.join(here, '..')
const REPO = path.join(NEST, '..')
export const BUNDLE_DIR = path.join(NEST, 'shell', 'bundle', 'resources')

function need(p) {
  if (!fs.existsSync(p)) throw new Error(`Missing build input: ${path.relative(REPO, p)}`)
  return p
}

function copyDir(from, to, filter = () => true) {
  fs.cpSync(need(from), to, { recursive: true, filter: (src) => fs.statSync(src).isDirectory() || filter(src) })
}

function main() {
  if (process.platform !== 'win32') throw new Error('The Tauri installer is Windows-only for now (plan D7)')
  fs.rmSync(BUNDLE_DIR, { recursive: true, force: true })
  fs.mkdirSync(BUNDLE_DIR, { recursive: true })
  const out = (...p) => path.join(BUNDLE_DIR, ...p)

  // The runtime.
  fs.mkdirSync(out('node'))
  fs.copyFileSync(need(stagedBinaryPath('win32')), out('node', 'node.exe'))
  fs.copyFileSync(need(path.join(NEST, 'deps', 'node', 'LICENSE')), out('node', 'LICENSE'))

  // The daemon, and its production dependencies installed from the lockfile.
  copyDir(path.join(NEST, 'bin'), out('app', 'bin'))
  copyDir(path.join(NEST, 'electron', 'main'), out('app', 'electron', 'main'))
  copyDir(path.join(NEST, 'dist'), out('app', 'dist'))
  for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(need(path.join(NEST, f)), out('app', f))
  // --ignore-scripts: no production dependency needs an install script, and
  // a release build should not run any.
  // One fixed command string (npm is a .cmd on Windows, which needs a shell).
  execSync('npm ci --omit=dev --ignore-scripts --no-audit --no-fund', {
    cwd: out('app'),
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' },
  })

  copyDir(path.join(REPO, 'shared'), out('shared'), (p) => p.endsWith('.mjs'))
  copyDir(path.join(NEST, 'src', 'chat-ui', 'dist'), out('chat-ui'))

  // llama-server and exactly what it loads (the release workflow stages these;
  // check-dll-closure.mjs proves the set is closed).
  const dll = (p) => /\.dll$/i.test(p)
  copyDir(path.join(NEST, 'llama-cpp-turboquant', 'build', 'bin', 'Release'), out('bin'),
    (p) => dll(p) || /llama-server\.exe$/i.test(p))
  copyDir(path.join(NEST, 'deps', 'windows'), out('bin'), dll)
  need(out('bin', 'llama-server.exe'))
  fs.copyFileSync(need(path.join(NEST, 'deps', 'windows', 'elevate.exe')), out('elevate.exe'))

  fs.copyFileSync(need(path.join(NEST, 'LICENSE.txt')), out('LICENSE.txt'))
  fs.copyFileSync(need(path.join(REPO, 'THIRD-PARTY-NOTICES.md')), out('THIRD-PARTY-NOTICES.md'))
  // npm-licenses.json (license:gen) and rust-licenses.json (rust-licenses.mjs).
  need(path.join(NEST, 'licenses', 'rust-licenses.json'))
  copyDir(path.join(NEST, 'licenses'), out('licenses'))

  console.log(`Staged ${path.relative(REPO, BUNDLE_DIR)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (err) { console.error(err.message); process.exit(1) }
}
