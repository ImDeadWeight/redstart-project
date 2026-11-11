#!/usr/bin/env node
// =============================================================================
// `npm run dev`'s desktop half: the Tauri shell in debug, pointed at Vite
// =============================================================================
// Runs `cargo run` in shell/ with REDSTART_DEV_URL set, so the window loads
// Vite's dev server (hot reload) instead of the admin listener. Vite proxies
// /admin to the real listener (vite.config.ts). The debug shell runs the
// checkout's bin/nestd.mjs on the staged Node 26 (shell/src/paths.rs) and
// never touches the login item or the updater.
//
// Extra arguments go to the shell, e.g. `npm run dev -- --background`.
// =============================================================================

import { execFileSync, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
// The shell embeds build/icon.* at compile time, and build/ is generated.
// Regenerated when missing OR older than what it is made from (the drawing,
// or the scripts that render it): checking only for a missing file kept a
// stale icon in every dev build after the drawing or its rendering changed.
// shell/build.rs then makes cargo rebuild when build/icon.* changes.
const built = path.join(here, '..', 'build', 'icon.png')
const sources = [
  path.join(here, '..', 'assets', 'mascot', 'redstart-nest.txt'),
  path.join(here, 'mascot.mjs'),
  path.join(here, 'make-icon.mjs'),
]
const mtime = (f) => { try { return fs.statSync(f).mtimeMs } catch { return 0 } }
if (!fs.existsSync(built) || sources.some((f) => mtime(f) > mtime(built))) {
  execFileSync(process.execPath, [path.join(here, 'make-icon.mjs')], { stdio: 'inherit' })
}
const child = spawn('cargo', ['run', '--', ...process.argv.slice(2)], {
  cwd: path.join(here, '..', 'shell'),
  stdio: 'inherit',
  env: { ...process.env, REDSTART_DEV_URL: process.env.REDSTART_DEV_URL || 'http://localhost:5173/' },
})
child.on('exit', (code) => process.exit(code ?? 1))
