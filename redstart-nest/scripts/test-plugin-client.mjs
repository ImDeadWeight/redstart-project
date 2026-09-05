// =============================================================================
// Unit tests for electron/main/mcp-plugin-client.mjs — the per-plugin stdio
// MCP client.
// =============================================================================
// The riskiest module in the plugin system (see task T6): a wrong body here
// passes a syntax check and only fails under timeout, crash, or concurrent
// load. So this suite drives scripts/fixtures/fake-mcp-server.mjs as a REAL
// child process over real stdio, through each of its controllable failure
// modes, rather than mocking the transport.
//
// mcp-plugin-client.mjs has no Electron dependency of its own (it only
// imports shared/mcp-stdio-process.mjs, which is plain Node), so this runs
// under plain node with no loader stub and no server — same posture as
// scripts/test-roles.mjs.
//
// Run:  node scripts/test-plugin-client.mjs
// =============================================================================

import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as os from 'node:os'
import * as fs from 'node:fs'
import { createPluginClient } from '../electron/main/mcp-plugin-client.mjs'
import { createStdioProcessManager } from '../../shared/mcp-stdio-process.mjs'
import { initLogger, closeLogger } from '../electron/main/logger.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(__dirname, 'fixtures', 'fake-mcp-server.mjs')

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

const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-plugin-client-test-'))

function makeClient(id, mode, opts = {}) {
  return createPluginClient({
    id,
    command: process.execPath,
    args: [FIXTURE, mode],
    env: opts.env ?? {},
    timeoutMs: opts.timeoutMs ?? 15000,
    callTimeoutMs: opts.callTimeoutMs,
    logDir,
  })
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`test itself timed out waiting on: ${label}`)), ms)),
  ])
}

// ---------------------------------------------------------------------------

console.log('\n-- normal operation --')

await test('normal: ensureReady() resolves, listTools() returns both tools', async () => {
  const client = makeClient('normal1', 'normal')
  await withTimeout(client.ensureReady(), 10000, 'ensureReady')
  const tools = await withTimeout(client.listTools(), 10000, 'listTools')
  assert(tools.length === 2, `expected 2 tools, got ${tools.length}`)
  const names = tools.map((t) => t.name).sort()
  assert(names[0] === 'echo' && names[1] === 'write_thing', `unexpected tool names: ${names.join(',')}`)
  client.stop()
  return `${tools.length} tools`
})

await test('normal: callTool() forwards a bare name and returns the result', async () => {
  const client = makeClient('normal2', 'normal')
  const result = await withTimeout(client.callTool('echo', { text: 'hi' }), 10000, 'callTool')
  assert(result?.content?.[0]?.text === 'hi', `unexpected result: ${JSON.stringify(result)}`)
  client.stop()
  return 'echoed'
})

console.log('\n-- a slow tool call is not a dead plugin --')

// The failure this section exists for, reported from real use: a plugin tool
// that installs an application ran past the client's single 15-second budget,
// the caller was told the plugin "did not respond", and the install carried on
// and SUCCEEDED unheard. The model was handed a failure it could act on, so it
// walked the user through doing the whole thing again by hand.
//
// Three things had to be true at once for that, and each gets a check here.

await test('🔍 a tools/call may outlast the handshake budget', async () => {
  // The handshake budget is short on purpose — a plugin that cannot say hello
  // quickly is broken. A tool call that takes longer than a handshake ever
  // should is ordinary, and used to be indistinguishable from a hang.
  const client = makeClient('slowclient', 'slow-call', { timeoutMs: 300, callTimeoutMs: 5000 })
  const started = Date.now()
  const result = await withTimeout(client.callTool('echo', { text: 'x' }), 8000, 'slow callTool')
  const elapsed = Date.now() - started
  assert(result, 'the call returned nothing')
  assert(elapsed > 300, `the call finished in ${elapsed}ms — the fixture should have taken ~800ms`)
  client.stop()
  return `answered in ${elapsed}ms, past a ${300}ms handshake budget`
})

await test('the handshake keeps its own short budget', async () => {
  // The other half: raising the call timeout must not make a broken plugin
  // take five seconds to be recognised as broken.
  const client = makeClient('handshakeclient', 'no-handshake', { timeoutMs: 400, callTimeoutMs: 30000 })
  const started = Date.now()
  let rejected = null
  try {
    await withTimeout(client.callTool('echo', {}), 5000, 'handshake')
  } catch (err) { rejected = err }
  const elapsed = Date.now() - started
  assert(rejected, 'a plugin that never handshakes should not resolve')
  assert(elapsed < 3000, `took ${elapsed}ms — the handshake used the call budget instead of its own`)
  client.stop()
  return `gave up in ${elapsed}ms`
})

await test('🔒 the timeout message does not claim the work failed', async () => {
  // It is a wait that was given up on, not a result. A model told "did not
  // respond" concludes the operation failed and offers to redo it, which for an
  // installer means doing it twice.
  const client = makeClient('msgclient', 'silent', { timeoutMs: 300, callTimeoutMs: 400 })
  let rejected = null
  try {
    await withTimeout(client.callTool('echo', { text: 'x' }), 4000, 'silent')
  } catch (err) { rejected = err }
  assert(rejected, 'the call did not reject')
  const msg = rejected.message
  assert(/may still be running/i.test(msg), `the message asserts failure: ${msg}`)
  assert(/duplicate|again/i.test(msg), `the message does not warn against blindly retrying: ${msg}`)
  assert(msg.includes('echo'), `the message does not name the call: ${msg}`)
  assert(msg.includes('msgclient'), `the message does not name the plugin: ${msg}`)
  client.stop()
})

await test('🔍 an answer that arrives after the timeout is recorded, not dropped', async () => {
  // The silent half of the bug. The late result cannot be delivered — the
  // caller is long gone — but a tool call that timed out and then succeeded
  // used to leave no trace anywhere, which is why nothing contradicted the
  // "it failed" the model had already been given.
  const logDirForLate = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-late-log-'))
  initLogger(logDirForLate)
  try {
    const client = makeClient('lateclient', 'slow-call', { timeoutMs: 300, callTimeoutMs: 200 })
    let rejected = null
    try {
      await withTimeout(client.callTool('echo', { text: 'x' }), 4000, 'late')
    } catch (err) { rejected = err }
    assert(rejected, 'a 200ms budget against an 800ms answer should have timed out')
    // Wait past the fixture's own delay so the late answer actually arrives.
    await new Promise(r => setTimeout(r, 1500))
    client.stop()

    const log = fs.readFileSync(path.join(logDirForLate, 'redstart.log'), 'utf8')
    const line = log.split('\n').filter(Boolean).map(l => JSON.parse(l)).find(e => e.event === 'late_response')
    assert(line, `no late_response was recorded. log was: ${log}`)
    assert(line.plugin === 'lateclient', `wrong plugin recorded: ${line.plugin}`)
    assert(line.call === 'echo', `the call was not named: ${line.call}`)
    assert(typeof line.afterMs === 'number' && line.afterMs >= 0, `no elapsed time recorded: ${line.afterMs}`)
    return `${line.call} answered ${line.afterMs}ms after it was abandoned`
  } finally {
    closeLogger()
    fs.rmSync(logDirForLate, { recursive: true, force: true })
  }
})


console.log('\n-- timeout isolation --')

await test('silent: a call rejects under the client\'s own timeout, message names the plugin', async () => {
  const client = makeClient('silentclient', 'silent', { timeoutMs: 1500 })
  const start = Date.now()
  let rejected = null
  try {
    await withTimeout(client.callTool('echo', { text: 'x' }), 3000, 'silent callTool')
  } catch (err) {
    rejected = err
  }
  const elapsed = Date.now() - start
  assert(rejected, 'the call did not reject at all')
  assert(elapsed < 3000, `took ${elapsed}ms — should reject well under 3s`)
  assert(rejected.message.includes('silentclient'), `error should name the plugin id, got: ${rejected.message}`)
  client.stop()
  return `rejected in ${elapsed}ms: ${rejected.message}`
})

await test('one plugin timing out does not block another plugin from answering', async () => {
  const slow = makeClient('slowclient', 'silent', { timeoutMs: 1500 })
  const fast = makeClient('fastclient', 'normal')

  const slowPromise = withTimeout(slow.callTool('echo', { text: 'x' }), 3000, 'slow callTool').catch((e) => e)
  // Give the slow call a moment to actually be in flight before racing the fast one.
  await new Promise((r) => setTimeout(r, 100))
  const fastResult = await withTimeout(fast.callTool('echo', { text: 'still works' }), 5000, 'fast callTool')
  assert(fastResult?.content?.[0]?.text === 'still works', 'the fast client did not answer while the slow one was hung')

  const slowOutcome = await slowPromise
  assert(slowOutcome instanceof Error, 'the slow client eventually should have rejected too')

  slow.stop()
  fast.stop()
  return 'fast client unaffected by the hung one'
})

console.log('\n-- child exit mid-request --')

await test('exit-on-call: the in-flight call rejects with "exited", nothing left unsettled', async () => {
  const client = makeClient('exitonclient', 'exit-on-call')
  let rejected = null
  try {
    await withTimeout(client.callTool('echo', { text: 'x' }), 10000, 'exit-on-call callTool')
  } catch (err) {
    rejected = err
  }
  assert(rejected, 'the call did not reject')
  assert(rejected.message.includes('exited'), `error should mention "exited", got: ${rejected.message}`)
  client.stop()
  return rejected.message
})

console.log('\n-- deliberate stop --')

await test('stop() kills the child and rejects everything in flight', async () => {
  const client = makeClient('stopclient', 'silent', { timeoutMs: 30000 })
  await withTimeout(client.ensureReady(), 10000, 'ensureReady')
  const callPromise = client.callTool('echo', { text: 'x' }).catch((e) => e)
  await new Promise((r) => setTimeout(r, 200)) // let the call actually land in pending
  client.stop()
  const outcome = await withTimeout(callPromise, 5000, 'call after stop()')
  assert(outcome instanceof Error, 'stop() did not reject the in-flight call')
  assert(!client.isRunning(), 'client reports running after stop()')
  return outcome.message
})

console.log('\n-- env allowlist (Trap 7 / T5) --')

await test('env-echo: the parent secret does not leak, but PATH survives', async () => {
  process.env.REDSTART_SECRET_CANARY = 'leaked'
  try {
    const client = makeClient('envechoclient', 'env-echo')
    const result = await withTimeout(client.callTool('anything', {}), 10000, 'env-echo callTool')
    const text = result?.content?.[0]?.text
    const parsed = JSON.parse(text)
    assert(parsed.REDSTART_SECRET_CANARY === null, `parent secret leaked into the plugin child: ${text}`)
    assert(parsed.PATH === 'present', `PATH was not passed through — this is a broken spawn, not a secure one: ${text}`)
    client.stop()
    return text
  } finally {
    delete process.env.REDSTART_SECRET_CANARY
  }
})

console.log('\n-- D3: the child\'s own readOnlyHint is never trusted here --')

await test('write_thing declares readOnlyHint:true, but the client does no classification at all', async () => {
  const client = makeClient('classclient', 'normal')
  const tools = await withTimeout(client.listTools(), 10000, 'listTools')
  const writeThing = tools.find((t) => t.name === 'write_thing')
  assert(writeThing, 'write_thing missing from listTools()')
  assert(writeThing.annotations?.readOnlyHint === true, 'fixture stopped declaring readOnlyHint — test fixture drifted')
  // The client is pure transport: it must not have derived, added, or
  // interpreted a "class" field from that hint. Classification is an admin
  // decision made at install time (plan decision D3/D-b), not something this
  // module infers from what the child claims about itself.
  assert(!('class' in writeThing), 'the client attached a class derived from the child\'s own hint — D3 violation')
  client.stop()
  return 'readOnlyHint present, no class derived from it'
})

console.log('\n-- Trap 8: Twig\'s default spawn env is unchanged --')

await test('a config with no inheritEnv still inherits the full parent environment (default unchanged)', async () => {
  // mcp-plugin-client.mjs always spawns with inheritEnv:false — this test
  // exercises the shared supervisor directly, exactly as redstart-twig's own
  // servers use it, to prove T5's opt-in flag left the default byte-identical.
  process.env.REDSTART_SECRET_CANARY = 'should-be-inherited-by-default'
  try {
    const lines = []
    const gotExit = new Promise((resolve) => {
      const manager = createStdioProcessManager({
        logDir,
        onMessage: (_id, line) => lines.push(line),
        onExit: () => resolve(),
      })
      const res = manager.start('twiglikeclient', {
        command: process.execPath,
        args: [FIXTURE, 'env-echo'],
        shell: false,
        // No inheritEnv field at all — the default path.
      })
      assert(res.ok, `spawn failed: ${res.error}`)
      // Drive one tools/call so the fixture echoes back what it saw.
      manager.send('twiglikeclient', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))
      setTimeout(() => {
        manager.send('twiglikeclient', JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'anything', arguments: {} } }))
        setTimeout(() => { manager.stop('twiglikeclient') }, 500)
      }, 300)
    })
    await withTimeout(gotExit, 10000, 'twig-like spawn')
    const callLine = lines.find((l) => l.includes('REDSTART_SECRET_CANARY'))
    assert(callLine, `no tools/call response observed; lines: ${JSON.stringify(lines)}`)
    const parsed = JSON.parse(JSON.parse(callLine).result.content[0].text)
    assert(parsed.REDSTART_SECRET_CANARY === 'should-be-inherited-by-default', 'default spawn no longer inherits the parent environment — Twig would break')
    return 'default inheritance intact'
  } finally {
    delete process.env.REDSTART_SECRET_CANARY
  }
})

// ---------------------------------------------------------------------------

fs.rmSync(logDir, { recursive: true, force: true })

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
