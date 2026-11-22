// =============================================================================
// Unit tests for daemon/ipc/hardware.mjs — the per-platform hardware scan.
// =============================================================================
// The regression this guards: the scan was a single PowerShell script, so on
// macOS (and Linux) it silently failed and reported 0 GB of memory. Each
// platform branch is driven here with a fake execFileAsync, so the macOS
// branch is exercised on any CI runner.
//
// Run:  node scripts/test-hardware-scan.mjs
// =============================================================================

import { scanHardware, appleGpuShareMb, parseVmStat } from '../daemon/ipc/hardware.mjs'

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

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
