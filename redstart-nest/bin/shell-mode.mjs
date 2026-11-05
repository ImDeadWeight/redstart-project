'use strict'
// =============================================================================
// nestd --shell-pipe: the daemon under a desktop shell
// =============================================================================
// The daemon split (docs/notes/daemon-split-tauri-plan.md). A desktop shell
// (Electron in T1, Tauri in T2) spawns `nestd --shell-pipe` on the bundled Node
// and speaks shell-pipe.mjs over the child's stdin/stdout. This module is the
// daemon's end of that conversation. The headless path (no --shell-pipe) in
// nestd.mjs is untouched.
//
// What the shell supplies, and what it replaces from the in-process Electron
// days (index.mjs before T1):
//   argv --config/--capability-base/--resources   initPaths(app.getPath(...))
//   hello.key  (the OSCrypt key, unwrapped by     initSecrets(safeStorage)
//              the SHELL; this process never
//              calls DPAPI)
//   trash / login-item / update requests          shell.trashItem,
//                                                 setLoginItemSettings, the updater
//   'shutdown', or EOF on stdin                   before-quit → stopDaemon()
//
// LIFETIME (plan D2): the shell owns it. EOF on stdin means the shell is gone,
// whether it quit, crashed or was killed, and the daemon stops gracefully
// and exits 0. A daemon outliving its shell was the orphan the Tauri spike
// found.
//
// EXIT CODES, the same contract nestd.mjs documents: 0 deliberate (shutdown,
// EOF, admin Shut down), 1 crash or startup failure. The shell reads 1 as "warn
// the user" (settled: warn only, no auto-restart yet).
// =============================================================================

import * as fs from 'node:fs'
import { initPaths } from '../electron/main/platform-paths.mjs'
import { initSecrets } from '../electron/main/secrets.mjs'
import { oscryptProvider } from '../electron/main/secrets-dpapi.mjs'
import {
  startDaemon, stopDaemon, installCrashHandlers, serverState, readSettings, writeSettings,
} from '../electron/main/daemon.mjs'
import { setRecycleBin, setLoginItems, setUpdater } from '../electron/main/desktop-integration.mjs'
import { reconcileStartupSetting } from '../electron/main/ipc/admin.mjs'
import { subscribeToEvents, publish } from '../electron/main/event-broker.mjs'
import { getAdminListenerState } from '../electron/main/admin-listener.mjs'
import { hasOwner } from '../electron/main/auth.mjs'
import { readBootstrapToken } from '../electron/main/bootstrap-token.mjs'
import { stopServer } from '../electron/main/ipc/server.mjs'
import { logEvent } from '../electron/main/logger.mjs'
import { portConflictMessage } from '../electron/main/ports.mjs'
import { createPeer, PROTOCOL_VERSION } from '../electron/main/shell-pipe.mjs'
import { resolveDaemonPaths } from './nest-dir.mjs'

// How long the shell has to say hello. It spawns us and writes hello
// immediately, so anything longer means it never will.
const HELLO_TIMEOUT_MS = 15_000
// admin Shut down asks the shell to quit (it may install an update first). If
// the shell never acts on it, stop anyway: the admin asked for a stop.
const QUIT_FALLBACK_MS = 15_000

// Broker channels the shell's tray reflects.
const FORWARDED_EVENTS = new Set(['server:started', 'server:stopped'])

export async function runShellMode(argv) {
  const peer = createPeer({
    input: process.stdin,
    write: (line) => process.stdout.write(line),
    onNoise: (line) => console.warn(`[shell-pipe] ignored a non-protocol line from the shell: ${line.slice(0, 200)}`),
  })

  let stopping = false
  // Set once startDaemon() has been entered. Before that there is nothing to
  // tear down, and stopDaemon() would reach for paths that were never set.
  let daemonStarted = false
  function shutdown(reason) {
    if (stopping) return
    stopping = true
    if (!daemonStarted) process.exit(0)
    let childPids = []
    try {
      logEvent('app', 'shutdown', { reason })
      ;({ childPids } = stopDaemon())
    } catch (err) {
      // A teardown that throws must not become exit 1: that reads as a crash.
      console.warn('Shutdown was not clean:', err.message)
    }
    // The pids the shell's updater must see gone before it installs. Our own
    // pid is the shell's to wait for; it knows it.
    peer.send({ type: 'stopping', pids: childPids })
    process.stdout.write('', () => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  }

  // Crash path: process state is suspect, so the warning is written
  // SYNCHRONOUSLY before exiting. An async stdout write would be lost to exit.
  installCrashHandlers({
    notifyCrash: (n) => {
      console.error(`\n${n.title}\n${n.body}\n`)
      try { fs.writeSync(1, JSON.stringify({ rs: PROTOCOL_VERSION, type: 'notify', kind: 'crash', title: n.title, body: n.body }) + '\n') } catch {}
    },
    exitCrashed: () => process.exit(1),
  })

  // EOF before hello, or before anything else: the shell is gone. Nothing has
  // started yet in the first case, so exiting 0 tears nothing down.
  peer.onClose(() => shutdown('shell-pipe-closed'))
  peer.on('shutdown', () => shutdown('shell'))

  const hello = await peer.waitFor('hello', HELLO_TIMEOUT_MS)

  const daemonPaths = resolveDaemonPaths(argv)
  initPaths({
    config: daemonPaths.config,
    capabilityBase: daemonPaths.capabilityBase,
    isPackaged: daemonPaths.resources !== null,
    resources: daemonPaths.resources,
  })

  const key = Buffer.from(String(hello.key ?? ''), 'base64')
  initSecrets(oscryptProvider(key))
  key.fill(0)

  // ---- the desktop seams, now answered by the shell ----
  setRecycleBin((fullPath) => peer.request('trash', { path: fullPath }, { timeoutMs: 120_000 }))

  if (hello.loginItem) {
    // get() is synchronous in desktop-integration's contract, so it answers
    // from the state the shell reported (in hello, then 'login-item' pushes).
    let openAtLogin = !!hello.loginItem.enabled
    peer.on('login-item', (msg) => { openAtLogin = !!msg.enabled })
    setLoginItems({
      get: () => ({ openAtLogin }),
      set: (settings) => {
        openAtLogin = !!settings.openAtLogin
        peer.request('login-item-set', { openAtLogin, args: settings.args ?? [] })
          .catch((err) => console.warn('Setting start-at-login failed:', err.message))
      },
    })
  }

  if (hello.updater?.active) {
    let status = hello.updater.status ?? { state: 'idle', version: null, error: null, checkedAt: null }
    peer.on('update-status', (msg) => {
      status = msg.status
      // Every admin UI, local or remote, gets it over the SSE feed, as before.
      publish('update:status', status)
    })
    setUpdater({
      status: () => status,
      checkNow: (opts) => peer.request('update-check', opts ?? {}, { timeoutMs: 120_000 }),
      // Must not quit synchronously (desktop-integration's contract): the
      // shell runs its deliberate quit after this returns.
      install: () => {
        if (status?.state !== 'ready') return false
        peer.send({ type: 'install-update' })
        return true
      },
    })
  }

  peer.handle('stop-model', async () => {
    await stopServer({ serverState })
    return true
  })

  subscribeToEvents((channel) => {
    if (FORWARDED_EVENTS.has(channel)) peer.send({ type: 'event', channel })
  })

  daemonStarted = true
  await startDaemon({
    quitApp: () => {
      // Deferred, as everywhere: admin:shutdown's 200 must leave first.
      setImmediate(() => {
        peer.send({ type: 'quit-requested' })
        setTimeout(() => shutdown('admin-fallback'), QUIT_FALLBACK_MS).unref()
      })
    },
  })

  // What index.mjs did right after startDaemon: put the OS login item in step
  // with settings.json. Now it goes through the shell.
  reconcileStartupSetting({ readSettings, writeSettings })

  peer.send({
    type: 'ready',
    adminPort: getAdminListenerState().port,
    modelRunning: !!serverState.process,
    // While no owner exists the window opens on first-run setup with the code
    // filled in, the way Electron's createWindow did.
    setupToken: hasOwner() ? null : readBootstrapToken(),
  })
  logEvent('app', 'shell_mode_ready', { pid: process.pid })
}

export function shellModeFailed(err) {
  console.error(`Redstart Nest daemon failed to start: ${portConflictMessage(err) || err.message}`)
  process.exit(1)
}
