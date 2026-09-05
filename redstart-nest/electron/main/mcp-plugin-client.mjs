'use strict'

// =============================================================================
// Redstart Nest — Per-plugin stdio MCP client
// =============================================================================
// Implemented per docs/notes/mcp-plugin-system-tasks.md task T6. Nothing
// imports this module until T7, so it cannot affect a running app yet.
//
// JSON-RPC 2.0 plumbing over one plugin child process's stdin/stdout: spawn,
// initialize handshake, tools/list, tools/call, timeouts, teardown.
//
// READ filesystem-mcp-provider.mjs BEFORE WRITING THIS. It does the same job
// and is the reference implementation — handleMessage/handleExit/request/
// notify/spawnAndHandshake there map one-to-one onto this file.
//
// THE ONE STRUCTURAL DIFFERENCE, and the whole reason this is a separate
// module rather than a generalisation of that one: filesystem-mcp-provider
// holds its state in MODULE-SCOPE variables (manager, pending, ready,
// currentRootDir, restartAttempts...) because there is exactly one filesystem
// server. There are many plugins. Every piece of that state must live inside
// createPluginClient's closure, one set per plugin. A module-scope `pending`
// map here would route plugin A's response to plugin B's waiter.
//
// (Plan decision D-d: sibling, not refactor. filesystem-mcp-provider.mjs is
// the highest-blast-radius capability in the system and is covered by the
// conformance and capability suites; duplicating some JSON-RPC plumbing is
// cheaper than destabilising it. Converge later if it earns it.)
// =============================================================================

import { createStdioProcessManager } from '../../../shared/mcp-stdio-process.mjs'
import { logEvent } from './logger.mjs'

// Crash-restart pacing, per plugin. A child that dies instantly every time must
// not spawn-churn forever — give up and report, rather than retrying until the
// end of time. Mirrors filesystem-mcp-provider.mjs.
const RESTART_INITIAL_MS = 2_000
const RESTART_MAX_MS = 60_000
const RESTART_MAX_ATTEMPTS = 5

/** How many timed-out request ids to remember, so a late answer can be explained. */
const ABANDONED_MAX = 64

/**
 * @typedef {object} PluginClient
 * @property {() => Promise<void>} ensureReady  spawn + handshake; idempotent, safe to call concurrently
 * @property {(name: string, args: object) => Promise<object>} callTool  BARE tool name, not namespaced
 * @property {() => Promise<object[]>} listTools  used by the install probe
 * @property {() => void} stop  kill the child, reject everything in flight
 * @property {() => boolean} isRunning
 */

/**
 * One client per installed plugin.
 *
 * @param {object} opts
 * @param {string} opts.id          plugin id; also the process-manager key and the log filename
 * @param {string} opts.command     resolved at INSTALL time, never at spawn (plan decision D5)
 * @param {string[]} opts.args
 * @param {Record<string,string>} opts.env  explicit allowlist + admin values; secrets already decrypted
 * @param {number} opts.timeoutMs   handshake/list timeout, per-plugin, from the registry entry
 * @param {number} [opts.callTimeoutMs]  tools/call timeout; see the note on request()
 * @param {string} [opts.logDir]    per-server stderr logs; the install probe reads this file's tail
 * @returns {PluginClient}
 */
export function createPluginClient({ id, command, args, env, timeoutMs, callTimeoutMs, logDir }) {
  // ---- per-instance state (NEVER module scope — see the header) -----------
  let manager = null
  const pending = new Map()   // request id -> { resolve, reject, timer }
  const abandoned = new Map() // request id -> { label, at } for requests we stopped waiting for
  let nextRequestId = 1
  let ready = false
  let starting = false        // guards overlapping ensureReady() calls
  let startPromise = null
  let stopping = false        // true while a deliberate stop() is settling the child
  let restartAttempts = 0
  let restartDelay = RESTART_INITIAL_MS
  let restartTimer = null

  function ensureManager() {
    if (manager) return manager
    manager = createStdioProcessManager({
      logDir,
      onMessage: handleMessage,
      onExit: handleExit,
      // We drive our own restart (so every restart gets a fresh handshake)
      // rather than the shared module's built-in backoff restart.
      shouldRestart: () => false,
    })
    return manager
  }

  /**
   * Route one framed JSON-RPC line to its waiter. Ignores non-JSON lines and
   * notifications (no `id`) — nothing is waiting on those.
   */
  function handleMessage(_procId, line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.id === undefined || msg.id === null) return
    const waiter = pending.get(msg.id)
    if (!waiter) {
      // An answer to a request we stopped waiting for. It used to be dropped
      // in silence, which is how a tool call that timed out and then SUCCEEDED
      // left no trace anywhere — the caller was told it had not answered and
      // nothing ever said otherwise. Cannot be delivered (the caller is long
      // gone), but it can be recorded.
      const late = abandoned.get(msg.id)
      if (late) {
        abandoned.delete(msg.id)
        logEvent('plugin', 'late_response', {
          plugin: id,
          call: late.label,
          afterMs: Date.now() - late.at,
          isError: !!msg.error,
        })
      }
      return
    }
    pending.delete(msg.id)
    clearTimeout(waiter.timer)
    if (msg.error) waiter.reject(new Error(msg.error.message || 'MCP error'))
    else waiter.resolve(msg.result)
  }

  /**
   * The child died. Reject EVERY pending request so nothing hangs, then
   * restart with backoff — unless this was a deliberate stop() or we have
   * already given up after RESTART_MAX_ATTEMPTS.
   */
  function handleExit(_procId, _info) {
    ready = false
    for (const [reqId, waiter] of pending) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(`Plugin "${id}" exited`))
      pending.delete(reqId)
    }
    clearTimeout(restartTimer)

    if (stopping) {
      stopping = false
      return
    }
    if (restartAttempts >= RESTART_MAX_ATTEMPTS) return
    restartAttempts++
    restartTimer = setTimeout(() => {
      spawnAndHandshake().catch(() => { /* next callTool()/ensureReady() surfaces the failure */ })
    }, restartDelay)
    restartDelay = Math.min(restartDelay * 2, RESTART_MAX_MS)
    restartTimer.unref?.()
  }

  /**
   * Send a JSON-RPC request, resolve/reject its promise.
   *
   * TWO timeouts, because the two kinds of request have nothing in common. A
   * handshake or a tools/list that takes more than a few seconds means a broken
   * plugin — there is nothing for it to be doing. A tools/call can legitimately
   * run for minutes: installing an application, downloading weights, training.
   * Sharing one 15-second budget between them meant every long tool call was
   * reported as a plugin that had not answered, while the work carried on and
   * finished unheard.
   *
   * A timeout ABANDONS the request; it does not cancel it. Nothing here can
   * cancel one — MCP has no cancellation and the child is mid-operation — so
   * the honest thing is to say so, both to the caller (below) and in the log
   * (handleMessage, when the answer eventually arrives).
   *
   * Per-client either way: a hung plugin must not block the providers that come
   * after it in the tools/call dispatch loop, and each client owns its own
   * pending map.
   */
  function request(method, params, { timeout = timeoutMs, label = method } = {}) {
    const reqId = nextRequestId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(reqId)
        abandoned.set(reqId, { label, at: Date.now() })
        // Bounded: this only exists to explain a late answer, and an unbounded
        // map keyed by a monotonic id is a leak with a nice name.
        if (abandoned.size > ABANDONED_MAX) abandoned.delete(abandoned.keys().next().value)
        reject(new Error(
          `Plugin "${id}" has not answered "${label}" within ${timeout}ms. ` +
          'It may still be running — this is a wait that was given up on, not a failure that was reported. ' +
          'Check whether the work completed before trying again, since repeating it may duplicate what it already did.',
        ))
      }, timeout)
      pending.set(reqId, { resolve, reject, timer })
      const res = manager.send(id, payload)
      if (!res.ok) {
        clearTimeout(timer)
        pending.delete(reqId)
        reject(new Error(res.error))
      }
    })
  }

  function notify(method, params) {
    manager.send(id, JSON.stringify({ jsonrpc: '2.0', method, params }))
  }

  async function spawnAndHandshake() {
    ensureManager()
    // A fresh spawn attempt — deliberate (ensureReady) or automatic
    // (crash-restart) — means any earlier stop() is no longer "in progress".
    // Without this reset, a stop() called before a child ever finished
    // spawning (manager null / no exit event to consume the flag) would leave
    // `stopping` stuck true and permanently suppress crash-restart on every
    // later respawn of this same client.
    stopping = false
    manager.stop(id)
    const res = manager.start(id, {
      command,
      args: args ?? [],
      env: env ?? {},
      // SECURITY-relevant, not just tidy: with shell:true on win32 the child
      // is cmd.exe, and the plugin's credentials would transit that
      // environment first (plan decision D-f). inheritEnv:false keeps Nest's
      // own environment away from third-party code (spec R8, T5).
      inheritEnv: false,
      shell: false,
    })
    if (!res.ok) throw new Error(res.error)

    await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'redstart-nest', version: '1.0.0' },
    })
    notify('notifications/initialized', {})
    ready = true
    restartDelay = RESTART_INITIAL_MS
    restartAttempts = 0
  }

  async function ensureReadyImpl() {
    if (ready && manager?.isRunning(id)) return
    if (starting) return startPromise
    starting = true
    startPromise = spawnAndHandshake()
      .catch((err) => {
        ready = false
        throw err
      })
      .finally(() => {
        starting = false
      })
    return startPromise
  }

  return {
    /**
     * Spawn + initialize + notifications/initialized. Idempotent and safe to
     * call concurrently — overlapping callers share the same in-flight
     * handshake promise rather than racing two spawns.
     */
    ensureReady() {
      return ensureReadyImpl()
    },

    /**
     * Forward tools/call and return the child's result verbatim. `name` is
     * the BARE tool name — plugin-provider.mjs strips the namespace prefix
     * before calling. The child has never seen a prefixed name.
     */
    async callTool(name, callArgs) {
      await ensureReadyImpl()
      return request('tools/call', { name, arguments: callArgs ?? {} }, {
        timeout: callTimeoutMs ?? timeoutMs,
        label: name,
      })
    },

    /** tools/list. Used by the install probe, not by tools/list dispatch. */
    async listTools() {
      await ensureReadyImpl()
      const result = await request('tools/list', {})
      return Array.isArray(result?.tools) ? result.tools : []
    },

    /** Deliberate stop — cancel restarts, kill the child, reject in flight. */
    stop() {
      clearTimeout(restartTimer)
      stopping = true
      ready = false
      manager?.stop(id)
      for (const [reqId, waiter] of pending) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error(`Plugin "${id}" exited`))
        pending.delete(reqId)
      }
    },

    isRunning() {
      return ready && !!manager?.isRunning(id)
    },
  }
}
