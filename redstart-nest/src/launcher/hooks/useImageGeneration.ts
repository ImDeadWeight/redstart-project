import { useCallback, useEffect, useState } from 'react'
import { getAPI } from '../api/redstart'
import type { ImageGenerationStatus, ImageTransferProgress } from '../types'

// Image generation's state for the Images page: settings, image models, the
// engine, and the two downloads' progress (image models, the engine). Owns the
// image:download-progress and image:runtime-progress subscriptions — the event
// proxy keeps one callback per channel, so only this hook subscribes to them.
export function useImageGeneration() {
  const [status, setStatus] = useState<ImageGenerationStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [engineProgress, setEngineProgress] = useState<ImageTransferProgress | null>(null)
  const [downloadProgress, setDownloadProgress] = useState<ImageTransferProgress | null>(null)

  const load = useCallback(async () => {
    const a = getAPI()
    if (!a) return
    try { setStatus(await a.capabilities.imageGeneration()) } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }, [])

  useEffect(() => {
    load()
    const a = getAPI()
    if (!a) return
    a.events.onImageRuntimeProgress((p) => {
      setEngineProgress(['complete', 'error'].includes(p.state) ? null : p)
      if (p.state === 'complete') load()
    })
    a.events.onImageDownloadProgress((p) => {
      setDownloadProgress(['complete', 'cancelled', 'error'].includes(p.state) ? null : p)
      if (p.state === 'error' && p.error) setError(p.error)
      if (p.state !== 'downloading') load()
    })
    // A picture being made (status.busy) has no event of its own here — the
    // pause events belong to useServerLifecycle — so the page re-reads its
    // status while it is open.
    const poll = setInterval(load, 4000)
    return () => { clearInterval(poll); a.events.offImageRuntimeProgress(); a.events.offImageDownloadProgress() }
  }, [load])

  /** Run an action, show its error, then reload the status. */
  const run = useCallback(async <T extends { ok: boolean; error?: string }>(p: Promise<T>) => {
    setError(null)
    const r = await p
    if (!r.ok && r.error) setError(r.error)
    await load()
    return r
  }, [load])

  return { status, error, setError, engineProgress, downloadProgress, load, run }
}

/** Why generate_image cannot work yet, or null when it can. Shared by the Images page and the Tools row. */
export function imageBlocker(status: ImageGenerationStatus | null, documentsConfigured: boolean): string | null {
  if (!status) return 'Checking…'
  const active = status.models.find(m => m.file === status.model) ?? null
  if (!documentsConfigured) return 'Choose a Documents folder first (Tools → Documents): each chat\'s pictures are saved there.'
  if (!active) return 'No image model chosen yet.'
  if (!active.ready) return 'The chosen image model is missing some of its files; download it again.'
  if (!status.engine.installed) return 'The image engine is not installed yet. It downloads on the first picture, or install it now.'
  return null
}
