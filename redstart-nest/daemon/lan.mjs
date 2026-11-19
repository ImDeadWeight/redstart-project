'use strict'

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createNetworkModeOwner } from './network-mode-owner.mjs'
import { createCaddySupervisor, caddyBinaryCandidates, caddyPaths } from './caddy-server.mjs'
import { buildCaddyConfig, PROXY_SECRET_ENV } from './caddy-config.mjs'
import { newProxySecret, clearProxySecret } from './proxy-trust.mjs'
import { rebindGateway } from './tools-gateway.mjs'
import { rebindMcpServer } from './mcp-server.mjs'
import { startPort80Proxy, stopPort80Proxy } from './port80-proxy.mjs'
import { ensureFirewallRule, ensureCaddyFirewallRule } from './firewall.mjs'
import { readTls, tlsRuntime, caddyKeyOf } from './tls-settings.mjs'
import { nameProvider, createAddressWatcher } from './tls-names.mjs'
import { checkServing, diagnostics, createHealthRunner } from './tls-health.mjs'
import { getPrimaryLanIp } from './net-interfaces.mjs'
import { logEvent } from './logger.mjs'

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
let io = null            // { readSettings, writeSettings, decrypt }
let lastPublish = null   // the watcher's last result, for the panel
let lastDiagnostics = []
let pendingSwitch = null // { previousTls, name, deadline, timer }
let lastSwitchFailure = null

const runtime = () => (io ? tlsRuntime(io.readSettings(), { decrypt: io.decrypt }) : null)

/**
 * @param {{ configDir: string, packaged?: boolean, resourcesDir?: string|null,
 *           readSettings?: () => object, writeSettings?: (s: object) => void, decrypt?: (c: string) => string }} p
 */
export function initLan({ configDir, packaged = false, resourcesDir = null, readSettings, writeSettings, decrypt } = {}) {
  if (owner) return owner
  if (readSettings && writeSettings && decrypt) io = { readSettings, writeSettings, decrypt }
  const resolveCaddy = () => {
    caddyPath = caddyBinaryCandidates({ packaged, resourcesDir, nestRoot: NEST_ROOT, configDir }).find((p) => fs.existsSync(p)) ?? null
    return caddyPath
  }
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
      return nameProvider({ provider: t.provider, name: t.hostname }).updateAddress(ip, { token: t.token })
    },
    onResult: (r) => {
      lastPublish = { ...r, at: Date.now() }
      logEvent('tls', r.ok ? 'address_published' : 'address_publish_failed', { detail: r.detail })
    },
  })
  owner = createNetworkModeOwner({ effects: realEffects({ configDir }), onChange: onOwnerChange })
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
  if (verdict.serving && pendingSwitch && pendingSwitch.name === t.hostname) commitSwitch()
  return verdict
}

function onOwnerChange(s) {
  const httpsOn = s.state === 'lan-https' || s.state === 'lan-https-fallback'
  if (httpsOn) void watcher.start()
  else watcher.stop()
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
      })
      await supervisor.start({ config, secrets: { ...t.secrets, [PROXY_SECRET_ENV]: secret } })
    },
    async stopCaddy() {
      await supervisor.stop()
      clearProxySecret()
    },
    async ensureFirewall(rule, { gatewayPort }) {
      if (rule === 'gateway') ensureFirewallRule(gatewayPort)
      else if (rule === 'mcp') ensureFirewallRule(gatewayPort + 2)
      else if (rule === 'port80') ensureFirewallRule(80)
      else if (rule === 'caddy' && caddyPath) ensureCaddyFirewallRule(caddyPath)
    },
  }
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
export function beginSwitch(previousTls, name) {
  cancelSwitch()
  const timer = setTimeout(() => { void revertSwitch() }, SWITCH_DEADLINE_MS)
  timer.unref?.()
  pendingSwitch = { previousTls, name, deadline: Date.now() + SWITCH_DEADLINE_MS, timer }
}

function cancelSwitch() {
  if (pendingSwitch?.timer) clearTimeout(pendingSwitch.timer)
  pendingSwitch = null
}

function commitSwitch() {
  logEvent('tls', 'switch_committed', { name: pendingSwitch?.name })
  cancelSwitch()
}

async function revertSwitch() {
  if (!pendingSwitch || !io) return
  const { previousTls, name } = pendingSwitch
  cancelSwitch()
  logEvent('tls', 'switch_reverted', { name })
  const s = io.readSettings()
  io.writeSettings({ ...s, tls: previousTls })
  lastSwitchFailure = `${name} didn't start working within ${Math.round(SWITCH_DEADLINE_MS / 60000)} minutes, so the previous name was kept.`
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
    switching: pendingSwitch ? { name: pendingSwitch.name, deadline: pendingSwitch.deadline } : null,
    lastSwitchFailure,
    egress: settings && settings.mode === 'own' && settings.name
      ? nameProvider({ provider: settings.provider, name: settings.name }).egress()
      : [],
  }
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
  stopPort80Proxy()
  void supervisor.stop()
  clearProxySecret()
  void owner.update({ stopping: true })
  return pid
}
