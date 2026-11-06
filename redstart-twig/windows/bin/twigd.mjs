// =============================================================================
// twigd: Redstart Twig's local process, under its Tauri shell
// =============================================================================
// The Tauri shell (redstart-twig/windows/shell) spawns
//   node twigd.mjs --shell-pipe --config <dir>
// on the Node 26 it bundles, and speaks shared/shell-pipe.mjs over the child's
// stdin/stdout. This is the half of Twig that used to be Electron's main
// process: the granted folder's tools, the local MCP servers, the LAN scan,
// and which release is the update. The shell is the window, the folder
// dialog, the recycle bin and the updater itself.
//
// Requests from the shell, by method:
//   the page's methods     forwarded from the page through the shell's
//                          allowlist (shell/src/bridge.rs): network:*, fs:*
//                          except set-root, mcp-local:*
//   fs:set-root            only after the shell's own folder dialog
//   update-find            which release carries twig-latest.json
// One-way messages to the shell: ready, mcp-message, mcp-exit, stopping.
// Requests to the shell: trash (the OS recycle bin).
//
// LIFETIME: the shell owns it. 'shutdown' or EOF on stdin stops every MCP
// child, reports their pids ('stopping'), and exits 0. Exit 1 is a crash.
// =============================================================================

import './stdout-guard.mjs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPeer, PROTOCOL_VERSION } from '../../../shared/shell-pipe.mjs'
import { findUpdateRelease } from '../../../shared/update-feed.mjs'
import { createLocalFiles } from '../daemon/local-files.mjs'
import { createLocalMcp } from '../daemon/mcp-local.mjs'
import { handlers as networkHandlers } from '../daemon/network.mjs'
import { setTrashImpl } from '../daemon/fs/trash.mjs'

export const TWIG_MANIFEST = 'twig-latest.json'

function argValue(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
}

/**
 * Wire twigd's handlers onto a peer. Exported so the suite can drive the same
 * wiring in-process; the entrypoint below calls it on stdio.
 *
 * @param {ReturnType<typeof createPeer>} peer
 * @param {{ configDir: string, exit?: (code: number) => void, findUpdate?: typeof findUpdateRelease }} opts
 */
export function wireTwigd(peer, { configDir, exit = (code) => process.exit(code), findUpdate = findUpdateRelease }) {
  const files = createLocalFiles({ configDir })
  const mcp = createLocalMcp({ configDir, send: (type, payload) => peer.send({ type, ...payload }) })

  // Deletes go to the OS recycle bin, which only the shell can reach. If it
  // refuses (or the pipe is gone), trash.mjs falls back to a .trash/ folder
  // inside the granted root. Never a permanent delete.
  setTrashImpl((fullPath) => peer.request('trash', { path: fullPath }, { timeoutMs: 120_000 }))

  const pageHandlers = { ...networkHandlers, ...files.handlers, ...mcp.handlers }
  for (const [method, fn] of Object.entries(pageHandlers)) peer.handle(method, fn)

  peer.handle('fs:set-root', (params) => files.setRoot(params))

  // Which release is the update. The shell verifies the download's signature
  // itself; this only chooses where to look, and decides nothing about trust.
  peer.handle('update-find', async ({ currentVersion } = {}) => {
    if (typeof currentVersion !== 'string') throw new Error('update-find needs currentVersion')
    const { release, error } = await findUpdate({
      currentVersion,
      manifest: TWIG_MANIFEST,
      userAgent: `Redstart-Twig/${currentVersion}`,
    })
    if (error) throw new Error(error)
    return release ? { tag: release.tag, version: release.version, manifestUrl: release.feedUrl + TWIG_MANIFEST } : null
  })

  let stopping = false
  function shutdown() {
    if (stopping) return
    stopping = true
    const pids = mcp.shutdown()
    // The pids the shell's updater must see gone before it installs.
    peer.send({ type: 'stopping', pids })
    // On EOF the pipe is already gone and the write fails at once. The timer
    // bounds a stdout that never drains.
    process.stdout.write('', () => exit(0))
    setTimeout(() => exit(0), 2000).unref()
  }
  peer.on('shutdown', shutdown)
  peer.onClose(shutdown)

  peer.send({ type: 'ready', pid: process.pid, rootDir: files.getRoot() })
  return { pageMethods: Object.keys(pageHandlers), shutdown }
}

async function main(argv) {
  if (!argv.includes('--shell-pipe')) {
    console.error('twigd runs under the Redstart Twig shell: twigd.mjs --shell-pipe --config <dir>')
    process.exit(2)
  }
  const configDir = argValue(argv, '--config')
  if (!configDir || !path.isAbsolute(configDir)) {
    console.error('twigd: --config <absolute dir> is required')
    process.exit(2)
  }

  // A crash is written SYNCHRONOUSLY: an async write would be lost to exit.
  const crash = (err) => {
    console.error(`twigd crashed: ${err?.stack ?? err}`)
    try {
      process.stdout.write(JSON.stringify({ rs: PROTOCOL_VERSION, type: 'crash', message: String(err?.message ?? err) }) + '\n')
    } catch {}
    process.exit(1)
  }
  process.on('uncaughtException', crash)
  process.on('unhandledRejection', crash)

  const peer = createPeer({
    input: process.stdin,
    write: (line) => process.stdout.write(line),
    onNoise: (line) => console.warn(`[shell-pipe] ignored a non-protocol line from the shell: ${line.slice(0, 200)}`),
  })
  wireTwigd(peer, { configDir })
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isEntry) main(process.argv.slice(2))
