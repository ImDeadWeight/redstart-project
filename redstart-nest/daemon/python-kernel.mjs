'use strict'

// =============================================================================
// Redstart Nest — run_python kernels: one sandboxed Pyodide child per chat
// =============================================================================
// Phase 1.0 measured ≈4.8 s from spawn to the first chart, so a child is kept
// warm per conversation and variables persist between calls like a notebook.
// The pool is small on purpose: ≈457 MB RSS per kernel with all three packages
// imported. Defaults: 2 kernels, idle-killed after 10 min, LRU eviction.
//
// THE TIMEOUT IS A KILL. A wasm loop cannot be interrupted from outside
// without SharedArrayBuffer plumbing Pyodide only offers in a browser, so a run
// over its wall clock ends the child, and the next call starts a fresh kernel.
// The tool result says so, and the description tells the model "files
// persist, variables may not".
//
// Keys are `<scope>/<conversationId>`, so two accounts never share a kernel
// even for the same conversation id (which with auth off, a device id scheme
// could produce).
// =============================================================================

import { spawn } from 'child_process'
import * as path from 'path'
import { logEvent } from './logger.mjs'
import { CHILD_SCRIPT } from './python-runtime.mjs'

const REPLY_MARK = '\u001eRS '

export const DEFAULT_MAX_KERNELS = 2
export const DEFAULT_IDLE_MS = 10 * 60 * 1000
export const BOOT_TIMEOUT_MS = 60 * 1000

/** The argv for one child. Exported for the sandbox suite, which must run what production runs. */
export function childArgs({ distDir, workspace, script = CHILD_SCRIPT }) {
  // Repeated flags, never comma-joined (1.0: a comma list silently denied the
  // script itself on Windows), each with the trailing wildcard form.
  const star = (p) => path.join(p, '*')
  return [
    '--permission',
    `--allow-fs-read=${star(distDir)}`,
    `--allow-fs-read=${script}`,
    `--allow-fs-read=${star(workspace)}`,
    `--allow-fs-write=${star(workspace)}`,
    '--disallow-code-generation-from-strings',
    script, distDir, workspace,
  ]
}

/** Spawn env: nothing of the host's. Windows needs SYSTEMROOT for its CRT. */
export function childEnv() {
  return process.platform === 'win32' && process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}
}

class Kernel {
  constructor({ key, nodePath, distDir, workspace, onExit }) {
    this.key = key
    this.workspace = workspace
    this.lastUsed = Date.now()
    this.busy = false
    this.dead = false
    this.pending = new Map()
    this.nextId = 1
    this.stderrTail = ''
    this.child = spawn(nodePath, childArgs({ distDir, workspace }), {
      env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    let buf = ''
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    const bootTimer = setTimeout(() => this.rejectReady(new Error('The Python kernel did not start within 60 s')), BOOT_TIMEOUT_MS)
    this.ready.then(() => clearTimeout(bootTimer), () => clearTimeout(bootTimer))
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.startsWith(REPLY_MARK)) continue
        let msg
        try { msg = JSON.parse(line.slice(REPLY_MARK.length)) } catch { continue }
        this.onMessage(msg)
      }
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (s) => { this.stderrTail = (this.stderrTail + s).slice(-2000) })
    this.child.on('error', (err) => this.die(err.message))
    this.child.on('exit', (code, signal) => {
      this.die(`exited (${signal || code})`)
      onExit(this)
    })
    // The pending queue holds one call at a time (callers serialize), but a
    // promise must still be rejected if the child goes away under it.
    this.ready.catch(() => this.kill())
  }

  onMessage(msg) {
    if (msg.type === 'ready') { this.info = msg; this.resolveReady(msg); return }
    if (msg.type === 'log') { logEvent('python', 'child_log', { message: String(msg.message).slice(0, 300) }); return }
    if (msg.type === 'result') {
      const p = this.pending.get(msg.id)
      if (p) { this.pending.delete(msg.id); p.resolve(msg) }
    }
  }

  die(reason) {
    if (this.dead) return
    this.dead = true
    this.rejectReady?.(new Error(`The Python kernel ${reason}. ${this.stderrTail.trim().split('\n').slice(-3).join(' ')}`.trim()))
    for (const p of this.pending.values()) p.reject(new Error(`The Python kernel ${reason}`))
    this.pending.clear()
  }

  kill() {
    if (!this.child.killed) { try { this.child.kill() } catch {} }
  }

  run(code, timeoutMs) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // Dead NOW, not when 'exit' arrives: the next call for this
        // conversation must not be handed a kernel that is mid-kill.
        this.die('was stopped after a timeout')
        this.kill()
        reject(Object.assign(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`), { code: 'TIMEOUT' }))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (m) => { clearTimeout(timer); resolve(m) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      this.child.stdin.write(JSON.stringify({ op: 'run', id, code }) + '\n')
    })
  }
}

/**
 * The pool. One per daemon; python-tool.mjs holds the instance.
 */
export class KernelPool {
  constructor({ maxKernels = DEFAULT_MAX_KERNELS, idleMs = DEFAULT_IDLE_MS } = {}) {
    this.maxKernels = maxKernels
    this.idleMs = idleMs
    this.kernels = new Map()
    this.sweeper = setInterval(() => this.reapIdle(), Math.min(60_000, idleMs)).unref?.() ?? null
  }

  configure({ maxKernels, idleMs } = {}) {
    if (Number.isInteger(maxKernels) && maxKernels >= 1) this.maxKernels = maxKernels
    if (Number.isFinite(idleMs) && idleMs > 0) this.idleMs = idleMs
  }

  reapIdle(now = Date.now()) {
    for (const k of this.kernels.values()) {
      if (!k.busy && now - k.lastUsed > this.idleMs) {
        logEvent('python', 'kernel_idle_killed', {})
        this.evict(k)
      }
    }
  }

  evict(kernel) {
    this.kernels.delete(kernel.key)
    kernel.kill()
  }

  /** Get or start the kernel for a key, evicting the least recently used idle one at the cap. */
  acquire(key, spawnSpec) {
    const existing = this.kernels.get(key)
    if (existing && !existing.dead) return { kernel: existing, fresh: false }
    if (existing) this.kernels.delete(key)
    if (this.kernels.size >= this.maxKernels) {
      const idle = [...this.kernels.values()].filter((k) => !k.busy).sort((a, b) => a.lastUsed - b.lastUsed)
      if (!idle.length) {
        throw new Error(`All ${this.maxKernels} Python kernels are busy running other conversations' code. Try again in a moment.`)
      }
      logEvent('python', 'kernel_evicted', { reason: 'cap' })
      this.evict(idle[0])
    }
    const kernel = new Kernel({
      key,
      ...spawnSpec,
      onExit: (k) => { if (this.kernels.get(k.key) === k) this.kernels.delete(k.key) },
    })
    this.kernels.set(key, kernel)
    logEvent('python', 'kernel_started', { count: this.kernels.size })
    return { kernel, fresh: true }
  }

  /**
   * Run code in the kernel for `key`. Calls for the same key are serialized.
   *
   * @returns {Promise<{ fresh: boolean, reply?: any, error?: string, timedOut?: boolean }>}
   */
  async run(key, spawnSpec, code, timeoutMs) {
    const { kernel, fresh } = this.acquire(key, spawnSpec)
    // Serialize per kernel: a model that fires two calls at once would
    // otherwise interleave its globals.
    const previous = kernel.queueTail ?? Promise.resolve()
    let release
    kernel.queueTail = new Promise((r) => { release = r })
    await previous
    kernel.busy = true
    try {
      await kernel.ready
      const reply = await kernel.run(code, timeoutMs)
      return { fresh, reply }
    } catch (err) {
      if (err?.code === 'TIMEOUT') return { fresh, timedOut: true, error: err.message }
      return { fresh, error: err?.message || String(err) }
    } finally {
      kernel.busy = false
      kernel.lastUsed = Date.now()
      release()
    }
  }

  /** Kill one conversation's kernel (its conversation was deleted). */
  drop(key) {
    const k = this.kernels.get(key)
    if (k) this.evict(k)
  }

  stopAll() {
    for (const k of [...this.kernels.values()]) this.evict(k)
  }

  get size() { return this.kernels.size }
}
