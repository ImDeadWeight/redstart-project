// =============================================================================
// FolderPicker — the one component behind all nine former per-site pickers.
// =============================================================================
// A small modal driven by browse:roots / browse:list / browse:mkdir
// (admin/browse-routes.mjs) — pick a root, click into directories,
// optionally create one, confirm. Used identically whether the caller is a
// browser or the Electron launcher itself: the native-dialog
// branch this component used to have (isDaemonLocal()) is retired along with
// IPC entirely — "a native dialog browses the CLIENT's disk, wrong
// the moment a browser or remote launcher is the caller" stopped being a
// branch to gate and became simply true of every caller, always.
//
// FILE MODE: browse:list is directories-only by design (it never
// returns file contents, and a filename is not a directory to click into).
// So picking a FILE is "navigate to the folder, then type the filename"
// rather than a clickable file list.
// =============================================================================

import { useEffect, useState } from 'react'
import { api } from '../api/redstart'
import { btnCls, inputCls, Modal } from './ui'

function FolderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-zinc-400">
      <path d="M3 6h6l2 2h10v11H3z" />
    </svg>
  )
}

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

// readable/writable come from the daemon's own access() probe,
// not from anything the browser can work out. They are what makes "the picker
// refuses a folder it cannot use" possible at all.
type Entry = { name: string; kind: 'directory'; readable?: boolean; writable?: boolean }

// In file mode the caller's startPath is the CURRENT FILE (e.g. the selected
// .gguf), which browse:list cannot open — it answered ENOTDIR. Split it into
// the folder to browse and the name to pre-fill. Either separator, since the
// path is the daemon's and may be Windows or POSIX. A root-level file keeps
// its trailing separator ("C:\"), which is the form browse:list expects.
export function splitFilePath(p: string): { dir: string; name: string } {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  if (i < 0) return { dir: '', name: p }
  const dir = p.slice(0, i)
  return { dir: dir === '' || /^[A-Za-z]:$/.test(dir) ? p.slice(0, i + 1) : dir, name: p.slice(i + 1) }
}
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
    if (mode === 'file' && startPath) {
      const { dir, name } = splitFilePath(startPath)
      setFileName(name)
      load(dir || null)
      return
    }
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

  const canConfirm = !!path && access.readable !== false && !(mode === 'file' && !fileName.trim())
  const confirm = () => {
    if (!path || !canConfirm) return
    const sep = path.endsWith('\\') || path.endsWith('/') ? '' : (path.includes('\\') ? '\\' : '/')
    onConfirm(mode === 'file' ? `${path}${sep}${fileName.trim()}` : path)
  }

  return (
    <Modal
      open
      title={title || (mode === 'file' ? 'Choose a file' : 'Choose a folder')}
      onClose={onCancel}
      footer={<>
        {allowCreate && path !== null && !creating && (
          <button type="button" onClick={() => setCreating(true)} className={`${btnCls.secondary} mr-auto`}>New folder</button>
        )}
        {allowCreate && creating && (
          <div className="mr-auto flex items-center gap-2">
            <input autoFocus value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') createFolder(); if (e.key === 'Escape') { e.stopPropagation(); setCreating(false) } }}
              aria-label="New folder name" placeholder="Folder name" className={inputCls.sm} />
            <button type="button" onClick={createFolder} className={btnCls.secondary}>Create</button>
          </div>
        )}
        <button type="button" onClick={onCancel} className={btnCls.secondary}>Cancel</button>
        <button type="button" disabled={!canConfirm} onClick={confirm} className={btnCls.primary}>
          {mode === 'file' ? 'Use this file' : 'Use this folder'}
        </button>
      </>}>
      <div className="flex flex-col gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {path !== null && (
            <button type="button" onClick={() => load(parent === null ? null : parent)} className={btnCls.secondary}
              aria-label="Up one folder" data-tip="Up one folder">↑</button>
          )}
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-[13px] text-zinc-300">
            {path ?? 'Choose where to start'}
          </code>
        </div>

        <div className="max-h-72 overflow-y-auto rounded-lg border border-zinc-800">
          {loading && <p className="p-3 text-sm text-zinc-500">Loading…</p>}

          {!loading && path === null && roots.map((r) => (
            <button key={r.path} type="button" onClick={() => load(r.path)}
              className="flex w-full items-center gap-2.5 border-b border-zinc-800/70 px-3 py-2 text-left text-sm text-zinc-200 last:border-b-0 hover:bg-zinc-800">
              <FolderIcon /> {r.label}
            </button>
          ))}

          {!loading && path !== null && reason && (
            <p className="p-3 text-sm text-red-400">Can&apos;t open this folder: {reason}</p>
          )}

          {!loading && path !== null && !reason && entries.length === 0 && (
            <p className="p-3 text-sm text-zinc-500">No folders here.</p>
          )}

          {!loading && path !== null && entries.map((e) => (
            <button key={e.name} type="button" onClick={() => load(`${path}${path.endsWith('\\') || path.endsWith('/') ? '' : '/'}${e.name}`)}
              className="flex w-full items-center gap-2.5 border-b border-zinc-800/70 px-3 py-2 text-left text-sm text-zinc-200 last:border-b-0 hover:bg-zinc-800">
              <FolderIcon /> {e.name}
            </button>
          ))}
        </div>

        {/* The one hard requirement: say it HERE, while the admin is still
            looking at the picker, rather than letting the path be saved and
            fail later inside a tool call - where the error reaches the user as
            a confused model instead of as a permissions problem. Only fires at
            level 3, where the daemon runs as a service account that was never
            granted this folder. */}
        {!loading && path !== null && access.readable === false && (
          <p className="text-sm text-red-400">
            Redstart cannot read this folder. Grant its account access, or choose another one.
          </p>
        )}
        {!loading && path !== null && access.readable !== false && access.writable === false && (
          <p className="text-sm text-amber-400">
            Redstart can read this folder but not write to it. Fine for read-only use; anything
            that saves a file here will fail.
          </p>
        )}

        {error && <p className="text-sm text-red-400">{error}</p>}

        {mode === 'file' && path !== null && (
          <label className="flex flex-col gap-1.5 text-[13px] text-zinc-400">
            File name in this folder
            <input value={fileName} onChange={(e) => setFileName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') confirm() }}
              placeholder="e.g. model.gguf" className={`${inputCls.sm} font-mono`} />
            <span className="text-zinc-500">Folders on the server are listed, not files, so type the file&rsquo;s name.</span>
          </label>
        )}
      </div>
    </Modal>
  )
}
