// Hardware IPC namespace — machine spec scan and GGUF model picker.
import { ipcMain, dialog } from 'electron'

export function registerHardwareHandlers({ execFileAsync }) {
  // --- Hardware ---

  ipcMain.handle('hardware:scan', async () => {
    const specs = {
      cpu: { name: '', cores: 0, threads: 0, architecture: process.arch, supportsAVX: false },
      gpu: { name: '', vram: 0, cudaAvailable: false },
      memory: { total: 0, available: 0 },
      os: { platform: process.platform, arch: process.arch },
    }

    // Single PowerShell call queries everything and returns JSON — no wmic, no header-row parsing bug
    const psScript = `
$r = @{ cpu = @{ name=''; cores=0; threads=0 }; memory = @{ totalBytes=0 }; gpu = @{ name=''; vramMb=0; cuda=$false } }
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
  $nv = & nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>$null
  if ($nv) {
    $p = $nv -split ','
    $r.gpu.name   = $p[0].Trim()
    $r.gpu.vramMb = [int]$p[1].Trim()
    $r.gpu.cuda   = $true
  }
} catch {}
if (-not $r.gpu.cuda) {
  try {
    $g = Get-CimInstance Win32_VideoController | Select-Object -First 1
    $r.gpu.name   = [string]$g.Name
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
      specs.gpu.name           = raw.gpu?.name   || ''
      specs.gpu.vram           = raw.gpu?.vramMb || 0
      specs.gpu.cudaAvailable  = !!raw.gpu?.cuda
      specs.cpu.supportsAVX    = /AVX/i.test(specs.cpu.name) ||
                                  /AVX/i.test(process.env.PROCESSOR_IDENTIFIER || '')
    } catch (e) {
      console.error('Hardware scan error:', e)
    }

    return specs
  })

  ipcMain.handle('hardware:select-model', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'GGUF Models', extensions: ['gguf'] }, { name: 'All Files', extensions: ['*'] }],
    })
    return result.canceled ? null : result.filePaths[0]
  })
}
