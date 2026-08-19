'use strict'

// =============================================================================
// Shared stdio MCP process supervisor
// =============================================================================
// Spawns a stdio MCP server as a child process, frames its stdout into
// newline-delimited JSON-RPC messages, restarts it on crash with capped
// backoff, and force-kills it (including any shell grandchild on Windows) on
// stop/shutdown.
//
// No Electron dependency, no config-file opinion, no renderer/IPC opinion —
// callers own how messages/exits are delivered (IPC to a renderer, an
// in-process Promise-based client, etc.) via the onMessage/onExit callbacks,
// and own whether a dead server should come back via shouldRestart. That
// keeps this importable from any Node process (redstart-nest's main process,
// redstart-twig's main process, or a test harness) without pulling in
// Electron just to spawn a child process.
//
// Extracted from redstart-twig's mcp-manager.mjs (which owns the config file
// + IPC wiring + renderer relay; this module owns only process supervision).
// =============================================================================

import { spawn, execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Restart-on-crash backoff: start at 1s, double per consecutive crash, cap at
// 30s. A child that stays up for RESTART_STABLE_MS resets its counter.
const RESTART_INITIAL_MS = 1_000
const RESTART_MAX_MS = 30_000
const RESTART_STABLE_MS = 30_000
// How long a child gets to exit after a polite kill before it is force-killed.
const KILL_GRACE_MS = 3_000

// Windows quirk: `npx`/`npm` are .cmd shims, and Node's spawn() only runs
// real executables unless shell:true. On Windows we build one quoted command
// line ourselves and hand it to cmd.exe (passing an args array alongside
// shell:true is deprecated — DEP0190 — because Node concatenates without
// quoting); elsewhere spawn the command directly with the args array.
// Standard Windows argv quoting: backslash runs immediately before a quote
// (or the closing quote we add) must be doubled, then quotes escaped —
// otherwise an arg ending in `\` (any folder path) escapes its own closing
// quote and mangles the rest of the command line.
function quoteWindowsArg(a) {
  return /[\s"&|<>^%]/.test(a) || a === ''
    ? '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"'
    : a
}

/**
 * @typedef {object} StdioServerConfig
 * @property {string} command
 * @property {string[]} [args]
 * @property {Record<string, string>} [env]
 * @property {boolean} [inheritEnv] Set false to spawn with a minimal baseline
 *   environment plus `env`, instead of the parent's full environment. For
 *   third-party plugin children, which must not receive Nest's own environment.
 *   Default: true (inherit) — redstart-twig's servers depend on it.
 * @property {boolean} [shell] Set false to spawn the command directly even on
 *   Windows — for real executables (node.exe, *.exe). Default: shell on win32,
 *   which is required for .cmd shims like npx/npm.
 */

/**
 * @param {object} opts
 * @param {string} [opts.logDir] Directory for per-server stderr logs. Omit to disable file logging.
 * @param {(id: string, line: string) => void} [opts.onMessage] Called with one framed JSON-RPC line at a time.
 * @param {(id: string, info: {code?: number|null, signal?: string|null, error?: string}) => void} [opts.onExit]
 * @param {(id: string) => boolean} [opts.shouldRestart] Consulted before a crash-restart; defaults to always true.
 * @param {(id: string) => StdioServerConfig | undefined} [opts.resolveConfig] Re-resolves a server's config
 *   before a crash-restart, so config edits made while a server was up take effect on its next
 *   restart. Falling back to the config captured at spawn when absent/undefined.
 */
// The minimum a child needs to start at all. Trimming below this does not make
// a plugin safer, it makes it fail to spawn: on win32 with shell:true the child
// is cmd.exe, which needs COMSPEC/SystemRoot/PATH before it can run anything.
// Everything outside this list is withheld from plugin children.
const BASELINE_ENV_KEYS = process.platform === 'win32'
  ? ['SystemRoot', 'SystemDrive', 'windir', 'COMSPEC', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']
  : ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL']

function buildChildEnv(cfg) {
  if (cfg.inheritEnv !== false) return { ...process.env, ...(cfg.env ?? {}) }
  const base = {}
  for (const key of BASELINE_ENV_KEYS) {
    if (process.env[key] !== undefined) base[key] = process.env[key]
  }
  return { ...base, ...(cfg.env ?? {}) }
}

export function createStdioProcessManager({ logDir, onMessage, onExit, shouldRestart, resolveConfig } = {}) {
  /**
   * @typedef {object} ManagedServer
   * @property {import('node:child_process').ChildProcess} child
   * @property {StdioServerConfig} cfg
   * @property {string} stdoutBuf   partial-line buffer for stdout framing
   * @property {number} restartDelay current crash-restart backoff
   * @property {ReturnType<typeof setTimeout> | null} stableTimer
   * @property {boolean} stopping   true while a deliberate stop is in progress
   */
  /** @type {Map<string, ManagedServer>} */
  const running = new Map()
  /** Pending crash-restart timers by id — cancelled by stop()/shutdown() so a
   * deliberate stop can't be undone by a restart queued before it. */
  const restartTimers = new Map()
  let quitting = false

  function logStream(id) {
    if (!logDir) return null
    try {
      fs.mkdirSync(logDir, { recursive: true })
      return fs.createWriteStream(path.join(logDir, `${id.replace(/[^a-zA-Z0-9._-]/g, '_')}.log`), { flags: 'a' })
    } catch {
      return null
    }
  }

  /** @param {string} id @param {StdioServerConfig} cfg */
  function start(id, cfg) {
    if (running.has(id)) return { ok: true, alreadyRunning: true }

    // A deliberate start supersedes any crash-restart queued for this id.
    clearTimeout(restartTimers.get(id))
    restartTimers.delete(id)

    const useShell = process.platform === 'win32' && cfg.shell !== false
    const args = cfg.args ?? []
    const childEnv = buildChildEnv(cfg)

    let child
    try {
      child = useShell
        ? spawn([cfg.command, ...args].map(quoteWindowsArg).join(' '), {
            env: childEnv,
            windowsHide: true,
            shell: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          })
        : spawn(cfg.command, args, {
            env: childEnv,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          })
    } catch (err) {
      return { ok: false, error: `Failed to spawn "${cfg.command}": ${err.message}` }
    }

    const prev = running.get(id)
    const entry = {
      child,
      cfg,
      stdoutBuf: '',
      restartDelay: prev?.restartDelay ?? RESTART_INITIAL_MS,
      stableTimer: null,
      stopping: false,
    }
    running.set(id, entry)

    // A child that survives the stability window earns a backoff reset.
    entry.stableTimer = setTimeout(() => { entry.restartDelay = RESTART_INITIAL_MS }, RESTART_STABLE_MS)

    const errLog = logStream(id)
    errLog?.write(`\n--- ${new Date().toISOString()} started: ${cfg.command} ${args.join(' ')} ---\n`)

    // Frame stdout by newline. stdout may deliver partial lines or several
    // messages per chunk — buffer the tail so the caller only ever receives
    // whole JSON-RPC messages.
    child.stdout.on('data', (chunk) => {
      entry.stdoutBuf += chunk.toString('utf8')
      let nl
      while ((nl = entry.stdoutBuf.indexOf('\n')) !== -1) {
        const line = entry.stdoutBuf.slice(0, nl).replace(/\r$/, '')
        entry.stdoutBuf = entry.stdoutBuf.slice(nl + 1)
        if (line.trim()) onMessage?.(id, line)
      }
    })

    // stderr is server logging, never protocol traffic — file only.
    child.stderr.on('data', (chunk) => errLog?.write(chunk))

    // A write can race the child dying (send() checked the map, then the
    // process exited before the write landed). Without a listener that EPIPE
    // becomes an uncaught 'error' event and takes down the host process.
    child.stdin.on('error', (err) => errLog?.write(`stdin error: ${err.message}\n`))

    // 'error' (spawn failure) and 'exit' can both fire for the same child;
    // settle exactly once so the entry can't leak in `running` (a leaked entry
    // makes send() write into a dead stdin forever after).
    let settled = false

    child.on('error', (err) => {
      if (settled) return
      settled = true
      errLog?.write(`spawn error: ${err.message}\n`)
      errLog?.end()
      clearTimeout(entry.stableTimer)
      if (running.get(id) === entry) running.delete(id)
      // No crash-restart here: a spawn error means the command itself is bad
      // (missing binary, bad path) — retrying would loop against the same
      // failure. The caller decides via its onExit handler.
      onExit?.(id, { error: err.message })
    })

    child.on('exit', (code, signal) => {
      if (settled) return
      settled = true
      errLog?.write(`--- exited code=${code} signal=${signal} ---\n`)
      errLog?.end()
      clearTimeout(entry.stableTimer)
      const wasStopping = entry.stopping
      if (running.get(id) === entry) running.delete(id)
      onExit?.(id, { code, signal })

      // Crash restart with capped backoff — but never for deliberate stops or
      // while quitting, and only if the caller still wants this id running.
      const wantsRestart = shouldRestart ? shouldRestart(id) : true
      if (!wasStopping && !quitting && wantsRestart) {
        const delay = entry.restartDelay
        const nextDelay = Math.min(entry.restartDelay * 2, RESTART_MAX_MS)
        const timer = setTimeout(() => {
          restartTimers.delete(id)
          if (!quitting && !running.has(id)) {
            // Re-resolve config so edits made while the server was up take
            // effect on the restart, not just on a manual stop/start.
            const freshCfg = resolveConfig?.(id) ?? cfg
            const res = start(id, freshCfg)
            if (res.ok) {
              const restarted = running.get(id)
              if (restarted) restarted.restartDelay = nextDelay
            }
          }
        }, delay)
        timer.unref?.()
        restartTimers.set(id, timer)
      }
    })

    return { ok: true }
  }

  function killChild(child) {
    if (child.exitCode !== null || child.signalCode !== null) return
    if (process.platform === 'win32') {
      // With shell:true the real server is a grandchild of cmd.exe; child.kill()
      // would orphan it. taskkill /T takes down the whole tree.
      try { execFile('taskkill', ['/pid', String(child.pid), '/T', '/F']) } catch { /* already gone */ }
    } else {
      child.kill('SIGTERM')
      const force = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, KILL_GRACE_MS)
      force.unref?.()
    }
  }

  /** @param {string} id */
  function stop(id) {
    // Cancel any queued crash-restart first — otherwise a stop issued between
    // a crash and its restart timer would be silently undone seconds later.
    clearTimeout(restartTimers.get(id))
    restartTimers.delete(id)
    const entry = running.get(id)
    if (!entry) return { ok: true, wasRunning: false }
    entry.stopping = true
    clearTimeout(entry.stableTimer)
    try { entry.child.stdin.end() } catch { /* stream may be gone */ }
    killChild(entry.child)
    return { ok: true, wasRunning: true }
  }

  /** @param {string} id @param {string} line One JSON-RPC message, newline-free. */
  function send(id, line) {
    const entry = running.get(id)
    if (!entry) return { ok: false, error: `Server "${id}" is not running` }
    // One JSON-RPC message per line by contract; strip embedded newlines so a
    // malformed payload can't smuggle extra frames into the child.
    try {
      entry.child.stdin.write(String(line).replace(/\r?\n/g, ' ') + '\n')
    } catch (err) {
      return { ok: false, error: `Server "${id}" stdin write failed: ${err.message}` }
    }
    return { ok: true }
  }

  /** @param {string} id */
  function isRunning(id) {
    return running.has(id)
  }

  function listRunning() {
    return Array.from(running.keys())
  }

  /** Kill every child; call on quit so no orphans survive in Task Manager. */
  function shutdown() {
    quitting = true
    for (const timer of restartTimers.values()) clearTimeout(timer)
    restartTimers.clear()
    for (const id of Array.from(running.keys())) stop(id)
  }

  return { start, stop, send, isRunning, listRunning, shutdown }
}
