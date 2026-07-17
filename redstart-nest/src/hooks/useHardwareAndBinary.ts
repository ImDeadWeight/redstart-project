import { useEffect, useState } from 'react'
import { api, getAPI } from '../api/redstart'
import type { HardwareSpecs, LlamaConfig } from '../types'

// Hardware scan, llama-server binary resolution/override, and model picking.
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

  async function selectBinary() {
    const p = await api().settings.selectBinary()
    if (p) {
      await api().settings.setBinaryPath(p)
      setBinaryPath(p)
    }
  }

  async function clearBinaryOverride() {
    await api().settings.setBinaryPath(null)
    const resolved = await api().settings.getResolvedBinary()
    setBinaryPath(resolved)
  }

  async function selectModel() {
    const p = await api().hardware.selectModel()
    if (p) setConfig(prev => ({ ...prev, modelPath: p }))
  }

  return { hardware, binaryPath, scanHardware, selectBinary, clearBinaryOverride, selectModel }
}
