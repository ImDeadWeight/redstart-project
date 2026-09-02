// Server / llama IPC namespace — command preview and the llama-server process
// lifecycle (launch / stop / status) plus the LAN IP lookup.
//
// This namespace owns the live server process. That state is shared with the
// app lifecycle and gateway-refresh code in index.mjs, so it is threaded in as
// a mutable `serverState` object ({ process, ema, lastConfig }) rather than kept
// as module globals here — both sides mutate the same object. mainWindow is
// reassigned in index.mjs after this module registers, so it is read through a
// getMainWindow() getter, never captured by value.
//
// Handler bodies are exported as plain functions (Phase 1, §1.3 of the
// headless-admin-plane implementation plan) so an HTTP route can call them
// directly without dragging IPC registration in — importing this module never
// registers anything; only registerServerHandlers() does that. The
// getMainWindow()?.webContents.send(...) calls inside launchServer are left
// exactly as they are: replacing them with the shared event broker is Phase 5's
// job, not this one.
import { handle } from './guard.mjs'
import { spawn } from 'child_process'
import * as path from 'path'
import { startGateway, stopGateway, getGatewayPort } from '../tools-gateway.mjs'
import { startMcpServer, stopMcpServer, getMcpServerRunning } from '../mcp-server.mjs'
import { startDiscovery, discoveryRecordFor } from '../discovery.mjs'
import { getAdminListenerState } from '../admin-listener.mjs'
import { syncFilesystemProvider, stopFilesystemProvider } from '../filesystem-mcp-provider.mjs'
import { logEvent } from '../logger.mjs'
import { serverPortRejection } from './validate.mjs'
import { writePidFile, deletePidFile } from '../process-supervision.mjs'

// EMA smoothing factor for the tokens/sec readout (moved here with its sole
// consumer, the launch handler's stdout parser).
const EMA_ALPHA = 0.2

// networkMode, advertisedHost and config.port are launcher state folded into
// the llama config — they arrive here and are persisted nowhere else, so a
// daemon starting before any launch has no way to know whether this box is
// meant to be on the network. Recording them at launch is what lets discovery
// start at boot from the last configuration a human actually chose, rather than
// from a default nobody picked. Best-effort: a settings file that cannot be
// written must not fail a launch.
function rememberDiscovery(config, { readSettings, writeSettings }) {
  try {
    const settings = readSettings()
    settings.discovery = discoveryRecordFor(config)
    writeSettings(settings)
  } catch (err) {
    console.warn('Could not record the discovery settings:', err.message)
  }
}

export function generateLlamaCommand(config, { buildArgs }) {
  const args = buildArgs(config)
  return `llama-server.exe ${args.join(' ')}`
}

export async function launchServer(config, deps) {
  const {
    serverState,
    getMainWindow,
    resolveBinary,
    buildArgs,
    parseEvalTokensPerSec,
    buildGatewayConfig,
    ensureFirewallRule,
    userDataDir,
  } = deps

  if (serverState.process) return { success: false, error: 'Server is already running' }

  // Before the binary is even resolved: config.port claims three ports, and one
  // of them colliding with the always-on beacon or admin listener produces a
  // failure a long way from its cause. See serverPortRejection() in validate.mjs.
  const portRejection = serverPortRejection(config?.port)
  if (portRejection) {
    logEvent('security', 'launch_rejected', { reason: 'port_reserved', port: config?.port })
    return { success: false, error: portRejection }
  }

  const binaryPath = resolveBinary()
  if (!binaryPath) {
    return { success: false, error: `llama-server.exe not found.\nPlace it in llama-cpp-turboquant/build/bin/Release/, the project root, or set a custom path via Settings.` }
  }
  const binaryDir = path.dirname(binaryPath)

  const spawnArgs = buildArgs(config, true)

  try {
    // --- Piped mode (in-app log + token tracking) ---
    serverState.ema = 0
    // cwd = binary dir so Windows DLL search finds companion DLLs.
    // detached (POSIX only) puts the child in its own process group, so
    // killByPid's negative-pid signal in process-supervision.mjs reaches
    // any grandchildren too, not just this one process. Windows tree-kill
    // goes through `taskkill /T` instead and does not need this.
    const child = spawn(binaryPath, spawnArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: binaryDir,
      detached: process.platform !== 'win32',
    })

    const forwardLines = (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        const tps = parseEvalTokensPerSec(line)
        if (tps !== null) {
          serverState.ema = serverState.ema === 0 ? tps : EMA_ALPHA * tps + (1 - EMA_ALPHA) * serverState.ema
          getMainWindow()?.webContents.send('server:tpm', Math.round(serverState.ema * 60))
        }
        getMainWindow()?.webContents.send('server:log', line)
      }
    }

    child.stdout.on('data', forwardLines)
    child.stderr.on('data', forwardLines)

    child.on('error', err => {
      getMainWindow()?.webContents.send('server:log', `SPAWN ERROR: ${err.message}`)
      getMainWindow()?.webContents.send('server:stopped')
      serverState.process = null
      deletePidFile(userDataDir)
    })

    child.on('exit', (code, signal) => {
      if (code !== 0) {
        getMainWindow()?.webContents.send('server:log', `Process exited with code ${code} (signal: ${signal})`)
      }
      serverState.process = null
      serverState.ema = 0
      serverState.lastConfig = null
      deletePidFile(userDataDir)
      getMainWindow()?.webContents.send('server:stopped')
    })

    serverState.process = child
    serverState.lastConfig = config
    // Recorded so a hard-killed Nest (Task Manager, power loss — anything
    // that skips the exit handler above) can be reaped by PID, not by name,
    // the next time Nest starts. See process-supervision.mjs.
    writePidFile(userDataDir, { pid: child.pid, binaryPath, startedAt: Date.now() })

    // Start the gateway on the public port. It injects the Redstart system
    // context into every completions request and proxies everything else
    // through to llama-server on config.port + 1 (localhost only).
    const gwConfig = buildGatewayConfig(config)
    // LAN exposure is a bind decision, not a firewall decision. With network
    // mode off both public listeners stay on loopback, so a LAN client gets
    // connection-refused rather than a login screen — and that holds whatever
    // the host's firewall is doing. Firewall rules are only added when we
    // actually want the LAN in, matching how the port-80 proxy already works.
    //
    // Rules are deliberately NOT removed when network mode goes off: deleting
    // one needs elevation, so a settings toggle would fire a UAC prompt, and a
    // leftover rule is inert once nothing is listening on the wildcard.
    //
    // networkMode only reaches the main process here, at server start (it is
    // launcher state folded into config), so a change to it takes effect at the
    // next launch. Discovery used to share that restart semantics and no longer
    // does — it is refreshed below and otherwise lives with the daemon.
    const bindHost = config.networkMode ? '0.0.0.0' : '127.0.0.1'
    try {
      await startGateway(config.port, gwConfig, { bindHost })
      const gwPort = getGatewayPort(config.port)
      if (config.networkMode && gwPort) ensureFirewallRule(gwPort)
    } catch (err) {
      console.warn('Tool gateway failed to start:', err.message)
      // Non-fatal — server still works, just without tool interception
    }

    // Start the built-in MCP server on port+2 so the chat-ui can call web_fetch
    // with actual whitelist enforcement (not just prompt-level advisory).
    try {
      const mcpPort = config.port + 2
      await startMcpServer(mcpPort, gwConfig, { bindHost })
      if (config.networkMode && getMcpServerRunning()) ensureFirewallRule(mcpPort)
    } catch (err) {
      console.warn('MCP server failed to start:', err.message)
    }

    // Discovery is NOT started here any more — it starts with the daemon (see
    // discovery.mjs and index.mjs). What a launch still does is push the values
    // it just used, so a changed port or advertised name takes effect now
    // rather than at next boot, and so the next boot has something to read: the
    // three fields discovery needs are launcher state folded into the llama
    // config and live nowhere else on disk.
    rememberDiscovery(config, deps)
    startDiscovery({
      adminBindHost: getAdminListenerState().bindHost,
      ...discoveryRecordFor(config),
    })

    // File System capability's child process — fire-and-forget, since spawn
    // + MCP handshake takes a moment and this handler already returned
    // success for the llama-server launch itself.
    syncFilesystemProvider(gwConfig.fileSystem, path.join(userDataDir, 'mcp-fs-logs'))
      .catch((err) => console.warn('[filesystem-mcp-provider] sync failed:', err.message))

    // Log the port only — never the model path or other config (privacy).
    logEvent('server', 'model_started', { port: config.port, networkMode: !!config.networkMode })
    return { success: true, pid: child.pid }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

// Discovery is deliberately absent here. Stopping the model used to unpublish
// the `.local` name and drop the clean URL, which is the lifecycle bug from the
// other side: an admin who stops the server to reconfigure it would lose the
// ability to find the box while doing so. Discovery stops with the daemon.
export async function stopServer({ serverState }) {
  stopGateway()
  stopMcpServer()
  stopFilesystemProvider()
  if (!serverState.process) return { success: true }
  serverState.process.kill()
  serverState.process = null
  serverState.ema = 0
  serverState.lastConfig = null
  logEvent('server', 'model_stopped', {})
  return { success: true }
}

export async function getServerStatus(config, { serverState }) {
  if (!serverState.process) return { running: false, health: null }
  try {
    const res = await fetch(`http://127.0.0.1:${config?.port || 19080}/health`, {
      signal: AbortSignal.timeout(1500),
    })
    const data = await res.json()
    return { running: true, health: data.status }
  } catch {
    return { running: true, health: 'unreachable' }
  }
}

// Capability config and the plugin registry's `enabled` switch already take
// effect on a running server without a restart, via refreshLiveToolsConfig()
// — getCapabilities()/listPlugins() re-read their own files fresh on every
// call. A profile's OWN tools settings (activeToolIds/disabledToolIds/
// activeGroupIds/tools.enabled) did NOT: buildGatewayConfig() reads those
// straight off `llamaConfig.tools`, i.e. off serverState.lastConfig — a
// snapshot frozen at `llama:launch` and never re-read from disk afterward.
// So toggling a plugin's Tools-tab activation card had no live effect at
// all until the server was stopped and restarted, unlike every other
// toggle on that same tab. This closes the gap the same way: merge the new
// tools settings into the live snapshot, then refresh.
//
// A no-op when nothing is running (serverState.process null) or nothing has
// been launched yet this session (lastConfig null) — there is no live
// server to push to, and the next launch will read the saved profile fresh
// regardless.
export function syncServerTools(tools, { serverState, refreshLiveToolsConfig }) {
  if (!serverState.process || !serverState.lastConfig) return { live: false }
  serverState.lastConfig = { ...serverState.lastConfig, tools }
  refreshLiveToolsConfig()
  return { live: true }
}

export function registerServerHandlers(deps) {
  const { getLocalIp } = deps

  // --- Llama command preview ---

  handle('llama:generate-command', (_, config) => generateLlamaCommand(config, deps))

  // --- Server launch ---

  handle('llama:launch', async (_, config) => launchServer(config, deps))

  // --- Server stop (graceful) ---

  handle('server:stop', async () => stopServer(deps))

  // --- Server status ---

  handle('server:status', async (_, config) => getServerStatus(config, deps))

  // --- Live tools sync ---

  handle('server:sync-tools', (_, tools) => syncServerTools(tools, deps))

  // --- Network info ---

  handle('server:get-ip', () => getLocalIp())
}
