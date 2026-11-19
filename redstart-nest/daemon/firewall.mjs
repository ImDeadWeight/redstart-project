'use strict'

// ---------------------------------------------------------------------------
// Windows Firewall inbound rules.
//
// Adding a rule requires admin and the app runs unelevated, so `netsh add` is
// routed through the bundled elevate.exe. The existence check runs unelevated
// and short-circuits when the rule is already there, so a normal start prompts
// for nothing — UAC fires once per rule, ever.
//
// Originally extracted from index.mjs so the mDNS advertiser could reuse it
// (its own rule called netsh directly without elevation, which always threw
// and was swallowed into a warn — inbound UDP 5353 stayed blocked on every
// install and the advertiser was unreachable no matter what it broadcast).
// The advertiser itself retired (mDNS support was dropped wholesale — see
// discovery.mjs); this module stays for the TCP rules the gateway and
// port-80 proxy still need.
//
// POSIX: this is a NO-OP off Windows and must stay one. Opening a port on
// Linux belongs to the operator or the package (ufw, nftables, a cloud
// security group) — never to Nest. Holding NET_ADMIN in order to do it
// itself would undo the point of the service account, which exists
// precisely to shed privileges from a process that spawns a
// user-configurable binary and runs third-party plugin code. Nothing here
// needed deleting for the headless daemon; it needed saying.
//
// Deliberately free of any `electron` import. elevate.exe is found through
// platform-paths' resourcesDir(), which the entrypoint sets: Electron passes
// process.resourcesPath, and a packaged nestd gets --resources from its shell
// (plain Node has no process.resourcesPath at all). In dev and headless runs
// there is no resources directory, so this warns and skips, the pre-existing
// dev behaviour.
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { resourcesDir } from './platform-paths.mjs'

function resolveElevatePath() {
  let dir = null
  try { dir = resourcesDir() } catch { return null } // paths not initialised yet
  if (!dir) return null
  const candidate = path.join(dir, 'elevate.exe')
  return fs.existsSync(candidate) ? candidate : null
}

/**
 * The rule set's name suffix. Rules are found by NAME, so the LAN-only rules
 * get new names: an older rule (any remote address) would otherwise be
 * found and kept. The older ones are inert once nothing listens for them,
 * and are listed in docs/security.md for removal.
 */
export const RULE_SUFFIX = ' (LAN only)'

// Add an inbound allow rule if one by this name isn't already present.
// Fire-and-forget: a missing rule degrades reachability, it never breaks the
// server, so nothing here is allowed to reject into a caller's start path.
export function ensureInboundRule({ name, protocol, port, program = null, label = name }) {
  if (process.platform !== 'win32') return

  execFile(
    'netsh',
    ['advfirewall', 'firewall', 'show', 'rule', `name=${name}`, 'dir=in'],
    (_err, stdout) => {
      if (stdout && stdout.includes(name)) return // Already present

      const elevatePath = resolveElevatePath()
      if (!elevatePath) {
        console.warn(`Firewall: elevate.exe not found, skipping ${label} (inbound ${protocol} ${port})`)
        return
      }

      execFile(
        elevatePath,
        [
          'netsh', 'advfirewall', 'firewall', 'add', 'rule',
          `name=${name}`,
          'dir=in', 'action=allow',
          `protocol=${protocol}`,
          `localport=${port}`,
          // Scoped to one executable when given: the rule then admits that
          // program on these ports and nothing else that might bind them.
          ...(program ? [`program=${program}`] : []),
          // The LAN only, whatever the network profile: Windows itself
          // refuses any connection from outside this machine's own subnets,
          // so a forwarded port or a public address still cannot reach Nest
          // through a rule Nest made (2026-11-19, the internet-exposure check).
          'remoteip=localsubnet',
        ],
        (err) => {
          if (err) console.warn(`Could not add firewall rule ${label}:`, err.message)
          else console.log(`Firewall rule added: ${label} (inbound ${protocol} ${port})`)
        }
      )
    }
  )
}

// TCP rule for a listening service port (gateway, port-80 proxy, MCP server).
export function ensureFirewallRule(gatewayPort) {
  ensureInboundRule({
    name: `RedstartNest Gateway ${gatewayPort}${RULE_SUFFIX}`,
    protocol: 'TCP',
    port: gatewayPort,
  })
}

/**
 * The bundled Caddy's rule (TLS plan C6): TCP 80, 443 and 8443 (the admin
 * panel over HTTPS), for caddy.exe only.
 * Program-scoped, unlike the gateway's port rules, because these are
 * well-known ports another program could bind.
 */
export function ensureCaddyFirewallRule(caddyPath) {
  // 8443: the admin panel over HTTPS. A new name, so the wider port set is
  // created rather than an older 80,443 rule found and kept.
  ensureInboundRule({ name: `RedstartNest Caddy HTTPS+admin${RULE_SUFFIX}`, protocol: 'TCP', port: '80,443,8443', program: caddyPath })
}
