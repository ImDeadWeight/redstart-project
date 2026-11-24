// =============================================================================
// Hugging Face browser — the body of the Model page's "Find models" popup.
// =============================================================================
// The explorer layout (components/HubBrowser.tsx): recommended publishers on
// the left, results in the middle, the opened model on the right. A search
// term searches inside the chosen publisher; picking another keeps the term.
//
// Nothing here reaches the network until Connect is pressed (useModelCatalog's
// rule). Shows FACTS, not a verdict: each download is drawn against the
// machine's GPU memory and RAM, and the person judges. See ModelSection's
// header for why there is no "will it fit" label.
//
// "Models that see images" and "Hide gated models" filter the results that
// came back (the Hub has no such query), so they narrow the 50 shown rather
// than search further.
// =============================================================================

import { useState } from 'react'
import type { ModelCatalogHook } from '../hooks/useModelCatalog'
import type { HardwareSpecs, ModelArtifact } from '../types'
import { btnCls } from '../components/ui'
import {
  DownloadTray, FactChips, HubLayout, HubSearchBar, MemoryBar, MemoryScale, PaneMessage, ResultHeader, ResultRow,
  ScopeSelect, SidebarHeading, SidebarItem, SidebarSwitch, fmtSize, quantRange, useDebouncedEffect,
} from '../components/HubBrowser'

const params = (n: number | null) => !n ? null : n >= 1e9 ? `${(n / 1e9).toFixed(1)}B parameters` : `${(n / 1e6).toFixed(0)}M parameters`

export function HuggingFaceBrowser({ catalog, hardware, onDone }: { catalog: ModelCatalogHook; hardware: HardwareSpecs | null; onDone: () => void }) {
  const {
    catalogEnabled, connectCatalog,
    publishers, publisher, setPublisher, query, setQuery, sort, setSort,
    models, searching, searchError, runSearch,
    detail, detailLoading, detailError, description, openModel, closeModel,
    localNames,
    progress, downloading, downloadError, downloadLabel, download, cancelDownload,
  } = catalog
  const [seesImages, setSeesImages] = useState(false)
  const [hideGated, setHideGated] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [more, setMore] = useState(false)

  // Typing searches by itself once the term settles; Enter searches now.
  useDebouncedEffect(() => { if (catalogEnabled) runSearch() }, [query])

  if (!catalogEnabled) {
    return (
      <div className="space-y-4 px-5 py-5 text-sm leading-relaxed text-zinc-300">
        <p>
          Redstart doesn&rsquo;t contact Hugging Face until you ask it to. Connecting fetches model listings
          over the internet. Nothing about your conversations is sent.
        </p>
        <button type="button" onClick={connectCatalog} className={btnCls.primary}>Connect to Hugging Face</button>
      </div>
    )
  }

  const pickSource = (id: string) => { setPublisher(id); void runSearch({ publisher: id }) }
  const scopeLabel = publishers.find(p => p.id === publisher)?.label ?? publisher
  const rows = models.filter(m => (!seesImages || m.vision) && (!hideGated || !m.gated))
  const where = publisher ? `from ${scopeLabel}` : 'on Hugging Face'
  const summary = searching ? 'Searching…'
    : `${rows.length}${rows.length < models.length ? ` of ${models.length}` : ''} model${rows.length === 1 ? '' : 's'} ${where}${query.trim() ? ` matching “${query.trim()}”` : ''}`
  const open = (repoId: string) => { setOpenId(repoId); setMore(false); void openModel(repoId) }
  const back = () => { setOpenId(null); closeModel() }

  const sidebar = (<>
    <SidebarHeading>Recommended</SidebarHeading>
    {publishers.map(p => <SidebarItem key={p.id} label={p.label} note={p.note} active={publisher === p.id} onClick={() => pickSource(p.id)} />)}
    <SidebarHeading>Everywhere</SidebarHeading>
    <SidebarItem label="All of Hugging Face" active={!publisher} onClick={() => pickSource('')} />
    <SidebarHeading>Show only</SidebarHeading>
    <SidebarSwitch label="Models that see images" checked={seesImages} onChange={setSeesImages} />
    <SidebarSwitch label="Hide gated models" checked={hideGated} onChange={setHideGated} />
    <p className="mt-auto px-2.5 pt-3 text-[11.5px] leading-snug text-zinc-400">
      Recommended publishers convert models carefully. A search of all of Hugging Face also finds abandoned and mislabeled repos.
    </p>
  </>)

  const results = (<>
    <HubSearchBar
      scopes={publisher ? [{ label: scopeLabel, onClear: () => pickSource('') }] : []}
      query={query} onQuery={setQuery} onSubmit={() => void runSearch()}
      placeholder={publisher ? `Search ${scopeLabel}’s models…` : 'Search all of Hugging Face for GGUF models…'}
      sort={sort} onSort={s => { setSort(s); void runSearch({ sort: s }) }}>
      <ScopeSelect value={publisher} onChange={pickSource}
        options={[...publishers.map(p => ({ id: p.id, label: p.label })), { id: '', label: 'All of Hugging Face' }]} />
    </HubSearchBar>
    <div className="px-4 pb-2 text-[12.5px] text-zinc-400">{summary}</div>
    <ResultHeader second="Sizes offered" />
    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
      {searchError && <p className="px-2 py-3 text-sm text-red-400">{searchError}</p>}
      {rows.map(m => (
        <ResultRow key={m.repoId} active={openId === m.repoId} onClick={() => open(m.repoId)}
          title={m.repoId.split('/').slice(1).join('/')}
          tags={<>
            <span>{m.author}</span>
            {m.vision && <span className="text-blue-300">· sees images</span>}
            {m.gated && <span className="text-amber-300">· gated</span>}
          </>}
          second={quantRange(m.quants)} downloads={m.downloads} updated={m.lastModified} />
      ))}
      {!searching && !searchError && rows.length === 0 && (
        <div className="px-4 py-10 text-center text-[13.5px] text-zinc-400">
          No GGUF models match here.
          {publisher && <> <button type="button" onClick={() => pickSource('')} className={btnCls.subtle}>Search all of Hugging Face</button></>}
        </div>
      )}
    </div>
  </>)

  const detailPane = detailLoading ? <PaneMessage>Loading model details…</PaneMessage>
    : detailError ? <PaneMessage><span className="text-red-400">{detailError}</span></PaneMessage>
    : !detail ? <PaneMessage>Choose a model to see the sizes it comes in.</PaneMessage>
    : (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-zinc-800 px-4 pb-3 pt-4">
          <div className="text-xs text-zinc-400">{detail.repoId.split('/')[0]}</div>
          <h3 className="mt-0.5 break-all text-[15px] font-semibold text-zinc-100">{detail.repoId.split('/').slice(1).join('/')}</h3>
          <FactChips facts={[
            params(detail.paramCount),
            detail.experts && `${detail.experts.total} experts, ${detail.experts.active} active`,
            detail.contextLength && `${(detail.contextLength / 1024).toFixed(0)}K context`,
            detail.architecture,
            detail.license,
          ]} />
          {description && (
            <div className="mt-2.5 text-[12.5px]">
              <p className={`whitespace-pre-line text-zinc-300 ${more ? '' : 'line-clamp-3'}`}>{description.text}</p>
              {more && (
                <p className="mt-1 text-zinc-400">
                  {description.source === 'base_model'
                    ? `From the model card of ${description.repoId}, which this build was quantized from.`
                    : 'From this repository’s own model card, which may describe the conversion rather than the model.'}
                </p>
              )}
              <button type="button" onClick={() => setMore(v => !v)} className="mt-0.5 text-[12.5px] text-orange-400 hover:text-orange-300">{more ? 'Less' : 'More'}</button>
            </div>
          )}
          {detail.gated && (
            <p className="mt-2.5 rounded-lg bg-amber-950/50 px-3 py-2 text-[12.5px] text-amber-200">
              Gated: it needs a Hugging Face account, which Redstart does not use. Download it yourself and put it in the models folder.
            </p>
          )}
        </div>
        <div className="flex items-baseline gap-2 px-4 pb-1.5 pt-3">
          <h4 className="flex-1 text-[13px] font-semibold text-zinc-100">Choose a size</h4>
          {hardware && <span className="text-[11px] text-zinc-400">bar: the file against your GPU and RAM</span>}
        </div>
        {downloadError && <p className="px-4 pb-1 text-[12.5px] text-red-400">{downloadError}</p>}
        <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
          {detail.artifacts.map(a => (
            <ArtifactRow key={a.id} artifact={a} hardware={hardware}
              already={a.files.some(f => localNames.has((f.rfilename.split('/').pop() || '').toLowerCase()))}
              blocked={downloading || detail.gated || !a.complete}
              blockedTip={detail.gated ? 'Gated models need a Hugging Face account' : !a.complete ? 'Part of this file set is missing on Hugging Face' : downloading ? 'One download at a time' : undefined}
              active={downloading && progress?.repoId === detail.repoId && progress?.artifactId === a.id}
              onDownload={() => download(a)} />
          ))}
          <MemoryScale hardware={hardware} />
          <p className="mx-2 mt-3 text-[11.5px] leading-snug text-zinc-400">
            Larger sizes are closer to the original model and need more memory. A model can run partly on the GPU and partly in RAM; llama-server places it when it starts.
          </p>
        </div>
      </div>
    )

  const pct = progress?.totalBytes ? Math.min(100, Math.round(((progress.receivedBytes || 0) / progress.totalBytes) * 100)) : 0
  const footer = (<>
    {downloading
      ? <DownloadTray label={`Downloading ${downloadLabel || progress?.repoId || ''}`} pct={pct} onCancel={cancelDownload}
          detail={[progress?.totalBytes ? `${fmtSize(progress.receivedBytes ?? 0)} of ${fmtSize(progress.totalBytes)}` : '', progress?.bytesPerSec ? `${(progress.bytesPerSec / 1024 ** 2).toFixed(1)} MB/s` : ''].filter(Boolean).join(' · ')} />
      : <span className="flex-1 text-[12.5px] text-zinc-400">Downloads go to the models folder, one at a time. Each file is checked against its published sha256 when it has one.</span>}
    <button type="button" onClick={onDone} className={btnCls.primary}>Done</button>
  </>)

  return <HubLayout sidebar={sidebar} results={results} detail={detailPane} detailOpen={!!openId} onBack={back} footer={footer} />
}

function ArtifactRow({ artifact, hardware, already, blocked, blockedTip, active, onDownload }: {
  artifact: ModelArtifact
  hardware: HardwareSpecs | null
  already: boolean
  blocked: boolean
  blockedTip?: string
  active: boolean
  onDownload: () => void
}) {
  const total = artifact.totalBytes === null ? null : artifact.totalBytes + (artifact.projector?.size ?? 0)
  const notes = [
    artifact.shardTotal > 1 && `${artifact.shardTotal} files`,
    // A published checksum is the difference between a verified download and
    // a hopeful one, so its absence is stated rather than hidden.
    !artifact.verifiable && 'no checksum',
    artifact.projector && `+ vision ${fmtSize(artifact.projector.size)}`,
  ].filter(Boolean).join(' · ')
  return (
    <div className={`rounded-lg px-2 py-2 ${active ? 'bg-orange-500/[0.08]' : ''}`}>
      <div className="flex items-center gap-2.5">
        <span className={`w-[5.5rem] shrink-0 truncate font-mono text-[13px] font-medium ${artifact.quantRecognized ? 'text-zinc-100' : 'text-zinc-400'}`}>{artifact.quantLabel}</span>
        <span className="w-16 shrink-0 text-[12.5px] text-zinc-300">{fmtSize(total)}</span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-zinc-400" data-tip={artifact.projector ? `${artifact.projector.rfilename} is downloaded with it and loaded with --mmproj` : undefined}>
          {notes}
          {!artifact.complete && <span className="text-amber-300">{notes ? ' · ' : ''}incomplete on Hugging Face</span>}
        </span>
        {already ? (
          <span className="flex shrink-0 items-center gap-1 text-[12.5px] font-medium text-green-400">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8.5l3 3 7-7" /></svg>
            Downloaded
          </span>
        ) : active ? (
          <span className="shrink-0 text-[12.5px] text-orange-300">Downloading</span>
        ) : (
          <button type="button" onClick={onDownload} disabled={blocked} className={btnCls.chip} data-tip={blocked ? blockedTip : undefined} data-tip-end="">Download</button>
        )}
      </div>
      <MemoryBar bytes={total} hardware={hardware} />
    </div>
  )
}
