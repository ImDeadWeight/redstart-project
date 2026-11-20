// =============================================================================
// Hugging Face browser — the body of the Model page's "Find models" popup.
// =============================================================================
// Nothing here reaches the network until Connect is pressed (useModelCatalog's
// rule). Shows FACTS, not a verdict: each download sits beside the machine's
// VRAM, RAM and free disk, and the person judges. See ModelSection's header
// for why there is no "will it fit" label.
// =============================================================================

import type { ModelCatalogHook } from '../hooks/useModelCatalog'
import type { HardwareSpecs, ModelArtifact } from '../types'
import { btnCls, inputCls } from '../components/ui'

const gb = (n: number | null | undefined) => typeof n === 'number' ? `${(n / 1024 ** 3).toFixed(1)} GB` : '—'
const compact = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n)
const params = (n: number | null) => !n ? null : n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : `${(n / 1e6).toFixed(0)}M`

export function HuggingFaceBrowser({ catalog, hardware }: { catalog: ModelCatalogHook; hardware: HardwareSpecs | null }) {
  const {
    catalogEnabled, connectCatalog,
    publishers, publisher, setPublisher, query, setQuery,
    models, searching, searchError, runSearch,
    detail, detailLoading, detailError, description, openModel, closeModel,
    disk, localNames,
    progress, downloading, downloadError, download, cancelDownload,
  } = catalog

  const hwLine = hardware ? [
    hardware.gpu.name
      ? `GPU ${(hardware.gpu.vram / 1024).toFixed(0)} GB${hardware.gpu.vramFree ? ` (${(hardware.gpu.vramFree / 1024).toFixed(1)} free)` : ''}`
      : null,
    `RAM ${hardware.memory.total.toFixed(0)} GB${hardware.memory.available ? ` (${hardware.memory.available.toFixed(0)} free)` : ''}`,
    disk.freeBytes ? `Disk ${gb(disk.freeBytes)} free` : null,
  ].filter(Boolean).join(' · ') : ''

  if (!catalogEnabled) {
    return (
      <div className="space-y-4 text-sm leading-relaxed text-zinc-300">
        <p>
          Redstart doesn&rsquo;t contact Hugging Face until you ask it to. Connecting fetches model listings
          over the internet. Nothing about your conversations is sent.
        </p>
        <button type="button" onClick={connectCatalog} className={btnCls.primary}>Connect to Hugging Face</button>
      </div>
    )
  }

  if (detailLoading) return <p className="text-sm text-zinc-400">Loading model details…</p>

  if (detail) {
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="break-all text-[15px] font-semibold text-zinc-100">{detail.repoId}</h3>
            <p className="mt-1 text-[13px] text-zinc-400">
              {[
                detail.architecture,
                params(detail.paramCount) && `${params(detail.paramCount)} parameters`,
                detail.experts && `${detail.experts.total} experts, ${detail.experts.active} active`,
                detail.contextLength && `${(detail.contextLength / 1024).toFixed(0)}K context`,
                detail.license,
              ].filter(Boolean).join(' · ')}
            </p>
          </div>
          <button type="button" onClick={closeModel} className={btnCls.secondary}>Back to results</button>
        </div>

        {description && (
          <div>
            <p className="whitespace-pre-line text-[13px] text-zinc-300">{description.text}</p>
            <p className="mt-1 text-[13px] text-zinc-500">
              {description.source === 'base_model'
                ? `From the model card of ${description.repoId}, which this build was quantized from.`
                : 'From this repository’s own model card, which may describe the conversion rather than the model.'}
            </p>
          </div>
        )}

        {detail.gated && (
          <p className="rounded-lg bg-amber-950/50 px-3 py-2 text-[13px] text-amber-200">
            This model is gated: it needs a Hugging Face account, which Redstart does not use. Download it yourself and put it in the models folder.
          </p>
        )}

        {hwLine && <p className="text-[13px] text-zinc-400">Your computer: <span className="text-zinc-200">{hwLine}</span></p>}
        {downloadError && <p className="text-[13px] text-red-400">{downloadError}</p>}

        <ul className="flex flex-col gap-2">
          {detail.artifacts.map(a => (
            <ArtifactRow
              key={a.id}
              artifact={a}
              gated={detail.gated}
              already={a.files.some(f => localNames.has((f.rfilename.split('/').pop() || '').toLowerCase()))}
              busy={downloading}
              active={progress?.artifactId === a.id && downloading}
              progress={progress?.artifactId === a.id ? progress : null}
              onDownload={() => download(a)}
              onCancel={cancelDownload}
            />
          ))}
        </ul>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {detailError && <p className="text-[13px] text-red-400">{detailError}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') runSearch() }}
          aria-label="Search Hugging Face"
          placeholder="Search all of Hugging Face for GGUF models…"
          className={`${inputCls.sm} min-w-[14rem] flex-1`}
        />
        <button type="button" onClick={() => runSearch()} className={btnCls.primary}>Search</button>
        {query && (
          <button type="button" onClick={() => { setQuery(''); runSearch({ query: '' }) }} className={btnCls.secondary}>Clear</button>
        )}
      </div>

      {/* Publisher tabs: the conversions the project already recommends. Raw
          Hub search is noisy, and dead repos rank well. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {publishers.map(p => (
          <button
            key={p.id}
            type="button"
            data-tip={p.note}
            onClick={() => { setPublisher(p.id); setQuery(''); runSearch({ publisher: p.id, query: '' }) }}
            className={`rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors ${
              !query && publisher === p.id ? 'bg-orange-500 text-zinc-950' : 'border border-zinc-700 text-zinc-300 hover:border-zinc-500'
            }`}>
            {p.label}
          </button>
        ))}
        {query && <span className="ml-1 text-[13px] text-zinc-500">searching all publishers</span>}
      </div>

      {searching && <p className="text-sm text-zinc-400">Loading…</p>}
      {searchError && <p className="text-sm text-red-400">{searchError}</p>}
      {!searching && !searchError && models.length === 0 && <p className="text-sm text-zinc-500">No GGUF models found.</p>}

      <ul className="flex flex-col gap-1.5">
        {models.map(m => (
          <li key={m.repoId}>
            <button type="button" onClick={() => openModel(m.repoId)}
              className="w-full rounded-xl border border-zinc-800 bg-zinc-950/40 px-3.5 py-2.5 text-left transition-colors hover:border-zinc-600">
              <div className="flex items-baseline gap-2">
                <span className="break-all text-sm text-zinc-100">{m.repoId}</span>
                {m.gated && <span className="shrink-0 text-xs text-amber-300">gated</span>}
                <span className="ml-auto shrink-0 text-xs text-zinc-500">↓ {compact(m.downloads)}</span>
              </div>
              {m.quants.length > 0 && (
                <div className="mt-0.5 text-[13px] text-zinc-500">
                  {m.quants.slice(0, 8).join(' · ')}{m.quants.length > 8 ? ` +${m.quants.length - 8}` : ''}
                </div>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ArtifactRow({ artifact, gated, already, busy, active, progress, onDownload, onCancel }: {
  artifact: ModelArtifact
  gated: boolean
  already: boolean
  busy: boolean
  active: boolean
  progress: { receivedBytes?: number; totalBytes?: number; bytesPerSec?: number; state?: string } | null
  onDownload: () => void
  onCancel: () => void
}) {
  const pct = active && progress?.totalBytes
    ? Math.min(100, Math.round(((progress.receivedBytes || 0) / progress.totalBytes) * 100))
    : 0

  return (
    <li className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-3.5 py-2.5">
      <div className="flex flex-wrap items-center gap-3">
        <span className={`w-32 shrink-0 text-sm ${artifact.quantRecognized ? 'text-zinc-100' : 'text-zinc-400'}`}>{artifact.quantLabel}</span>
        <span className="w-20 shrink-0 text-[13px] text-zinc-300">{gb(artifact.totalBytes)}</span>
        <span className="min-w-[10rem] flex-1 text-[13px] text-zinc-500">
          {artifact.shardTotal > 1 && `${artifact.shardTotal} files · `}
          {/* A published checksum is the difference between a verified download
              and a hopeful one, so its absence is stated rather than hidden. */}
          {artifact.verifiable ? 'checked against its sha256 on download' : 'no checksum published'}
          {!artifact.complete && <span className="text-amber-300"> · file set incomplete on Hugging Face</span>}
          {artifact.projector && <span data-tip={`${artifact.projector.rfilename} is downloaded with it and loaded with --mmproj`}> · + vision projector ({gb(artifact.projector.size)})</span>}
        </span>
        {already ? (
          <span className="shrink-0 text-[13px] font-medium text-green-400">Downloaded</span>
        ) : active ? (
          <button type="button" onClick={onCancel} className={btnCls.secondary}>Cancel</button>
        ) : (
          <button type="button" onClick={onDownload} disabled={busy || gated || !artifact.complete} className={btnCls.primary}>Download</button>
        )}
      </div>
      {active && (
        <div className="mt-2">
          <div className="h-1.5 overflow-hidden rounded bg-zinc-800" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-orange-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1 text-[13px] text-zinc-400">
            {pct}% — {gb(progress?.receivedBytes)} of {gb(progress?.totalBytes)}
            {progress?.bytesPerSec ? ` · ${(progress.bytesPerSec / 1024 ** 2).toFixed(1)} MB/s` : ''}
          </p>
        </div>
      )}
    </li>
  )
}
