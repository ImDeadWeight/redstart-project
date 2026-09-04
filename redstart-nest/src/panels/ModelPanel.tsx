import { SectionTitle, btnCls } from '../components/ui'
import { FolderPicker } from '../components/FolderPicker'

export function ModelPanel({ modelPath, onSelectModel }: {
  modelPath: string
  onSelectModel: (path: string) => void
}) {
  return (
    <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      <SectionTitle className="mb-2">Selected model</SectionTitle>
      <FolderPicker
        mode="file"
        extensions={['gguf']}
        extensionLabel="GGUF Models"
        title="Select a GGUF model"
        startPath={modelPath || undefined}
        onPick={onSelectModel}
        className={btnCls.primaryBlock}>
        Select .gguf File
      </FolderPicker>
      {modelPath && (
        <p className="mt-2 text-xs text-zinc-400 break-all">{modelPath}</p>
      )}
    </section>
  )
}
