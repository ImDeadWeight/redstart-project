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

export function PythonCapabilityCard({ status, documentsConfigured, active, onToggle, onChanged }: {
  status: PythonCapabilityStatus | null
  documentsConfigured: boolean
  active: boolean
  onToggle: () => void
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
  const blocker = !status.sandboxAvailable
    ? status.sandboxProblem
    : !documentsConfigured
      ? 'Choose a Documents folder first: each conversation\'s files live in it.'
      : !status.runtimeInstalled
        ? 'The Python runtime is not installed yet.'
        : null

  return (
    <div className="bg-zinc-800/40 rounded px-3 py-2.5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-zinc-200">Python</span>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className={`text-xs ${active && !blocker ? 'text-green-400' : active ? 'text-amber-400' : 'text-zinc-500'}`}>
            {active ? (blocker ? 'Enabled, not ready' : 'Enabled') : 'Disabled'}
          </span>
          <button onClick={onToggle} className={btnCls.chip}>{active ? 'Disable' : 'Enable'}</button>
        </div>
      </div>

      {blocker && <p className="text-xs text-amber-400 mb-1.5">{blocker}</p>}

      {status.sandboxAvailable && !status.runtimeInstalled && (
        <div className="flex items-center gap-2 mb-1.5">
          <button onClick={install} disabled={busy} className={btnCls.secondary}>
            {busy ? 'Installing…' : `Install runtime (~${mb(status.approxDownloadBytes)})`}
          </button>
          <span className="text-xs text-zinc-500">Pyodide {status.pyodideVersion}, every file hash-checked</span>
        </div>
      )}
      {status.runtimeProblem && <p className="text-xs text-red-400 mb-1.5">Installed runtime failed verification: {status.runtimeProblem}. Install again to repair it.</p>}

      <div className="flex items-center gap-3 mb-1.5 flex-wrap">
        <label className="text-xs text-zinc-400 flex items-center gap-1.5">
          Warm kernels
          <input type="number" min={1} max={8} value={maxKernels} onChange={e => setMaxKernels(Number(e.target.value))} className={`${inputCls.xs.replace("w-full", "")} w-16`} />
        </label>
        <label className="text-xs text-zinc-400 flex items-center gap-1.5">
          Default timeout (s)
          <input type="number" min={1} max={120} value={timeoutS} onChange={e => setTimeoutS(Number(e.target.value))} className={`${inputCls.xs.replace("w-full", "")} w-16`} />
        </label>
        <button onClick={save} className={btnCls.chip}>Save</button>
        <span className="text-xs text-zinc-500">≈ {mb(status.approxKernelBytes * maxKernels)} of RAM with every kernel warm</span>
      </div>

      {error && <p className="text-xs text-red-400 mb-1.5">{error}</p>}

      <p className="text-xs text-zinc-600 mt-1.5">
        Lets the model run Python {status.pythonVersion} ({status.packages.join(', ')}) against the files in each conversation's workspace
        (Documents → chats/&lt;conversation&gt;), and show charts. It runs in WebAssembly under Node's permission model{status.sandboxNode ? ` (Node ${status.sandboxNode})` : ''}:
        no network, no programs, and no files outside that workspace. One kernel per active conversation, stopped after 10 idle minutes.
        Workspaces are limited to {status.workspaceCapMb} MB each and {status.accountCapMb} MB per account, and go to the trash with their conversation.
      </p>
    </div>
  )
}
