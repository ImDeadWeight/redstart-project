// =============================================================================
// The daemon's own pid file — how a person stops it without Task Manager
// =============================================================================
// process-supervision.mjs records the llama-server CHILD's pid so a crashed
// Nest can reap it next time. This is the other one: the daemon's own pid, so
// `npm run daemon:stop` has something to signal and `daemon:status` can answer
// "is it running" without probing a port and guessing what replied.
//
// The interesting cases are all the ones where the file is LYING. It survives
// a hard kill, an OOM and a power loss — the same gap process-supervision.mjs
// was built around — so every reader has to treat it as a claim to verify
// rather than a fact. Pid reuse is real: after enough process churn the
// recorded number belongs to something else entirely, and signalling on a
// number alone is precisely the bug that module exists to have removed.
//
// Run:  node scripts/test-daemon-pidfile.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  writeDaemonPid, readDaemonPid, clearDaemonPid, daemonStatus, DAEMON_PID_FILE,
} from '../electron/main/daemon-pidfile.mjs'
import { resolveNestDir, configDirFor } from '../bin/nest-dir.mjs'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-daemonpid-'))

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

let n = 0
function newDir(name) {
  const dir = path.join(tmpRoot, `${++n}-${name}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

console.log('\n-- the nest directory, resolved identically everywhere --')

await test('🔍 --dir, then the environment, then a home default', () => {
  // nestd starts in a directory and daemon-stop has to find the SAME one. Two
  // copies of this order would eventually disagree, and the symptom would be
  // "stop says nothing is running" about a daemon that plainly is.
  assert(resolveNestDir(['--dir', 'somewhere'], {}) === path.resolve('somewhere'), 'flag ignored')
  assert(resolveNestDir([], { REDSTART_DIR: 'from-env' }) === path.resolve('from-env'), 'env ignored')
  const fallback = resolveNestDir([], {})
  assert(fallback === path.join(os.homedir(), '.redstart'), `unexpected default: ${fallback}`)
  // The flag wins over the environment — otherwise `npm run daemon:stop` in a
  // shell that happens to export REDSTART_DIR would target the wrong install.
  assert(resolveNestDir(['--dir', 'flag'], { REDSTART_DIR: 'env' }) === path.resolve('flag'),
    'the environment beat an explicit flag')
})

await test('--dir with no value is refused rather than swallowing the next flag', () => {
  let threw = null
  try { resolveNestDir(['--dir', '--status'], {}) } catch (err) { threw = err }
  assert(threw, 'resolved a directory called "--status"')
})

await test('config lives in a subtree of the nest directory', () => {
  assert(configDirFor('/nest') === path.join('/nest', 'config'), configDirFor('/nest'))
})

console.log('\n-- writing and reading --')

await test('round-trips the pid, the executable and the start time', () => {
  const dir = newDir('roundtrip')
  assert(writeDaemonPid(dir) === true, 'write reported failure')
  const read = readDaemonPid(dir)
  assert(read.pid === process.pid, `recorded ${read.pid}, expected ${process.pid}`)
  assert(read.execPath === process.execPath, 'execPath not recorded')
  assert(typeof read.startedAt === 'number', 'startedAt not recorded')
})

await test('🔒 the executable is recorded, not just the number', () => {
  // Without it there is no way to tell "the daemon" from "whatever inherited
  // this pid after a reboot", and the stop script would signal a stranger.
  const dir = newDir('execpath')
  writeDaemonPid(dir)
  assert(readDaemonPid(dir).execPath, 'no execPath to verify identity against')
})

await test('a missing, empty or malformed file reads as nothing', () => {
  const dir = newDir('malformed')
  assert(readDaemonPid(dir) === null, 'a missing file produced a record')
  fs.writeFileSync(path.join(dir, DAEMON_PID_FILE), '')
  assert(readDaemonPid(dir) === null, 'an empty file produced a record')
  fs.writeFileSync(path.join(dir, DAEMON_PID_FILE), '{"pid":"not a number"}')
  assert(readDaemonPid(dir) === null, 'a wrong-typed pid produced a record')
  fs.writeFileSync(path.join(dir, DAEMON_PID_FILE), '{"pid":123}')
  assert(readDaemonPid(dir) === null, 'a record with no execPath was accepted')
})

await test('writing to an unwritable directory is survivable, not fatal', () => {
  // The daemon works fine without this file; what is lost is the scripted
  // stop, not the service. It must never be a reason to refuse to run.
  const missing = path.join(tmpRoot, 'does', 'not', 'exist')
  assert(writeDaemonPid(missing) === false, 'reported success writing into a missing tree')
})

await test('clearing is idempotent', () => {
  const dir = newDir('clear')
  writeDaemonPid(dir)
  clearDaemonPid(dir)
  clearDaemonPid(dir) // must not throw on the second pass — cleanup paths run twice
  assert(readDaemonPid(dir) === null, 'the file survived clearing')
})

console.log('\n-- status, which is where the lying happens --')

await test('no file at all reads as stopped', async () => {
  assert((await daemonStatus(newDir('none'))).state === 'stopped', 'invented a daemon')
})

await test('🔍 this very process reads as running', async () => {
  // The positive case has to be real: the pid is this test's own, and
  // isLikelyOurProcess() confirms it by image name (node/electron), so this
  // exercises the platform query rather than mocking it.
  const dir = newDir('running')
  writeDaemonPid(dir)
  const status = await daemonStatus(dir)
  assert(status.state === 'running', `expected running, got ${status.state}`)
  assert(status.pid === process.pid, 'reported someone else')
})

await test('🔒 a pid that is gone reads as stale, not as running', async () => {
  // What a hard kill leaves behind. Expected, not exceptional — and it must
  // not be reported as an error, or the ordinary "Task Manager killed it"
  // recovery looks like a fault.
  const dir = newDir('stale')
  // A pid that cannot be live: 0 is not addressable, and a very high number is
  // beyond the platform's range. Use an unallocated high pid and confirm.
  const deadPid = 0x7ffffffe
  fs.writeFileSync(path.join(dir, DAEMON_PID_FILE),
    JSON.stringify({ pid: deadPid, execPath: process.execPath, startedAt: Date.now() }))
  const status = await daemonStatus(dir)
  assert(status.state === 'stale', `expected stale, got ${status.state}`)
})

await test('🔒 a live pid that is NOT ours reads as unknown, never as running', async () => {
  // Pid reuse, staged directly: a live process (this one) recorded against a
  // different executable. The stop script refuses to signal on `unknown`,
  // which is the whole reason the state exists rather than collapsing into a
  // boolean — killing on a matching number alone is the class of bug
  // process-supervision.mjs was written to remove.
  const dir = newDir('reused')
  fs.writeFileSync(path.join(dir, DAEMON_PID_FILE), JSON.stringify({
    pid: process.pid,
    execPath: path.join(path.dirname(process.execPath), 'something-else-entirely.exe'),
    startedAt: Date.now(),
  }))
  const status = await daemonStatus(dir)
  assert(status.state === 'unknown', `expected unknown, got ${status.state} — it would have been signalled`)
})

// ---------------------------------------------------------------------------

fs.rmSync(tmpRoot, { recursive: true, force: true })

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
