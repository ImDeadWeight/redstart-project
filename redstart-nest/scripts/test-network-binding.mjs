// =============================================================================
// Network binding — LAN exposure is a socket decision, not a firewall decision.
// =============================================================================
// The gateway and the MCP server used to listen on '0.0.0.0' unconditionally,
// with Windows Firewall rules added on every start regardless of the launcher's
// "Local network" toggle. That made the toggle a firewall-rule switch rather
// than an exposure control: the socket was bound wide either way, so a host
// with the firewall off, a third-party firewall, or a stale rule from an
// earlier run was reachable on both ports with network mode off.
//
// Both servers now take an explicit bindHost that DEFAULTS TO LOOPBACK, and
// ipc/server.mjs derives it from config.networkMode.
//
// WHY THIS SUITE OPENS REAL SOCKETS
//
// A test that asserts `bindHost === '127.0.0.1'` proves only that a variable
// holds a string. The claim being made is "a machine on the LAN cannot reach
// this port", and the only honest way to check it is to bind the server and
// then try to connect from a non-loopback address on this host. Every check
// below is a real TCP connect against a real listening server.
//
// Run:  node scripts/test-network-binding.mjs
// =============================================================================

import { register } from 'node:module'
import * as net from 'node:net'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-bind-test-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir

register('./auth-test-loader.mjs', import.meta.url)

const { startGateway, stopGateway } = await import('../electron/main/tools-gateway.mjs')
const { startMcpServer, stopMcpServer } = await import('../electron/main/mcp-server.mjs')
const { setAuthRequired } = await import('../electron/main/auth.mjs')

// This suite is about reachability, not the auth gate (test-auth.mjs owns
// that). Auth off keeps the loopback probes to a plain 200 instead of a 401 —
// either would prove the socket is listening, but a 200 rules out the probe
// itself being the thing that failed.
setAuthRequired(false)

const GATEWAY_PORT = 48280 // internal is +1
const MCP_PORT = 48282
const CONNECT_TIMEOUT_MS = 3000

const baseConfig = { allowedBaseUrls: [], activeTools: [], maxFetchTokens: 2000 }

// ---------------------------------------------------------------------------
// Harness (same shape as the sibling suites)
// ---------------------------------------------------------------------------

const results = []

async function test(name, fn) {
  try {
    const detail = await fn()
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

// ---------------------------------------------------------------------------
// A non-loopback address belonging to THIS machine.
//
// Deliberately NOT net-interfaces.mjs's getPrimaryLanIp(): that function
// filters out Hyper-V/WSL/VPN adapters because it answers "which address should
// we advertise to other devices?". This suite asks a different question — "is
// there any address other than 127.0.0.1 on which this port answers?" — and a
// virtual adapter is a perfectly good witness for it. Using the raw list also
// keeps the checks alive on CI runners, whose NICs carry hypervisor MAC OUIs
// and would otherwise be filtered out, skipping the whole suite in the one
// place it most needs to run.
// ---------------------------------------------------------------------------
function nonLoopbackIpv4() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address
    }
  }
  return null
}

const LAN_IP = nonLoopbackIpv4()

/**
 * Attempt a TCP connection. Resolves 'open' | 'refused' | 'unreachable'.
 * Never rejects — the outcome IS the assertion subject.
 */
function probe(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const finish = (outcome) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(outcome)
    }
    socket.setTimeout(CONNECT_TIMEOUT_MS)
    socket.once('connect', () => finish('open'))
    socket.once('timeout', () => finish('unreachable'))
    socket.once('error', (err) => finish(err.code === 'ECONNREFUSED' ? 'refused' : 'unreachable'))
    socket.connect(port, host)
  })
}

// A closed port and a filtered one are both "the LAN cannot get in", which is
// the property under test. Only 'open' falsifies it.
const isClosed = (outcome) => outcome === 'refused' || outcome === 'unreachable'

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

console.log('\n-- gateway bind --')

await test('🔍 loopback bind: reachable on 127.0.0.1', async () => {
  await startGateway(GATEWAY_PORT, baseConfig, { bindHost: '127.0.0.1' })
  try {
    assert(await probe('127.0.0.1', GATEWAY_PORT) === 'open', 'gateway not listening on loopback')
    const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/auth/config`)
    assert(res.ok, `loopback probe returned HTTP ${res.status}`)
    return 'serving, not merely bound'
  } finally {
    stopGateway()
  }
})

await test('🔍 loopback bind: NOT reachable on this host\'s LAN address', async () => {
  if (!LAN_IP) return 'skipped — no non-loopback IPv4 on this host'
  await startGateway(GATEWAY_PORT, baseConfig, { bindHost: '127.0.0.1' })
  try {
    const outcome = await probe(LAN_IP, GATEWAY_PORT)
    assert(isClosed(outcome), `gateway answered on ${LAN_IP}:${GATEWAY_PORT} (${outcome}) with a loopback bind`)
    return `${LAN_IP} -> ${outcome}`
  } finally {
    stopGateway()
  }
})

await test('wildcard bind: reachable on the LAN address', async () => {
  if (!LAN_IP) return 'skipped — no non-loopback IPv4 on this host'
  await startGateway(GATEWAY_PORT, baseConfig, { bindHost: '0.0.0.0' })
  try {
    const outcome = await probe(LAN_IP, GATEWAY_PORT)
    assert(outcome === 'open', `network mode cannot expose the gateway: ${LAN_IP} -> ${outcome}`)
    return `${LAN_IP} -> open`
  } finally {
    stopGateway()
  }
})

await test('🔍 default bind is loopback — a caller must ASK for LAN exposure', async () => {
  if (!LAN_IP) return 'skipped — no non-loopback IPv4 on this host'
  await startGateway(GATEWAY_PORT, baseConfig) // no options at all
  try {
    const outcome = await probe(LAN_IP, GATEWAY_PORT)
    assert(isClosed(outcome), `omitting bindHost exposed the gateway on ${LAN_IP} (${outcome}) — the default must fail closed`)
    return 'fails closed'
  } finally {
    stopGateway()
  }
})

// ---------------------------------------------------------------------------
// MCP server
//
// Matters more than the gateway, not less: this port IS the MCP transport, so
// anything that reaches it can drive tools/call directly.
// ---------------------------------------------------------------------------

console.log('\n-- MCP server bind --')

await test('🔍 loopback bind: reachable on 127.0.0.1', async () => {
  await startMcpServer(MCP_PORT, baseConfig, { bindHost: '127.0.0.1' })
  try {
    assert(await probe('127.0.0.1', MCP_PORT) === 'open', 'MCP server not listening on loopback')
    return 'listening'
  } finally {
    stopMcpServer()
  }
})

await test('🔍 loopback bind: NOT reachable on this host\'s LAN address', async () => {
  if (!LAN_IP) return 'skipped — no non-loopback IPv4 on this host'
  await startMcpServer(MCP_PORT, baseConfig, { bindHost: '127.0.0.1' })
  try {
    const outcome = await probe(LAN_IP, MCP_PORT)
    assert(isClosed(outcome), `MCP transport answered on ${LAN_IP}:${MCP_PORT} (${outcome}) with a loopback bind`)
    return `${LAN_IP} -> ${outcome}`
  } finally {
    stopMcpServer()
  }
})

await test('wildcard bind: reachable on the LAN address', async () => {
  if (!LAN_IP) return 'skipped — no non-loopback IPv4 on this host'
  await startMcpServer(MCP_PORT, baseConfig, { bindHost: '0.0.0.0' })
  try {
    const outcome = await probe(LAN_IP, MCP_PORT)
    assert(outcome === 'open', `network mode cannot expose the MCP server: ${LAN_IP} -> ${outcome}`)
    return `${LAN_IP} -> open`
  } finally {
    stopMcpServer()
  }
})

await test('🔍 default bind is loopback — a caller must ASK for LAN exposure', async () => {
  if (!LAN_IP) return 'skipped — no non-loopback IPv4 on this host'
  await startMcpServer(MCP_PORT, baseConfig) // no options at all
  try {
    const outcome = await probe(LAN_IP, MCP_PORT)
    assert(isClosed(outcome), `omitting bindHost exposed the MCP transport on ${LAN_IP} (${outcome}) — the default must fail closed`)
    return 'fails closed'
  } finally {
    stopMcpServer()
  }
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

if (!LAN_IP) {
  console.log('\nNOTE: this host has no non-loopback IPv4 address, so the LAN-reachability')
  console.log('      checks were skipped. The loopback checks still ran.')
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
