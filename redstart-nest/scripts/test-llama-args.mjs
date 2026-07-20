// =============================================================================
// Invariant tests for electron/main/llama-args.mjs — llama-server is
// localhost-only.
// =============================================================================
// The headline Priority-9 architecture invariant: the raw, unauthenticated
// llama.cpp inference server must NEVER be bound to a network-reachable address.
// LAN exposure is owned solely by the gateway (tools-gateway.mjs), which sits
// behind the auth gate and proxies to llama-server on a private +1 port. If a
// future change ever wires --host to a config field (e.g. a "network mode"
// toggle), these tests fail loudly.
//
// buildArgs() was extracted out of electron/main/index.mjs specifically so this
// invariant can be exercised without booting Electron. The only Electron touch
// is app.isPackaged (read to pick the chat-ui path), stubbed by
// auth-test-loader.mjs the same way the other suites stub 'electron'.
//
// Run:  node scripts/test-llama-args.mjs
// =============================================================================

import { register } from 'node:module'

register('./auth-test-loader.mjs', import.meta.url)

const { buildArgs } = await import('../electron/main/llama-args.mjs')

// ---------------------------------------------------------------------------
// Harness (mirrors scripts/test-path-scope.mjs)
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

// Value that follows a given flag in an argv array (e.g. flagValue(args, '--host')).
function flagValue(args, flag) {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}

function count(args, flag) {
  return args.filter(a => a === flag).length
}

const baseConfig = {
  modelPath: 'C:\\models\\model.gguf',
  ctxSize: 8192,
  batchSize: 512,
  threads: 8,
  port: 1917,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('\n-- llama-server localhost-only invariant --')

await test('🔍 --host is 127.0.0.1 for a default config', async () => {
  const args = buildArgs(baseConfig)
  assert(flagValue(args, '--host') === '127.0.0.1', `--host was ${flagValue(args, '--host')}`)
  assert(count(args, '--host') === 1, `expected exactly one --host, got ${count(args, '--host')}`)
})

await test('🔍 --host stays 127.0.0.1 no matter what config fields are set, incl. spoofed host/networkMode', async () => {
  // Throw every field the builder reads, plus fields it must NOT honor for the
  // bind address (host / networkMode / bindHost), across raw and quoted modes.
  const hostileConfigs = [
    { ...baseConfig, networkMode: '0.0.0.0' },
    { ...baseConfig, networkMode: 'network', host: '0.0.0.0' },
    { ...baseConfig, host: '0.0.0.0', bindHost: '0.0.0.0' },
    { ...baseConfig, gpuLayers: 40, nCpuMoe: 12, priority: 'high', noMmap: true, kvCache: 'aggressive' },
    { ...baseConfig, chatTemplateFile: 'C:\\t.jinja', chatTemplate: 'chatml' },
  ]
  for (const cfg of hostileConfigs) {
    for (const raw of [false, true]) {
      const args = buildArgs(cfg, raw)
      assert(flagValue(args, '--host') === '127.0.0.1', `--host was ${flagValue(args, '--host')} for ${JSON.stringify(cfg)} (raw=${raw})`)
      assert(count(args, '--host') === 1, `duplicate --host for ${JSON.stringify(cfg)}`)
    }
  }
})

await test('🔍 no argv token is a wildcard/LAN bind address (0.0.0.0 / ::) — structured config only', async () => {
  const args = buildArgs({ ...baseConfig, gpuLayers: 40, nCpuMoe: 12, priority: 'high', noMmap: true, kvCache: 'balanced' })
  for (const tok of args) {
    assert(tok !== '0.0.0.0' && tok !== '::' && tok !== '[::]', `wildcard bind address leaked into argv: ${tok}`)
  }
})

await test('🔍 llama-server runs on the private +1 port (gateway owns the public port)', async () => {
  const args = buildArgs({ ...baseConfig, port: 1917 })
  assert(flagValue(args, '--port') === '1918', `--port was ${flagValue(args, '--port')}, expected 1918`)
})

await test('base config always includes --jinja (native tool-calling) and the model path', async () => {
  const args = buildArgs(baseConfig)
  assert(args.includes('--jinja'), 'missing --jinja')
  assert(flagValue(args, '-m') === '"C:\\models\\model.gguf"', `unexpected -m value: ${flagValue(args, '-m')}`)
})

// additionalArgs (the advanced-user free-text field) passes through, EXCEPT a
// --host override, which is stripped so it cannot defeat the localhost bind.
await test('additionalArgs passes through (non-host flags preserved)', async () => {
  const args = buildArgs({ ...baseConfig, additionalArgs: '--foo bar --baz' })
  const joined = args.join(' ')
  assert(joined.endsWith('--foo bar --baz'), `additionalArgs not appended: ${joined}`)
})

await test('🔍 a --host override in additionalArgs is stripped (cannot defeat localhost bind)', async () => {
  for (const inject of ['--host 0.0.0.0', '--host=0.0.0.0', '-ngl 40 --host 0.0.0.0 --foo bar', '--foo x --host=:: --baz']) {
    const args = buildArgs({ ...baseConfig, additionalArgs: inject })
    assert(flagValue(args, '--host') === '127.0.0.1', `--host became ${flagValue(args, '--host')} via additionalArgs "${inject}"`)
    assert(count(args, '--host') === 1, `duplicate --host from additionalArgs "${inject}": ${args.filter(a => a === '--host').length}`)
    for (const tok of args) {
      assert(tok !== '0.0.0.0' && tok !== '::' && tok !== '[::]', `wildcard bind leaked via additionalArgs "${inject}": ${tok}`)
    }
  }
})

await test('non-host flags survive alongside a stripped --host override', async () => {
  const args = buildArgs({ ...baseConfig, additionalArgs: '-ngl 40 --host 0.0.0.0 --foo bar' })
  const joined = args.join(' ')
  assert(joined.includes('-ngl 40') && joined.includes('--foo bar'), `legit additionalArgs lost: ${joined}`)
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
