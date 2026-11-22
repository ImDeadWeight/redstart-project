// =============================================================================
// Redstart Twig: finding a Redstart Nest on the local network
// =============================================================================
// Mirrors the Android NetworkDiscovery Capacitor plugin's interface, so the
// chat-ui uses one code path on both platforms. The scan uses Nest's beacon
// (port 8765), the same protocol the Android app speaks, so both clients find
// servers identically without duplicating server-side logic. Moved from
// Electron's main.mjs in the Tauri move, unchanged.
// =============================================================================

import * as dns from 'node:dns'
import * as http from 'node:http'
import * as os from 'node:os'

import { lanScanInfo, refreshRouteIp } from '../../../shared/net-interfaces.mjs'

// Must match the beacon port in Redstart Nest. Not configurable on purpose:
// the point is zero-configuration discovery.
export const BEACON_PORT = 8765

// How many beacon probes are in flight at once. All 254 used to start
// together: on macOS a process may hold 256 open files by default (ulimit -n),
// so most connects failed with EMFILE, which a probe reads as "no Nest
// here", and the scan found nothing. On Windows, that many half-open
// connections also trips some antivirus "port scan" heuristics.
export const SCAN_CONCURRENCY = 32

const ORIGIN_RE = /^https:\/\/([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)$/

/**
 * The beacon's `origin` (TLS plan C7), but only if it is a bare https origin
 * whose name RESOLVES TO THE RESPONDING IP. Otherwise null, and the caller
 * keeps building http://<ip>:<port> from the responding address, as it always
 * has. So a spoofed beacon gains nothing it could not do with its own IP: it
 * can only name a host that already points at itself.
 *
 * @param {unknown} origin  what the beacon said
 * @param {string} ip       the address that answered
 * @param {{ lookup?: (name: string, opts: object) => Promise<Array<{ address: string }>> }} [deps]
 * @returns {Promise<string|null>}
 */
export async function verifiedOrigin(origin, ip, { lookup = dns.promises.lookup } = {}) {
  if (typeof origin !== 'string') return null
  const m = ORIGIN_RE.exec(origin)
  if (!m) return null
  // 127.0.0.1 answers for Nest on this machine; its name resolves to the LAN
  // address, never to loopback, and the https name is still the right URL.
  try {
    const addrs = (await lookup(m[1], { all: true, family: 4 })).map((a) => a.address)
    return addrs.includes(ip) || (ip === '127.0.0.1' && addrs.length > 0 && addrs.some((a) => isLocalAddress(a))) ? origin : null
  } catch {
    return null
  }
}

function isLocalAddress(addr) {
  return Object.values(os.networkInterfaces()).some((list) => (list ?? []).some((i) => i.address === addr))
}

/**
 * Contact one IP and check whether Redstart Nest is there. The app identity
 * ("redstart-nest") is verified so another HTTP service on the port is not
 * mistaken for Nest, and `running` must be true: Nest open with no model
 * started has nothing to connect to.
 */
export function probeBeacon(ip, timeout, port = BEACON_PORT, deps = {}) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: ip, port, path: '/', timeout }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        try {
          const data = JSON.parse(body)
          if (data.app !== 'redstart-nest' || !data.running) { resolve(null); return }
          // The beacon sends a minimal { app, running, port } payload, plus
          // `origin` while Nest's HTTPS is serving. The URL is built from the
          // responding IP and that port, unless the origin's name resolves to
          // that same IP (verifiedOrigin).
          const serverPort = data.port
          if (!serverPort) { resolve(null); return }
          const direct = serverPort === 80 ? `http://${ip}` : `http://${ip}:${serverPort}`
          verifiedOrigin(data.origin, ip, deps).then((origin) => {
            resolve(origin ? { url: origin, ip, port: serverPort, secure: true } : { url: direct, ip, port: serverPort })
          }, () => resolve({ url: direct, ip, port: serverPort }))
        } catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

export const handlers = {
  // The subnet to scan comes from the same adapter choice Nest makes
  // (shared/net-interfaces.mjs): the route the OS would use, skipping VPN,
  // WSL, Hyper-V, Docker and macOS bridge adapters. It used to be the first
  // non-internal IPv4, so a machine with any of those scanned the wrong
  // network and never found Nest.
  'network:get-info': async () => {
    await refreshRouteIp()
    const info = lanScanInfo(os.networkInterfaces())
    if (!info) throw new Error('No active network interface found')
    return info
  },

  'network:scan': async ({ subnet, timeout = 400 } = {}) => {
    if (typeof subnet !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(subnet)) {
      throw new Error('network:scan needs a subnet like 192.168.1')
    }
    const found = []
    // 127.0.0.1 first, for Nest and Twig on one machine in localhost-only
    // mode, where Nest is not bound to the LAN address.
    const targets = ['127.0.0.1']
    for (let i = 1; i <= 254; i++) targets.push(`${subnet}.${i}`)
    await runLimited(targets, SCAN_CONCURRENCY, async (ip) => {
      const s = await probeBeacon(ip, timeout)
      if (s) found.push(s)
    })
    return { servers: found }
  },
}

/** Run `fn` over `items`, at most `limit` at a time. */
export async function runLimited(items, limit, fn) {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]
      await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}
