// =============================================================================
// Tests for daemon/net-interfaces.mjs — LAN adapter selection.
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
  probeRouteIp,
  lanScanInfo,
  _setRouteIpForTests,
} from '../daemon/net-interfaces.mjs'
import { EventEmitter } from 'node:events'

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
// Route probe + the wider virtual-adapter list (shared/net-interfaces.mjs)
// ---------------------------------------------------------------------------

test('the routed adapter wins over listing order when both are physical', () => {
  // Two real adapters: Ethernet on an old network, Wi-Fi on the LAN. Order
  // alone picked Ethernet; the routing table says Wi-Fi.
  const ifaces = { 'Ethernet': v4('192.168.50.4', 'a8:a1:59:00:00:01'), 'Wi-Fi': v4('192.168.1.23', 'a8:a1:59:00:00:02') }
  _setRouteIpForTests('192.168.1.23')
  try {
    assert(getPrimaryLanIp(ifaces) === '192.168.1.23', getPrimaryLanIp(ifaces))
  } finally { _setRouteIpForTests(null) }
})

test('a routed VPN address does NOT win (a full-tunnel VPN owns the default route)', () => {
  const ifaces = { 'ProtonVPN': v4('10.2.0.2'), 'Wi-Fi': v4('192.168.1.23', 'a8:a1:59:00:00:02') }
  _setRouteIpForTests('10.2.0.2')
  try {
    assert(getPrimaryLanIp(ifaces) === '192.168.1.23', getPrimaryLanIp(ifaces))
  } finally { _setRouteIpForTests(null) }
})

test('a stale route address (adapter gone) is ignored', () => {
  _setRouteIpForTests('192.168.9.9')
  try {
    assert(getPrimaryLanIp({ 'Wi-Fi': v4('192.168.1.23') }) === '192.168.1.23', 'used an address no adapter has')
  } finally { _setRouteIpForTests(null) }
})

test('macOS bridge/AirDrop/hotspot adapters are skipped; en0 is kept', () => {
  const ifaces = { bridge100: v4('192.168.2.1'), awdl0: v4('192.168.3.1'), ap1: v4('192.168.4.1'), en0: v4('192.168.1.40') }
  const lan = listLanInterfaces(ifaces).map(i => i.name)
  assert(lan.length === 1 && lan[0] === 'en0', lan.join(', '))
})

test('a name fragment does not catch real adapters ("Laptop1", "Ethernet 2")', () => {
  const lan = listLanInterfaces({ 'Laptop1': v4('192.168.1.5'), 'Ethernet 2': v4('192.168.1.6') })
  assert(lan.length === 2, lan.map(i => i.name).join(', '))
})

test('VPN clients and Linux container bridges are skipped', () => {
  const names = ['NordVPN', 'Mullvad', 'Cisco AnyConnect Secure Mobility Client', 'PANGP Virtual Ethernet Adapter', 'virbr0', 'br-3f2a9c1d', 'veth12ab', 'podman0']
  const ifaces = Object.fromEntries(names.map((n, i) => [n, v4(`10.9.${i}.2`)]))
  ifaces['Ethernet'] = v4('192.168.1.7')
  const lan = listLanInterfaces(ifaces).map(i => i.name)
  assert(lan.length === 1 && lan[0] === 'Ethernet', lan.join(', '))
})

test('lanScanInfo gives the /24 of the primary address, not of the first adapter', () => {
  const info = lanScanInfo({ 'vEthernet (WSL)': v4('172.24.0.1'), 'Wi-Fi': v4('192.168.1.23') })
  assert(info && info.subnet === '192.168.1' && info.ip === '192.168.1.23', JSON.stringify(info))
  assert(lanScanInfo({}) === null, 'no adapters should give null')
})

// probeRouteIp is async; run its cases after the sync ones above.
function fakeSocket({ address = '192.168.1.23', fail = false } = {}) {
  const s = new EventEmitter()
  s.connect = (_port, _host, cb) => { setImmediate(() => (fail ? s.emit('error', new Error('ENETUNREACH')) : cb())) }
  s.address = () => ({ address, family: 'IPv4', port: 50000 })
  s.close = () => { s.closed = true }
  s.send = () => { throw new Error('the probe must never send') }
  return s
}
async function asyncTest(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true, detail })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false, detail: err.message })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}
await asyncTest('probeRouteIp reads the routed source address and closes the socket, sending nothing', async () => {
  const sock = fakeSocket()
  const ip = await probeRouteIp({ createSocket: () => sock })
  assert(ip === '192.168.1.23', String(ip))
  assert(sock.closed, 'socket left open')
})
await asyncTest('probeRouteIp answers null with no route', async () => {
  assert(await probeRouteIp({ createSocket: () => fakeSocket({ fail: true }) }) === null, 'expected null')
  assert(await probeRouteIp({ createSocket: () => fakeSocket({ address: '0.0.0.0' }) }) === null, 'expected null for 0.0.0.0')
})
await asyncTest('probeRouteIp against the real stack never throws', async () => {
  const ip = await probeRouteIp()
  return `routed address here: ${ip ?? 'none'}`
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
