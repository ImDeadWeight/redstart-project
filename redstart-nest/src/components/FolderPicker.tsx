// =============================================================================
// FolderPicker — the one component behind all nine former per-site pickers
// (headless-admin-plane-plan.md Phase 4 §4.3).
// =============================================================================
// Renders a native dialog when isDaemonLocal() and a server-side directory
// browser otherwise, so no call site branches on transport (trap 5.2: a
// native dialog browses the CLIENT's disk, wrong the moment a browser or a
// remote launcher is the caller).
//
// Local branch: one round trip to browse:pick-native (ipc/browse.mjs), a real
// dialog.showOpenDialog on whichever machine the daemon runs on.
//
// Remote branch: a small modal driven by browse:roots / browse:list /
// browse:mkdir (admin/browse-routes.mjs) — pick a root, click into
// directories, optionally create one, confirm.
//
// FILE MODE, REMOTELY: browse:list is directories-only by design (§4.2 — it
// never returns file contents, and a filename is not a directory to click
// into). So picking a FILE remotely is "navigate to the folder, then type the
// filename" rather than a clickable file list. Still strictly better than the
// 501 it replaces.
// =============================================================================

import { useEffect, useState } from 'react'
import { api, isDaemonLocal } from '../api/redstart'
import { btnCls, inputCls } from './ui'

export type FolderPickerProps = {
  mode: 'file' | 'directory'
  /** File mode only, e.g. ['gguf']. */
  extensions?: string[]
  extensionLabel?: string
  /** Directory mode only — offers *New Folder* in the native dialog / a Remote "New folder" affordance. */
  allowCreate?: boolean
  title?: string
  /** Where to start browsing — the current value, or a sensible default. */
  startPath?: string
  onPick: (path: string) => void
  /** Rendered as the trigger. Defaults to a small "Browse…" secondary button. */
  children?: React.ReactNode
  className?: string
  disabled?: boolean
}

export function FolderPicker({
  mode, extensions, extensionLabel, allowCreate, title, startPath, onPick, children, className, disabled,
}: FolderPickerProps) {
  const [browserOpen, setBrowserOpen] = useState(false)

  async function openNative() {
    const picked = await api().browse.pickNative({
      mode, extensions, extensionLabel, allowCreate, title,
      defaultPath: startPath,
    })
    if (picked) onPick(picked)
  }

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => (isDaemonLocal() ? openNative() : setBrowserOpen(true))}
        className={className ?? btnCls.secondary}>
        {children ?? 'Browse…'}
      </button>
      {browserOpen && (
        <RemoteBrowserModal
          mode={mode}
          allowCreate={allowCreate}
          title={title}
          startPath={startPath}
          onCancel={() => setBrowserOpen(false)}
          onConfirm={(path) => { setBrowserOpen(false); onPick(path) }}
        />
      )}
    </>
  )
}

// --- the remote browser modal -----------------------------------------------

type Entry = { name: string; kind: 'directory' }
type Root = { path: string; label: string }

function RemoteBrowserModal({
  mode, allowCreate, title, startPath, onCancel, onConfirm,
}: {
  mode: 'file' | 'directory'
  allowCreate?: boolean
  title?: string
  startPath?: string
  onCancel: () => void
  onConfirm: (path: string) => void
}) {
  const [roots, setRoots] = useState<Root[]>([])
  const [path, setPath] = useState<string | null>(null)
  const [parent, setParent] = useState<string | null>(null)
  const [entries, setEntries] = useState<Entry[]>([])
  const [reason, setReason] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [fileName, setFileName] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function load(target: string | null) {
    setLoading(true)
    setError(null)
    try {
      if (target === null) {
        const r = await api().browse.roots()
        setRoots(r)
        setPath(null)
        setEntries([])
        setParent(null)
        setReason(null)
      } else {
        const result = await api().browse.list({ path: target })
        setPath(result.path)
        setParent(result.parent)
        setEntries(result.entries)
        setReason(result.reason ?? null)
      }
    } catch {
      setError('Could not reach the daemon.')
    } finally {
      setLoading(false)
    }
  }

  // File mode still needs SOMEWHERE to start browsing — directories only are
  // ever listed (browse:list never returns file contents), so the admin
  // navigates to the containing folder and confirms it; there is no remote
  // file-level picker. Directory mode's confirm target is wherever they are.
  useEffect(() => {
    load(startPath ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function createFolder() {
    if (!path || !newFolderName.trim()) return
    const result = await api().browse.mkdir({ path, name: newFolderName.trim() })
    if (result.ok) {
      setNewFolderName('')
      setCreating(false)
      await load(path)
    } else {
      setError(result.error || 'Could not create the folder')
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-lg w-full max-w-lg max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <p className="font-medium text-zinc-200 text-sm">{title || (mode === 'file' ? 'Choose a file location' : 'Choose a folder')}</p>
          <button onClick={onCancel} className={btnCls.subtle}>Cancel</button>
        </div>

        <div className="px-4 py-2 border-b border-zinc-800 flex items-center gap-2 min-w-0">
          {path !== null && (
            <button onClick={() => load(parent === null ? null : parent)} className={btnCls.subtle} title="Up">↑</button>
          )}
          <p className="text-xs text-zinc-400 truncate flex-1">{path ?? 'Select a starting point'}</p>
        </div>

        <div className="overflow-y-auto flex-1 p-2">
          {loading && <p className="text-xs text-zinc-500 p-2">Loading…</p>}

          {!loading && path === null && roots.map((r) => (
            <button key={r.path} onClick={() => load(r.path)}
              className="w-full text-left px-3 py-2 rounded hover:bg-zinc-800 text-sm text-zinc-200">
              📁 {r.label}
            </button>
          ))}

          {!loading && path !== null && reason && (
            <p className="text-xs text-red-400 p-2">Can&apos;t open this folder: {reason}</p>
          )}

          {!loading && path !== null && !reason && entries.length === 0 && (
            <p className="text-xs text-zinc-500 p-2">No subfolders here.</p>
          )}

          {!loading && path !== null && entries.map((e) => (
            <button key={e.name} onClick={() => load(`${path}${path.endsWith('\\') || path.endsWith('/') ? '' : '/'}${e.name}`)}
              className="w-full text-left px-3 py-2 rounded hover:bg-zinc-800 text-sm text-zinc-200">
              📁 {e.name}
            </button>
          ))}
        </div>

        {error && <p className="text-xs text-red-400 px-4 pb-2">{error}</p>}

        {mode === 'file' && path !== null && (
          <div className="px-4 py-2 border-t border-zinc-800">
            <input value={fileName} onChange={(e) => setFileName(e.target.value)}
              placeholder="File name" className={inputCls.sm} />
          </div>
        )}

        <div className="px-4 py-3 border-t border-zinc-800 flex items-center gap-2">
          {allowCreate && path !== null && !creating && (
            <button onClick={() => setCreating(true)} className={btnCls.subtle}>New folder</button>
          )}
          {allowCreate && creating && (
            <div className="flex items-center gap-2 flex-1">
              <input autoFocus value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createFolder()}
                placeholder="Folder name" className={inputCls.sm} />
              <button onClick={createFolder} className={btnCls.secondary}>Create</button>
            </div>
          )}
          <div className="flex-1" />
          <button
            disabled={!path || (mode === 'file' && !fileName.trim())}
            onClick={() => {
              if (!path) return
              const sep = path.endsWith('\\') || path.endsWith('/') ? '' : (path.includes('\\') ? '\\' : '/')
              onConfirm(mode === 'file' ? `${path}${sep}${fileName.trim()}` : path)
            }}
            className={btnCls.primary}>
            {mode === 'file' ? 'Choose this file' : 'Choose this folder'}
          </button>
        </div>
      </div>
    </div>
  )
}
