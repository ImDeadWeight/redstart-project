// =============================================================================
// Redstart Twig (Windows) — local MCP server process manager
// =============================================================================
// Config file I/O + IPC wiring + renderer relay for local stdio MCP servers.
// Process spawn/framing/crash-restart supervision lives in the shared
// ../../../shared/mcp-stdio-process.mjs (no Electron dependency there, so it
// can also back redstart-nest's MCP providers) — this module is the
// Twig-specific shell around it: it owns twig-mcp.json and pipes
// messages/exits to the renderer. All MCP *protocol* logic (initialize,
// capabilities, tools) lives in the shared chat-ui's SDK client — this module
// is deliberately a dumb pipe plus a process supervisor, so there is exactly
// one MCP host implementation.
//
// Trust boundary: servers are defined in <userData>/twig-mcp.json — a local,
// hand-editable file, the claude_desktop_config.json analog. Entries are
// arbitrary command execution by design, so the file is NEVER synced from
// Redstart Nest or the network. The renderer may add/remove entries (it is
// local first-party UI behind contextIsolation), but a spawn always resolves
// its command from what is on disk at start time.
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { createStdioProcessManager } from '../../../shared/mcp-stdio-process.mjs'

/** @type {import('electron').App} */ let app = null
/** @type {import('electron').IpcMain} */ let ipcMain = null
/** @type {() => import('electron').BrowserWindow | null} */ let getWindow = null
/** @type {ReturnType<typeof createStdioProcessManager> | null} */ let manager = null

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
// Renderer relay
// ---------------------------------------------------------------------------

function sendToRenderer(channel, payload) {
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

// ---------------------------------------------------------------------------
// Public wiring
// ---------------------------------------------------------------------------

export function initMcpManager(deps) {
  app = deps.app
  ipcMain = deps.ipcMain
  getWindow = deps.getWindow

  manager = createStdioProcessManager({
    logDir: logDir(),
    onMessage: (id, line) => sendToRenderer(`mcp-local:message:${id}`, line),
    onExit: (id, info) => sendToRenderer(`mcp-local:exit:${id}`, info),
    // Never restart a server that's been removed from the config file since
    // it last started.
    shouldRestart: (id) => !!loadConfig()[id],
    // Crash-restarts re-read twig-mcp.json so an edited command/args/env
    // takes effect on the next restart (matching the pre-refactor behavior,
    // where every start resolved its command from what is on disk).
    resolveConfig: (id) => loadConfig()[id],
  })

  ipcMain.handle('mcp-local:list', () => {
    const cfg = loadConfig()
    return Object.entries(cfg).map(([id, entry]) => ({
      id,
      command: entry.command,
      args: entry.args,
      running: manager.isRunning(id),
    }))
  })

  ipcMain.handle('mcp-local:start', (_e, { id }) => {
    const key = String(id)
    const cfg = loadConfig()[key]
    if (!cfg) return { ok: false, error: `No server "${key}" in twig-mcp.json` }
    return manager.start(key, cfg)
  })

  ipcMain.handle('mcp-local:stop', (_e, { id }) => manager.stop(String(id)))

  ipcMain.handle('mcp-local:send', (_e, { id, line }) => manager.send(String(id), line))

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
    manager.stop(key)
    return { ok: true }
  })

  app.on('before-quit', () => shutdownMcpManager())
}

/** Kill every child; called on quit so no orphans survive in Task Manager. */
export function shutdownMcpManager() {
  manager?.shutdown()
}
