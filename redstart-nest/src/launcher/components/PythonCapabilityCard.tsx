import { useEffect, useState } from 'react'
import { api } from '../api/redstart'
import type { PythonCapabilityStatus } from '../types'
import { btnCls, inputCls } from './ui'

// The Python (run_python) card in the Tools tab. Three things gate the tool,
// and the card states each one rather than leaving the admin to guess why an
// enabled capability produces nothing:
//
//   1. the sandbox: a Node with the network permission (python-runtime.mjs).
//      Not something the card can fix, so it only says why.
//   2. the runtime: a one-time ~30 MB pinned download, installed from here.
//   3. Documents configured: the workspaces live in its folder.
//
// Memory is stated next to the kernel cap because it is the real cost: each
// warm kernel holds ~457 MB (measured in Phase 1.0).

const mb = (bytes: number) => `${Math.round(bytes / 1048576)} MB`

/** Why run_python cannot work yet, or null when it can. Shared with the Tools list's status chip. */
export function pythonBlocker(status: PythonCapabilityStatus | null, documentsConfigured: boolean): string | null {
  if (!status) return 'Checking…'
  return !status.sandboxAvailable
    ? status.sandboxProblem
    : !documentsConfigured
      ? 'Choose a Documents folder first: each conversation\'s files live in it.'
      : !status.runtimeInstalled
        ? 'The Python runtime is not installed yet.'
        : null
}

// The settings for Python, shown when its row in the Tools list is open. The
// row itself carries the name, status and on/off switch.
export function PythonCapabilityCard({ status, documentsConfigured, onChanged }: {
  status: PythonCapabilityStatus | null
  documentsConfigured: boolean
  onChanged: () => void | Promise<void>
}) {
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [maxKernels, setMaxKernels] = useState(2)
  const [timeoutS, setTimeoutS] = useState(30)

  useEffect(() => {
    if (!status) return
    setMaxKernels(status.maxKernels)
    setTimeoutS(status.timeoutS)
  }, [status?.maxKernels, status?.timeoutS])

  if (!status) return null

  async function install() {
    setError(null)
    setInstalling(true)
    try {
      const result = await api().capabilities.installPython()
      if (!result.ok) setError(result.error || 'Install failed')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(false)
      await onChanged()
    }
  }

  async function save() {
    setError(null)
    const result = await api().capabilities.setPython({ maxKernels, timeoutS })
    if (!result.ok) setError(result.error || 'Failed to save')
    await onChanged()
  }

  const busy = installing || status.installing
  const blocker = pythonBlocker(status, documentsConfigured)

  return (
    <div className="space-y-3">
      {blocker && <p className="text-[13px] text-amber-300">{blocker}</p>}

      {status.sandboxAvailable && !status.runtimeInstalled && (
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={install} disabled={busy} className={btnCls.secondary}>
            {busy ? 'Installing…' : `Install runtime (~${mb(status.approxDownloadBytes)})`}
          </button>
          <span className="text-[13px] text-zinc-500">Pyodide {status.pyodideVersion}, every file hash-checked</span>
        </div>
      )}
      {status.runtimeProblem && <p className="text-[13px] text-red-400">Installed runtime failed verification: {status.runtimeProblem}. Install again to repair it.</p>}

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5 text-[13px] text-zinc-400">
          Warm kernels
          <input type="number" min={1} max={8} value={maxKernels} onChange={e => setMaxKernels(Number(e.target.value))} className={`${inputCls.sm.replace('w-full', '')} w-20 font-mono`} />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] text-zinc-400">
          Time limit (seconds)
          <input type="number" min={1} max={120} value={timeoutS} onChange={e => setTimeoutS(Number(e.target.value))} className={`${inputCls.sm.replace('w-full', '')} w-20 font-mono`} />
        </label>
        <button onClick={save} className={btnCls.secondary}>Save</button>
        <span className="pb-2 text-[13px] text-zinc-500">≈ {mb(status.approxKernelBytes * maxKernels)} of memory with every kernel warm</span>
      </div>

      {error && <p className="text-[13px] text-red-400">{error}</p>}

      <p className="text-[13px] leading-relaxed text-zinc-500">
        Python {status.pythonVersion} ({status.packages.join(', ')}) in WebAssembly under Node&rsquo;s permission model{status.sandboxNode ? ` (Node ${status.sandboxNode})` : ''}:
        no network, no programs, and no files outside the conversation&rsquo;s workspace. One kernel per active conversation, stopped after 10 idle minutes.
        Workspaces are limited to {status.workspaceCapMb} MB each and {status.accountCapMb} MB per account.
      </p>
    </div>
  )
}
