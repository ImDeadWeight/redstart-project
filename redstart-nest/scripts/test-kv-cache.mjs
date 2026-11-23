// =============================================================================
// Tests for daemon/kv-cache.mjs — "Memory saving" presets become cache types
// the running llama-server actually accepts.
// =============================================================================
// The bundled engine is upstream llama.cpp, which has no turbo* cache types; a
// TurboQuant+ binary chosen as a custom path does. A preset mapped to a type the
// binary lacks stops llama-server at startup ("Unsupported cache type"), so the
// mapping is decided from the binary's own --help, and these tests pin both
// help formats (taken from each project's common/arg.cpp) and the fallbacks.
//
// Run:  node scripts/test-kv-cache.mjs
// =============================================================================

import { initPaths } from '../daemon/platform-paths.mjs'

initPaths({ config: 'unused-by-kv-cache/config', capabilityBase: 'unused-by-kv-cache/data', isPackaged: false })

const {
  KV_CACHE_PRESETS, parseCacheTypes, kvCacheTypes, resolveKvCache, probeCacheTypes, clearCacheTypeProbes,
} = await import('../daemon/kv-cache.mjs')
const { buildArgs } = await import('../daemon/llama-args.mjs')

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

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

function flagValue(args, flag) {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}

// The -ctk/-ctv entries as each project's llama-server --help prints them.
const UPSTREAM_HELP = [
  '-fa,   --flash-attn [on|off|auto]      set Flash Attention use (\'on\', \'off\', or \'auto\', default: \'auto\')',
  '-ctk,  --cache-type-k TYPE             KV cache data type for K',
  '                                       allowed values: f32, f16, bf16, f8_e4m3, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1',
  '                                       (default: f16)',
  '                                       (env: LLAMA_ARG_CACHE_TYPE_K)',
  '-ctv,  --cache-type-v TYPE             KV cache data type for V',
  '                                       allowed values: f32, f16, bf16, f8_e4m3, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1',
  '                                       (default: f16)',
  '                                       (env: LLAMA_ARG_CACHE_TYPE_V)',
  '-dt,   --defrag-thold N                KV cache defragmentation threshold (DEPRECATED)',
].join('\n')
const TURBO_HELP = UPSTREAM_HELP.replace(/q5_1\n/g, 'q5_1, turbo2, turbo3, turbo4\n')

const base = { modelPath: '/m/model.gguf', ctxSize: 8192, batchSize: 512, threads: 8, port: 1917 }

console.log('\n-- parsing llama-server --help --')

await test('upstream help: the V list is read, and has no turbo types', async () => {
  const t = parseCacheTypes(UPSTREAM_HELP)
  assert(t && t.has('q8_0') && t.has('q4_0') && t.has('q5_1'), `parsed ${t && [...t]}`)
  assert(!t.has('turbo3'), 'turbo3 in an upstream list')
  return [...t].join(',')
})

await test('TurboQuant+ help: turbo2/3/4 are read', async () => {
  const t = parseCacheTypes(TURBO_HELP)
  assert(t && ['turbo2', 'turbo3', 'turbo4', 'q8_0'].every(x => t.has(x)), `parsed ${t && [...t]}`)
})

await test('Windows line endings parse the same', async () => {
  const t = parseCacheTypes(TURBO_HELP.replace(/\n/g, '\r\n'))
  assert(t && t.has('turbo3') && !t.has('turbo4\r'), `parsed ${t && [...t]}`)
})

await test('no --cache-type-v entry, empty or non-string input → null', async () => {
  for (const x of ['', 'usage: something else', null, undefined, 42, '-ctv, --cache-type-v TYPE\n-dt, --defrag N  allowed values: a, b']) {
    assert(parseCacheTypes(x) === null, `expected null for ${JSON.stringify(x)}`)
  }
})

console.log('\n-- preset mapping --')

await test('upstream binary: q8_0/q8_0, q8_0/q4_0, q4_0/q4_0', async () => {
  const s = parseCacheTypes(UPSTREAM_HELP)
  const got = ['conservative', 'balanced', 'aggressive'].map(p => kvCacheTypes(p, s))
  assert(got.every(g => g.codec === 'upstream'), JSON.stringify(got))
  assert(got.map(g => `${g.k}/${g.v}`).join(' ') === 'q8_0/q8_0 q8_0/q4_0 q4_0/q4_0', JSON.stringify(got))
})

await test('TurboQuant+ binary: K stays q8_0, V turbo4/turbo3/turbo2', async () => {
  const s = parseCacheTypes(TURBO_HELP)
  const got = ['conservative', 'balanced', 'aggressive'].map(p => kvCacheTypes(p, s))
  assert(got.every(g => g.codec === 'turbo'), JSON.stringify(got))
  assert(got.map(g => `${g.k}/${g.v}`).join(' ') === 'q8_0/turbo4 q8_0/turbo3 q8_0/turbo2', JSON.stringify(got))
})

await test('unknown binary (probe failed) falls back to the upstream types', async () => {
  const g = kvCacheTypes('balanced', null)
  assert(g.codec === 'upstream' && g.k === 'q8_0' && g.v === 'q4_0', JSON.stringify(g))
})

await test('off / missing / unknown preset → no cache types', async () => {
  for (const p of ['off', undefined, null, 'turbo', '__proto__', 'constructor']) {
    assert(kvCacheTypes(p, null) === null, `preset ${p} mapped to something`)
  }
})

await test('every upstream mapping uses only types upstream lists', async () => {
  const s = parseCacheTypes(UPSTREAM_HELP)
  for (const [name, p] of Object.entries(KV_CACHE_PRESETS)) {
    assert(s.has(p.upstream.k) && s.has(p.upstream.v), `${name}: ${p.upstream.k}/${p.upstream.v}`)
  }
})

console.log('\n-- resolveKvCache + buildArgs --')

await test('the launch config carries the resolved types into -ctk/-ctv', async () => {
  const { config, logLine } = resolveKvCache({ ...base, kvCache: 'balanced' }, parseCacheTypes(TURBO_HELP))
  const args = buildArgs(config, true)
  assert(flagValue(args, '-ctk') === 'q8_0' && flagValue(args, '-ctv') === 'turbo3', args.join(' '))
  assert(/turbo3/.test(logLine) && /TurboQuant\+/.test(logLine), logLine)
})

await test('upstream binary: balanced launches with -ctv q4_0, never a turbo type', async () => {
  const { config } = resolveKvCache({ ...base, kvCache: 'balanced' }, parseCacheTypes(UPSTREAM_HELP))
  const args = buildArgs(config, true)
  assert(flagValue(args, '-ctv') === 'q4_0', args.join(' '))
  assert(!args.some(a => /^turbo/.test(a)), args.join(' '))
})

await test('a binary that lists types but not the mapped ones launches at f16', async () => {
  const s = new Set(['f32', 'f16'])
  const { config, logLine } = resolveKvCache({ ...base, kvCache: 'balanced' }, s)
  const args = buildArgs(config, true)
  assert(!args.includes('-ctk') && !args.includes('-ctv'), args.join(' '))
  assert(/does not accept/.test(logLine), logLine)
})

await test('memory saving off: no cache flags, and a stale kvCacheTypes is dropped', async () => {
  const { config } = resolveKvCache({ ...base, kvCache: 'off', kvCacheTypes: { k: 'q4_0', v: 'q4_0' } }, null)
  const args = buildArgs(config, true)
  assert(!args.includes('-ctk') && !args.includes('-ctv'), args.join(' '))
})

await test('buildArgs without resolveKvCache uses the upstream mapping (a direct caller is safe)', async () => {
  const args = buildArgs({ ...base, kvCache: 'aggressive' }, true)
  assert(flagValue(args, '-ctk') === 'q4_0' && flagValue(args, '-ctv') === 'q4_0', args.join(' '))
})

await test('🔍 a crafted kvCacheTypes in a profile never reaches argv', async () => {
  for (const kvCacheTypes of [
    { k: 'q8_0 --host 0.0.0.0', v: 'q4_0' },
    { k: 'q8_0', v: '--host' },
    { k: '', v: 'q4_0' },
    { k: 'q8_0', v: 'a'.repeat(40) },
  ]) {
    const args = buildArgs({ ...base, kvCacheTypes }, true)
    assert(!args.includes('-ctk') && !args.includes('-ctv'), `${JSON.stringify(kvCacheTypes)} → ${args.join(' ')}`)
    assert(flagValue(args, '--host') === '127.0.0.1', args.join(' '))
  }
})

console.log('\n-- probing the binary --')

const fakeStat = () => ({ size: 1, mtimeMs: 1 })

await test('probe runs `<binary> --help` from the binary\'s own folder, once per binary file', async () => {
  clearCacheTypeProbes()
  const calls = []
  const execFileAsync = async (file, args, opts) => { calls.push({ file, args, cwd: opts.cwd }); return { stdout: TURBO_HELP, stderr: '' } }
  const a = await probeCacheTypes('/opt/llama/llama-server', { execFileAsync, statSync: fakeStat })
  const b = await probeCacheTypes('/opt/llama/llama-server', { execFileAsync, statSync: fakeStat })
  assert(a.has('turbo3') && b === a, 'not cached')
  assert(calls.length === 1 && calls[0].args.join(' ') === '--help' && calls[0].cwd === '/opt/llama', JSON.stringify(calls))
})

await test('a replaced binary (new size/mtime) is probed again', async () => {
  clearCacheTypeProbes()
  let n = 0
  const execFileAsync = async () => { n++; return { stdout: n === 1 ? TURBO_HELP : UPSTREAM_HELP } }
  const first = await probeCacheTypes('/b/llama-server', { execFileAsync, statSync: () => ({ size: 1, mtimeMs: 1 }) })
  const second = await probeCacheTypes('/b/llama-server', { execFileAsync, statSync: () => ({ size: 2, mtimeMs: 2 }) })
  assert(first.has('turbo3') && !second.has('turbo3') && n === 2, `n=${n}`)
})

await test('a failing or missing binary is null (→ upstream types) and is not cached', async () => {
  clearCacheTypeProbes()
  let n = 0
  const execFileAsync = async () => { n++; throw Object.assign(new Error('spawn ENOENT'), { stdout: '', stderr: '' }) }
  assert(await probeCacheTypes('/x/llama-server', { execFileAsync, statSync: fakeStat }) === null, 'not null')
  assert(await probeCacheTypes('/x/llama-server', { execFileAsync, statSync: fakeStat }) === null, 'not null')
  assert(n === 2, 'a failed probe was cached')
  assert(await probeCacheTypes('/gone', { execFileAsync, statSync: () => { throw new Error('ENOENT') } }) === null, 'missing file')
  assert(await probeCacheTypes(null, { execFileAsync }) === null, 'no path')
  assert(await probeCacheTypes('/x', {}) === null, 'no exec')
})

await test('help printed on a non-zero exit is still read', async () => {
  clearCacheTypeProbes()
  const execFileAsync = async () => { throw Object.assign(new Error('exit 1'), { stdout: UPSTREAM_HELP, stderr: '' }) }
  const t = await probeCacheTypes('/y/llama-server', { execFileAsync, statSync: fakeStat })
  assert(t && t.has('q4_0'), 'not parsed')
})

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
