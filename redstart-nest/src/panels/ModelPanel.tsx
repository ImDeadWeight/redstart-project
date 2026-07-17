import { SectionTitle, btnCls } from '../components/ui'

export function ModelPanel({ modelPath, onSelectModel }: {
  modelPath: string
  onSelectModel: () => void
}) {
  return (
    <section>
      <SectionTitle>Model</SectionTitle>
      <button onClick={onSelectModel} className={btnCls.primaryBlock}>
        Select .gguf File
      </button>
      {modelPath && (
        <p className="mt-2 text-xs text-zinc-400 break-all">{modelPath}</p>
      )}
    </section>
  )
}
