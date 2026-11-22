// Hardware IPC namespace — machine spec scan. (The GGUF model picker moved to
// a native picker, itself since retired.)
//
// PER PLATFORM. The scan used to be one PowerShell script, so on macOS and
// Linux the powershell spawn failed, the catch swallowed it, and the Models
// tab reported "0 GB memory" and no GPU. Windows keeps that script unchanged;
// macOS and Linux each have their own branch below, and every branch starts
// from Node's own os.totalmem()/os.cpus() so a failed probe degrades to
// "less detail", never to zero.
//
// UNIFIED MEMORY (Apple Silicon). There is no separate VRAM: the GPU draws on
// the same RAM as everything else. gpu.vram is reported as the share Metal
// lets the GPU wire (what llama.cpp sees as recommendedMaxWorkingSetSize),
// and gpu.unifiedMemory is set so the UI says "shared" instead of presenting
// two independent pools that would add up to more than the machine has.
//
// KNOWN BUG (non-NVIDIA VRAM): the fallback below reads
// Win32_VideoController.AdapterRAM, a 32-bit signed field that saturates at
// 4095 MB — a 16 GB AMD or Intel card reports as 4 GB. The Models tab shows
// this number as context next to artifact sizes without drawing a conclusion
// from it, which is survivable. It must be fixed (registry qwMemorySize) before
// anything *decides* anything from gpu.vram.
//
// Handler bodies are exported as plain functions so an HTTP route can call them
// directly without dragging IPC registration in — importing this module never
// registers anything; only registerHardwareHandlers() does that.

import * as fs from 'fs'
import * as os from 'os'

const GB = 1024 ** 3

function baseSpecs(platform, arch) {
  const cpus = os.cpus() || []
  return {
    cpu: { name: (cpus[0]?.model || '').trim(), cores: cpus.length, threads: cpus.length, architecture: arch, supportsAVX: false },
    gpu: { name: '', vram: 0, vramFree: 0, cudaAvailable: false, unifiedMemory: false },
    memory: { total: os.totalmem() / GB, available: os.freemem() / GB },
    os: { platform, arch },
  }
}

// Every probe below is best-effort: a missing tool or odd output leaves the
// os-module baseline in place rather than failing the scan.
async function run(execFileAsync, cmd, args) {
  try {
    const out = await execFileAsync(cmd, args)
    return String(out?.stdout ?? '').trim()
  } catch {
    return ''
  }
}

// nvidia-smi exists on Linux (and on the rare eGPU Mac it does not); one line
// per card, first card only — same single-GPU shape as the Windows branch.
async function probeNvidia(execFileAsync, specs) {
  const nv = await run(execFileAsync, 'nvidia-smi', ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'])
  const line = nv.split('\n')[0]
  if (!line) return false
  const p = line.split(',').map(x => x.trim())
  if (p.length < 3 || !p[0]) return false
  specs.gpu.name = p[0]
  specs.gpu.vram = parseInt(p[1], 10) || 0
  specs.gpu.vramFree = parseInt(p[2], 10) || 0
  specs.gpu.cudaAvailable = true
  return true
}

// macOS's own default GPU wiring limit when iogpu.wired_limit_mb is unset
// (0): about two thirds of RAM up to 36 GB, three quarters above. This is the
// figure Metal's recommendedMaxWorkingSetSize reports, so it is what
// llama.cpp will actually be allowed to use.
export function appleGpuShareMb(totalBytes, wiredLimitMb) {
  if (wiredLimitMb > 0) return wiredLimitMb
  const totalMb = totalBytes / (1024 * 1024)
  return Math.round(totalBytes <= 36 * GB ? totalMb * 2 / 3 : totalMb * 3 / 4)
}

// vm_stat counts pages. os.freemem() on macOS is only the "free" bucket, which
// is tiny on a healthy Mac because the OS keeps idle RAM as file cache; the
// memory a model can actually take also includes inactive, speculative and
// purgeable pages, which the OS hands back on demand.
export function parseVmStat(text) {
  const pageSize = parseInt(/page size of (\d+) bytes/.exec(text)?.[1] ?? '', 10)
  if (!pageSize) return 0
  const pages = (label) => parseInt(new RegExp(`Pages ${label}:\\s+(\\d+)`).exec(text)?.[1] ?? '0', 10)
  return (pages('free') + pages('inactive') + pages('speculative') + pages('purgeable')) * pageSize
}

async function scanMac({ execFileAsync }, specs) {
  const sysctl = (name) => run(execFileAsync, 'sysctl', ['-n', name])

  const brand = await sysctl('machdep.cpu.brand_string')
  if (brand) specs.cpu.name = brand
  const physical = parseInt(await sysctl('hw.physicalcpu'), 10)
  const logical = parseInt(await sysctl('hw.logicalcpu'), 10)
  if (physical > 0) specs.cpu.cores = physical
  if (logical > 0) specs.cpu.threads = logical
  const memsize = Number(await sysctl('hw.memsize'))
  if (memsize > 0) specs.memory.total = memsize / GB
  const avail = parseVmStat(await run(execFileAsync, 'vm_stat', []))
  if (avail > 0) specs.memory.available = avail / GB

  if (specs.os.arch === 'arm64') {
    // Apple Silicon: the GPU is on the same chip and shares system RAM.
    const totalBytes = memsize > 0 ? memsize : os.totalmem()
    const wired = parseInt(await sysctl('iogpu.wired_limit_mb'), 10) || 0
    specs.gpu.name = `${specs.cpu.name || 'Apple Silicon'} GPU`
    specs.gpu.vram = appleGpuShareMb(totalBytes, wired)
    specs.gpu.vramFree = Math.min(specs.gpu.vram, Math.round(specs.memory.available * 1024))
    specs.gpu.unifiedMemory = true
    return
  }

  // Intel Mac: AVX from the feature flags, the GPU from system_profiler.
  const features = `${await sysctl('machdep.cpu.features')} ${await sysctl('machdep.cpu.leaf7_features')}`
  specs.cpu.supportsAVX = /\bAVX/i.test(features)
  try {
    const raw = JSON.parse(await run(execFileAsync, 'system_profiler', ['SPDisplaysDataType', '-json']) || '{}')
    const cards = raw.SPDisplaysDataType || []
    const card = cards.find(c => /vram/i.test(Object.keys(c).join(' '))) || cards[0]
    if (card) {
      specs.gpu.name = card.sppci_model || card._name || ''
      const vramText = card.spdisplays_vram || card.spdisplays_vram_shared || ''
      const m = /([\d.]+)\s*(GB|MB)/i.exec(vramText)
      if (m) specs.gpu.vram = Math.round(parseFloat(m[1]) * (/GB/i.test(m[2]) ? 1024 : 1))
    }
  } catch {}
}

async function scanLinux({ execFileAsync }, specs) {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8')
    const kb = (k) => parseInt(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(meminfo)?.[1] ?? '0', 10) * 1024
    if (kb('MemTotal')) specs.memory.total = kb('MemTotal') / GB
    if (kb('MemAvailable')) specs.memory.available = kb('MemAvailable') / GB
  } catch {}
  try {
    const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8')
    specs.cpu.supportsAVX = /^flags\s*:.*\bavx\b/m.test(cpuinfo)
    const cores = new Set(cpuinfo.split('\n\n').map(b => `${/physical id\s*:\s*(\d+)/.exec(b)?.[1]}:${/core id\s*:\s*(\d+)/.exec(b)?.[1]}`).filter(k => !k.includes('undefined')))
    if (cores.size > 0) specs.cpu.cores = cores.size
  } catch {}
  await probeNvidia(execFileAsync, specs)
}

export async function scanHardware({ execFileAsync, platform = process.platform, arch = process.arch }) {
  const specs = baseSpecs(platform, arch)
  try {
    if (platform === 'win32') await scanWindows({ execFileAsync }, specs)
    else if (platform === 'darwin') await scanMac({ execFileAsync }, specs)
    else await scanLinux({ execFileAsync }, specs)
  } catch (e) {
    console.error('Hardware scan error:', e)
  }
  return specs
}

async function scanWindows({ execFileAsync }, specs) {
  // Single PowerShell call queries everything and returns JSON — no wmic, no header-row parsing bug
  const psScript = `
$r = @{ cpu = @{ name=''; cores=0; threads=0 }; memory = @{ totalBytes=0; availableBytes=0 }; gpu = @{ name=''; vramMb=0; vramFreeMb=0; cuda=$false } }
try {
  $c = Get-CimInstance Win32_Processor | Select-Object -First 1
  $r.cpu.name    = [string]$c.Name
  $r.cpu.cores   = [int]$c.NumberOfCores
  $r.cpu.threads = [int]$c.NumberOfLogicalProcessors
} catch {}
try {
  $r.memory.totalBytes = [long](Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
} catch {}
try {
  # FreePhysicalMemory is in KB. This is free RAM right now, which is what
  # matters for "can I offload to system RAM", not the total.
  $r.memory.availableBytes = [long](Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory * 1024
} catch {}
try {
  $nv = & nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits 2>$null
  if ($nv) {
    # Multi-GPU returns one line per card; take the first, matching the
    # single-GPU shape the rest of the launcher assumes.
    $line = ($nv | Select-Object -First 1)
    $p = $line -split ','
    $r.gpu.name       = $p[0].Trim()
    $r.gpu.vramMb     = [int]$p[1].Trim()
    $r.gpu.vramFreeMb = [int]$p[2].Trim()
    $r.gpu.cuda       = $true
  }
} catch {}
if (-not $r.gpu.cuda) {
  try {
    $g = Get-CimInstance Win32_VideoController | Select-Object -First 1
    $r.gpu.name   = [string]$g.Name
    # AdapterRAM caps at 4095 MB — see the file header. No free-VRAM source
    # exists on this path, so vramFreeMb stays 0 and the UI omits it.
    $r.gpu.vramMb = if ($g.AdapterRAM) { [int]([Math]::Round($g.AdapterRAM / 1MB)) } else { 0 }
  } catch {}
}
$r | ConvertTo-Json -Compress
`
  try {
    const out = await execFileAsync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command', psScript,
    ])
    const raw = JSON.parse(out.stdout.trim())
    specs.cpu.name    = raw.cpu?.name    || specs.cpu.name
    specs.cpu.cores   = raw.cpu?.cores   || specs.cpu.cores
    specs.cpu.threads = raw.cpu?.threads || specs.cpu.threads
    if (raw.memory?.totalBytes) specs.memory.total = raw.memory.totalBytes / GB
    if (raw.memory?.availableBytes) specs.memory.available = raw.memory.availableBytes / GB
    specs.gpu.name           = raw.gpu?.name   || ''
    specs.gpu.vram           = raw.gpu?.vramMb || 0
    specs.gpu.vramFree       = raw.gpu?.vramFreeMb || 0
    specs.gpu.cudaAvailable  = !!raw.gpu?.cuda
    specs.cpu.supportsAVX    = /AVX/i.test(specs.cpu.name) ||
                                /AVX/i.test(process.env.PROCESSOR_IDENTIFIER || '')
  } catch (e) {
    console.error('Hardware scan error:', e)
  }
}

// selectModelFile() is retired — model-file picking moved onto
// FolderPicker.tsx, which calls admin/browse-routes.mjs's browse:list
// instead of a dedicated dialog here (the native dialog it briefly grew as a
// middle step was later retired too). The renderer already knows the
// models dir (settings.getModelsDir()) and passes it through as
// FolderPicker's `defaultPath`, so nothing is lost.

export function hardwareHandlers(deps) {
  return {
    'hardware:scan': async () => scanHardware(deps),
  }
}
