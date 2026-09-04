#!/usr/bin/env node
'use strict'

// =============================================================================
// nestd — the Redstart Nest daemon, without Electron
// =============================================================================
// The headless entrypoint. Runs exactly the same daemon the Electron launcher
// runs (electron/main/daemon.mjs); the difference is entirely in the four
// answers an entrypoint owes it — where state lives, how secrets are
// encrypted, what a crash does, what a deliberate shutdown does.
//
// There is no window, no tray, and no Electron single-instance lock. The admin
// listener's port bind is the de-facto guard, and here a failure to take it is
// FATAL rather than logged and survived: with no UI to notice, a daemon that
// came up owning nothing has no way to tell anyone, and the process already
// holding :19083 is the one actually in charge.
//
// Usage:
//   nestd [--dir <nest directory>]
//   REDSTART_DIR=<nest directory> nestd
//
// The flag names the NEST directory, not the config directory, because the
// directory needs two subtrees that must never collapse into one:
//
//   <nest dir>/config    Nest's own state — accounts, roles, tools, plugins,
//                        profiles, settings, logs, and the secret key.
//   <nest dir>/data      User content: the five folder-scoped capabilities.
//
// Backups want those treated differently, and the last-resort reset ("stop
// the daemon, delete accounts.json") must never be a step someone takes in a
// directory adjacent to a user's documents. Deliberately not `--config-dir`:
// that would have named the inner subtree and left the outer one implicit.
//
// EXIT CODES ARE A CONTRACT (a supervisor reads them):
//   0  a deliberate stop — admin:shutdown, SIGTERM, SIGINT. Stay down.
//   1  a crash, or a startup failure. Restart me.
// Getting these backwards makes the admin UI's "Shut down" a button that gets
// undone a second later by systemd.
// =============================================================================

import * as path from 'node:path'
import { initPaths, configDir } from '../electron/main/platform-paths.mjs'
import { initSecrets } from '../electron/main/secrets.mjs'
import { keyfileProvider } from '../electron/main/secrets-keyfile.mjs'
import { startDaemon, stopDaemon, installCrashHandlers } from '../electron/main/daemon.mjs'
import { logEvent } from '../electron/main/logger.mjs'
import { portConflictMessage } from '../electron/main/ports.mjs'
import { resolveNestDir } from './nest-dir.mjs'

// ---------------------------------------------------------------------------
// Stopping
// ---------------------------------------------------------------------------
// One path for every deliberate stop — a signal, or admin:shutdown coming
// through the daemon's own quitApp. Guarded because SIGTERM followed by an
// impatient SIGINT is ordinary, and running the teardown twice would try to
// close an already-closed logger and kill an already-dead child.
let stopping = false

function shutdown(reason) {
  if (stopping) return
  stopping = true
  try {
    logEvent('app', 'shutdown', { reason })
    stopDaemon()
  } catch (err) {
    // A teardown that throws must not become exit 1 — that would tell a
    // supervisor to restart a daemon somebody deliberately stopped.
    console.warn('Shutdown was not clean:', err.message)
  }
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  // Before initPaths(), same as the desktop launcher: a crash during startup
  // itself has to be caught too. Headless there is no notification area, so
  // the log line IS the warning — which is also why it goes to stderr as well.
  installCrashHandlers({
    notifyCrash: (notification) => {
      console.error(`\n${notification.title}\n${notification.body}\n`)
    },
    exitCrashed: () => process.exit(1),
  })

  const nestDir = resolveNestDir(process.argv.slice(2))
  initPaths({
    config: path.join(nestDir, 'config'),
    capabilityBase: path.join(nestDir, 'data'),
    // Not an Electron packaged app, and this is a statement of fact rather
    // than a deferral: nestd runs under plain Node, so `process.resourcesPath`
    // does not exist and the packaged branch of llama-args.mjs / resolveBinary
    // could never be the right answer here.
    //
    // What each consumer does with `false`:
    //   chat UI (llama-args.mjs)  src/chat-ui/dist, relative to this tree —
    //                             correct for a source or package install,
    //                             which is the shape headless ships in.
    //   llama-server (daemon.mjs) falls through the dev-tree candidates to
    //                             <config>/bin, which is the headless one.
    isPackaged: false,
  })
  // The headless provider: a daemon-owned key file, since there is no
  // keychain on an appliance and no console to unlock one at boot.
  initSecrets(keyfileProvider(configDir()))

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => shutdown(signal))
  }

  await startDaemon({
    quitApp: () => {
      // admin:shutdown's HTTP 200 has to leave the socket before teardown
      // begins, or the caller sees a connection reset and cannot tell
      // success from crash. Electron defers with setImmediate for the same
      // reason.
      setImmediate(() => shutdown('admin'))
    },
    // See this file's header, and daemon.mjs's DEFAULT_HOST.
    adminBindFailureIsFatal: true,
  })

  console.log(`Redstart Nest daemon running — ${nestDir}`)
}

main().catch((err) => {
  // Startup failed: no admin listener, no beacon, or a path/secret provider
  // that could not be initialised. Exit 1 — this is the case a supervisor
  // SHOULD retry, since a bind failure is frequently a slow-releasing socket
  // from the previous run.
  //
  // A fixed-port collision gets named rather than passed through raw. The
  // header above says the admin listener's bind is the de-facto single-instance
  // guard, which is true of the INTENT and not of the ordering: the beacon
  // binds first, so a second daemon fails on 8765 and Node's own message
  // ("address already in use 0.0.0.0:8765") never mentions Redstart at all.
  console.error(`Redstart Nest daemon failed to start: ${portConflictMessage(err) || err.message}`)
  process.exit(1)
})
