import type { LlamaConfig } from '../types'
import { SectionTitle, inputCls } from '../components/ui'

export function ConfigTab({ config, setConfig, networkMode, generatedCommand, onGenerateCommand }: {
  config: LlamaConfig
  setConfig: React.Dispatch<React.SetStateAction<LlamaConfig>>
  networkMode: boolean
  generatedCommand: string
  onGenerateCommand: () => void
}) {
  return (
    <>
      <section className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">
        <SectionTitle className="mb-4">Configuration</SectionTitle>
        <div className="grid grid-cols-3 gap-4">
          {([
            ['ctxSize', 'Context Size'],
            ['batchSize', 'Batch Size'],
            ['threads', 'Threads'],
            ['port', 'Port'],
          ] as [keyof LlamaConfig, string][]).map(([field, label]) => (
            <div key={field}>
              <label className="block text-xs text-zinc-500 mb-1">{label}</label>
              <input
                type="number"
                value={config[field] as number}
                onChange={e => setConfig(prev => ({ ...prev, [field]: parseInt(e.target.value) || 0 }))}
                className={inputCls.sm}
              />
            </div>
          ))}
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Host</label>
            <input
              type="text"
              value={networkMode ? '0.0.0.0' : config.host}
              readOnly={networkMode}
              onChange={e => setConfig(prev => ({ ...prev, host: e.target.value }))}
              className={`${inputCls.sm} read-only:opacity-50`}
            />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-4 gap-4">
          <div>
            <label className="block text-xs text-zinc-500 mb-1">GPU Layers <span className="text-zinc-600">(blank = auto)</span></label>
            <input
              type="number"
              value={config.gpuLayers ?? ''}
              onChange={e => {
                const v = parseInt(e.target.value)
                setConfig(prev => ({ ...prev, gpuLayers: isNaN(v) || v < 0 ? undefined : v }))
              }}
              placeholder="Auto (recommended)"
              className={inputCls.sm}
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">N-CPU-MoE <span className="text-zinc-600">(MoE models only, blank = auto)</span></label>
            <input
              type="number"
              value={config.nCpuMoe ?? ''}
              onChange={e => {
                const v = parseInt(e.target.value)
                setConfig(prev => ({ ...prev, nCpuMoe: isNaN(v) || v < 0 ? undefined : v }))
              }}
              placeholder="Auto (recommended)"
              className={inputCls.sm}
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Process Priority</label>
            <select
              value={config.priority ?? 'normal'}
              onChange={e => setConfig(prev => ({ ...prev, priority: e.target.value === 'high' ? 'high' : undefined }))}
              className={inputCls.sm}
            >
              <option value="normal">Normal</option>
              <option value="high">High</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Mmap</label>
            <label className="flex items-center gap-2 h-[34px] px-2 cursor-pointer select-none text-sm text-zinc-300">
              <input
                type="checkbox"
                checked={!!config.noMmap}
                onChange={e => setConfig(prev => ({ ...prev, noMmap: e.target.checked }))}
                className="accent-orange-500"
              />
              Disable (--no-mmap)
            </label>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-4">
          <div>
            <label className="block text-xs text-zinc-500 mb-1">
              KV Cache <span className="text-zinc-600">(TurboQuant)</span>
            </label>
            <select
              value={config.kvCache ?? 'off'}
              onChange={e => setConfig(prev => ({ ...prev, kvCache: e.target.value as LlamaConfig['kvCache'] }))}
              className={inputCls.sm}
            >
              <option value="off">Off (f16 — largest VRAM)</option>
              <option value="conservative">Conservative — q8_0 / turbo4</option>
              <option value="balanced">Balanced — q8_0 / turbo3 (recommended)</option>
              <option value="aggressive">Aggressive (MoE) — q8_0 / turbo2</option>
            </select>
          </div>
          <div className="col-span-2 flex items-end">
            <p className="text-xs text-zinc-500 leading-relaxed">
              {config.kvCache === 'off'
                ? 'Full-precision f16 KV cache. Largest memory footprint — context is capped by VRAM.'
                : config.kvCache === 'conservative'
                ? 'Lightest turbo tier. Near-identical to f16; a modest KV memory win.'
                : config.kvCache === 'aggressive'
                ? '~2-bit V with Boundary V layer protection — best for MoE models like Qwen3.6. Fits the most context; validate quality on your model.'
                : 'Near-lossless K, ~4.6× compressed V (<1.5% PPL loss). Total KV ~3–4× smaller than f16 — lets you roughly 3–4× the context on the same card.'}
            </p>
          </div>
        </div>

        <div className="mt-4">
          <label className="block text-xs text-zinc-500 mb-1">Additional args</label>
          <input
            type="text"
            value={config.additionalArgs ?? ''}
            onChange={e => setConfig(prev => ({ ...prev, additionalArgs: e.target.value }))}
            placeholder="Extra flags for llama-server"
            className={inputCls.sm}
          />
        </div>
      </section>

      <section className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">
        <div className="flex justify-between items-center mb-2">
          <SectionTitle className="">Command Preview</SectionTitle>
          <button onClick={onGenerateCommand}
            className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-xs transition-colors">
            Generate
          </button>
        </div>
        <pre className="text-xs text-orange-400 overflow-x-auto whitespace-pre-wrap break-all">
          {generatedCommand || 'Click Generate to preview the launch command'}
        </pre>
      </section>
    </>
  )
}
