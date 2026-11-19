'use strict'

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
import { logEvent } from './logger.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'

// =============================================================================
// Redstart Nest — the LAN front door, wired (TLS plan C2 + C2b + C6)
// =============================================================================
// One Caddy supervisor and one network-mode owner per daemon, and the real
// effects the owner's steps run:
//
//   dataplane:bind   rebind the running gateway + MCP listeners (handlers,
//                    plugins and kernels stay up; listener-rebind.mjs)
//   port80:*         the Windows clean-URL proxy (port80-proxy.mjs)
//   caddy:*          the bundled Caddy, with a NEW proxy secret per start
//   firewall:ensure  the inbound rules, added only once their listener is up
//
// HTTPS has no settings yet (TLS step 4 adds tls.* and the name providers),
// so tlsConfig() returns null and tlsMode stays 'off': the owner only ever
// reaches local and lan-http, which is exactly the behaviour before this
// module. The lan-https path is exercised by test-network-mode-owner.mjs
// against the real Caddy.
// =============================================================================

const here = path.dirname(fileURLToPath(import.meta.url))
const NEST_ROOT = path.join(here, '..')

let supervisor = null
let owner = null
let caddyPath = null
let getTlsConfig = () => null

/**
 * @param {{ configDir: string, packaged?: boolean, resourcesDir?: string|null, tlsConfig?: () => object|null }} p
 */
export function initLan({ configDir, packaged = false, resourcesDir = null, tlsConfig } = {}) {
  if (owner) return owner
  if (tlsConfig) getTlsConfig = tlsConfig
  const resolveCaddy = () => {
    caddyPath = caddyBinaryCandidates({ packaged, resourcesDir, nestRoot: NEST_ROOT, configDir }).find((p) => fs.existsSync(p)) ?? null
    return caddyPath
  }
  supervisor = createCaddySupervisor({
    configDir,
    resolveBinary: resolveCaddy,
    onStateChange: (s) => { void owner?.caddyStatus(s) },
  })
  owner = createNetworkModeOwner({ effects: realEffects({ configDir }) })
  return owner
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
      const t = getTlsConfig()
      if (!t) throw new Error('HTTPS is not configured')
      const secret = newProxySecret()
      const config = buildCaddyConfig({
        hostname: t.hostname,
        dnsProvider: t.dnsProvider,
        gatewayPort: t.gatewayPort,
        mcpPort: t.gatewayPort + 2,
        httpsServing: serving,
        requireHttps: !!t.requireHttps,
        acmeStaging: !!t.acmeStaging,
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
  stopPort80Proxy()
  void supervisor.stop()
  clearProxySecret()
  void owner.update({ stopping: true })
  return pid
}
