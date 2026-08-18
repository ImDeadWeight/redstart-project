'use strict'

// =============================================================================
// Redstart Nest — Per-plugin stdio MCP client
// =============================================================================
// SKELETON. Every function below throws until implemented — see
// docs/notes/mcp-plugin-system-tasks.md task T6. Nothing imports this module
// until T7, so an unfinished file here cannot affect a running app.
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

// Crash-restart pacing, per plugin. A child that dies instantly every time must
// not spawn-churn forever — give up and report, rather than retrying until the
// end of time. Mirrors filesystem-mcp-provider.mjs.
const RESTART_INITIAL_MS = 2_000
const RESTART_MAX_MS = 60_000
const RESTART_MAX_ATTEMPTS = 5

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
 * @param {number} opts.timeoutMs   per-plugin, from the registry entry
 * @param {string} [opts.logDir]    per-server stderr logs; the install probe reads this file's tail
 * @returns {PluginClient}
 */
export function createPluginClient({ id, command, args, env, timeoutMs, logDir }) {
  // ---- per-instance state (NEVER module scope — see the header) -----------
  // let manager = null
  // const pending = new Map()   // request id -> { resolve, reject, timer }
  // let nextRequestId = 1
  // let ready = false
  // let starting = false        // guards overlapping ensureReady() calls
  // let restartAttempts = 0
  // let restartDelay = RESTART_INITIAL_MS
  // let restartTimer = null

  /**
   * TODO(T6): route one framed JSON-RPC line to its waiter.
   * Ignore non-JSON lines and notifications (no `id`). Clear the timer, delete
   * the pending entry, reject on msg.error, resolve on msg.result.
   */
  // function handleMessage(_id, line) {}

  /**
   * TODO(T6): the child died.
   * Reject EVERY pending request with `Plugin "${id}" exited` and clear the
   * map — never leave a promise unsettled, or a tools/call hangs forever and
   * takes an MCP session with it. Then restart with backoff, giving up after
   * RESTART_MAX_ATTEMPTS.
   */
  // function handleExit(_id, info) {}

  /**
   * TODO(T6): send a JSON-RPC request, resolve/reject its promise.
   * Timeout uses THIS client's timeoutMs, not a shared constant. On timeout:
   * delete the pending entry and reject with
   * `Plugin "${id}" did not respond within ${timeoutMs}ms`. The child stays up
   * and other clients are unaffected — a hung plugin must not block the
   * providers that come after it in the tools/call dispatch loop.
   */
  // function request(method, params) {}

  return {
    /**
     * TODO(T6): spawn + initialize + notifications/initialized.
     *
     * Use createStdioProcessManager with `shouldRestart: () => false` — we
     * drive restarts ourselves so every restart gets a fresh handshake, exactly
     * as filesystem-mcp-provider does.
     *
     * Spawn config MUST include:
     *   shell: false        — real executable, no cmd.exe layer. This is
     *                         SECURITY-relevant, not just tidy: with shell:true
     *                         the plugin's credentials would transit a cmd.exe
     *                         environment first (plan decision D-f).
     *   inheritEnv: false   — third-party code does not receive Nest's own
     *                         environment (spec R8, added to the shared
     *                         supervisor in T5).
     *
     * Idempotent and concurrency-safe: use the `starting` guard.
     */
    ensureReady() {
      throw new Error('TODO(T6): ensureReady not implemented')
    },

    /**
     * TODO(T6): forward tools/call and return the child's result verbatim.
     * `name` is the BARE tool name — plugin-provider.mjs strips the namespace
     * prefix before calling. The child has never seen a prefixed name.
     */
    callTool(name, args) {
      throw new Error('TODO(T6): callTool not implemented')
    },

    /** TODO(T6): tools/list. Used by the install probe, not by tools/list dispatch. */
    listTools() {
      throw new Error('TODO(T6): listTools not implemented')
    },

    /** TODO(T6): deliberate stop — cancel restarts, kill the child, reject in flight. */
    stop() {
      throw new Error('TODO(T6): stop not implemented')
    },

    /** TODO(T6) */
    isRunning() {
      throw new Error('TODO(T6): isRunning not implemented')
    },
  }
}
