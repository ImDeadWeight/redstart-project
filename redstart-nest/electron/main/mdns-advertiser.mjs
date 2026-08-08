'use strict'

// ---------------------------------------------------------------------------
// mDNS advertiser — publishes `redstart.local` on the LAN.
//
// Scope note: mDNS is a convenience layer, never the primary path. Android's
// resolver does not answer `.local` lookups for browser navigation, so phones
// cannot use this name at all; the IP (and the QR code built from it) is the
// universal route, and Twig finds Nest by beacon scan without needing a name.
// What follows makes the name work everywhere it *can* work — iOS, macOS,
// Windows 10 1703+, Linux with avahi + nss-mdns.
//
// Two things were wrong before:
//   1. The firewall rule was added by calling netsh directly without elevation,
//      so it ALWAYS threw and was swallowed into a console.warn. Inbound UDP
//      5353 stayed blocked, queries never arrived, and the advertiser answered
//      nobody. This was the actual reason other machines couldn't resolve the
//      name. Now routed through firewall.mjs / elevate.exe like the TCP rules.
//   2. Nothing re-announced after a Wi-Fi reconnect, sleep/resume, or DHCP
//      lease change, so the record went stale until the server was restarted,
//      and stop() sent no goodbye packets so peers cached a dead address for
//      minutes. Now watched, republished, and unpublished properly.
//
// Deliberately NOT per-interface: multicast-dns already joins the multicast
// group on every IPv4 interface (allInterfaces()) and binds 0.0.0.0, so the
// default instance receives queries on every adapter. Passing `interface`
// would instead bind the socket to one unicast address, which on Linux stops
// multicast datagrams being delivered at all. The default is the robust choice.
// ---------------------------------------------------------------------------

import { Bonjour } from 'bonjour-service'
import { getGatewayPort } from './tools-gateway.mjs'
import { ensureMdnsFirewallRule } from './firewall.mjs'
import { interfaceSignature, describeInterfaces } from './net-interfaces.mjs'

// How often to re-check the interface set. 5s is responsive enough that a
// laptop waking onto Wi-Fi re-announces before a user finishes typing the URL,
// and cheap enough to ignore — os.networkInterfaces() is a local syscall.
const WATCH_INTERVAL_MS = 5000

let bonjour = null
let advertised = null
let watchTimer = null
let watchedSignature = ''
let activeConfig = null

// Tear down the published service without touching the watcher, so a network
// change can rebuild cleanly and keep watching.
function unpublish() {
  if (bonjour) {
    // unpublishAll first: it sends mDNS goodbye packets (TTL 0) so peers drop
    // the record immediately. destroy() alone leaves it cached for minutes,
    // which is what made a restarted or moved Nest resolve to a dead address.
    try { bonjour.unpublishAll() } catch {}
  }
  if (advertised) {
    try { advertised.stop() } catch {}
    advertised = null
  }
  if (bonjour) {
    try { bonjour.destroy() } catch {}
    bonjour = null
  }
}

function publish(config) {
  // bonjour-service uses `host` verbatim as the A-record name (no suffix is
  // appended), and mDNS resolvers only ever query names ending in `.local`.
  // So the advertised host MUST carry the `.local` suffix — normalize to it
  // rather than stripping it.
  const rawHost = (config.advertisedHost || '').trim().replace(/\.local$/i, '')
  const host = rawHost ? `${rawHost}.local` : null
  const port = getGatewayPort(config.port) || config.port
  if (!port) return

  watchedSignature = interfaceSignature()

  // Logged every (re)publish so a "can't reach it" report shows which adapters
  // existed at the time and which were judged virtual.
  for (const line of describeInterfaces()) console.log(`mDNS interface: ${line}`)

  bonjour = new Bonjour()
  advertised = bonjour.publish({
    name: 'Redstart Nest',
    type: 'http',
    port,
    ...(host ? { host } : {}),
    disableIPv6: true,
    txt: {
      path: '/',
      service: 'redstart-nest',
    },
  })

  console.log(`mDNS advertising Redstart Nest on port ${port}${host ? ` as ${host}` : ''}`)
}

function startWatching() {
  if (watchTimer) return
  watchTimer = setInterval(() => {
    if (!activeConfig) return
    const current = interfaceSignature()
    if (current === watchedSignature) return
    console.log('mDNS: network change detected, re-announcing')
    unpublish()
    try {
      publish(activeConfig)
    } catch (err) {
      console.warn('mDNS re-announce failed:', err.message)
    }
  }, WATCH_INTERVAL_MS)
  // Don't hold the event loop open on shutdown.
  if (typeof watchTimer.unref === 'function') watchTimer.unref()
}

export function startMdnsAdvertiser(config) {
  stopMdnsAdvertiser()

  if (!config?.networkMode) return

  activeConfig = config

  // Inbound UDP 5353 must be open or queries never reach us. Fire-and-forget:
  // it prompts at most once ever, and a blocked port degrades the name only.
  ensureMdnsFirewallRule()

  try {
    publish(config)
    startWatching()
  } catch (err) {
    console.warn('mDNS advertiser failed to start:', err.message)
    unpublish()
    activeConfig = null
  }
}

export function stopMdnsAdvertiser() {
  if (watchTimer) {
    clearInterval(watchTimer)
    watchTimer = null
  }
  activeConfig = null
  watchedSignature = ''
  unpublish()
}
