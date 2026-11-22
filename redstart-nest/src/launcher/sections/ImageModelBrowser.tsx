// =============================================================================
// Image model browser — the body of the Images page's "Find on Hugging Face".
// =============================================================================
// The image counterpart of HuggingFaceBrowser (the chat model's), on purpose
// the same shape: publisher tabs and a search box; results that list each
// repo's quants; a repo opened to one row per file with its size, its checksum
// and its own Download button, beside the machine's VRAM and free disk. Facts,
// not a "will it fit" verdict (see ModelSection's header).
//
// What is image-specific: the FAMILY, read from the model card and shown up
// front, because it decides which shared files come along (FLUX's text
// encoders and VAE, once per family) and whether Nest can run the model at all.
// Nothing reaches the network until a tab or Search is pressed.
// =============================================================================

import { useState } from 'react'
import { getAPI } from '../api/redstart'
import type { HardwareSpecs, ImageCatalogModel, ImageGenerationStatus, ImageRepoDetail, ImageTransferProgress } from '../types'
import { btnCls, inputCls } from '../components/ui'

const size = (n: number | null | undefined) => typeof n === 'number' ? (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`) : '—'
const compact = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n)
const pct = (p: ImageTransferProgress | null) => p?.totalBytes ? Math.min(100, Math.round(((p.receivedBytes ?? 0) / p.totalBytes) * 100)) : 0

export function ImageModelBrowser({ status, hardware, diskFreeBytes, progress, onDownload, onCancel }: {
  status: ImageGenerationStatus
  hardware: HardwareSpecs | null
  diskFreeBytes?: number
  progress: ImageTransferProgress | null
  onDownload: (req: { repoId: string; rfilename: string; family: string }) => void
  onCancel: () => void
}) {
  const api = getAPI()
  const [publisher, setPublisher] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ImageCatalogModel[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [repo, setRepo] = useState<ImageRepoDetail | null>(null)
  const [loadingRepo, setLoadingRepo] = useState(false)
  const [family, setFamily] = useState('')

  async function search(opts: { query?: string; publisher?: string | null }) {
    if (!api) return
    setSearching(true); setError(null)
    const r = await api.capabilities.searchImageModels({ query: opts.query ?? '', publisher: opts.publisher ?? '' })
    setResults(r.results); if (!r.ok) setError(r.error ?? 'Search failed')
    setSearching(false)
  }

  async function open(repoId: string) {
    if (!api) return
    setLoadingRepo(true); setError(null)
    const r = await api.capabilities.imageRepo(repoId)
    setLoadingRepo(false)
    if (!r.ok) { setError(r.error ?? 'Could not open that model'); return }
    setRepo(r)
    setFamily(r.family ?? '')
  }

  const hwLine = [
    hardware?.gpu.name ? `GPU ${hardware.gpu.unifiedMemory ? 'up to ' : ''}${(hardware.gpu.vram / 1024).toFixed(0)} GB${hardware.gpu.unifiedMemory ? ' (shared with RAM)' : ''}` : null,
    hardware ? `RAM ${hardware.memory.total.toFixed(0)} GB` : null,
    diskFreeBytes ? `Disk ${size(diskFreeBytes)} free` : null,
  ].filter(Boolean).join(' · ')

  if (loadingRepo) return <p className="text-sm text-zinc-400">Loading model details…</p>

  // ── One repo ──
  if (repo) {
    const fam = status.families.find(f => f.id === family)
    // The family's shared files are already here if any model of it is ready.
    const haveShared = status.models.some(m => m.family === family && m.ready)
    const sharedBytes = fam && !haveShared ? fam.companionBytes : 0
    const downloaded = new Set(status.models.filter(m => m.repoId === repo.repoId).map(m => m.rfilename))
    const busy = !!status.downloading

    return (
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="break-all text-[15px] font-semibold text-zinc-100">{repo.repoId}</h3>
            <p className="mt-1 text-[13px] text-zinc-400">
              {[repo.family ? status.families.find(f => f.id === repo.family)?.label : 'Family not stated', repo.license, `↓ ${compact(repo.downloads)}`].filter(Boolean).join(' · ')}
            </p>
          </div>
          <button type="button" onClick={() => setRepo(null)} className={btnCls.secondary}>Back to results</button>
        </div>

        {repo.description && (
          <div>
            <p className="whitespace-pre-line text-[13px] text-zinc-300">{repo.description.text}</p>
            <p className="mt-1 text-[13px] text-zinc-500">
              {repo.description.source === 'base_model'
                ? `From the model card of ${repo.description.repoId}, which these files were converted from.`
                : 'From this repository’s own model card, which may describe the conversion rather than the model.'}
            </p>
          </div>
        )}

        {repo.gated && (
          <p className="rounded-lg bg-amber-950/50 px-3 py-2 text-[13px] text-amber-200">
            This model is gated: it needs a Hugging Face account, which Redstart does not use. Look for a copy of it that is not.
          </p>
        )}

        <label className="flex flex-wrap items-center gap-3 text-[13px] text-zinc-400">
          Family
          <select value={family} onChange={e => setFamily(e.target.value)} className={`${inputCls.sm} w-auto`}>
            <option value="">Choose…</option>
            {status.families.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
          <span className="text-zinc-500">
            {repo.family
              ? 'Read from the model card.'
              : 'The card does not name a family Nest knows (FLUX.1, SDXL, SD 1.x). Choose one only if you know it is; otherwise the engine will refuse the file.'}
          </span>
        </label>
        {fam && <p className="text-[13px] text-zinc-400">{fam.note}{sharedBytes ? ` Its shared files (${size(sharedBytes)}) come with the first ${fam.label} model, once.` : ' Its shared files are already here.'}</p>}

        {hwLine && <p className="text-[13px] text-zinc-400">Your computer: <span className="text-zinc-200">{hwLine}</span></p>}
        {error && <p className="text-[13px] text-red-400">{error}</p>}

        {repo.files.length === 0 && <p className="text-sm text-zinc-500">No single-file .gguf or .safetensors weights in this repository.</p>}
        <ul className="flex flex-col gap-2">
          {repo.files.map(f => {
            const active = status.downloading?.repoId === repo.repoId && status.downloading.rfilename === f.rfilename
            const already = downloaded.has(f.rfilename)
            return (
              <li key={f.rfilename} className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-3.5 py-2.5">
                <div className="flex flex-wrap items-center gap-3">
                  <span className={`w-32 shrink-0 text-sm ${f.quantRecognized ? 'text-zinc-100' : 'text-zinc-400'}`}>{f.quantLabel}</span>
                  <span className="w-20 shrink-0 text-[13px] text-zinc-300">{size(f.size)}</span>
                  <span className="min-w-[10rem] flex-1 text-[13px] text-zinc-500">
                    {f.sha256 ? 'checked against its sha256 on download' : 'no checksum published'}
                    {sharedBytes > 0 && f.size ? ` · ${size(f.size + sharedBytes)} with the shared files` : ''}
                  </span>
                  {already ? (
                    <span className="shrink-0 text-[13px] font-medium text-green-400">Downloaded</span>
                  ) : active ? (
                    <button type="button" onClick={onCancel} className={btnCls.secondary}>Cancel</button>
                  ) : (
                    <button type="button" onClick={() => onDownload({ repoId: repo.repoId, rfilename: f.rfilename, family })}
                      disabled={busy || repo.gated || !family} className={btnCls.primary}
                      data-tip={!family ? 'Choose the family first' : busy ? 'One download at a time' : undefined}>
                      Download
                    </button>
                  )}
                </div>
                {active && (
                  <div className="mt-2">
                    <div className="h-1.5 overflow-hidden rounded bg-zinc-800"><div className="h-full bg-orange-500 transition-all" style={{ width: `${pct(progress)}%` }} /></div>
                    <p className="mt-1 text-[12px] text-zinc-500">{pct(progress)}%{progress?.file ? ` · ${progress.file}` : ''}{progress?.totalBytes ? ` · ${size(progress.receivedBytes)} of ${size(progress.totalBytes)}` : ''}</p>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    )
  }

  // ── Search ──
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { setPublisher(null); search({ query }) } }}
          aria-label="Search Hugging Face for image models"
          placeholder="Search Hugging Face for image models (flux schnell gguf, sdxl…)"
          className={`${inputCls.sm} min-w-[14rem] flex-1`}
        />
        <button type="button" onClick={() => { setPublisher(null); search({ query }) }} className={btnCls.primary}>Search</button>
        {query && <button type="button" onClick={() => { setQuery(''); setResults(null) }} className={btnCls.secondary}>Clear</button>}
      </div>

      {/* Publisher tabs: converters whose files stable-diffusion.cpp loads. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {status.publishers.map(p => (
          <button key={p.id} type="button" data-tip={p.note}
            onClick={() => { setPublisher(p.id); setQuery(''); search({ publisher: p.id }) }}
            className={`rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors ${
              !query && publisher === p.id ? 'bg-orange-500 text-zinc-950' : 'border border-zinc-700 text-zinc-300 hover:border-zinc-500'
            }`}>
            {p.label}
          </button>
        ))}
        {query && results && <span className="ml-1 text-[13px] text-zinc-500">searching all publishers</span>}
      </div>

      {results === null && !searching && (
        <p className="text-[13px] text-zinc-500">Pick a publisher or search. Nest contacts Hugging Face only when you do. FLUX.1 schnell is a good first choice: Apache-2.0, four steps per picture.</p>
      )}
      {searching && <p className="text-sm text-zinc-400">Loading…</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
      {!searching && results?.length === 0 && <p className="text-sm text-zinc-500">No text-to-image models found.</p>}

      <ul className="flex flex-col gap-1.5">
        {(results ?? []).map(m => (
          <li key={m.repoId}>
            <button type="button" onClick={() => open(m.repoId)} disabled={m.weightFileCount === 0}
              className="w-full rounded-xl border border-zinc-800 bg-zinc-950/40 px-3.5 py-2.5 text-left transition-colors hover:border-zinc-600 disabled:opacity-50"
              data-tip={m.weightFileCount === 0 ? 'No single-file weights Nest can use (a diffusers folder only)' : undefined}>
              <div className="flex items-baseline gap-2">
                <span className="break-all text-sm text-zinc-100">{m.repoId}</span>
                {m.gated && <span className="shrink-0 text-xs text-amber-300">gated</span>}
                <span className="ml-auto shrink-0 text-xs text-zinc-500">↓ {compact(m.downloads)}</span>
              </div>
              <div className="mt-0.5 text-[13px] text-zinc-500">
                {m.quants.length > 0
                  ? <>{m.quants.slice(0, 8).join(' · ')}{m.quants.length > 8 ? ` +${m.quants.length - 8}` : ''}</>
                  : 'no single-file weights'}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
