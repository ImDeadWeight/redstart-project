// Server / llama IPC namespace — command preview and the llama-server process
// lifecycle (launch / stop / status) plus the LAN IP lookup.
//
// This namespace owns the live server process. That state is shared with the
// app lifecycle and gateway-refresh code in index.mjs, so it is threaded in as
// a mutable `serverState` object ({ process, ema, lastConfig }) rather than kept
// as module globals here — both sides mutate the same object. mainWindow is
// reassigned in index.mjs after this module registers, so it is read through a
// getMainWindow() getter, never captured by value.
import { handle } from './guard.mjs'
import { spawn } from 'child_process'
import * as path from 'path'
import { startGateway, stopGateway, getGatewayPort } from '../tools-gateway.mjs'
import { startMcpServer, stopMcpServer, getMcpServerRunning } from '../mcp-server.mjs'
import { startMdnsAdvertiser, stopMdnsAdvertiser } from '../mdns-advertiser.mjs'
import { startPort80Proxy, stopPort80Proxy } from '../port80-proxy.mjs'
import { syncFilesystemProvider, stopFilesystemProvider } from '../filesystem-mcp-provider.mjs'
import { logEvent } from '../logger.mjs'
import { writePidFile, deletePidFile } from '../process-supervision.mjs'

// EMA smoothing factor for the tokens/sec readout (moved here with its sole
// consumer, the launch handler's stdout parser).
const EMA_ALPHA = 0.2

export function registerServerHandlers({
  serverState,
  getMainWindow,
  resolveBinary,
  buildArgs,
  parseEvalTokensPerSec,
  buildGatewayConfig,
  ensureFirewallRule,
  getLocalIp,
  userDataDir,
  refreshLiveToolsConfig,
}) {
  // --- Llama command preview ---

  handle('llama:generate-command', (_, config) => {
    const args = buildArgs(config)
    return `llama-server.exe ${args.join(' ')}`
  })

  // --- Server launch ---

  handle('llama:launch', async (_, config) => {
    if (serverState.process) return { success: false, error: 'Server is already running' }

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
      // launcher state folded into config), so this introduces no new restart
      // semantics — mDNS and the port-80 proxy already worked this way.
      const bindHost = config.networkMode ? '0.0.0.0' : '127.0.0.1'
      try {
        await startGateway(config.port, gwConfig, { bindHost })
        const gwPort = getGatewayPort(config.port)
        if (config.networkMode && gwPort) ensureFirewallRule(gwPort)
        startMdnsAdvertiser(config)
        // Serve the login/chat UI on plain port 80 too, so users can browse to
        // http://redstart.local without the :port suffix. Falls back silently
        // to the gateway port if 80 is unavailable.
        if (config.networkMode && config.port !== 80) {
          ensureFirewallRule(80)
          startPort80Proxy(config)
        }
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
  })

  // --- Server stop (graceful) ---

  handle('server:stop', async () => {
    stopGateway()
    stopMcpServer()
    stopFilesystemProvider()
    stopMdnsAdvertiser()
    stopPort80Proxy()
    if (!serverState.process) return { success: true }
    serverState.process.kill()
    serverState.process = null
    serverState.ema = 0
    serverState.lastConfig = null
    logEvent('server', 'model_stopped', {})
    return { success: true }
  })

  // --- Server status ---

  handle('server:status', async (_, config) => {
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
  })

  // --- Live tools sync ---
  //
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
  handle('server:sync-tools', (_, tools) => {
    if (!serverState.process || !serverState.lastConfig) return { live: false }
    serverState.lastConfig = { ...serverState.lastConfig, tools }
    refreshLiveToolsConfig()
    return { live: true }
  })

  // --- Network info ---

  handle('server:get-ip', () => getLocalIp())
}
