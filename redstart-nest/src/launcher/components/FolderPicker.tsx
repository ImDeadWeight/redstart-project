// =============================================================================
// FolderPicker — the one component behind every file and folder picker.
// =============================================================================
// A file explorer in a modal, driven by browse:roots / browse:list /
// browse:mkdir (admin/browse-routes.mjs). It browses the computer NEST runs
// on, whatever the caller is — a browser anywhere on the network, or the
// launcher's own window: "a native dialog browses the CLIENT's disk" is true
// of every caller, so there is no native-dialog branch.
//
// Layout, approved as a mockup on 2026-11-23:
//   - a sidebar of places: the models folder and recent folders, model
//     libraries other tools keep (Hugging Face cache, LM Studio — both in
//     hidden folders that were otherwise reachable only by pasting a path),
//     Home/Desktop/Documents/Downloads, and drives with their free space;
//   - back / forward / up, and a breadcrumb trail where every folder above
//     is one click away; "Type path" swaps it for an editable box (paste a
//     folder, or a file in file mode, and press Enter);
//   - a filter box, "Only .gguf files" and "Show hidden folders" switches,
//     and Name / Size / Modified columns that sort;
//   - the full chosen path in the footer before anything is confirmed.
//
// File mode: click a folder to open it, a matching file to select it,
// double-click a file to use it. Directory mode: click a folder to select it,
// double-click (or → / Enter on the selected one) to open it; with nothing
// selected, "Use this folder" takes the folder being shown.
//
// MAC AND WINDOWS ALIKE. Paths are the daemon's, so separators are read off
// each path (pickerPaths.ts), never off the browser's platform — a Windows
// Nest driven from a Mac browser works the same as either alone. Sidebar
// wording follows the daemon's platform (Finder's "Favorites" / "Locations",
// Explorer's "Quick access" / "This PC"), and so do the keyboard shortcuts
// (⌘↑ / ⌘[ / ⌘] on a Mac, Alt+↑ / Alt+← / Alt+→ elsewhere, Backspace on
// both). macOS privacy prompts are never triggered by the sidebar: the
// daemon checks only that those folders exist, and reading inside one
// happens when the admin opens it.
// =============================================================================

import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type BrowseEntry, type BrowseRoot } from '../api/redstart'
import { btnCls, inputCls, Modal } from './ui'
import {
  baseName, crumbsFor, formatDate, formatSize, isWindowsPath, joinPath, samePath, splitFilePath,
} from './pickerPaths'

export { splitFilePath } from './pickerPaths'

export type FolderPickerProps = {
  mode: 'file' | 'directory'
  /** File mode only, e.g. ['gguf']. Matching files are listed by the daemon; 'exe' also matches extensionless executables off Windows. */
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
  mode, extensions, allowCreate, title, startPath, onPick, children, className, disabled,
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
          extensions={extensions}
          allowCreate={allowCreate}
          title={title}
          startPath={startPath}
          onCancel={() => setOpen(false)}
          onConfirm={(path) => { setOpen(false); rememberRecent(mode === 'file' ? splitFilePath(path).dir : path); onPick(path) }}
        />
      )}
    </>
  )
}

// --- recent folders ----------------------------------------------------------

// Kept in this browser, not on the daemon: a short convenience list, and two
// admins on two machines each get their own. Paths only — never contents.
const RECENT_KEY = 'redstart.picker.recent'
const RECENT_MAX = 4

function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string' && !!p).slice(0, RECENT_MAX) : []
  } catch {
    return []
  }
}

function rememberRecent(dir: string) {
  if (!dir) return
  try {
    const next = [dir, ...readRecent().filter(p => !samePath(p, dir))].slice(0, RECENT_MAX)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {}
}

// --- icons -------------------------------------------------------------------

const ico = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const, 'aria-hidden': true }

function FolderIcon({ className = 'text-zinc-400' }: { className?: string }) {
  return <svg {...ico} className={`shrink-0 ${className}`}><path d="M3 6h6l2 2h10v11H3z" /></svg>
}
function FileIcon({ className = 'text-zinc-500' }: { className?: string }) {
  return <svg {...ico} className={`shrink-0 ${className}`}><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /></svg>
}
function ModelIcon({ className = 'text-orange-400' }: { className?: string }) {
  return <svg {...ico} className={`shrink-0 ${className}`}><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" /></svg>
}
function DriveIcon({ className = 'text-zinc-400' }: { className?: string }) {
  return <svg {...ico} className={`shrink-0 ${className}`}><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 14h.01M11 14h6" /></svg>
}
function StarIcon({ className = 'text-zinc-400' }: { className?: string }) {
  return <svg {...ico} className={`shrink-0 ${className}`}><path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z" /></svg>
}
function HomeIcon({ className = 'text-zinc-400' }: { className?: string }) {
  return <svg {...ico} className={`shrink-0 ${className}`}><path d="M4 11l8-7 8 7v9H4z" /><path d="M10 20v-5h4v5" /></svg>
}
function ClockIcon({ className = 'text-zinc-400' }: { className?: string }) {
  return <svg {...ico} className={`shrink-0 ${className}`}><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></svg>
}
function Chevron({ d }: { d: string }) {
  return <svg {...ico} strokeWidth={2}><path d={d} /></svg>
}

// --- the browser modal -----------------------------------------------------

type Place = { path: string; label: string; note?: string; icon: 'star' | 'clock' | 'library' | 'home' | 'folder' | 'drive' }
type SortKey = 'name' | 'size' | 'modified'

function PlaceIcon({ icon, active }: { icon: Place['icon']; active: boolean }) {
  const c = active ? 'text-orange-400' : 'text-zinc-400'
  if (icon === 'star') return <StarIcon className={c} />
  if (icon === 'clock') return <ClockIcon className={c} />
  if (icon === 'library') return <ModelIcon className={c} />
  if (icon === 'home') return <HomeIcon className={c} />
  if (icon === 'drive') return <DriveIcon className={c} />
  return <FolderIcon className={c} />
}

// The daemon's platform, read off its paths: Windows paths have a drive
// letter, a Mac's drives include the startup disk at `/` with /Volumes mounts.
function daemonPlatform(roots: BrowseRoot[]): 'win' | 'mac' | 'other' {
  if (roots.some(r => isWindowsPath(r.path))) return 'win'
  if (roots.some(r => r.group === 'drive' && r.path === '/' && r.label !== 'Computer')) return 'mac'
  return 'other'
}

function BrowserModal({
  mode, extensions, allowCreate, title, startPath, onCancel, onConfirm,
}: {
  mode: 'file' | 'directory'
  extensions?: string[]
  allowCreate?: boolean
  title?: string
  startPath?: string
  onCancel: () => void
  onConfirm: (path: string) => void
}) {
  const fileMode = mode === 'file' && !!extensions?.length
  const [roots, setRoots] = useState<BrowseRoot[]>([])
  const [modelsDir, setModelsDir] = useState('')
  const [recent] = useState<string[]>(readRecent)
  const [path, setPath] = useState<string | null>(null)
  const [parent, setParent] = useState<string | null>(null)
  const [entries, setEntries] = useState<BrowseEntry[]>([])
  const [reason, setReason] = useState<string | null>(null)
  const [access, setAccess] = useState<{ readable?: boolean; writable?: boolean }>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<{ stack: string[]; at: number }>({ stack: [], at: -1 })
  const [selected, setSelected] = useState('')
  const [filter, setFilter] = useState('')
  const [onlyMatch, setOnlyMatch] = useState(true)
  const [showHidden, setShowHidden] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 })
  const [editingPath, setEditingPath] = useState(false)
  const [typedPath, setTypedPath] = useState('')
  const [creating, setCreating] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const requestId = useRef(0)
  const crumbBox = useRef<HTMLDivElement>(null)

  const platform = daemonPlatform(roots)
  const isMac = platform === 'mac'

  // `record: false` is back/forward, which moves along the history instead
  // of adding to it. Returns the listing so a typed path can fall back to
  // "that was a file" on ENOTDIR.
  async function load(target: string, opts: { record?: boolean; select?: string; hidden?: boolean; all?: boolean } = {}) {
    const id = ++requestId.current
    setLoading(true)
    setError(null)
    try {
      const result = await api().browse.list({
        path: target,
        ...(fileMode ? { extensions, allFiles: opts.all ?? !onlyMatch } : {}),
        showHidden: opts.hidden ?? showHidden,
      })
      if (id !== requestId.current) return result
      setPath(result.path)
      setParent(result.parent)
      setEntries(result.entries)
      setReason(result.reason ?? null)
      setAccess({ readable: result.readable, writable: result.writable })
      setSelected(opts.select ?? '')
      setFilter('')
      setEditingPath(false)
      if (opts.record !== false) {
        setHistory(h => {
          if (h.stack[h.at] && samePath(h.stack[h.at], result.path)) return h
          const stack = [...h.stack.slice(0, h.at + 1), result.path]
          return { stack, at: stack.length - 1 }
        })
      }
      return result
    } catch {
      if (id === requestId.current) setError('Could not reach the daemon.')
      return null
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }

  // Start: the caller's current value (in file mode, the current FILE — open
  // its folder and pre-select it), else the models folder, else Home.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [r, md] = await Promise.all([
        api().browse.roots().catch(() => [] as BrowseRoot[]),
        api().settings.getModelsDir().catch(() => ''),
      ])
      if (cancelled) return
      setRoots(r)
      setModelsDir(md)
      const fallback = md || r.find(x => x.kind === 'home')?.path || r[0]?.path || ''
      if (mode === 'file' && startPath) {
        const { dir, name } = splitFilePath(startPath)
        const res = await load(dir || fallback, { select: name })
        if (res?.reason && fallback && dir !== fallback) await load(fallback)
        return
      }
      const res = await load(startPath || fallback)
      if (res?.reason && startPath && fallback && startPath !== fallback) await load(fallback)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Long paths: keep the END of the breadcrumb (where you are) in view.
  useEffect(() => {
    const el = crumbBox.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [path, editingPath])

  const go = (p: string) => { if (!path || !samePath(p, path)) void load(p) }
  const goBack = () => {
    if (history.at <= 0) return
    const at = history.at - 1
    setHistory(h => ({ ...h, at }))
    void load(history.stack[at], { record: false })
  }
  const goForward = () => {
    if (history.at >= history.stack.length - 1) return
    const at = history.at + 1
    setHistory(h => ({ ...h, at }))
    void load(history.stack[at], { record: false })
  }
  const goUp = () => { if (parent) void load(parent) }

  // A typed path may name a FILE in file mode (pasted from Finder with
  // ⌥⌘C, or from Explorer's "Copy as path", quotes and all): open its folder
  // and pre-select it.
  const goTyped = async () => {
    const t = typedPath.trim().replace(/^"(.*)"$/, '$1')
    if (!t) { setEditingPath(false); return }
    const looksLikeFile = fileMode && extensions!.some(ext => t.toLowerCase().endsWith(`.${ext.toLowerCase()}`))
    if (looksLikeFile) {
      const { dir, name } = splitFilePath(t)
      if (dir) { await load(dir, { select: name }); return }
    }
    const res = await load(t)
    if (fileMode && res?.reason === 'ENOTDIR') {
      const { dir, name } = splitFilePath(t)
      if (dir) await load(dir, { select: name })
    }
  }

  async function createFolder() {
    if (!path || !newFolderName.trim()) return
    const result = await api().browse.mkdir({ path, name: newFolderName.trim() })
    if (result.ok) {
      setNewFolderName('')
      setCreating(false)
      await load(path, { record: false, select: newFolderName.trim() })
    } else {
      setError(result.error || 'Could not create the folder')
    }
  }

  // --- places --------------------------------------------------------------
  const groups = useMemo(() => {
    const out: { label: string; items: Place[] }[] = []
    const mine: Place[] = []
    if (modelsDir) mine.push({ path: modelsDir, label: 'Models folder', icon: 'star' })
    for (const p of recent) {
      if (modelsDir && samePath(p, modelsDir)) continue
      mine.push({ path: p, label: baseName(p), note: p, icon: 'clock' })
    }
    if (mine.length) out.push({ label: 'Redstart', items: mine })
    const lib = roots.filter(r => r.group === 'library').map<Place>(r => ({ path: r.path, label: r.label, icon: 'library' }))
    if (lib.length) out.push({ label: 'Found on this computer', items: lib })
    const quick = roots.filter(r => r.group === 'quick').map<Place>(r => ({ path: r.path, label: r.label, icon: r.kind === 'home' ? 'home' : 'folder' }))
    if (quick.length) out.push({ label: platform === 'win' ? 'Quick access' : 'Favorites', items: quick })
    // An older daemon answers roots without `group`: show them all as drives.
    const drives = roots.filter(r => r.group === 'drive' || !r.group).map<Place>(r => ({
      path: r.path, label: r.label, icon: 'drive',
      note: typeof r.free === 'number' && typeof r.total === 'number' ? `${formatSize(r.free)} free of ${formatSize(r.total)}` : undefined,
    }))
    if (drives.length) out.push({ label: platform === 'win' ? 'This PC' : 'Locations', items: drives })
    return out
  }, [roots, modelsDir, recent, platform])

  // The sidebar highlights the deepest place holding the current folder only
  // when it IS that folder — "you are here", not "you are somewhere below".
  const activePlace = path ? groups.flatMap(g => g.items).find(p => samePath(p.path, path))?.path : undefined

  // --- rows ----------------------------------------------------------------
  const isMatch = (e: BrowseEntry) => e.kind === 'file' && e.match !== false
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const list = entries.filter(e => !q || e.name.toLowerCase().includes(q))
    list.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
      let v = 0
      if (sort.key === 'size') v = (a.size ?? 0) - (b.size ?? 0)
      else if (sort.key === 'modified') v = (a.modified ?? 0) - (b.modified ?? 0)
      if (v === 0) v = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      return v * sort.dir
    })
    return list
  }, [entries, filter, sort])

  const nDirs = rows.filter(e => e.kind === 'directory').length
  const nFiles = rows.length - nDirs
  const toggleSort = (key: SortKey) => setSort(s => s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 })
  const arrow = (key: SortKey) => sort.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''

  const selectedEntry = selected ? entries.find(e => e.name === selected) : undefined
  // File mode uses only a file that is actually listed here: a start value
  // naming a model that has since been deleted must not be confirmable.
  const pickPath = !path ? '' : fileMode
    ? (selectedEntry?.kind === 'file' ? joinPath(path, selected) : '')
    : (selected && selectedEntry?.kind === 'directory' ? joinPath(path, selected) : path)
  const pickUnreadable = fileMode
    ? selectedEntry?.readable === false
    : (selectedEntry?.kind === 'directory' ? selectedEntry.readable === false : access.readable === false)
  const canConfirm = !!pickPath && !pickUnreadable && !loading
  const confirm = (p = pickPath) => { if (p && !pickUnreadable) onConfirm(p) }

  const crumbs = path ? crumbsFor(path, roots) : []
  const onlyLabel = extensions?.length === 1 && extensions[0] === 'exe'
    ? (platform === 'win' ? 'Only .exe files' : 'Only programs')
    : `Only ${(extensions ?? []).map(e => `.${e}`).join(', ')} files`

  // Shortcuts, scoped to the dialog (never a global listener), and never
  // while typing in one of its boxes.
  function onKeyDown(e: React.KeyboardEvent) {
    const t = e.target as HTMLElement
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return
    const mod = isMac ? e.metaKey : e.altKey
    if (e.key === 'Backspace' || (mod && e.key === 'ArrowUp')) { e.preventDefault(); goUp() }
    else if ((mod && e.key === 'ArrowLeft') || (isMac && e.metaKey && e.key === '[')) { e.preventDefault(); goBack() }
    else if ((mod && e.key === 'ArrowRight') || (isMac && e.metaKey && e.key === ']')) { e.preventDefault(); goForward() }
  }

  const iconBtn = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:cursor-default disabled:opacity-35 disabled:hover:bg-zinc-800'
  const shortcut = (mac: string, other: string) => (isMac ? mac : other)

  return (
    <Modal
      open
      size="xl"
      flush
      title={title || (fileMode ? 'Choose a file' : 'Choose a folder')}
      subtitle={fileMode
        ? 'Browsing the computer Nest runs on. Click a folder to open it, click a file to select it, double-click to use it.'
        : 'Browsing the computer Nest runs on. Click a folder to select it, double-click to open it.'}
      onClose={onCancel}
      footer={<>
        {allowCreate && path !== null && !creating && (
          <button type="button" onClick={() => setCreating(true)} className={btnCls.secondary}>New folder</button>
        )}
        {allowCreate && creating && (
          <div className="flex items-center gap-2">
            <input autoFocus value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') createFolder(); if (e.key === 'Escape') { e.stopPropagation(); setCreating(false) } }}
              aria-label="New folder name" placeholder="Folder name" className={inputCls.sm} />
            <button type="button" onClick={createFolder} className={btnCls.secondary}>Create</button>
          </div>
        )}
        <div className="mr-auto flex min-w-0 flex-1 flex-col gap-0.5 px-1">
          <span className="text-[11px] text-zinc-400">{fileMode ? 'Selected file' : 'Folder to use'}</span>
          <span className={`truncate font-mono text-xs ${pickPath ? 'text-zinc-200' : 'text-zinc-400'}`} title={pickPath || undefined}>
            {pickPath || 'No file selected'}
          </span>
        </div>
        <button type="button" onClick={onCancel} className={btnCls.secondary}>Cancel</button>
        <button type="button" disabled={!canConfirm} onClick={() => confirm()} className={btnCls.primary}>
          {fileMode ? 'Use this file' : 'Use this folder'}
        </button>
      </>}>
      <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
        {/* ── toolbar ── */}
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
          <button type="button" className={iconBtn} onClick={goBack} disabled={history.at <= 0}
            aria-label="Back" data-tip={`Back (${shortcut('⌘[', 'Alt+←')})`}><Chevron d="M15 6l-6 6 6 6" /></button>
          <button type="button" className={iconBtn} onClick={goForward} disabled={history.at >= history.stack.length - 1}
            aria-label="Forward" data-tip={`Forward (${shortcut('⌘]', 'Alt+→')})`}><Chevron d="M9 6l6 6-6 6" /></button>
          <button type="button" className={iconBtn} onClick={goUp} disabled={!parent}
            aria-label="Up one folder" data-tip={`Up one folder (${shortcut('⌘↑', 'Alt+↑')})`}><Chevron d="M12 19V5M6 11l6-6 6 6" /></button>

          <div className="flex h-[34px] min-w-[12rem] flex-1 items-center rounded-md border border-zinc-700 bg-zinc-950 px-1">
            {editingPath ? (
              <input autoFocus value={typedPath} onChange={(e) => setTypedPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); void goTyped() }
                  if (e.key === 'Escape') { e.stopPropagation(); setEditingPath(false) }
                }}
                onBlur={() => setEditingPath(false)}
                aria-label={fileMode ? 'Folder or file path' : 'Folder path'} spellCheck={false}
                placeholder={isMac ? 'Paste a path (⌥⌘C in Finder copies one) and press Enter' : 'Paste a path and press Enter'}
                className="h-7 min-w-0 flex-1 bg-transparent px-2 font-mono text-[13px] text-zinc-100 outline-none placeholder:font-sans placeholder:text-zinc-500" />
            ) : (
              <>
                <nav aria-label="Folder path" ref={crumbBox} className="flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none]">
                  {crumbs.map((c, i) => (
                    <span key={c.path} className="flex shrink-0 items-center">
                      {i > 0 && <span aria-hidden="true" className="px-0.5 text-[13px] text-zinc-600">›</span>}
                      <button type="button" onClick={() => go(c.path)}
                        aria-current={i === crumbs.length - 1 ? 'location' : undefined}
                        className={`h-[26px] whitespace-nowrap rounded px-1.5 text-[13px] hover:bg-zinc-800 hover:text-zinc-100 ${i === crumbs.length - 1 ? 'font-medium text-zinc-100' : 'text-zinc-400'}`}>
                        {c.label}
                      </button>
                    </span>
                  ))}
                </nav>
                <button type="button" onClick={() => { setTypedPath(path ?? ''); setEditingPath(true) }}
                  className="flex h-[26px] shrink-0 items-center gap-1.5 rounded px-2 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                  aria-label="Type or paste a path">
                  <svg {...ico} width={14} height={14} strokeWidth={2}><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>
                  Type path
                </button>
              </>
            )}
          </div>

          <label className="flex h-[34px] w-full items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-950 px-2.5 text-zinc-400 sm:w-56">
            <svg {...ico} width={14} height={14} strokeWidth={2}><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter this folder"
              aria-label="Filter this folder" spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-zinc-100 outline-none placeholder:text-zinc-500" />
          </label>
        </div>

        <div className="flex h-[min(60vh,520px)] min-h-0 flex-col sm:flex-row">
          {/* ── places ── */}
          <nav aria-label="Places" className="flex max-h-40 shrink-0 flex-col gap-3.5 overflow-y-auto border-b border-zinc-800 px-2.5 py-3 sm:max-h-none sm:w-60 sm:border-b-0 sm:border-r">
            {groups.map(g => (
              <div key={g.label} className="flex flex-col gap-0.5">
                <p className="mb-1 ml-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{g.label}</p>
                {g.items.map(p => {
                  const active = p.path === activePlace
                  return (
                    <button key={`${g.label}:${p.path}`} type="button" onClick={() => go(p.path)}
                      aria-current={active ? 'page' : undefined} title={p.path}
                      className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] ${active ? 'bg-orange-500/10 text-orange-200' : 'text-zinc-200 hover:bg-zinc-800'}`}>
                      <PlaceIcon icon={p.icon} active={active} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">{p.label}</span>
                        {p.note && <span className="truncate text-[11px] text-zinc-400">{p.note}</span>}
                      </span>
                    </button>
                  )
                })}
              </div>
            ))}
          </nav>

          {/* ── listing ── */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-zinc-800 px-4 py-2 text-xs text-zinc-400">
              {fileMode && (
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input type="checkbox" checked={onlyMatch} className="accent-orange-500"
                    onChange={() => { const v = !onlyMatch; setOnlyMatch(v); if (path) void load(path, { record: false, all: !v, select: selected }) }} />
                  {onlyLabel}
                </label>
              )}
              <label className="flex cursor-pointer items-center gap-1.5">
                <input type="checkbox" checked={showHidden} className="accent-orange-500"
                  onChange={() => { const v = !showHidden; setShowHidden(v); if (path) void load(path, { record: false, hidden: v, select: selected }) }} />
                Show hidden folders
              </label>
              <span className="flex-1" />
              {!loading && !reason && (
                <span>{nDirs} folder{nDirs === 1 ? '' : 's'}{fileMode ? ` · ${nFiles} file${nFiles === 1 ? '' : 's'}` : ''}</span>
              )}
            </div>

            <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-3 border-b border-zinc-800 px-4 py-1.5 text-xs font-medium text-zinc-400 sm:grid-cols-[minmax(0,1fr)_96px_120px]">
              <button type="button" onClick={() => toggleSort('name')} className="text-left hover:text-zinc-100">Name{arrow('name')}</button>
              <button type="button" onClick={() => toggleSort('size')} className="text-right hover:text-zinc-100">Size{arrow('size')}</button>
              <button type="button" onClick={() => toggleSort('modified')} className="hidden text-left hover:text-zinc-100 sm:block">Modified{arrow('modified')}</button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto" role="list" aria-busy={loading}>
              {loading && <p className="p-4 text-sm text-zinc-400">Loading…</p>}
              {!loading && error && <p className="p-4 text-sm text-red-400">{error}</p>}
              {!loading && !error && reason && (
                <p className="p-4 text-sm text-red-400">Can&apos;t open this folder: {reason}</p>
              )}
              {!loading && !error && !reason && rows.length === 0 && (
                <p className="px-4 py-10 text-center text-sm text-zinc-400">
                  {filter.trim() ? `Nothing here matches “${filter.trim()}”.`
                    : entries.length === 0 && !fileMode ? 'No folders here.'
                      : fileMode && onlyMatch ? `No folders or matching files here. Untick “${onlyLabel}” to see everything.`
                        : 'This folder is empty.'}
                </p>
              )}
              {!loading && !error && !reason && rows.map(e => {
                const dir = e.kind === 'directory'
                const match = isMatch(e)
                const isSel = selected === e.name
                const noAccess = e.readable === false
                const open = () => void load(joinPath(path!, e.name))
                const click = () => {
                  if (dir) { if (fileMode) open(); else setSelected(e.name) }
                  else if (match && !noAccess) setSelected(e.name)
                }
                const dbl = () => {
                  if (dir) open()
                  else if (match && !noAccess) confirm(joinPath(path!, e.name))
                }
                const inert = !dir && !match
                return (
                  <div role="listitem" key={`${e.kind}:${e.name}`}>
                    <button type="button" onClick={click} onDoubleClick={dbl}
                      onKeyDown={(k) => {
                        if (dir && !fileMode && (k.key === 'ArrowRight' || (k.key === 'Enter' && isSel))) { k.preventDefault(); open() }
                        else if (!dir && match && isSel && k.key === 'Enter') { k.preventDefault(); dbl() }
                      }}
                      aria-pressed={dir && fileMode ? undefined : isSel}
                      aria-disabled={inert || undefined}
                      title={inert ? `Not a ${(extensions ?? []).map(x => `.${x}`).join(' / ')} file` : undefined}
                      className={`grid w-full grid-cols-[minmax(0,1fr)_96px] items-center gap-3 border-b border-zinc-800/70 px-4 py-2 text-left text-[13px] sm:grid-cols-[minmax(0,1fr)_96px_120px] ${isSel ? 'bg-orange-500/10 text-orange-200' : inert ? 'cursor-default text-zinc-500' : 'text-zinc-200 hover:bg-zinc-800'}`}>
                      <span className="flex min-w-0 items-center gap-2.5">
                        {dir ? <FolderIcon /> : match ? <ModelIcon /> : <FileIcon />}
                        <span className="truncate">{e.name}</span>
                        {noAccess && <span className="shrink-0 rounded-full bg-zinc-800 px-1.5 text-[11px] text-red-300">No access</span>}
                      </span>
                      <span className="text-right tabular-nums text-zinc-400">{dir ? '—' : formatSize(e.size)}</span>
                      <span className="hidden text-zinc-400 sm:block">{formatDate(e.modified)}</span>
                    </button>
                  </div>
                )
              })}
            </div>

            {/* The one hard requirement: say it HERE, while the admin is still
                looking at the picker, rather than letting the path be saved and
                fail later inside a tool call - where the error reaches the user
                as a confused model instead of as a permissions problem. Only
                fires at level 3, where the daemon runs as a service account
                that was never granted this folder. */}
            {!loading && path !== null && !reason && access.readable === false && (
              <p className="border-t border-zinc-800 px-4 py-2 text-sm text-red-400">
                Redstart cannot read this folder. Grant its account access, or choose another one.
              </p>
            )}
            {!loading && path !== null && !reason && access.readable !== false && access.writable === false && !fileMode && (
              <p className="border-t border-zinc-800 px-4 py-2 text-sm text-amber-400">
                Redstart can read this folder but not write to it. Fine for read-only use; anything
                that saves a file here will fail.
              </p>
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}
