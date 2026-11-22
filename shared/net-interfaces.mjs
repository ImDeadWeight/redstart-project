'use strict'

// ---------------------------------------------------------------------------
// LAN interface selection — for the "server address" display (and, until it
// was retired, the mDNS advertiser).
//
// os.networkInterfaces() lists every adapter, and on a typical Windows box
// that includes Hyper-V / WSL / VirtualBox switches and VPN taps. Taking the
// FIRST non-internal IPv4 routinely picked a virtual adapter, showing the UI
// (and encoding into the QR code) an IP nothing on the LAN could reach.
// Centralising the choice here keeps every caller agreeing on which
// addresses are real.
//
// SHARED (moved from redstart-nest/daemon). Nest uses it for the address it
// shows, encodes in the QR code and publishes to DuckDNS/deSEC; Twig uses it
// to pick the subnet its "find my Nest" scan walks. Twig used to take the
// first non-internal IPv4, the bug this file was written to fix in Nest, so
// on a machine with a VPN, WSL or Docker adapter it scanned the wrong subnet.
//
// THE ROUTE PROBE. A name list cannot know every VPN client or every way an
// adapter can be named, and on a box with two real adapters (Ethernet plus a
// Wi-Fi on another network) it cannot know which one the LAN is on. The OS
// can: connect() on a UDP socket picks the source address the routing table
// would use, without sending a single packet (UDP has no handshake). That
// address wins when it belongs to a physical adapter. It is probed in the
// background and cached, because every caller here is synchronous; until a
// probe has answered, or when there is no route at all (an offline LAN), the
// ordering below decides as it always has.
//
// The probe target is a public address only so that the routing table picks
// the default route; nothing is sent to it.
// ---------------------------------------------------------------------------

import * as dgram from 'node:dgram'
import * as os from 'node:os'

// Adapter-name fragments indicating a virtual/host-only switch rather than a
// NIC on the physical LAN. Matched as case-insensitive substrings because
// Windows names them e.g. "vEthernet (WSL (Hyper-V firewall))".
const VIRTUAL_NAME_PATTERNS = [
  // Windows hypervisors, containers and VPN taps
  'vethernet', 'wsl', 'hyper-v', 'hyperv', 'virtualbox', 'vmware', 'vmnet',
  'docker', 'loopback', 'tailscale', 'zerotier', 'wireguard', 'tap-windows',
  'openvpn', 'bluetooth', 'npcap', 'nordlynx', 'utun',
  // VPN clients that name their adapter after themselves
  'vpn', 'nordvpn', 'proton', 'mullvad', 'expressvpn', 'surfshark', 'cisco',
  'anyconnect', 'fortinet', 'forticlient', 'globalprotect', 'pangp',
  'hamachi', 'radmin', 'cloudflare warp',
]

// Interface names macOS and Linux generate, matched whole (a fragment like
// "ap1" would also match a Windows adapter someone named "Laptop1"):
//   macOS  bridge100 (Internet Sharing, VMs), awdl0 (AirDrop), llw0 (Low
//          Latency WLAN), anpi0 (Apple-internal), ap1 (Wi-Fi hotspot side)
//   Linux  virbr0 (libvirt), veth* (containers), br-<id> (docker networks),
//          cni0 / flannel.1 (Kubernetes), podman0
const VIRTUAL_NAME_REGEXES = [
  /^bridge\d+$/, /^awdl\d+$/, /^llw\d+$/, /^anpi\d+$/, /^ap\d+$/,
  /^virbr\d+/, /^veth/, /^br-[0-9a-f]+$/, /^cni\d+$/, /^flannel\./, /^podman\d+$/,
]

// MAC OUIs owned by hypervisors. Catches virtual adapters that were renamed to
// something innocuous, which the name check alone would miss.
const VIRTUAL_MAC_PREFIXES = [
  '00:15:5d', // Hyper-V
  '08:00:27', // VirtualBox
  '0a:00:27', // VirtualBox host-only
  '00:05:69', // VMware
  '00:0c:29', // VMware
  '00:1c:14', // VMware
  '00:50:56', // VMware
]

function isVirtual(name, mac) {
  const lowerName = name.toLowerCase()
  if (VIRTUAL_NAME_PATTERNS.some(p => lowerName.includes(p))) return true
  if (VIRTUAL_NAME_REGEXES.some(r => r.test(lowerName))) return true
  const lowerMac = (mac || '').toLowerCase()
  return VIRTUAL_MAC_PREFIXES.some(p => lowerMac.startsWith(p))
}

// 169.254/16 is APIPA — the adapter failed DHCP and is on no useful network.
function isLinkLocal(address) {
  return address.startsWith('169.254.')
}

function isRfc1918(address) {
  if (address.startsWith('192.168.') || address.startsWith('10.')) return true
  const m = address.match(/^172\.(\d+)\./)
  return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31
}

// Every non-internal IPv4 the OS reports, annotated. Callers filter/rank.
//
// `ifaces` is injectable so tests can feed a synthetic Hyper-V/WSL/VPN adapter
// map — the exact configuration this module exists to handle, and one that
// can't be reproduced on a single-NIC machine.
function collect(ifaces = os.networkInterfaces()) {
  const out = []
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs || []) {
      // Node <18 reports family as the string 'IPv4'; newer versions may use 4.
      const isV4 = addr.family === 'IPv4' || addr.family === 4
      if (!isV4 || addr.internal) continue
      out.push({
        name,
        address: addr.address,
        mac: addr.mac,
        virtual: isVirtual(name, addr.mac),
        linkLocal: isLinkLocal(addr.address),
        private: isRfc1918(addr.address),
      })
    }
  }
  return out
}

// The interfaces worth advertising on / showing to the user: physical adapters
// holding a routable address. RFC1918 addresses sort first — on a dual-homed
// box the private one is the LAN clients live on.
export function listLanInterfaces(ifaces) {
  return collect(ifaces)
    .filter(i => !i.virtual && !i.linkLocal)
    .sort((a, b) => Number(b.private) - Number(a.private))
}

// Best single address for "browse here". Falls back through progressively
// worse options rather than returning loopback while a usable adapter exists.
export function getPrimaryLanIp(ifaces) {
  const lan = listLanInterfaces(ifaces)
  if (routeIp && lan.some(i => i.address === routeIp)) return routeIp
  if (lan.length) return lan[0].address

  // No physical adapter — better to hand back a virtual/APIPA address than
  // 127.0.0.1, which is guaranteed useless to every other device.
  const any = collect(ifaces).filter(i => !i.linkLocal)
  if (any.length) return any[0].address

  const all = collect(ifaces)
  return all.length ? all[0].address : '127.0.0.1'
}

// --- the route probe --------------------------------------------------------

const PROBE_TARGET = '1.1.1.1'
const PROBE_PORT = 53
const PROBE_INTERVAL_MS = 30_000

let routeIp = null
let probeTimer = null

/**
 * The local IPv4 the OS would route outbound traffic from, or null (no
 * default route, or the probe failed). Sends nothing: connect() on UDP only
 * selects a route. `createSocket` is injectable for tests.
 *
 * @returns {Promise<string|null>}
 */
export function probeRouteIp({ createSocket = () => dgram.createSocket('udp4'), target = PROBE_TARGET, timeoutMs = 1000 } = {}) {
  return new Promise((resolve) => {
    let sock
    let settled = false
    const done = (ip) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { sock?.close() } catch { /* already closed */ }
      resolve(ip)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    timer.unref?.()
    try {
      sock = createSocket()
      sock.on('error', () => done(null))
      sock.connect(PROBE_PORT, target, () => {
        try {
          const { address } = sock.address()
          done(typeof address === 'string' && address !== '0.0.0.0' ? address : null)
        } catch {
          done(null)
        }
      })
    } catch {
      done(null)
    }
  })
}

/** Re-probe now and update the cache getPrimaryLanIp() reads. */
export async function refreshRouteIp(opts) {
  routeIp = await probeRouteIp(opts)
  return routeIp
}

/**
 * Keep the cache fresh (an adapter change, a laptop moving networks). Idempotent;
 * the timer is unref'd so it never holds a process open.
 */
export function startRouteProbe(intervalMs = PROBE_INTERVAL_MS) {
  if (probeTimer) return
  void refreshRouteIp()
  probeTimer = setInterval(() => { void refreshRouteIp() }, intervalMs)
  probeTimer.unref?.()
}

export function stopRouteProbe() {
  if (probeTimer) clearInterval(probeTimer)
  probeTimer = null
}

/** Tests only: set the cached route address directly. */
export function _setRouteIpForTests(ip) {
  routeIp = ip
}

/**
 * The /24 a "find my Nest" scan should walk, from the primary LAN address.
 * The scan protocol takes a three-octet prefix, so a wider network is scanned
 * as the /24 this machine is in, which is where a home router puts its hosts.
 *
 * @returns {{ ip: string, subnet: string, gateway: string } | null}
 */
export function lanScanInfo(ifaces) {
  const ip = getPrimaryLanIp(ifaces)
  if (!ip || ip === '127.0.0.1') return null
  const parts = ip.split('.')
  return { ip, subnet: parts.slice(0, 3).join('.'), gateway: `${parts.slice(0, 3).join('.')}.1` }
}
