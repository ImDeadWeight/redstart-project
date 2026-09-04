'use strict'

// =============================================================================
// Redstart Nest — the daemon
// =============================================================================
// Everything that is Nest-the-service, extracted from index.mjs in Phase 8A.2
// so that a plain-Node process can run it. The Electron launcher and
// bin/nestd.mjs are two entrypoints onto this one module; the daemon itself
// cannot tell them apart, which is decision 6 ("the Electron UI is a client of
// the daemon, like Twig") reaching the code.
//
// The seam was already a line in a file. index.mjs's main() ran paths, logger,
// process log, capability folders, stale-process reaping, the admin API table,
// the beacon and the admin plane — and only then the tray and the window.
// Everything above the tray is here now; everything below it stayed there.
//
// WHAT IS DELIBERATELY NOT HERE:
//   - The window, the tray, the close notice, popup containment, the
//     single-instance lock: client concerns, all Electron-only.
//   - migrateUserDataFromBeaver(): one-time glue tied to Electron's app-name
//     userData scheme, not a "where does data live" question this ever asks.
//   - initPaths() and initSecrets(): the entrypoint decides where state lives
//     and how secrets are encrypted, and those two answers are exactly what
//     differ between a desktop install and an appliance (§1.1, §3.1). Passing
//     them in rather than deciding them here is the whole point.
//
// THE EXIT-CODE CONTRACT (§8A.2, and 8B.3's supervisor depends on it):
//   1  the daemon crashed — a supervisor should restart it
//   0  someone deliberately stopped it — a supervisor should leave it down
// Phase 7 already chose these correctly (crash-handler's app.exit(1), §7.5's
// ordinary quit). Both entrypoints must preserve them, or the admin UI's
// "Shut down" becomes a button that gets undone a second later.
// =============================================================================

import { execFile } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'
import * as fs from 'fs'
import { fileURLToPath } from 'url'
import { ensureDefaultCapabilityFolders } from './tools-storage.mjs'
import { stopGateway } from './tools-gateway.mjs'
import { stopMcpServer } from './mcp-server.mjs'
import { startBeaconServer, stopBeaconServer } from './beacon.mjs'
import { startAdminListener, stopAdminListener, DEFAULT_ADMIN_BIND_HOST } from './admin-listener.mjs'
import { startDiscovery, stopDiscovery, lastKnownDiscovery } from './discovery.mjs'
import { ensureBootstrapToken } from './bootstrap-token.mjs'
import { buildAdminApi } from './admin/api-table.mjs'
import { setAdminApi } from './admin/api-routes.mjs'
import { ensureFirewallRule } from './firewall.mjs'
import { getPrimaryLanIp } from './net-interfaces.mjs'
import { cleanupOldConversations } from './conversations-storage.mjs'
import { initLogger, closeLogger, logEvent } from './logger.mjs'
import { initProcessLog } from './process-log.mjs'
import { reapStaleProcess, deletePidFile } from './process-supervision.mjs'
import { writeDaemonPid, clearDaemonPid } from './daemon-pidfile.mjs'
import { configDir, capabilityBaseDir, isPackaged } from './platform-paths.mjs'
import { buildGatewayConfig, createRefreshLiveToolsConfig } from './gateway-config.mjs'
import { buildArgs } from './llama-args.mjs'
import { binaryPathRejection, serverBinaryName } from './ipc/validate.mjs'
import { setPluginCapabilityProvider } from './tools-definitions.mjs'
import { pluginCapabilities } from './plugin-registry.mjs'
import { sweepPendingDeletions } from './plugin-install.mjs'
import { describeCrash } from './crash-handler.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// What the entrypoint supplies
// ---------------------------------------------------------------------------
// Set by startDaemon(). Everything in here is something the two entrypoints
// answer differently — how to quit, how to warn a human, whether a failure to
// bind the control plane is survivable.
let host = null

const DEFAULT_HOST = {
  // The ONE deliberate-quit path admin:shutdown gets (§7.5). Electron defers
  // app.quit(); nestd stops the daemon and exits 0.
  quitApp: () => {},
  // Best-effort human warning on a crash. A desktop has a notification area;
  // a headless box has the log and nothing else.
  notifyCrash: () => {},
  // How the crash path leaves. Never a plain return: the process is in a
  // suspect state by then.
  exitCrashed: () => process.exit(1),
  // Whether the daemon can survive not owning the control plane. On the
  // desktop it can (the daemon still runs; only the UI cannot reach it —
  // and §7.1's single-instance lock means a second process rarely gets
  // this far). Headless it cannot: a daemon that controls nothing is worse
  // than one that failed loudly, and §7.1's "make the failure legible"
  // applies with more force where there is no window to notice.
  adminBindFailureIsFatal: false,
}

// Live server process state, shared by reference between the server IPC handlers
// (ipc/server.mjs, which owns launch/stop/status) and the lifecycle +
// gateway-refresh code in this module that reads it. process: the spawned
// llama-server child; ema: smoothed tokens/sec; lastConfig: set on launch,
// cleared on stop/exit.
const serverState = { process: null, ema: 0, lastConfig: null }
let beaconServerInstance = null

// Live tool-config refresh, bound to serverState. buildGatewayConfig +
// createRefreshLiveToolsConfig live in gateway-config.mjs; this module only
// owns the serverState the refresh closes over.
// Bound inside setupAdminApi() (once paths are initialised, so configDir() is
// safe to call) rather than here at module scope — see below.
let refreshLiveToolsConfig

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

function getSettingsPath() {
  return path.join(configDir(), 'settings.json')
}

function readSettings() {
  const p = getSettingsPath()
  if (!fs.existsSync(p)) return {}
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return {} }
}

function writeSettings(data) {
  fs.writeFileSync(getSettingsPath(), JSON.stringify(data, null, 2), 'utf8')
}

// ---------------------------------------------------------------------------
// Models folder
// ---------------------------------------------------------------------------
// Where the Models tab downloads GGUF files and where the "Select .gguf File"
// picker opens. Defaults to <Documents>\Redstart\Models to match the capability
// folders provisioned above, but is user-changeable because model files are
// tens of gigabytes and Documents usually lives on the system drive.
//
// Always resolves to a real path so no caller has to handle null — the picker's
// defaultPath and the downloader's containment root must never disagree about
// which folder is "the models folder".

function defaultModelsDir() {
  return path.join(capabilityBaseDir(), 'Models')
}

function resolveModelsDir() {
  const configured = readSettings().modelsDir
  return typeof configured === 'string' && configured.trim() ? configured : defaultModelsDir()
}

// Best-effort, same contract as ensureDefaultCapabilityFolders: a folder that
// cannot be created is not fatal, the tab just reports it.
function ensureModelsDir() {
  try {
    fs.mkdirSync(resolveModelsDir(), { recursive: true })
  } catch (err) {
    console.warn('Could not provision the models folder:', err.message)
  }
}


// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

// The value this returns becomes spawn()'s first argument in ipc/server.mjs, so
// it is checked HERE as well as at the settings:set-binary-path write. That is
// not belt-and-braces for its own sake: settings.json is an ordinary file on
// disk, and any value written by a build that predates the write-side check —
// which is every install shipped so far — is read by this function and launched.
// Validating only on the way in would leave the stored value trusted forever.
//
// A rejected override falls through to the bundled binary rather than failing
// the launch, which is the same thing that happens when the path simply does
// not exist.
function resolveBinary() {
  const settings = readSettings()
  if (settings.serverBinPath) {
    const rejection = binaryPathRejection(settings.serverBinPath)
    if (rejection) {
      logEvent('security', 'binary_override_rejected', { reason: rejection })
    } else {
      return settings.serverBinPath
    }
  }

  const candidates = []
  const name = serverBinaryName()

  if (isPackaged()) {
    // Packaged: binary is placed at resources/bin/ via extraResources in electron-builder.json
    candidates.push(path.join(process.resourcesPath, 'bin', name))
  } else {
    // Dev: look in the project tree
    const projectRoot = path.join(__dirname, '..', '..')
    candidates.push(
      path.join(projectRoot, 'llama-cpp-turboquant', 'build', 'bin', 'Release', name),
      path.join(projectRoot, name),
      path.join(process.cwd(), name),
    )
    if (process.platform !== 'win32') {
      // A POSIX build tree puts it here instead of under a Release/ config
      // directory, which is an MSVC convention rather than a CMake one.
      candidates.push(path.join(projectRoot, 'llama-cpp-turboquant', 'build', 'bin', name))
    }
  }

  if (process.platform !== 'win32') {
    // Where a package install would put it. Checked after the project tree so
    // a developer's own build still wins in a checkout, and deliberately NOT
    // extended to a PATH lookup: this value is the head of the escalation
    // chain (ipc/validate.mjs), and resolving it from PATH would hand that
    // decision to whatever the daemon's environment happens to say.
    candidates.push(
      path.join(configDir(), 'bin', name),
      path.join('/usr/lib/redstart/bin', name),
      path.join('/usr/local/lib/redstart/bin', name),
    )
  }

  return candidates.find(p => fs.existsSync(p)) || null
}

// ---------------------------------------------------------------------------
// Profile helpers
// ---------------------------------------------------------------------------

function getProfilesPath() {
  return path.join(configDir(), 'profiles.json')
}

function readProfiles() {
  const p = getProfilesPath()
  if (!fs.existsSync(p)) return { profiles: {} }
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return { profiles: {} } }
}

function writeProfiles(data) {
  fs.writeFileSync(getProfilesPath(), JSON.stringify(data, null, 2), 'utf8')
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

// Delegates to net-interfaces.mjs, which skips Hyper-V/WSL/VirtualBox/VPN
// adapters. Taking the first non-internal IPv4 (as this did) routinely handed
// back a virtual-switch address that nothing else on the LAN can reach — and
// that address is what the UI shows and what the QR code encodes.
function getLocalIp() {
  return getPrimaryLanIp()
}

// ---------------------------------------------------------------------------
// Token EMA parser
// ---------------------------------------------------------------------------

function parseEvalTokensPerSec(line) {
  // llama_print_timings:        eval time = ... X tokens per second)
  const match = line.match(/eval time\s+=.+?(\d+\.?\d*)\s+tokens per second/)
  return match ? parseFloat(match[1]) : null
}

// ---------------------------------------------------------------------------
// Server health poll
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Discovery beacon server
// Runs on a fixed port (8765) as long as Redstart Nest is open, regardless of
// whether a llama-server is running. Redstart Twig scans for this beacon to
// confirm it found a real Redstart Nest instance and to get the actual server URL.
// ---------------------------------------------------------------------------

async function startDiscoveryBeacon() {
  beaconServerInstance = await startBeaconServer(
    () => !!serverState.process,
    () => serverState.lastConfig?.port ?? 19080,
  )
  console.log(`Redstart Nest beacon listening on port 8765`)
}

// ---------------------------------------------------------------------------
// Admin listener (the control plane)
// ---------------------------------------------------------------------------
// Started HERE, beside the beacon, and not from the llama:launch handler. That
// placement is the whole argument: the control plane must be up before, and
// independently of, the thing it controls (headless-admin-plane-plan.md
// decision 3). See admin-listener.mjs for what it serves.
//
// Where it binds is a persisted setting holding an ADDRESS, not a boolean, and
// it defaults to loopback — availability is always on, exposure is opt-in (plan
// decision 4). Deliberately not `networkMode`, which is data-plane state read
// only at launch.
//
// A failure to bind is logged and swallowed rather than fatal ON THE DESKTOP
// — the daemon itself (gateway, MCP, discovery) still comes up. Headless it is
// fatal instead (host.adminBindFailureIsFatal): with no window and no tray, a
// daemon that came up owning nothing has no way to tell anyone, and the
// process that already holds :19083 is the one actually in charge. Since
// Phase 6 §6.2,
// though, the LAUNCHER window specifically has no fallback if this fails:
// createWindow() loads this listener's own page, so a bind failure here
// means the window loads nothing rather than a working-but-disconnected UI.
// That is the accepted shape of "the Electron UI is a client of the daemon,
// like Twig" (plan decision 6) — the alternative would be keeping a second,
// privileged way for the window to render regardless, which is the exact
// thing this phase retires.
async function startAdminPlane() {
  // Minted here, not on first use. A token that only appears at the moment
  // someone is locked out is a token they cannot get to — and an install that
  // predates this feature needs one waiting for it, not one generated by the
  // request that needed it. See bootstrap-token.mjs.
  ensureBootstrapToken()
  const settings = readSettings()
  const bindHost = settings.adminBindHost || DEFAULT_ADMIN_BIND_HOST
  try {
    // Phase 8A.6 — absent on every install, which means no CORS headers at
    // all. It exists for a client that did not come from this origin, which
    // is a thing only a remote daemon makes possible.
    await startAdminListener({ bindHost, allowedOrigins: settings.adminAllowedOrigins })
  } catch (err) {
    console.warn('Admin listener failed to start:', err.message)
    logEvent('admin', 'listener_start_failed', { reason: err.code || 'error' })
    if (host.adminBindFailureIsFatal) throw err
  }
  // Discovery (the port-80 clean URL, since Phase 6.5 retired mDNS) is a
  // data-plane convenience keyed on networkMode alone — it no longer reads
  // the listener's bind state at all. Still started here rather than only
  // from `llama:launch`, so a box that was previously put in network mode
  // gets the clean URL back at boot even before the next launch. See
  // discovery.mjs.
  startDiscovery(lastKnownDiscovery(readSettings()))
}


// ---------------------------------------------------------------------------
// Crash detection and warning (Phase 7 §7.4a)
// ---------------------------------------------------------------------------
// describeCrash()'s own module header (crash-handler.mjs) has the full
// reasoning for warn-not-restart and for what this can and cannot catch.
// This function is only the wiring: register the two handlers, and on
// either firing, log, notify (best-effort), then exit directly.
//
// Called by the ENTRYPOINT rather than by startDaemon(), and deliberately so:
// §7.4a installs these before initPaths() so that a crash during startup
// itself is caught, and startDaemon() runs after paths are up. Both halves of
// what differs between entrypoints — how to warn a human, how to leave — are
// arguments, since a headless box has no notification area and no app.exit().
export function installCrashHandlers({ notifyCrash, exitCrashed } = {}) {
  const notify = notifyCrash ?? DEFAULT_HOST.notifyCrash
  const exit = exitCrashed ?? DEFAULT_HOST.exitCrashed
  const onFatal = (err) => {
    const { logFields, notification } = describeCrash(err)
    // logEvent no-ops safely even if this fires before initLogger() has run
    // (a crash during path/logger init itself) — see logger.mjs.
    logEvent('app', 'crash', logFields)
    try {
      notify(notification)
    } catch (notifyErr) {
      // A crash handler must not itself throw — the notification is
      // best-effort, the log line and the exit below are not.
      console.warn('Crash notification failed:', notifyErr.message)
    }
    // Exit code 1, and NOT through the ordinary teardown: process state is
    // suspect here, so this deliberately skips stopDaemon(). Leaves a running
    // llama-server orphaned — accepted, not solved here: reapStaleProcess()
    // already runs at the next startup and exists precisely for this case.
    // The 1 is also the supervisor's signal to restart (8B.3); see this
    // module's header on the exit-code contract.
    exit()
  }
  process.on('uncaughtException', onFatal)
  process.on('unhandledRejection', onFatal)
}

// ---------------------------------------------------------------------------
// The control-plane API table
// ---------------------------------------------------------------------------
// Phase 6 §6.2 retired IPC — this used to also register every namespace's
// handlers with ipcMain (registerIpcHandlers(), deleted along with
// ipc/guard.mjs). buildAdminApi(deps) below is the only consumer of the
// handler tables left, and it was always the design's real source of truth
// (ipc/transport.mjs's header explains why: a route table derived from IPC
// registration would be empty on a platform with no Electron, which is the
// platform HTTP-only exists for).
function setupAdminApi() {
  const userDataDir = configDir()
  refreshLiveToolsConfig = createRefreshLiveToolsConfig(serverState, userDataDir)
  // Hands tools-definitions.mjs a live read of the plugin registry. Must run
  // before any tools/list or config build, or plugin tools resolve to no
  // capability and are neither classified nor bannable.
  setPluginCapabilityProvider(pluginCapabilities)
  const deps = {
    execFileAsync,
    readSettings,
    writeSettings,
    resolveBinary,
    // Resolved lazily on every call — the user can repoint the models folder at
    // runtime, so a value captured here would go stale.
    resolveModelsDir,
    getModelsDir: resolveModelsDir,
    ensureModelsDir,
    readProfiles,
    writeProfiles,
    buildGatewayConfig,
    refreshLiveToolsConfig,
    serverState,
    buildArgs,
    parseEvalTokensPerSec,
    ensureFirewallRule,
    getLocalIp,
    // So the external-MCP validator knows which ports are ours and can refuse a
    // server pointed at Nest itself. Falls back to the documented default when
    // no profile has been started yet, since the ports are derived from it.
    getConfiguredPort: () => serverState.lastConfig?.port ?? 19080,
    userDataDir,
    // Phase 7 §7.5 — the ONE deliberate-quit path admin:shutdown gets. Both
    // entrypoints must let the HTTP response this call is answering leave the
    // socket before teardown begins, or the caller sees a connection reset and
    // cannot tell success from crash — see ipc/admin.mjs's shutdown() for why
    // that ordering matters. Late-bound through host so the deps table can be
    // built before an entrypoint's own quit path is reachable.
    quitApp: () => host.quitApp(),
  }

  setAdminApi(buildAdminApi(deps))
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Start everything that is Nest-the-service. The caller has already decided
 * where state lives (initPaths) and how secrets are encrypted (initSecrets);
 * this does the rest, in an order that has been load-bearing since Phase 1.
 *
 * Throws only if the control plane fails to bind AND the entrypoint declared
 * that fatal — see DEFAULT_HOST.adminBindFailureIsFatal.
 */
export async function startDaemon(entrypoint = {}) {
  host = { ...DEFAULT_HOST, ...entrypoint }

  // Structured logging to <configDir>/redstart.log. First, so every startup
  // step below it is captured.
  initLogger(configDir())
  logEvent('app', 'ready', { platform: process.platform })
  // llama-server's own output (Phase 5 §5.2) — a separate stream from the
  // structured event log above, see process-log.mjs's header for why.
  initProcessLog(configDir())
  // Pre-provision default capability folders so Documents/SQLite/Vault/Git
  // are one-click enable out of the box. Fills only unset paths — a
  // user-chosen folder is never overridden — and leaves every capability
  // disabled.
  ensureDefaultCapabilityFolders(capabilityBaseDir())
  // Same idea for the models folder — see resolveModelsDir().
  ensureModelsDir()
  // Reaps a llama-server left running by a previous session that never got
  // to run its own exit handler (Task Manager kill, power loss). Verifies the
  // recorded pid is still that same binary before touching it — never a
  // by-name sweep. See process-supervision.mjs for why this replaced
  // killOrphanedServers().
  await reapStaleProcess(configDir())
  const cleanedConversations = cleanupOldConversations()
  if (cleanedConversations > 0) console.log(`Cleaned ${cleanedConversations} conversations older than 30 days`)
  // Retries any plugin folder an uninstall couldn't delete last session (a
  // Windows file lock, most likely) — best-effort, never blocks startup (P4-4).
  sweepPendingDeletions()
  // Before the admin listener binds, not after: a control-plane request that
  // arrives before this table is assembled gets a 503 rather than the
  // method it asked for.
  setupAdminApi()
  await startDiscoveryBeacon()
  await startAdminPlane()
  // LAST, and only once the control plane is actually bound. A second daemon
  // started while one is already running fails at that bind; had it recorded
  // its pid on the way in, it would have overwritten the live daemon's entry
  // and then exited, leaving a file pointing at a dead process. See
  // daemon-pidfile.mjs.
  writeDaemonPid(configDir())
}

/**
 * Stop everything startDaemon() started, in reverse order of dependency.
 *
 * This was index.mjs's `before-quit` body verbatim. Design §4's Phase 7
 * paragraph asked for the teardown to move out of the client and into the
 * daemon; Phase 7 could not, because with one process there was only ever one
 * caller. There are two now, and a second copy that drifts is precisely how a
 * llama-server child gets left running past quit.
 *
 * The tray is NOT torn down here — it is the client's, and the client's own
 * before-quit still owns it.
 */
export function stopDaemon() {
  logEvent('app', 'quit', {})
  stopGateway()
  stopMcpServer()
  stopDiscovery()
  if (serverState.process) {
    // killOrphanedServers() used to do this job as a side effect of its
    // by-name sweep — this line never actually killed the child itself, only
    // dropped the reference. Kill by pid explicitly now that the sweep is
    // gone, or Nest's own llama-server would leak past quit.
    serverState.process.kill()
    serverState.process = null
    deletePidFile(configDir())
  }
  if (beaconServerInstance) {
    stopBeaconServer(beaconServerInstance)
    beaconServerInstance = null
  }
  stopAdminListener()
  // Before the logger closes, so a failure here still gets a line.
  clearDaemonPid(configDir())
  closeLogger()
}

// ---------------------------------------------------------------------------
// Read-through for the client
// ---------------------------------------------------------------------------
// The Electron client legitimately needs a few daemon-side values in-process:
// the tray asks whether a model is running and offers to stop it, §7.4's login
// item and §7.7's close notice read and write settings.json. Exported directly
// rather than routed through the admin API because the client shares this
// process — a loopback HTTP round-trip to read a boolean out of the same heap
// would be ceremony. That shortcut is available ONLY to an in-process client
// and stops existing the moment the two are split for real (8B.7); anything
// richer than this should go through the API instead of growing this list.
export { serverState, readSettings, writeSettings }
