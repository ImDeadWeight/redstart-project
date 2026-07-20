// =============================================================================
// Redstart Twig (Windows) — local MCP server process manager
// =============================================================================
// Spawns stdio MCP servers (the Claude Desktop model) as child processes and
// pipes newline-delimited JSON-RPC between each child and the renderer. All
// MCP *protocol* logic (initialize, capabilities, tools) lives in the shared
// chat-ui's SDK client — this module is deliberately a dumb pipe plus a
// process supervisor, so there is exactly one MCP host implementation.
//
// Trust boundary: servers are defined in <userData>/twig-mcp.json — a local,
// hand-editable file, the claude_desktop_config.json analog. Entries are
// arbitrary command execution by design, so the file is NEVER synced from
// Redstart Nest or the network. The renderer may add/remove entries (it is
// local first-party UI behind contextIsolation), but a spawn always resolves
// its command from what is on disk at start time.
// =============================================================================

import { spawn, execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Restart-on-crash backoff (same spirit as the chat-ui's MCP_RECONNECT_*
// constants): start at 1s, double per consecutive crash, cap at 30s. A child
// that stays up for STABLE_MS resets its counter.
const RESTART_INITIAL_MS = 1_000
const RESTART_MAX_MS = 30_000
const RESTART_STABLE_MS = 30_000
// How long a child gets to exit after a polite kill before it is force-killed.
const KILL_GRACE_MS = 3_000

/** @type {import('electron').App} */ let app = null
/** @type {import('electron').IpcMain} */ let ipcMain = null
/** @type {() => import('electron').BrowserWindow | null} */ let getWindow = null

const configPath = () => path.join(app.getPath('userData'), 'twig-mcp.json')
const logDir = () => path.join(app.getPath('userData'), 'twig-mcp-logs')

// ---------------------------------------------------------------------------
// Config file
// ---------------------------------------------------------------------------

// Defensive read: a malformed file must never crash the shell — it just means
// "no local servers" (and a warning in the console for the user to find).
function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
    const servers = raw?.mcpServers
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return {}

    const valid = {}
    for (const [id, entry] of Object.entries(servers)) {
      if (!id.trim() || typeof entry?.command !== 'string' || !entry.command.trim()) continue
      valid[id] = {
        command: entry.command.trim(),
        args: Array.isArray(entry.args) ? entry.args.map(String) : [],
        env: entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env)
          ? Object.fromEntries(Object.entries(entry.env).map(([k, v]) => [k, String(v)]))
          : {},
      }
    }
    return valid
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[mcp-manager] Could not read twig-mcp.json:', err.message)
    return {}
  }
}

function saveConfig(servers) {
  fs.writeFileSync(configPath(), JSON.stringify({ mcpServers: servers }, null, 2))
}

// ---------------------------------------------------------------------------
// Child process supervision
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ManagedServer
 * @property {import('node:child_process').ChildProcess} child
 * @property {string} stdoutBuf   partial-line buffer for stdout framing
 * @property {number} restartDelay current crash-restart backoff
 * @property {ReturnType<typeof setTimeout> | null} restartTimer
 * @property {ReturnType<typeof setTimeout> | null} stableTimer
 * @property {boolean} stopping   true while a deliberate stop is in progress
 */
/** @type {Map<string, ManagedServer>} */
const running = new Map()
let quitting = false

function logStream(id) {
  try {
    fs.mkdirSync(logDir(), { recursive: true })
    return fs.createWriteStream(path.join(logDir(), `${id.replace(/[^a-zA-Z0-9._-]/g, '_')}.log`), { flags: 'a' })
  } catch {
    return null
  }
}

function sendToRenderer(channel, payload) {
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function startServer(id) {
  if (running.has(id)) return { ok: true, alreadyRunning: true }

  const cfg = loadConfig()[id]
  if (!cfg) return { ok: false, error: `No server "${id}" in twig-mcp.json` }

  // Windows quirk: `npx`/`npm` are .cmd shims, and Node's spawn() only runs
  // real executables unless shell:true. On Windows we build one quoted command
  // line ourselves and hand it to cmd.exe (passing an args array alongside
  // shell:true is deprecated — DEP0190 — because Node concatenates without
  // quoting); elsewhere spawn the command directly with the args array.
  const useShell = process.platform === 'win32'
  // Standard Windows argv quoting: backslash runs immediately before a quote
  // (or the closing quote we add) must be doubled, then quotes escaped —
  // otherwise an arg ending in `\` (any folder path) escapes its own closing
  // quote and mangles the rest of the command line.
  const quote = (a) =>
    /[\s"&|<>^%]/.test(a) || a === ''
      ? '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"'
      : a

  let child
  try {
    child = useShell
      ? spawn([cfg.command, ...cfg.args].map(quote).join(' '), {
          env: { ...process.env, ...cfg.env },
          windowsHide: true,
          shell: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      : spawn(cfg.command, cfg.args, {
          env: { ...process.env, ...cfg.env },
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
  } catch (err) {
    return { ok: false, error: `Failed to spawn "${cfg.command}": ${err.message}` }
  }

  const prev = running.get(id)
  const entry = {
    child,
    stdoutBuf: '',
    restartDelay: prev?.restartDelay ?? RESTART_INITIAL_MS,
    restartTimer: null,
    stableTimer: null,
    stopping: false,
  }
  running.set(id, entry)

  // A child that survives the stability window earns a backoff reset.
  entry.stableTimer = setTimeout(() => { entry.restartDelay = RESTART_INITIAL_MS }, RESTART_STABLE_MS)

  const errLog = logStream(id)
  errLog?.write(`\n--- ${new Date().toISOString()} started: ${cfg.command} ${cfg.args.join(' ')} ---\n`)

  // Frame stdout by newline. stdout may deliver partial lines or several
  // messages per chunk — buffer the tail so the renderer only ever receives
  // whole JSON-RPC messages (that contract is what keeps the renderer
  // transport framing-free).
  child.stdout.on('data', (chunk) => {
    entry.stdoutBuf += chunk.toString('utf8')
    let nl
    while ((nl = entry.stdoutBuf.indexOf('\n')) !== -1) {
      const line = entry.stdoutBuf.slice(0, nl).replace(/\r$/, '')
      entry.stdoutBuf = entry.stdoutBuf.slice(nl + 1)
      if (line.trim()) sendToRenderer(`mcp-local:message:${id}`, line)
    }
  })

  // stderr is server logging, never protocol traffic — file only.
  child.stderr.on('data', (chunk) => errLog?.write(chunk))

  child.on('error', (err) => {
    errLog?.write(`spawn error: ${err.message}\n`)
    sendToRenderer(`mcp-local:exit:${id}`, { error: err.message })
  })

  child.on('exit', (code, signal) => {
    errLog?.write(`--- exited code=${code} signal=${signal} ---\n`)
    errLog?.end()
    clearTimeout(entry.stableTimer)
    const wasStopping = entry.stopping
    running.delete(id)
    sendToRenderer(`mcp-local:exit:${id}`, { code, signal })

    // Crash restart with capped backoff — but never for deliberate stops or
    // while quitting, and only if the entry still exists in the config.
    if (!wasStopping && !quitting && loadConfig()[id]) {
      const delay = entry.restartDelay
      entry.restartDelay = Math.min(entry.restartDelay * 2, RESTART_MAX_MS)
      const timer = setTimeout(() => {
        if (!quitting && !running.has(id)) {
          const res = startServer(id)
          if (res.ok) {
            const restarted = running.get(id)
            if (restarted) restarted.restartDelay = entry.restartDelay
          }
        }
      }, delay)
      timer.unref?.()
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

function stopServer(id) {
  const entry = running.get(id)
  if (!entry) return { ok: true, wasRunning: false }
  entry.stopping = true
  clearTimeout(entry.restartTimer)
  clearTimeout(entry.stableTimer)
  try { entry.child.stdin.end() } catch { /* stream may be gone */ }
  killChild(entry.child)
  return { ok: true, wasRunning: true }
}

// ---------------------------------------------------------------------------
// Public wiring
// ---------------------------------------------------------------------------

export function initMcpManager(deps) {
  app = deps.app
  ipcMain = deps.ipcMain
  getWindow = deps.getWindow

  ipcMain.handle('mcp-local:list', () => {
    const cfg = loadConfig()
    return Object.entries(cfg).map(([id, entry]) => ({
      id,
      command: entry.command,
      args: entry.args,
      running: running.has(id),
    }))
  })

  ipcMain.handle('mcp-local:start', (_e, { id }) => startServer(String(id)))

  ipcMain.handle('mcp-local:stop', (_e, { id }) => stopServer(String(id)))

  ipcMain.handle('mcp-local:send', (_e, { id, line }) => {
    const entry = running.get(String(id))
    if (!entry) return { ok: false, error: `Server "${id}" is not running` }
    // One JSON-RPC message per line by contract; strip embedded newlines so a
    // malformed payload can't smuggle extra frames into the child.
    entry.child.stdin.write(String(line).replace(/\r?\n/g, ' ') + '\n')
    return { ok: true }
  })

  ipcMain.handle('mcp-local:add', (_e, { id, command, args, env }) => {
    const key = String(id ?? '').trim()
    if (!key) return { ok: false, error: 'Server id is required' }
    if (typeof command !== 'string' || !command.trim()) return { ok: false, error: 'Command is required' }
    const servers = loadConfig()
    servers[key] = {
      command: command.trim(),
      args: Array.isArray(args) ? args.map(String) : [],
      env: env && typeof env === 'object' && !Array.isArray(env)
        ? Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)]))
        : {},
    }
    try {
      saveConfig(servers)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: `Could not write twig-mcp.json: ${err.message}` }
    }
  })

  ipcMain.handle('mcp-local:remove', (_e, { id }) => {
    const key = String(id ?? '').trim()
    const servers = loadConfig()
    if (key in servers) {
      delete servers[key]
      try {
        saveConfig(servers)
      } catch (err) {
        return { ok: false, error: `Could not write twig-mcp.json: ${err.message}` }
      }
    }
    stopServer(key)
    return { ok: true }
  })

  app.on('before-quit', () => shutdownMcpManager())
}

/** Kill every child; called on quit so no orphans survive in Task Manager. */
export function shutdownMcpManager() {
  quitting = true
  for (const id of Array.from(running.keys())) stopServer(id)
}
