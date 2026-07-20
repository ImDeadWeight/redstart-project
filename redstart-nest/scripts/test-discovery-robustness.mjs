// =============================================================================
// Robustness tests for electron/main/beacon.mjs — the inbound discovery
// endpoint.
// =============================================================================
// Priority 7: malformed discovery traffic must be rejected safely with no
// crash. The beacon is the ONE discovery surface that accepts inbound traffic
// from untrusted clients on the LAN (mdns-advertiser.mjs only broadcasts, it
// never parses incoming packets), so it is where "garbage in -> no crash, still
// serving" has to be proven.
//
// The security contract (that the payload leaks nothing beyond app/running/port)
// is covered by the chat-ui security suite's "beacon payload" test. This suite
// is complementary: it hammers the listener with odd HTTP methods and raw
// non-HTTP bytes, then confirms the server is still alive and answering
// correctly afterward.
//
// beacon.mjs imports only Node's http — no Electron — so no stub is needed.
//
// Run:  node scripts/test-discovery-robustness.mjs
// =============================================================================

import * as http from 'node:http'
import * as net from 'node:net'
import { startBeaconServer, stopBeaconServer } from '../electron/main/beacon.mjs'

// ---------------------------------------------------------------------------
// Harness
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

// A normal GET to the beacon; resolves { status, json }.
function getBeacon(port, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: '/', timeout: 3000 }, (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(data) } catch {}
        resolve({ status: res.statusCode, json })
      })
    })
    req.on('timeout', () => { req.destroy(new Error('request timed out')) })
    req.on('error', reject)
    req.end()
  })
}

// Fire raw bytes at the socket and resolve once the server has closed/handled
// the connection (or a short grace period elapses). Never rejects on a socket
// error — a reset/close is an ACCEPTABLE response to garbage; the point is the
// server process must survive it.
function fireRaw(port, bytes) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(bytes)
    })
    const done = () => { try { sock.destroy() } catch {}; resolve() }
    sock.on('close', done)
    sock.on('error', done)
    sock.setTimeout(1500, done)
  })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Ephemeral port (0) so this never collides with a running instance's beacon.
  const server = await startBeaconServer(() => true, () => 19080, 0)
  const port = server.address().port
  console.log(`beacon listening on 127.0.0.1:${port}`)

  console.log('\n-- discovery beacon robustness --')

  await test('baseline: a normal GET returns the identity payload', async () => {
    const { status, json } = await getBeacon(port)
    assert(status === 200, `status ${status}`)
    assert(json && json.app === 'redstart-nest' && json.running === true && json.port === 19080, `unexpected payload: ${JSON.stringify(json)}`)
  })

  await test('🔍 odd HTTP methods do not crash the beacon', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH']) {
      const { status } = await getBeacon(port, method)
      assert(typeof status === 'number', `no status for ${method}`)
    }
  })

  await test('🔍 raw non-HTTP garbage bytes are handled without crashing', async () => {
    await fireRaw(port, Buffer.from([0x00, 0xff, 0x13, 0x37, 0xde, 0xad, 0xbe, 0xef, 0x0a, 0x0d]))
    await fireRaw(port, '\x16\x03\x01\x00\xff') // looks like the start of a TLS ClientHello
    await fireRaw(port, 'not a valid http request line at all\r\n\r\n')
  })

  await test('🔍 malformed / oversized request lines are handled without crashing', async () => {
    await fireRaw(port, 'GET ' + '/' + 'A'.repeat(100000) + ' HTTP/1.1\r\nHost: x\r\n\r\n')
    await fireRaw(port, 'GET / HTTP/9.9\r\n\r\n')
    await fireRaw(port, 'GARBAGEMETHOD / HTTP/1.1\r\n\r\n')
    await fireRaw(port, 'GET /\r\n') // truncated, no headers/terminator
  })

  await test('🔍 the beacon is still alive and correct after the barrage', async () => {
    const { status, json } = await getBeacon(port)
    assert(status === 200 && json?.app === 'redstart-nest' && Object.keys(json).length === 3, `beacon degraded after malformed traffic: ${status} ${JSON.stringify(json)}`)
  })

  stopBeaconServer(server)

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
}

main().catch(err => { console.error(err); process.exit(1) })
