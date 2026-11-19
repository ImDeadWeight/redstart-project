'use strict'

// =============================================================================
// Redstart Nest — Discovery (the port-80 clean URL)
// =============================================================================
// mDNS was retired wholesale (`.local` names never worked on Android, the
// primary mobile platform, and Twig's beacon scan never needed a name to
// begin with). What is left of this module is the port-80 proxy: a clean
// `http://<ip>` instead of `http://<ip>:19080`, useful on the LAN and,
// unlike mDNS, working on every client including Android.
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
// WHO STARTS IT: the network-mode owner (network-mode-owner.mjs), since TLS
// step 3. This module keeps the POLICY (discoveryPlan) and the boot record.
//
// WHAT DECIDES WHETHER IT STARTS. `networkMode`, full stop — this is purely a
// data-plane convenience now. (Historical note: this used to be "the union of
// both planes," because an exposed control plane was also a reason to
// advertise via mDNS. That reasoning is gone with mDNS. What survives of it
// is only "this starts with the daemon, not from inside `llama:launch`.")
// =============================================================================

import { stopPort80Proxy } from './port80-proxy.mjs'
import { DEFAULT_GATEWAY_PORT } from './ports.mjs'

/**
 * The last network configuration a launch actually used, normalised.
 *
 * Absent on a machine that has never launched — deliberately NOT defaulted to
 * `networkMode: true`. The default in src/launcher/types.ts is on, but inferring "this
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
export function discoveryPlan({ networkMode, platform = process.platform } = {}) {
  if (networkMode !== true) return { advertise: false, reason: 'loopback-only' }
  if (platform !== 'win32') {
    // The clean URL is a Windows-desktop convenience and it cannot work
    // headless, for two independent reasons:
    //
    //   1. Port 80 is privileged on POSIX. An unprivileged daemon simply
    //      cannot bind it, and the answer is emphatically NOT to give Nest
    //      the capability to do so — the service account exists to SHED
    //      privileges, and CAP_NET_BIND_SERVICE on a process that spawns a
    //      user-configurable binary and runs third-party plugin code undoes
    //      the point of it.
    //   2. A reverse proxy sits in front at level 3, and it owns 80 and 443.
    //      Nest also binding 80 would be a collision with the thing that is
    //      supposed to be terminating TLS.
    //
    // Reported rather than attempted-and-swallowed: an EADDRINUSE or EACCES
    // logged as a warning on every boot is how an operator learns to ignore
    // warnings.
    return { advertise: false, reason: 'no-privileged-port' }
  }
  return { advertise: true, reason: 'data-plane' }
}

/**
 * Stop the port-80 proxy. Starting it is the network-mode owner's job since
 * TLS step 3 (network-mode-owner.mjs, through lan.mjs), because with Caddy in
 * the picture the proxy and Caddy must never both hold :80, and only one
 * module may decide which runs. The policy above is still this module's:
 * network-mode.mjs asks discoveryPlan() rather than keeping a copy.
 */
export function stopDiscovery() {
  stopPort80Proxy()
}
