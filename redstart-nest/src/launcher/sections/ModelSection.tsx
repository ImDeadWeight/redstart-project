// =============================================================================
// Model — which model answers, and how much it can hold in mind at once.
// =============================================================================
// Brings together what used to be split across the Models tab (hardware, the
// model list, storage, Hugging Face) and the Configuration tab (the launch
// settings). Two settings stay up front in plain words; the llama.cpp flags
// sit behind "Advanced settings", one click away.
//
// Model sizes are shown as FACTS beside the machine's VRAM/RAM, never as a
// "fits / doesn't fit" verdict: that would need a memory estimator that
// llama-server's own --fit already does better at load time, and it would be
// confidently wrong on MoE offload and on non-NVIDIA GPUs (where the VRAM
// figure is capped at 4 GB by a Windows API quirk).
// =============================================================================

import { useEffect, useState } from 'react'
import type { LlamaConfig, LocalModelFile } from '../types'
import type { useHardwareAndBinary } from '../hooks/useHardwareAndBinary'
import type { ModelCatalogHook } from '../hooks/useModelCatalog'
import { Card, Chip, Modal, PageHeader, SectionTitle, btnCls, inputCls } from '../components/ui'
import { FolderPicker } from '../components/FolderPicker'
import { HuggingFaceBrowser } from './HuggingFaceBrowser'

const gb = (n: number | null | undefined) => typeof n === 'number' ? `${(n / 1024 ** 3).toFixed(1)} GB` : '—'
const samePath = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
const baseName = (p: string) => p.split(/[\\/]/).pop() || p

const CONTEXT_PRESETS: { value: number; label: string }[] = [
  { value: 4096, label: 'Very short (4K tokens)' },
  { value: 8192, label: 'Short (8K tokens)' },
  { value: 16384, label: 'Standard (16K tokens)' },
  { value: 32768, label: 'Long (32K tokens)' },
  { value: 65536, label: 'Very long (64K tokens)' },
  { value: 131072, label: 'Longest (128K tokens)' },
]

const KV_HELP: Record<NonNullable<LlamaConfig['kvCache']>, string> = {
  off: 'Full-precision cache. Uses the most GPU memory, so it holds the least conversation.',
  conservative: 'A light saving, nearly identical to full precision.',
  balanced: 'Holds about 3 to 4 times more conversation, with almost no loss in quality.',
  aggressive: 'Holds the most. Best for mixture-of-experts models such as Qwen3.6; check the answers on your model.',
}

function Field({ label, children, hint, className = '' }: { label: string; children: React.ReactNode; hint?: string; className?: string }) {
  return (
    <label className={`flex flex-col gap-1.5 text-[13px] text-zinc-400 ${className}`}>
      {label}
      {children}
      {hint && <span className="text-zinc-500">{hint}</span>}
    </label>
  )
}

export function ModelSection({
  config, setConfig, networkMode, hw, catalog, isRunning,
  generatedCommand, onGenerateCommand,
}: {
  config: LlamaConfig
  setConfig: React.Dispatch<React.SetStateAction<LlamaConfig>>
  networkMode: boolean
  hw: ReturnType<typeof useHardwareAndBinary>
  catalog: ModelCatalogHook
  isRunning: boolean
  generatedCommand: string
  onGenerateCommand: () => void
}) {
  const { hardware, scanHardware, applyModelPath } = hw
  const { modelsDir, localFiles, disk, changeFolder, deleteLocal } = catalog
  const [hfOpen, setHfOpen] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<LocalModelFile | null>(null)

  // Local disk only: a readdir and a statfs. Hugging Face is not contacted
  // until someone presses Connect inside the popup.
  const { openTab } = catalog
  useEffect(() => { openTab() }, [openTab])

  const modelPath = config.modelPath
  const usable = localFiles.filter(f => !f.partial && !f.embedding && !f.extraShard).sort((a, b) => a.name.localeCompare(b.name))
  const others = localFiles.filter(f => f.partial || f.embedding || f.extraShard)
  const inUse = usable.find(f => modelPath && samePath(f.path, modelPath))
  const set = <K extends keyof LlamaConfig>(k: K, v: LlamaConfig[K]) => setConfig(prev => ({ ...prev, [k]: v }))
  const ctxIsPreset = CONTEXT_PRESETS.some(p => p.value === config.ctxSize)

  const hwLine = hardware
    ? [
        hardware.gpu.name ? `${hardware.gpu.name}, ${(hardware.gpu.vram / 1024).toFixed(0)} GB` : null,
        `${hardware.memory.total.toFixed(0)} GB memory`,
        disk.freeBytes !== undefined ? `${gb(disk.freeBytes)} free on the models drive` : null,
      ].filter(Boolean).join(' · ')
    : null

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Model">Which model answers, and how much it can hold in mind at once.</PageHeader>

      {/* ── In use ── */}
      <Card>
        <div className="flex flex-wrap items-center gap-4">
          <div className="min-w-[16rem] flex-1">
            <div className="mb-1 text-[13px] text-zinc-400">In use</div>
            {modelPath ? (<>
              <div className="break-all text-lg font-semibold text-zinc-50">{baseName(modelPath)}</div>
              <code className="mt-1 block break-all text-[13px] text-zinc-500">{inUse ? `${gb(inUse.size)} · in the models folder` : modelPath}</code>
            </>) : (
              <div className="text-lg font-semibold text-zinc-300">No model chosen yet</div>
            )}
          </div>
          {isRunning && modelPath && <Chip tone="info">A new choice applies when the model restarts</Chip>}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-zinc-800 pt-4 text-[13px] text-zinc-400">
          <span>This computer: {hwLine ? <span className="text-zinc-200">{hwLine}</span> : 'not checked yet'}</span>
          <button type="button" onClick={scanHardware} className={btnCls.subtle}
            data-tip="Look for the GPU, memory and processor again">
            {hardware ? 'Check again' : 'Check hardware'}
          </button>
        </div>
      </Card>

      {/* ── Your models ── */}
      <Card>
        <SectionTitle className="mb-1">Your models</SectionTitle>
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-zinc-400">
          <span>Kept in</span>
          <code className="break-all text-[13px] text-zinc-300">{modelsDir || '—'}</code>
          <FolderPicker mode="directory" allowCreate title="Choose the models folder" startPath={modelsDir || undefined}
            onPick={changeFolder} className={btnCls.subtle}>Change</FolderPicker>
        </div>

        {usable.length > 0 ? (
          <div role="radiogroup" aria-label="Models in the models folder" className="flex max-h-96 flex-col gap-2 overflow-y-auto pr-1">
            {usable.map(f => {
              const active = !!modelPath && samePath(f.path, modelPath)
              return (
                <div key={f.path} className={`flex flex-wrap items-center gap-3 rounded-xl border px-3.5 py-2.5 ${active ? 'border-orange-500/70 bg-orange-500/5' : 'border-zinc-800 bg-zinc-950/40'}`}>
                  <div className="min-w-[14rem] flex-1">
                    <div className="break-all text-sm font-medium text-zinc-100">{f.name}</div>
                    <div className="text-[13px] text-zinc-500">{gb(f.size)}</div>
                  </div>
                  {active
                    ? <Chip tone="ok">In use</Chip>
                    : <button type="button" role="radio" aria-checked={false} onClick={() => applyModelPath(f.path)} className={btnCls.chip}>Use this</button>}
                  <button type="button" onClick={() => setConfirmDelete(f)} className={btnCls.subtle} disabled={active}
                    data-tip={active ? 'Choose another model before deleting this one' : 'Delete this file from the models folder'} data-tip-end="">
                    Delete
                  </button>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-sm text-zinc-500">No models in this folder yet. Find one on Hugging Face, or use a .gguf file from somewhere else.</p>
        )}

        {others.length > 0 && (
          <details className="mt-3">
            <summary className="flex items-center gap-2 text-[13px] text-zinc-400"><span className="chev">›</span>{others.length} other file{others.length === 1 ? '' : 's'} (incomplete downloads, extra parts, the search model)</summary>
            <ul className="mt-2 space-y-1">
              {others.map(f => (
                <li key={f.name} className="flex items-center gap-3 text-[13px]">
                  <span className={`min-w-0 flex-1 break-all ${f.partial ? 'text-amber-300' : 'text-zinc-400'}`}>
                    {f.name}{f.partial ? ' — incomplete download' : f.embedding ? ' — used by document and tool search' : ' — part of a split model'}
                  </span>
                  <span className="text-zinc-500">{gb(f.size)}</span>
                  {f.partial && <button type="button" onClick={() => deleteLocal(f.name)} className={btnCls.subtle}>Delete</button>}
                </li>
              ))}
            </ul>
          </details>
        )}

        <div className="mt-4 flex flex-wrap gap-2 border-t border-zinc-800 pt-4">
          <button type="button" onClick={() => setHfOpen(true)} className={btnCls.secondary}>Find models on Hugging Face</button>
          <FolderPicker mode="file" extensions={['gguf']} extensionLabel="GGUF models" title="Choose a .gguf file"
            startPath={modelPath || (modelsDir ? `${modelsDir}${modelsDir.includes('\\') ? '\\' : '/'}` : undefined)} onPick={applyModelPath} className={btnCls.secondary}>
            Use a file from another folder…
          </FolderPicker>
        </div>
      </Card>

      {/* ── How it runs ── */}
      <Card>
        <SectionTitle className="mb-4">How it runs</SectionTitle>
        <div className="grid max-w-3xl gap-4 md:grid-cols-2">
          <Field label="Memory for each conversation" hint="Longer lets it read bigger documents and use more tools, and uses more GPU memory.">
            <select value={config.ctxSize} onChange={e => set('ctxSize', parseInt(e.target.value) || config.ctxSize)} className={inputCls.sm}>
              {!ctxIsPreset && <option value={config.ctxSize}>Custom ({config.ctxSize.toLocaleString()} tokens)</option>}
              {CONTEXT_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </Field>
          <Field label="Memory saving" hint={KV_HELP[config.kvCache ?? 'off']}>
            <select value={config.kvCache ?? 'off'} onChange={e => set('kvCache', e.target.value as LlamaConfig['kvCache'])} className={inputCls.sm}>
              <option value="off">Off — best quality, uses the most memory</option>
              <option value="conservative">Light</option>
              <option value="balanced">Balanced — recommended</option>
              <option value="aggressive">Maximum — for mixture-of-experts models</option>
            </select>
          </Field>
        </div>
        {config.ctxSize < 8192 && (
          <p className="mt-3 rounded-lg bg-amber-950/50 px-3 py-2 text-[13px] text-amber-200">
            With less than 8K tokens, a single web page or document can fill the whole conversation. Tools work better with 16K or more.
          </p>
        )}

        <div className="mt-5 border-t border-zinc-800 pt-4">
          <button type="button" onClick={() => setAdvanced(v => !v)} aria-expanded={advanced}
            className="flex items-center gap-2 text-left text-sm font-medium text-zinc-100">
            <span className={`inline-block text-lg leading-none transition-transform ${advanced ? 'rotate-90' : ''}`}>›</span>
            Advanced settings
            <span className="font-normal text-zinc-500">— for people who know llama.cpp</span>
          </button>
          {advanced && (
            <div className="mt-4 flex flex-wrap items-start gap-x-5 gap-y-4">
              <Field label="Context size (tokens)" className="w-36">
                <input type="number" value={config.ctxSize} onChange={e => set('ctxSize', parseInt(e.target.value) || 0)} className={`${inputCls.sm} font-mono`} />
              </Field>
              <Field label="Batch size" className="w-28">
                <input type="number" value={config.batchSize} onChange={e => set('batchSize', parseInt(e.target.value) || 0)} className={`${inputCls.sm} font-mono`} />
              </Field>
              <Field label="Threads" className="w-24">
                <input type="number" value={config.threads} onChange={e => set('threads', parseInt(e.target.value) || 0)} className={`${inputCls.sm} font-mono`} />
              </Field>
              <Field label="GPU layers" hint="Blank lets llama-server decide." className="w-44">
                <input type="number" value={config.gpuLayers ?? ''} placeholder="Automatic"
                  onChange={e => { const v = parseInt(e.target.value); set('gpuLayers', isNaN(v) || v < 0 ? undefined : v) }}
                  className={`${inputCls.sm} font-mono`} />
              </Field>
              <Field label="Experts on the CPU (N-CPU-MoE)" hint="MoE models only. Blank is automatic." className="w-60">
                <input type="number" value={config.nCpuMoe ?? ''} placeholder="Automatic"
                  onChange={e => { const v = parseInt(e.target.value); set('nCpuMoe', isNaN(v) || v < 0 ? undefined : v) }}
                  className={`${inputCls.sm} font-mono`} />
              </Field>
              <Field label="Process priority" className="w-36">
                <select value={config.priority ?? 'normal'} onChange={e => set('priority', e.target.value === 'high' ? 'high' : undefined)} className={inputCls.sm}>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                </select>
              </Field>
              <Field label="Port" hint="The next two are used internally." className="w-56">
                <input type="number" value={config.port} onChange={e => set('port', parseInt(e.target.value) || 0)} className={`${inputCls.sm} font-mono`} />
              </Field>
              <Field label="Host" hint={networkMode ? 'Set by "Everyone on my network".' : undefined} className="w-56">
                <input type="text" value={networkMode ? '0.0.0.0' : config.host} readOnly={networkMode}
                  onChange={e => set('host', e.target.value)} className={`${inputCls.sm} font-mono read-only:opacity-60`} />
              </Field>
              <label className="flex items-center gap-2.5 self-center pt-5 text-sm text-zinc-200">
                <input type="checkbox" checked={!!config.noMmap} onChange={e => set('noMmap', e.target.checked)} className="h-4 w-4" />
                Disable memory-mapping (--no-mmap)
              </label>
              <div className="w-full max-w-2xl">
                <Field label="Extra llama-server flags">
                  <input type="text" value={config.additionalArgs ?? ''} placeholder="e.g. --flash-attn on"
                    onChange={e => set('additionalArgs', e.target.value)} className={`${inputCls.sm} font-mono`} />
                </Field>
              </div>
              <div className="w-full">
                <div className="mb-1.5 flex items-center justify-between gap-3">
                  <span className="text-[13px] text-zinc-400">The command Nest will run</span>
                  <button type="button" onClick={onGenerateCommand} className={btnCls.chip}>{generatedCommand ? 'Refresh' : 'Show'}</button>
                </div>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-300">
                  {generatedCommand || 'Press Show to see the launch command for these settings.'}
                </pre>
              </div>
            </div>
          )}
        </div>
      </Card>

      <Modal open={hfOpen} title="Find models on Hugging Face" onClose={() => setHfOpen(false)} size="lg"
        footer={<button type="button" onClick={() => setHfOpen(false)} className={btnCls.secondary}>Done</button>}>
        <HuggingFaceBrowser catalog={catalog} hardware={hardware} />
      </Modal>

      <Modal open={!!confirmDelete} title="Delete this model file?" onClose={() => setConfirmDelete(null)} size="sm"
        footer={<>
          <button type="button" onClick={() => setConfirmDelete(null)} className={btnCls.secondary}>Cancel</button>
          <button type="button" className={btnCls.danger}
            onClick={() => { if (confirmDelete) deleteLocal(confirmDelete.name); setConfirmDelete(null) }}>Delete</button>
        </>}>
        <p className="text-sm text-zinc-300">
          <span className="break-all font-medium text-zinc-100">{confirmDelete?.name}</span> ({gb(confirmDelete?.size)}) leaves the models folder.
          On a desktop install it goes to the Recycle Bin; on a headless install it is deleted outright.
        </p>
      </Modal>
    </div>
  )
}
