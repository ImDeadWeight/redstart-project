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
//   - a toolDefs(cfg)/callTool(name, args, cfg, ctx) provider interface so it drops
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
import { resolveUserRoot } from './user-scope.mjs'

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

// Rewrite every path argument from "relative to the caller's own folder" into
// the absolute path the child process needs.
//
// The child is spawned ONCE, rooted at the capability root, and shared by every
// account — spawning one server per user would multiply processes by users for
// no security gain. So scoping happens here instead: we resolve the model's
// path inside the caller's own folder (which containmentError has already
// verified) and hand the child an absolute path. That path is a subpath of the
// child's own root, so the child allows it; our gate has already confirmed it
// is inside the CALLER'S root, which is the narrower claim.
//
// The model keeps speaking in paths relative to its own folder throughout — it
// is never told the absolute layout, and pathsToRelative() puts results back
// into the same terms on the way out.
export function toAbsolutePathArgs(userRoot, args) {
  if (!args || typeof args !== 'object') return args
  const out = { ...args }
  const abs = (value) => (typeof value === 'string' ? resolveWithinRoot(userRoot, value) : value)
  for (const [key, value] of Object.entries(args)) {
    if (PATH_STRING_KEYS.has(key)) out[key] = abs(value)
    else if (PATH_ARRAY_KEYS.has(key) && Array.isArray(value)) out[key] = value.map(abs)
  }
  return out
}

// Strip the caller's absolute root back out of the child's response text.
//
// The upstream server echoes absolute paths ("Successfully wrote to
// C:\...\user_files\pat-a1b2\notes.md"), and directory_tree / search_files /
// list_allowed_directories are made almost entirely of them. Left alone they
// would tell every model the server's on-disk layout, the account-folder naming
// scheme, and by extension that other accounts' folders sit alongside — an
// invitation to go looking. Replaced with paths relative to the caller's own
// root, which is the only frame the model has any business reasoning in.
export function pathsToRelative(result, userRoot) {
  if (!result || !Array.isArray(result.content)) return result
  // Match both separator conventions: the child reports native win32 paths,
  // while some fields come back POSIX-normalised.
  const variants = [userRoot, userRoot.split(path.sep).join('/')]
  const escaped = variants.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = new RegExp(`(${escaped.join('|')})[\\\\/]?`, 'gi')
  return {
    ...result,
    content: result.content.map((part) =>
      part?.type === 'text' && typeof part.text === 'string'
        ? { ...part, text: part.text.replace(pattern, '') || '.' }
        : part,
    ),
  }
}

/**
 * @param {string} name @param {object} args
 * @param {string} [userRoot] the caller's own folder; defaults to the whole
 *   capability root, which is what the boundary suites drive directly.
 */
export async function callFilesystemTool(name, args, userRoot = currentRootDir) {
  if (!ready) throw new Error('filesystem MCP server is not ready')
  const blocked = containmentError(userRoot, args)
  if (blocked) return blocked
  const result = await request('tools/call', { name, arguments: toAbsolutePathArgs(userRoot, args) })
  return pathsToRelative(result, userRoot)
}

// ---------------------------------------------------------------------------
// Provider interface — matches the toolDefs(cfg)/callTool(name, args, cfg, ctx)
// shape mcp-server.mjs expects from every entry in its PROVIDERS array, so this
// module drops into that list in place of the old in-process fs-tool.mjs. The
// child process's lifecycle is driven separately via syncFilesystemProvider()
// (wired to server start/stop + config changes); these two functions only
// expose/route its tools.
// ---------------------------------------------------------------------------

export function toolDefs(cfg) {
  if (!cfg?.fileSystem?.enabled) return []
  // Only what the LLM/MCP client needs — drop the upstream server's
  // outputSchema/execution fields to match the other providers' tool shape.
  //
  // `annotations` is deliberately KEPT (it used to be dropped with the rest):
  // mcp-server.mjs stamps every advertised tool with Redstart's own provenance
  // annotation, and stripping the field here just meant the merge loop had to
  // rebuild from nothing. Upstream's own hints are preserved underneath ours.
  return getCachedFilesystemTools().map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    ...(t.annotations ? { annotations: t.annotations } : {}),
  }))
}

// Tools whose success means "a file now exists at args.path". Their results get
// a [FILE: ...] marker so the chat UI renders a download button — the upstream
// server just says "Successfully wrote to ...", which left every file written
// through this capability (scripts especially) unreachable from a browser
// client even though /files/download already serves the fileSystem root.
const FILE_PRODUCING_TOOLS = new Set(['write_file', 'edit_file'])

// The marker must start its own line and carry the path RELATIVE to the served
// root — see documents-tool.mjs for the other end of the same contract.
function withDownloadMarker(result, rootDir, requestedPath) {
  if (result?.isError || typeof requestedPath !== 'string' || !Array.isArray(result?.content)) return result
  let relativePath
  try {
    relativePath = path.relative(rootDir, resolveWithinRoot(rootDir, requestedPath)).split(path.sep).join('/')
  } catch {
    return result // uncontained or unresolvable — no download link to offer
  }
  // path.relative returns '' when the argument IS the root (a directory, not a
  // file), and a '..' prefix would mean it escaped; neither is downloadable.
  if (!relativePath || relativePath.startsWith('..')) return result
  const first = result.content[0]
  if (first?.type !== 'text') return result
  return {
    ...result,
    content: [{ ...first, text: `[FILE: ${relativePath}]\n${first.text}` }, ...result.content.slice(1)],
  }
}

// Provider interface: callTool(name, args, cfg, ctx). `ctx.account` is the
// authenticated caller (null when auth is off).
//
// PER-ACCOUNT SCOPING. Every call is confined to the caller's own folder inside
// the configured root, not to the root itself. This is the capability with the
// widest blast radius — arbitrary reads and writes over one folder shared by
// the entire server — so the containment the model faces is the narrower of the
// two roots, always.
export async function callTool(name, args, cfg, ctx) {
  if (!FILESYSTEM_TOOL_NAME_SET.has(name)) return null // not ours — let the next provider try

  const fsCfg = cfg?.fileSystem
  if (!fsCfg?.enabled || !fsCfg?.rootDir) {
    return { isError: true, content: [{ type: 'text', text: 'File system is not configured or enabled.' }] }
  }
  let userRoot
  try {
    userRoot = resolveUserRoot(fsCfg.rootDir, ctx?.account, { create: true })
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Could not open your file storage: ${err.message}` }] }
  }

  // Answered here rather than by the child. The child was spawned with the
  // CAPABILITY root and would report that — a path pathsToRelative cannot strip,
  // because it is a prefix of the caller's root rather than a match. Reporting
  // it would hand every model the server's on-disk layout and the fact that
  // sibling account folders live next door. The caller's own storage is the only
  // directory it can reach, and it addresses everything relative to it anyway.
  if (name === 'list_allowed_directories') {
    return {
      content: [{
        type: 'text',
        text: 'Allowed directories:\n. (your own file storage on the Redstart server — give every path relative to it)',
      }],
    }
  }

  try {
    const result = await callFilesystemTool(name, args ?? {}, userRoot)
    if (FILE_PRODUCING_TOOLS.has(name)) return withDownloadMarker(result, userRoot, args?.path)
    return result
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `File system error: ${err.message}` }] }
  }
}
