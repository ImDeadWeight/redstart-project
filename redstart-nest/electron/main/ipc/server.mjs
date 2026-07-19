// Server / llama IPC namespace — command preview and the llama-server process
// lifecycle (launch / stop / status) plus the LAN IP lookup.
//
// This namespace owns the live server process. That state is shared with the
// app lifecycle and gateway-refresh code in index.mjs, so it is threaded in as
// a mutable `serverState` object ({ process, ema, lastConfig }) rather than kept
// as module globals here — both sides mutate the same object. mainWindow is
// reassigned in index.mjs after this module registers, so it is read through a
// getMainWindow() getter, never captured by value.
import { ipcMain } from 'electron'
import { spawn } from 'child_process'
import * as path from 'path'
import { startGateway, stopGateway, getGatewayPort } from '../tools-gateway.mjs'
import { startMcpServer, stopMcpServer, getMcpServerRunning } from '../mcp-server.mjs'
import { startMdnsAdvertiser, stopMdnsAdvertiser } from '../mdns-advertiser.mjs'
import { startPort80Proxy, stopPort80Proxy } from '../port80-proxy.mjs'
import { logEvent } from '../logger.mjs'

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
}) {
  // --- Llama command preview ---

  ipcMain.handle('llama:generate-command', (_, config) => {
    const args = buildArgs(config)
    return `llama-server.exe ${args.join(' ')}`
  })

  // --- Server launch ---

  ipcMain.handle('llama:launch', async (_, config) => {
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
      // cwd = binary dir so Windows DLL search finds companion DLLs
      const child = spawn(binaryPath, spawnArgs, { stdio: ['ignore', 'pipe', 'pipe'], cwd: binaryDir })

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
      })

      child.on('exit', (code, signal) => {
        if (code !== 0) {
          getMainWindow()?.webContents.send('server:log', `Process exited with code ${code} (signal: ${signal})`)
        }
        serverState.process = null
        serverState.ema = 0
        serverState.lastConfig = null
        getMainWindow()?.webContents.send('server:stopped')
      })

      serverState.process = child
      serverState.lastConfig = config

      // Start the gateway on the public port. It injects the Redstart system
      // context into every completions request and proxies everything else
      // through to llama-server on config.port + 1 (localhost only).
      const gwConfig = buildGatewayConfig(config)
      try {
        await startGateway(config.port, gwConfig)
        const gwPort = getGatewayPort(config.port)
        if (gwPort) ensureFirewallRule(gwPort)
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
        await startMcpServer(mcpPort, gwConfig)
        if (getMcpServerRunning()) ensureFirewallRule(mcpPort)
      } catch (err) {
        console.warn('MCP server failed to start:', err.message)
      }

      // Log the port only — never the model path or other config (privacy).
      logEvent('server', 'model_started', { port: config.port, networkMode: !!config.networkMode })
      return { success: true, pid: child.pid }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  // --- Server stop (graceful) ---

  ipcMain.handle('server:stop', async () => {
    stopGateway()
    stopMcpServer()
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

  ipcMain.handle('server:status', async (_, config) => {
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

  // --- Network info ---

  ipcMain.handle('server:get-ip', () => getLocalIp())
}
