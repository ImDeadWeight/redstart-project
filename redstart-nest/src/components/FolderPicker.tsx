// =============================================================================
// FolderPicker — the one component behind all nine former per-site pickers
// (headless-admin-plane-plan.md Phase 4 §4.3).
// =============================================================================
// A small modal driven by browse:roots / browse:list / browse:mkdir
// (admin/browse-routes.mjs) — pick a root, click into directories,
// optionally create one, confirm. Used identically whether the caller is a
// browser or the Electron launcher itself: Phase 6 retired the native-dialog
// branch this component used to have (isDaemonLocal()) along with IPC
// entirely — trap 5.2's "a native dialog browses the CLIENT's disk, wrong
// the moment a browser or remote launcher is the caller" stopped being a
// branch to gate and became simply true of every caller, always.
//
// FILE MODE: browse:list is directories-only by design (§4.2 — it never
// returns file contents, and a filename is not a directory to click into).
// So picking a FILE is "navigate to the folder, then type the filename"
// rather than a clickable file list.
// =============================================================================

import { useEffect, useState } from 'react'
import { api } from '../api/redstart'
import { btnCls, inputCls } from './ui'

export type FolderPickerProps = {
  mode: 'file' | 'directory'
  /** File mode only, e.g. ['gguf']. Unused now that there is no native filter to apply — kept on the props so call sites don't need to change if a filtered remote listing is ever added. */
  extensions?: string[]
  extensionLabel?: string
  /** Directory mode only — offers a "New folder" affordance. */
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
  mode, allowCreate, title, startPath, onPick, children, className, disabled,
}: FolderPickerProps) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className={className ?? btnCls.secondary}>
        {children ?? 'Browse…'}
      </button>
      {open && (
        <BrowserModal
          mode={mode}
          allowCreate={allowCreate}
          title={title}
          startPath={startPath}
          onCancel={() => setOpen(false)}
          onConfirm={(path) => { setOpen(false); onPick(path) }}
        />
      )}
    </>
  )
}

// --- the browser modal -------------------------------------------------

// Phase 8B.6 - readable/writable come from the daemon's own access() probe,
// not from anything the browser can work out. They are what makes "the picker
// refuses a folder it cannot use" possible at all (design section 3.5).
type Entry = { name: string; kind: 'directory'; readable?: boolean; writable?: boolean }
type Root = { path: string; label: string }

function BrowserModal({
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
  const [access, setAccess] = useState<{ readable?: boolean; writable?: boolean }>({})
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
        setAccess({})
      } else {
        const result = await api().browse.list({ path: target })
        setPath(result.path)
        setParent(result.parent)
        setEntries(result.entries)
        setReason(result.reason ?? null)
        setAccess({ readable: result.readable, writable: result.writable })
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

        {/* Phase 8B.6, design section 3.5's one hard requirement: say it HERE,
            while the admin is still looking at the picker, rather than letting
            the path be saved and fail later inside a tool call - where the
            error reaches the user as a confused model instead of as a
            permissions problem. Only fires at level 3, where the daemon runs
            as a service account that was never granted this folder. */}
        {!loading && path !== null && access.readable === false && (
          <p className="text-xs text-red-400 px-4 pb-2">
            Redstart cannot read this folder. Grant its account access, or choose another one.
          </p>
        )}
        {!loading && path !== null && access.readable !== false && access.writable === false && (
          <p className="text-xs text-amber-500 px-4 pb-2">
            Redstart can read this folder but not write to it. Fine for read-only use; anything
            that saves a file here will fail.
          </p>
        )}

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
            disabled={!path || access.readable === false || (mode === 'file' && !fileName.trim())}
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
