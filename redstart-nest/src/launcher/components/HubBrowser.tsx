// =============================================================================
// HubBrowser — the explorer layout shared by both Hugging Face browsers.
// =============================================================================
// Approved as a mockup on 2026-11-24 ("Option A"), the same treatment the file
// explorer got (FolderPicker.tsx):
//   - a sidebar of where to look: the recommended publishers, then all of
//     Hugging Face, then "show only" switches;
//   - a search box that says where it is searching ("in Unsloth ×"): a term
//     searches INSIDE the chosen publisher, and the × widens it to everyone;
//     picking a publisher keeps the term;
//   - results that sort by downloads, likes or last update;
//   - the opened model beside the list, never in place of it (on a narrow
//     window it does replace the list, with a Back button);
//   - the machine's GPU, RAM and free disk in the header the whole time, and
//     each file's size drawn against them: a fact, not a "will it fit"
//     verdict (see ModelSection's header).
// Both browsers (HuggingFaceBrowser, ImageModelBrowser) own their data; this
// file is layout only.
// =============================================================================

import { useEffect, useRef } from 'react'
import type { HardwareSpecs, SearchSort } from '../types'

export const fmtSize = (n: number | null | undefined) =>
  typeof n === 'number' ? (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`) : '—'
export const fmtCount = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n)
export function fmtAgo(iso: string | null) {
  if (!iso) return ''
  const days = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 86_400_000))
  if (Number.isNaN(days)) return ''
  return days < 1 ? 'today' : days < 31 ? `${days} d ago` : days < 365 ? `${Math.round(days / 30)} mo ago` : `${Math.round(days / 365)} yr ago`
}

/** Runs `fn` once `value` has stopped changing for `ms`. Not on the first render. */
export function useDebouncedEffect(fn: () => void, deps: unknown[], ms = 400) {
  const first = useRef(true)
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => {
    if (first.current) { first.current = false; return }
    const t = setTimeout(() => fnRef.current(), ms)
    return () => clearTimeout(t)
  }, deps)
}

// --- Header: the machine's facts --------------------------------------------

export function HardwareFacts({ hardware, diskFreeBytes }: { hardware: HardwareSpecs | null; diskFreeBytes?: number }) {
  const facts = [
    hardware?.gpu.name
      ? `GPU ${hardware.gpu.unifiedMemory ? 'up to ' : ''}${(hardware.gpu.vram / 1024).toFixed(0)} GB${hardware.gpu.unifiedMemory ? ' (shared)' : ''}`
      : null,
    hardware ? `RAM ${hardware.memory.total.toFixed(0)} GB${hardware.memory.available ? ` · ${hardware.memory.available.toFixed(0)} free` : ''}` : null,
    diskFreeBytes ? `Disk ${fmtSize(diskFreeBytes)} free` : null,
  ].filter(Boolean) as string[]
  if (!facts.length) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-300">
      <span className="mr-0.5 text-zinc-400">Your computer</span>
      {facts.map(f => <span key={f} className="rounded-full bg-zinc-800 px-2.5 py-1">{f}</span>)}
    </div>
  )
}

// --- The three panes ----------------------------------------------------------

export function HubLayout({ sidebar, results, detail, detailOpen, onBack, footer }: {
  sidebar: React.ReactNode
  results: React.ReactNode
  detail: React.ReactNode
  /** On a narrow window the detail replaces the results while open. */
  detailOpen: boolean
  onBack: () => void
  footer: React.ReactNode
}) {
  return (
    <div className="flex h-[min(44rem,calc(100vh-9rem))] min-h-0 flex-col">
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Where to look" className="hidden w-56 shrink-0 flex-col gap-1 overflow-y-auto border-r border-zinc-800 bg-zinc-950/40 px-2.5 py-3.5 md:flex">
          {sidebar}
        </nav>
        <section aria-label="Results" className={`min-w-0 flex-1 flex-col ${detailOpen ? 'hidden lg:flex' : 'flex'}`}>
          {results}
        </section>
        <aside aria-label="Model details" className={`min-h-0 w-full shrink-0 flex-col border-zinc-800 bg-zinc-950/40 lg:w-[25rem] lg:border-l ${detailOpen ? 'flex' : 'hidden lg:flex'}`}>
          {detailOpen && (
            <button type="button" onClick={onBack} className="flex items-center gap-1.5 border-b border-zinc-800 px-4 py-2.5 text-left text-sm text-orange-400 hover:text-orange-300 lg:hidden">
              <span aria-hidden="true">‹</span> Back to results
            </button>
          )}
          {detail}
        </aside>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-zinc-800 px-5 py-3">{footer}</div>
    </div>
  )
}

// --- Sidebar ------------------------------------------------------------------

export function SidebarHeading({ children }: { children: React.ReactNode }) {
  return <div className="px-2.5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-zinc-400 first:pt-1">{children}</div>
}

export function SidebarItem({ label, note, active, onClick }: { label: string; note?: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-current={active ? 'true' : undefined}
      className={`flex w-full flex-col items-start rounded-lg px-2.5 py-1.5 text-left transition-colors ${active ? 'bg-orange-950/70 text-orange-100' : 'text-zinc-200 hover:bg-zinc-800/70'}`}>
      <span className="text-[13px] font-medium">{label}</span>
      {note && <span className={`text-[11.5px] leading-snug ${active ? 'text-orange-300' : 'text-zinc-400'}`}>{note}</span>}
    </button>
  )
}

export function SidebarSwitch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 px-2.5 py-1 text-[13px] text-zinc-200">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="h-[15px] w-[15px] accent-orange-500" />
      {label}
    </label>
  )
}

/** A publisher <select> standing in for the sidebar on a narrow window. */
export function ScopeSelect({ options, value, onChange }: { options: { id: string; label: string }[]; value: string; onChange: (id: string) => void }) {
  return (
    <select aria-label="Where to look" value={value} onChange={e => onChange(e.target.value)}
      className="h-9 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 text-[13px] text-zinc-100 md:hidden">
      {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  )
}

// --- Search bar ---------------------------------------------------------------

export function HubSearchBar({ scopes, query, onQuery, onSubmit, placeholder, sort, onSort, children }: {
  /** Chips inside the box saying where it searches; each × widens it. */
  scopes: { label: string; tone?: 'publisher' | 'family'; onClear: () => void }[]
  query: string
  onQuery: (q: string) => void
  onSubmit: () => void
  placeholder: string
  sort: SearchSort
  onSort: (s: SearchSort) => void
  /** The narrow-window scope <select>. */
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 px-4 pb-2.5 pt-3.5">
      {children}
      <label className="flex h-[38px] min-w-[14rem] flex-1 items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950 pl-2.5 pr-1.5 focus-within:border-orange-500">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="shrink-0 text-zinc-400" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></svg>
        {scopes.map(s => (
          <button key={s.label} type="button" onClick={s.onClear} aria-label={`Stop searching only ${s.label}`} data-tip="Search everywhere instead"
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md py-0.5 pl-2 pr-1.5 text-[12.5px] font-medium ${s.tone === 'family' ? 'bg-slate-800 text-blue-200' : 'bg-orange-950 text-orange-300'}`}>
            {s.tone === 'family' ? s.label : `in ${s.label}`}
            <svg width="9" height="9" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" /></svg>
          </button>
        ))}
        <input value={query} onChange={e => onQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') onSubmit() }}
          aria-label="Search models" placeholder={placeholder}
          className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500" />
        {query && (
          <button type="button" onClick={() => onQuery('')} aria-label="Clear the search"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
            <svg width="9" height="9" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" /></svg>
          </button>
        )}
      </label>
      <label className="flex items-center gap-2 text-[13px] text-zinc-400">
        Sort
        <select value={sort} onChange={e => onSort(e.target.value as SearchSort)}
          className="h-[38px] rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 text-[13px] text-zinc-100">
          <option value="downloads">Most downloaded</option>
          <option value="likes">Most liked</option>
          <option value="updated">Recently updated</option>
        </select>
      </label>
    </div>
  )
}

// --- Results table --------------------------------------------------------------

export const RESULT_COLS = 'grid grid-cols-[minmax(0,1fr)_9.5rem_4.5rem_5rem] gap-3'

export function ResultHeader({ second }: { second: string }) {
  return (
    <div className={`${RESULT_COLS} border-y border-zinc-800 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400`}>
      <span>Model</span><span>{second}</span><span className="text-right">Downloads</span><span className="text-right">Updated</span>
    </div>
  )
}

export function ResultRow({ active, onClick, disabled, tip, title, tags, second, downloads, updated }: {
  active: boolean
  onClick: () => void
  disabled?: boolean
  tip?: string
  title: string
  tags: React.ReactNode
  second: React.ReactNode
  downloads: number
  updated: string | null
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} data-tip={tip} aria-current={active ? 'true' : undefined}
      className={`${RESULT_COLS} my-0.5 w-full items-center rounded-lg border px-2 py-2 text-left transition-colors disabled:opacity-50 ${active ? 'border-orange-500/60 bg-orange-500/[0.08]' : 'border-transparent hover:bg-zinc-800/60'}`}>
      <span className="min-w-0">
        <span className="block break-all text-[13.5px] font-medium leading-snug text-zinc-100">{title}</span>
        <span className="mt-0.5 flex flex-wrap gap-x-1.5 text-[11.5px] text-zinc-400">{tags}</span>
      </span>
      <span className="truncate font-mono text-xs text-zinc-300">{second}</span>
      <span className="text-right text-[12.5px] text-zinc-300">{fmtCount(downloads)}</span>
      <span className="text-right text-[12.5px] text-zinc-400">{fmtAgo(updated)}</span>
    </button>
  )
}

/** "Q2_K – Q8_0 · 14": the range a repo offers, before it is opened. */
export function quantRange(quants: string[]) {
  if (!quants.length) return '—'
  return quants.length === 1 ? quants[0] : `${quants[0]} – ${quants[quants.length - 1]} · ${quants.length}`
}

// --- Detail pieces --------------------------------------------------------------

export function FactChips({ facts }: { facts: (string | number | null | undefined | false)[] }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11.5px]">
      {facts.filter(Boolean).map(f => <span key={String(f)} className="rounded-md bg-zinc-800 px-2 py-0.5 text-zinc-300">{f}</span>)}
    </div>
  )
}

/**
 * A file's size against the machine's memory: the bar runs to the RAM total,
 * and the tick marks the GPU's memory. On Apple Silicon both are one pool, so
 * the tick is the share the GPU may use.
 */
export function MemoryBar({ bytes, hardware }: { bytes: number | null; hardware: HardwareSpecs | null }) {
  if (!hardware || !bytes || !hardware.memory.total) return null
  const scale = hardware.memory.total * 1024 ** 3
  const gpu = hardware.gpu.name ? Math.min(100, (hardware.gpu.vram * 1024 ** 2) / scale * 100) : null
  const pct = Math.min(100, bytes / scale * 100)
  return (
    <div className="relative mt-1.5 h-1.5 rounded bg-zinc-800" aria-hidden="true">
      <div className={`absolute inset-y-0 left-0 rounded ${bytes > scale ? 'bg-zinc-500' : 'bg-orange-400'}`} style={{ width: `${pct}%` }} />
      {gpu !== null && <div className="absolute -inset-y-[3px] w-0.5 bg-zinc-200" style={{ left: `${gpu}%` }} />}
    </div>
  )
}

export function MemoryScale({ hardware }: { hardware: HardwareSpecs | null }) {
  if (!hardware?.memory.total) return null
  const gpuGb = hardware.gpu.name ? hardware.gpu.vram / 1024 : null
  const gpuPct = gpuGb !== null ? Math.min(100, gpuGb / hardware.memory.total * 100) : null
  return (
    <div className="relative mx-2 mt-1 h-4 text-[10.5px] text-zinc-400">
      <span className="absolute left-0">0</span>
      {gpuPct !== null && gpuPct < 85 && gpuPct > 8 && <span className="absolute -translate-x-1/2" style={{ left: `${gpuPct}%` }}>GPU {gpuGb!.toFixed(0)} GB</span>}
      <span className="absolute right-0">RAM {hardware.memory.total.toFixed(0)} GB</span>
    </div>
  )
}

/** One download at a time, shown in the footer wherever the person is. */
export function DownloadTray({ label, pct, detail, onCancel }: { label: string; pct: number; detail?: string; onCancel: () => void }) {
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-orange-400" aria-hidden="true"><path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M3 13.5h10" /></svg>
      <span className="min-w-0 truncate text-[13px] text-zinc-100">{label}</span>
      <div className="h-1.5 w-40 shrink-0 overflow-hidden rounded bg-zinc-800" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full bg-orange-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="whitespace-nowrap text-[12.5px] text-zinc-400">{pct}%{detail ? ` · ${detail}` : ''}</span>
      <button type="button" onClick={onCancel} className="rounded-md border border-zinc-700 px-2.5 py-1 text-[12.5px] text-zinc-100 hover:border-zinc-500 hover:bg-zinc-800">Cancel</button>
    </div>
  )
}

export function PaneMessage({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-1 items-center justify-center p-6 text-center text-[13px] text-zinc-400">{children}</div>
}
