'use strict'

// =============================================================================
// Redstart Nest — Discovery (the port-80 clean URL)
// =============================================================================
// Phase 6.5 retired mDNS wholesale (`.local` names never worked on Android,
// the primary mobile platform, and Twig's beacon scan never needed a name to
// begin with — see the removal's own record in
// docs/notes/headless-admin-plane-implementation.md §6.5.0). What is left of
// this module is the port-80 proxy: a clean `http://<ip>` instead of
// `http://<ip>:19080`, useful on the LAN and, unlike mDNS, working on every
// client including Android.
//
// WHAT MOVED AND WHY. This used to be started from inside the `llama:launch`
// handler, which meant a box that had never launched a model had never
// started it either — irrelevant for a manual convenience, but the mDNS half
// this module used to also own needed to be findable before it was
// configured, so both moved to start with the daemon together. Only the
// port-80 half survives, and it keeps that placement: it's a data-plane
// convenience, but starting it at boot (from the last configuration a launch
// actually used) rather than only from the next launch is simpler than
// having two different lifecycles for the same setting.
//
// WHAT DECIDES WHETHER IT STARTS. `networkMode`, full stop — this is purely a
// data-plane convenience now. (Historical note: this used to be "the union of
// both planes," because an exposed control plane was also a reason to
// advertise via mDNS. That reasoning is gone with mDNS; design decision 17
// is accordingly half-void — see the Phase 6.5 record. What survives of it is
// only "this starts with the daemon, not from inside `llama:launch`.")
// =============================================================================

import { startPort80Proxy, stopPort80Proxy } from './port80-proxy.mjs'
import { ensureFirewallRule } from './firewall.mjs'
import { DEFAULT_GATEWAY_PORT } from './ports.mjs'
import { logEvent } from './logger.mjs'

/**
 * The last network configuration a launch actually used, normalised.
 *
 * Absent on a machine that has never launched — deliberately NOT defaulted to
 * `networkMode: true`. The default in src/types.ts is on, but inferring "this
 * box wants to be on the LAN" from a value nobody has chosen yet is how a fresh
 * install would start advertising itself at boot without anyone asking.
 *
 * @param {object} settings the parsed settings.json
 */
export function lastKnownDiscovery(settings) {
  const stored = settings?.discovery
  return {
    networkMode: stored?.networkMode === true,
    gatewayPort: Number.isInteger(stored?.gatewayPort) ? stored.gatewayPort : DEFAULT_GATEWAY_PORT,
  }
}

/** What a launch should write back, so the next boot starts where this left off. */
export function discoveryRecordFor(config) {
  return {
    networkMode: config?.networkMode === true,
    gatewayPort: Number.isInteger(config?.port) ? config.port : DEFAULT_GATEWAY_PORT,
  }
}

/**
 * Should this box run the clean-URL proxy, and why?
 *
 * Pure, so the policy is testable without opening a socket. `reason` is what
 * makes a support answer possible.
 *
 * @returns {{ advertise: boolean, reason: string }}
 */
export function discoveryPlan({ networkMode } = {}) {
  if (networkMode === true) return { advertise: true, reason: 'data-plane' }
  return { advertise: false, reason: 'loopback-only' }
}

let advertising = false

/**
 * Start (or restart) the port-80 proxy.
 *
 * Idempotent and safe to call again with a new port — that is how a launch
 * pushes a changed port through without the whole thing being tied to the
 * launch's lifecycle.
 *
 * @param {object} input
 * @param {boolean} input.networkMode  the data plane's LAN exposure
 * @param {number} input.gatewayPort   the port the proxy forwards to
 * @returns {{ advertise: boolean, reason: string }} the plan that was applied
 */
export function startDiscovery(input = {}) {
  const plan = discoveryPlan(input)

  if (!plan.advertise) {
    stopDiscovery()
    return plan
  }

  const { gatewayPort } = input
  const port = Number.isInteger(gatewayPort) ? gatewayPort : DEFAULT_GATEWAY_PORT

  // Skipped when the gateway is already on 80 — there would be nothing to
  // proxy. The firewall rule is checked unelevated and short-circuits when it
  // already exists, so this prompts at most once ever (firewall.mjs); moving
  // this to boot moves that one prompt from the first launch to the first
  // exposed start, which is the price of the lifecycle being correct.
  if (port !== 80) {
    ensureFirewallRule(80)
    startPort80Proxy({ targetPort: port })
  }

  if (!advertising) logEvent('discovery', 'started', { reason: plan.reason, port })
  advertising = true
  return plan
}

export function stopDiscovery() {
  stopPort80Proxy()
  if (advertising) logEvent('discovery', 'stopped', {})
  advertising = false
}
