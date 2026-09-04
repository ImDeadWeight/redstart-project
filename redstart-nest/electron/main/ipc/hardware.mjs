// Hardware IPC namespace — machine spec scan. (The GGUF model picker moved to
// a native picker, Phase 4 §4.3 — itself retired in Phase 6 §6.1.)
//
// KNOWN BUG (non-NVIDIA VRAM): the fallback below reads
// Win32_VideoController.AdapterRAM, a 32-bit signed field that saturates at
// 4095 MB — a 16 GB AMD or Intel card reports as 4 GB. The Models tab shows
// this number as context next to artifact sizes without drawing a conclusion
// from it, which is survivable. It must be fixed (registry qwMemorySize) before
// anything *decides* anything from gpu.vram. See docs/notes/model-browser-plan.md.
//
// Handler bodies are exported as plain functions (Phase 1, §1.3 of the
// headless-admin-plane implementation plan) so an HTTP route can call them
// directly without dragging IPC registration in — importing this module never
// registers anything; only registerHardwareHandlers() does that.

export async function scanHardware({ execFileAsync }) {
  const specs = {
    cpu: { name: '', cores: 0, threads: 0, architecture: process.arch, supportsAVX: false },
    gpu: { name: '', vram: 0, vramFree: 0, cudaAvailable: false },
    memory: { total: 0, available: 0 },
    os: { platform: process.platform, arch: process.arch },
  }

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
    specs.cpu.name    = raw.cpu?.name    || ''
    specs.cpu.cores   = raw.cpu?.cores   || 0
    specs.cpu.threads = raw.cpu?.threads || 0
    specs.memory.total       = (raw.memory?.totalBytes || 0) / (1024 ** 3)
    specs.memory.available   = (raw.memory?.availableBytes || 0) / (1024 ** 3)
    specs.gpu.name           = raw.gpu?.name   || ''
    specs.gpu.vram           = raw.gpu?.vramMb || 0
    specs.gpu.vramFree       = raw.gpu?.vramFreeMb || 0
    specs.gpu.cudaAvailable  = !!raw.gpu?.cuda
    specs.cpu.supportsAVX    = /AVX/i.test(specs.cpu.name) ||
                                /AVX/i.test(process.env.PROCESSOR_IDENTIFIER || '')
  } catch (e) {
    console.error('Hardware scan error:', e)
  }

  return specs
}

// selectModelFile() retired — Phase 4 §4.3 moved model-file picking onto
// FolderPicker.tsx, which calls admin/browse-routes.mjs's browse:list
// instead of a dedicated dialog here (Phase 6 §6.1 later retired the native
// dialog it briefly grew as a middle step). The renderer already knows the
// models dir (settings.getModelsDir()) and passes it through as
// FolderPicker's `defaultPath`, so nothing is lost.

export function hardwareHandlers(deps) {
  return {
    'hardware:scan': async () => scanHardware(deps),
  }
}
