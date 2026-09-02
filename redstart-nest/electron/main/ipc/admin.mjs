// Admin / control-plane IPC namespace — where the control plane is bound,
// and changing it.
//
// Handler bodies are exported as plain functions (Phase 1, §1.3); importing
// this module never registers anything, only adminHandlers()/buildAdminApi()
// wiring it into the table does.
import {
  startAdminListener, getAdminListenerState, bindHostRejection, isLoopbackBind,
} from '../admin-listener.mjs'
import { logEvent } from '../logger.mjs'
import { getGatewayPort } from '../tools-gateway.mjs'
import { getMcpServerRunning } from '../mcp-server.mjs'

export function getControlPlane() {
  return getAdminListenerState()
}

/**
 * The full status endpoint (Phase 5 §5.4) — "running: true" was the whole of
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
  }
}

/**
 * Move the control plane to a different bind address.
 *
 * REBINDS IMMEDIATELY, not at next start (plan decision 4). The reason is not
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

  // Discovery no longer reads the control plane's bind address (Phase 6.5 —
  // mDNS, the only mechanism that used to key on it, is retired). Nothing to
  // re-run here any more.

  logEvent('admin', 'bind_changed', { loopback: isLoopbackBind(bindHost) })
  return { ok: true, state: getAdminListenerState() }
}

// `set-bind-host` is now wired to the UI (AccountsPanel.tsx's exposure
// toggle) — it sat unregistered from Phase 2 until then because offering the
// button before there was a login screen a browser could reach would have let
// someone expose a process-spawning plane in exchange for nothing (plan
// decision 19's warning exists for exactly this act). Owner-gated like every
// other route on this table, same as the read.
export function adminHandlers(deps) {
  return {
    'admin:get-control-plane': () => getControlPlane(),
    // §5.4 — a remote admin's full-status readout. deps is the same big
    // collaborator bag every other namespace gets; only serverState is used.
    'admin:get-status': () => getFullStatus(deps ?? {}),
    'admin:set-bind-host': (host) => setControlPlaneBindHost(host, deps ?? {}),
  }
}
