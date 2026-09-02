// =============================================================================
// Models tab — browse Hugging Face, download GGUFs into the models folder.
// =============================================================================
// Deliberately shows FACTS, not a verdict. Each artifact row carries its size
// next to the machine's VRAM/RAM/free disk and lets the user judge. A
// traffic-light "will this fit" indicator would need a memory estimator that
// llama-server's own --fit already does better at load time, and that would be
// confidently wrong on MoE offload and on non-NVIDIA GPUs (where the VRAM
// figure itself is capped at 4 GB by a Windows API quirk).
//
// Downloading does not change the running configuration. The model is selected
// via the "Select .gguf File" button in the Selected Model section below,
// which opens in this folder. Hardware scan and profile generation moved in
// here too (from the old sidebar) — this is where "will it fit" questions
// actually get asked, ahead of a future revamp that puts a real fit estimate
// next to each artifact using the scanned specs.
// =============================================================================

import { useEffect } from 'react'
import { SectionTitle, btnCls, inputCls } from '../components/ui'
import { FolderPicker } from '../components/FolderPicker'
import { HardwarePanel } from '../panels/HardwarePanel'
import { ModelPanel } from '../panels/ModelPanel'
import type { useHardwareAndBinary } from '../hooks/useHardwareAndBinary'
import type { ModelCatalogHook } from '../hooks/useModelCatalog'
import type { ModelArtifact } from '../types'

function gb(bytes: number | null | undefined) {
  if (typeof bytes !== 'number') return '—'
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function compact(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`
  return String(n)
}

function params(n: number | null) {
  if (!n) return null
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : `${(n / 1e6).toFixed(0)}M`
}

export function ModelsTab({ catalog, hw, modelPath, onGenerateDefaultProfiles }: {
  catalog: ModelCatalogHook
  hw: ReturnType<typeof useHardwareAndBinary>
  modelPath: string
  onGenerateDefaultProfiles: () => void
}) {
  const { hardware, applyModelPath } = hw
  const {
    catalogEnabled, connectCatalog, openTab,
    publishers, publisher, setPublisher, query, setQuery,
    models, searching, searchError, runSearch,
    detail, detailLoading, detailError, openModel, closeModel,
    modelsDir, localFiles, disk, localNames,
    changeFolder, deleteLocal,
    progress, downloading, downloadError, download, cancelDownload,
  } = catalog

  // Local disk only. The Hub is not contacted until Connect is clicked.
  useEffect(() => { openTab() }, [openTab])

  // One line of machine context, repeated under each artifact so the
  // comparison is always in view rather than scrolled away at the top.
  const hwLine = hardware ? [
    hardware.gpu.name
      ? `GPU ${(hardware.gpu.vram / 1024).toFixed(0)} GB${hardware.gpu.vramFree ? ` (${(hardware.gpu.vramFree / 1024).toFixed(1)} free)` : ''}`
      : null,
    `RAM ${hardware.memory.total.toFixed(0)} GB${hardware.memory.available ? ` (${hardware.memory.available.toFixed(0)} free)` : ''}`,
    disk.freeBytes ? `Disk ${gb(disk.freeBytes)} free` : null,
  ].filter(Boolean).join(' · ') : ''

  return (
    <div className="flex flex-col gap-5">

      {/* ── Hardware + selected model (moved in from the old sidebar) ── */}
      <HardwarePanel hw={hw} onGenerateDefaults={onGenerateDefaultProfiles} />
      <ModelPanel modelPath={modelPath} onSelectModel={applyModelPath} />

      {/* ── Storage ── */}
      <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <SectionTitle>Model storage</SectionTitle>
        <div className="flex items-center gap-2 mb-2">
          <code className="flex-1 text-xs text-zinc-400 break-all bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5">
            {modelsDir || '—'}
          </code>
          <FolderPicker
            mode="directory"
            allowCreate
            title="Select the models folder"
            startPath={modelsDir || undefined}
            onPick={changeFolder}
            className={btnCls.secondary}>
            Change…
          </FolderPicker>
          {/* Reveal-in-explorer retired in Phase 6 §6.1 — opening a
              file-explorer window is inherently local to whichever machine
              runs it, and there is no longer a channel that can tell "the
              caller is sitting at this machine" from "the caller is a
              browser anywhere on the network" to gate it on. A copy button
              for the path shown above, for every caller alike. */}
          <button onClick={() => navigator.clipboard?.writeText(modelsDir || '')} className={btnCls.secondary}>Copy path</button>
        </div>
        <p className="text-xs text-zinc-500">
          {disk.freeBytes !== undefined
            ? <>{gb(disk.freeBytes)} free of {gb(disk.totalBytes)} on this drive.</>
            : 'Checking free space…'}
          {' '}Downloaded models are selected with <span className="text-zinc-400">Select .gguf File</span> above.
        </p>

        {localFiles.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1">
            {localFiles.map(f => (
              <li key={f.name} className="flex items-center gap-2 text-xs">
                <span className={`flex-1 break-all ${f.partial ? 'text-amber-400' : 'text-zinc-300'}`}>
                  {f.name}
                  {f.partial && <span className="text-zinc-500"> — incomplete download</span>}
                </span>
                <span className="text-zinc-500 shrink-0">{gb(f.size)}</span>
                <button onClick={() => deleteLocal(f.name)} className={btnCls.subtle}>Delete</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Browse ── */}
      {!detail && !catalogEnabled && (
        <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <SectionTitle>Browse Hugging Face</SectionTitle>
          <p className="text-xs text-zinc-500 mb-3 leading-relaxed">
            Redstart does not contact Hugging Face until you ask it to. Nothing above this
            point leaves the machine — the storage list is read from your own disk.
            Connecting fetches model listings over the internet.
          </p>
          <button onClick={connectCatalog} className={btnCls.primary}>
            Connect to Hugging Face
          </button>
        </section>
      )}

      {!detail && catalogEnabled && (
        <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <SectionTitle>Browse Hugging Face</SectionTitle>

          <div className="flex items-center gap-2 mb-3">
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') runSearch() }}
              placeholder="Search all of Hugging Face for GGUF models…"
              className={inputCls.sm}
            />
            <button onClick={() => runSearch()} className={btnCls.primary}>Search</button>
            {query && (
              <button
                onClick={() => { setQuery(''); runSearch({ query: '' }) }}
                className={btnCls.secondary}>Clear</button>
            )}
          </div>

          {/* Publisher tabs. These are the conversions the project already
              recommends; raw Hub search is noisy and dead repos rank well. */}
          <div className="flex items-center gap-1 mb-3 flex-wrap">
            {publishers.map(p => (
              <button
                key={p.id}
                title={p.note}
                onClick={() => { setPublisher(p.id); setQuery(''); runSearch({ publisher: p.id, query: '' }) }}
                className={`px-2.5 py-1 rounded text-xs transition-colors ${
                  !query && publisher === p.id
                    ? 'bg-orange-500 text-white'
                    : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}>
                {p.label}
              </button>
            ))}
            {query && <span className="text-xs text-zinc-600 ml-1">searching all publishers</span>}
          </div>

          {searching && <p className="text-xs text-zinc-500">Loading…</p>}
          {searchError && <p className="text-xs text-red-400">{searchError}</p>}
          {!searching && !searchError && models.length === 0 && (
            <p className="text-xs text-zinc-500">No GGUF models found.</p>
          )}

          <ul className="flex flex-col gap-1">
            {models.map(m => (
              <li key={m.repoId}>
                <button
                  onClick={() => openModel(m.repoId)}
                  className="w-full text-left px-3 py-2 rounded bg-zinc-950 border border-zinc-800 hover:border-zinc-700 transition-colors">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm text-zinc-200 break-all">{m.repoId}</span>
                    {m.gated && <span className="text-xs text-amber-400 shrink-0">gated</span>}
                    <span className="ml-auto text-xs text-zinc-600 shrink-0">↓ {compact(m.downloads)}</span>
                  </div>
                  {m.quants.length > 0 && (
                    <div className="text-xs text-zinc-500 mt-0.5">
                      {m.quants.slice(0, 8).join(' · ')}{m.quants.length > 8 ? ` +${m.quants.length - 8}` : ''}
                    </div>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── Detail ── */}
      {detailLoading && <p className="text-xs text-zinc-500">Loading model details…</p>}
      {detailError && <p className="text-xs text-red-400">{detailError}</p>}

      {detail && (
        <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <div className="flex items-start gap-3 mb-3">
            <div className="flex-1">
              <h3 className="text-sm text-zinc-100 break-all">{detail.repoId}</h3>
              <p className="text-xs text-zinc-500 mt-1">
                {[
                  detail.architecture,
                  params(detail.paramCount) && `${params(detail.paramCount)} params`,
                  detail.experts && `${detail.experts.total} experts, ${detail.experts.active} active`,
                  detail.contextLength && `${(detail.contextLength / 1024).toFixed(0)}k context`,
                  detail.license,
                ].filter(Boolean).join(' · ')}
              </p>
            </div>
            <button onClick={closeModel} className={btnCls.secondary}>Back</button>
          </div>

          {detail.gated && (
            <p className="text-xs text-amber-400 mb-3">
              This model is gated — it requires a Hugging Face account, which Redstart does not use.
              Download it manually and place it in the models folder.
            </p>
          )}

          {hwLine && (
            <p className="text-xs text-zinc-500 mb-2">Your machine: <span className="text-zinc-400">{hwLine}</span></p>
          )}

          {downloadError && <p className="text-xs text-red-400 mb-2">{downloadError}</p>}

          <ul className="flex flex-col gap-1">
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
        </section>
      )}
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
    <li className="px-3 py-2 rounded bg-zinc-950 border border-zinc-800">
      <div className="flex items-center gap-3">
        <span className={`text-sm shrink-0 w-32 ${artifact.quantRecognized ? 'text-zinc-200' : 'text-zinc-400'}`}>
          {artifact.quantLabel}
        </span>
        <span className="text-xs text-zinc-400 shrink-0 w-20">{gb(artifact.totalBytes)}</span>
        <span className="text-xs text-zinc-600 flex-1">
          {artifact.shardTotal > 1 && `${artifact.shardTotal} files · `}
          {/* A published checksum is the difference between a verified download
              and a hopeful one, so its absence is stated rather than hidden. */}
          {artifact.verifiable ? 'sha256 verified on download' : 'no checksum published'}
          {!artifact.complete && <span className="text-amber-400"> · file set incomplete on Hugging Face</span>}
        </span>

        {already ? (
          <span className="text-xs text-green-400 shrink-0">Downloaded</span>
        ) : active ? (
          <button onClick={onCancel} className={btnCls.secondary}>Cancel</button>
        ) : (
          <button
            onClick={onDownload}
            disabled={busy || gated || !artifact.complete}
            className={`${btnCls.primary} disabled:opacity-40 disabled:cursor-not-allowed`}>
            Download
          </button>
        )}
      </div>

      {active && (
        <div className="mt-2">
          <div className="h-1 bg-zinc-800 rounded overflow-hidden">
            <div className="h-full bg-orange-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-xs text-zinc-500 mt-1">
            {pct}% — {gb(progress?.receivedBytes)} of {gb(progress?.totalBytes)}
            {progress?.bytesPerSec ? ` · ${(progress.bytesPerSec / 1024 ** 2).toFixed(1)} MB/s` : ''}
          </p>
        </div>
      )}
    </li>
  )
}
