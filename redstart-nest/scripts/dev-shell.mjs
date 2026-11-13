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
// The chat page is NOT hot-reloaded: llama-server serves the last build in
// src/chat-ui/dist, and that is what the Nest window's chat opens. On
// 2026-11-11 a chat test ran a dist from before ask_user existed, so Nest
// never offered the tool and the model rightly said it had none. Say so when
// the build is older than the source it came from.
function newestMtime(dir) {
  let newest = 0
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else newest = Math.max(newest, mtime(p))
    }
  }
  try { walk(dir) } catch { /* no source tree: nothing to compare */ }
  return newest
}
const chatUi = path.join(here, '..', 'src', 'chat-ui')
const chatBuilt = mtime(path.join(chatUi, 'dist', 'index.html'))
const chatSource = Math.max(newestMtime(path.join(chatUi, 'src')), newestMtime(path.join(here, '..', '..', 'shared')))
if (chatBuilt < chatSource) {
  console.warn(
    `\n[dev] The chat UI the Nest window opens (src/chat-ui/dist) is older than its source${chatBuilt ? ` (built ${new Date(chatBuilt).toLocaleString()})` : ' (never built)'}.\n` +
      '[dev] Run `npm run build:chat`, then reload the chat page. Until then it is not this checkout\'s chat UI.\n'
  )
}

const child = spawn('cargo', ['run', '--', ...process.argv.slice(2)], {
  cwd: path.join(here, '..', 'shell'),
  stdio: 'inherit',
  env: { ...process.env, REDSTART_DEV_URL: process.env.REDSTART_DEV_URL || 'http://localhost:5173/' },
})
child.on('exit', (code) => process.exit(code ?? 1))
