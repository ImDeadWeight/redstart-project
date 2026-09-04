// =============================================================================
// useModelCatalog — Hugging Face browsing, local storage, and download state.
// =============================================================================
// Owns everything the Models tab needs. Two-tier by design: the search list
// carries no file sizes (the Hub omits them from the search endpoint), so a
// model's artifacts are fetched only when it is opened.
// =============================================================================

import { useState, useEffect, useCallback, useRef } from 'react'
import { api, getAPI } from '../api/redstart'
import type {
  CatalogModel, ModelDetail, ModelDescription, ModelArtifact, LocalModelFile, DownloadProgress,
} from '../types'

export function useModelCatalog() {
  // Off until the user clicks Connect — see the bootstrap note below.
  const [catalogEnabled, setCatalogEnabled] = useState(false)
  const [publishers, setPublishers] = useState<{ id: string; label: string; note: string }[]>([])
  const [publisher, setPublisher] = useState('unsloth')
  const [query, setQuery] = useState('')
  const [models, setModels] = useState<CatalogModel[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  const [detail, setDetail] = useState<ModelDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  // Fetched separately from the detail and never blocking it — see the note on
  // getModelDescriptionById. A card that is missing, gated or unparseable
  // leaves this null, which the panel renders as nothing at all rather than as
  // an error: a description is context, and its absence is not a failure the
  // user has to act on.
  const [description, setDescription] = useState<ModelDescription | null>(null)

  const [modelsDir, setModelsDir] = useState('')
  const [localFiles, setLocalFiles] = useState<LocalModelFile[]>([])
  const [disk, setDisk] = useState<{ freeBytes?: number; totalBytes?: number }>({})

  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  // Guards against an in-flight search landing after a newer one — a slow
  // "qwen" resolving after a fast "llama" would otherwise show the wrong list.
  const searchSeq = useRef(0)
  // The same guard for the detail panel, which now makes two sequential calls.
  const detailSeq = useRef(0)

  const refreshLocal = useCallback(async () => {
    const a = getAPI()
    if (!a) return
    const [listed, space] = await Promise.all([a.models.local(), a.models.diskSpace()])
    setModelsDir(listed.dir)
    setLocalFiles(listed.files || [])
    if (space.ok) setDisk({ freeBytes: space.freeBytes, totalBytes: space.totalBytes })
  }, [])

  const runSearch = useCallback(async (opts?: { query?: string; publisher?: string }) => {
    const a = getAPI()
    if (!a) return
    const q = opts?.query ?? query
    const p = opts?.publisher ?? publisher
    const seq = ++searchSeq.current
    setSearching(true)
    setSearchError(null)
    // A search term spans all publishers; a publisher tab lists that publisher.
    const res = await a.models.search(q.trim() ? { query: q, limit: 30 } : { publisher: p, limit: 30 })
    if (seq !== searchSeq.current) return
    setSearching(false)
    if (res.ok) setModels(res.models || [])
    else { setModels([]); setSearchError(res.error || 'Search failed') }
  }, [query, publisher])

  const openModel = useCallback(async (repoId: string) => {
    const a = getAPI()
    if (!a) return
    setDetail(null)
    setDetailError(null)
    setDescription(null)
    setDetailLoading(true)
    detailSeq.current += 1
    const seq = detailSeq.current
    const res = await a.models.detail(repoId)
    if (seq !== detailSeq.current) return
    setDetailLoading(false)
    if (res.ok) setDetail(res.detail || null)
    else { setDetailError(res.error || 'Could not load this model'); return }

    // Same staleness guard as the search box, for the same reason: opening a
    // second model while a slow card is still in flight must not caption it
    // with the first model's description.
    const described = await a.models.describe(repoId)
    if (seq !== detailSeq.current) return
    setDescription(described.ok ? (described.description ?? null) : null)
  }, [])

  const closeModel = useCallback(() => {
    detailSeq.current += 1
    setDetail(null); setDetailError(null); setDescription(null)
  }, [])

  const download = useCallback(async (artifact: ModelArtifact) => {
    if (!detail) return
    setDownloading(true)
    setDownloadError(null)
    setProgress({ repoId: detail.repoId, artifactId: artifact.id, state: 'downloading', receivedBytes: 0, totalBytes: artifact.totalBytes ?? 0 })
    const res = await api().models.download({
      repoId: detail.repoId, revision: detail.revision, artifact,
    })
    setDownloading(false)
    if (!res.ok && !res.cancelled) setDownloadError(res.error || 'Download failed')
    await refreshLocal()
  }, [detail, refreshLocal])

  const cancelDownload = useCallback(async () => { await api().models.cancelDownload() }, [])

  // Picking itself lives in FolderPicker.tsx; this applies
  // whatever path comes back.
  const changeFolder = useCallback(async (picked: string) => {
    await api().settings.setModelsDir(picked)
    await refreshLocal()
  }, [refreshLocal])

  const deleteLocal = useCallback(async (name: string) => {
    await api().models.deleteLocal(name)
    await refreshLocal()
  }, [refreshLocal])

  // --- Bootstrap ---
  //
  // Nothing here reaches the network, and nothing runs until the user asks.
  // Launching Nest must not cost a Hugging Face round trip, and neither must
  // merely opening the Models tab: the catalog is opt-in behind an explicit
  // button, so a machine that is offline, air-gapped, or busy serving a loaded
  // model never talks to the Hub at all unless someone clicks.
  //
  // The mount effect is a local event subscription only — no IPC, no fetch.
  useEffect(() => {
    const a = getAPI()
    if (!a) return
    a.events.onModelDownloadProgress(setProgress)
    return () => a.events.offModelDownloadProgress()
  }, [])

  // Called when the Models tab mounts. Local disk only — a readdir and a
  // statfs, no network.
  const openTab = useCallback(async () => {
    const a = getAPI()
    if (!a) return
    await refreshLocal()
    // Re-attach to a transfer already running in the main process, so
    // switching tabs mid-download does not present it as idle.
    a.models.downloadStatus().then(s => setDownloading(s.active))
  }, [refreshLocal])

  // The one place the Hub is contacted, and only on an explicit click.
  const connectCatalog = useCallback(async () => {
    const a = getAPI()
    if (!a) return
    setCatalogEnabled(true)
    a.models.publishers().then(setPublishers)
    await runSearch({ publisher: 'unsloth', query: '' })
  }, [runSearch])

  // A local file with the same name as an artifact's first shard means it is
  // already here — the tab marks it rather than offering the download again.
  const localNames = new Set(localFiles.filter(f => !f.partial).map(f => f.name.toLowerCase()))

  return {
    catalogEnabled, connectCatalog, openTab,
    publishers, publisher, setPublisher,
    query, setQuery,
    models, searching, searchError, runSearch,
    detail, detailLoading, detailError, description, openModel, closeModel,
    modelsDir, localFiles, disk, localNames,
    refreshLocal, changeFolder, deleteLocal,
    progress, downloading, downloadError, download, cancelDownload,
  }
}

export type ModelCatalogHook = ReturnType<typeof useModelCatalog>
