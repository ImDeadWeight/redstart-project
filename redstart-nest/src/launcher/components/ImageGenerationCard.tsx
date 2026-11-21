import { useCallback, useEffect, useState } from 'react'
import { getAPI } from '../api/redstart'
import type { ImageCatalogModel, ImageGenerationStatus, ImageRepoDetail, ImageTransferProgress } from '../types'
import { btnCls, Chip, ConfirmDialog, inputCls, Modal } from './ui'

// The Image generation card in the Tools list (docs/notes/image-generation-plan.md).
// Three things gate generate_image, and the card states each one:
//
//   1. Documents configured: the pictures go into each chat's workspace.
//   2. An image model: you pick one on Hugging Face. Nest knows model
//      FAMILIES (FLUX schnell/dev, SDXL, SD 1.x); within a family any
//      checkpoint works, and the family's shared files come along.
//   3. The engine (stable-diffusion.cpp): downloaded once, CUDA with an
//      NVIDIA GPU (about 1 GB) or Vulkan (30 MB).
//
// The cost is said plainly: the chat model pauses while a picture is made.

const gb = (n: number | null | undefined) => typeof n === 'number' ? (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`) : '—'
const pct = (p: ImageTransferProgress | null) => p?.totalBytes ? Math.min(100, Math.round(((p.receivedBytes ?? 0) / p.totalBytes) * 100)) : 0

export function ImageGenerationCard({ documentsConfigured }: { documentsConfigured: boolean }) {
  const [status, setStatus] = useState<ImageGenerationStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [engineProgress, setEngineProgress] = useState<ImageTransferProgress | null>(null)
  const [downloadProgress, setDownloadProgress] = useState<ImageTransferProgress | null>(null)
  const [finding, setFinding] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const load = useCallback(async () => {
    const a = getAPI()
    if (!a) return
    try { setStatus(await a.capabilities.imageGeneration()) } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }, [])

  useEffect(() => {
    load()
    const a = getAPI()
    if (!a) return
    a.events.onImageRuntimeProgress((p) => { setEngineProgress(p.state === 'complete' ? null : p); if (p.state === 'complete') load() })
    a.events.onImageDownloadProgress((p) => {
      setDownloadProgress(['complete', 'cancelled', 'error'].includes(p.state) ? null : p)
      if (p.state === 'error' && p.error) setError(p.error)
      if (p.state !== 'downloading') load()
    })
    return () => { a.events.offImageRuntimeProgress(); a.events.offImageDownloadProgress() }
  }, [load])

  if (!status) return <p className="text-[13px] text-zinc-500">Checking…</p>
  const api = getAPI()!

  async function run<T extends { ok: boolean; error?: string }>(p: Promise<T>) {
    setError(null)
    const r = await p
    if (!r.ok && r.error) setError(r.error)
    await load()
    return r
  }

  const active = status.models.find(m => m.file === status.model) ?? null
  const blocker = !documentsConfigured
    ? 'Choose a Documents folder first: each chat\'s pictures are saved there.'
    : !active ? 'Choose an image model below.'
      : !active.ready ? 'The chosen model is missing some of its files; download it again.'
        : !status.engine.installed ? 'The image engine is not installed yet. It downloads on the first picture, or install it now.'
          : null

  return (
    <div className="space-y-4">
      {blocker && <p className="text-[13px] text-amber-300">{blocker}</p>}
      {error && <p className="text-[13px] text-red-400">{error}</p>}
      {status.busy && <p className="text-[13px] text-zinc-300">Making a picture now{status.busy.paused ? '; the chat model is paused until it is done' : ''}.</p>}

      <p className="text-[13px] text-zinc-400">
        While a picture is made, the chat model pauses so the image model can use the GPU, then reloads by itself. Chats wait for it.
        A role can withhold this tool on the Roles page.
      </p>

      {/* ── Image model ── */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-zinc-200">Image model</span>
          <button type="button" className={btnCls.chip} onClick={() => setFinding(true)} disabled={!!status.downloading}>Find one on Hugging Face</button>
        </div>
        {status.models.length === 0 && !status.downloading && (
          <p className="text-[13px] text-zinc-500">None yet. FLUX.1 schnell is a good first choice (Apache-2.0, about 10 GB with its shared files, four steps per picture).</p>
        )}
        {status.models.map(m => {
          const isActive = m.file === status.model
          return (
            <div key={m.file} className={`flex flex-wrap items-center gap-3 rounded-xl border px-3.5 py-2.5 ${isActive ? 'border-orange-500/70 bg-orange-500/5' : 'border-zinc-800 bg-zinc-950/40'}`}>
              <div className="min-w-[14rem] flex-1">
                <div className="break-all text-sm text-zinc-100">{m.repoId} <span className="text-zinc-400">· {m.rfilename}</span></div>
                <div className="text-[13px] text-zinc-500">{m.familyLabel} · {gb(m.bytes)}{!m.ready && <span className="text-amber-300"> · files missing</span>}</div>
              </div>
              {isActive
                ? <Chip tone="ok">In use</Chip>
                : <button type="button" className={btnCls.chip} onClick={() => run(api.capabilities.setImageGeneration({ model: m.file }))}>Use this</button>}
              <button type="button" className={btnCls.subtle} onClick={() => setConfirmDelete(m.file)}>Delete</button>
            </div>
          )
        })}
        {status.downloading && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-3.5 py-2.5">
            <div className="flex items-center gap-3 text-[13px] text-zinc-300">
              <span className="min-w-0 flex-1 break-all">Downloading {status.downloading.repoId} · {downloadProgress?.file ?? status.downloading.rfilename}</span>
              <span>{pct(downloadProgress)}%</span>
              <button type="button" className={btnCls.secondary} onClick={() => run(api.capabilities.cancelImageDownload())}>Cancel</button>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded bg-zinc-800"><div className="h-full bg-orange-500" style={{ width: `${pct(downloadProgress)}%` }} /></div>
          </div>
        )}
      </div>

      {/* ── Engine ── */}
      <div className="space-y-2">
        <span className="text-sm font-medium text-zinc-200">Engine</span>
        <div className="flex flex-wrap items-center gap-3 text-[13px] text-zinc-400">
          <span>stable-diffusion.cpp {status.engine.release}, {status.engine.label ?? 'not available here'}{status.engine.nvidia ? ' (NVIDIA GPU found)' : ''}</span>
          {status.engine.installed
            ? <Chip tone="ok">Installed</Chip>
            : status.engine.buildKey && (
              <button type="button" className={btnCls.chip} disabled={status.engine.installing || !!engineProgress}
                onClick={() => run(api.capabilities.installImageEngine())}>
                {status.engine.installing || engineProgress ? `Installing… ${pct(engineProgress)}%` : `Install now (${gb(status.engine.downloadBytes)})`}
              </button>
            )}
        </div>
        <label className="flex flex-wrap items-center gap-3 text-[13px] text-zinc-400">
          Build
          <select value={status.backend} onChange={e => run(api.capabilities.setImageGeneration({ backend: e.target.value as ImageGenerationStatus['backend'] }))}
            className={`${inputCls.xs} w-auto`}>
            <option value="auto">Automatic (CUDA with an NVIDIA GPU, else Vulkan)</option>
            <option value="cuda">CUDA (NVIDIA, about 1 GB, fastest)</option>
            <option value="vulkan">Vulkan (any GPU, 30 MB)</option>
            <option value="metal">Metal (Apple Silicon)</option>
          </select>
        </label>
      </div>

      <FindImageModel open={finding} status={status} onClose={() => setFinding(false)}
        onDownload={async (req) => { setFinding(false); await run(api.capabilities.downloadImageModel(req)) }} />

      <ConfirmDialog open={!!confirmDelete} title="Delete this image model?" confirmLabel="Delete"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => { const f = confirmDelete!; setConfirmDelete(null); await run(api.capabilities.deleteImageModel(f)) }}>
        The model file is removed from the models folder. Its family&rsquo;s shared files stay, for other models of the same family.
      </ConfirmDialog>
    </div>
  )
}

function FindImageModel({ open, status, onClose, onDownload }: {
  open: boolean
  status: ImageGenerationStatus
  onClose: () => void
  onDownload: (req: { repoId: string; rfilename: string; family: string }) => void
}) {
  const [query, setQuery] = useState('flux schnell gguf')
  const [results, setResults] = useState<ImageCatalogModel[]>([])
  const [repo, setRepo] = useState<ImageRepoDetail | null>(null)
  const [file, setFile] = useState('')
  const [family, setFamily] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const api = getAPI()

  async function search() {
    if (!api) return
    setBusy(true); setError(null); setRepo(null)
    const r = await api.capabilities.searchImageModels({ query })
    setResults(r.results); if (!r.ok) setError(r.error ?? 'Search failed')
    setBusy(false)
  }

  async function openRepo(repoId: string) {
    if (!api) return
    setBusy(true); setError(null)
    const r = await api.capabilities.imageRepo(repoId)
    setBusy(false)
    if (!r.ok) { setError(r.error ?? 'Could not open that model'); return }
    setRepo(r)
    setFamily(r.family ?? '')
    // Prefer a mid-size quant when there is a choice: q4_k is the plan's tested default.
    const pick = r.files.find(f => /q4_k/i.test(f.rfilename)) ?? r.files[0]
    setFile(pick?.rfilename ?? '')
  }

  const fam = status.families.find(f => f.id === family)
  const chosen = repo?.files.find(f => f.rfilename === file)
  const total = (chosen?.size ?? 0) + (fam?.companionBytes ?? 0)

  return (
    <Modal open={open} title="Find an image model" subtitle="Text-to-image models on Hugging Face" onClose={onClose} size="lg"
      footer={repo && (
        <div className="flex items-center gap-3">
          <span className="flex-1 text-[13px] text-zinc-400">{fam && chosen ? `About ${gb(total)} with the ${fam.label} shared files (fetched once).` : 'Choose a file and its family.'}</span>
          <button type="button" className={btnCls.secondary} onClick={() => setRepo(null)}>Back</button>
          <button type="button" className={btnCls.primary} disabled={!file || !family || repo.gated}
            onClick={() => onDownload({ repoId: repo.repoId, rfilename: file, family })}>Download</button>
        </div>
      )}>
      {error && <p className="mb-2 text-[13px] text-red-400">{error}</p>}
      {!repo ? (
        <div className="space-y-3">
          <form className="flex gap-2" onSubmit={e => { e.preventDefault(); search() }}>
            <input value={query} onChange={e => setQuery(e.target.value)} className={`${inputCls.sm} flex-1`} placeholder="flux schnell gguf, sdxl, …" />
            <button type="submit" className={btnCls.secondary} disabled={busy}>Search</button>
          </form>
          <ul className="space-y-1.5">
            {results.map(m => (
              <li key={m.repoId}>
                <button type="button" onClick={() => openRepo(m.repoId)} disabled={busy || m.weightFileCount === 0}
                  className="flex w-full items-center gap-3 rounded-lg border border-zinc-800 px-3 py-2 text-left hover:border-zinc-600 disabled:opacity-50">
                  <span className="min-w-0 flex-1 break-all text-sm text-zinc-100">{m.repoId}</span>
                  <span className="text-[12px] text-zinc-500">{m.weightFileCount} file{m.weightFileCount === 1 ? '' : 's'}{m.gated ? ' · needs a Hugging Face account' : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="text-sm text-zinc-100">{repo.repoId} <span className="text-zinc-500">{repo.license ? `· ${repo.license}` : ''}</span></div>
          {repo.gated && <p className="text-[13px] text-amber-300">This model needs a Hugging Face account to download, which Nest does not sign in to. Look for a copy of it that does not.</p>}
          <label className="block text-[13px] text-zinc-400">File
            <select value={file} onChange={e => setFile(e.target.value)} className={`${inputCls.sm} mt-1 w-full`}>
              {repo.files.map(f => <option key={f.rfilename} value={f.rfilename}>{f.rfilename} — {gb(f.size)}</option>)}
            </select>
          </label>
          <label className="block text-[13px] text-zinc-400">Family {repo.family ? '(read from the model card)' : '(the card does not say; choose)'}
            <select value={family} onChange={e => setFamily(e.target.value)} className={`${inputCls.sm} mt-1 w-full`}>
              <option value="">Choose…</option>
              {status.families.map(f => <option key={f.id} value={f.id}>{f.label} — {f.note}</option>)}
            </select>
          </label>
        </div>
      )}
    </Modal>
  )
}
