import { SectionTitle, btnCls } from '../components/ui'
import { FolderPicker } from '../components/FolderPicker'
import type { LocalModelFile } from '../types'

// The models in the storage folder are offered as one button each — picking
// the model you just downloaded used to mean browsing to the folder and typing
// its file name. The picker stays as the way to a .gguf kept somewhere else.
//
// Not offered: incomplete downloads, shards 2..N of a split model (shard 1 is
// the loadable path), and the document-search embedding model. The storage
// list below still shows all of them, with Delete.

// Windows paths compare case-insensitively, and either separator may appear.
const samePath = (a: string, b: string) =>
  a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`

export function ModelPanel({ modelPath, onSelectModel, localFiles = [] }: {
  modelPath: string
  onSelectModel: (path: string) => void
  localFiles?: LocalModelFile[]
}) {
  const selectable = localFiles
    .filter(f => !f.partial && !f.embedding && !f.extraShard)
    .sort((a, b) => a.name.localeCompare(b.name))
  const elsewhere = modelPath && !selectable.some(f => samePath(f.path, modelPath))

  return (
    <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      <SectionTitle className="mb-2">Selected model</SectionTitle>

      {selectable.length > 0 && (
        <div className="flex flex-col gap-1 mb-3" role="radiogroup" aria-label="Models in the storage folder">
          {selectable.map(f => {
            const active = !!modelPath && samePath(f.path, modelPath)
            return (
              <button
                key={f.path}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => { if (!active) onSelectModel(f.path) }}
                className={`flex items-center gap-2 text-left px-3 py-2 rounded border text-sm transition-colors ${
                  active
                    ? 'border-orange-500/60 bg-orange-500/10 text-zinc-100'
                    : 'border-zinc-800 bg-zinc-950 text-zinc-300 hover:bg-zinc-800'}`}>
                <span className={`h-2 w-2 rounded-full shrink-0 ${active ? 'bg-orange-500' : 'bg-zinc-700'}`} />
                <span className="flex-1 break-all">{f.name}</span>
                <span className="text-xs text-zinc-500 shrink-0">{gb(f.size)}</span>
              </button>
            )
          })}
        </div>
      )}

      <FolderPicker
        mode="file"
        extensions={['gguf']}
        extensionLabel="GGUF Models"
        title="Select a GGUF model"
        startPath={modelPath || undefined}
        onPick={onSelectModel}
        className={selectable.length > 0 ? btnCls.secondaryBlock : btnCls.primaryBlock}>
        {selectable.length > 0 ? 'Browse for another .gguf…' : 'Select .gguf File'}
      </FolderPicker>

      {elsewhere && (
        <p className="mt-2 text-xs text-zinc-400 break-all">{modelPath}</p>
      )}
    </section>
  )
}
