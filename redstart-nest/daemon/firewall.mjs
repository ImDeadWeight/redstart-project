'use strict'

// ---------------------------------------------------------------------------
// Windows Firewall inbound rules.
//
// Adding a rule requires admin and the app runs unelevated. Two ways to get
// there, chosen by who started the daemon:
//
//   - Under the desktop shell (the normal install): the shell is asked over
//     its pipe (setFirewallElevator, wired in bin/shell-mode.mjs). It starts
//     ITSELF elevated and adds the rules (shell/src/firewall.rs), so the UAC
//     prompt names Redstart Nest, not "Network Shell" (netsh.exe, which is
//     what this module used to elevate and what UAC then described).
//   - Anything else on Windows (a headless nestd with --resources): the
//     bundled elevate.exe runs netsh, one prompt per rule, as before.
//
// Requests made within BATCH_MS of each other go out together, so a launch
// that needs the gateway, MCP and port-80 rules asks once, not three times.
// The existence check runs unelevated first and short-circuits when a rule
// is already there, so a normal start prompts for nothing: UAC fires once
// per missing set of rules, ever.
//
// Each request resolves to whether the rule exists afterwards, checked
// unelevated again rather than taken from the elevated side's word. Nothing
// here rejects: a missing rule degrades reachability, it never breaks the
// server, so nothing is allowed to reject into a caller's start path.
//
// Originally extracted from index.mjs so the mDNS advertiser could reuse it
// (its own rule called netsh directly without elevation, which always threw
// and was swallowed into a warn — inbound UDP 5353 stayed blocked on every
// install and the advertiser was unreachable no matter what it broadcast).
// The advertiser itself retired (mDNS support was dropped wholesale — see
// discovery.mjs); this module stays for the TCP rules the gateway, port-80
// proxy and Caddy still need.
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
// platform-paths' resourcesDir(), which the entrypoint sets: a packaged
// nestd gets --resources from its shell (plain Node has no
// process.resourcesPath at all). In dev and headless runs there is no
// resources directory and no shell, so this warns and skips.
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { resourcesDir } from './platform-paths.mjs'

export const BATCH_MS = 150

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

/** @type {null | ((rules: Array<{ name: string, protocol: string, port: string|number, program: string|null }>) => Promise<unknown>)} */
let elevator = null

/**
 * The desktop shell's seam: given the missing rules, add them in one
 * elevation (the shell validates them again; firewall.rs). The returned
 * promise settles when the elevated helper is done or the prompt was
 * declined. Its value is ignored: existence is re-checked here.
 */
export function setFirewallElevator(fn) {
  elevator = typeof fn === 'function' ? fn : null
}

/** Unelevated: is a rule by this exact name present? */
function netshRuleExists(name) {
  return new Promise((resolve) => {
    execFile('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${name}`, 'dir=in'], (_err, stdout) => {
      resolve(!!stdout && stdout.includes(name))
    })
  })
}

/** The headless path: elevate.exe + netsh, one prompt per rule. */
function addWithElevateExe(rule) {
  const elevatePath = resolveElevatePath()
  if (!elevatePath) {
    console.warn(`Firewall: no shell and no elevate.exe, skipping ${rule.name} (inbound ${rule.protocol} ${rule.port})`)
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    execFile(
      elevatePath,
      [
        'netsh', 'advfirewall', 'firewall', 'add', 'rule',
        `name=${rule.name}`,
        'dir=in', 'action=allow',
        `protocol=${rule.protocol}`,
        `localport=${rule.port}`,
        // Scoped to one executable when given: the rule then admits that
        // program on these ports and nothing else that might bind them.
        ...(rule.program ? [`program=${rule.program}`] : []),
        // The LAN only, whatever the network profile: Windows itself
        // refuses any connection from outside this machine's own subnets,
        // so a forwarded port or a public address still cannot reach Nest
        // through a rule Nest made (2026-11-19, the internet-exposure check).
        // shell/src/firewall.rs fixes the same scope on the shell's path.
        'remoteip=localsubnet',
      ],
      (err) => {
        if (err) console.warn(`Could not add firewall rule ${rule.name}:`, err.message)
        resolve()
      }
    )
  })
}

// Swapped only by scripts/test-firewall.mjs, which runs on any OS.
let platform = process.platform
let ruleExists = netshRuleExists
export function _setFirewallTestHooks({ platform: p = process.platform, exists = netshRuleExists } = {}) {
  platform = p
  ruleExists = exists
}

/** @type {Array<{ rule: object, resolve: (present: boolean) => void }>} */
let pending = []
let flushTimer = null

async function flush() {
  const batch = pending
  pending = []
  flushTimer = null
  // One entry per name: two requests for the same rule share the answer.
  const byName = new Map()
  for (const p of batch) {
    if (!byName.has(p.rule.name)) byName.set(p.rule.name, { rule: p.rule, waiters: [] })
    byName.get(p.rule.name).waiters.push(p.resolve)
  }
  const entries = [...byName.values()]
  try {
    const present = await Promise.all(entries.map((e) => ruleExists(e.rule.name)))
    const missing = entries.filter((_e, i) => !present[i])
    if (missing.length) {
      const rules = missing.map((e) => e.rule)
      if (elevator) {
        try {
          await elevator(rules)
        } catch (err) {
          console.warn(`Could not add firewall rules (${rules.map((r) => r.name).join(', ')}):`, err.message)
        }
      } else {
        for (const r of rules) await addWithElevateExe(r)
      }
      for (const e of missing) {
        const ok = await ruleExists(e.rule.name)
        if (ok) console.log(`Firewall rule added: ${e.rule.name} (inbound ${e.rule.protocol} ${e.rule.port})`)
        present[entries.indexOf(e)] = ok
      }
    }
    entries.forEach((e, i) => e.waiters.forEach((w) => w(present[i])))
  } catch (err) {
    console.warn('Firewall check failed:', err.message)
    entries.forEach((e) => e.waiters.forEach((w) => w(false)))
  }
}

/**
 * Ask for an inbound allow rule. Resolves to whether it exists afterwards.
 * Off Windows it resolves false at once and touches nothing.
 *
 * @param {{ name: string, protocol: string, port: string|number, program?: string|null }} rule
 * @returns {Promise<boolean>}
 */
export function ensureInboundRule({ name, protocol, port, program = null }) {
  if (platform !== 'win32') return Promise.resolve(false)
  return new Promise((resolve) => {
    pending.push({ rule: { name, protocol, port: String(port), program }, resolve })
    if (!flushTimer) flushTimer = setTimeout(() => { void flush() }, BATCH_MS)
  })
}

// TCP rule for a listening service port (gateway, port-80 proxy, MCP server).
export function ensureFirewallRule(gatewayPort) {
  return ensureInboundRule({
    name: `RedstartNest Gateway ${gatewayPort}${RULE_SUFFIX}`,
    protocol: 'TCP',
    port: gatewayPort,
  })
}

/**
 * The bundled Caddy's rule (TLS plan C6): TCP 80, 443 and 8443 (the admin
 * panel over HTTPS), for caddy.exe only.
 * Program-scoped, unlike the gateway's port rules, because these are
 * well-known ports another program could bind. Program-scoped is also why it
 * may be added BEFORE Caddy starts (network-mode.mjs): it admits caddy.exe
 * and nothing else, and its existence when caddy.exe first listens is what
 * keeps Windows from showing its own "allow access?" alert for Caddy.
 */
export function ensureCaddyFirewallRule(caddyPath) {
  // 8443: the admin panel over HTTPS. A new name, so the wider port set is
  // created rather than an older 80,443 rule found and kept.
  return ensureInboundRule({ name: `RedstartNest Caddy HTTPS+admin${RULE_SUFFIX}`, protocol: 'TCP', port: '80,443,8443', program: caddyPath })
}
