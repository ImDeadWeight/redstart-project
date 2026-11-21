import { useState } from 'react'
import type { LlamaConfig, WebSearchEngine } from '../types'
import { retrievalOnFor } from '../types'
import type { useToolsCatalog } from '../hooks/useToolsCatalog'
import type { useCapabilities, FolderCap } from '../hooks/useCapabilities'
import { folderCapAllowCreate } from '../hooks/useCapabilities'
import type { useExternalMcp } from '../hooks/useExternalMcp'
import type { usePlugins } from '../hooks/usePlugins'
import { Card, Chip, TogglePill, btnCls, inputCls } from '../components/ui'
import { FolderPicker } from '../components/FolderPicker'
import { api } from '../api/redstart'
import { PythonCapabilityCard, pythonBlocker } from '../components/PythonCapabilityCard'
import { ImageGenerationCard } from '../components/ImageGenerationCard'
import { DeferralCard } from '../components/DeferralCard'

// ---------------------------------------------------------------------------
// The Tools list — one compact row per tool, settings one click away.
// ---------------------------------------------------------------------------
// Each row is the tool's name, one line saying what it does, a status chip and
// its switch for this profile (activeToolIds; Web access keeps its own
// webAccessEnabled, see types.ts). Opening a row shows that tool's settings
// directly under it, one at a time, so the page stays short however many
// capabilities exist. The rarely touched parts (keeping tools out of the
// prompt, tool servers elsewhere, blocked tools) fold away below the list.
// ---------------------------------------------------------------------------

type FolderCardDef = { cap: FolderCap; title: string; short: string; emptyText: string; description: string }

const FOLDER_CARDS: FolderCardDef[] = [
  {
    cap: 'documents', title: 'Documents', short: 'Read files, and write Word, PDF and Markdown', emptyText: 'No folder chosen',
    description: 'Creates documents in this folder and reads documents and spreadsheets (.pdf, .docx, .txt, .md, .xlsx, .csv) placed in it. Each account has its own space inside it. All extraction happens on this computer.',
  },
  {
    cap: 'file_system', title: 'File System', short: 'Read and edit files in a folder', emptyText: 'No folder chosen',
    description: 'Reads and writes files within the chosen folder: configs, scripts, project files. Paths are contained to it, and every change waits for the person\'s approval.',
  },
  {
    cap: 'sqlite', title: 'SQLite', short: 'Query database files, read-only', emptyText: 'No folder chosen',
    description: 'Read-only queries against .sqlite and .db files in the chosen folder. The files are never opened for writing.',
  },
  {
    cap: 'vault', title: 'Vault', short: 'Search a folder of Markdown notes', emptyText: 'No folder chosen',
    description: 'Read-only search across Markdown notes (an Obsidian vault or any folder of .md files): search, read notes, browse tags.',
  },
  {
    cap: 'git', title: 'Git', short: 'Look at code repositories, read-only', emptyText: 'No folder chosen',
    description: 'Read-only repository context: status, recent commits, uncommitted changes. Choose a repository or a folder of them. Needs git on this computer.',
  },
]

function capDir(caps: ReturnType<typeof useCapabilities>, cap: FolderCap): string | null {
  const cc = caps.capabilityConfig
  if (!cc) return null
  return cap === 'documents' ? cc.documents.outputDir : cc[cap].rootDir
}

// Mirrors the *Wanted checks in buildGatewayConfig: a capability produces tools
// when its card is enabled for this profile AND it has whatever it needs to run
// (a folder, or a connection string). This function answers only the second
// half — "is it configured" — because the card's own toggle is the first half.
// A card that is enabled but not configured is the silent-no-op case each card
// warns about inline.
type CapabilityConfig = ReturnType<typeof useCapabilities>['capabilityConfig']
function isCapabilityReady(cc: CapabilityConfig, id: string): boolean {
  if (!cc) return false
  switch (id) {
    case 'postgres': return cc.postgres.hasConnectionString
    case 'documents': return !!cc.documents.outputDir
    case 'scholar': return true   // no setup required
    case 'memory': return true   // nothing to configure
    case 'document_search': return !!cc.documents.outputDir
    case 'python': return !!cc.documents.outputDir && cc.python.runtimeInstalled && cc.python.sandboxAvailable
    // The card says what is missing (model, engine); here only the folder.
    case 'image_generation': return !!cc.documents.outputDir
    case 'sqlite':
    case 'vault':
    case 'git':
    case 'file_system': return !!cc[id].rootDir
    default: return true
  }
}

type Status = { tone: 'ok' | 'warn' | 'error' | 'off'; label: string }
function statusOf(on: boolean, ready: boolean, notReadyText = 'Needs setup'): Status {
  if (on && ready) return { tone: 'ok', label: 'On' }
  if (on) return { tone: 'warn', label: `On · ${notReadyText.toLowerCase()}` }
  if (!ready) return { tone: 'off', label: notReadyText }
  return { tone: 'off', label: 'Off' }
}

function ToolRow({ name, short, status, on, onToggle, open, onOpen, children }: {
  name: string
  short: string
  status: Status
  on: boolean
  onToggle: () => void
  open: boolean
  onOpen: () => void
  children: React.ReactNode
}) {
  return (
    <li className={`rounded-xl border transition-colors ${open ? 'border-zinc-700 bg-zinc-950/40' : 'border-transparent hover:bg-zinc-800/40'}`}>
      <div className="flex items-center gap-3 px-3 py-2.5">
        <button type="button" onClick={onOpen} aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <span aria-hidden="true" className={`inline-block w-3 shrink-0 text-lg leading-none text-zinc-500 transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
          <span className="min-w-0">
            <span className="block text-sm font-medium text-zinc-100">{name}</span>
            <span className="block truncate text-[13px] text-zinc-500">{short}</span>
          </span>
        </button>
        <Chip tone={status.tone}>{status.label}</Chip>
        <TogglePill checked={on} onToggle={onToggle} label={`${name} for this profile`} />
      </div>
      {open && <div className="border-t border-zinc-800 px-4 pb-4 pt-3.5 sm:pl-9">{children}</div>}
    </li>
  )
}

/** A closed-by-default section below the list. */
function Fold({ title, summary, children }: { title: string; summary?: React.ReactNode; children: React.ReactNode }) {
  return (
    <details className="group rounded-xl border border-zinc-800 bg-zinc-900">
      <summary className="flex items-center gap-3 px-5 py-3.5">
        <span className="chev text-lg leading-none text-zinc-500" aria-hidden="true">›</span>
        <span className="flex-1 text-sm font-semibold text-zinc-100">{title}</span>
        {summary && <span className="text-[13px] text-zinc-500">{summary}</span>}
      </summary>
      <div className="border-t border-zinc-800 px-5 pb-5 pt-4">{children}</div>
    </details>
  )
}

function FolderSettings({ caps, cap, title, emptyText, description }: {
  caps: ReturnType<typeof useCapabilities>
  cap: FolderCap
  title: string
  emptyText: string
  description: string
}) {
  const dir = capDir(caps, cap)
  const fs = caps.capabilityConfig?.file_system
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <code className={`min-w-0 flex-1 break-all text-[13px] ${dir ? 'text-zinc-300' : 'text-zinc-500'}`}>{dir || emptyText}</code>
        <FolderPicker
          mode="directory"
          allowCreate={folderCapAllowCreate(cap)}
          title={`Choose the ${title} folder`}
          startPath={dir ?? undefined}
          onPick={(picked) => caps.applyFolder(cap, picked)}
          disabled={caps.savingCap === cap}
          className={btnCls.secondary}>
          {dir ? 'Change folder…' : 'Choose folder…'}
        </FolderPicker>
      </div>

      {/* File System is the one read/write capability, so it carries a
          server-enforced permission policy. */}
      {cap === 'file_system' && dir && fs && (
        <div className="space-y-3 border-t border-zinc-800 pt-3">
          <label className="flex items-start justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-sm text-zinc-200">Allow writes</span>
              <span className="block text-[13px] text-zinc-500">Create and edit files. Off is read-only.</span>
            </span>
            <TogglePill checked={fs.allowWrite !== false} onToggle={() => caps.toggleFsPolicy('allowWrite')} />
          </label>
          <label className="flex items-start justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-sm text-zinc-200">Allow deleting</span>
              <span className="block text-[13px] text-zinc-500">Deletions go to the Recycle Bin, and the person approves every one; &ldquo;always allow&rdquo; is never offered for deleting.</span>
            </span>
            <TogglePill checked={!!fs.allowDestructive} onToggle={() => caps.toggleFsPolicy('allowDestructive')} />
          </label>
        </div>
      )}

      <p className="text-[13px] leading-relaxed text-zinc-500">{description}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tools for this profile
// ---------------------------------------------------------------------------

export function ToolsTab({ config, toolsCatalog, caps, mcp, plugins }: {
  config: LlamaConfig
  toolsCatalog: ReturnType<typeof useToolsCatalog>
  caps: ReturnType<typeof useCapabilities>
  mcp: ReturnType<typeof useExternalMcp>
  plugins: ReturnType<typeof usePlugins>
}) {
  const {
    allTools, allGroups, clientApps,
    showAddTool, setShowAddTool, newToolName, setNewToolName,
    newToolUrl, setNewToolUrl, newToolDesc, setNewToolDesc,
    editingToolId, startEditTool, cancelToolForm,
    showAddGroup, setShowAddGroup, newGroupName, setNewGroupName,
    newGroupDesc, setNewGroupDesc, newGroupToolIds, setNewGroupToolIds,
    setToolsField, toggleGroup, toggleTool, toggleDisabledTool,
    addCustomTool, deleteCustomTool, addCustomGroup, deleteCustomGroup,
  } = toolsCatalog
  const {
    capabilityConfig, pgConnectionString, setPgConnectionString, pgMaxRows, setPgMaxRows,
    pgTestResult, pgSaving, savePostgresConfig, testPostgresConnection,
    scholarVenueFilter, setScholarVenueFilter, saveScholarVenueFilter,
    searxngUrl, setSearxngUrl, braveApiKey, setBraveApiKey, webSearchError,
    saveWebSearchConfig, clearBraveApiKey,
    toolContextEstimate, retrievalStatus, applyRetrieval,
  } = caps
  const {
    externalServers, showAddExternal, setShowAddExternal,
    newExtName, setNewExtName, newExtUrl, setNewExtUrl, mcpTestResults,
    newExtApiKey, setNewExtApiKey, editingServerId, startEditServer, cancelServerForm,
    addExternalError, addExternalWarnings,
    addExternalMcpServer, removeExternalMcpServer, testExternalMcpServer,
  } = mcp
  const [openId, setOpenId] = useState<string | null>(null)
  const openRow = (id: string) => setOpenId(prev => prev === id ? null : id)

  // Every row's switch is this profile's activeToolIds membership. Web Access
  // is the one exception — it predates activeToolIds and defaults to on, so it
  // uses its own `!== false` boolean (see ProfileTools in types.ts).
  const isActive = (id: string) => config.tools?.activeToolIds?.includes(id) ?? false
  const webAccessOn = config.tools?.webAccessEnabled !== false
  const restrictOn = config.tools?.whitelistEnabled !== false
  const toolsOn = !!config.tools?.enabled
  const docsDir = !!capabilityConfig?.documents.outputDir

  // Mirrors resolveEngine in web-search-engines.mjs: chosen AND configured, or
  // off. The UI says "off" in exactly the cases the server treats as off.
  const searchEngine: WebSearchEngine = config.tools?.webSearchEngine ?? 'none'
  const savedSearxng = capabilityConfig?.web_search?.searxngUrl || null
  const searchEngineReady =
    (searchEngine === 'searxng' && !!savedSearxng) ||
    (searchEngine === 'brave' && !!capabilityConfig?.web_search?.hasBraveApiKey)
  const searchEngineDestination = searchEngine === 'searxng'
    ? (() => { try { return `SearXNG at ${new URL(savedSearxng || '').host}` } catch { return 'SearXNG' } })()
    : 'Brave Search (api.search.brave.com)'

  const pyBlocker = pythonBlocker(capabilityConfig?.python ?? null, docsDir)
  const enabledPlugins = plugins.plugins.filter((p) => p.enabled)
  const onCount = (webAccessOn ? 1 : 0) + (config.tools?.activeToolIds ?? []).filter(id => !allTools.some(t => t.kind === 'web' && t.id === id)).length
  const bannedCount = (config.tools?.disabledToolIds ?? []).length

  return (
    <div className="flex flex-col gap-4">
      {/* ---- The profile's master switch ---- */}
      <Card className="flex flex-wrap items-center gap-x-4 gap-y-2 !py-4">
        <div className="min-w-[14rem] flex-1">
          <div className="text-sm font-semibold text-zinc-100">Tools for this profile</div>
          <div className="text-[13px] text-zinc-500">
            {toolsOn
              ? `${onCount} on. Each tool call adds a few seconds before the answer appears.`
              : 'Off: the assistant can only chat. Turn on to choose tools.'}
          </div>
        </div>
        <TogglePill checked={toolsOn} onToggle={() => setToolsField('enabled', !toolsOn)} label="Tools for this profile" />
      </Card>

      {toolsOn && config.ctxSize < 8192 && (
        <p className={`rounded-lg px-3 py-2 text-[13px] ${config.ctxSize < 4096 ? 'bg-red-950/60 text-red-200' : 'bg-amber-950/50 text-amber-200'}`}>
          Each conversation holds only {config.ctxSize.toLocaleString()} tokens, so one web page or document can fill it.
          Tools work better with 16K or more (Model → How it runs).
        </p>
      )}

      {toolsOn && (
        <Card className="!p-2">
          <ul className="flex flex-col gap-0.5">
            <ToolRow name="Web access" short="Read and search approved websites"
              status={statusOf(webAccessOn, true)} on={webAccessOn}
              onToggle={() => setToolsField('webAccessEnabled', !webAccessOn)}
              open={openId === 'web'} onOpen={() => openRow('web')}>
              <div>
              <div className="flex items-center justify-between gap-3 pb-3">
                <span className="min-w-0">
                  <span className="text-sm text-zinc-200">Only approved sites</span>
                  <span className="block text-xs text-zinc-500">
                    {restrictOn
                      ? 'The model can only fetch from the sources selected below.'
                      : 'The model can fetch any public website. Local network addresses are always blocked.'}
                  </span>
                </span>
                <TogglePill
                  checked={restrictOn}
                  onToggle={() => setToolsField('whitelistEnabled', !restrictOn)}
                  className="flex-shrink-0"
                />
              </div>

              {!restrictOn && (
                <div className="mb-3 px-3 py-2 rounded text-xs border bg-yellow-900/30 border-yellow-700 text-yellow-300">
                  ⚠ Open web access: the model can reach any public site, including ones you haven't reviewed. Fetched pages can contain wrong or manipulative content.
                </div>
              )}

              {restrictOn && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-3">
                  {/* Left column: Groups */}
                  <div>
                    <p className="text-sm font-medium text-zinc-200 mb-2">Source groups</p>

                    <div className="space-y-2 mb-4">
                      {allGroups.filter(g => g.builtIn).map(group => {
                        const active = config.tools?.activeGroupIds?.includes(group.id) ?? false
                        return (
                          <label key={group.id} className="flex items-start gap-2 cursor-pointer select-none">
                            <input
                              type="checkbox" checked={active}
                              onChange={() => toggleGroup(group.id)}
                              className="mt-0.5 accent-orange-500"
                            />
                            <div>
                              <span className="text-sm text-zinc-200">{group.name}</span>
                              <span className="text-xs text-zinc-500 ml-2">{group.description}</span>
                            </div>
                          </label>
                        )
                      })}
                    </div>

                    {allGroups.filter(g => !g.builtIn).length > 0 && (<>
                      <p className="text-xs text-zinc-500 mb-2">Custom groups</p>
                      <div className="space-y-1 mb-3">
                        {allGroups.filter(g => !g.builtIn).map(group => {
                          const active = config.tools?.activeGroupIds?.includes(group.id) ?? false
                          return (
                            <div key={group.id} className="flex items-center gap-2">
                              <label className="flex items-center gap-2 cursor-pointer select-none flex-1">
                                <input type="checkbox" checked={active} onChange={() => toggleGroup(group.id)} className="accent-orange-500" />
                                <span className="text-sm text-zinc-200">{group.name}</span>
                              </label>
                              <button onClick={() => deleteCustomGroup(group.id)} className="text-xs text-zinc-500 hover:text-red-400 transition-colors px-1">✕</button>
                            </div>
                          )
                        })}
                      </div>
                    </>)}

                    {!showAddGroup ? (
                      <button onClick={() => setShowAddGroup(true)} className={btnCls.subtle}>
                        + Create custom group
                      </button>
                    ) : (
                      <div className="space-y-2 bg-zinc-950/40 p-3 rounded-lg border border-zinc-700">
                        <input value={newGroupName} onChange={e => setNewGroupName(e.target.value)}
                          placeholder="Group name" className={inputCls.dark} />
                        <input value={newGroupDesc} onChange={e => setNewGroupDesc(e.target.value)}
                          placeholder="Description (optional)" className={inputCls.dark} />
                        <p className="text-xs text-zinc-500">Select sources for this group:</p>
                        <div className="space-y-1 max-h-40 overflow-y-auto">
                           {allTools.filter(t => t.kind === 'web').map(tool => (
                             <label key={tool.id} className="flex items-center gap-2 cursor-pointer select-none">
                               <input type="checkbox" checked={newGroupToolIds.includes(tool.id)}
                                 onChange={() => setNewGroupToolIds(prev => prev.includes(tool.id) ? prev.filter(id => id !== tool.id) : [...prev, tool.id])}
                                 className="accent-orange-500" />
                               <span className="text-sm text-zinc-300">{tool.name}</span>
                             </label>
                           ))}
                        </div>
                        <div className="flex gap-2 pt-1">
                          <button onClick={addCustomGroup} className={btnCls.primary}>Save group</button>
                          <button onClick={() => { setShowAddGroup(false); setNewGroupName(''); setNewGroupToolIds([]) }} className={btnCls.secondary}>Cancel</button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Right column: Individual sources */}
                  <div>
                    <p className="text-sm font-medium text-zinc-200 mb-2">Individual sources</p>
                    <div className="space-y-1.5 mb-4">
                      {allTools.filter(t => t.kind === 'web').map(tool => {
                        const inActiveGroup = (config.tools?.activeGroupIds ?? []).some(gid => {
                          const grp = allGroups.find(g => g.id === gid)
                          return grp?.toolIds.includes(tool.id)
                        })
                        const active = (config.tools?.activeToolIds?.includes(tool.id) ?? false) || inActiveGroup
                        return (
                          <div key={tool.id} className="flex items-center gap-2">
                            <label className={`flex items-center gap-2 cursor-pointer select-none flex-1 ${inActiveGroup ? 'opacity-50' : ''}`}>
                              <input type="checkbox" checked={active} disabled={inActiveGroup}
                                onChange={() => toggleTool(tool.id)} className="accent-orange-500" />
                              <div className="min-w-0">
                                <span className="text-sm text-zinc-200">{tool.name}</span>
                                {inActiveGroup && <span className="text-xs text-zinc-500 ml-2">(via group)</span>}
                                {tool.builtIn && !inActiveGroup && <span className="text-xs text-zinc-500 ml-2">{tool.baseUrl}</span>}
                              </div>
                            </label>
                            {!tool.builtIn && (
                              <span className="flex items-center gap-1 flex-shrink-0">
                                <button onClick={() => startEditTool(tool)} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors px-1">Edit</button>
                                <button onClick={() => deleteCustomTool(tool.id)} className="text-xs text-zinc-500 hover:text-red-400 transition-colors px-1">✕</button>
                              </span>
                            )}
                          </div>
                        )
                      })}
                    </div>

                    {!showAddTool ? (
                      <button onClick={() => setShowAddTool(true)} className={`${btnCls.subtle} mb-4 block`}>
                        + Add custom source
                      </button>
                    ) : (
                      <div className="space-y-2 bg-zinc-950/40 p-3 rounded-lg border border-zinc-700 mb-4">
                        <input value={newToolName} onChange={e => setNewToolName(e.target.value)}
                          placeholder="Source name" className={inputCls.dark} />
                        <input value={newToolUrl} onChange={e => setNewToolUrl(e.target.value)}
                          placeholder="Base URL (e.g. https://example.com)" className={inputCls.dark} />
                        <input value={newToolDesc} onChange={e => setNewToolDesc(e.target.value)}
                          placeholder="Description (optional)" className={inputCls.dark} />
                        <div className="flex gap-2 pt-1">
                          <button onClick={addCustomTool} className={btnCls.primary}>{editingToolId ? 'Save changes' : 'Save source'}</button>
                          <button onClick={cancelToolForm} className={btnCls.secondary}>Cancel</button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* General web search engine (web_search source "web"). Off by
                  default; "off" is a visible state, not an absent control, and
                  the selected engine's destination is named (plan D1). The
                  choice is this profile's; the connection below is global. */}
              <div className="py-3 border-t border-zinc-800 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0">
                    <span className="text-sm text-zinc-200">General web search</span>
                    <span className="block text-xs text-zinc-500">
                      {searchEngine === 'none'
                        ? 'Off. The model can only search the specific sources above.'
                        : searchEngineReady
                        ? `Queries are sent to ${searchEngineDestination}.`
                        : 'Selected but not configured below, so it is off.'}
                    </span>
                  </span>
                  <select
                    value={searchEngine}
                    onChange={e => setToolsField('webSearchEngine', e.target.value as WebSearchEngine)}
                    className="flex-shrink-0 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-orange-500">
                    <option value="none">Off</option>
                    <option value="searxng">SearXNG (self-hosted)</option>
                    <option value="brave">Brave Search API</option>
                  </select>
                </div>

                {searchEngine !== 'none' && (
                  <div className="px-3 py-2 rounded text-xs border bg-yellow-900/30 border-yellow-700 text-yellow-300">
                    ⚠ Every web search the model makes is sent to this engine{searchEngine === 'searxng' ? ', which forwards it to the public search engines it is configured to use' : ', a hosted service outside your network'}. Result snippets come from unreviewed pages.
                    {restrictOn && ' With sources restricted, results are filtered to the approved sources.'}
                  </div>
                )}

                {searchEngine === 'searxng' && (
                  <div className="flex max-w-xl gap-2">
                    <input value={searxngUrl} onChange={e => setSearxngUrl(e.target.value)}
                      placeholder="SearXNG URL, e.g. http://search.lan:8080/" className={inputCls.dark} />
                    <button onClick={saveWebSearchConfig} className={btnCls.secondary}>Save</button>
                  </div>
                )}
                {searchEngine === 'searxng' && (
                  <p className="text-xs text-zinc-500">The instance must allow JSON results (settings.yml → search.formats: json). Shared by every profile.</p>
                )}

                {searchEngine === 'brave' && (
                  <div className="flex max-w-xl gap-2">
                    <input type="password" value={braveApiKey} onChange={e => setBraveApiKey(e.target.value)}
                      placeholder={capabilityConfig?.web_search?.hasBraveApiKey ? 'API key saved (enter a new one to replace)' : 'Brave Search API key'}
                      className={inputCls.dark} />
                    <button onClick={saveWebSearchConfig} className={btnCls.secondary}>Save</button>
                    {capabilityConfig?.web_search?.hasBraveApiKey && (
                      <button onClick={clearBraveApiKey} className={btnCls.secondary}>Remove</button>
                    )}
                  </div>
                )}
                {webSearchError && <p className="text-xs text-red-400">{webSearchError}</p>}
              </div>

              <div className="flex flex-wrap items-center gap-3 pt-3 border-t border-zinc-800">
                <label className="text-sm text-zinc-300 whitespace-nowrap">Longest page it reads</label>
                <input
                  type="number" min={500} max={8000} step={500}
                  value={config.tools?.maxFetchTokens ?? 2000}
                  onChange={e => setToolsField('maxFetchTokens', Math.max(500, Math.min(8000, parseInt(e.target.value) || 2000)))}
                  className="w-24 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 font-mono text-sm text-zinc-100 focus:outline-none focus:border-orange-500"
                />
                <span className="text-[13px] text-zinc-500">tokens, of {config.ctxSize.toLocaleString()} per conversation</span>
              </div>
              </div>
              <p className="text-[13px] text-zinc-500 mt-3">
                web_fetch reads a page, web_search searches a site&rsquo;s own search. Private and local network addresses are always blocked.
              </p>
            </ToolRow>

            {FOLDER_CARDS.filter(c => c.cap === 'documents').map(card => (
              <ToolRow key={card.cap} name={card.title} short={card.short}
                status={statusOf(isActive(card.cap), !!capDir(caps, card.cap), 'Needs a folder')}
                on={isActive(card.cap)} onToggle={() => toggleTool(card.cap)}
                open={openId === card.cap} onOpen={() => openRow(card.cap)}>
                <FolderSettings caps={caps} {...card} />
              </ToolRow>
            ))}

            <ToolRow name="Python" short="Run calculations and make charts"
              status={statusOf(isActive('python'), !pyBlocker, 'Not ready')} on={isActive('python')}
              onToggle={() => toggleTool('python')}
              open={openId === 'python'} onOpen={() => openRow('python')}>
              <PythonCapabilityCard status={capabilityConfig?.python ?? null} documentsConfigured={docsDir} onChanged={caps.loadCapabilities} />
            </ToolRow>

            <ToolRow name="Image generation" short="Make pictures with an image model you choose"
              status={statusOf(isActive('image_generation'), docsDir, 'Needs Documents')} on={isActive('image_generation')}
              onToggle={() => toggleTool('image_generation')}
              open={openId === 'image_generation'} onOpen={() => openRow('image_generation')}>
              <ImageGenerationCard documentsConfigured={docsDir} />
            </ToolRow>

            <ToolRow name="Document search" short="Find answers in people&rsquo;s own files, with sources"
              status={statusOf(isActive('document_search'), docsDir, 'Needs Documents')} on={isActive('document_search')}
              onToggle={() => toggleTool('document_search')}
              open={openId === 'document_search'} onOpen={() => openRow('document_search')}>
              <div className="space-y-3">
                {!docsDir && <p className="text-[13px] text-amber-300">Choose a Documents folder first: this searches each person&rsquo;s files there.</p>}
                {/* Shared Documents (master plan 6.2): one folder every account
                    searches too, read-only, limited per role on the Roles page. */}
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-sm text-zinc-300">Shared folder</span>
                  <code className="min-w-0 flex-1 break-all text-[13px] text-zinc-400">
                    {capabilityConfig?.shared_documents?.rootDir || 'None: only each person\'s own files are searched'}
                  </code>
                  <FolderPicker
                    mode="directory"
                    allowCreate={false}
                    title="Choose the shared documents folder"
                    startPath={capabilityConfig?.shared_documents?.rootDir ?? undefined}
                    onPick={async (picked) => { await api().capabilities.setSharedDocuments({ rootDir: picked }); await caps.loadCapabilities() }}
                    className={btnCls.secondary}>
                    Choose folder…
                  </FolderPicker>
                  {capabilityConfig?.shared_documents?.rootDir && (
                    <button
                      onClick={async () => { await api().capabilities.setSharedDocuments({ clear: true }); await caps.loadCapabilities() }}
                      className={btnCls.subtle}>
                      Clear
                    </button>
                  )}
                </div>
                <p className="text-[13px] leading-relaxed text-zinc-500">
                  Finds the passages in a person&rsquo;s own files (uploads, attachments, workspaces, created documents) that answer a question, and cites them.
                  The shared folder is read-only and cited as &ldquo;Shared:&rdquo;; a role can limit an account to some of its folders (Settings → Roles).
                  Nothing leaves this computer. Ranking uses the embedding model when it runs, and word matching otherwise.
                </p>
              </div>
            </ToolRow>

            <ToolRow name="Memory" short="Remember facts and preferences across chats"
              status={statusOf(isActive('memory'), true)} on={isActive('memory')}
              onToggle={() => toggleTool('memory')}
              open={openId === 'memory'} onOpen={() => openRow('memory')}>
              <div className="space-y-3">
                <label className="flex items-start justify-between gap-4">
                  <span className="min-w-0">
                    <span className="block text-sm text-zinc-200">Think before suggesting memories</span>
                    <span className="block text-[13px] text-zinc-500">After a chat goes quiet, the model reviews it for things worth keeping. With this on it reasons first: better suggestions on some models (Ornith 9B), none on others (Qwen3-4B), and slower. It runs only while no one is waiting on a reply.</span>
                  </span>
                  <TogglePill
                    checked={config.tools?.memoryReview?.think === true}
                    onToggle={() => setToolsField('memoryReview', { ...(config.tools?.memoryReview ?? {}), think: config.tools?.memoryReview?.think !== true })}
                  />
                </label>
                <p className="text-[13px] leading-relaxed text-zinc-500">
                  Private per account; about 300 tokens of the newest memories ride along with every request. Every save shows in the chat with Undo,
                  people manage theirs under Settings → Memory, and a save made while reading the web is flagged.
                </p>
              </div>
            </ToolRow>

            {FOLDER_CARDS.filter(c => c.cap !== 'documents').map(card => (
              <ToolRow key={card.cap} name={card.title} short={card.short}
                status={statusOf(isActive(card.cap), !!capDir(caps, card.cap), 'Needs a folder')}
                on={isActive(card.cap)} onToggle={() => toggleTool(card.cap)}
                open={openId === card.cap} onOpen={() => openRow(card.cap)}>
                <FolderSettings caps={caps} {...card} />
              </ToolRow>
            ))}

            <ToolRow name="Postgres" short="Query a database, read-only"
              status={statusOf(isActive('postgres'), isCapabilityReady(capabilityConfig, 'postgres'), 'Needs a connection')} on={isActive('postgres')}
              onToggle={() => toggleTool('postgres')}
              open={openId === 'postgres'} onOpen={() => openRow('postgres')}>
              <div className="space-y-3">
                <div className="flex max-w-2xl flex-wrap items-end gap-3">
                  <label className="flex min-w-[16rem] flex-1 flex-col gap-1.5 text-[13px] text-zinc-400">
                    Connection
                    <input
                      type="password" value={pgConnectionString} onChange={e => setPgConnectionString(e.target.value)}
                      placeholder={capabilityConfig?.postgres.hasConnectionString ? 'Saved. Leave blank to keep it' : 'postgresql://user:pass@host:5432/db'}
                      className={`${inputCls.sm} font-mono`} />
                  </label>
                  <label className="flex flex-col gap-1.5 text-[13px] text-zinc-400">
                    Rows per answer
                    <input
                      type="number" min={10} max={5000} step={10} value={pgMaxRows}
                      onChange={e => setPgMaxRows(Math.max(10, Math.min(5000, parseInt(e.target.value) || 200)))}
                      className={`${inputCls.sm.replace('w-full', '')} w-24 font-mono`} />
                  </label>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button onClick={testPostgresConnection} className={btnCls.secondary}>Test connection</button>
                  <button onClick={savePostgresConfig} disabled={pgSaving} className={btnCls.primary}>{pgSaving ? 'Saving…' : 'Save'}</button>
                  {pgTestResult && (
                    <span className={`text-[13px] ${pgTestResult.ok ? 'text-green-400' : 'text-red-400'}`}>{pgTestResult.message}</span>
                  )}
                </div>
                <p className="text-[13px] text-zinc-500">Every query runs in a read-only transaction. Use a read-only database user as well.</p>
              </div>
            </ToolRow>

            <ToolRow name="Scholar" short="Search research papers (OpenAlex, arXiv, PubMed)"
              status={statusOf(isActive('scholar'), true)} on={isActive('scholar')}
              onToggle={() => toggleTool('scholar')}
              open={openId === 'scholar'} onOpen={() => openRow('scholar')}>
              <div className="space-y-3">
                <label className="flex max-w-2xl flex-col gap-1.5 text-[13px] text-zinc-400">
                  Only these journals or categories (optional)
                  <div className="flex gap-2">
                    <input
                      type="text" value={scholarVenueFilter} onChange={e => setScholarVenueFilter(e.target.value)}
                      placeholder="ISSNs or arXiv categories, e.g. 1932-6203, cs.CL"
                      className={`${inputCls.sm} font-mono`} />
                    <button onClick={saveScholarVenueFilter} className={btnCls.secondary}>Save</button>
                  </div>
                </label>
                <p className="text-[13px] text-zinc-500">
                  Searches open academic literature and saves open-access PDFs into the Documents folder. The one built-in tool that sends queries
                  outside this network. Leave the list empty for every journal.
                </p>
              </div>
            </ToolRow>

            {/* One row per installed AND allowed plugin (decision D1 — a plugin
                is a capability, not a special case). A plugin that is installed
                but not allowed on this server gets no row: a per-profile switch
                for it would imply it is available. Allowing it is Tools →
                Plugins, kept apart on purpose. */}
            {enabledPlugins.map((p) => (
              <ToolRow key={p.id} name={p.displayName}
                short={`${p.toolCount} tool${p.toolCount === 1 ? '' : 's'} · plugin`}
                status={p.lastError ? { tone: 'error', label: 'Unhealthy' } : statusOf(isActive(p.id), true)}
                on={isActive(p.id)} onToggle={() => toggleTool(p.id)}
                open={openId === p.id} onOpen={() => openRow(p.id)}>
                <div className="space-y-2 text-[13px]">
                  {p.lastError && <p className="text-red-400">{p.lastError}</p>}
                  <p className="text-zinc-500">A third-party plugin. Installation, health and what each of its tools may do are under Plugins at the top of this page.</p>
                </div>
              </ToolRow>
            ))}
          </ul>
        </Card>
      )}

      {toolsOn && (
        <Fold title="Keep tools out of every message" summary={retrievalOnFor(config.tools) ? 'On' : 'Off'}>
          <div className="space-y-5">
        {(() => {
          const on = retrievalOnFor(config.tools)
          const dl = retrievalStatus?.model.download
          const downloading = on && (dl?.state === 'downloading')
          const running = retrievalStatus?.server.state === 'running'
          // Spawned but not yet answering. A real interval — llama-server
          // accepts the connection before the model is loaded — and it used to
          // be reported as "running", which is the one reading this control
          // exists to avoid.
          const starting = retrievalStatus?.server.state === 'starting'
          const pct = dl && dl.totalBytes > 0 ? Math.min(100, Math.round((dl.receivedBytes / dl.totalBytes) * 100)) : 0
          return (
            <div>
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0">
                  <span className="text-sm font-medium text-zinc-100">Look up tools only when needed</span>
                  <span className="block text-xs text-zinc-500 mt-0.5">
                    The capabilities ticked below stay out of the tool list, which is the same on every message, so
                    the model never re-reads the conversation. It finds them with search_tools and calls them
                    through call_tool. Search runs a small model locally
                    {retrievalStatus ? ` (${retrievalStatus.model.label}, ${Math.round(retrievalStatus.model.bytes / 1e6)} MB, downloaded once)` : ''},
                    and matches by keyword until it is ready.
                  </span>
                </span>
                <TogglePill
                  checked={on}
                  onToggle={() => {
                    const retrieval = { ...(config.tools?.retrieval ?? {}), enabled: !on }
                    setToolsField('retrieval', retrieval)
                    // Straight to the daemon, not through the live-server tool
                    // sync: the sidecar's lifetime is the daemon's, so it must
                    // start whether or not a chat model happens to be loaded.
                    applyRetrieval({ ...config, tools: { ...(config.tools ?? {}), retrieval } as typeof config.tools })
                  }}
                  className="flex-shrink-0"
                />
              </div>

              {/* Every branch below is read off a fact the daemon reported. The
                  one this replaced ended in a bare "Starting…" whenever the
                  sidecar was merely untouched, which is indistinguishable from
                  starting and was wrong in exactly the case that mattered:
                  nothing had been asked to start at all. */}
              {on && (
                <p className={`text-xs mt-2 pt-2 border-t border-zinc-700/50 ${
                  running && retrievalStatus?.applied.enabled ? 'text-zinc-500' : 'text-amber-400'
                }`}>
                  {!retrievalStatus
                    ? 'Checking…'
                    : downloading
                      ? `Downloading the search model — ${pct}% of ${Math.round((dl?.totalBytes ?? 0) / 1e6)} MB. Until it finishes, search_tools matches by keyword.`
                      : dl?.state === 'failed'
                        ? `⚠ The search model could not be downloaded${dl?.error ? `: ${dl.error}` : ''}. search_tools matches by keyword only. Toggle this off and on to retry.`
                        : !retrievalStatus.model.present
                          ? '⚠ The search model is not downloaded yet, so search_tools matches by keyword only. Toggle this off and on to fetch it.'
                          : starting
                            ? 'Loading the search model into memory. Until it is ready, search_tools matches by keyword.'
                            : !running
                              ? `⚠ The search model is downloaded, but its process is not running${retrievalStatus.server.reason ? `: ${retrievalStatus.server.reason}` : ''}. search_tools matches by keyword only.`
                              : !retrievalStatus.applied.gatewayUp
                                ? '✓ Ready. The catalog applies when you launch a model.'
                                : !retrievalStatus.applied.enabled
                                  ? '⚠ Ready, but the running server is still using the previously saved settings. Save this profile to apply it.'
                                  : '✓ Running. The catalog applies from your next message.'}
                </p>
              )}

              {on && !config.tools?.enabled && (
                <p className="text-xs mt-2 text-zinc-500">Tools are switched off for this profile, so there is nothing to keep out.</p>
              )}
            </div>
          )
        })()}

            <DeferralCard
              entries={capabilityConfig?.deferral}
              retrievalOn={retrievalOnFor(config.tools)}
              onChanged={caps.loadCapabilities}
            />
            <div>
        {toolContextEstimate && toolContextEstimate.toolCount > 0 && (
          <p className={`text-xs mt-4 ${
            toolContextEstimate.approxTokens > config.ctxSize * 0.25 ? 'text-amber-400' : 'text-zinc-500'
          }`}>
            {toolContextEstimate.toolCount} active tool{toolContextEstimate.toolCount === 1 ? '' : 's'} in this profile ≈ {toolContextEstimate.approxTokens.toLocaleString()} tokens of context on every request
            {toolContextEstimate.approxTokens > config.ctxSize * 0.25
              ? ` — over a quarter of your ${config.ctxSize.toLocaleString()}-token window. Consider enabling fewer tools per profile.`
              : ''}
          </p>
        )}
        {toolContextEstimate?.observed && (() => {
          const o = toolContextEstimate.observed
          const total = o.toolTokens + o.promptTokens
          const ctx = o.ctxSize ?? config.ctxSize
          return (
            /* Amber on the same quarter-of-the-window threshold the estimate
               above uses.

               "from any account" is not padding. This is ONE observation,
               overwritten by every completion the daemon serves, so on a
               multi-user box it is whoever asked last — not this admin, and not
               a series. Reading it as "my last request" is the obvious mistake
               and the number is useless once it has been made. A per-account
               history was declined deliberately (it is a log of one user's tool
               usage, with a retention policy to argue about), so saying what
               the number is stands in for keeping more of them. */
            <p className={`text-xs mt-1 ${o.toolTokens > ctx * 0.25 ? 'text-amber-400' : 'text-zinc-500'}`}>
              Last request from any account: {o.toolsSent} tool{o.toolsSent === 1 ? '' : 's'} ≈ {o.toolTokens.toLocaleString()} tokens,
              plus {o.promptTokens.toLocaleString()} for the prompt and conversation — {total.toLocaleString()} of {ctx.toLocaleString()}.
              {o.toolsOffered > o.toolsAfterBans
                ? ` ${o.toolsOffered - o.toolsAfterBans} of the ${o.toolsOffered} the client offered were withheld by policy.`
                : ''}
              {o.toolsAfterBans > o.toolsSent
                ? ` ${o.toolsAfterBans - o.toolsSent} more were in the catalog, reachable through search_tools.`
                : ''}
            </p>
          )
        })()}
            </div>
          </div>
        </Fold>
      )}

      <Fold title="Tool servers on other computers" summary={externalServers.length ? `${externalServers.length} added` : 'None'}>
        {!showAddExternal && (
          <button onClick={() => setShowAddExternal(true)} className={`${btnCls.secondary} mb-3`}>Add a server</button>
        )}
        <div className="mb-3 rounded-lg bg-zinc-950/50 px-3 py-2 text-[13px] text-zinc-400">
          <span className="text-zinc-300 font-medium">Built-in Redstart MCP:</span>{' '}
          {config.tools?.enabled
            ? <span className="text-green-400">http://localhost:{(config.port ?? 19080) + 2}/mcp</span>
            : <span className="text-zinc-500">Starts with server (enable tools above)</span>
          }
        </div>

        {externalServers.length === 0 && !showAddExternal && (
          <p className="text-xs text-zinc-500">No external MCP servers configured. Add a server URL to connect to an MCP server on another device.</p>
        )}

        <div className="space-y-2">
          {externalServers.map(server => (
            <div key={server.id} className="flex items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
              <div className="flex-1 min-w-0">
                <span className="text-sm text-zinc-200">{server.name}</span>
                <span className="text-xs text-zinc-500 ml-2 break-all">{server.url}</span>
                {server.hasApiKey && (
                  <span className="text-xs text-zinc-500 ml-2" tabIndex={0} role="img" aria-label="An API key is stored for this server" data-tip="An API key is stored for this server">🔑</span>
                )}
                {mcpTestResults[server.id] && (
                  <span className={`block text-xs mt-0.5 ${mcpTestResults[server.id].ok ? 'text-green-400' : 'text-red-400'}`}>
                    {mcpTestResults[server.id].message}
                  </span>
                )}
              </div>
              <button
                onClick={() => testExternalMcpServer(server.id, server.url)}
                className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors px-1 flex-shrink-0">
                Test
              </button>
              <button
                onClick={() => startEditServer(server)}
                className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors px-1 flex-shrink-0">
                Edit
              </button>
              <button
                onClick={() => removeExternalMcpServer(server.id)}
                className="text-xs text-zinc-500 hover:text-red-400 transition-colors px-1 flex-shrink-0">
                ✕
              </button>
            </div>
          ))}
        </div>

        {/* Cautions about the server that was just added — plaintext to a remote
            host, egress, an endpoint that doesn't look like /sse. Non-blocking
            by design: the main process accepted it, and an admin at the console
            is allowed to make these choices. See external-mcp-url.mjs. */}
        {addExternalWarnings.length > 0 && (
          <div className="mt-2 text-xs text-amber-300/90 bg-amber-950/30 border border-amber-900/60 rounded p-2 space-y-1">
            {addExternalWarnings.map((w, i) => <p key={i}>⚠ {w}</p>)}
          </div>
        )}

        {showAddExternal && (
          <div className="mt-3 max-w-xl space-y-2 rounded-lg border border-zinc-700 bg-zinc-950/40 p-3">
            <input
              value={newExtName} onChange={e => setNewExtName(e.target.value)}
              placeholder="Server name (e.g. Legal DB Server)"
              className={inputCls.dark} />
            <input
              value={newExtUrl} onChange={e => setNewExtUrl(e.target.value)}
              placeholder="Address (e.g. http://10.0.0.5:9000/mcp)"
              className={inputCls.dark} />
            <input
              type="password"
              value={newExtApiKey} onChange={e => setNewExtApiKey(e.target.value)}
              placeholder={
                editingServerId && externalServers.find(s => s.id === editingServerId)?.hasApiKey
                  ? 'API key (leave blank to keep the current one)'
                  : 'API key (optional — sent as Authorization: Bearer …)'
              }
              className={inputCls.dark} />
            {/* A refusal from the main process. Without this the Add button
                would simply do nothing on a rejected URL, which reads as a
                broken button rather than a policy decision. */}
            {addExternalError && (
              <p className="text-xs text-red-400 bg-red-950/30 border border-red-900/60 rounded p-2">
                {addExternalError}
              </p>
            )}
            <div className="flex gap-2 pt-1">
              <button onClick={addExternalMcpServer} className={btnCls.primary}>
                {editingServerId ? 'Save changes' : 'Add server'}
              </button>
              <button onClick={cancelServerForm} className={btnCls.secondary}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </Fold>

      {/* Banned tools — the only control that reaches tools this server does
          not provide. Deliberately NOT a second list of the rows above: for a
          capability, switching its row off already stops the tools being served
          at all, so listing capabilities here would be two controls over the
          same names meaning opposite things. */}
      <Fold title="Blocked tools" summary={bannedCount ? `${bannedCount} blocked` : 'None'}>
        <p className="mb-3 text-[13px] text-zinc-500">
          Apps bring some tools of their own, which this server never offers and so cannot switch off. Blocking strips them by name from every request this profile serves.
        </p>
        <div className="space-y-2.5">
          {clientApps.map(app => {
            const banned = (config.tools?.disabledToolIds ?? []).includes(app.id)
            return (
              <label key={app.id} className="flex cursor-pointer select-none items-start gap-2.5">
                <input type="checkbox" checked={banned} onChange={() => toggleDisabledTool(app.id)} className="mt-1 flex-shrink-0" />
                <span className="min-w-0">
                  <span className="text-sm text-zinc-200">{app.name}</span>
                  <span className="ml-1.5 text-[13px] text-zinc-500">({app.toolNames.length} tools)</span>
                  <span className="block text-[13px] text-zinc-500">{app.description}</span>
                </span>
              </label>
            )
          })}
        </div>
        <p className="mt-3 text-[13px] text-zinc-500">
          To stop one of this server&rsquo;s own tools, switch its row off above. To make File System read-only, use its &ldquo;Allow writes&rdquo; switch.
        </p>
      </Fold>
    </div>
  )
}
