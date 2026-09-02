'use strict'

// =============================================================================
// Redstart Nest — Discovery (mDNS + the port-80 clean URL)
// =============================================================================
// WHAT MOVED AND WHY. Both of these used to be started from inside the
// `llama:launch` handler, which meant a box that had never launched a model
// advertised nothing on the network at all — precisely the cold-start case an
// appliance ships in. Finding the box is a precondition for configuring it, so
// it must not depend on the box already being configured
// (headless-admin-plane-plan.md decision 17). They now start with the daemon,
// beside the beacon and the admin listener, and stopping the model no longer
// stops them.
//
// WHAT DECIDES WHETHER THEY START. Not `networkMode` alone. The plan says to key
// discovery to the admin listener's exposure setting; taken literally that would
// silence mDNS on every existing desktop install, because the control plane
// defaults to loopback while the data plane's networkMode defaults to on — and
// `http://redstart.local:19080` is how people reach the chat UI today. So the
// rule here is the UNION: advertise when EITHER plane is exposed. The decision's
// own justification is satisfied by the control-plane half (an appliance bound
// to the LAN is findable before anything is configured), and the data-plane half
// is what keeps today's behaviour intact.
//
// WHERE THE DATA-PLANE HALF COMES FROM AT BOOT. `networkMode`, `advertisedHost`
// and `config.port` are launcher state folded into the llama config; none of
// them existed on disk before this. So a launch records what it used, and the
// next boot reads it back. A machine that has never launched has no record and
// advertises nothing — which is exactly today's behaviour, so this change is
// additive for existing installs and only the appliance (non-loopback control
// plane) advertises from a cold start.
//
// WHICH PORT IS ADVERTISED. The gateway's, unchanged. Pointing the service
// record at the admin listener would be defensible once there is an admin UI a
// browser can actually load — that is Phase 3. Until then it would advertise a
// page that cannot render. The A record for `redstart.local` is the valuable
// half either way, and it does not depend on the port.
// =============================================================================

import { startMdnsAdvertiser, stopMdnsAdvertiser } from './mdns-advertiser.mjs'
import { startPort80Proxy, stopPort80Proxy } from './port80-proxy.mjs'
import { ensureFirewallRule } from './firewall.mjs'
import { isLoopbackBind } from './admin-listener.mjs'
import { DEFAULT_GATEWAY_PORT } from './ports.mjs'
import { logEvent } from './logger.mjs'

const DEFAULT_ADVERTISED_HOST = 'redstart.local'

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
    advertisedHost: typeof stored?.advertisedHost === 'string' && stored.advertisedHost.trim()
      ? stored.advertisedHost.trim()
      : DEFAULT_ADVERTISED_HOST,
    gatewayPort: Number.isInteger(stored?.gatewayPort) ? stored.gatewayPort : DEFAULT_GATEWAY_PORT,
  }
}

/** What a launch should write back, so the next boot starts where this left off. */
export function discoveryRecordFor(config) {
  return {
    networkMode: config?.networkMode === true,
    advertisedHost: typeof config?.advertisedHost === 'string' && config.advertisedHost.trim()
      ? config.advertisedHost.trim()
      : DEFAULT_ADVERTISED_HOST,
    gatewayPort: Number.isInteger(config?.port) ? config.port : DEFAULT_GATEWAY_PORT,
  }
}

/**
 * Should this box announce itself, and why?
 *
 * Pure, so the policy is testable without opening a socket or a multicast
 * group. `reason` is what makes a support answer possible: "it is not on the
 * network" and "it is on the network but nothing has told it to say so" look
 * identical from the outside.
 *
 * @returns {{ advertise: boolean, reason: string }}
 */
export function discoveryPlan({ adminBindHost, networkMode } = {}) {
  // An unknown bind address is treated as loopback, not as exposure. The admin
  // listener reports null when it failed to bind at all, and `!isLoopbackBind(null)`
  // is true — which would have a box that has no control plane advertise itself
  // on the strength of it. Fail closed on the exposure axis, always.
  const controlPlaneExposed = typeof adminBindHost === 'string' && !isLoopbackBind(adminBindHost)
  if (controlPlaneExposed) return { advertise: true, reason: 'control-plane' }
  if (networkMode === true) return { advertise: true, reason: 'data-plane' }
  return { advertise: false, reason: 'loopback-only' }
}

let advertising = false

/**
 * Start (or restart) discovery.
 *
 * Idempotent and safe to call again with new values — that is how a launch
 * pushes a changed port or advertised name through without the whole thing
 * being tied to the launch's lifecycle.
 *
 * @param {object} input
 * @param {string} input.adminBindHost   where the control plane is bound
 * @param {boolean} input.networkMode    the data plane's LAN exposure
 * @param {string} input.advertisedHost  the `.local` name to publish
 * @param {number} input.gatewayPort     the port the service record points at
 * @returns {{ advertise: boolean, reason: string }} the plan that was applied
 */
export function startDiscovery(input = {}) {
  const plan = discoveryPlan(input)

  if (!plan.advertise) {
    stopDiscovery()
    return plan
  }

  const { advertisedHost, gatewayPort } = input
  const port = Number.isInteger(gatewayPort) ? gatewayPort : DEFAULT_GATEWAY_PORT

  startMdnsAdvertiser({ advertisedHost, port })

  // The clean URL. Skipped when the gateway is already on 80 — there would be
  // nothing to proxy. The firewall rule is checked unelevated and short-circuits
  // when it already exists, so this prompts at most once ever (firewall.mjs);
  // moving discovery to boot moves that one prompt from the first launch to the
  // first exposed start, which is the price of the lifecycle being correct.
  if (port !== 80) {
    ensureFirewallRule(80)
    startPort80Proxy({ targetPort: port })
  }

  if (!advertising) logEvent('discovery', 'started', { reason: plan.reason, port })
  advertising = true
  return plan
}

export function stopDiscovery() {
  stopMdnsAdvertiser()
  stopPort80Proxy()
  if (advertising) logEvent('discovery', 'stopped', {})
  advertising = false
}
