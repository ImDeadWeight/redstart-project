import { useEffect, useState } from 'react'
import { getAPI } from '../api/redstart'
import type { ImageGenerationStatus } from '../types'
import { imageBlocker } from '../hooks/useImageGeneration'
import { btnCls } from './ui'

// The Image generation row's settings in the Tools list. Setup (the image
// model, the engine) lives on its own Images page; this row only says whether
// the tool can work and links there. Reads the status once when opened: the
// download and install events belong to the Images page's hook.
export function ImageGenerationCard({ documentsConfigured, onOpenImages }: {
  documentsConfigured: boolean
  onOpenImages: () => void
}) {
  const [status, setStatus] = useState<ImageGenerationStatus | null>(null)

  useEffect(() => {
    getAPI()?.capabilities.imageGeneration().then(setStatus).catch(() => {})
  }, [])

  const blocker = imageBlocker(status, documentsConfigured)
  const active = status?.models.find(m => m.file === status.model)

  return (
    <div className="space-y-3">
      {blocker
        ? <p className="text-[13px] text-amber-300">{blocker}</p>
        : <p className="text-[13px] text-zinc-300">Ready: {active?.familyLabel} ({active?.repoId}).</p>}
      <p className="text-[13px] text-zinc-400">The chat model pauses while a picture is made, then reloads by itself.</p>
      <button type="button" className={btnCls.secondary} onClick={onOpenImages}>Image model and engine: open Images</button>
    </div>
  )
}
