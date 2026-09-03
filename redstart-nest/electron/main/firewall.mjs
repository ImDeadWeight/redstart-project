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
// The advertiser itself retired in Phase 6.5 (mDNS support was dropped
// wholesale — see discovery.mjs); this module stays for the TCP rules the
// gateway and port-80 proxy still need.
//
// POSIX (Phase 8A.4): this is a NO-OP off Windows and must stay one. Opening a
// port on Linux belongs to the operator or the package (ufw, nftables, a cloud
// security group) — never to Nest. Holding NET_ADMIN in order to do it itself
// would undo decision 9, which exists precisely to shed privileges from a
// process that spawns a user-configurable binary and runs third-party plugin
// code. Nothing here needed deleting for the headless daemon; it needed saying.
//
// Deliberately free of any `electron` import: process.resourcesPath is a plain
// global set by the Electron runtime, so test scripts can import modules that
// depend on this without stubbing Electron. In dev, resourcesPath points at
// Electron's own resources directory where elevate.exe does not exist, so the
// existsSync check fails and we warn-and-skip — the pre-existing dev behaviour.
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

function resolveElevatePath() {
  if (!process.resourcesPath) return null
  const candidate = path.join(process.resourcesPath, 'elevate.exe')
  return fs.existsSync(candidate) ? candidate : null
}

// Add an inbound allow rule if one by this name isn't already present.
// Fire-and-forget: a missing rule degrades reachability, it never breaks the
// server, so nothing here is allowed to reject into a caller's start path.
export function ensureInboundRule({ name, protocol, port, label = name }) {
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
    name: `RedstartNest Gateway ${gatewayPort}`,
    protocol: 'TCP',
    port: gatewayPort,
  })
}
