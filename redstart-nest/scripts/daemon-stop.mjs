// =============================================================================
// Stop (or ask about) a headless Redstart daemon
// =============================================================================
//   node scripts/daemon-stop.mjs [--dir <nest dir>] [--status]
//
// The Electron desktop app has a tray with "Quit Redstart" and needs none of
// this. bin/nestd.mjs has no tray, no window and no shortcut, so without this
// the only ways to stop a detached one are the admin UI's Shut Down button and
// Task Manager. This is the third.
//
// ON WINDOWS THIS IS A HARD STOP, and that is worth being plain about rather
// than discovering. Node's signals are emulated there: process.kill(pid,
// 'SIGTERM') does not deliver a signal a process can handle, it terminates it
// unconditionally. So nestd's own graceful shutdown() — which stops the
// gateway, kills llama-server, closes the logger — does NOT run.
//
// What that costs, concretely: a loaded model is orphaned rather than stopped.
// It is not lost, because reapStaleProcess() at the next start is built for
// exactly this case (a Task Manager kill, an OOM, power loss) and will find it
// through the llama-server pid file. But if a model is loaded, the tidier
// options are the admin UI's Shut Down or Ctrl-C in the daemon's own terminal,
// and this script says so before acting.
//
// On POSIX, SIGTERM is a real signal, nestd handles it, and the shutdown is
// graceful.
// =============================================================================

import { resolveNestDir, configDirFor } from '../bin/nest-dir.mjs'
import { daemonStatus, clearDaemonPid, readDaemonPid } from '../electron/main/daemon-pidfile.mjs'
import { readPidFile } from '../electron/main/process-supervision.mjs'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const argv = process.argv.slice(2)
  const statusOnly = argv.includes('--status')
  const nestDir = resolveNestDir(argv.filter(a => a !== '--status'))
  const config = configDirFor(nestDir)

  const status = await daemonStatus(config)

  if (status.state === 'stopped') {
    console.log(`No daemon recorded in ${nestDir}`)
    process.exit(statusOnly ? 0 : 0)
  }

  if (status.state === 'stale') {
    // Expected, not exceptional: this is what a hard kill leaves behind.
    console.log(`Stale pid file in ${nestDir} (pid ${status.pid} is gone)`)
    if (!statusOnly) {
      clearDaemonPid(config)
      console.log('Cleared it. Nothing was running.')
    }
    process.exit(0)
  }

  if (status.state === 'unknown') {
    // Refuse. Pid reuse is real, and signalling on a matching number alone is
    // the class of bug process-supervision.mjs exists to have removed — the
    // process wearing this pid now may be something entirely unrelated.
    console.error(`Pid ${status.pid} is alive but could not be confirmed as Redstart.`)
    console.error('Refusing to signal it. If you are sure, stop it by hand and delete:')
    console.error(`  ${config}\\nestd.pid`)
    process.exit(1)
  }

  const uptime = status.startedAt ? `${Math.round((Date.now() - status.startedAt) / 1000)}s` : 'unknown'
  console.log(`Daemon running — pid ${status.pid}, up ${uptime}`)
  console.log(`  nest: ${nestDir}`)

  if (statusOnly) process.exit(0)

  // Is a model loaded? Only a warning — the caller asked to stop, and this is
  // information, not an obstacle.
  const child = readPidFile(config)
  if (child && process.platform === 'win32') {
    console.log('')
    console.log(`A model appears to be running (llama-server pid ${child.pid}).`)
    console.log('On Windows this stop is a hard termination, so the daemon will not get to')
    console.log('stop it — the next start reaps it instead. Use the admin UI\'s Shut Down,')
    console.log('or Ctrl-C in the daemon\'s terminal, if you would rather it be tidy.')
    console.log('')
  }

  try {
    process.kill(status.pid, 'SIGTERM')
  } catch (err) {
    console.error(`Could not stop pid ${status.pid}: ${err.message}`)
    process.exit(1)
  }

  // Wait for it to actually go. A stop command that returns before the port is
  // released just moves the confusion to whatever starts next.
  for (let i = 0; i < 50; i++) {
    await sleep(100)
    const after = await daemonStatus(config)
    if (after.state !== 'running') {
      // The daemon clears its own pid file on a graceful exit; on Windows it
      // never got the chance, so clear it here.
      if (readDaemonPid(config)) clearDaemonPid(config)
      console.log('Stopped.')
      process.exit(0)
    }
  }

  console.error('The daemon did not exit within 5 seconds. Its pid file is left in place.')
  process.exit(1)
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
