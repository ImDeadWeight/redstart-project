'use strict'

// =============================================================================
// Redstart Nest — hosting nestd from JavaScript (the shell's end of the pipe)
// =============================================================================
// The desktop shell is Rust (shell/src/daemon.rs). This is the same end of
// the protocol in JavaScript: it spawns `nestd --shell-pipe` and talks to it
// through shell-pipe.mjs (bin/shell-mode.mjs is the other end). It was the
// T1 Electron shell's host. Now test-shell-pipe.mjs drives the real nestd
// with it, which keeps the protocol checked from both sides.
//
// Everything desktop-specific (trash, login items, notifications, the
// updater) is passed in as plain functions.
//
// THE LIFETIME RULE (plan D2): this process owns the daemon. stop() asks it to
// shut down and waits for it. If the host dies, the daemon sees EOF on stdin
// and stops itself. (The Rust shell adds a Job Object on top.)
// =============================================================================

import { spawn } from 'node:child_process'
import { createPeer } from '../../shared/shell-pipe.mjs'

// How long a graceful stop may take before the daemon is killed. stopDaemon()
// itself waits on llama-server; this bounds the whole thing.
const STOP_TIMEOUT_MS = 20_000
// From spawn to `ready`. Startup reaps stale processes, provisions folders and
// binds three listeners, normally about a second.
const READY_TIMEOUT_MS = 60_000

/**
 * @param {object} opts
 * @param {string} opts.nodePath
 * @param {string} opts.nestdPath
 * @param {{ config: string, capabilityBase: string, resources: string|null }} opts.paths
 * @param {Buffer} opts.key          the unwrapped OSCrypt key (shell-secrets-key.mjs)
 * @param {object|null} opts.loginItem  { enabled } or null when the platform has none
 * @param {object|null} opts.updater    { active, status } or null
 * @param {object} opts.handlers     what the daemon may ask the shell to do:
 *   trash(path), setLoginItem({ openAtLogin, args }), checkForUpdate(opts)
 * @param {object} opts.events       what the shell is told:
 *   onEvent(channel), onNotify(msg), onQuitRequested(), onInstallUpdate(),
 *   onExit({ code, expected, stderrTail }), onStderr(text)
 */
export function startDaemonProcess(opts) {
  const { nodePath, nestdPath, paths, key, loginItem = null, updater = null, handlers = {}, events = {} } = opts
  // --no-experimental-webstorage: Node 26's localStorage global warns when a
  // dependency probes it. Off, it is absent, as on Node 20.
  const args = ['--no-experimental-webstorage', nestdPath, '--shell-pipe', '--config', paths.config, '--capability-base', paths.capabilityBase]
  if (paths.resources) args.push('--resources', paths.resources)

  // Electron's own variable must not reach the child: under the real Node it is
  // meaningless, but any Electron the daemon spawns would inherit it.
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  const child = spawn(nodePath, args, { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true })

  // The last few KB of stderr: what the user is told when startup fails.
  let stderrTail = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-4096)
    events.onStderr?.(chunk)
  })
  child.stdin.on('error', () => {}) // EPIPE when the daemon exits first

  const peer = createPeer({
    input: child.stdout,
    write: (line) => { if (!child.stdin.destroyed) child.stdin.write(line) },
    onNoise: (line) => events.onStderr?.(`[daemon stdout, not protocol] ${line}\n`),
  })

  let stopRequested = false
  let lastStoppingPids = []
  peer.on('stopping', (msg) => { lastStoppingPids = Array.isArray(msg.pids) ? msg.pids : [] })
  peer.on('event', (msg) => events.onEvent?.(msg.channel))
  peer.on('notify', (msg) => events.onNotify?.(msg))
  peer.on('quit-requested', () => events.onQuitRequested?.())
  peer.on('install-update', () => events.onInstallUpdate?.())

  peer.handle('trash', ({ path: p }) => {
    if (!handlers.trash) throw new Error('No recycle bin in this shell')
    return handlers.trash(p)
  })
  peer.handle('login-item-set', (settings) => {
    if (!handlers.setLoginItem) throw new Error('No login items in this shell')
    handlers.setLoginItem(settings)
    return true
  })
  peer.handle('update-check', (o) => {
    if (!handlers.checkForUpdate) throw new Error('No updater in this shell')
    return handlers.checkForUpdate(o)
  })

  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      const info = { code, signal, expected: stopRequested, stderrTail }
      events.onExit?.(info)
      resolve(info)
    })
    child.on('error', (err) => {
      stderrTail += `\n${err.message}`
      const info = { code: null, signal: null, expected: false, stderrTail, spawnError: err }
      events.onExit?.(info)
      resolve(info)
    })
  })

  peer.send({
    type: 'hello',
    key: Buffer.from(key).toString('base64'),
    loginItem,
    updater,
  })

  // `ready`, or a failure that says why: the daemon exiting first is the
  // common case (a port taken by another Redstart), and its stderr says so.
  // The pipe closing usually comes BEFORE the exit event (stdout hits EOF
  // first), so a closed pipe waits for the exit, briefly, to report the stderr
  // rather than a bare "pipe closed".
  const diedDuringStartup = (info) => new Error(`The Redstart daemon exited during startup (code ${info.code}).\n${info.stderrTail.trim()}`)
  const ready = Promise.race([
    peer.waitFor('ready', READY_TIMEOUT_MS).catch(async (err) => {
      if (!peer.closed) throw err
      const info = await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000, null))])
      throw info ? diedDuringStartup(info) : err
    }),
    exited.then((info) => { throw diedDuringStartup(info) }),
  ])

  return {
    child,
    peer,
    ready,
    exited,
    get pid() { return child.pid },
    /** Tell the shell's tray/updater state to the daemon. */
    pushLoginItem: (enabled) => peer.send({ type: 'login-item', enabled: !!enabled }),
    pushUpdateStatus: (status) => peer.send({ type: 'update-status', status }),
    stopModel: () => peer.request('stop-model', {}, { timeoutMs: 30_000 }),
    /**
     * Stop the daemon and wait for it. Resolves with the pids the updater must
     * see gone: the daemon's children, as it reported them, plus the daemon.
     */
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return { childPids: [] }
      stopRequested = true
      peer.send({ type: 'shutdown' })
      const timer = setTimeout(() => { try { child.kill() } catch {} }, STOP_TIMEOUT_MS)
      await exited
      clearTimeout(timer)
      return { childPids: [...lastStoppingPids, child.pid].filter(Boolean) }
    },
  }
}
