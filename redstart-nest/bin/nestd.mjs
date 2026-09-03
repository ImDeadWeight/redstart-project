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
// holding :19083 is the one actually in charge. §7.1's rule — make the failure
// legible — applies with more force where nobody is looking at a screen.
//
// Usage:
//   nestd [--dir <nest directory>]
//   REDSTART_DIR=<nest directory> nestd
//
// The flag names the NEST directory, not the config directory, because design
// §3.5 requires two subtrees under it and they must not collapse into one:
//
//   <nest dir>/config    Nest's own state — accounts, roles, tools, plugins,
//                        profiles, settings, logs, and the secret key.
//   <nest dir>/data      User content: the five folder-scoped capabilities.
//
// Backups want those treated differently, and §3.2's last-resort reset ("stop
// the daemon, delete accounts.json") must never be a step someone takes in a
// directory adjacent to a user's documents. Deviation from §8A.2's plan text,
// which said `--config-dir`: that would have named the inner subtree and left
// the outer one implicit.
//
// EXIT CODES ARE A CONTRACT (§8A.2; 8B.3's supervisor reads them):
//   0  a deliberate stop — admin:shutdown, SIGTERM, SIGINT. Stay down.
//   1  a crash, or a startup failure. Restart me.
// Getting these backwards makes the admin UI's "Shut down" a button that gets
// undone a second later by systemd.
// =============================================================================

import * as os from 'node:os'
import * as path from 'node:path'
import { initPaths, configDir } from '../electron/main/platform-paths.mjs'
import { initSecrets } from '../electron/main/secrets.mjs'
import { keyfileProvider } from '../electron/main/secrets-keyfile.mjs'
import { startDaemon, stopDaemon, installCrashHandlers } from '../electron/main/daemon.mjs'
import { logEvent } from '../electron/main/logger.mjs'

// ---------------------------------------------------------------------------
// Where the nest lives
// ---------------------------------------------------------------------------
// A flag, then the environment, then a home-directory default. No platform
// magic and no /var/lib guess: a service install passes the directory it
// wants explicitly (8B's packaging does exactly that), and a developer or a
// single-user box gets something predictable without arguments.
function resolveNestDir(argv) {
  const flagIndex = argv.indexOf('--dir')
  if (flagIndex !== -1) {
    const value = argv[flagIndex + 1]
    if (!value || value.startsWith('--')) {
      throw new Error('--dir needs a directory path')
    }
    return path.resolve(value)
  }
  if (process.env.REDSTART_DIR) return path.resolve(process.env.REDSTART_DIR)
  return path.join(os.homedir(), '.redstart')
}

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
  // Before initPaths(), exactly as §7.4a requires on the desktop: a crash
  // during startup itself has to be caught too. Headless there is no
  // notification area, so the log line IS the warning — which is also why
  // it goes to stderr as well.
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
    // Not an Electron packaged app. Affects where the bundled chat UI and the
    // server binary are looked for (llama-args.mjs, resolveBinary) — the
    // dev-tree branch is the right one for a checkout, and 8B's packaging is
    // what will need this to mean something else.
    isPackaged: false,
  })
  // The headless provider: a daemon-owned key file, since there is no
  // keychain on an appliance and no console to unlock one at boot (§3.1).
  initSecrets(keyfileProvider(configDir()))

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => shutdown(signal))
  }

  await startDaemon({
    quitApp: () => {
      // admin:shutdown's HTTP 200 has to leave the socket before teardown
      // begins, or the caller sees a connection reset and cannot tell
      // success from crash. Electron defers with setImmediate for the same
      // reason; this is the headless half of that contract (§7.5).
      setImmediate(() => shutdown('admin'))
    },
    // See this file's header, and daemon.mjs's DEFAULT_HOST.
    adminBindFailureIsFatal: true,
  })

  console.log(`Redstart Nest daemon running — ${nestDir}`)
}

main().catch((err) => {
  // Startup failed: no admin listener, or a path/secret provider that could
  // not be initialised. Exit 1 — this is the case a supervisor SHOULD retry,
  // since a bind failure is frequently a slow-releasing socket from the
  // previous run.
  console.error('Redstart Nest daemon failed to start:', err.message)
  process.exit(1)
})
