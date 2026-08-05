'use strict'

// =============================================================================
// Redstart Nest — File System via the official MCP filesystem server
// =============================================================================
// Lifecycle wiring for @modelcontextprotocol/server-filesystem, spawned as a
// local stdio child process via the shared process supervisor (the same one
// backing redstart-twig's local MCP servers — see ../../../shared/mcp-stdio-process.mjs).
//
// This module owns:
//   - starting/stopping the child process to match the File System capability's
//     enabled/rootDir config
//   - the JSON-RPC 2.0 request/response plumbing over its stdin/stdout (the
//     child speaks MCP; nothing here interprets tool semantics)
//   - caching its tools/list result, since the rest of the app calls toolDefs()
//     synchronously
//   - a toolDefs(cfg)/callTool(name, args, cfg) provider interface so it drops
//     into mcp-server.mjs's PROVIDERS array in place of the old fs-tool.mjs
//
// Tool names are the official server's own (write_file, read_text_file, ...) —
// standard names local models call far more reliably than the old bespoke fs_*
// schema, which is the whole reason for the swap.
// =============================================================================

import { createRequire } from 'node:module'
import * as path from 'node:path'
import { createStdioProcessManager } from '../../../shared/mcp-stdio-process.mjs'
import { resolveWithinRoot } from './path-scope.mjs'

const SERVER_ID = 'filesystem'

// The server is a pinned dependency (package.json), NOT fetched via `npx -y`:
// npx re-resolves the package at every spawn — network-dependent, unpinned,
// slow enough cold to blow the handshake timeout, and absent from packaged
// builds. Resolve its JS entry here and run it under our own executable with
// ELECTRON_RUN_AS_NODE (in plain-node test runs process.execPath is already
// node and the env var is inert), so dev, tests, and packaged builds all
// spawn the exact same pinned code with no shell layer.
// (Resolved via package.json because the package declares only a bin, no main.)
const FILESYSTEM_SERVER_ENTRY = path.join(
  path.dirname(createRequire(import.meta.url).resolve('@modelcontextprotocol/server-filesystem/package.json')),
  'dist', 'index.js',
)

// The tool names @modelcontextprotocol/server-filesystem exposes (pinned
// exactly in package.json — currently 2026.7.10; re-audit this list, the
// TOOL_CLASSES entries, and the containment gate whenever the pin moves).
// Hardcoded so callTool() can claim/route them deterministically even before
// the first tools/list handshake completes. Kept in sync with the live server
// by test-mcp-capabilities.mjs, which asserts the advertised set.
export const FILESYSTEM_TOOL_NAMES = [
  'read_file',
  'read_text_file',
  'read_media_file',
  'read_multiple_files',
  'write_file',
  'edit_file',
  'create_directory',
  'list_directory',
  'list_directory_with_sizes',
  'directory_tree',
  'move_file',
  'search_files',
  'get_file_info',
  'list_allowed_directories',
]
const FILESYSTEM_TOOL_NAME_SET = new Set(FILESYSTEM_TOOL_NAMES)

// Defense in depth. The upstream server already blocks "..", absolute,
// drive-qualified, and real-symlink escapes (verified against v2026.7.10), but
// this capability grants arbitrary file WRITES, so every path argument is also
// re-validated here through our own symlink-aware containment (path-scope.mjs)
// before the call reaches the child — a second, independently-audited gate that
// stays in force if a future upstream version ever regresses. Keyed by argument
// NAME so new upstream tools are covered without edits: every path-bearing arg
// the server defines is named one of these.
const PATH_STRING_KEYS = new Set(['path', 'source', 'destination'])
const PATH_ARRAY_KEYS = new Set(['paths'])
const REQUEST_TIMEOUT_MS = 15_000
// Crash-restart pacing: exponential backoff, then give up until the next
// syncFilesystemProvider() call (config change / server start) resets it —
// a child that dies instantly every time must not spawn-churn forever.
const RESTART_INITIAL_MS = 2_000
const RESTART_MAX_MS = 60_000
const RESTART_MAX_ATTEMPTS = 5

let manager = null
let pending = new Map()      // request id -> { resolve, reject, timer }
let nextRequestId = 1
let cachedTools = []          // last successful tools/list result
let ready = false              // true once initialize + tools/list has completed for the current process
let currentRootDir = null      // rootDir the running child was spawned with
let currentlyEnabled = false
let restartTimer = null
let restartDelay = RESTART_INITIAL_MS
let restartAttempts = 0
let starting = false           // guards against overlapping start-and-handshake attempts

function log(...args) {
  console.log('[filesystem-mcp-provider]', ...args)
}

function ensureManager(logDir) {
  if (manager) return manager
  manager = createStdioProcessManager({
    logDir,
    onMessage: handleMessage,
    onExit: handleExit,
    // We drive our own restart (so every restart gets a fresh handshake,
    // whether it's config-driven or crash-driven) rather than the shared
    // module's built-in backoff restart.
    shouldRestart: () => false,
  })
  return manager
}

function handleMessage(_id, line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    log('non-JSON line from child, ignoring:', line.slice(0, 200))
    return
  }
  if (msg.id === undefined || msg.id === null) return // notification — nothing to route it to
  const waiter = pending.get(msg.id)
  if (!waiter) return
  pending.delete(msg.id)
  clearTimeout(waiter.timer)
  if (msg.error) waiter.reject(new Error(msg.error.message || 'MCP error'))
  else waiter.resolve(msg.result)
}

function handleExit(_id, info) {
  ready = false
  cachedTools = []
  for (const [reqId, waiter] of pending) {
    clearTimeout(waiter.timer)
    waiter.reject(new Error('filesystem MCP server exited'))
    pending.delete(reqId)
  }
  log('child exited', info)

  clearTimeout(restartTimer)
  if (!currentlyEnabled || !currentRootDir) return
  if (restartAttempts >= RESTART_MAX_ATTEMPTS) {
    log(`giving up after ${restartAttempts} restart attempts — will retry on the next config sync`)
    return
  }
  restartAttempts++
  restartTimer = setTimeout(() => {
    spawnAndHandshake(currentRootDir).catch((err) => log('restart failed:', err.message))
  }, restartDelay)
  restartDelay = Math.min(restartDelay * 2, RESTART_MAX_MS)
  restartTimer.unref?.()
}

function request(method, params) {
  const id = nextRequestId++
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`MCP request "${method}" timed out`))
    }, REQUEST_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    const res = manager.send(SERVER_ID, payload)
    if (!res.ok) {
      clearTimeout(timer)
      pending.delete(id)
      reject(new Error(res.error))
    }
  })
}

function notify(method, params) {
  manager.send(SERVER_ID, JSON.stringify({ jsonrpc: '2.0', method, params }))
}

async function spawnAndHandshake(rootDir) {
  if (starting) return
  starting = true
  try {
    manager.stop(SERVER_ID)
    const res = manager.start(SERVER_ID, {
      command: process.execPath,
      args: [FILESYSTEM_SERVER_ENTRY, rootDir],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      shell: false, // real executable — no cmd.exe layer needed on win32
    })
    if (!res.ok) throw new Error(res.error)

    const initResult = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'redstart-nest', version: '1.0.0' },
    })
    notify('notifications/initialized', {})

    const listResult = await request('tools/list', {})
    cachedTools = Array.isArray(listResult?.tools) ? listResult.tools : []
    ready = true
    restartDelay = RESTART_INITIAL_MS
    restartAttempts = 0
    log(`ready — ${cachedTools.length} tools (server ${initResult?.serverInfo?.name ?? 'unknown'})`)
  } finally {
    starting = false
  }
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Reconcile the running child process against the File System capability's
 * current config. Call this whenever that config changes (capability
 * enabled/disabled, rootDir changed) and once when the MCP server starts.
 * @param {{enabled?: boolean, rootDir?: string|null}} fsCfg
 * @param {string} [logDir]
 */
export async function syncFilesystemProvider(fsCfg, logDir) {
  ensureManager(logDir)
  const wantEnabled = !!(fsCfg?.enabled && fsCfg?.rootDir)
  currentlyEnabled = wantEnabled
  currentRootDir = fsCfg?.rootDir ?? null
  // A config sync is a fresh mandate — forgive past crash-restart failures.
  restartDelay = RESTART_INITIAL_MS
  restartAttempts = 0

  if (!wantEnabled) {
    clearTimeout(restartTimer)
    manager.stop(SERVER_ID)
    ready = false
    cachedTools = []
    return
  }

  // Already running against this exact rootDir — nothing to do.
  if (ready && manager.isRunning(SERVER_ID) && currentRootDir === fsCfg.rootDir) return

  await spawnAndHandshake(fsCfg.rootDir)
}

/** Stop the child process unconditionally (server shutdown). */
export function stopFilesystemProvider() {
  clearTimeout(restartTimer)
  currentlyEnabled = false
  manager?.stop(SERVER_ID)
  ready = false
  cachedTools = []
}

export function isFilesystemProviderReady() {
  return ready
}

export function getCachedFilesystemTools() {
  return cachedTools
}

// Reject any path argument that escapes the given root (including via a
// symlink the upstream server would follow). Returns an MCP isError result to
// send back verbatim, or null when every path is contained. Config errors
// (missing/invalid root) are allowed to throw — that's a setup fault, not an
// attack, and the caller's catch turns it into an error result.
// Exported (with rootDir as a parameter rather than module state) so the
// security suite can drive the gate directly without a child process.
export function containmentError(rootDir, args) {
  if (!args || typeof args !== 'object') return null
  const offenders = []
  const check = (value) => {
    if (typeof value !== 'string') return
    try {
      resolveWithinRoot(rootDir, value)
    } catch (err) {
      if (err.message === 'No root directory configured') throw err
      offenders.push(value)
    }
  }
  for (const [key, value] of Object.entries(args)) {
    if (PATH_STRING_KEYS.has(key)) check(value)
    else if (PATH_ARRAY_KEYS.has(key) && Array.isArray(value)) value.forEach(check)
  }
  if (offenders.length === 0) return null
  return {
    isError: true,
    content: [{ type: 'text', text: `Path is outside the configured file system folder: ${offenders.join(', ')}` }],
  }
}

/** @param {string} name @param {object} args */
export async function callFilesystemTool(name, args) {
  if (!ready) throw new Error('filesystem MCP server is not ready')
  const blocked = containmentError(currentRootDir, args)
  if (blocked) return blocked
  return request('tools/call', { name, arguments: args })
}

// ---------------------------------------------------------------------------
// Provider interface — matches the toolDefs(cfg)/callTool(name, args, cfg)
// shape mcp-server.mjs expects from every entry in its PROVIDERS array, so this
// module drops into that list in place of the old in-process fs-tool.mjs. The
// child process's lifecycle is driven separately via syncFilesystemProvider()
// (wired to server start/stop + config changes); these two functions only
// expose/route its tools.
// ---------------------------------------------------------------------------

export function toolDefs(cfg) {
  if (!cfg?.fileSystem?.enabled) return []
  // Only what the LLM/MCP client needs — drop the server's extra annotation/
  // outputSchema/execution fields to match the other providers' tool shape.
  return getCachedFilesystemTools().map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }))
}

export async function callTool(name, args, cfg) {
  if (!FILESYSTEM_TOOL_NAME_SET.has(name)) return null // not ours — let the next provider try

  const fsCfg = cfg?.fileSystem
  if (!fsCfg?.enabled || !fsCfg?.rootDir) {
    return { isError: true, content: [{ type: 'text', text: 'File system is not configured or enabled.' }] }
  }
  try {
    return await callFilesystemTool(name, args ?? {})
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `File system error: ${err.message}` }] }
  }
}
