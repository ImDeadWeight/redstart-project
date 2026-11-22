// =============================================================================
// Unit tests for daemon/network.mjs's scan: bounded concurrency and the
// subnet it picks.
// =============================================================================
// The two bugs this guards:
//   - all 254 probes opened at once. macOS allows a process 256 open files by
//     default, so most failed with EMFILE and the scan found nothing.
//   - the subnet came from the FIRST non-internal IPv4, so a VPN, WSL or
//     Docker adapter sent the scan to the wrong network.
//
// Run:  node scripts/test-network-scan.mjs
// =============================================================================

import { runLimited, SCAN_CONCURRENCY, handlers } from '../daemon/network.mjs'

const results = []
async function test(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}
function assert(cond, message) { if (!cond) throw new Error(message) }

await test('runLimited never has more than the limit in flight, and runs every item', async () => {
  let inFlight = 0
  let peak = 0
  const seen = []
  const items = Array.from({ length: 255 }, (_, i) => i)
  await runLimited(items, SCAN_CONCURRENCY, async (i) => {
    inFlight++
    peak = Math.max(peak, inFlight)
    await new Promise((r) => setTimeout(r, 1))
    seen.push(i)
    inFlight--
  })
  assert(peak <= SCAN_CONCURRENCY, `peak was ${peak}`)
  assert(seen.length === 255, `ran ${seen.length} of 255`)
  return `peak ${peak}`
})

await test('SCAN_CONCURRENCY stays well under the macOS default open-file limit (256)', () => {
  assert(SCAN_CONCURRENCY > 0 && SCAN_CONCURRENCY <= 64, String(SCAN_CONCURRENCY))
})

await test('network:get-info answers a three-octet subnet or a clear error, never a loopback subnet', async () => {
  try {
    const info = await handlers['network:get-info']()
    assert(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(info.subnet), JSON.stringify(info))
    assert(!info.subnet.startsWith('127.'), 'scanned loopback')
    return `${info.ip} -> ${info.subnet}.0/24`
  } catch (err) {
    assert(/No active network interface/.test(err.message), err.message)
    return 'no adapter in this environment'
  }
})

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
