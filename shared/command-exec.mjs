'use strict'

// =============================================================================
// Shared command executor: run one program with an argument list (agent-runtime
// plan D15, D18, D21)
// =============================================================================
// The host-neutral half of a command tool. The host that wraps it decides WHO
// may run WHAT, WHERE; this module only runs a program it is handed and
// reports what happened. Nest's run_command was its first host and was
// removed (master plan Phase 2); it stays for Twig's terminal (agent-runtime
// D49), whose host passes a PowerShell line as one argument to powershell.exe.
//
// THE RULE THIS FILE EXISTS FOR: no string is ever handed to a shell.
// spawn() runs with shell: false, the program is an absolute path chosen by an
// admin, and every argument reaches the child as one argv entry exactly as the
// model wrote it. `--version & echo INJECTED` is one argument to the program,
// not two commands (scripts/test-command-exec.mjs, its first test).
//
// Windows `.cmd` and `.bat` files are refused here (D17). Node refuses to
// spawn them without a shell (the CVE-2024-27980 fix), and running them
// through cmd.exe reopens argument injection: verified 2026-11-10, an argument
// list of `--version & echo INJECTED` printed INJECTED through npm.cmd. A
// host resolves npm to node + npm-cli.js instead.
//
// Containment is policy, not isolation (D20): a scrubbed environment
// (buildEnv), a confined working directory (the caller's job), a wall-clock
// limit with a tree kill, an output cap. The child can still reach the network
// and anything the OS user running it can. `isolation` takes one value, 'none',
// so a container backend can arrive later behind the same option.
//
// Node built-ins only, no daemon import: Twig or a test harness can import it.
// =============================================================================

import { spawn, execFile } from 'node:child_process'
import * as path from 'node:path'

export const ISOLATION_MODES = /** @type {const} */ (['none'])
export const DEFAULT_OUTPUT_CAP = 16 * 1024
/** After a kill, how long to wait for the pipes to close before giving up on them. */
const CLOSE_GRACE_MS = 5_000

/** A Windows batch file, which cannot be run without a shell. */
export function isShellShim(file, platform = process.platform) {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(String(file ?? ''))
}

/**
 * Keeps the first and last `cap / 2` bytes of a stream and counts what fell
 * between. A test runner's summary is at the end and the first error at the
 * start, so both halves matter more than the middle.
 */
export class HeadTail {
  constructor(cap) {
    this.headCap = Math.max(0, Math.floor(cap / 2))
    this.tailCap = Math.max(0, cap - this.headCap)
    this.head = []
    this.headBytes = 0
    this.tail = []
    this.tailBytes = 0
    this.total = 0
  }

  /** @param {Buffer} chunk */
  push(chunk) {
    this.total += chunk.length
    if (this.headBytes < this.headCap) {
      const take = Math.min(chunk.length, this.headCap - this.headBytes)
      this.head.push(chunk.subarray(0, take))
      this.headBytes += take
      chunk = chunk.subarray(take)
    }
    if (!chunk.length || this.tailCap === 0) return
    this.tail.push(chunk)
    this.tailBytes += chunk.length
    while (this.tailBytes - this.tail[0].length >= this.tailCap) {
      this.tailBytes -= this.tail.shift().length
    }
  }

  /** Bytes neither kept in the head nor in the tail. */
  get dropped() {
    return Math.max(0, this.total - this.headBytes - Math.min(this.tailBytes, this.tailCap))
  }

  /** @returns {string} */
  text() {
    const head = Buffer.concat(this.head).toString('utf8')
    let tail = Buffer.concat(this.tail)
    if (tail.length > this.tailCap) tail = tail.subarray(tail.length - this.tailCap)
    const dropped = this.dropped
    return dropped > 0
      ? `${head}\n[... ${dropped} bytes not shown ...]\n${tail.toString('utf8')}`
      : head + tail.toString('utf8')
  }
}

/**
 * The child's environment, built from nothing (D18), the way python-kernel.mjs
 * builds its own. Nothing of the daemon's environment is inherited: no API
 * keys, no tokens, no user profile paths.
 *
 * @param {{ pathDirs?: string[], home: string, platform?: string, hostEnv?: Record<string, string | undefined>, extra?: Record<string, string> }} opts
 *   pathDirs  the only directories on PATH (the allowlisted executables' own)
 *   home      HOME, USERPROFILE, TEMP and TMP all point here
 *   hostEnv   where Windows' system variables are read from (tests pass a fake)
 *   extra     a few fixed variables the caller wants set (never model input)
 * @returns {Record<string, string>}
 */
export function buildEnv({ pathDirs = [], home, platform = process.platform, hostEnv = process.env, extra = {} }) {
  const sep = platform === 'win32' ? ';' : ':'
  const env = {
    PATH: [...new Set(pathDirs.filter(Boolean))].join(sep),
    HOME: home,
    TMPDIR: home,
    TEMP: home,
    TMP: home,
  }
  if (platform === 'win32') {
    env.USERPROFILE = home
    // Windows variable names are case-insensitive (SystemRoot, ComSpec).
    const byUpper = new Map(Object.entries(hostEnv).map(([k, v]) => [k.toUpperCase(), v]))
    // The C runtime needs SYSTEMROOT; git for Windows reads WINDIR and
    // COMSPEC; PATHEXT lets a program find its own helpers by bare name.
    for (const name of ['SYSTEMROOT', 'WINDIR', 'PATHEXT', 'COMSPEC', 'SYSTEMDRIVE']) {
      const value = byUpper.get(name)
      if (typeof value === 'string' && value) env[name] = value
    }
    // libuv copies these from the parent into any child environment that
    // lacks them (uv_spawn's required variables, found by the suite on
    // 2026-11-14: HOMEDRIVE, HOMEPATH, LOGONSERVER, USERDOMAIN, USERNAME
    // appeared in a block built from nothing). Set them, so it copies none:
    // the home pair to the workspace's own home, the identity ones empty.
    const parsed = path.win32.parse(home)
    env.HOMEDRIVE = parsed.root.replace(/\\$/, '')
    env.HOMEPATH = home.slice(env.HOMEDRIVE.length) || '\\'
    env.USERNAME = ''
    env.USERDOMAIN = ''
    env.LOGONSERVER = ''
  } else {
    env.LANG = 'C.UTF-8'
  }
  return { ...env, ...extra }
}

/**
 * Kill a process and everything it started. Never by name: only the pid this
 * module spawned.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {string} [platform]
 */
export function killTree(child, platform = process.platform) {
  const pid = child.pid
  if (!pid) return Promise.resolve()
  if (platform === 'win32') {
    return new Promise((resolve) => {
      const systemRoot = process.env.SYSTEMROOT || process.env.SystemRoot || 'C:\\Windows'
      const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe')
      execFile(taskkill, ['/F', '/T', '/PID', String(pid)], { windowsHide: true }, () => {
        // Already gone, or taskkill missing: the direct kill is the fallback.
        try { child.kill('SIGKILL') } catch { /* gone */ }
        resolve()
      })
    })
  }
  // POSIX: the child was spawned detached, so it leads its own process group
  // and a negative pid reaches every process in it.
  try { process.kill(-pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* gone */ } }
  return Promise.resolve()
}

/**
 * @typedef {{
 *   ok: true, exitCode: number | null, signal: string | null, timedOut: boolean,
 *   aborted: boolean, stdout: string, stderr: string, stdoutDropped: number,
 *   stderrDropped: number, durationMs: number,
 * }} CommandResult
 * @typedef {{ ok: false, reason: string }} CommandRefusal
 */

/**
 * Run one program to completion.
 *
 * @param {{
 *   file: string, args?: string[], prefixArgs?: string[], cwd: string,
 *   env: Record<string, string>, timeoutMs: number, outputCap?: number,
 *   signal?: AbortSignal, isolation?: string, platform?: string,
 *   onSpawn?: (child: import('node:child_process').ChildProcess) => void,
 * }} opts
 *   file        absolute path of the program (never searched on PATH here)
 *   prefixArgs  fixed arguments the configuration put first (npm-cli.js)
 *   args        the caller's arguments, each passed through as one argv entry
 * @returns {Promise<CommandResult | CommandRefusal>}
 */
export function runCommand({
  file, args = [], prefixArgs = [], cwd, env, timeoutMs, outputCap = DEFAULT_OUTPUT_CAP,
  signal, isolation = 'none', platform = process.platform, onSpawn,
}) {
  if (!ISOLATION_MODES.includes(/** @type {any} */ (isolation))) {
    return Promise.resolve({ ok: false, reason: `Isolation "${isolation}" is not available; the only mode is "none".` })
  }
  if (typeof file !== 'string' || !path.isAbsolute(file)) {
    return Promise.resolve({ ok: false, reason: 'The program must be given as an absolute path.' })
  }
  if (isShellShim(file, platform)) {
    return Promise.resolve({
      ok: false,
      reason: `${path.basename(file)} is a Windows batch file, which can only run through cmd.exe, where its arguments could be read as commands. It is not run.`,
    })
  }
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) {
    return Promise.resolve({ ok: false, reason: 'Every argument must be a string.' })
  }
  if (signal?.aborted) return Promise.resolve({ ok: false, reason: 'Stopped before it started.' })

  return new Promise((resolve) => {
    const startedAt = Date.now()
    const out = new HeadTail(outputCap)
    const err = new HeadTail(outputCap)
    let timedOut = false
    let aborted = false
    let settled = false
    let child
    try {
      child = spawn(file, [...prefixArgs, ...args], {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        // POSIX: its own process group, so killTree's negative pid reaches the
        // children too. On Windows `detached` would open a console window.
        detached: platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      resolve({ ok: false, reason: `Could not start ${path.basename(file)}: ${e?.message ?? e}` })
      return
    }
    onSpawn?.(child)

    let closeTimer = null
    const finish = (/** @type {CommandResult | CommandRefusal} */ result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (closeTimer) clearTimeout(closeTimer)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const stop = (why) => {
      if (why === 'timeout') timedOut = true
      else aborted = true
      void killTree(child, platform)
      // A grandchild that escaped the kill may hold the pipes open; do not
      // wait on it forever.
      closeTimer = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        finishFromExit(null, 'SIGKILL')
      }, CLOSE_GRACE_MS)
    }
    const timer = setTimeout(() => stop('timeout'), Math.max(1, timeoutMs))
    const onAbort = () => stop('abort')
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (c) => out.push(c))
    child.stderr.on('data', (c) => err.push(c))

    const finishFromExit = (code, sig) => finish({
      ok: true,
      exitCode: typeof code === 'number' ? code : null,
      signal: sig ?? null,
      timedOut,
      aborted,
      stdout: out.text(),
      stderr: err.text(),
      stdoutDropped: out.dropped,
      stderrDropped: err.dropped,
      durationMs: Date.now() - startedAt,
    })

    child.on('error', (e) => {
      const reason = /** @type {any} */ (e)?.code === 'ENOENT'
        ? `${path.basename(file)} was not found at ${file}.`
        : `Could not start ${path.basename(file)}: ${e.message}`
      finish({ ok: false, reason })
    })
    // 'close', not 'exit': the output is complete only when the pipes close.
    child.on('close', (code, sig) => finishFromExit(code, sig))
  })
}
