import { useState } from 'react'
import { api } from '../api/redstart'
import type { DeferralEntry } from '../types'

// Which capabilities are catalog-only (master plan Phase 3.1). A deferred
// capability's tools are not in the prompt: the assistant finds them with
// search_tools and calls them through call_tool, so the prompt's tool list
// stays the same for the whole conversation, however many plugins are added.
//
// It only takes effect while the profile's tool retrieval is on (which means
// the catalog, master plan 3.3), and the card says so, so an admin who ticks a
// box and sees no change is not left guessing.

export function DeferralCard({ entries, retrievalOn, onChanged }: {
  entries: DeferralEntry[] | null | undefined
  retrievalOn: boolean
  onChanged: () => void | Promise<void>
}) {
  const [error, setError] = useState<string | null>(null)
  if (!entries || entries.length === 0) return null

  async function set(id: string, deferred: boolean | null) {
    setError(null)
    try {
      const result = await api().capabilities.setDeferred({ id, deferred })
      if (!result.ok) setError(result.error || 'Failed to save')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      await onChanged()
    }
  }

  return (
    <div className="bg-zinc-950/40 border border-zinc-800 rounded-lg px-4 py-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm text-zinc-200">Catalog-only tools</span>
        <span className={`text-xs ${retrievalOn ? 'text-green-400' : 'text-zinc-500'}`}>
          {retrievalOn ? 'In effect' : 'Not in effect'}
        </span>
      </div>
      <p className="text-xs text-zinc-500 mb-2">
        A ticked capability's tools are left out of the assistant's tool list. It finds them by searching
        and calls them through call_tool, so the list never changes mid-conversation.
        {!retrievalOn && ' This applies only while tool retrieval is on.'}
      </p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        {entries.map((e) => (
          <label key={e.id} className="flex items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={e.deferred}
              onChange={(ev) => void set(e.id, ev.target.checked === e.byDefault ? null : ev.target.checked)}
            />
            <span>{e.name}{e.plugin ? ' (plugin)' : ''}</span>
            {e.overridden && <span className="text-zinc-500">(changed)</span>}
          </label>
        ))}
      </div>
      {error && <p className="text-xs text-red-400 mt-1.5">{error}</p>}
    </div>
  )
}
