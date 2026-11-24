import { useEffect, useState } from 'react'
import { api, getAPI } from '../api/redstart'
import type { HardwareSpecs, LlamaConfig } from '../types'

// Hardware scan, llama-server binary resolution/override, and model picking.
//
// applyBinaryPath / applyModelPath are the onPick callbacks for
// FolderPicker.tsx — the picking itself (native dialog or the
// remote browser) lives in the component now, not here. This hook only
// applies whatever path comes back.
export function useHardwareAndBinary(
  setConfig: React.Dispatch<React.SetStateAction<LlamaConfig>>,
) {
  const [hardware, setHardware] = useState<HardwareSpecs | null>(null)
  const [binaryPath, setBinaryPath] = useState<string | null>(null)

  useEffect(() => {
    getAPI()?.settings.getResolvedBinary().then(setBinaryPath)
  }, [])

  async function scanHardware() {
    const specs = await api().hardware.scan()
    setHardware(specs)
    setConfig(prev => ({
      ...prev,
      threads: specs.cpu.threads || 4,
      // gpuLayers left unset — llama-server's own --fit picks the real value
      // live against actual free VRAM and the model's tensor sizes, which a
      // flat guess here can't match.
      gpuLayers: undefined,
    }))
  }

  // Read the hardware without touching the config, for screens that only show
  // it (the Hugging Face browsers' memory bars). scanHardware() also resets
  // threads and GPU layers, which would mark the profile as changed.
  async function ensureHardware() {
    if (hardware) return
    try { setHardware(await api().hardware.scan()) } catch { /* the bars just stay hidden */ }
  }

  async function applyBinaryPath(p: string) {
    await api().settings.setBinaryPath(p)
    setBinaryPath(p)
  }

  async function clearBinaryOverride() {
    await api().settings.setBinaryPath(null)
    const resolved = await api().settings.getResolvedBinary()
    setBinaryPath(resolved)
  }

  function applyModelPath(p: string) {
    setConfig(prev => ({ ...prev, modelPath: p }))
  }

  return { hardware, binaryPath, scanHardware, ensureHardware, applyBinaryPath, clearBinaryOverride, applyModelPath }
}
