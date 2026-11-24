// =============================================================================
// Image model browser — the body of the Images page's "Find on Hugging Face".
// =============================================================================
// The image counterpart of HuggingFaceBrowser, in the same explorer layout
// (components/HubBrowser.tsx): publishers on the left, results in the middle,
// the opened repo on the right with one row per file, its size drawn against
// the machine's GPU memory and RAM. Facts, not a "will it fit" verdict (see
// ModelSection's header).
//
// What is image-specific: the FAMILY. It is a sidebar filter (the Hub search
// is narrowed to conversions of the family's base model), and in the opened
// repo it is read from the model card and shown up front, because it decides
// which shared files come along (FLUX's text encoders and VAE, once per
// family) and whether Nest can run the model at all.
//
// Nothing reaches the network until a publisher, a family, Sort or a search
// is chosen.
// =============================================================================

import { useState } from 'react'
import { getAPI } from '../api/redstart'
import type { HardwareSpecs, ImageCatalogModel, ImageGenerationStatus, ImageRepoDetail, ImageTransferProgress, SearchSort } from '../types'
import { btnCls, inputCls } from '../components/ui'
import {
  DownloadTray, FactChips, HubLayout, HubSearchBar, MemoryBar, MemoryScale, PaneMessage, ResultHeader, ResultRow,
  ScopeSelect, SidebarHeading, SidebarItem, fmtCount, fmtSize, quantRange, useDebouncedEffect,
} from '../components/HubBrowser'

const pct = (p: ImageTransferProgress | null) => p?.totalBytes ? Math.min(100, Math.round(((p.receivedBytes ?? 0) / p.totalBytes) * 100)) : 0

export function ImageModelBrowser({ status, hardware, progress, onDownload, onCancel, onDone }: {
  status: ImageGenerationStatus
  hardware: HardwareSpecs | null
  progress: ImageTransferProgress | null
  onDownload: (req: { repoId: string; rfilename: string; family: string }) => void
  onCancel: () => void
  onDone: () => void
}) {
  const api = getAPI()
  // '' is all of Hugging Face; a family of '' is any family.
  const [publisher, setPublisher] = useState('')
  const [familyFilter, setFamilyFilter] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SearchSort>('downloads')
  const [results, setResults] = useState<ImageCatalogModel[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [repo, setRepo] = useState<ImageRepoDetail | null>(null)
  const [repoError, setRepoError] = useState<string | null>(null)
  const [loadingRepo, setLoadingRepo] = useState(false)
  const [family, setFamily] = useState('')

  async function search(next: { query?: string; publisher?: string; family?: string; sort?: SearchSort } = {}) {
    if (!api) return
    setSearching(true); setError(null)
    const r = await api.capabilities.searchImageModels({
      query: (next.query ?? query).trim(), publisher: next.publisher ?? publisher,
      family: next.family ?? familyFilter, sort: next.sort ?? sort,
    })
    setResults(r.results); if (!r.ok) setError(r.error ?? 'Search failed')
    setSearching(false)
  }

  useDebouncedEffect(() => { void search() }, [query])

  async function open(repoId: string) {
    if (!api) return
    setOpenId(repoId); setRepo(null); setRepoError(null); setLoadingRepo(true)
    const r = await api.capabilities.imageRepo(repoId)
    setLoadingRepo(false)
    if (!r.ok) { setRepoError(r.error ?? 'Could not open that model'); return }
    setRepo(r)
    setFamily(r.family ?? '')
  }

  const pickSource = (id: string) => { setPublisher(id); void search({ publisher: id }) }
  const pickFamily = (id: string) => { setFamilyFilter(id); void search({ family: id }) }
  const pubLabel = status.publishers.find(p => p.id === publisher)?.label ?? publisher
  const famLabel = status.families.find(f => f.id === familyFilter)?.label ?? ''
  const rows = results ?? []

  const sidebar = (<>
    <SidebarHeading>Recommended</SidebarHeading>
    {status.publishers.map(p => <SidebarItem key={p.id} label={p.label} note={p.note} active={results !== null && publisher === p.id} onClick={() => pickSource(p.id)} />)}
    <SidebarHeading>Everywhere</SidebarHeading>
    <SidebarItem label="All of Hugging Face" active={results !== null && !publisher} onClick={() => pickSource('')} />
    <SidebarHeading>Family</SidebarHeading>
    <div role="radiogroup" aria-label="Family">
      {[{ id: '', label: 'Any family' }, ...status.families].map(f => (
        <label key={f.id} className="flex cursor-pointer items-center gap-2.5 px-2.5 py-1 text-[13px] text-zinc-200">
          <input type="radio" name="image-family" checked={familyFilter === f.id} onChange={() => pickFamily(f.id)} className="h-[15px] w-[15px] accent-orange-500" />
          {f.label}
        </label>
      ))}
    </div>
    <p className="mt-auto px-2.5 pt-3 text-[11.5px] leading-snug text-zinc-400">
      Nest runs the families listed here. A family narrows the search to conversions of that model.
    </p>
  </>)

  const resultsPane = (<>
    <HubSearchBar
      scopes={[
        ...(publisher ? [{ label: pubLabel, onClear: () => pickSource('') }] : []),
        ...(familyFilter ? [{ label: famLabel, tone: 'family' as const, onClear: () => pickFamily('') }] : []),
      ]}
      query={query} onQuery={setQuery} onSubmit={() => void search()}
      placeholder={publisher && familyFilter ? 'Search…' : publisher ? `Search ${pubLabel}’s image models…` : 'Search Hugging Face for image models (flux schnell gguf, sdxl…)'}
      sort={sort} onSort={s => { setSort(s); void search({ sort: s }) }}>
      <ScopeSelect value={publisher} onChange={pickSource}
        options={[{ id: '', label: 'All of Hugging Face' }, ...status.publishers.map(p => ({ id: p.id, label: p.label }))]} />
    </HubSearchBar>
    <div className="px-4 pb-2 text-[12.5px] text-zinc-400">
      {searching ? 'Searching…'
        : results === null ? 'Pick a publisher or a family, or search. Nest contacts Hugging Face only when you do.'
        : `${rows.length} model${rows.length === 1 ? '' : 's'} ${publisher ? `from ${pubLabel}` : 'on Hugging Face'}${famLabel ? ` · ${famLabel}` : ''}${query.trim() ? ` matching “${query.trim()}”` : ''}`}
    </div>
    <ResultHeader second="Files offered" />
    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
      {error && <p className="px-2 py-3 text-sm text-red-400">{error}</p>}
      {results === null && !searching && (
        <p className="px-3 py-6 text-[13px] text-zinc-400">FLUX.1 schnell is a good first choice: Apache-2.0, four steps per picture. Choose it under Family.</p>
      )}
      {rows.map(m => (
        <ResultRow key={m.repoId} active={openId === m.repoId} onClick={() => open(m.repoId)}
          disabled={m.weightFileCount === 0} tip={m.weightFileCount === 0 ? 'No single-file weights Nest can use (a diffusers folder only)' : undefined}
          title={m.repoId.split('/').slice(1).join('/')}
          tags={<><span>{m.author}</span>{m.gated && <span className="text-amber-300">· gated</span>}</>}
          second={m.quants.length ? quantRange(m.quants) : 'no single files'} downloads={m.downloads} updated={m.lastModified} />
      ))}
      {!searching && results !== null && rows.length === 0 && !error && (
        <div className="px-4 py-10 text-center text-[13.5px] text-zinc-400">
          No text-to-image models match here.
          {(publisher || familyFilter) && <> <button type="button" className={btnCls.subtle}
            onClick={() => { setPublisher(''); setFamilyFilter(''); void search({ publisher: '', family: '' }) }}>Search everywhere, any family</button></>}
        </div>
      )}
    </div>
  </>)

  let detailPane: React.ReactNode
  if (loadingRepo) detailPane = <PaneMessage>Loading model details…</PaneMessage>
  else if (repoError) detailPane = <PaneMessage><span className="text-red-400">{repoError}</span></PaneMessage>
  else if (!repo) detailPane = <PaneMessage>Choose a model to see its files.</PaneMessage>
  else {
    const fam = status.families.find(f => f.id === family)
    // The family's shared files are already here if any model of it is ready.
    const haveShared = status.models.some(m => m.family === family && m.ready)
    const sharedBytes = fam && !haveShared ? fam.companionBytes : 0
    const downloaded = new Set(status.models.filter(m => m.repoId === repo.repoId).map(m => m.rfilename))
    const busy = !!status.downloading
    detailPane = (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-zinc-800 px-4 pb-3 pt-4">
          <div className="text-xs text-zinc-400">{repo.repoId.split('/')[0]}</div>
          <h3 className="mt-0.5 break-all text-[15px] font-semibold text-zinc-100">{repo.repoId.split('/').slice(1).join('/')}</h3>
          <FactChips facts={[repo.family ? `${status.families.find(f => f.id === repo.family)?.label} · from the model card` : 'Family not stated', repo.license, `${fmtCount(repo.downloads)} downloads`]} />
          {repo.description && (
            <p className="mt-2.5 line-clamp-4 whitespace-pre-line text-[12.5px] text-zinc-300" data-tip={repo.description.source === 'base_model' ? `From the model card of ${repo.description.repoId}` : 'From this repository’s own model card'}>
              {repo.description.text}
            </p>
          )}
          {repo.gated && (
            <p className="mt-2.5 rounded-lg bg-amber-950/50 px-3 py-2 text-[12.5px] text-amber-200">
              Gated: it needs a Hugging Face account, which Redstart does not use. Look for a copy of it that is not.
            </p>
          )}
        </div>
        <div className="space-y-2 px-4 pt-3">
          <label className="flex flex-wrap items-center gap-2.5 text-[12.5px] text-zinc-400">
            Family
            <select value={family} onChange={e => setFamily(e.target.value)} className={`${inputCls.xs} w-auto`}>
              <option value="">Choose…</option>
              {status.families.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
            {!repo.family && <span className="text-zinc-400">Choose only if you know it; otherwise the engine will refuse the file.</span>}
          </label>
          {fam && (
            <p className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-[12px] leading-snug text-zinc-300">
              {fam.note}{sharedBytes ? ` Its shared files (${fmtSize(sharedBytes)}) come with the first ${fam.label} model, once. Sizes below include them.` : ' Its shared files are already here.'}
            </p>
          )}
        </div>
        <div className="flex items-baseline gap-2 px-4 pb-1.5 pt-3">
          <h4 className="flex-1 text-[13px] font-semibold text-zinc-100">Choose a file</h4>
          {hardware && <span className="text-[11px] text-zinc-400">bar: the download against your GPU and RAM</span>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
          {repo.files.length === 0 && <p className="px-2 text-[13px] text-zinc-400">No single-file .gguf or .safetensors weights in this repository.</p>}
          {repo.files.map(f => {
            const active = status.downloading?.repoId === repo.repoId && status.downloading.rfilename === f.rfilename
            const already = downloaded.has(f.rfilename)
            const total = f.size === null ? null : f.size + sharedBytes
            return (
              <div key={f.rfilename} className={`rounded-lg px-2 py-2 ${active ? 'bg-orange-500/[0.08]' : ''}`}>
                <div className="flex items-center gap-2.5">
                  <span className={`w-[5.5rem] shrink-0 truncate font-mono text-[13px] font-medium ${f.quantRecognized ? 'text-zinc-100' : 'text-zinc-400'}`} data-tip={f.rfilename}>{f.quantLabel}</span>
                  <span className="w-16 shrink-0 text-[12.5px] text-zinc-300">{fmtSize(total)}</span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-zinc-400">{f.sha256 ? '' : 'no checksum'}</span>
                  {already ? (
                    <span className="shrink-0 text-[12.5px] font-medium text-green-400">Downloaded</span>
                  ) : active ? (
                    <span className="shrink-0 text-[12.5px] text-orange-300">Downloading</span>
                  ) : (
                    <button type="button" onClick={() => onDownload({ repoId: repo.repoId, rfilename: f.rfilename, family })}
                      disabled={busy || repo.gated || !family} className={btnCls.chip} data-tip-end=""
                      data-tip={!family ? 'Choose the family first' : busy ? 'One download at a time' : repo.gated ? 'Gated models need a Hugging Face account' : undefined}>
                      Download
                    </button>
                  )}
                </div>
                <MemoryBar bytes={total} hardware={hardware} />
              </div>
            )
          })}
          <MemoryScale hardware={hardware} />
        </div>
      </div>
    )
  }

  const footer = (<>
    {status.downloading
      ? <DownloadTray label={`Downloading ${status.downloading.repoId.split('/').pop()} · ${progress?.file ?? status.downloading.rfilename}`}
          pct={pct(progress)} onCancel={onCancel}
          detail={progress?.totalBytes ? `${fmtSize(progress.receivedBytes ?? 0)} of ${fmtSize(progress.totalBytes)}` : undefined} />
      : <span className="flex-1 text-[12.5px] text-zinc-400">Image models go to the models folder, under image/. One download at a time.</span>}
    <button type="button" onClick={onDone} className={btnCls.primary}>Done</button>
  </>)

  return <HubLayout sidebar={sidebar} results={resultsPane} detail={detailPane} detailOpen={!!openId}
    onBack={() => { setOpenId(null); setRepo(null); setRepoError(null) }} footer={footer} />
}
