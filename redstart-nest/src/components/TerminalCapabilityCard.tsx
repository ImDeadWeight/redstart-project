import { useEffect, useState } from 'react'
import { api } from '../api/redstart'
import type { TerminalCapabilityStatus } from '../types'
import { btnCls, inputCls } from './ui'

// The Terminal (run_command) card in the Tools tab (agent-runtime Phase 4).
//
// What the card must say, and says first: this grants host access (plan D20,
// U3). A command runs as this machine's user, so it can reach the network
// and read every account's files and the secrets key, wherever it starts.
// It is offered to the owner account only, and never when sign-in is off
// and the server is open to the network.
//
// The program list is typed by the admin (a name such as `git`, or an
// absolute path) and resolved by the daemon on Save: each entry shows what it
// resolved to, and one entry that cannot be used refuses the whole save with
// the reason (a .cmd-only program, a name not on PATH). npm and npx resolve
// to node plus npm's CLI script, so no batch file is ever run.

export function TerminalCapabilityCard({ status, documentsConfigured, active, onToggle, onChanged }: {
  status: TerminalCapabilityStatus | null
  documentsConfigured: boolean
  active: boolean
  onToggle: () => void
  onChanged: () => void | Promise<void>
}) {
  const [entries, setEntries] = useState('')
  const [extraDirs, setExtraDirs] = useState('')
  const [defaultTimeoutS, setDefaultTimeoutS] = useState(60)
  const [maxTimeoutS, setMaxTimeoutS] = useState(600)
  const [outputCapKb, setOutputCapKb] = useState(16)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!status) return
    setEntries(status.executables.map((e) => e.entry).join('\n'))
    setExtraDirs(status.extraDirs.join('\n'))
    setDefaultTimeoutS(status.defaultTimeoutS)
    setMaxTimeoutS(status.maxTimeoutS)
    setOutputCapKb(Math.round(status.outputCapBytes / 1024))
  }, [status])

  if (!status) return null

  const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean)
  const live = status.executables.filter((e) => !e.missing)
  const blocker = !documentsConfigured
    ? 'Choose a Documents folder first: commands run in each conversation\'s workspace there.'
    : live.length === 0
      ? 'Add at least one program below and save.'
      : null

  async function save() {
    setError(null)
    setSaving(true)
    try {
      const result = await api().capabilities.setTerminal({
        executables: lines(entries),
        extraDirs: lines(extraDirs),
        defaultTimeoutS,
        maxTimeoutS,
        outputCapBytes: outputCapKb * 1024,
      })
      if (!result.ok) setError(result.error || 'Failed to save')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
      await onChanged()
    }
  }

  const num = `${inputCls.xs.replace('w-full', '')} w-16`

  return (
    <div className="bg-zinc-800/40 rounded px-3 py-2.5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-zinc-200">Terminal</span>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className={`text-xs ${active && !blocker ? 'text-green-400' : active ? 'text-amber-400' : 'text-zinc-500'}`}>
            {active ? (blocker ? 'Enabled, not ready' : 'Enabled') : 'Disabled'}
          </span>
          <button onClick={onToggle} className={btnCls.chip}>{active ? 'Disable' : 'Enable'}</button>
        </div>
      </div>

      <p className="text-xs text-red-400 mb-1.5">
        Grants host access. A command runs as this machine's user: it can reach the network and read every
        account's files and Redstart's secrets, wherever it starts. This is not a sandbox. Offered to the
        owner account only, and never while sign-in is off and the server is open to the network.
      </p>

      {blocker && <p className="text-xs text-amber-400 mb-1.5">{blocker}</p>}

      <label className="text-xs text-zinc-400 block mb-1">
        Programs the assistant may run, one per line (a name on this machine's PATH, or an absolute path)
      </label>
      <textarea
        value={entries}
        onChange={(e) => setEntries(e.target.value)}
        rows={3}
        placeholder={'git\nnode\nnpm'}
        className={`${inputCls.xs} font-mono mb-1`}
      />
      {status.executables.length > 0 && (
        <ul className="text-xs text-zinc-500 mb-1.5 space-y-0.5">
          {status.executables.map((e) => (
            <li key={e.name} className={e.missing ? 'text-amber-400' : ''}>
              <span className="font-mono text-zinc-300">{e.name}</span> → <span className="font-mono break-all">{e.file}{e.prefixArgs.length ? ` ${e.prefixArgs.join(' ')}` : ''}</span>
              {e.missing && ' (no longer on disk: not offered until saved again)'}
            </li>
          ))}
        </ul>
      )}

      <label className="text-xs text-zinc-400 block mb-1">Extra folders commands may run in, one absolute path per line (optional)</label>
      <textarea
        value={extraDirs}
        onChange={(e) => setExtraDirs(e.target.value)}
        rows={2}
        className={`${inputCls.xs} font-mono mb-1.5`}
      />

      <div className="flex items-center gap-3 mb-1.5 flex-wrap">
        <label className="text-xs text-zinc-400 flex items-center gap-1.5">
          Default timeout (s)
          <input type="number" min={status.limits.timeoutS.min} max={status.limits.timeoutS.max} value={defaultTimeoutS} onChange={(e) => setDefaultTimeoutS(Number(e.target.value))} className={num} />
        </label>
        <label className="text-xs text-zinc-400 flex items-center gap-1.5">
          Max (s)
          <input type="number" min={status.limits.timeoutS.min} max={status.limits.timeoutS.max} value={maxTimeoutS} onChange={(e) => setMaxTimeoutS(Number(e.target.value))} className={num} />
        </label>
        <label className="text-xs text-zinc-400 flex items-center gap-1.5">
          Output kept (KB)
          <input type="number" min={1} max={1024} value={outputCapKb} onChange={(e) => setOutputCapKb(Number(e.target.value))} className={num} />
        </label>
        <button onClick={save} disabled={saving} className={btnCls.chip}>{saving ? 'Saving…' : 'Save'}</button>
      </div>

      {error && <p className="text-xs text-red-400 mb-1.5">{error}</p>}

      <p className="text-xs text-zinc-600 mt-1.5">
        Gives the owner's assistant run_command: one listed program with an argument list, no shell (pipes,
        redirection and && are plain text to it), in the conversation's workspace. Every command shows its exact
        arguments and asks first; "Always allow" covers one program and its first argument (git status), never a
        program as a whole. The exit code comes back first, then the output and the files it changed. Windows
        .cmd and .bat programs cannot be listed; npm and npx run through node.
      </p>
    </div>
  )
}
