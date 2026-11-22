'use strict'

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createNetworkModeOwner } from './network-mode-owner.mjs'
import { createCaddySupervisor, caddyBinaryCandidates, caddyPaths } from './caddy-server.mjs'
import { buildCaddyConfig, PROXY_SECRET_ENV, adminHostnameFor } from './caddy-config.mjs'
import { newProxySecret, clearProxySecret } from './proxy-trust.mjs'
import { rebindGateway } from './tools-gateway.mjs'
import { rebindMcpServer } from './mcp-server.mjs'
import { startPort80Proxy, stopPort80Proxy } from './port80-proxy.mjs'
import { ensureFirewallRule, ensureCaddyFirewallRule } from './firewall.mjs'
import { readTls, tlsRuntime, caddyKeyOf, readRedstart, withRedstart, withoutRedstart } from './tls-settings.mjs'
import { nameProvider, createAddressWatcher, registerName, heartbeatName, releaseName } from './tls-names.mjs'
import { checkServing, diagnostics, createHealthRunner } from './tls-health.mjs'
import { getPrimaryLanIp, refreshRouteIp } from './net-interfaces.mjs'
import { logEvent } from './logger.mjs'
import { ADMIN_PORT } from './ports.mjs'
import { setInfrastructureEgress } from './infrastructure-egress.mjs'

// =============================================================================
// Redstart Nest — the LAN front door, wired (TLS plan C2 + C2b + C4 + C5 + C9)
// =============================================================================
// One Caddy supervisor, one network-mode owner, one health runner and one
// address watcher per daemon, and the real effects the owner's steps run:
//
//   dataplane:bind   rebind the running gateway + MCP listeners (handlers,
//                    plugins and kernels stay up; listener-rebind.mjs)
//   port80:*         the Windows clean-URL proxy (port80-proxy.mjs)
//   caddy:*          the bundled Caddy, with a NEW proxy secret per start
//   firewall:ensure  the inbound rules
//
// Settings → owner: tls.mode / requireHttps / a fingerprint of everything in
// Caddy's config (caddyKeyOf) are the owner's inputs; applyTlsSettings()
// pushes them after every tls:set and at boot.
//
// Health → owner: the runner runs only in lan-https, and only its SERVING
// verdict, with hysteresis, reaches the owner (tls-health.mjs).
//
// The address watcher runs only while HTTPS is on with network mode on: a
// loopback-only install never calls a name service (invariant 6).
//
// Switching names (review R6). For DuckDNS and deSEC the old name is the
// admin's and "releasing" it is nothing, but Caddy serves one name at a time,
// so a switch is TRY-AND-REVERT: the previous tls block is kept, and if the
// new name has not reached serving within SWITCH_DEADLINE_MS it is put back
// (its certificate is still in storage, so the revert is immediate). Turning
// HTTPS off is immediate: the admin asked for no name.
// =============================================================================

const here = path.dirname(fileURLToPath(import.meta.url))
const NEST_ROOT = path.join(here, '..')
export const SWITCH_DEADLINE_MS = 5 * 60_000

let supervisor = null
let owner = null
let health = null
let watcher = null
let caddyPath = null
let resolveCaddyPath = null // initLan's resolver, for the rule that runs before Caddy starts
/** How long Caddy's start waits on its firewall rule's UAC prompt. */
export const CADDY_RULE_WAIT_MS = 90_000
let io = null            // { readSettings, writeSettings, decrypt, encrypt }
let heartbeatTimer = null
export const HEARTBEAT_MS = 7 * 24 * 60 * 60 * 1000
let lastPublish = null   // the watcher's last result, for the panel
let lastDiagnostics = []
let pendingSwitch = null // { previousTls, name, deadline, timer }
let lastSwitchFailure = null

const runtime = () => (io ? tlsRuntime(io.readSettings(), { decrypt: io.decrypt }) : null)

/**
 * @param {{ configDir: string, packaged?: boolean, resourcesDir?: string|null,
 *           readSettings?: () => object, writeSettings?: (s: object) => void, decrypt?: (c: string) => string }} p
 */
export function initLan({ configDir, packaged = false, resourcesDir = null, readSettings, writeSettings, decrypt, encrypt } = {}) {
  if (owner) return owner
  if (readSettings && writeSettings && decrypt) io = { readSettings, writeSettings, decrypt, encrypt }
  const resolveCaddy = () => {
    caddyPath = caddyBinaryCandidates({ packaged, resourcesDir, nestRoot: NEST_ROOT, configDir }).find((p) => fs.existsSync(p)) ?? null
    return caddyPath
  }
  resolveCaddyPath = resolveCaddy
  supervisor = createCaddySupervisor({
    configDir,
    resolveBinary: resolveCaddy,
    onStateChange: (s) => { void owner?.caddyStatus(s) },
  })
  health = createHealthRunner({
    check: runHealth,
    onServing: (serving) => {
      logEvent('tls', serving ? 'https_serving' : 'https_not_serving', {})
      void owner.update({ serving })
    },
  })
  watcher = createAddressWatcher({
    getIp: () => getPrimaryLanIp(os.networkInterfaces()),
    update: async (ip) => {
      const t = runtime()
      if (!t) return { ok: false, detail: 'HTTPS is not configured' }
      return nameProvider({ provider: t.provider, name: t.hostname }).updateAddress(ip, { token: t.token, id: t.id })
    },
    onResult: (r) => {
      lastPublish = { ...r, at: Date.now() }
      logEvent('tls', r.ok ? 'address_published' : 'address_publish_failed', { detail: r.detail })
    },
  })
  owner = createNetworkModeOwner({ effects: realEffects({ configDir }), onChange: onOwnerChange })
  // /egress's infrastructure list (C10): only while HTTPS actually faces the
  // LAN. A loopback-only install, or HTTPS off, sends nothing.
  setInfrastructureEgress(() => {
    const st = owner.status().state
    return st === 'lan-https' || st === 'lan-https-fallback' ? lanStatus().egress : []
  })
  return owner
}

async function runHealth() {
  const t = runtime()
  if (!t) return { serving: false, reason: 'HTTPS is not configured', cert: null }
  const verdict = await checkServing({ name: t.hostname, allowStaging: t.acmeStaging })
  // Diagnostics ride along with each run but never change the verdict.
  try {
    lastDiagnostics = await diagnostics({
      name: t.hostname, lanIp: getPrimaryLanIp(os.networkInterfaces()), cert: verdict.cert, allowStaging: t.acmeStaging,
    })
  } catch (err) {
    lastDiagnostics = [{ kind: 'diagnostics', text: `Couldn't run the checks: ${err.message}` }]
  }
  if (verdict.serving && pendingSwitch && (pendingSwitch.name ? pendingSwitch.name === t.hostname : t.provider === 'redstart')) await commitSwitch()
  return verdict
}

let ownerGeneration = 0

function onOwnerChange(s) {
  const httpsOn = s.state === 'lan-https' || s.state === 'lan-https-fallback'
  // Ask the routing table first, so the first address published is the
  // routed one rather than the first adapter in listing order.
  // `generation` drops a start whose HTTPS was switched off meanwhile.
  const generation = ++ownerGeneration
  if (httpsOn) void refreshRouteIp().catch(() => null).then(() => { if (generation === ownerGeneration) void watcher.start() })
  else watcher.stop()
  // Automatic: a weekly "still here" (the address watcher's PUT also counts,
  // but an address can stay the same for months). Only while HTTPS faces the LAN.
  const automatic = httpsOn && runtime()?.provider === 'redstart'
  if (automatic && !heartbeatTimer) {
    heartbeatTimer = setInterval(() => { void sendHeartbeat() }, HEARTBEAT_MS)
    heartbeatTimer.unref?.()
  } else if (!automatic && heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  if (s.state === 'lan-https') void health.start()
  else health.stop()
}

function realEffects({ configDir }) {
  return {
    async bindDataPlane(host) {
      await rebindGateway(host)
      await rebindMcpServer(host)
    },
    async startPort80({ gatewayPort }) {
      startPort80Proxy({ targetPort: gatewayPort })
      logEvent('discovery', 'started', { reason: 'data-plane', port: gatewayPort })
    },
    async stopPort80() {
      stopPort80Proxy()
    },
    async startCaddy({ serving }) {
      // Automatic registers HERE, the first time Caddy starts, which only
      // happens with network mode on: never at the click (invariant 6).
      await ensureRegistered()
      const t = runtime()
      if (!t) throw new Error('HTTPS is not configured')
      const gatewayPort = owner.status().inputs.gatewayPort
      const secret = newProxySecret()
      const config = buildCaddyConfig({
        hostname: t.hostname,
        dnsProvider: t.dnsProvider,
        gatewayPort,
        mcpPort: gatewayPort + 2,
        httpsServing: serving,
        requireHttps: t.requireHttps,
        acmeStaging: t.acmeStaging,
        storageDir: caddyPaths(configDir).storageDir,
        // The control plane over HTTPS on :8443, when it is meant to be
        // reachable from other devices (the admin listener is on loopback then).
        adminPort: t.adminProxied ? ADMIN_PORT : null,
        // And on its own name, admin.<name>, for an Automatic name: the name
        // service publishes that record and the wildcard certificate's
        // challenge is the one it already answers. Own names keep :8443 only
        // (controlPlaneState in ipc/admin.mjs tells the launcher the same).
        adminHostname: t.adminProxied && t.provider === 'redstart' ? adminHostnameFor(t.hostname) : null,
      })
      await supervisor.start({ config, secrets: { ...t.secrets, [PROXY_SECRET_ENV]: secret } })
    },
    async stopCaddy() {
      await supervisor.stop()
      clearProxySecret()
    },
    async ensureFirewall(rule, { gatewayPort }) {
      // Not awaited: these follow their listeners, and firewall.mjs batches
      // requests made together into one UAC prompt, which awaiting each
      // one in turn would split up again.
      if (rule === 'gateway') void ensureFirewallRule(gatewayPort)
      else if (rule === 'mcp') void ensureFirewallRule(gatewayPort + 2)
      else if (rule === 'port80') void ensureFirewallRule(80)
      else if (rule === 'caddy') {
        // Awaited: this runs BEFORE caddy:start (network-mode.mjs, rule 4's
        // exception), and Caddy must not listen until the rule exists, or
        // Windows shows its own alert. Bounded, so an unanswered prompt
        // holds the owner's queue for at most CADDY_RULE_WAIT_MS; Caddy then
        // starts anyway and the alert is the fallback. Never throws.
        const p = caddyPath ?? resolveCaddyPath?.()
        if (!p) return
        let timer
        const waited = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), CADDY_RULE_WAIT_MS) })
        const r = await Promise.race([ensureCaddyFirewallRule(p), waited])
        clearTimeout(timer)
        if (r !== true) logEvent('network', 'caddy_rule_missing', { reason: r === 'timeout' ? 'timeout' : 'not-added' })
      }
    },
  }
}

/**
 * Automatic with no registration yet: register now and store it. Throws
 * with one sentence when the service cannot be reached or refuses, which
 * the owner turns into its rollback and the panel into "Couldn't apply".
 */
async function ensureRegistered() {
  if (!io) return
  const s = io.readSettings()
  if (readTls(s).mode !== 'redstart' || readRedstart(s)) return
  if (!io.encrypt) throw new Error('Nest cannot store a name-service credential here')
  const r = await registerName()
  if (!r.ok) throw new Error(r.error)
  io.writeSettings(withRedstart(io.readSettings(), r, { encrypt: io.encrypt }))
  logEvent('tls', 'name_registered', { hostname: r.hostname })
}

async function sendHeartbeat() {
  const t = runtime()
  if (t?.provider !== 'redstart') return
  const r = await heartbeatName({ id: t.id, credential: t.token })
  logEvent('tls', r.ok ? 'name_heartbeat' : 'name_heartbeat_failed', { status: r.status ?? null })
}

/**
 * Give the Automatic name back: the service deletes its records, and the
 * registration is forgotten here. Best effort: if the service cannot be
 * reached the registration is still forgotten, and the service's own
 * housekeeping removes the records after 180 days unseen.
 */
export async function releaseAutomatic() {
  if (!io) return { ok: true }
  const r = readRedstart(io.readSettings())
  if (!r) return { ok: true }
  let credential = null
  try { credential = io.decrypt(r.credentialEnc) } catch { /* undecryptable: nothing to authenticate with */ }
  const res = credential ? await releaseName({ id: r.id, credential }) : { ok: false }
  io.writeSettings(withoutRedstart(io.readSettings()))
  logEvent('tls', res.ok ? 'name_released' : 'name_release_failed', { hostname: r.hostname, status: res.status ?? null })
  return res
}

/** The owner's tls inputs from settings.json, as they stand. */
export function tlsInputsFrom(settings) {
  const t = readTls(settings)
  return { tlsMode: t.mode, requireHttps: t.requireHttps, caddyKey: caddyKeyOf(settings) }
}

/** Push the stored tls settings to the owner (boot, and after every tls:set). */
export function applyTlsSettings({ clearFailure = false } = {}) {
  if (clearFailure) lastSwitchFailure = null
  if (!io) return lanOwner().status()
  watcher?.reset()
  return lanOwner().update(tlsInputsFrom(io.readSettings()))
}

/**
 * Start a try-and-revert switch to the tls block now in settings.
 * @param {object} previousTls the block it replaced
 */
export function beginSwitch(previousTls, name, { releaseAutomaticAfter = false } = {}) {
  cancelSwitch()
  const timer = setTimeout(() => { void revertSwitch() }, SWITCH_DEADLINE_MS)
  timer.unref?.()
  // name null: switching TO Automatic, whose name is not known until it registers.
  pendingSwitch = { previousTls, name, releaseAutomaticAfter, deadline: Date.now() + SWITCH_DEADLINE_MS, timer }
}

function cancelSwitch() {
  if (pendingSwitch?.timer) clearTimeout(pendingSwitch.timer)
  pendingSwitch = null
}

async function commitSwitch() {
  const release = pendingSwitch?.releaseAutomaticAfter
  logEvent('tls', 'switch_committed', { name: pendingSwitch?.name })
  cancelSwitch()
  // Make-before-break (review R6): the Automatic name goes back only now,
  // once the name that replaces it is serving.
  if (release) await releaseAutomatic()
}

async function revertSwitch() {
  if (!pendingSwitch || !io) return
  const { previousTls, name } = pendingSwitch
  cancelSwitch()
  logEvent('tls', 'switch_reverted', { name })
  const s = io.readSettings()
  io.writeSettings({ ...s, tls: previousTls })
  lastSwitchFailure = `${name ?? 'The automatic name'} didn't start working within ${Math.round(SWITCH_DEADLINE_MS / 60000)} minutes, so the previous name was kept.`
  await applyTlsSettings()
}

/** "Check now" from the panel. */
export async function checkTlsNow() {
  if (owner?.status().state !== 'lan-https') return lanStatus()
  await health.runNow()
  return lanStatus()
}

/** "Try again" after Caddy gave up. */
export function retryCaddy() {
  return lanOwner().retryCaddy()
}

/** Everything the panel shows. Never contains a token. */
export function lanStatus() {
  const o = owner?.status() ?? null
  const settings = io ? readTls(io.readSettings()) : null
  return {
    settings,
    state: o?.state ?? 'local',
    lastError: o?.lastError ?? null,
    caddy: supervisor ? (({ state, reason, lastAcmeError, lastCertificateAt }) => ({ state, reason, lastAcmeError, lastCertificateAt }))(supervisor.status()) : null,
    serving: health?.serving() ?? false,
    health: health?.latest() ?? null,
    warnings: lastDiagnostics,
    address: lastPublish,
    switching: pendingSwitch ? { name: pendingSwitch.name ?? 'an automatic name', deadline: pendingSwitch.deadline } : null,
    lastSwitchFailure,
    egress: settings?.mode === 'redstart'
      ? nameProvider({ provider: 'redstart', name: settings.automatic?.hostname ?? '' }).egress()
      : settings && settings.mode === 'own' && settings.name
        ? nameProvider({ provider: settings.provider, name: settings.name }).egress()
        : [],
  }
}

/**
 * What the discovery beacon advertises (TLS plan C7). While Caddy fronts the
 * data plane the gateway is on loopback, so the reachable port is Caddy's
 * 80, never the gateway's (which a LAN client could not connect to). The
 * HTTPS origin is added only while it is SERVING.
 * @param {number} gatewayPort
 */
export function beaconInfo(gatewayPort) {
  const s = owner?.status()
  if (s?.state !== 'lan-https') return { port: gatewayPort, origin: null }
  const t = io ? readTls(io.readSettings()) : null
  return { port: 80, origin: health?.serving() && t?.name ? `https://${t.name}` : null }
}

/** The owner. Lazily created with defaults for callers that run without a daemon (tests). */
export function lanOwner() {
  return owner ?? initLan({ configDir: path.join(os.tmpdir(), 'redstart-lan-unconfigured') })
}

export function caddyStatus() {
  return supervisor ? supervisor.status() : { state: 'stopped', reason: null, pid: null }
}

/**
 * Shutdown, synchronously, for stopDaemon(): the port-80 proxy stops and
 * Caddy is signalled now (both before any await), and the owner is told it
 * is stopping, so nothing it has queued can start anything again.
 * @returns {number|null} Caddy's pid, for the daemon's wait-for-children
 */
export function stopLanNow() {
  if (!owner) return null
  const pid = supervisor.status().pid
  cancelSwitch()
  health.stop()
  watcher.stop()
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  stopPort80Proxy()
  void supervisor.stop()
  clearProxySecret()
  void owner.update({ stopping: true })
  return pid
}
