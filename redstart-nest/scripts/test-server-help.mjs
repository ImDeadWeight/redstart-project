// =============================================================================
// Tests for daemon/server-help.mjs — "Disable memory-mapping" becomes the flag
// the running llama-server actually accepts.
// =============================================================================
// Upstream llama.cpp (b12651, the bundled engine) replaced --mmap/--no-mmap
// with -lm/--load-mode and rejects the old flag at startup ("error: invalid
// argument: --no-mmap", exit 1), which stopped every profile with noMmap set.
// An older or TurboQuant+ build only knows --no-mmap. The flag is decided from
// the binary's own --help; these tests pin both help formats and the fallback.
//
// Run:  node scripts/test-server-help.mjs
// =============================================================================

import { initPaths } from '../daemon/platform-paths.mjs'

initPaths({ config: 'unused-by-server-help/config', capabilityBase: 'unused-by-server-help/data', isPackaged: false })

const {
  MMAP_OFF_ARGS, parseMmapOffFlag, resolveMmap, probeServerHelp, clearServerHelpProbes,
} = await import('../daemon/server-help.mjs')
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

// As b12651's llama-server --help prints them (Windows CUDA release build).
const UPSTREAM_HELP = [
  '-lm,   --load-mode MODE                 model loading mode (default: auto)',
  '                                        - auto: mmap, unless a device does not support it',
  '                                        - none: no special loading mode',
  '                                        - mmap: memory-map model (if mmap disabled, slower load but may reduce',
  '                                        (env: LLAMA_ARG_LOAD_MODE)',
  '-ctv,  --cache-type-v TYPE              KV cache data type for V',
  '                                        allowed values: f32, f16, bf16, f8_e4m3, q8_0, q4_0, q4_1, iq4_nl,',
  '                                        q5_0, q5_1',
].join('\n')
// As the TurboQuant+ fork and pre-load-mode upstream builds print them.
const OLD_HELP = [
  '--mmap, --no-mmap                       whether to memory-map model (if disabled, slower load but may reduce',
  '                                        pageouts if not using mlock) (default: enabled)',
  '                                        (env: LLAMA_ARG_MMAP)',
  '-ctv,  --cache-type-v TYPE              KV cache data type for V',
  '                                        allowed values: f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1, turbo2, turbo3, turbo4',
].join('\n')

const base = { modelPath: 'C:\\m.gguf', ctxSize: 4096, batchSize: 512, threads: 8, port: 19080, additionalArgs: '' }

console.log('\n-- reading the help text --')

await test('upstream help → --load-mode; old/TurboQuant+ help → --no-mmap; neither → null', async () => {
  assert(parseMmapOffFlag(UPSTREAM_HELP) === 'load-mode', parseMmapOffFlag(UPSTREAM_HELP))
  assert(parseMmapOffFlag(OLD_HELP) === 'no-mmap', parseMmapOffFlag(OLD_HELP))
  assert(parseMmapOffFlag('usage: something else') === null, 'unrelated text')
  assert(parseMmapOffFlag('') === null && parseMmapOffFlag(undefined) === null, 'empty')
})

await test('a help naming both prefers --load-mode (the build that has it dropped --no-mmap)', async () => {
  assert(parseMmapOffFlag(`${OLD_HELP}\n${UPSTREAM_HELP}`) === 'load-mode', 'did not prefer load-mode')
})

console.log('\n-- the launch arguments --')

await test('noMmap on upstream emits `--load-mode none` and never `--no-mmap`', async () => {
  const args = buildArgs(resolveMmap({ ...base, noMmap: true }, 'load-mode').config, true)
  const i = args.indexOf('--load-mode')
  assert(i !== -1 && args[i + 1] === 'none', args.join(' '))
  assert(!args.includes('--no-mmap'), args.join(' '))
})

await test('noMmap on an old/TurboQuant+ binary emits `--no-mmap` and never `--load-mode`', async () => {
  const args = buildArgs(resolveMmap({ ...base, noMmap: true }, 'no-mmap').config, true)
  assert(args.includes('--no-mmap') && !args.includes('--load-mode'), args.join(' '))
})

await test('a binary that could not be asked gets no mmap flag, and the log says so', async () => {
  const r = resolveMmap({ ...base, noMmap: true }, null)
  const args = buildArgs(r.config, true)
  assert(!args.includes('--no-mmap') && !args.includes('--load-mode'), args.join(' '))
  assert(/left on/.test(r.logLine), r.logLine)
})

await test('noMmap off: no flag on either binary, and no log line', async () => {
  for (const flag of ['load-mode', 'no-mmap', null]) {
    const r = resolveMmap({ ...base }, flag)
    const args = buildArgs(r.config, true)
    assert(!args.includes('--no-mmap') && !args.includes('--load-mode'), `${flag}: ${args.join(' ')}`)
    assert(r.logLine === null, `${flag}: ${r.logLine}`)
  }
})

await test('a config that never went through resolveMmap gets the bundled (upstream) form', async () => {
  const args = buildArgs({ ...base, noMmap: true }, true)
  assert(args.join(' ').includes('--load-mode none') && !args.includes('--no-mmap'), args.join(' '))
})

await test('🔍 mmapOffFlag from a config file cannot put anything else on the command line', async () => {
  for (const mmapOffFlag of ['--host', '__proto__', 'constructor', 'toString', ['--host', '0.0.0.0'], { 0: '--host' }, 42]) {
    const args = buildArgs({ ...base, noMmap: true, mmapOffFlag }, true)
    assert(!args.includes('--no-mmap') && !args.includes('--load-mode'), `${JSON.stringify(mmapOffFlag)}: ${args.join(' ')}`)
    assert(args.filter(a => a === '--host').length === 1 && args[args.indexOf('--host') + 1] === '127.0.0.1', args.join(' '))
  }
  // And resolveMmap discards a file's value before deciding.
  const r = resolveMmap({ ...base, noMmap: false, mmapOffFlag: 'no-mmap' }, 'load-mode')
  assert(r.config.mmapOffFlag === null, JSON.stringify(r.config.mmapOffFlag))
  assert(Object.keys(MMAP_OFF_ARGS).join() === 'load-mode,no-mmap', 'table changed')
})

console.log('\n-- probing the binary --')

const fakeStat = () => ({ size: 1, mtimeMs: 1 })

await test('one --help run answers both the cache types and the mmap flag', async () => {
  clearServerHelpProbes()
  let n = 0
  const execFileAsync = async () => { n++; return { stdout: UPSTREAM_HELP, stderr: '' } }
  const a = await probeServerHelp('/u/llama-server', { execFileAsync, statSync: fakeStat })
  const b = await probeServerHelp('/u/llama-server', { execFileAsync, statSync: fakeStat })
  assert(a.mmapOffFlag === 'load-mode' && a.cacheTypes?.has('q4_0') && b === a && n === 1, `n=${n} ${JSON.stringify(a)}`)
})

await test('a failing binary is { null, null } and is retried next time', async () => {
  clearServerHelpProbes()
  let n = 0
  const execFileAsync = async () => { n++; throw Object.assign(new Error('spawn ENOENT'), { stdout: '', stderr: '' }) }
  for (let i = 0; i < 2; i++) {
    const h = await probeServerHelp('/x/llama-server', { execFileAsync, statSync: fakeStat })
    assert(h.cacheTypes === null && h.mmapOffFlag === null, JSON.stringify(h))
  }
  assert(n === 2, 'a failed probe was cached')
})

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
