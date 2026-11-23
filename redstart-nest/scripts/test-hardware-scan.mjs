// =============================================================================
// Unit tests for daemon/ipc/hardware.mjs — the per-platform hardware scan.
// =============================================================================
// The regressions this guards: the scan was a single PowerShell script, so on
// macOS (and Linux) it silently failed and reported 0 GB of memory; and the
// GPU now comes from `llama-server --list-devices`, with the OS probes as the
// fallback. Each platform branch is driven here with a fake execFileAsync, so
// the macOS branch is exercised on any CI runner.
//
// Run:  node scripts/test-hardware-scan.mjs
// =============================================================================

import * as path from 'path'
import { scanHardware, appleGpuShareMb, parseVmStat, parseListDevices, probeLlamaDevices } from '../daemon/ipc/hardware.mjs'

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

const GB = 1024 ** 3

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               50000.
Pages active:                            400000.
Pages inactive:                          300000.
Pages speculative:                        10000.
Pages throttled:                              0.
Pages wired down:                        200000.
Pages purgeable:                          20000.
`

function fakeExec(table) {
  return async (cmd, args) => {
    const key = [cmd, ...args].join(' ')
    if (key in table) return { stdout: table[key] }
    const err = new Error(`ENOENT ${cmd}`)
    err.code = 'ENOENT'
    throw err
  }
}

console.log('\n--- macOS (Apple Silicon) ---')

await test('an M-series Mac reports its RAM and a unified-memory GPU, never 0', async () => {
  const specs = await scanHardware({
    platform: 'darwin', arch: 'arm64',
    execFileAsync: fakeExec({
      'sysctl -n machdep.cpu.brand_string': 'Apple M2 Pro',
      'sysctl -n hw.physicalcpu': '12',
      'sysctl -n hw.logicalcpu': '12',
      'sysctl -n hw.memsize': String(32 * GB),
      'sysctl -n iogpu.wired_limit_mb': '0',
      'vm_stat': VM_STAT,
    }),
  })
  assert(Math.round(specs.memory.total) === 32, `memory.total was ${specs.memory.total}`)
  assert(specs.memory.available > 0, 'memory.available was 0')
  assert(specs.cpu.name === 'Apple M2 Pro', `cpu.name was ${specs.cpu.name}`)
  assert(specs.cpu.cores === 12 && specs.cpu.threads === 12, 'core counts wrong')
  assert(specs.gpu.unifiedMemory === true, 'unifiedMemory not set')
  assert(specs.gpu.name === 'Apple M2 Pro GPU', `gpu.name was ${specs.gpu.name}`)
  assert(specs.gpu.vram > 20000 && specs.gpu.vram < 23000, `gpu.vram was ${specs.gpu.vram} MB`)
  assert(specs.gpu.cudaAvailable === false, 'CUDA reported on a Mac')
  return `${specs.memory.total} GB, GPU share ${specs.gpu.vram} MB`
})

await test('a raised iogpu.wired_limit_mb is honoured', async () => {
  const specs = await scanHardware({
    platform: 'darwin', arch: 'arm64',
    execFileAsync: fakeExec({ 'sysctl -n hw.memsize': String(64 * GB), 'sysctl -n iogpu.wired_limit_mb': '57344' }),
  })
  assert(specs.gpu.vram === 57344, `gpu.vram was ${specs.gpu.vram}`)
})

await test('every probe failing still reports Node\'s own memory figure, not 0', async () => {
  const specs = await scanHardware({ platform: 'darwin', arch: 'arm64', execFileAsync: fakeExec({}) })
  assert(specs.memory.total > 0, 'memory.total fell to 0')
  assert(specs.gpu.vram > 0, 'gpu.vram fell to 0')
})

await test('appleGpuShareMb: two thirds up to 36 GB, three quarters above', () => {
  assert(appleGpuShareMb(16 * GB, 0) === Math.round(16 * 1024 * 2 / 3), '16 GB')
  assert(appleGpuShareMb(64 * GB, 0) === 48 * 1024, '64 GB')
})

await test('parseVmStat counts free + inactive + speculative + purgeable pages', () => {
  assert(parseVmStat(VM_STAT) === (50000 + 300000 + 10000 + 20000) * 16384, 'wrong byte count')
  assert(parseVmStat('garbage') === 0, 'garbage did not give 0')
})

console.log('\n--- Linux / Windows ---')

await test('Linux reports memory from /proc/meminfo or os, never 0', async () => {
  const specs = await scanHardware({ platform: 'linux', arch: 'x64', execFileAsync: fakeExec({}) })
  assert(specs.memory.total > 0, 'memory.total was 0')
  assert(specs.cpu.threads > 0, 'threads was 0')
})

await test('Linux picks up an NVIDIA card from nvidia-smi', async () => {
  const specs = await scanHardware({
    platform: 'linux', arch: 'x64',
    execFileAsync: fakeExec({ 'nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits': 'NVIDIA GeForce RTX 4090, 24564, 23000' }),
  })
  assert(specs.gpu.name === 'NVIDIA GeForce RTX 4090' && specs.gpu.vram === 24564 && specs.gpu.cudaAvailable, JSON.stringify(specs.gpu))
})

await test('Windows: a failed PowerShell call keeps the os baseline instead of zeroing it', async () => {
  const specs = await scanHardware({ platform: 'win32', arch: 'x64', execFileAsync: fakeExec({}) })
  assert(specs.memory.total > 0, 'memory.total was 0')
})

console.log('\n--- llama-server --list-devices ---')

const BIN = '/opt/redstart/llama-server'
const LIST = (body) => ({ [`${BIN} --list-devices`]: `Available devices:\n${body}\n` })

await test('parseListDevices reads CUDA, Metal and Vulkan lines, CRLF included', () => {
  const d = parseListDevices('Available devices:\r\n  CUDA0: NVIDIA GeForce RTX 3060 (12287 MiB, 11253 MiB free)\r\n  MTL0: Apple M2 Pro (21845 MiB, 21800 MiB free)\r\n  Vulkan1: AMD Radeon (TM) Graphics (512 MiB, 400 MiB free)\r\n')
  assert(d.length === 3, `got ${d.length} devices`)
  assert(d[0].id === 'CUDA0' && d[0].backend === 'CUDA' && d[0].name === 'NVIDIA GeForce RTX 3060' && d[0].totalMb === 12287 && d[0].freeMb === 11253, JSON.stringify(d[0]))
  assert(d[1].backend === 'MTL', JSON.stringify(d[1]))
  assert(d[2].name === 'AMD Radeon (TM) Graphics' && d[2].backend === 'Vulkan', `parenthesised name: ${JSON.stringify(d[2])}`)
})

await test('parseListDevices drops memoryless devices (BLAS) and ignores log noise', () => {
  const d = parseListDevices('ggml_cuda_init: found 1 CUDA devices:\nAvailable devices:\n  BLAS: Accelerate (0 MiB, 0 MiB free)\n')
  assert(d.length === 0, JSON.stringify(d))
  assert(parseListDevices('').length === 0 && parseListDevices(undefined).length === 0, 'empty input')
})

await test('Windows: llama-server\'s device replaces the OS GPU figures', async () => {
  const specs = await scanHardware({
    platform: 'win32', arch: 'x64', resolveBinary: () => BIN,
    execFileAsync: fakeExec(LIST('  CUDA0: NVIDIA GeForce RTX 3060 (12287 MiB, 11253 MiB free)')),
  })
  assert(specs.gpu.source === 'llama-server', `source was ${specs.gpu.source}`)
  assert(specs.gpu.name === 'NVIDIA GeForce RTX 3060' && specs.gpu.vram === 12287 && specs.gpu.vramFree === 11253, JSON.stringify(specs.gpu))
  assert(specs.gpu.cudaAvailable === true, 'CUDA device but cudaAvailable false')
  assert(specs.memory.total > 0, 'memory baseline lost')
})

await test('multi-GPU: the largest device is the headline, all are listed', async () => {
  const specs = await scanHardware({
    platform: 'linux', arch: 'x64', resolveBinary: () => BIN,
    execFileAsync: fakeExec(LIST('  Vulkan0: Intel(R) UHD Graphics (2048 MiB, 2000 MiB free)\n  Vulkan1: AMD Radeon RX 7900 XTX (24560 MiB, 24000 MiB free)')),
  })
  assert(specs.gpu.name === 'AMD Radeon RX 7900 XTX' && specs.gpu.vram === 24560, JSON.stringify(specs.gpu))
  assert(specs.gpu.devices.length === 2, 'devices not all kept')
  assert(specs.gpu.cudaAvailable === false, 'Vulkan reported as CUDA')
})

await test('Apple Silicon: Metal\'s device keeps unified memory, free bounded by RAM', async () => {
  const specs = await scanHardware({
    platform: 'darwin', arch: 'arm64', resolveBinary: () => BIN,
    execFileAsync: fakeExec({
      'sysctl -n hw.memsize': String(32 * GB),
      'vm_stat': VM_STAT,
      ...LIST('  MTL0: Apple M2 Pro (21845 MiB, 21845 MiB free)\n  BLAS: Accelerate (0 MiB, 0 MiB free)'),
    }),
  })
  assert(specs.gpu.unifiedMemory === true && specs.gpu.vram === 21845, JSON.stringify(specs.gpu))
  assert(specs.gpu.vramFree <= Math.round(specs.memory.available * 1024), `vramFree ${specs.gpu.vramFree} exceeds free RAM`)
  assert(specs.gpu.devices.length === 1, 'BLAS was kept as a device')
})

await test('a missing, throwing or failing binary falls back to the OS probe', async () => {
  const nv = { 'nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits': 'NVIDIA GeForce RTX 4090, 24564, 23000' }
  for (const resolveBinary of [undefined, () => null, () => { throw new Error('nope') }, () => BIN]) {
    const specs = await scanHardware({ platform: 'linux', arch: 'x64', resolveBinary, execFileAsync: fakeExec(nv) })
    assert(specs.gpu.source === 'system' && specs.gpu.vram === 24564, `fallback lost: ${JSON.stringify(specs.gpu)}`)
  }
})

await test('a binary that lists no device keeps the OS figures', async () => {
  const specs = await scanHardware({
    platform: 'linux', arch: 'x64', resolveBinary: () => BIN,
    execFileAsync: fakeExec({ ...LIST(''), 'nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits': 'NVIDIA GeForce RTX 4090, 24564, 23000' }),
  })
  assert(specs.gpu.source === 'system' && specs.gpu.name === 'NVIDIA GeForce RTX 4090', JSON.stringify(specs.gpu))
})

await test('the probe runs the binary from its own folder, with a timeout', async () => {
  let seen = null
  await probeLlamaDevices({ resolveBinary: () => BIN, execFileAsync: async (cmd, args, opts) => { seen = opts; return { stdout: '' } } })
  assert(seen && seen.cwd === path.dirname(BIN), `cwd was ${seen?.cwd}`)
  assert(seen.timeout > 0 && seen.windowsHide === true, JSON.stringify(seen))
})

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
