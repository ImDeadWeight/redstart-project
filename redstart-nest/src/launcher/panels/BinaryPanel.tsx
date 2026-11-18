import type { useHardwareAndBinary } from '../hooks/useHardwareAndBinary'
import { SectionTitle, btnCls } from '../components/ui'
import { FolderPicker } from '../components/FolderPicker'

export function BinaryPanel({ hw }: { hw: ReturnType<typeof useHardwareAndBinary> }) {
  const { binaryPath, applyBinaryPath, clearBinaryOverride } = hw
  return (
    <section className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">
      <SectionTitle className="mb-4">Server Binary</SectionTitle>
      <FolderPicker
        mode="file"
        extensions={['exe']}
        extensionLabel="Executable"
        title="Select llama-server.exe"
        startPath={binaryPath ?? undefined}
        onPick={applyBinaryPath}
        className={btnCls.primaryBlock}>
        Select llama-server.exe
      </FolderPicker>
      {binaryPath ? (
        <div className="mt-2 space-y-1">
          <p className="text-xs text-zinc-400 break-all">{binaryPath}</p>
          <button onClick={clearBinaryOverride} className={btnCls.link}>
            Reset to auto-detect
          </button>
        </div>
      ) : (
        <p className="mt-2 text-xs text-red-400">Not found — select binary above</p>
      )}
    </section>
  )
}
