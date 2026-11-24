// =============================================================================
// RegistryExplorer — step 1 of "Add a plugin" when the source is the registry.
// =============================================================================
// Approved as a mockup on 2026-11-24 ("Option A"): the explorer layout the
// Hugging Face browsers use (HubBrowser.tsx), fitted to what the official MCP
// registry actually returns:
//   - no downloads or likes, so results sort by last update or by name, here
//     in the launcher (the registry itself lists by name);
//   - most of the registry is remote-only servers this Nest cannot run, so the
//     sidebar leads with "Runs on this Nest" and every hidden result is still
//     counted and one click away, each with the reason it can't run here.
//     Nothing is filtered silently (plugin-registry-api.mjs, verdictFor);
//   - the registry's search matches server names only, and the explorer says so.
// The dialog (AddToolDialog.tsx) owns the wizard state; this file owns the
// view: the sidebar, the result rows and the opened server.
// =============================================================================

import type { PluginRuntimes, RegistrySearchResult } from '../api/redstart'
import type { usePlugins } from '../hooks/usePlugins'
import { btnCls } from './ui'
import {
  FactChips, HubSearchBar, PaneMessage, ScopeSelect, SidebarHeading, SidebarItem, SidebarSwitch, fmtAgo, useDebouncedEffect,
} from './HubBrowser'

export type RegistryShow = 'runs' | 'cant' | 'all'
export type RegistrySort = 'updated' | 'name'
export type RegistryView = {
  show: RegistryShow
  sort: RegistrySort
  readyOnly: boolean
  withSource: boolean
  /** The server opened in the detail pane, by registry name. */
  openName: string | null
}
export const initialRegistryView: RegistryView = { show: 'runs', sort: 'updated', readyOnly: false, withSource: false, openName: null }

const SORTS: { value: RegistrySort; label: string }[] = [
  { value: 'updated', label: 'Recently updated' },
  { value: 'name', label: 'Name A–Z' },
]

export function runsHere(r: RegistrySearchResult) {
  return r.verdict.state === 'installable' || r.verdict.state === 'needs-setup'
}

/** "npm", "Python (uv)", "Docker": what the server ships as. */
export function runsAsLabel(r: RegistrySearchResult) {
  if (r.verdict.reason === 'remote') return 'Remote only'
  switch (r.registryType) {
    case 'npm': return 'npm'
    case 'pypi': return 'Python (uv)'
    case 'oci': return 'Docker'
    case 'mcpb': return '.mcpb bundle'
    case 'nuget': return '.NET (NuGet)'
    default: return r.registryType || 'Unknown'
  }
}

/** Why it can't be installed from here, as a sentence. */
function whyNot(r: RegistrySearchResult): string {
  switch (r.verdict.reason) {
    case 'remote': return 'It runs only on its publisher’s servers and is reached over the internet. Plugins are servers that run on this machine.'
    case 'docker': return 'It ships as a Docker image, and Redstart doesn’t run Docker images.'
    case 'bundle': return 'It ships as an .mcpb bundle, which Redstart doesn’t install yet.'
    case 'unpinned': return 'Its package doesn’t name a version, and Redstart installs only a pinned version.'
    case 'inactive': return 'The registry marks it deprecated or deleted.'
    case 'python': return 'It needs Python, which this Nest can’t install plugins with.'
    default: return `It ships as ${r.registryType ? `a ${runsAsLabel(r)} package` : 'a package type'} Redstart can’t install.`
  }
}

/** The short "can't run here" reason, for counts. */
function reasonShort(r: RegistrySearchResult) {
  switch (r.verdict.reason) {
    case 'remote': return 'remote-only'
    case 'docker': return 'Docker'
    case 'bundle': return '.mcpb bundle'
    case 'unpinned': return 'no pinned version'
    case 'inactive': return 'deprecated'
    default: return r.registryType ? runsAsLabel(r) : 'other runtime'
  }
}

function setupNeeded(r: RegistrySearchResult): { text: string; tone: 'ready' | 'optional' | 'required' } {
  const required = r.fields.filter(f => f.isRequired)
  if (required.length) {
    const key = required.some(f => f.isSecret)
    return { text: `${required.length} required${required.length === 1 ? ' setting' : ' settings'}${key ? ' · a key' : ''}`, tone: 'required' }
  }
  return r.fields.length ? { text: 'Optional settings', tone: 'optional' } : { text: 'Ready', tone: 'ready' }
}

const displayTitle = (r: RegistrySearchResult) => r.title || r.name.split('/').slice(1).join('/') || r.name

const COLS = 'grid grid-cols-[minmax(0,1fr)_7rem_9.5rem_4.5rem] gap-3'

/** The runtimes this Nest has, for the dialog's header. */
export function RuntimeFacts({ runtimes }: { runtimes: PluginRuntimes | null }) {
  if (!runtimes) return null
  const facts = [
    runtimes.npm.ok ? `npm ${runtimes.npm.version}${runtimes.npm.nodeVersion ? ` · Node ${runtimes.npm.nodeVersion.replace(/^v/, '')}` : ''}` : 'npm: not found',
    runtimes.uv.ok ? `Python · ${runtimes.uv.version.replace(/^uv\s*/i, 'uv ').split(' (')[0]}` : 'uv: not found',
  ]
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-300">
      <span className="mr-0.5 text-zinc-400">This Nest can run</span>
      {facts.map(f => <span key={f} className="rounded-full bg-zinc-800 px-2.5 py-1">{f}</span>)}
    </div>
  )
}

/** The rows to show, and the counts the sidebar and the notice give. */
export function filterRegistry({ plugins, view }: { plugins: ReturnType<typeof usePlugins>; view: RegistryView }) {
  const all = plugins.searchResults
  const runnable = all.filter(runsHere)
  const notRunnable = all.filter(r => !runsHere(r))
  const inScope = view.show === 'runs' ? runnable : view.show === 'cant' ? notRunnable : all
  const rows = inScope
    .filter(r => !view.readyOnly || (runsHere(r) && !r.fields.some(f => f.isRequired)))
    .filter(r => !view.withSource || !!r.repositoryUrl)
    .slice()
    .sort((a, b) => view.sort === 'name'
      ? displayTitle(a).localeCompare(displayTitle(b), undefined, { sensitivity: 'base' })
      : (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0))
  const opened = all.find(r => r.name === view.openName) ?? null
  return { all, runnable, notRunnable, rows, opened }
}

type Explorer = ReturnType<typeof filterRegistry>

export function RegistrySidebar({ explorer, view, setView, onOtherSource }: {
  explorer: Explorer
  view: RegistryView
  setView: (v: Partial<RegistryView>) => void
  onOtherSource: (kind: 'npm' | 'pypi' | 'path' | 'command') => void
}) {
  const n = (k: number) => explorer.all.length ? String(k) : undefined
  return (<>
    <SidebarHeading>Show</SidebarHeading>
    <CountedItem label="Runs on this Nest" note="npm and Python packages" count={n(explorer.runnable.length)} active={view.show === 'runs'} onClick={() => setView({ show: 'runs' })} />
    <CountedItem label="Can’t run here" note="Remote, Docker, bundles: each says why" count={n(explorer.notRunnable.length)} active={view.show === 'cant'} onClick={() => setView({ show: 'cant' })} />
    <CountedItem label="Everything" count={n(explorer.all.length)} active={view.show === 'all'} onClick={() => setView({ show: 'all' })} />
    <SidebarHeading>Show only</SidebarHeading>
    <SidebarSwitch label="Ready without settings" checked={view.readyOnly} onChange={v => setView({ readyOnly: v })} />
    <SidebarSwitch label="Has a source repository" checked={view.withSource} onChange={v => setView({ withSource: v })} />
    <SidebarHeading>Install another way</SidebarHeading>
    <SidebarItem label="An npm package by name" active={false} onClick={() => onOtherSource('npm')} />
    <SidebarItem label="A Python package by name" active={false} onClick={() => onOtherSource('pypi')} />
    <SidebarItem label="A folder on this machine" active={false} onClick={() => onOtherSource('path')} />
    <SidebarItem label="A command (Advanced)" active={false} onClick={() => onOtherSource('command')} />
  </>)
}

function CountedItem({ label, note, count, active, onClick }: { label: string; note?: string; count?: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-current={active ? 'true' : undefined}
      className={`flex w-full items-start justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors ${active ? 'bg-orange-950/70 text-orange-100' : 'text-zinc-200 hover:bg-zinc-800/70'}`}>
      <span className="flex flex-col">
        <span className="text-[13px] font-medium">{label}</span>
        {note && <span className={`text-[11.5px] leading-snug ${active ? 'text-orange-300' : 'text-zinc-400'}`}>{note}</span>}
      </span>
      {count !== undefined && <span className={`text-xs ${active ? 'text-orange-300' : 'text-zinc-400'}`}>{count}</span>}
    </button>
  )
}

export function RegistryResults({ explorer, plugins, view, setView, query, onQuery, onOpen }: {
  explorer: Explorer
  plugins: ReturnType<typeof usePlugins>
  view: RegistryView
  setView: (v: Partial<RegistryView>) => void
  query: string
  onQuery: (q: string) => void
  onOpen: (r: RegistrySearchResult) => void
}) {
  // Typing searches once the term settles; Enter searches now (and an empty
  // Enter lists the registry from the top). Nothing is fetched before that.
  useDebouncedEffect(() => {
    if (query.trim()) void plugins.search(query.trim())
    else plugins.clearSearch()
  }, [query])
  const searched = plugins.searching || plugins.searchResults.length > 0 || !!plugins.searchError
  const hidden = view.show === 'runs' ? explorer.notRunnable : []
  const breakdown = Object.entries(hidden.reduce<Record<string, number>>((acc, r) => {
    const k = reasonShort(r); acc[k] = (acc[k] ?? 0) + 1; return acc
  }, {})).sort((a, b) => b[1] - a[1]).map(([k, c]) => `${c} ${k}`).join(', ')
  const term = query.trim()
  const summary = plugins.searching && !explorer.all.length ? 'Searching…'
    : `${explorer.rows.length}${explorer.rows.length < explorer.all.length ? ` of ${explorer.all.length}` : ''} server${explorer.all.length === 1 ? '' : 's'}${term ? ` matching “${term}”` : ' in the registry'}${plugins.hasMoreResults ? ' so far' : ''}`

  return (<>
    <HubSearchBar<RegistrySort>
      scopes={[]}
      query={query} onQuery={onQuery}
      onSubmit={() => void plugins.search(query.trim())}
      placeholder="Search the MCP registry by name…"
      searchLabel="Search the MCP registry"
      sort={view.sort} onSort={s => setView({ sort: s })} sortOptions={SORTS}>
      <ScopeSelect value={view.show} onChange={id => setView({ show: id as RegistryShow })}
        options={[{ id: 'runs', label: 'Runs on this Nest' }, { id: 'cant', label: 'Can’t run here' }, { id: 'all', label: 'Everything' }]} />
    </HubSearchBar>
    <div className="px-4 pb-2 text-[12.5px] text-zinc-400">
      {searched ? summary : 'Searches server names. The registry doesn’t search descriptions.'}
    </div>
    <div className={`${COLS} border-y border-zinc-800 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400`}>
      <span>Server</span><span>Runs as</span><span>Before it runs</span><span className="text-right">Updated</span>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
      {plugins.searchError && (
        <p className="px-2 py-3 text-sm text-red-400">
          Registry unavailable ({plugins.searchError}). You can still install by package name: see “Install another way”.
        </p>
      )}
      {!searched && (
        <div className="px-4 py-10 text-center text-[13.5px] leading-relaxed text-zinc-400">
          Type a server’s name to search the official MCP registry,<br />or press Enter to list it from the top.
        </div>
      )}
      {explorer.rows.map(r => {
        const setup = runsHere(r) ? setupNeeded(r) : null
        const active = view.openName === r.name
        return (
          <button key={r.name} type="button" onClick={() => onOpen(r)} aria-current={active ? 'true' : undefined}
            className={`${COLS} my-0.5 w-full items-center rounded-lg border px-2 py-2 text-left transition-colors ${active ? 'border-orange-500/60 bg-orange-500/[0.08]' : 'border-transparent hover:bg-zinc-800/60'}`}>
            <span className="min-w-0">
              <span className={`block text-[13.5px] font-medium leading-snug [overflow-wrap:anywhere] ${runsHere(r) ? 'text-zinc-100' : 'text-zinc-300'}`}>{displayTitle(r)}</span>
              <span className="mt-0.5 block truncate text-[11.5px] text-zinc-400">{[r.publisher, r.description].filter(Boolean).join(' · ')}</span>
            </span>
            <span className="truncate font-mono text-xs text-zinc-300">{runsAsLabel(r)}</span>
            <span className={`truncate text-[12.5px] ${!setup ? 'text-zinc-400' : setup.tone === 'ready' ? 'text-green-300' : setup.tone === 'required' ? 'text-amber-300' : 'text-zinc-300'}`}>
              {setup ? setup.text : `Can’t run here`}
            </span>
            <span className="text-right text-[12.5px] text-zinc-400">{fmtAgo(r.updatedAt)}</span>
          </button>
        )
      })}
      {searched && !plugins.searching && !plugins.searchError && explorer.rows.length === 0 && (
        <div className="px-4 py-8 text-center text-[13.5px] text-zinc-400">
          {explorer.all.length ? 'None of these match the switches on the left.' : 'No server names match. Try a shorter word: the registry matches names only.'}
        </div>
      )}
      {hidden.length > 0 && (
        <div className="mx-2 mt-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-zinc-700 px-3 py-2.5 text-[12.5px] text-zinc-400">
          <span>{hidden.length} more {hidden.length === 1 ? 'matches that' : 'match that'} can’t run here: {breakdown}.</span>
          <button type="button" onClick={() => setView({ show: 'cant' })} className={btnCls.chip}>Show them</button>
        </div>
      )}
      {plugins.hasMoreResults && (
        <div className="flex justify-center py-3">
          <button type="button" onClick={() => void plugins.search(query.trim(), { more: true })} disabled={plugins.searching} className={btnCls.secondary + ' disabled:opacity-50'}>
            {plugins.searching ? 'Loading…' : 'Load more from the registry'}
          </button>
        </div>
      )}
    </div>
  </>)
}

/** The opened server. `form` is the dialog's name/id/constraints and Next, shown only for one that runs here. */
export function RegistryDetail({ server, runtimes, form }: { server: RegistrySearchResult | null; runtimes: PluginRuntimes | null; form: React.ReactNode }) {
  if (!server) return <PaneMessage>Choose a server to see what it installs and what it asks for.</PaneMessage>
  const ok = runsHere(server)
  const missingRuntime = ok && runtimes && (server.registryType === 'pypi' ? !runtimes.uv.ok : !runtimes.npm.ok)
  const required = server.fields.filter(f => f.isRequired).length
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4 pt-4">
        <div>
          <h3 className="text-[15px] font-semibold leading-snug text-zinc-100 [overflow-wrap:anywhere]">{displayTitle(server)}</h3>
          <div className="mt-0.5 break-all font-mono text-[11.5px] text-zinc-400">{server.name}</div>
          <FactChips facts={[server.publisher && `by ${server.publisher}`, server.updatedAt && `updated ${fmtAgo(server.updatedAt)}`]} />
        </div>
        <p className="whitespace-pre-line text-[13px] leading-relaxed text-zinc-300 [overflow-wrap:anywhere]">
          {server.description || '(no description provided by the registry)'}
        </p>

        <div className="rounded-lg border border-zinc-800 px-3 py-2.5">
          {ok ? (<>
            <div className="flex items-center gap-1.5 text-[13px] font-medium text-green-300">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8.5l3 3 7-7" /></svg>
              Runs on this Nest
            </div>
            <div className="mt-1 text-xs leading-snug text-zinc-400">
              Installed with {server.registryType === 'pypi' ? 'uv as an isolated Python tool' : 'npm into its own folder'}, pinned to this version:
            </div>
            <div className="mt-0.5 break-all font-mono text-xs text-zinc-200">{server.packageName}{server.version ? `@${server.version}` : ''}</div>
            {missingRuntime && (
              <p className="mt-2 rounded-md bg-amber-950/50 px-2.5 py-1.5 text-xs text-amber-200">
                {server.registryType === 'pypi' ? 'uv' : 'npm'} isn’t installed on this machine, so the install will stop until it is.
              </p>
            )}
          </>) : (<>
            <div className="text-[13px] font-medium text-zinc-200">Can’t run here · {runsAsLabel(server)}</div>
            <div className="mt-1 text-xs leading-snug text-zinc-400">{whyNot(server)}</div>
            {server.verdict.reason === 'remote' && server.remoteUrl && (<>
              <div className="mt-2 text-xs leading-snug text-zinc-400">
                To use it from here, add this address under Tools → External MCP:
              </div>
              <div className="mt-0.5 select-all break-all font-mono text-xs text-zinc-200">{server.remoteUrl}</div>
            </>)}
          </>)}
        </div>

        {ok && server.fields.length > 0 && (
          <div>
            <div className="pb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
              It asks for{required ? '' : ' · all optional'}
            </div>
            <ul className="space-y-1">
              {server.fields.map(f => (
                <li key={f.name} className="flex justify-between gap-3 text-[12.5px]">
                  <span className="break-all font-mono text-zinc-200">{f.name}{f.isRequired && <span className="text-red-400"> *</span>}</span>
                  <span className="shrink-0 text-zinc-400">{f.isSecret ? 'secret' : f.format === 'filepath' ? 'a path' : f.format === 'boolean' ? 'on / off' : 'text'}</span>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-zinc-400">You fill these in on the next step.</p>
          </div>
        )}

        {(server.repositoryUrl || server.websiteUrl) && (
          <div className="space-y-0.5 text-[12.5px]">
            <div className="pb-0.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Links</div>
            {server.repositoryUrl && <ExternalLink href={server.repositoryUrl} label="Source" />}
            {server.websiteUrl && <ExternalLink href={server.websiteUrl} label="Website" />}
          </div>
        )}
      </div>
      {ok && <div className="shrink-0 border-t border-zinc-800 bg-zinc-900/60 px-4 py-3.5">{form}</div>}
    </div>
  )
}

function ExternalLink({ href, label }: { href: string; label: string }) {
  const shown = href.replace(/^https:\/\//, '').replace(/\/$/, '')
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="block truncate text-orange-300 hover:text-orange-200">
      {label} · {shown}
    </a>
  )
}
