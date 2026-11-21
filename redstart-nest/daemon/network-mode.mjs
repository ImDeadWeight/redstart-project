'use strict'

// =============================================================================
// Redstart Nest — one owner for the LAN state (TLS plan C2b, review R5)
// =============================================================================
// Before Caddy, "network mode" was one boolean: ipc/server.mjs bound the
// gateway and MCP server to 0.0.0.0 or 127.0.0.1, and discovery.mjs started
// the port-80 proxy. With Caddy there are four LAN states and two processes
// that must never both hold a port, so ONE module decides, and nothing else
// rebinds the data plane, starts the port-80 proxy or starts Caddy.
//
// This file is the pure half: inputs → target state → the facts that state
// needs → the ordered steps that get from the current facts to those. The
// executor (network-mode-owner.mjs) runs the steps against the real servers.
//
// STATES
//   local               network mode off: loopback only, no Caddy, no :80.
//   lan-http            HTTPS off (today's behaviour, or a BYO proxy):
//                       gateway + MCP on 0.0.0.0, port-80 proxy on Windows.
//   lan-https           Caddy fronts :443/:80; gateway + MCP on LOOPBACK.
//                       While HTTPS is not serving yet, Caddy's :80 proxies
//                       plain HTTP itself (caddy-config.mjs), so every LAN
//                       byte still goes through Caddy.
//   lan-https-fallback  Caddy gave up and requireHttps is off: gateway + MCP
//                       back on 0.0.0.0 so the household is not locked out.
//                       A deliberate, logged, visible downgrade.
//   stopping            the daemon is shutting down; wins over everything.
//
// THE FAILED LATCH. "Caddy gave up" is an input the owner latches, not
// Caddy's live state. Fallback stops Caddy, so a live "stopped" would read as
// "start it", and the box would loop: start, fail five times (~40 s), fall
// back, start again, rebinding the gateway every cycle. The latch is cleared
// only by a retry, a Caddy config change, or HTTPS being turned off.
//
// ORDERING RULES (each a test in test-network-mode.mjs)
//   1. Releases first: Caddy and the port-80 proxy stop before anything
//      binds. (Caddy stops before the gateway takes 0.0.0.0 back; the port-80
//      proxy stops before Caddy takes :80.)
//   2. Then the data plane's bind changes: leaving 0.0.0.0 happens before
//      Caddy starts taking traffic for it.
//   3. Then starts.
//   4. Firewall rules follow the bind, never lead it. They are only ever
//      added (removing one needs elevation; a leftover rule is inert once
//      nothing listens on the wildcard; the existing policy, ipc/server.mjs).
//      One exception, LEADING_RULES: Caddy's rule goes just BEFORE
//      caddy:start. It names caddy.exe (program-scoped), so it admits
//      nothing while Caddy is down. If it is not there when caddy.exe first
//      listens, Windows shows its own "allow access?" alert for Caddy on
//      top of Nest's UAC prompt (2026-11-20).
// =============================================================================

import { discoveryPlan } from './discovery.mjs'

export const LOOPBACK = '127.0.0.1'
export const WILDCARD = '0.0.0.0'

/** Rules added before their listener starts (ordering rule 4's exception). */
export const LEADING_RULES = Object.freeze(new Set(['caddy']))

export const STATES = Object.freeze(['local', 'lan-http', 'lan-https', 'lan-https-fallback', 'stopping'])
export const TLS_MODES = Object.freeze(['off', 'own', 'redstart'])

/**
 * @typedef {{
 *   networkMode: boolean,
 *   tlsMode: 'off'|'own'|'redstart',
 *   caddyFailed: boolean,     // the latch above
 *   requireHttps: boolean,
 *   serving: boolean,         // C5's serving verdict (never its warnings)
 *   caddyKey: string,         // opaque: changes whenever Caddy's config must
 *   stopping: boolean,
 *   platform: string,
 *   gatewayPort: number,
 * }} Inputs
 *
 * @typedef {{
 *   host: string|null,        // the gateway's and MCP server's bind; null = leave it
 *   port80Proxy: boolean,
 *   caddy: null | { serving: boolean, key: string },
 *   firewall: string[],       // rule ids this state wants present
 * }} Facts
 */

/** @param {Inputs} i */
export function targetState(i) {
  if (i.stopping) return 'stopping'
  if (!i.networkMode) return 'local'
  if (!TLS_MODES.includes(i.tlsMode) || i.tlsMode === 'off') return 'lan-http'
  if (i.caddyFailed && !i.requireHttps) return 'lan-https-fallback'
  return 'lan-https'
}

/** Whether lan-http also runs the port-80 clean-URL proxy: discovery.mjs's rule, not a copy of it. */
function wantsPort80Proxy({ platform, gatewayPort }) {
  return discoveryPlan({ networkMode: true, platform }).advertise && gatewayPort !== 80
}

/**
 * The facts a state needs.
 * @param {string} state
 * @param {Inputs} i
 * @returns {Facts}
 */
export function factsFor(state, i) {
  switch (state) {
    case 'local':
      return { host: LOOPBACK, port80Proxy: false, caddy: null, firewall: [] }
    case 'lan-http': {
      const p80 = wantsPort80Proxy(i)
      return { host: WILDCARD, port80Proxy: p80, caddy: null, firewall: ['gateway', 'mcp', ...(p80 ? ['port80'] : [])] }
    }
    case 'lan-https':
      // Caddy wanted even while the latch says it failed under requireHttps:
      // the fact is unchanged, so no step re-runs it; a retry changes caddyKey.
      return { host: LOOPBACK, port80Proxy: false, caddy: { serving: !!i.serving, key: String(i.caddyKey ?? '') }, firewall: ['caddy'] }
    case 'lan-https-fallback':
      return { host: WILDCARD, port80Proxy: false, caddy: null, firewall: ['gateway', 'mcp'] }
    case 'stopping':
      // host null: shutdown stops the data plane itself; rebinding it first
      // would be work for nothing.
      return { host: null, port80Proxy: false, caddy: null, firewall: [] }
    default:
      throw new Error(`unknown network state ${state}`)
  }
}

/** Nothing running, nothing bound wide: the state every rollback can reach. */
export const INITIAL_FACTS = Object.freeze({ host: LOOPBACK, port80Proxy: false, caddy: null, firewall: Object.freeze([]) })

/**
 * The steps from `from` to `to`, in the order the rules above require.
 * `from.firewall` is the set already ensured (rules are never removed).
 *
 * @param {Facts} from
 * @param {Facts} to
 * @returns {Array<{ op: string, host?: string, rule?: string, serving?: boolean, key?: string }>}
 */
export function planSteps(from, to) {
  const steps = []
  const caddyChanged = !!to.caddy && (!from.caddy || from.caddy.serving !== to.caddy.serving || from.caddy.key !== to.caddy.key)

  // 1. Releases.
  if (from.caddy && !to.caddy) steps.push({ op: 'caddy:stop' })
  if (from.port80Proxy && !to.port80Proxy) steps.push({ op: 'port80:stop' })
  // 2. The data plane's bind.
  if (to.host && to.host !== from.host) steps.push({ op: 'dataplane:bind', host: to.host })
  const have = new Set(from.firewall)
  const wanted = to.firewall.filter((rule) => !have.has(rule))
  // 3. Starts. (caddy:start on a running Caddy restarts it with the new
  //    config: the admin API is off, so a restart is how config changes.)
  //    Caddy's own rule leads it (rule 4's exception).
  if (to.port80Proxy && !from.port80Proxy) steps.push({ op: 'port80:start' })
  for (const rule of wanted) if (LEADING_RULES.has(rule)) steps.push({ op: 'firewall:ensure', rule })
  if (caddyChanged) steps.push({ op: 'caddy:start', serving: to.caddy.serving, key: to.caddy.key })
  // 4. Firewall, after the binds.
  for (const rule of wanted) if (!LEADING_RULES.has(rule)) steps.push({ op: 'firewall:ensure', rule })
  return steps
}

/**
 * The facts after `steps` ran successfully from `from`.
 * @param {Facts} from @param {Facts} to
 * @returns {Facts}
 */
export function appliedFacts(from, to) {
  return {
    host: to.host ?? from.host,
    port80Proxy: to.port80Proxy,
    caddy: to.caddy ? { ...to.caddy } : null,
    firewall: [...new Set([...from.firewall, ...to.firewall])],
  }
}

/**
 * The facts after ONE step, so the executor knows exactly what is up when a
 * later step fails (and rolls back from there, not from where it hoped to be).
 * @param {Facts} f @param {{ op: string, host?: string, rule?: string, serving?: boolean, key?: string }} step
 * @returns {Facts}
 */
export function applyStep(f, step) {
  switch (step.op) {
    case 'caddy:stop': return { ...f, caddy: null }
    case 'port80:stop': return { ...f, port80Proxy: false }
    case 'dataplane:bind': return { ...f, host: step.host }
    case 'port80:start': return { ...f, port80Proxy: true }
    case 'caddy:start': return { ...f, caddy: { serving: !!step.serving, key: String(step.key ?? '') } }
    case 'firewall:ensure': return { ...f, firewall: [...new Set([...f.firewall, step.rule])] }
    default: throw new Error(`unknown step ${step.op}`)
  }
}

/**
 * One transition: where the inputs say to be, and how to get there from the
 * facts as they are.
 *
 * @param {Facts} current
 * @param {Inputs} inputs
 */
export function next(current, inputs) {
  const state = targetState(inputs)
  const facts = factsFor(state, inputs)
  return { state, facts, steps: planSteps(current, facts) }
}
