// Admin / control-plane IPC namespace — where the control plane is bound, and
// changing it.
//
// A SHORT-LIVED NAMESPACE, and worth saying so at the top. Phase 3 moves the
// launcher onto HTTP against the admin listener itself, at which point these two
// channels become two routes and this file goes away with the rest of the
// preload bridge (plan decision 5). It exists now because the exposure warning
// (decision 19) is worth having before the transport lands: someone who edits
// adminBindHost in settings.json today should see the warning in the launcher
// they already have, not in a UI that does not exist yet.
//
// Handler bodies are exported as plain functions (Phase 1, §1.3) so the Phase 3
// route can call them directly; importing this module never registers anything.
import {
  startAdminListener, getAdminListenerState, bindHostRejection, isLoopbackBind,
} from '../admin-listener.mjs'
import { startDiscovery, lastKnownDiscovery } from '../discovery.mjs'
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

  // Exposure just changed, and discovery's rule reads it — a control plane that
  // has moved onto the LAN is a reason to advertise that did not exist a moment
  // ago (and moving back to loopback may remove the only one there was).
  startDiscovery({ adminBindHost: bindHost, ...lastKnownDiscovery(settings) })

  logEvent('admin', 'bind_changed', { loopback: isLoopbackBind(bindHost) })
  return { ok: true, state: getAdminListenerState() }
}

// Only the READ is on the bridge. setControlPlaneBindHost() above is exported
// and deliberately not registered: moving the control plane onto the LAN is of
// no use until Phase 3 ships a login screen and an admin UI a browser can
// actually load, so offering the button now would let someone expose a
// process-spawning plane in exchange for nothing. The function exists because
// the rebind-and-restore semantics belong beside the listener rather than being
// invented later, and Phase 3's route is what will call it. Editing
// adminBindHost in settings.json still works, and takes effect at next start —
// which is what the warning below the read is for.
export function adminHandlers(deps) {
  return {
    'admin:get-control-plane': () => getControlPlane(),
    // §5.4 — a remote admin's full-status readout. deps is the same big
    // collaborator bag every other namespace gets; only serverState is used.
    'admin:get-status': () => getFullStatus(deps ?? {}),
  }
}
