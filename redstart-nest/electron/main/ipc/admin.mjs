// Admin / control-plane IPC namespace — where the control plane is bound,
// and changing it.
//
// Handler bodies are exported as plain functions; importing
// this module never registers anything, only adminHandlers()/buildAdminApi()
// wiring it into the table does.
import { getLoginItems } from '../desktop-integration.mjs'
import {
  startAdminListener, getAdminListenerState, bindHostRejection, isLoopbackBind,
} from '../admin-listener.mjs'
import { logEvent } from '../logger.mjs'
import { getGatewayPort } from '../tools-gateway.mjs'
import { getMcpServerRunning } from '../mcp-server.mjs'
import { appVersion } from '../build-info.mjs'
import { apiRevision } from '../admin/api-routes.mjs'

export function getControlPlane() {
  return getAdminListenerState()
}

/**
 * The full status endpoint — "running: true" was the whole of
 * server:status before this; a remote admin watching a box they cannot see
 * the tray icon or the window title of needs more than a boolean.
 *
 * Deliberately NOT included: the model path or any other value logger.mjs's
 * BLOCKED_KEYS would strip from the event log. Status is owner-only, same as
 * every control-plane route, but the privacy stance server.mjs already takes
 * ("log the port only — never the model path") is worth keeping consistent
 * here rather than reopening it because this is a different code path.
 *
 * activeProfile is likewise absent — serverState carries the resolved llama
 * CONFIG a launch used, not the profile NAME the launcher's profile selector
 * showed at the time (that pairing lives only in the renderer, per-tab, and
 * is not persisted). Reporting the config's non-secret shape (port,
 * networkMode) is what is actually available server-side; a named "active
 * profile" would need the launcher to start telling the daemon the name at
 * launch, which it does not do today.
 */
export function getFullStatus({ serverState }) {
  const running = !!serverState.process
  const config = serverState.lastConfig
  return {
    running,
    pid: serverState.process?.pid ?? null,
    startedAt: serverState.startedAt ?? null,
    uptimeMs: running && serverState.startedAt ? Date.now() - serverState.startedAt : null,
    lastError: serverState.lastError ?? null,
    port: config?.port ?? null,
    networkMode: config ? !!config.networkMode : null,
    gateway: { port: config ? getGatewayPort(config.port) : null },
    mcp: { running: getMcpServerRunning() },
    adminListener: getAdminListenerState(),
    // What a client compares itself against when it
    // is not the bundle this daemon served. See build-info.mjs for why the
    // revision, and not the release version, is the load-bearing half.
    version: { app: appVersion(), apiRevision: apiRevision() },
  }
}

/**
 * Move the control plane to a different bind address.
 *
 * REBINDS IMMEDIATELY, not at next start. The reason is not
 * convenience: an admin changing this may be doing it to recover access, and a
 * setting that only takes effect after a restart they cannot perform remotely is
 * no use to them.
 *
 * The order below matters. Bind first, persist second: a setting saved for an
 * address the machine cannot bind would be read back at every subsequent boot
 * and fail every time, and the box would come up with no control plane at all
 * with nothing but a log line to say why. If the new address fails, the previous
 * one is restored so a rejected change leaves the admin exactly where they were.
 */
export async function setControlPlaneBindHost(host, { readSettings, writeSettings }) {
  const rejection = bindHostRejection(host)
  if (rejection) {
    logEvent('admin', 'bind_change_rejected', { reason: 'invalid' })
    return { ok: false, error: rejection, state: getAdminListenerState() }
  }

  const bindHost = host.trim()
  const { bindHost: previous, port } = getAdminListenerState()

  try {
    // The port travels with the rebind. This function changes WHERE the control
    // plane listens, not which port it is on — reading the live port back rather
    // than defaulting to the fixed one keeps that true.
    await startAdminListener({ bindHost, port })
  } catch (err) {
    if (previous) {
      try { await startAdminListener({ bindHost: previous, port }) } catch { /* nothing left to fall back to */ }
    }
    logEvent('admin', 'bind_change_failed', { reason: err.code || 'error' })
    return { ok: false, error: `Could not bind ${bindHost}: ${err.message}`, state: getAdminListenerState() }
  }

  const settings = readSettings()
  settings.adminBindHost = bindHost
  writeSettings(settings)

  // Discovery no longer reads the control plane's bind address — mDNS, the
  // only mechanism that used to key on it, is retired. Nothing to re-run
  // here any more.

  logEvent('admin', 'bind_changed', { loopback: isLoopbackBind(bindHost) })
  return { ok: true, state: getAdminListenerState() }
}

/**
 * Whether Redstart is set to start at login.
 *
 * Reads the OS's own record (the login-item capability an entrypoint
 * registered), not settings.json — a user can turn this off from Task
 * Manager's Startup tab behind Nest's back, and the UI must show what is
 * actually true, not what was last written. index.mjs reconciles the reverse
 * direction (a fresh install, or settings.json disagreeing with the OS) once
 * at startup; this function only ever reports the OS's current answer.
 *
 * `supported` is false on a headless daemon, where "start at login" has no
 * meaning at all: nobody logs in, and a service's boot start is the
 * supervisor's business, not a setting Nest owns. Reported rather than
 * answered `false` on its own, so the UI can hide a control that does not
 * apply instead of showing an off switch that can never be turned on.
 */
export function getStartupSettings() {
  const loginItems = getLoginItems()
  if (!loginItems) return { supported: false, startAtLogin: false }
  const { openAtLogin } = loginItems.get()
  return { supported: true, startAtLogin: openAtLogin }
}

/**
 * Sets both halves at once — the OS login item (what actually makes Windows
 * launch Redstart at sign-in) and settings.json (what a future boot's
 * reconciliation in index.mjs treats as the admin's last explicit choice,
 * distinct from the on-by-default seed a fresh install gets before anyone
 * has touched this toggle). `--background` is the flag index.mjs checks to
 * skip createWindow() on a login-triggered start — a login-triggered start
 * must stay windowless, tray-only.
 */
export function setStartupSettings(startAtLogin, { readSettings, writeSettings }) {
  const loginItems = getLoginItems()
  if (!loginItems) {
    // Refuse visibly rather than write a settings.json key that nothing will
    // ever act on. Same rule the picker work followed: a control that cannot
    // do what it says must say so, not fail quietly somewhere downstream.
    return { supported: false, startAtLogin: false, error: 'Start at login is not available on this platform' }
  }
  const value = !!startAtLogin
  loginItems.set({ openAtLogin: value, args: ['--background'] })

  const settings = readSettings()
  settings.startAtLogin = value
  writeSettings(settings)

  logEvent('admin', 'startup_changed', { startAtLogin: value })
  return getStartupSettings()
}

/**
 * The pure half of startup reconciliation: given the persisted settings,
 * what should the OS login item be right now, and does settings.json need
 * writing to remember it? No Electron call in here — that is what makes it
 * testable without a stub, unlike reconcileStartupSetting() below, whose one
 * untestable line is the login item's own set() call.
 *
 * A fresh install (`settings.startAtLogin` is undefined — nobody has ever
 * touched the toggle) seeds ON, on the grounds that a daemon with no model
 * loaded is a bound port and ~100MB, not the 40GB a loaded
 * model would be. Once an admin has set it explicitly (via setStartupSettings
 * above, so the value IS a boolean), that choice is reasserted forever —
 * never the on-by-default seed again.
 */
export function resolveStartupReconciliation(settings) {
  const hasStoredPreference = typeof settings?.startAtLogin === 'boolean'
  const startAtLogin = hasStoredPreference ? settings.startAtLogin : true
  return { startAtLogin, needsPersist: !hasStoredPreference }
}

/**
 * Runs on every boot, not only the first — the OS is re-told what
 * settings.json says every time, since a Windows update or a manual
 * registry edit could otherwise leave the two disagreeing silently.
 * `--background` is the flag index.mjs checks at startup to skip
 * createWindow() on a login-triggered start (which must stay windowless,
 * tray-only).
 */
export function reconcileStartupSetting({ readSettings, writeSettings }) {
  const loginItems = getLoginItems()
  // Nothing to reconcile against where there are no login items, and nothing
  // to persist either: seeding settings.startAtLogin on a headless box would
  // record an admin decision nobody made, which the NEXT desktop start would
  // then treat as an explicit choice and never re-seed.
  if (!loginItems) return { supported: false, startAtLogin: false }
  const settings = readSettings()
  const { startAtLogin, needsPersist } = resolveStartupReconciliation(settings)
  loginItems.set({ openAtLogin: startAtLogin, args: ['--background'] })
  if (needsPersist) {
    settings.startAtLogin = startAtLogin
    writeSettings(settings)
  }
  return { startAtLogin }
}

/**
 * Deliberate shutdown from the admin UI. There was no shutdown route before
 * this — with the window no longer meaning anything, Task Manager would
 * otherwise be the only exit, which is worse than what existed before.
 *
 * `deps.quitApp` is index.mjs's own closure — the one place that holds
 * `isQuitting` and `app.quit()`. It defers the actual quit to the next
 * tick, so the HTTP response this function returns actually leaves the
 * socket before before-quit's teardown begins; the caller must see 200,
 * not a connection reset, or it cannot tell success from crash. That
 * deferral lives in index.mjs, not here — this function only decides
 * WHETHER to quit and logs that the decision was made.
 */
export function shutdown({ quitApp }) {
  logEvent('app', 'shutdown_requested', {})
  quitApp?.()
  return { ok: true }
}

// `set-bind-host` is now wired to the UI (AccountsPanel.tsx's exposure
// toggle) — it sat unregistered until there was a login screen a browser
// could reach, because offering the button any earlier would have let
// someone expose a process-spawning plane in exchange for nothing. Owner-gated
// like every other route on this table, same as the read.
export function adminHandlers(deps) {
  return {
    'admin:get-control-plane': () => getControlPlane(),
    // A remote admin's full-status readout. deps is the same big
    // collaborator bag every other namespace gets; only serverState is used.
    'admin:get-status': () => getFullStatus(deps ?? {}),
    'admin:set-bind-host': (host) => setControlPlaneBindHost(host, deps ?? {}),
    'admin:get-startup': () => getStartupSettings(),
    'admin:set-startup': (startAtLogin) => setStartupSettings(startAtLogin, deps ?? {}),
    'admin:shutdown': () => shutdown(deps ?? {}),
  }
}
