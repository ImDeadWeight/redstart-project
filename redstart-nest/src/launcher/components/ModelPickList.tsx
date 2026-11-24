// =============================================================================
// ModelPickList — the "Your models" list, shared by the Model and Images pages.
// =============================================================================
// One row per model on disk: its name, a line of facts, and either "In use" or
// "Use this", then Delete. The model in use cannot be deleted from here (choose
// another first), on both pages, so a click never leaves the page with no model.
// The list scrolls past about six rows instead of pushing the page down.
// =============================================================================

import { Chip, btnCls } from './ui'

export type ModelPickRow = {
  key: string
  /** The main line: a file name, or a repo with its file. */
  title: React.ReactNode
  /** The facts line under it: size, family, "sees images". */
  detail?: React.ReactNode
  active: boolean
  onUse: () => void
  onDelete: () => void
}

export function ModelPickList({ label, rows, empty }: {
  label: string
  rows: ModelPickRow[]
  empty: React.ReactNode
}) {
  if (rows.length === 0) return <p className="text-sm text-zinc-500">{empty}</p>
  return (
    <div role="radiogroup" aria-label={label} className="flex max-h-96 flex-col gap-2 overflow-y-auto pr-1">
      {rows.map(r => (
        <div key={r.key} className={`flex flex-wrap items-center gap-3 rounded-xl border px-3.5 py-2.5 ${r.active ? 'border-orange-500/70 bg-orange-500/5' : 'border-zinc-800 bg-zinc-950/40'}`}>
          <div className="min-w-[14rem] flex-1">
            <div className="break-all text-sm font-medium text-zinc-100">{r.title}</div>
            {r.detail && <div className="text-[13px] text-zinc-500">{r.detail}</div>}
          </div>
          {r.active
            ? <Chip tone="ok">In use</Chip>
            : <button type="button" role="radio" aria-checked={false} onClick={r.onUse} className={btnCls.chip}>Use this</button>}
          <button type="button" onClick={r.onDelete} className={btnCls.subtle} disabled={r.active}
            data-tip={r.active ? 'Choose another model before deleting this one' : 'Delete this file from the models folder'} data-tip-end="">
            Delete
          </button>
        </div>
      ))}
    </div>
  )
}
