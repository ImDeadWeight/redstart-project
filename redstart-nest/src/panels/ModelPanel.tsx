import { SectionTitle, btnCls } from '../components/ui'
import { FolderPicker } from '../components/FolderPicker'

export function ModelPanel({ modelPath, onSelectModel }: {
  modelPath: string
  onSelectModel: (path: string) => void
}) {
  return (
    <section>
      <SectionTitle>Model</SectionTitle>
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
