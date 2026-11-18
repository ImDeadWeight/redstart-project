// =============================================================================
// shared/command-exec.mjs: one program, an argument list, no shell
// (agent-runtime plan D15, D17, D18, D21).
// =============================================================================
// The first test is the one the plan names (D17): an argument list that a
// shell would read as two commands reaches the child as plain arguments. The
// child is this machine's own node, printing its argv as JSON, so the check is
// exact and needs no other program.
//
// Then: a Windows batch file is refused, the environment carries nothing of
// the host's, a timeout kills the whole tree (a grandchild included), the
// output cap keeps the head and the tail, an abort stops the run.
//
// Run:  node scripts/test-command-exec.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { runCommand, buildEnv, HeadTail, isShellShim } from '../../shared/command-exec.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-cmd-exec-'))
const node = process.execPath
const nodeDir = path.dirname(node)

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

function script(name, body) {
  const file = path.join(tmp, name)
  fs.writeFileSync(file, body)
  return file
}
const env = () => buildEnv({ pathDirs: [nodeDir], home: tmp })
const run = (args, extra = {}) => runCommand({ file: node, args, cwd: tmp, env: env(), timeoutMs: 20_000, ...extra })

const printArgv = script('argv.mjs', 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')

console.log('\ncommand-exec\n')

await test('shell metacharacters in arguments are never interpreted (D17)', async () => {
  const hostile = [
    '--version & echo INJECTED',
    'a | echo INJECTED',
    'a; echo INJECTED',
    '$(echo INJECTED)',
    '`echo INJECTED`',
    '%PATH%',
    '$HOME',
    '"quoted" \'single\'',
    'a && echo INJECTED',
    '> out.txt',
    '^& echo INJECTED',
    '',
  ]
  const r = await run([printArgv, ...hostile])
  assert(r.ok, `refused: ${r.reason}`)
  assert(r.exitCode === 0, `exit ${r.exitCode}: ${r.stderr}`)
  const got = JSON.parse(r.stdout)
  assert(JSON.stringify(got) === JSON.stringify(hostile), `argv changed: ${r.stdout}`)
  assert(!fs.existsSync(path.join(tmp, 'out.txt')), 'a redirection ran')
  return `${hostile.length} arguments, byte for byte`
})

await test('prefixArgs go first and are not the caller\'s to change', async () => {
  const r = await runCommand({ file: node, prefixArgs: [printArgv], args: ['x'], cwd: tmp, env: env(), timeoutMs: 20_000 })
  assert(r.ok && JSON.parse(r.stdout).join(',') === 'x', `got ${r.ok ? r.stdout : r.reason}`)
})

await test('a Windows .cmd or .bat file is refused before anything spawns', async () => {
  assert(isShellShim('C:\\x\\npm.cmd', 'win32') && isShellShim('C:\\x\\a.BAT', 'win32'), 'not recognised')
  assert(!isShellShim('/usr/bin/npm.cmd', 'linux'), 'a .cmd name on POSIX is an ordinary file')
  const shim = path.join(tmp, 'evil.cmd')
  fs.writeFileSync(shim, '@echo INJECTED\r\n')
  const r = await runCommand({ file: shim, args: [], cwd: tmp, env: env(), timeoutMs: 5000, platform: 'win32' })
  assert(!r.ok && /batch file/.test(r.reason), `not refused: ${JSON.stringify(r)}`)
})

await test('a relative program path is refused (PATH is never searched here)', async () => {
  const r = await runCommand({ file: 'node', args: ['-v'], cwd: tmp, env: env(), timeoutMs: 5000 })
  assert(!r.ok && /absolute/.test(r.reason), JSON.stringify(r))
})

await test('isolation other than "none" is refused (D20)', async () => {
  const r = await run(['-v'], { isolation: 'container' })
  assert(!r.ok && /only mode/.test(r.reason), JSON.stringify(r))
})

await test('the environment is built from nothing (D18)', async () => {
  process.env.REDSTART_TEST_SECRET = 'do-not-leak'
  try {
    const dump = script('env.mjs', 'process.stdout.write(JSON.stringify(process.env))\n')
    const r = await run([dump])
    assert(r.ok && r.exitCode === 0, `run failed: ${r.reason ?? r.stderr}`)
    const childEnv = JSON.parse(r.stdout)
    assert(!('REDSTART_TEST_SECRET' in childEnv), 'a host variable reached the child')
    const pathKey = Object.keys(childEnv).find((k) => k.toUpperCase() === 'PATH')
    assert(childEnv[pathKey] === nodeDir, `PATH is ${childEnv[pathKey]}`)
    assert(childEnv.HOME === tmp && childEnv.TEMP === tmp, 'HOME/TEMP not the given folder')
    const allowed = new Set(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'PATHEXT', 'COMSPEC', 'LANG',
      'SYSTEMDRIVE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN', 'LOGONSERVER'])
    const extra = Object.keys(childEnv).filter((k) => !allowed.has(k.toUpperCase()))
    assert(extra.length === 0, `unexpected variables: ${extra.join(', ')}`)
    if (process.platform === 'win32') {
      // libuv fills these from the parent when absent; buildEnv sets them so it cannot.
      assert(childEnv.USERNAME === '' || childEnv.USERNAME === undefined, `USERNAME leaked: ${childEnv.USERNAME}`)
      assert(`${childEnv.HOMEDRIVE}${childEnv.HOMEPATH}`.toLowerCase() === tmp.toLowerCase(), `HOMEDRIVE+HOMEPATH is ${childEnv.HOMEDRIVE}${childEnv.HOMEPATH}`)
    }
    return `${Object.keys(childEnv).length} variables`
  } finally {
    delete process.env.REDSTART_TEST_SECRET
  }
})

await test('buildEnv on Windows keeps only the system variables it names', () => {
  const e = buildEnv({ pathDirs: ['C:\\Git\\cmd', 'C:\\Git\\cmd'], home: 'C:\\w\\.home', platform: 'win32',
    hostEnv: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', PATHEXT: '.EXE', ComSpec: 'C:\\Windows\\cmd.exe', GITHUB_TOKEN: 'x', APPDATA: 'C:\\u' } })
  assert(e.PATH === 'C:\\Git\\cmd', `PATH ${e.PATH}`)
  assert(e.SYSTEMROOT === 'C:\\Windows' && e.COMSPEC === 'C:\\Windows\\cmd.exe', 'system variables missing')
  assert(!('GITHUB_TOKEN' in e) && !('APPDATA' in e), 'host variables copied')
  assert(e.USERPROFILE === 'C:\\w\\.home', 'USERPROFILE not the home folder')
})

await test('a non-zero exit is reported with its code and both streams', async () => {
  const fail = script('fail.mjs', 'console.log("out line"); console.error("config missing"); process.exit(3)\n')
  const r = await run([fail])
  assert(r.ok && r.exitCode === 3, `exit ${r.exitCode}`)
  assert(r.stdout.includes('out line') && r.stderr.includes('config missing'), 'a stream was lost')
  assert(!r.timedOut && !r.aborted, 'flagged as stopped')
})

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}
async function gone(pid, ms = 5000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (!alive(pid)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return !alive(pid)
}

await test('a timeout kills the whole tree, grandchild included', async () => {
  const parent = script('tree.mjs', [
    "import { spawn } from 'node:child_process'",
    "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
    "process.stdout.write(String(g.pid) + '\\n')",
    'setInterval(() => {}, 1000)',
  ].join('\n'))
  const t0 = Date.now()
  const r = await run([parent], { timeoutMs: 1500 })
  assert(r.ok && r.timedOut, `not timed out: ${JSON.stringify(r)}`)
  assert(Date.now() - t0 < 10_000, 'the run did not end promptly')
  const grandchild = Number.parseInt(r.stdout, 10)
  assert(Number.isInteger(grandchild), `no grandchild pid in ${JSON.stringify(r.stdout)}`)
  assert(await gone(grandchild), `grandchild ${grandchild} is still running`)
  return `ended after ${r.durationMs} ms, grandchild ${grandchild} gone`
})

await test('an abort stops the run and kills it', async () => {
  const sleeper = script('sleep.mjs', 'setInterval(() => {}, 1000)\n')
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 300)
  const r = await run([sleeper], { signal: ac.signal })
  assert(r.ok && r.aborted && !r.timedOut, JSON.stringify(r))
})

await test('an already-aborted signal starts nothing', async () => {
  const ac = new AbortController()
  ac.abort()
  const r = await run(['-v'], { signal: ac.signal })
  assert(!r.ok, 'it ran')
})

await test('the output cap keeps the head and the tail and counts the rest', async () => {
  const loud = script('loud.mjs', "process.stdout.write('START' + 'x'.repeat(200000) + 'END')\n")
  const r = await run([loud], { outputCap: 1000 })
  assert(r.ok && r.exitCode === 0, JSON.stringify(r))
  assert(r.stdout.startsWith('START') && r.stdout.endsWith('END'), 'head or tail lost')
  assert(r.stdoutDropped === 200008 - 1000, `dropped ${r.stdoutDropped}`)
  assert(r.stdout.includes('bytes not shown'), 'no marker')
  return `${r.stdout.length} characters kept`
})

await test('HeadTail keeps everything under the cap and splits exactly at it', () => {
  const small = new HeadTail(10)
  small.push(Buffer.from('abc'))
  small.push(Buffer.from('def'))
  assert(small.text() === 'abcdef' && small.dropped === 0, small.text())
  const big = new HeadTail(10)
  for (const c of 'abcdefghijklmnopqrstuvwxyz') big.push(Buffer.from(c))
  assert(big.text() === 'abcde\n[... 16 bytes not shown ...]\nvwxyz', JSON.stringify(big.text()))
})

await test('a missing program is a refusal with the path, not a throw', async () => {
  const r = await runCommand({ file: path.join(tmp, 'no-such-program.exe'), args: [], cwd: tmp, env: env(), timeoutMs: 5000 })
  assert(!r.ok && /not found|Could not start/.test(r.reason), JSON.stringify(r))
})

console.log('\n' + '='.repeat(60))
const passed = results.filter((r) => r.pass).length
console.log(`${passed}/${results.length} passed`)
console.log('='.repeat(60) + '\n')
fs.rmSync(tmp, { recursive: true, force: true })
if (passed !== results.length) process.exit(1)
