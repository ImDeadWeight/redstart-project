// =============================================================================
// Tests for electron/main/net-interfaces.mjs — LAN adapter selection.
// =============================================================================
// This module decides which IP the UI shows and encodes into the QR code
// (and, until Phase 6.5 retired mDNS, which address the advertiser bound).
// Getting it wrong is silent: the app starts fine, reports an address, and
// simply cannot be reached from any other device. The failure mode it exists
// to prevent — picking a Hyper-V/WSL virtual switch over the real NIC — only
// reproduces on a machine that HAS those adapters, so every case here is
// driven from a synthetic interface map.
//
// net-interfaces.mjs imports only node:os — no Electron — so no stub is needed.
//
// Run:  node scripts/test-net-interfaces.mjs
// =============================================================================

import {
  listLanInterfaces,
  getPrimaryLanIp,
} from '../electron/main/net-interfaces.mjs'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const results = []

function test(name, fn) {
  try {
    const detail = fn()
    results.push({ name, pass: true, detail })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false, detail: err.message })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

// Shorthand for one IPv4 entry in an os.networkInterfaces()-shaped map.
function v4(address, mac = '00:11:22:33:44:55', internal = false) {
  return [{ address, family: 'IPv4', mac, internal }]
}

// ---------------------------------------------------------------------------
// Fixtures — realistic Windows adapter layouts
// ---------------------------------------------------------------------------

// The layout that broke it: Hyper-V's switch enumerates BEFORE the real NIC,
// so "first non-internal IPv4" returned an address no LAN device can reach.
const HYPERV_BOX = {
  'vEthernet (Default Switch)': v4('172.28.16.1', '00:15:5d:01:02:03'),
  'vEthernet (WSL (Hyper-V firewall))': v4('172.31.240.1', '00:15:5d:aa:bb:cc'),
  'Ethernet': v4('192.168.0.213', 'a8:a1:59:11:22:33'),
  'Loopback Pseudo-Interface 1': v4('127.0.0.1', '00:00:00:00:00:00', true),
}

const VM_ZOO = {
  'VirtualBox Host-Only Network': v4('192.168.56.1', '0a:00:27:00:00:12'),
  'VMware Network Adapter VMnet8': v4('192.168.239.1', '00:50:56:c0:00:08'),
  'Wi-Fi': v4('192.168.1.44', '3c:22:fb:aa:bb:cc'),
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log('\n-- LAN interface selection --')

test('baseline: a plain single-NIC box picks its only address', () => {
  const ifaces = { 'Ethernet': v4('192.168.0.213') }
  assert(getPrimaryLanIp(ifaces) === '192.168.0.213', getPrimaryLanIp(ifaces))
  return '192.168.0.213'
})

test('🔍 a Hyper-V/WSL switch never wins over the real NIC', () => {
  const ip = getPrimaryLanIp(HYPERV_BOX)
  assert(ip === '192.168.0.213', `picked ${ip}, expected the physical Ethernet address`)
  const lan = listLanInterfaces(HYPERV_BOX)
  assert(lan.length === 1, `expected 1 advertisable interface, got ${lan.length}: ${lan.map(i => i.name).join(', ')}`)
  return 'virtual switches excluded'
})

test('🔍 VirtualBox and VMware host-only adapters are excluded too', () => {
  const ip = getPrimaryLanIp(VM_ZOO)
  assert(ip === '192.168.1.44', `picked ${ip}, expected the Wi-Fi address`)
  return 'Wi-Fi chosen over 2 hypervisor adapters'
})

test('🔍 a renamed virtual adapter is still caught by its MAC OUI', () => {
  // Name gives nothing away; only the Hyper-V OUI 00:15:5d identifies it.
  const ifaces = {
    'Local Area Connection 3': v4('10.0.75.1', '00:15:5d:de:ad:be'),
    'Ethernet': v4('192.168.0.50', 'a8:a1:59:00:00:01'),
  }
  const ip = getPrimaryLanIp(ifaces)
  assert(ip === '192.168.0.50', `picked ${ip}, MAC-based detection failed`)
  return 'OUI 00:15:5d rejected'
})

test('🔍 APIPA (169.254/16) is never advertised', () => {
  const ifaces = {
    'Ethernet': v4('169.254.13.7'),      // failed DHCP
    'Wi-Fi': v4('192.168.1.20'),
  }
  const lan = listLanInterfaces(ifaces)
  assert(lan.length === 1 && lan[0].address === '192.168.1.20',
    `expected only the Wi-Fi address, got ${lan.map(i => i.address).join(', ')}`)
  return 'link-local filtered'
})

test('🔍 an all-APIPA box degrades to that address, not to loopback', () => {
  // Nothing is reachable either way, but 127.0.0.1 in the UI/QR is actively
  // misleading — it renders a code that can only ever open on this machine.
  const ip = getPrimaryLanIp({ 'Ethernet': v4('169.254.13.7') })
  assert(ip === '169.254.13.7', `got ${ip}`)
  return ip
})

test('🔍 a VPN-only box still yields an address rather than loopback', () => {
  const ip = getPrimaryLanIp({ 'Tailscale': v4('100.101.102.103') })
  assert(ip === '100.101.102.103', `got ${ip}`)
  return 'falls back past the virtual filter'
})

test('an empty interface map falls back to loopback', () => {
  assert(getPrimaryLanIp({}) === '127.0.0.1', getPrimaryLanIp({}))
  return '127.0.0.1'
})

test('RFC1918 addresses sort ahead of public ones on a dual-homed box', () => {
  const ifaces = {
    'Ethernet 2': v4('203.0.113.9', 'a8:a1:59:00:00:aa'),
    'Ethernet': v4('192.168.0.5', 'a8:a1:59:00:00:bb'),
  }
  assert(getPrimaryLanIp(ifaces) === '192.168.0.5', getPrimaryLanIp(ifaces))
  return 'private preferred'
})

test('numeric family === 4 is accepted alongside the string form', () => {
  const ifaces = { 'Ethernet': [{ address: '192.168.0.9', family: 4, mac: 'a8:a1:59:00:00:01', internal: false }] }
  assert(getPrimaryLanIp(ifaces) === '192.168.0.9', getPrimaryLanIp(ifaces))
  return 'both family encodings handled'
})

test('IPv6 and internal entries are ignored', () => {
  const ifaces = {
    'Ethernet': [
      { address: 'fe80::1', family: 'IPv6', mac: 'a8:a1:59:00:00:01', internal: false },
      { address: '192.168.0.7', family: 'IPv4', mac: 'a8:a1:59:00:00:01', internal: false },
    ],
    'Loopback': v4('127.0.0.1', '00:00:00:00:00:00', true),
  }
  const lan = listLanInterfaces(ifaces)
  assert(lan.length === 1 && lan[0].address === '192.168.0.7',
    `got ${lan.map(i => i.address).join(', ')}`)
  return 'IPv4-only, non-internal'
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
