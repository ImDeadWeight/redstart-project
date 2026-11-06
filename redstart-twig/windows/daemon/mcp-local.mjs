// =============================================================================
// Redstart Twig: local stdio MCP servers (twig-mcp.json)
// =============================================================================
// Config file I/O and the message relay for the local stdio MCP servers the
// user configures. Process spawn, framing and crash-restart supervision live in
// ../../../shared/mcp-stdio-process.mjs, which also backs Nest's MCP providers.
// All MCP *protocol* logic (initialize, capabilities, tools) lives in the
// chat-ui's SDK client. This module is a dumb pipe plus a process supervisor,
// so there is exactly one MCP host implementation.
//
// It ran in Electron's main process until the Tauri move. Now it runs in twigd
// and knows nothing about windows: `send` delivers child output to the shell,
// which emits it to the page as an event.
//
// Trust boundary: servers are defined in <config>/twig-mcp.json, a local,
// hand-editable file (the claude_desktop_config.json analog). Entries are
// arbitrary command execution by design, so the file is NEVER synced from
// Redstart Nest or the network. The page may add or remove entries (it is
// first-party UI, served by the shell), but a spawn always resolves its command
// from what is on disk at start time.
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { createStdioProcessManager } from '../../../shared/mcp-stdio-process.mjs'

/**
 * @param {object} deps
 * @param {string} deps.configDir  Twig's state directory
 * @param {(type: string, payload: object) => void} deps.send  one-way message to the shell
 */
export function createLocalMcp({ configDir, send }) {
  const configPath = path.join(configDir, 'twig-mcp.json')

  // Defensive read: a malformed file must never crash twigd. It just means
  // "no local servers", and a warning in the log for the user to find.
  function loadConfig() {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      const servers = raw?.mcpServers
      if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return {}

      const valid = {}
      for (const [id, entry] of Object.entries(servers)) {
        if (!id.trim() || typeof entry?.command !== 'string' || !entry.command.trim()) continue
        valid[id] = {
          command: entry.command.trim(),
          args: Array.isArray(entry.args) ? entry.args.map(String) : [],
          env: cleanEnv(entry.env),
        }
      }
      return valid
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('[mcp-local] Could not read twig-mcp.json:', err.message)
      return {}
    }
  }

  function saveConfig(servers) {
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: servers }, null, 2))
  }

  const manager = createStdioProcessManager({
    logDir: path.join(configDir, 'twig-mcp-logs'),
    onMessage: (id, line) => send('mcp-message', { id, line }),
    onExit: (id, info) => send('mcp-exit', { id, info }),
    // Never restart a server that has been removed from the config file since
    // it last started.
    shouldRestart: (id) => !!loadConfig()[id],
    // Crash-restarts re-read twig-mcp.json, so an edited command, args or env
    // takes effect on the next restart.
    resolveConfig: (id) => loadConfig()[id],
  })

  /** The page-callable methods, by the channel names the preload used. */
  const handlers = {
    'mcp-local:list': () => Object.entries(loadConfig()).map(([id, entry]) => ({
      id,
      command: entry.command,
      args: entry.args,
      running: manager.isRunning(id),
    })),

    'mcp-local:start': ({ id } = {}) => {
      const key = String(id)
      const cfg = loadConfig()[key]
      if (!cfg) return { ok: false, error: `No server "${key}" in twig-mcp.json` }
      return manager.start(key, cfg)
    },

    'mcp-local:stop': ({ id } = {}) => manager.stop(String(id)),

    'mcp-local:send': ({ id, line } = {}) => manager.send(String(id), line),

    'mcp-local:add': ({ id, command, args, env } = {}) => {
      const key = String(id ?? '').trim()
      if (!key) return { ok: false, error: 'Server id is required' }
      if (typeof command !== 'string' || !command.trim()) return { ok: false, error: 'Command is required' }
      const servers = loadConfig()
      servers[key] = {
        command: command.trim(),
        args: Array.isArray(args) ? args.map(String) : [],
        env: cleanEnv(env),
      }
      try {
        saveConfig(servers)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: `Could not write twig-mcp.json: ${err.message}` }
      }
    },

    'mcp-local:remove': ({ id } = {}) => {
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
    },
  }

  return {
    handlers,
    /** Kill every child. Returns the pids that were still alive, for the updater to wait on. */
    shutdown() {
      const before = manager.pids()
      manager.shutdown()
      return before
    },
  }
}

function cleanEnv(env) {
  return env && typeof env === 'object' && !Array.isArray(env)
    ? Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)]))
    : {}
}
