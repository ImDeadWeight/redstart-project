// Server / llama IPC namespace — command preview and the llama-server process
// lifecycle (launch / stop / status) plus the LAN IP lookup.
//
// This namespace owns the live server process. That state is shared with the
// app lifecycle and gateway-refresh code in index.mjs, so it is threaded in as
// a mutable `serverState` object ({ process, ema, lastConfig, startedAt,
// lastError }) rather than kept as module globals here — both sides mutate
// the same object. startedAt/lastError exist for ipc/admin.mjs's full status
// endpoint and are set/cleared alongside process/lastConfig at every launch,
// exit and error.
//
// Handler bodies are exported as plain functions so an HTTP route can call them
// directly without dragging IPC registration in — importing this module never
// registers anything; only registerServerHandlers() does that. The six
// getMainWindow()?.webContents.send(...) calls that used to live in
// launchServer are now publish() calls into event-broker.mjs —
// the window is one subscriber among others now, registered once from
// index.mjs, rather than the only possible reader hard-coded at each site.
import { spawn } from 'child_process'
import * as path from 'path'
import { startGateway, stopGateway } from '../tools-gateway.mjs'
import { startMcpServer, stopMcpServer } from '../mcp-server.mjs'
import { discoveryRecordFor } from '../discovery.mjs'
import { lanOwner } from '../lan.mjs'
import { readTls } from '../tls-settings.mjs'
import { syncFilesystemProvider, stopFilesystemProvider } from '../filesystem-mcp-provider.mjs'
import { logEvent } from '../logger.mjs'
import { serverPortRejection, serverBinaryName } from './validate.mjs'
import { writePidFile, deletePidFile } from '../process-supervision.mjs'
import { publish } from '../event-broker.mjs'
import { startRun, appendLine, endRun } from '../process-log.mjs'
import { chooseChatTemplate } from '../chat-template-choice.mjs'
import { resolveProjector } from '../projector.mjs'
import { probeCacheTypes, resolveKvCache } from '../kv-cache.mjs'
import { getUpstreamPort, setUpstreamPort, beginModelSuspension, endModelSuspension, completionsInFlight } from '../completion-activity.mjs'

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

// The preview applies the same chat-template choice as the launch, so a
// skipped override is missing from the preview too.
// The KV-cache types too: the preview asks the same binary the launch would
// run which cache types it accepts (kv-cache.mjs), so a TurboQuant+ binary
// previews turbo types and upstream llama.cpp previews its own.
export async function generateLlamaCommand(config, { buildArgs, resolveBinary, execFileAsync }) {
  let binaryPath = null
  try { binaryPath = resolveBinary?.() ?? null } catch { binaryPath = null }
  const cacheTypes = await probeCacheTypes(binaryPath, { execFileAsync })
  const args = buildArgs(resolveKvCache(resolveProjector(chooseChatTemplate(config).config).config, cacheTypes).config)
  return `${serverBinaryName()} ${args.join(' ')}`
}

// An always-on daemon reachable
// from the tray, a browser and the Electron window at once makes concurrent
// `llama:launch`/`server:stop` calls routine rather than a race someone has
// to contrive. Module-level, not per-call — the whole point is one guard
// shared across every caller of this module, regardless of which transport
// (HTTP route, tray click) reached it.
//
// A second caller arriving while the first is still in flight is handed the
// FIRST call's own promise and therefore its own result — it does not
// re-enter launchServer()/stopServer(), so it can never reach spawn() a
// second time. That is a different (and better) outcome than the earlier,
// unguarded shape would have raced toward: not a second caller told "already running"
// after a wasted spawn, but a second caller told exactly what the first one
// achieved, including its pid on success.
//
// COALESCING IS PER KIND; EXCLUSION IS ACROSS THEM. The two flags above
// deduplicate callers asking for the SAME transition. They do not order a
// launch against a stop, and that was a real gap rather than a theoretical
// one: `serverState.process` is assigned synchronously right after spawn(),
// but startGateway() and startMcpServer() are awaited AFTER it. A stop landing
// in that window ran stopGateway() against a gateway that had not started
// yet, killed the child, nulled the state — and then the launch resumed and
// started the gateway anyway, returning success. The box was left with a
// gateway listening in front of nothing and a UI that said stopped.
//
// So the two flags are kept for coalescing and a single chain is added
// underneath for exclusion. Every lifecycle transition queues behind the
// previous one, whichever kind it was, so the launch tail above can no longer
// interleave with a stop's teardown.
let launchInFlight = null
let stopInFlight = null

// The tail of the lifecycle chain. Not a promise anyone awaits for a RESULT —
// only for its timing — so it is kept deliberately settled-and-empty: a
// transition that rejects must order the next one, not poison it.
let lifecycleTail = Promise.resolve()

/**
 * Run one lifecycle transition after every transition already queued.
 *
 * `.then(fn, fn)` rather than `.then(fn)` for the same reason the tail is
 * neutralised below: a previous transition that threw has already been
 * reported to ITS caller, and must not silently cancel this one.
 */
function runExclusive(fn) {
  const result = lifecycleTail.then(fn, fn)
  lifecycleTail = result.then(() => {}, () => {})
  return result
}

export async function launchServer(config, deps) {
  if (launchInFlight) return launchInFlight
  launchInFlight = runExclusive(() => doLaunchServer(config, deps))
  try {
    return await launchInFlight
  } finally {
    launchInFlight = null
  }
}

/**
 * Spawn llama-server for `config` and wire its output, exit and pidfile into
 * serverState. Shared by a launch and by a resume after image generation
 * (resumeModel), so both run exactly the same arguments, template choice,
 * projector and run log. Throws only if spawn() itself throws.
 *
 * The exit handler tells a SUSPEND apart from a stop or a crash by
 * serverState.suspending, which suspendModel() sets before the kill: a
 * suspended model keeps lastConfig (the resume needs it), and nothing
 * publishes server:stopped, because the server has not stopped — the gateway,
 * MCP server and file-system provider are all still up.
 */
function spawnLlama(config, deps, binaryPath, cacheTypes = null) {
  const { serverState, buildArgs, parseEvalTokensPerSec, userDataDir } = deps
  const binaryDir = path.dirname(binaryPath)
  // A bundled template override is checked against the model before it is
  // applied; see chat-template-choice.mjs. The decision goes into the run's
  // log below, and into the status (source only, no paths).
  const template = chooseChatTemplate(config)
  // Then the vision projector, on the template's output, the same order the
  // preview uses. See projector.mjs.
  const projector = resolveProjector(template.config)
  // Then the KV-cache preset, mapped to the types this binary accepts
  // (cacheTypes, probed by the caller; see kv-cache.mjs).
  const kv = resolveKvCache(projector.config, cacheTypes)
  const spawnArgs = buildArgs(kv.config, true)

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

  // One file per launch — started here so even a launch that fails
  // before the first stdout line still leaves a file behind to look at.
  startRun()
  // What llama-server does not say for itself: which template Redstart
  // chose and why, and the exact argument list. The model path is already
  // in this file (llama-server prints it), and this log is admin-only.
  appendLine(template.logLine)
  publish('server:log', template.logLine)
  appendLine(projector.logLine)
  publish('server:log', projector.logLine)
  appendLine(kv.logLine)
  publish('server:log', kv.logLine)
  appendLine(`[redstart] args: ${spawnArgs.join(' ')}`)

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
    if (serverState.suspending) {
      // Killed on purpose to free the GPU (suspendModel). Not a stop.
      serverState.process = null
      serverState.ema = 0
      serverState.startedAt = null
      appendLine('[redstart] model paused to free the GPU for image generation')
      endRun()
      deletePidFile(userDataDir)
      return
    }
    if (code !== 0) {
      const line = `Process exited with code ${code} (signal: ${signal})`
      serverState.lastError = line
      appendLine(line)
      publish('server:log', line)
    }
    serverState.process = null
    serverState.ema = 0
    serverState.lastConfig = null
    serverState.chatTemplate = null
    serverState.vision = null
    serverState.startedAt = null
    endRun()
    deletePidFile(userDataDir)
    publish('server:stopped')
  })

  serverState.process = child
  serverState.lastConfig = config
  serverState.chatTemplate = {
    source: template.decision.source,
    architecture: template.decision.architecture,
    warning: template.decision.warning,
  }
  serverState.vision = projector.decision
  serverState.startedAt = Date.now()
  // Recorded so a hard-killed Nest (Task Manager, power loss — anything
  // that skips the exit handler above) can be reaped by PID, not by name,
  // the next time Nest starts. See process-supervision.mjs.
  writePidFile(userDataDir, { pid: child.pid, binaryPath, startedAt: serverState.startedAt })
  return child
}

async function doLaunchServer(config, deps) {
  const {
    serverState,
    resolveBinary,
    buildGatewayConfig,
    userDataDir,
    networkOwner = lanOwner(),
  } = deps

  // Not the concurrency guard above (that already prevented re-entry while a
  // launch is in flight) — this is the ordinary case of a launch requested
  // while a PRIOR, already-completed launch is still running.
  if (serverState.process) return { success: false, error: 'Server is already running' }
  // Paused for image generation: the gateway is still up, and the model comes
  // back by itself when the image is done.
  if (serverState.suspended) return { success: false, error: 'The model is paused while an image is generated; it reloads by itself when the image is done.' }

  // Before the binary is even resolved: config.port claims three ports, and one
  // of them colliding with the always-on beacon or admin listener produces a
  // failure a long way from its cause. See serverPortRejection() in validate.mjs.
  // While HTTPS is on, 80 and 443 are Caddy's too (TLS plan C9).
  let httpsFronted = false
  try { httpsFronted = readTls(deps.readSettings?.() ?? {}).mode !== 'off' } catch { /* unreadable settings: today's rule */ }
  const portRejection = serverPortRejection(config?.port, { httpsFronted })
  if (portRejection) {
    logEvent('security', 'launch_rejected', { reason: 'port_reserved', port: config?.port })
    return { success: false, error: portRejection }
  }

  const binaryPath = resolveBinary()
  if (!binaryPath) {
    return { success: false, error: `${serverBinaryName()} not found.
Place it in the build output directory or the project root, or set a custom path via Settings.` }
  }
  // Asked before the spawn, never in it: `--help` is a second short run of the
  // same binary, cached per binary file after the first answer.
  const cacheTypes = await probeCacheTypes(binaryPath, deps)
  try {
    const child = spawnLlama(config, deps, binaryPath, cacheTypes)

    // Start the gateway on the public port. It injects the Redstart system
    // context into every completions request and proxies everything else
    // through to llama-server on config.port + 1 (localhost only).
    const gwConfig = buildGatewayConfig(config)
    // LAN exposure is a bind decision, not a firewall decision, and since TLS
    // step 3 it is not this function's: the network-mode owner (C2b,
    // network-mode-owner.mjs) decides the bind host, the port-80 proxy, Caddy
    // and the firewall rules, from the inputs this launch reports. With
    // network mode off both public listeners stay on loopback; with Caddy
    // fronting them they ALSO stay on loopback, and only Caddy faces the LAN.
    // Firewall rules are added by the owner and never removed (elevation).
    //
    // networkMode reaches the daemon here, at server start (it is launcher
    // state folded into config), so a change to it takes effect at the next
    // launch, as before.
    await networkOwner.update({ networkMode: config.networkMode === true, gatewayPort: config.port })
    const bindHost = networkOwner.dataPlaneHost()
    try {
      await startGateway(config.port, gwConfig, { bindHost })
    } catch (err) {
      console.warn('Tool gateway failed to start:', err.message)
      // Non-fatal — server still works, just without tool interception
    }

    // Start the built-in MCP server on port+2 so the chat-ui can call web_fetch
    // with actual whitelist enforcement (not just prompt-level advisory).
    try {
      const mcpPort = config.port + 2
      await startMcpServer(mcpPort, gwConfig, { bindHost })
    } catch (err) {
      console.warn('MCP server failed to start:', err.message)
    }

    // The owner already applied this launch's networkMode/port above (the
    // port-80 proxy included). What is left is to record them, so the next
    // boot starts where this left off: they are launcher state folded into
    // the llama config and live nowhere else on disk.
    rememberDiscovery(config, deps)

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

// ---------------------------------------------------------------------------
// Pause and resume, for image generation (gpu-lease.mjs)
// ---------------------------------------------------------------------------
// A 12 GB card cannot hold a chat model and a diffusion model at once
// (docs/notes/image-generation-plan.md §8: Flux schnell peaks at 11.2 GB on its
// own). So the GPU lease pauses the model: ONLY the llama-server child is
// killed. The gateway, the built-in MCP server and the file-system provider
// stay up, because the tool call that asked for the image arrived through the
// MCP server and its answer goes back the same way; stopServer() would cut it
// off. Completions that arrive meanwhile are held by the gateway
// (completion-activity.mjs whenModelReady), and the upstream port reads null,
// so tasks wait for a model and the memory review stays idle.
//
// Both go on the lifecycle chain, so a user's Stop or Launch cannot interleave
// with a pause or a resume. Stop while paused wins: doStopServer clears
// serverState.suspended, and the resume that follows finds nothing to do.

const SUSPEND_EXIT_TIMEOUT_MS = 15_000
// How long a pause waits for replies already being generated (plan U-IG5).
const SUSPEND_DRAIN_TIMEOUT_MS = 60_000
const DRAIN_POLL_MS = 100
const RESUME_READY_TIMEOUT_MS = 180_000
const RESUME_POLL_MS = 250
// A failed resume ends in a full stop, but not at once: the stop force-closes
// every connection, including the one carrying the image tool's own answer.
const FAILED_RESUME_STOP_DELAY_MS = 3_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Pause the chat model to free the GPU. Resolves once the process has exited.
 *
 * @returns {Promise<{ ok: true, already?: true } | { ok: false, notRunning?: true, error?: string }>}
 */
export async function suspendModel(deps, {
  reason = 'image generation',
  exitTimeoutMs = SUSPEND_EXIT_TIMEOUT_MS,
  drainTimeoutMs = SUSPEND_DRAIN_TIMEOUT_MS,
  inFlight = completionsInFlight,
} = {}) {
  return runExclusive(() => doSuspendModel(deps, reason, exitTimeoutMs, drainTimeoutMs, inFlight))
}

async function doSuspendModel({ serverState }, reason, exitTimeoutMs, drainTimeoutMs, inFlight) {
  if (serverState.suspended) return { ok: true, already: true }
  const child = serverState.process
  if (!child) return { ok: false, notRunning: true }

  const since = Date.now()
  const savedPort = getUpstreamPort()
  setUpstreamPort(null)
  beginModelSuspension({ since, reason })

  // ORDER MATTERS. The pause is marked first, so the gateway holds anything
  // new (gateway/model-hold.mjs) and tasks see no upstream port; THEN the
  // replies already streaming are let finish. Checking "nothing in flight"
  // before marking would leave a gap in which a request is forwarded to a
  // process about to be killed.
  const drainDeadline = Date.now() + drainTimeoutMs
  while (inFlight() > 0 && Date.now() < drainDeadline) await sleep(DRAIN_POLL_MS)
  if (inFlight() > 0) {
    setUpstreamPort(savedPort)
    endModelSuspension(true)
    logEvent('server', 'model_suspend_busy', { reason, inFlight: inFlight() })
    return { ok: false, busy: true, error: `The model is still answering after ${Math.round(drainTimeoutMs / 1000)} s, so the GPU was not taken.` }
  }
  if (serverState.process !== child) {
    // Exited (crashed, or stopped) while draining: nothing to pause.
    endModelSuspension(false)
    return { ok: false, notRunning: true }
  }

  serverState.suspending = true
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve()
    else child.once('exit', () => resolve())
  })
  const waitExit = (ms) => Promise.race([exited.then(() => true), sleep(ms).then(() => false)])
  child.kill()
  let gone = await waitExit(exitTimeoutMs)
  if (!gone) {
    try { child.kill('SIGKILL') } catch { /* already going */ }
    gone = await waitExit(5_000)
  }
  serverState.suspending = false
  if (!gone) {
    // Still holding the GPU. Do not pretend otherwise: undo the pause, and
    // the image job is refused rather than run into an out-of-memory.
    setUpstreamPort(savedPort)
    endModelSuspension(true)
    logEvent('server', 'model_suspend_failed', { reason })
    return { ok: false, error: 'The chat model did not exit, so the GPU could not be freed.' }
  }
  serverState.suspended = { since, reason, upstreamPort: savedPort }
  logEvent('server', 'model_suspended', { reason })
  publish('server:suspended', { reason, since })
  return { ok: true }
}

/**
 * Bring the paused model back with the config it was running, and wait until
 * it answers /health. A no-op when nothing is paused (it was stopped).
 *
 * @returns {Promise<{ ok: true, skipped?: true, ms?: number } | { ok: false, error: string }>}
 */
export async function resumeModel(deps, { readyTimeoutMs = RESUME_READY_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  return runExclusive(() => doResumeModel(deps, readyTimeoutMs, fetchImpl))
}

async function doResumeModel(deps, readyTimeoutMs, fetchImpl) {
  const { serverState, resolveBinary } = deps
  const paused = serverState.suspended
  if (!paused) return { ok: true, skipped: true }
  const config = serverState.lastConfig
  const started = Date.now()

  const fail = (error) => {
    serverState.suspended = null
    serverState.lastError = error
    serverState.lastConfig = null
    serverState.chatTemplate = null
    serverState.vision = null
    endModelSuspension(false)
    appendLine(`[redstart] ${error}`)
    publish('server:log', `[redstart] ${error}`)
    logEvent('server', 'model_resume_failed', {})
    const t = setTimeout(() => { stopServer(deps).catch(() => {}) }, FAILED_RESUME_STOP_DELAY_MS)
    t.unref?.()
    return { ok: false, error }
  }

  const binaryPath = resolveBinary()
  if (!config || !binaryPath) return fail('The chat model could not be reloaded after image generation: its configuration or binary is gone.')

  const cacheTypes = await probeCacheTypes(binaryPath, deps)
  let child
  try {
    child = spawnLlama(config, deps, binaryPath, cacheTypes)
  } catch (err) {
    return fail(`The chat model could not be reloaded after image generation: ${err.message}`)
  }

  const port = config.port + 1
  const deadline = started + readyTimeoutMs
  let ready = false
  while (Date.now() < deadline && serverState.process === child) {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) { ready = true; break }
    } catch { /* still loading */ }
    await sleep(RESUME_POLL_MS)
  }
  if (!ready) {
    if (serverState.process === child) { try { child.kill() } catch { /* gone */ } }
    return fail(serverState.lastError
      ? `The chat model did not come back after image generation: ${serverState.lastError}`
      : `The chat model did not come back within ${Math.round(readyTimeoutMs / 1000)} s after image generation.`)
  }

  serverState.suspended = null
  setUpstreamPort(paused.upstreamPort ?? port)
  endModelSuspension(true)
  const ms = Date.now() - started
  logEvent('server', 'model_resumed', { ms, pausedMs: Date.now() - paused.since })
  publish('server:resumed', { ms })
  return { ok: true, ms }
}

// Discovery is deliberately absent here. Stopping the model used to unpublish
// the `.local` name and drop the clean URL, which is the lifecycle bug from the
// other side: an admin who stops the server to reconfigure it would lose the
// ability to find the box while doing so. Discovery stops with the daemon.
export async function stopServer(deps) {
  if (stopInFlight) return stopInFlight
  stopInFlight = runExclusive(() => doStopServer(deps))
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
  // Stopped while paused for image generation: there is no process to kill,
  // and the pending resume must find nothing to resume. Held completions are
  // told the model is not coming back.
  if (serverState.suspended) {
    serverState.suspended = null
    serverState.lastConfig = null
    serverState.chatTemplate = null
    serverState.vision = null
    endModelSuspension(false)
    logEvent('server', 'model_stopped', { whileSuspended: true })
    publish('server:stopped')
    return { success: true }
  }
  if (!serverState.process) return { success: true }
  serverState.process.kill()
  serverState.process = null
  serverState.ema = 0
  serverState.lastConfig = null
  logEvent('server', 'model_stopped', {})
  return { success: true }
}

export async function getServerStatus(config, { serverState }) {
  // Paused for image generation: the server is up (gateway and tools serve),
  // the model is not loaded. Not "stopped", which the launcher would offer to
  // start.
  if (serverState.suspended) {
    return { running: true, health: 'suspended', suspended: { since: serverState.suspended.since, reason: serverState.suspended.reason } }
  }
  if (!serverState.process) return { running: false, health: null }
  // Ask llama-server itself, on its loopback port (configured port + 1), not
  // the gateway: with sign-in required (the default) the gateway answers this
  // unauthenticated probe with a 401, and the launcher showed "—" instead of
  // the model's health. The port is the one the model was launched with, not
  // whatever the launcher's form says now.
  const gatewayPort = serverState.lastConfig?.port || config?.port || 19080
  try {
    const res = await fetch(`http://127.0.0.1:${gatewayPort + 1}/health`, {
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
