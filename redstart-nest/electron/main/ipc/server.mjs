// Server / llama IPC namespace — command preview and the llama-server process
// lifecycle (launch / stop / status) plus the LAN IP lookup.
//
// This namespace owns the live server process. That state is shared with the
// app lifecycle and gateway-refresh code in index.mjs, so it is threaded in as
// a mutable `serverState` object ({ process, ema, lastConfig, startedAt,
// lastError }) rather than kept as module globals here — both sides mutate
// the same object. startedAt/lastError exist for ipc/admin.mjs's full status
// endpoint (Phase 5 §5.4) and are set/cleared alongside process/lastConfig at
// every launch, exit and error.
//
// Handler bodies are exported as plain functions (Phase 1, §1.3 of the
// headless-admin-plane implementation plan) so an HTTP route can call them
// directly without dragging IPC registration in — importing this module never
// registers anything; only registerServerHandlers() does that. The six
// getMainWindow()?.webContents.send(...) calls that used to live in
// launchServer are now publish() calls into event-broker.mjs (Phase 5 §5.1) —
// the window is one subscriber among others now, registered once from
// index.mjs, rather than the only possible reader hard-coded at each site.
import { spawn } from 'child_process'
import * as path from 'path'
import { startGateway, stopGateway, getGatewayPort } from '../tools-gateway.mjs'
import { startMcpServer, stopMcpServer, getMcpServerRunning } from '../mcp-server.mjs'
import { startDiscovery, discoveryRecordFor } from '../discovery.mjs'
import { syncFilesystemProvider, stopFilesystemProvider } from '../filesystem-mcp-provider.mjs'
import { logEvent } from '../logger.mjs'
import { serverPortRejection, serverBinaryName } from './validate.mjs'
import { writePidFile, deletePidFile } from '../process-supervision.mjs'
import { publish } from '../event-broker.mjs'
import { startRun, appendLine, endRun } from '../process-log.mjs'

// EMA smoothing factor for the tokens/sec readout (moved here with its sole
// consumer, the launch handler's stdout parser).
const EMA_ALPHA = 0.2

// networkMode and config.port are launcher state folded into the llama
// config — they arrive here and are persisted nowhere else, so a daemon
// starting before any launch has no way to know whether this box is meant to
// be on the network. Recording them at launch is what lets discovery start at
// boot from the last configuration a human actually chose, rather than from a
// default nobody picked. Best-effort: a settings file that cannot be written
// must not fail a launch.
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
  return `${serverBinaryName()} ${args.join(' ')}`
}

// Phase 7 §7.6 (trap 5.5, real since Phase 3): an always-on daemon reachable
// from the tray, a browser and the Electron window at once makes concurrent
// `llama:launch`/`server:stop` calls routine rather than a race someone has
// to contrive. Module-level, not per-call — the whole point is one guard
// shared across every caller of this module, regardless of which transport
// (HTTP route, tray click) reached it.
//
// A second caller arriving while the first is still in flight is handed the
// FIRST call's own promise and therefore its own result — it does not
// re-enter launchServer()/stopServer(), so it can never reach spawn() a
// second time. That is a different (and better) outcome than the pre-Phase-7
// shape would have raced toward: not a second caller told "already running"
// after a wasted spawn, but a second caller told exactly what the first one
// achieved, including its pid on success.
let launchInFlight = null
let stopInFlight = null

export async function launchServer(config, deps) {
  if (launchInFlight) return launchInFlight
  launchInFlight = doLaunchServer(config, deps)
  try {
    return await launchInFlight
  } finally {
    launchInFlight = null
  }
}

async function doLaunchServer(config, deps) {
  const {
    serverState,
    resolveBinary,
    buildArgs,
    parseEvalTokensPerSec,
    buildGatewayConfig,
    ensureFirewallRule,
    userDataDir,
  } = deps

  // Not the concurrency guard above (that already prevented re-entry while a
  // launch is in flight) — this is the ordinary case of a launch requested
  // while a PRIOR, already-completed launch is still running.
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
    return { success: false, error: `${serverBinaryName()} not found.
Place it in the build output directory or the project root, or set a custom path via Settings.` }
  }
  const binaryDir = path.dirname(binaryPath)

  const spawnArgs = buildArgs(config, true)

  try {
    // --- Piped mode (in-app log + token tracking) ---
    serverState.ema = 0
    serverState.lastError = null
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

    // One file per launch (§5.2) — started here so even a launch that fails
    // before the first stdout line still leaves a file behind to look at.
    startRun()

    const forwardLines = (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        const tps = parseEvalTokensPerSec(line)
        if (tps !== null) {
          serverState.ema = serverState.ema === 0 ? tps : EMA_ALPHA * tps + (1 - EMA_ALPHA) * serverState.ema
          publish('server:tpm', Math.round(serverState.ema * 60))
        }
        appendLine(line)
        publish('server:log', line)
      }
    }

    child.stdout.on('data', forwardLines)
    child.stderr.on('data', forwardLines)

    child.on('error', err => {
      serverState.lastError = err.message
      appendLine(`SPAWN ERROR: ${err.message}`)
      publish('server:log', `SPAWN ERROR: ${err.message}`)
      publish('server:stopped')
      serverState.process = null
      serverState.startedAt = null
      endRun()
      deletePidFile(userDataDir)
    })

    child.on('exit', (code, signal) => {
      if (code !== 0) {
        const line = `Process exited with code ${code} (signal: ${signal})`
        serverState.lastError = line
        appendLine(line)
        publish('server:log', line)
      }
      serverState.process = null
      serverState.ema = 0
      serverState.lastConfig = null
      serverState.startedAt = null
      endRun()
      deletePidFile(userDataDir)
      publish('server:stopped')
    })

    serverState.process = child
    serverState.lastConfig = config
    serverState.startedAt = Date.now()
    // Recorded so a hard-killed Nest (Task Manager, power loss — anything
    // that skips the exit handler above) can be reaped by PID, not by name,
    // the next time Nest starts. See process-supervision.mjs.
    writePidFile(userDataDir, { pid: child.pid, binaryPath, startedAt: serverState.startedAt })

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
    // it just used, so a changed port takes effect now rather than at next
    // boot, and so the next boot has something to read: the two fields
    // discovery needs are launcher state folded into the llama config and live
    // nowhere else on disk.
    rememberDiscovery(config, deps)
    startDiscovery(discoveryRecordFor(config))

    // File System capability's child process — fire-and-forget, since spawn
    // + MCP handshake takes a moment and this handler already returned
    // success for the llama-server launch itself.
    syncFilesystemProvider(gwConfig.fileSystem, path.join(userDataDir, 'mcp-fs-logs'))
      .catch((err) => console.warn('[filesystem-mcp-provider] sync failed:', err.message))

    // Log the port only — never the model path or other config (privacy).
    logEvent('server', 'model_started', { port: config.port, networkMode: !!config.networkMode })
    // Broadcast so every OTHER connected client (a second tab, the Electron
    // window while admingate launched it, or vice versa) learns the server
    // is up — this handler's own return value only reaches the caller that
    // launched it. Mirrors publish('server:stopped') below/in stopServer(),
    // which already covered the reverse direction; this was the missing half.
    publish('server:started')
    return { success: true, pid: child.pid }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

// Discovery is deliberately absent here. Stopping the model used to unpublish
// the `.local` name and drop the clean URL, which is the lifecycle bug from the
// other side: an admin who stops the server to reconfigure it would lose the
// ability to find the box while doing so. Discovery stops with the daemon.
export async function stopServer(deps) {
  if (stopInFlight) return stopInFlight
  stopInFlight = doStopServer(deps)
  try {
    return await stopInFlight
  } finally {
    stopInFlight = null
  }
}

async function doStopServer({ serverState }) {
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

export function serverHandlers(deps) {
  const { getLocalIp } = deps
  return {
    'llama:generate-command': (config) => generateLlamaCommand(config, deps),
    'llama:launch': async (config) => launchServer(config, deps),
    'server:stop': async () => stopServer(deps),
    'server:status': async (config) => getServerStatus(config, deps),
    'server:sync-tools': (tools) => syncServerTools(tools, deps),
    'server:get-ip': () => getLocalIp(),
  }
}
