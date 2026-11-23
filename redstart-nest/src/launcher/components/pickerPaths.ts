// =============================================================================
// pickerPaths — the path arithmetic behind FolderPicker.tsx, kept free of
// React so scripts/test-picker-paths.mjs can run it under plain Node.
// =============================================================================
// Every path here is the DAEMON's, not the browser's: a Windows Nest may be
// driven from a Mac browser and the reverse, so nothing may use the client's
// platform to decide which separator a path has. Each helper reads it off
// the path itself.
// =============================================================================

export type CrumbRoot = { path: string; label: string; group?: string }
export type Crumb = { label: string; path: string }

/** True for a path written the Windows way: `C:\…`, `C:` or `\\server\share…`. */
export function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:/.test(p) || p.startsWith('\\\\')
}

function sepOf(p: string): string {
  return isWindowsPath(p) ? '\\' : '/'
}

export function joinPath(dir: string, name: string): string {
  const sep = dir.endsWith('\\') || dir.endsWith('/') ? '' : (dir.includes('\\') ? '\\' : '/')
  return `${dir}${sep}${name}`
}

// In file mode the caller's startPath is the CURRENT FILE (e.g. the selected
// .gguf), which browse:list cannot open — it answered ENOTDIR. Split it into
// the folder to browse and the name to pre-select. Either separator, since the
// path is the daemon's and may be Windows or POSIX. A root-level file keeps
// its trailing separator ("C:\", "/"), which is the form browse:list expects.
export function splitFilePath(p: string): { dir: string; name: string } {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  if (i < 0) return { dir: '', name: p }
  const dir = p.slice(0, i)
  return { dir: dir === '' || /^[A-Za-z]:$/.test(dir) ? p.slice(0, i + 1) : dir, name: p.slice(i + 1) }
}

/** Windows paths compare case-insensitively; POSIX ones exactly. */
export function samePath(a: string, b: string): boolean {
  const strip = (p: string) => (p.length > 1 && /[\\/]$/.test(p) && !/^[A-Za-z]:[\\/]$/.test(p) ? p.slice(0, -1) : p)
  const x = strip(a), y = strip(b)
  return isWindowsPath(x) ? x.toLowerCase() === y.toLowerCase() : x === y
}

/** Is `p` the root itself or somewhere inside it (on a separator boundary)? */
export function isUnder(p: string, root: string): boolean {
  if (samePath(p, root)) return true
  const win = isWindowsPath(p)
  const withSep = /[\\/]$/.test(root) ? root : root + sepOf(root)
  return win ? p.toLowerCase().startsWith(withSep.toLowerCase()) : p.startsWith(withSep)
}

// The fallback base when no drive in the sidebar contains the path: the
// path's own root, labelled the way a person would say it.
function ownRoot(p: string): Crumb {
  const drive = /^([A-Za-z]:)[\\/]?/.exec(p)
  if (drive) return { path: `${drive[1].toUpperCase()}\\`, label: drive[1].toUpperCase() }
  const unc = /^\\\\[^\\]+\\[^\\]+/.exec(p)
  if (unc) return { path: `${unc[0]}\\`, label: unc[0].slice(2) }
  return { path: '/', label: '/' }
}

/**
 * The breadcrumb trail for `p`. The first crumb is the drive from the sidebar
 * that holds it — longest match wins, so on a Mac `/Volumes/USB/models` starts
 * at "USB", not at the startup disk — and so carries the drive's own name
 * ("Macintosh HD", "C: drive") rather than a bare `/` or `C:\`.
 */
export function crumbsFor(p: string, roots: CrumbRoot[]): Crumb[] {
  if (!p) return []
  const drives = roots.filter(r => r.group === 'drive' && isUnder(p, r.path))
  drives.sort((a, b) => b.path.length - a.path.length)
  const own = drives[0] ?? ownRoot(p)
  const base: Crumb = { label: own.label, path: own.path }
  const rest = p.slice(base.path.length).split(/[\\/]+/).filter(Boolean)
  const crumbs: Crumb[] = [base]
  let acc = base.path
  for (const seg of rest) {
    acc = joinPath(acc, seg)
    crumbs.push({ label: seg, path: acc })
  }
  return crumbs
}

/** Decimal units, as disk and download sizes are shown everywhere else. */
export function formatSize(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1000) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1000, i = 0
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++ }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** "Nov 12" this year, "Nov 12, 2025" otherwise. */
export function formatDate(ms: number | undefined, now = Date.now()): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
}

/** The last segment of a path, for a sidebar label ("flux" for E:\Models\flux). */
export function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] || p
}
