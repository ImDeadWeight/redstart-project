// =============================================================================
// The server binary — what Nest looks for, and what Nest will accept
// =============================================================================
// `binaryPathRejection()` guards the value ipc/validate.mjs's own header calls
// "the head of the escalation chain": it becomes spawn()'s first argument by
// way of resolveBinary(), so anything it lets through is a process Nest starts
// on the user's machine. It had NO test coverage before Phase 8A.3 — it was
// added and then only ever exercised incidentally through the settings write
// path.
//
// It is also the check 8A.3 had to change, which is the more pressing reason
// to pin it. Windows requires a `.exe`; POSIX has no extension to require, so
// the equivalent question is whether the OS would execute the file at all. Two
// branches means two ways to be wrong, and the Windows one guards every
// install shipped so far.
//
// `platform` is an ARGUMENT to both functions rather than a read of
// process.platform, so both branches are reachable from either OS. A security
// check whose other half is untestable on the developer's machine is one that
// gets broken by someone who ran the tests and saw green.
//
// That is only MOSTLY achievable, and the exception is stated rather than
// hidden: chmod is inert on win32, so the POSIX branch's positive cases (a
// file that IS executable) cannot be staged on a Windows machine and report
// themselves as skipped there. Its refusals run everywhere.
//
// Run:  node scripts/test-server-binary.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { binaryPathRejection, serverBinaryName } from '../electron/main/ipc/validate.mjs'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-server-binary-'))

// chmod is inert on win32: Node reports 0o666 for any writable file, so
// `mode & 0o111` is zero for everything and no fixture can be staged as
// executable. The POSIX branch's POSITIVE cases therefore cannot run on a
// Windows developer's machine — they run for real on the Linux CI runner,
// which is the platform the rule exists for. Its refusals still run
// everywhere, and so does every Windows case.
const CANNOT_STAGE = 'not stageable on win32; runs on CI'

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

/** Create a real file, since the check stats the path rather than trusting it. */
function makeFile(name, { executable = false } = {}) {
  const full = path.join(tmpDir, name)
  fs.writeFileSync(full, 'not really a binary')
  fs.chmodSync(full, executable ? 0o755 : 0o644)
  return full
}

const exeFile = makeFile('llama-server.exe', { executable: true })
const posixExecutable = makeFile('llama-server', { executable: true })
const posixDataFile = makeFile('model-notes.txt')
const dirPath = path.join(tmpDir, 'a-directory')
fs.mkdirSync(dirPath)

console.log('\n-- the binary name --')

test('the name is platform-derived, not hardcoded', () => {
  assert(serverBinaryName('win32') === 'llama-server.exe', serverBinaryName('win32'))
  assert(serverBinaryName('linux') === 'llama-server', serverBinaryName('linux'))
  assert(serverBinaryName('darwin') === 'llama-server', serverBinaryName('darwin'))
})

test('the name agrees with what the validator will accept on Windows', () => {
  // The two functions are the same concern from opposite directions; if they
  // ever disagree, Nest looks for a file it would then refuse to launch.
  assert(binaryPathRejection(exeFile, 'win32') === null, 'Windows refused its own binary name')
})

console.log('\n-- shape, on every platform --')

for (const platform of ['win32', 'linux']) {
  test(`[${platform}] a non-string is refused`, () => {
    assert(binaryPathRejection(undefined, platform), 'accepted undefined')
    assert(binaryPathRejection('', platform), 'accepted an empty string')
    assert(binaryPathRejection(42, platform), 'accepted a number')
  })

  test(`[${platform}] 🔒 a relative path is refused`, () => {
    // A relative path resolves against the daemon's cwd, which is not a thing
    // the person who set it can see or predict.
    assert(binaryPathRejection('llama-server', platform), 'accepted a bare name')
    assert(binaryPathRejection('./build/llama-server', platform), 'accepted a relative path')
  })

  test(`[${platform}] 🔒 a path that does not exist is refused`, () => {
    // "one an attacker could create later" — validate.mjs's own reasoning.
    const missing = path.join(tmpDir, `nope-${platform}${platform === 'win32' ? '.exe' : ''}`)
    assert(binaryPathRejection(missing, platform), 'accepted a nonexistent path')
  })

  test(`[${platform}] 🔒 a directory is refused`, () => {
    assert(binaryPathRejection(dirPath, platform), 'accepted a directory')
  })
}

console.log('\n-- the Windows rule, unchanged by 8A.3 --')

test('🔒 Windows still requires .exe', () => {
  // The rule that guards every install shipped so far. 8A.3 made the check
  // per-platform; it must not have loosened this branch by a hair.
  const reason = binaryPathRejection(posixExecutable, 'win32')
  assert(reason, 'Windows accepted an extensionless file')
  assert(/\.exe/.test(reason), `unexpected reason: ${reason}`)
})

test('🔒 Windows refuses a .txt however executable its mode bits are', () => {
  assert(binaryPathRejection(makeFile('server.txt', { executable: true }), 'win32'),
    'Windows accepted a .txt')
})

test('Windows does NOT require an execute bit', () => {
  // Mode bits are approximated on win32 and mean little there; requiring one
  // would reject binaries that launch perfectly well.
  const plainExe = makeFile('plain.exe')
  assert(binaryPathRejection(plainExe, 'win32') === null,
    `Windows refused a non-executable-mode .exe: ${binaryPathRejection(plainExe, 'win32')}`)
})

console.log('\n-- the POSIX rule, new in 8A.3 --')

test('an extensionless executable is accepted', () => {
  if (process.platform === 'win32') return CANNOT_STAGE
  const reason = binaryPathRejection(posixExecutable, 'linux')
  assert(reason === null, `POSIX refused its own binary name: ${reason}`)
})

test('🔒 a file with no execute bit is refused', () => {
  // The POSIX equivalent of the .exe rule: there is no extension to check, so
  // the honest question is whether the OS would run it at all. A file without
  // an execute bit is a data file someone pointed at the wrong setting.
  const reason = binaryPathRejection(posixDataFile, 'linux')
  assert(reason, 'POSIX accepted a non-executable file')
  assert(/executable/i.test(reason), `unexpected reason: ${reason}`)
})

test('any execute bit counts, not specifically the owner\'s', () => {
  // Which bit applies depends on the daemon's uid and the file's owner, and
  // guessing at that here would refuse binaries that run fine.
  const groupOnly = makeFile('group-exec')
  fs.chmodSync(groupOnly, 0o610)
  const reason = binaryPathRejection(groupOnly, 'linux')
  if (process.platform === 'win32') {
    return CANNOT_STAGE
  }
  assert(reason === null, `refused a group-executable file: ${reason}`)
})

test('an extension is neither required nor forbidden on POSIX', () => {
  const oddName = makeFile('llama-server.bin', { executable: true })
  if (process.platform === 'win32') return CANNOT_STAGE
  assert(binaryPathRejection(oddName, 'linux') === null, 'POSIX rejected a valid binary over its name')
})

// ---------------------------------------------------------------------------

fs.rmSync(tmpDir, { recursive: true, force: true })

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
