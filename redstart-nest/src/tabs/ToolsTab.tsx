import type { LlamaConfig } from '../types'
import type { useToolsCatalog } from '../hooks/useToolsCatalog'
import type { useCapabilities, FolderCap } from '../hooks/useCapabilities'
import { folderCapAllowCreate } from '../hooks/useCapabilities'
import type { useExternalMcp } from '../hooks/useExternalMcp'
import type { usePlugins } from '../hooks/usePlugins'
import { SectionTitle, TogglePill, btnCls, inputCls } from '../components/ui'
import { FolderPicker } from '../components/FolderPicker'

// ---------------------------------------------------------------------------
// Folder-scoped capability card — one component for Documents/SQLite/Vault/
// Git/File System (they differ only in copy and which config field holds the
// folder). Postgres and Scholar keep bespoke cards below.
// ---------------------------------------------------------------------------

const FOLDER_CARDS: { cap: FolderCap; title: string; emptyText: string; description: string }[] = [
  {
    cap: 'documents', title: 'Documents', emptyText: 'No output folder chosen',
    description: 'The model can create documents in this folder and read documents and spreadsheets (.pdf, .docx, .txt, .md, .xlsx, .csv) you place in it. All extraction happens on-device.',
  },
  {
    cap: 'sqlite', title: 'SQLite', emptyText: 'No database folder chosen',
    description: 'Read-only queries against .sqlite/.db files in the chosen folder. The files are never opened for writing.',
  },
  {
    cap: 'vault', title: 'Vault', emptyText: 'No notes folder chosen',
    description: 'Read-only search across markdown notes (Obsidian vault or any folder of .md files) — search, read notes, browse tags.',
  },
  {
    cap: 'git', title: 'Git', emptyText: 'No repository folder chosen',
    description: 'Read-only repository context (status, recent commits, uncommitted diffs). Choose a repository or a folder containing repositories. Requires git on the server machine.',
  },
  {
    cap: 'file_system', title: 'File System', emptyText: 'No folder chosen',
    description: 'Read and write files within a chosen folder — read configs, write scripts, edit project files. Paths are contained to the chosen root.',
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
    case 'sqlite':
    case 'vault':
    case 'git':
    case 'file_system': return !!cc[id].rootDir
    default: return true
  }
}

// `active` is this profile's activeToolIds membership; `onToggle` flips it.
// The card no longer touches the global capability `enabled` flag — see
// buildGatewayConfig. "Configured" (a folder is chosen) is now purely a
// readout, not a second gate.
function FolderCapabilityCard({ caps, cap, title, emptyText, description, active, onToggle }: {
  caps: ReturnType<typeof useCapabilities>
  cap: FolderCap
  title: string
  emptyText: string
  description: string
  active: boolean
  onToggle: () => void
}) {
  const dir = capDir(caps, cap)
  return (
    <div className="bg-zinc-800/40 rounded px-3 py-2.5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-zinc-200">{title}</span>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className={`text-xs ${!dir ? 'text-zinc-600' : active ? 'text-green-400' : 'text-zinc-500'}`}>
            {!dir ? 'Not configured' : active ? 'Configured · Enabled' : 'Configured · Disabled'}
          </span>
          <button onClick={onToggle} className={btnCls.chip}>
            {active ? 'Disable' : 'Enable'}
          </button>
        </div>
      </div>
      {active && !dir && (
        <p className="text-xs text-yellow-500/90 mb-1.5">
          Enabled for this profile, but no folder chosen — the model will not see its tools.
        </p>
      )}
      <div className="flex items-center gap-2">
        <span className="flex-1 min-w-0 text-xs text-zinc-400 truncate">
          {dir || emptyText}
        </span>
        <FolderPicker
          mode="directory"
          allowCreate={folderCapAllowCreate(cap)}
          title={`Select the ${title} folder`}
          startPath={dir ?? undefined}
          onPick={(picked) => caps.applyFolder(cap, picked)}
          disabled={caps.savingCap === cap}
          className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 rounded text-xs transition-colors flex-shrink-0">
          Choose folder…
        </FolderPicker>
      </div>

      {/* File System is the one read/write capability, so it carries a
          server-enforced permission policy. The current server
          (@modelcontextprotocol/server-filesystem) exposes no delete tool, so
          the destructive toggle is reserved: it pre-gates any future
          destructive-class file tool but currently changes nothing. */}
      {cap === 'file_system' && dir && caps.capabilityConfig && (
        <div className="mt-2 pt-2 border-t border-zinc-700/50 space-y-2">
          <label className="flex items-center justify-between gap-2 cursor-pointer select-none">
            <span className="min-w-0">
              <span className="text-xs text-zinc-300">Allow writes</span>
              <span className="block text-xs text-zinc-600">Create and edit files. Off = read-only access.</span>
            </span>
            <TogglePill
              checked={caps.capabilityConfig.file_system.allowWrite !== false}
              onToggle={() => caps.toggleFsPolicy('allowWrite')}
              className="flex-shrink-0"
            />
          </label>
          <label className="flex items-center justify-between gap-2 cursor-pointer select-none">
            <span className="min-w-0">
              <span className="text-xs text-zinc-300">Allow destructive operations</span>
              <span className="block text-xs text-zinc-600">Lets the model delete files in its own storage. Deletions go to the Recycle Bin and can be recovered, and the model must ask before every single one — "always allow" is never offered for deletion.</span>
            </span>
            <TogglePill
              checked={!!caps.capabilityConfig.file_system.allowDestructive}
              onToggle={() => caps.toggleFsPolicy('allowDestructive')}
              className="flex-shrink-0"
            />
          </label>
          {caps.capabilityConfig.file_system.allowDestructive && (
            <p className="text-xs text-yellow-500/90">⚠ The model can delete files in each user's own storage under this folder. Deletions are recoverable from the Recycle Bin and are confirmed one at a time.</p>
          )}
        </div>
      )}

      <p className="text-xs text-zinc-600 mt-1.5">{description}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tools tab
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
    toolContextEstimate,
  } = caps
  const {
    externalServers, showAddExternal, setShowAddExternal,
    newExtName, setNewExtName, newExtUrl, setNewExtUrl, mcpTestResults,
    newExtApiKey, setNewExtApiKey, editingServerId, startEditServer, cancelServerForm,
    addExternalError, addExternalWarnings,
    addExternalMcpServer, removeExternalMcpServer, testExternalMcpServer,
  } = mcp

  // Every card's Enable/Disable is this profile's activeToolIds membership.
  // Web Access is the one exception — it predates activeToolIds and defaults to
  // on, so it uses its own `!== false` boolean (see ProfileTools in types.ts).
  const isActive = (id: string) => config.tools?.activeToolIds?.includes(id) ?? false
  const webAccessOn = config.tools?.webAccessEnabled !== false
  const restrictOn = config.tools?.whitelistEnabled !== false

  return (
    <section className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">
      <div className="flex items-center justify-between mb-4">
        <SectionTitle className="">Tools</SectionTitle>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <span className="text-xs text-zinc-400">{config.tools?.enabled ? 'Enabled' : 'Disabled'}</span>
          <TogglePill checked={!!config.tools?.enabled} onToggle={() => setToolsField('enabled', !(config.tools?.enabled))} />
        </label>
      </div>

      {config.tools?.enabled ? (<>
        {/* Performance warning — context cost applies to every tool, so it sits
            above the cards rather than inside any one of them. */}
        <div className={`mb-4 px-3 py-2 rounded text-xs border ${
          config.ctxSize < 4096
            ? 'bg-red-900/30 border-red-700 text-red-300'
            : config.ctxSize < 8192
            ? 'bg-yellow-900/30 border-yellow-700 text-yellow-300'
            : 'bg-zinc-800 border-zinc-700 text-zinc-400'
        }`}>
          {config.ctxSize < 4096
            ? `⚠ Context is very small (${config.ctxSize} tokens). Tool fetches may fill it completely. Increase context size or keep tools off.`
            : config.ctxSize < 8192
            ? `⚠ Small context (${config.ctxSize} tokens). Fetched content may use most of it. Consider 8192+ for tool use.`
            : `ⓘ Tool calls add ~2–5 s latency per lookup. The response appears after all fetches complete.`
          }
        </div>

        <div className="space-y-4">
          {/* ---- Web Access (web_fetch + web_search) ----
              Same card shape as the capability cards below: one Enable/Disable
              for this profile, with its setup nested inside. Its on/off lives in
              webAccessEnabled rather than activeToolIds — see types.ts. */}
          <div className="bg-zinc-800/40 rounded px-3 py-2.5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-zinc-200">Web Access</span>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className={`text-xs ${webAccessOn ? 'text-green-400' : 'text-zinc-500'}`}>
                  {webAccessOn ? 'Enabled' : 'Disabled'}
                </span>
                <button
                  onClick={() => setToolsField('webAccessEnabled', !webAccessOn)}
                  className={btnCls.chip}>
                  {webAccessOn ? 'Disable' : 'Enable'}
                </button>
              </div>
            </div>

            {webAccessOn && (<>
              <div className="flex items-center justify-between gap-2 py-2 border-t border-zinc-700/50">
                <span className="min-w-0">
                  <span className="text-xs text-zinc-300">Restrict to approved sources</span>
                  <span className="block text-xs text-zinc-600">
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
                    <p className="text-xs uppercase tracking-widest text-zinc-500 mb-2">Source Groups</p>

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
                              <button onClick={() => deleteCustomGroup(group.id)} className="text-xs text-zinc-600 hover:text-red-400 transition-colors px-1">✕</button>
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
                      <div className="space-y-2 bg-zinc-800/60 p-3 rounded border border-zinc-700">
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
                    <p className="text-xs uppercase tracking-widest text-zinc-500 mb-2">Individual Sources</p>
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
                                {inActiveGroup && <span className="text-xs text-zinc-600 ml-2">(via group)</span>}
                                {tool.builtIn && !inActiveGroup && <span className="text-xs text-zinc-600 ml-2">{tool.baseUrl}</span>}
                              </div>
                            </label>
                            {!tool.builtIn && (
                              <span className="flex items-center gap-1 flex-shrink-0">
                                <button onClick={() => startEditTool(tool)} className="text-xs text-zinc-600 hover:text-zinc-300 transition-colors px-1">Edit</button>
                                <button onClick={() => deleteCustomTool(tool.id)} className="text-xs text-zinc-600 hover:text-red-400 transition-colors px-1">✕</button>
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
                      <div className="space-y-2 bg-zinc-800/60 p-3 rounded border border-zinc-700 mb-4">
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

              <div className="flex items-center gap-3 pt-2 border-t border-zinc-700/50">
                <label className="text-xs text-zinc-400 whitespace-nowrap">Max tokens per fetch</label>
                <input
                  type="number" min={500} max={8000} step={500}
                  value={config.tools?.maxFetchTokens ?? 2000}
                  onChange={e => setToolsField('maxFetchTokens', Math.max(500, Math.min(8000, parseInt(e.target.value) || 2000)))}
                  className="w-24 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500"
                />
                <span className="text-xs text-zinc-600">of {config.ctxSize} ctx tokens</span>
              </div>
            </>)}

            <p className="text-xs text-zinc-600 mt-1.5">
              Look things up on the web: <span className="text-zinc-500">web_fetch</span> reads a page, <span className="text-zinc-500">web_search</span> searches a source's own search endpoint. Private and local network addresses are always blocked.
            </p>
          </div>

          {/* ---- Postgres ---- */}
          <div className="bg-zinc-800/40 rounded px-3 py-2.5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-zinc-200">Postgres</span>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className={`text-xs ${
                  !capabilityConfig?.postgres.hasConnectionString
                    ? 'text-zinc-600'
                    : isActive('postgres') ? 'text-green-400' : 'text-zinc-500'
                }`}>
                  {!capabilityConfig?.postgres.hasConnectionString
                    ? 'Not configured'
                    : isActive('postgres') ? 'Configured · Enabled' : 'Configured · Disabled'}
                </span>
                <button onClick={() => toggleTool('postgres')} className={btnCls.chip}>
                  {isActive('postgres') ? 'Disable' : 'Enable'}
                </button>
              </div>
            </div>
            {isActive('postgres') && !isCapabilityReady(capabilityConfig, 'postgres') && (
              <p className="text-xs text-yellow-500/90 mb-1.5">
                Enabled for this profile, but no connection string saved — the model will not see its tools.
              </p>
            )}
            <div className="flex gap-2 mb-1.5">
              <input
                type="password" value={pgConnectionString} onChange={e => setPgConnectionString(e.target.value)}
                placeholder={capabilityConfig?.postgres.hasConnectionString ? 'postgresql://... (leave blank to keep current)' : 'postgresql://user:pass@host:5432/db'}
                className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500" />
              <input
                type="number" min={10} max={5000} step={10} value={pgMaxRows}
                onChange={e => setPgMaxRows(Math.max(10, Math.min(5000, parseInt(e.target.value) || 200)))}
                title="Max rows returned per query"
                className="w-20 bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500" />
            </div>
            <div className="flex items-center gap-2">
              <button onClick={testPostgresConnection} className={btnCls.chip}>Test connection</button>
              <button onClick={savePostgresConfig} disabled={pgSaving} className="px-2.5 py-1 bg-orange-500 hover:bg-orange-400 disabled:opacity-50 rounded text-xs font-medium transition-colors">
                {pgSaving ? 'Saving…' : 'Save'}
              </button>
              {pgTestResult && (
                <span className={`text-xs ${pgTestResult.ok ? 'text-green-400' : 'text-red-400'}`}>{pgTestResult.message}</span>
              )}
            </div>
            <p className="text-xs text-zinc-600 mt-1.5">Queries run read-only. Use a database role with read-only grants for defense in depth.</p>
          </div>

          {FOLDER_CARDS.map(card => (
            <FolderCapabilityCard
              key={card.cap}
              caps={caps}
              active={isActive(card.cap)}
              onToggle={() => toggleTool(card.cap)}
              {...card}
            />
          ))}

          {/* ---- Scholar ---- */}
          <div className="bg-zinc-800/40 rounded px-3 py-2.5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-zinc-200">Scholar</span>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className={`text-xs ${isActive('scholar') ? 'text-green-400' : 'text-zinc-500'}`}>
                  {isActive('scholar') ? 'Enabled' : 'Disabled'}
                </span>
                <button onClick={() => toggleTool('scholar')} className={btnCls.chip}>
                  {isActive('scholar') ? 'Disable' : 'Enable'}
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2 mb-1.5">
              <input
                type="text" value={scholarVenueFilter} onChange={e => setScholarVenueFilter(e.target.value)}
                placeholder="Optional venue whitelist: journal ISSNs and/or arXiv categories (e.g. 1932-6203, cs.CL)"
                className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500 placeholder:text-zinc-600" />
              <button onClick={saveScholarVenueFilter} className={btnCls.chip}>Save filter</button>
            </div>
            <p className="text-xs text-zinc-600 mt-1.5">Search open academic literature (OpenAlex, arXiv, PubMed) and save open-access PDFs into the Documents folder. Leave the whitelist empty for all venues; when set, searches and downloads are restricted to those journals/categories at the API level.</p>
          </div>

          {/* ---- Installed plugins ----
              One card per installed+enabled plugin (decision D1 — a plugin is a
              capability, not a special case). A plugin installed but not yet
              registry-enabled shows no card at all: it isn't available on this
              server, so a per-profile toggle for it would imply otherwise. The
              registry `enabled` switch itself lives on the Plugins tab, not here —
              see [Two tabs, not one section] in the plan. */}
          {plugins.plugins.filter((p) => p.enabled).map((p) => (
            <div key={p.id} className="bg-zinc-800/40 rounded px-3 py-2.5">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm text-zinc-200">{p.displayName}</span>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className={`text-xs ${isActive(p.id) ? 'text-green-400' : 'text-zinc-500'}`}>
                    {isActive(p.id) ? 'Enabled' : 'Disabled'}
                  </span>
                  <button onClick={() => toggleTool(p.id)} className={btnCls.chip}>
                    {isActive(p.id) ? 'Disable' : 'Enable'}
                  </button>
                </div>
              </div>
              <p className="text-xs text-zinc-600">
                {p.toolCount} tool{p.toolCount === 1 ? '' : 's'} · third-party plugin — manage installation, health and classification on the Plugins tab.
              </p>
              {p.lastError && (
                <p className="text-xs text-red-400 mt-1">⚠ Unhealthy: {p.lastError}</p>
              )}
            </div>
          ))}
        </div>

        {toolContextEstimate && toolContextEstimate.toolCount > 0 && (
          <p className={`text-xs mt-4 ${
            toolContextEstimate.approxTokens > config.ctxSize * 0.25 ? 'text-amber-400' : 'text-zinc-500'
          }`}>
            {toolContextEstimate.toolCount} active tool{toolContextEstimate.toolCount === 1 ? '' : 's'} ≈ {toolContextEstimate.approxTokens.toLocaleString()} tokens of context on every request
            {toolContextEstimate.approxTokens > config.ctxSize * 0.25
              ? ` — over a quarter of your ${config.ctxSize.toLocaleString()}-token window. Consider enabling fewer tools per profile.`
              : ''}
          </p>
        )}
      </>) : (
        <p className="text-xs text-zinc-600">Enable tools to let the model use web access and local capabilities via the built-in MCP server. Settings are saved with the active profile.</p>
      )}

      {/* External MCP Servers */}
      <div className="mt-6 pt-4 border-t border-zinc-700">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs uppercase tracking-widest text-zinc-500">External MCP Servers</p>
          {!showAddExternal && (
            <button onClick={() => setShowAddExternal(true)} className={btnCls.subtle}>
              + Add server
            </button>
          )}
        </div>

        <div className="mb-3 px-3 py-2 bg-zinc-800/60 rounded text-xs text-zinc-400">
          <span className="text-zinc-300 font-medium">Built-in Redstart MCP:</span>{' '}
          {config.tools?.enabled
            ? <span className="text-green-400">http://localhost:{(config.port ?? 19080) + 2}/mcp</span>
            : <span className="text-zinc-600">Starts with server (enable tools above)</span>
          }
        </div>

        {externalServers.length === 0 && !showAddExternal && (
          <p className="text-xs text-zinc-600">No external MCP servers configured. Add a server URL to connect to an MCP server on another device.</p>
        )}

        <div className="space-y-2">
          {externalServers.map(server => (
            <div key={server.id} className="flex items-start gap-2 bg-zinc-800/40 rounded px-3 py-2">
              <div className="flex-1 min-w-0">
                <span className="text-sm text-zinc-200">{server.name}</span>
                <span className="text-xs text-zinc-500 ml-2 break-all">{server.url}</span>
                {server.hasApiKey && (
                  <span className="text-xs text-zinc-600 ml-2" title="An API key is stored for this server">🔑</span>
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
                className="text-xs text-zinc-600 hover:text-red-400 transition-colors px-1 flex-shrink-0">
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
          <div className="space-y-2 bg-zinc-800/60 p-3 rounded border border-zinc-700 mt-2">
            <input
              value={newExtName} onChange={e => setNewExtName(e.target.value)}
              placeholder="Server name (e.g. Legal DB Server)"
              className={inputCls.dark} />
            <input
              value={newExtUrl} onChange={e => setNewExtUrl(e.target.value)}
              placeholder="SSE URL (e.g. http://10.0.0.5:9000/sse)"
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
      </div>

      {/* Banned tools — the only control that reaches tools this server does
          not provide. Deliberately NOT a second list of the cards above: for a
          capability, disabling its card already stops the tools being served at
          all, so listing capabilities here would be two controls over the same
          names meaning opposite things — while the set that genuinely needs
          banning could not be named at all. */}
      <div className="mt-6 pt-4 border-t border-zinc-700">
        <p className="text-xs uppercase tracking-widest text-zinc-500 mb-1">Banned Tools</p>
        <p className="text-xs text-zinc-600 mb-3">
          Client apps bring their own tools, which arrive already inside the request — this server never offers them, so it cannot withhold them either. Banning strips them by name from every request this profile serves, and clients cannot re-enable them. Applies to <span className="text-zinc-500">this profile</span>; other profiles have their own list.
        </p>
        <div className="space-y-2.5">
          {clientApps.map(app => {
            const banned = (config.tools?.disabledToolIds ?? []).includes(app.id)
            return (
              <label key={app.id} className="flex items-start gap-2 cursor-pointer select-none">
                <input
                  type="checkbox" checked={banned}
                  onChange={() => toggleDisabledTool(app.id)}
                  className="accent-orange-500 mt-0.5 flex-shrink-0"
                />
                <span className="min-w-0">
                  <span className="text-sm text-zinc-200">{app.name}</span>
                  <span className="text-xs text-zinc-600 ml-1.5">({app.toolNames.length} tools)</span>
                  <span className="block text-xs text-zinc-600">{app.description}</span>
                </span>
              </label>
            )
          })}
        </div>
        <p className="text-xs text-zinc-600 mt-3">
          To turn off one of this server's own capabilities, disable its card above — that stops it being served at all. To make the File System capability read-only, use its "Allow writes" toggle rather than banning the whole thing.
        </p>
      </div>
    </section>
  )
}
