import type { useHardwareAndBinary } from '../hooks/useHardwareAndBinary'
import { SectionTitle, btnCls } from '../components/ui'

export function HardwarePanel({ hw, onGenerateDefaults }: {
  hw: ReturnType<typeof useHardwareAndBinary>
  onGenerateDefaults: () => void
}) {
  const { hardware, scanHardware } = hw
  return (
    <section>
      <SectionTitle>Hardware</SectionTitle>
      <button onClick={scanHardware} className={btnCls.primaryBlock}>
        Scan Hardware
      </button>
      {hardware && (
        <div className="mt-3 space-y-1 text-xs text-zinc-400">
          <div><span className="text-white">{hardware.cpu.name || 'CPU'}</span> — {hardware.cpu.cores}C / {hardware.cpu.threads}T</div>
          <div><span className="text-white">{hardware.gpu.name || 'GPU'}</span> — {hardware.gpu.vram} MB {hardware.gpu.cudaAvailable ? '· CUDA' : ''}</div>
          <div><span className="text-white">RAM</span> — {hardware.memory.total.toFixed(1)} GB</div>
        </div>
      )}
      {hardware && (
        <button onClick={onGenerateDefaults} className={`mt-2 ${btnCls.secondaryBlock}`}>
          Generate Default Profiles
        </button>
      )}
    </section>
  )
}
