// =============================================================================
// Images — the picture model, the way Model is the chat model.
// =============================================================================
// Image generation needs what a chat model needs: a model chosen on Hugging
// Face, downloaded, picked as the one in use, deleted when done with. Plus an
// engine (stable-diffusion.cpp) downloaded once. That is a page's worth of
// setup, so it has one; Tools keeps only the switch that lets the assistant
// use it (docs/notes/image-generation-plan.md).
//
// Nest knows image model FAMILIES (FLUX schnell/dev, SDXL, SD 1.x). Within a
// family any checkpoint works, and the family's shared files come along once.
//
// The cost is said plainly: the chat model pauses while a picture is made.
// =============================================================================

import { useState } from 'react'
import { getAPI } from '../api/redstart'
import type { HardwareSpecs, ImageGenerationStatus, ImageTransferProgress, LlamaConfig } from '../types'
import type { SectionId } from './Sidebar'
import { useImageGeneration, imageBlocker } from '../hooks/useImageGeneration'
import { Card, Chip, ConfirmDialog, Modal, PageHeader, SectionTitle, btnCls, inputCls } from '../components/ui'
import { ImageModelBrowser } from './ImageModelBrowser'

const size = (n: number | null | undefined) => typeof n === 'number' ? (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`) : '—'
const pct = (p: ImageTransferProgress | null) => p?.totalBytes ? Math.min(100, Math.round(((p.receivedBytes ?? 0) / p.totalBytes) * 100)) : 0

export function ImagesSection({ config, documentsConfigured, onNavigate, hardware, diskFreeBytes }: {
  config: LlamaConfig
  documentsConfigured: boolean
  onNavigate: (s: SectionId) => void
  /** For the browser's "Your computer" line: facts beside each download. */
  hardware: HardwareSpecs | null
  diskFreeBytes?: number
}) {
  const { status, error, engineProgress, downloadProgress, run } = useImageGeneration()
  const [finding, setFinding] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const api = getAPI()

  const toolOn = config.tools?.activeToolIds?.includes('image_generation') ?? false
  const active = status?.models.find(m => m.file === status.model) ?? null
  const blocker = imageBlocker(status, documentsConfigured)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Images">
        Pictures the assistant makes on this computer&rsquo;s GPU, with an image model you choose.
      </PageHeader>

      {!status || !api ? <Card><p className="text-sm text-zinc-500">Checking…</p></Card> : (<>

        {/* ── In use ── */}
        <Card>
          <div className="flex flex-wrap items-start gap-4">
            <div className="min-w-[16rem] flex-1">
              <div className="mb-1 text-[13px] text-zinc-400">Image model in use</div>
              {active ? (<>
                <div className="break-all text-lg font-semibold text-zinc-50">{active.repoId}</div>
                <div className="mt-1 break-all text-[13px] text-zinc-500">{active.familyLabel} · {active.rfilename} · {size(active.bytes)}</div>
              </>) : (
                <div className="text-lg font-semibold text-zinc-300">No image model chosen yet</div>
              )}
            </div>
            <div className="flex flex-col items-end gap-2">
              {status.busy ? <Chip tone="info">Making a picture</Chip> : blocker ? <Chip tone="warn">Not ready</Chip> : toolOn ? <Chip tone="ok">Ready</Chip> : <Chip tone="off">Ready, tool off</Chip>}
            </div>
          </div>
          <div className="mt-4 space-y-2 border-t border-zinc-800 pt-4 text-[13px] text-zinc-400">
            {blocker && <p className="text-amber-300">{blocker}</p>}
            {error && <p className="text-red-400">{error}</p>}
            {status.busy && <p className="text-zinc-200">Making a picture now{status.busy.paused ? '; the chat model is paused until it is done' : ''}.</p>}
            <p>
              {toolOn
                ? 'The assistant may make pictures with the running profile.'
                : 'The assistant cannot make pictures yet: turn Image generation on for this profile in Tools.'}
              {' '}<button type="button" className={btnCls.subtle} onClick={() => onNavigate('tools')}>Open Tools</button>
            </p>
            <p>While a picture is made (about 20 to 60 seconds), the chat model pauses so the image model can use the GPU, then reloads by itself. Chats wait for it. A role can withhold the tool on the Roles page.</p>
          </div>
        </Card>

        {/* ── Your image models ── */}
        <Card>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <SectionTitle className="mb-0 flex-1">Your image models</SectionTitle>
            <button type="button" className={btnCls.secondary} onClick={() => setFinding(true)}>Find one on Hugging Face</button>
          </div>
          {status.models.length === 0 && !status.downloading && (
            <p className="text-sm text-zinc-500">None yet. FLUX.1 schnell is a good first choice: Apache-2.0, about 10 GB with its shared files, four steps per picture. Search &ldquo;flux schnell gguf&rdquo;.</p>
          )}
          <div role="radiogroup" aria-label="Image models" className="flex flex-col gap-2">
            {status.models.map(m => {
              const isActive = m.file === status.model
              return (
                <div key={m.file} className={`flex flex-wrap items-center gap-3 rounded-xl border px-3.5 py-2.5 ${isActive ? 'border-orange-500/70 bg-orange-500/5' : 'border-zinc-800 bg-zinc-950/40'}`}>
                  <div className="min-w-[14rem] flex-1">
                    <div className="break-all text-sm font-medium text-zinc-100">{m.repoId} <span className="font-normal text-zinc-400">· {m.rfilename}</span></div>
                    <div className="text-[13px] text-zinc-500">{m.familyLabel} · {size(m.bytes)}{!m.ready && <span className="text-amber-300"> · files missing</span>}</div>
                  </div>
                  {isActive
                    ? <Chip tone="ok">In use</Chip>
                    : <button type="button" role="radio" aria-checked={false} className={btnCls.chip} onClick={() => run(api.capabilities.setImageGeneration({ model: m.file }))}>Use this</button>}
                  <button type="button" className={btnCls.subtle} onClick={() => setConfirmDelete(m.file)}>Delete</button>
                </div>
              )
            })}
          </div>
          {status.downloading && (
            <div className="mt-2 rounded-xl border border-zinc-800 bg-zinc-950/40 px-3.5 py-2.5">
              <div className="flex flex-wrap items-center gap-3 text-[13px] text-zinc-300">
                <span className="min-w-0 flex-1 break-all">Downloading {status.downloading.repoId} · {downloadProgress?.file ?? status.downloading.rfilename}</span>
                <span>{pct(downloadProgress)}%{downloadProgress?.totalBytes ? ` of ${size(downloadProgress.totalBytes)}` : ''}</span>
                <button type="button" className={btnCls.secondary} onClick={() => run(api.capabilities.cancelImageDownload())}>Cancel</button>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded bg-zinc-800"><div className="h-full bg-orange-500 transition-all" style={{ width: `${pct(downloadProgress)}%` }} /></div>
            </div>
          )}
          <p className="mt-3 text-[13px] text-zinc-500">Kept in the models folder (Model page), under <code>image/</code>.</p>
        </Card>

        {/* ── Engine ── */}
        <Card>
          <SectionTitle className="mb-1">Engine</SectionTitle>
          <p className="mb-3 text-[13px] text-zinc-400">
            stable-diffusion.cpp {status.engine.release}. Downloaded once, checked against a pinned hash, never bundled with Nest.
          </p>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-zinc-200">{status.engine.label ?? 'Not available on this platform'}</span>
            {status.engine.nvidia && <span className="text-[13px] text-zinc-500">NVIDIA GPU found</span>}
            <span className="flex-1" />
            {status.engine.installed
              ? <Chip tone="ok">Installed</Chip>
              : status.engine.buildKey && (
                <button type="button" className={btnCls.secondary} disabled={status.engine.installing || !!engineProgress}
                  onClick={() => run(api.capabilities.installImageEngine())}>
                  {status.engine.installing || engineProgress ? `Installing… ${pct(engineProgress)}%` : `Install now (${size(status.engine.downloadBytes)})`}
                </button>
              )}
          </div>
          <label className="mt-4 flex flex-wrap items-center gap-3 text-[13px] text-zinc-400">
            Build
            <select value={status.backend} onChange={e => run(api.capabilities.setImageGeneration({ backend: e.target.value as ImageGenerationStatus['backend'] }))}
              className={`${inputCls.sm} w-auto`}>
              <option value="auto">Automatic (CUDA with an NVIDIA GPU, otherwise Vulkan)</option>
              <option value="cuda">CUDA (NVIDIA only, about 1 GB, fastest)</option>
              <option value="vulkan">Vulkan (any GPU, 30 MB)</option>
              <option value="metal">Metal (Apple Silicon)</option>
            </select>
          </label>
          <p className="mt-2 text-[13px] text-zinc-500">On an RTX 3060, CUDA made a FLUX schnell picture in 17 s, Vulkan in 37 s.</p>
        </Card>

        <Modal open={finding} title="Find image models on Hugging Face" onClose={() => setFinding(false)} size="lg"
          footer={<button type="button" onClick={() => setFinding(false)} className={btnCls.secondary}>Done</button>}>
          <ImageModelBrowser status={status} hardware={hardware} diskFreeBytes={diskFreeBytes} progress={downloadProgress}
            onDownload={(req) => { void run(api.capabilities.downloadImageModel(req)) }}
            onCancel={() => { void run(api.capabilities.cancelImageDownload()) }} />
        </Modal>

        <ConfirmDialog open={!!confirmDelete} title="Delete this image model?" confirmLabel="Delete"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={async () => { const f = confirmDelete!; setConfirmDelete(null); await run(api.capabilities.deleteImageModel(f)) }}>
          The model file leaves the models folder. Its family&rsquo;s shared files stay, for other models of the same family.
        </ConfirmDialog>
      </>)}
    </div>
  )
}

