'use strict'

// ---------------------------------------------------------------------------
// LAN interface selection — for the "server address" display (and, until
// Phase 6.5 retired it, the mDNS advertiser).
//
// os.networkInterfaces() lists every adapter, and on a typical Windows box
// that includes Hyper-V / WSL / VirtualBox switches and VPN taps. Taking the
// FIRST non-internal IPv4 routinely picked a virtual adapter, showing the UI
// (and encoding into the QR code) an IP nothing on the LAN could reach.
// Centralising the choice here keeps every caller agreeing on which
// addresses are real.
// ---------------------------------------------------------------------------

import * as os from 'node:os'

// Adapter-name fragments indicating a virtual/host-only switch rather than a
// NIC on the physical LAN. Matched as case-insensitive substrings because
// Windows names them e.g. "vEthernet (WSL (Hyper-V firewall))".
const VIRTUAL_NAME_PATTERNS = [
  'vethernet', 'wsl', 'hyper-v', 'hyperv', 'virtualbox', 'vmware', 'vmnet',
  'docker', 'loopback', 'tailscale', 'zerotier', 'wireguard', 'tap-windows',
  'openvpn', 'bluetooth', 'npcap', 'nordlynx', 'utun',
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
  if (lan.length) return lan[0].address

  // No physical adapter — better to hand back a virtual/APIPA address than
  // 127.0.0.1, which is guaranteed useless to every other device.
  const any = collect(ifaces).filter(i => !i.linkLocal)
  if (any.length) return any[0].address

  const all = collect(ifaces)
  return all.length ? all[0].address : '127.0.0.1'
}
