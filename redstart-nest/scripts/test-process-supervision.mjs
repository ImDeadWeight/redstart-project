// =============================================================================
// Process supervision — reap by PID, never by name.
// =============================================================================
// killOrphanedServers() used to run `taskkill /F /IM llama-server.exe` at every
// startup and quit, killing every llama-server on the machine — including one
// started in a terminal for unrelated work. process-supervision.mjs replaces it
// with PID tracking: a startup reap only ever acts on the specific pid Nest
// itself recorded, and only after verifying the live process at that pid still
// looks like the binary that was launched.
//
// The security-critical property is the refusal, not the reap: PID reuse is
// real, and killing a recycled pid on nothing more than a matching number would
// be the exact class of bug being fixed here. These tests exercise that refusal
// against a real, currently-running process (this very script), which is the
// only thing that can be relied on to exist without spawning a fake
// llama-server binary.
//
// Run:  node scripts/test-process-supervision.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  writePidFile,
  readPidFile,
  deletePidFile,
  isLikelyOurProcess,
  reapStaleProcess,
} from '../electron/main/process-supervision.mjs'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-proc-sup-'))

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

console.log('\n-- pid file round trip --')

await test('writePidFile then readPidFile returns what was written', () => {
  writePidFile(tmpDir, { pid: 4242, binaryPath: 'C:\\fake\\llama-server.exe', startedAt: 123 })
  const record = readPidFile(tmpDir)
  assert(record?.pid === 4242, `expected pid 4242, got ${JSON.stringify(record)}`)
  assert(record.binaryPath === 'C:\\fake\\llama-server.exe', 'binaryPath round-tripped')
  deletePidFile(tmpDir)
})

await test('readPidFile on a missing file returns null, not a throw', () => {
  const record = readPidFile(tmpDir)
  assert(record === null, `expected null, got ${JSON.stringify(record)}`)
})

await test('readPidFile on a malformed pid file returns null (torn write, same shape as json-store)', () => {
  fs.writeFileSync(path.join(tmpDir, 'llama-server.pid'), '{not json')
  const record = readPidFile(tmpDir)
  assert(record === null, `expected null on corrupt file, got ${JSON.stringify(record)}`)
  deletePidFile(tmpDir)
})

await test('deletePidFile on an already-absent file does not throw', () => {
  deletePidFile(tmpDir) // no file present at this point
})

console.log('\n-- 🔍 the refusal: verify before kill --')

await test('🔍 a live pid with the WRONG expected binary name is refused', async () => {
  // process.pid is this very script — genuinely alive, so a name check is the
  // only thing standing between this test and killing itself.
  const isMatch = await isLikelyOurProcess(process.pid, '/definitely/not/this/process/name-xyz')
  assert(isMatch === false, 'expected refusal on a name mismatch, got a match')
})

await test('🔍 a pid that does not exist at all is refused, not treated as a match', async () => {
  // A pid vanishingly unlikely to be assigned to anything right now.
  const isMatch = await isLikelyOurProcess(999999, 'llama-server.exe')
  assert(isMatch === false, 'expected refusal for a nonexistent pid')
})

console.log('\n-- reapStaleProcess: end to end --')

await test('no pid file present: no-op, does not throw', async () => {
  await reapStaleProcess(tmpDir)
})

await test('🔍 a pid file naming the WRONG binary for a live pid is cleared but nothing is killed', async () => {
  // This process is alive (process.pid), but the recorded binary name will
  // never match "node" (or node.exe), so reapStaleProcess must not act on it —
  // and this test process must still be alive after the call to prove it.
  writePidFile(tmpDir, {
    pid: process.pid,
    binaryPath: '/not/actually/llama-server.exe',
    startedAt: Date.now(),
  })
  await reapStaleProcess(tmpDir)
  assert(readPidFile(tmpDir) === null, 'pid file should be cleared regardless of outcome')
  // If reapStaleProcess had matched and killed, this line would never run.
  assert(process.pid > 0, 'this process must still be alive')
})

await test('a pid file for a process that no longer exists is cleared without error', async () => {
  writePidFile(tmpDir, { pid: 999999, binaryPath: 'llama-server.exe', startedAt: Date.now() })
  await reapStaleProcess(tmpDir)
  assert(readPidFile(tmpDir) === null, 'pid file should be cleared')
})

console.log('\n' + '='.repeat(60))
const passed = results.filter(r => r.pass).length
console.log(`${passed}/${results.length} passed`)
console.log('='.repeat(60) + '\n')

fs.rmSync(tmpDir, { recursive: true, force: true })

if (passed !== results.length) process.exit(1)
