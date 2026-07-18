import type { LlamaConfig } from '../types'
import type { useToolsCatalog } from '../hooks/useToolsCatalog'
import type { useCapabilities, FolderCap } from '../hooks/useCapabilities'
import type { useExternalMcp } from '../hooks/useExternalMcp'
import { SectionTitle, TogglePill, btnCls, inputCls } from '../components/ui'

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

function FolderCapabilityCard({ caps, cap, title, emptyText, description }: {
  caps: ReturnType<typeof useCapabilities>
  cap: FolderCap
  title: string
  emptyText: string
  description: string
}) {
  const dir = capDir(caps, cap)
  const enabled = !!caps.capabilityConfig?.[cap].enabled
  return (
    <div className="bg-zinc-800/40 rounded px-3 py-2.5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-zinc-200">{title}</span>
        <span className={`text-xs ${dir ? (enabled ? 'text-green-400' : 'text-zinc-500') : 'text-zinc-600'}`}>
          {dir ? (enabled ? 'Enabled' : 'Disabled') : 'Not configured'}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="flex-1 min-w-0 text-xs text-zinc-400 truncate">
          {dir || emptyText}
        </span>
        <button onClick={() => caps.chooseFolder(cap)} disabled={caps.savingCap === cap}
          className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 rounded text-xs transition-colors flex-shrink-0">
          Choose folder…
        </button>
        {dir && (
          <button onClick={() => caps.toggleCapEnabled(cap)} className={btnCls.chip}>
            {enabled ? 'Disable' : 'Enable'}
          </button>
        )}
      </div>
      <p className="text-xs text-zinc-600 mt-1.5">{description}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tools tab
// ---------------------------------------------------------------------------

export function ToolsTab({ config, toolsCatalog, caps, mcp }: {
  config: LlamaConfig
  toolsCatalog: ReturnType<typeof useToolsCatalog>
  caps: ReturnType<typeof useCapabilities>
  mcp: ReturnType<typeof useExternalMcp>
}) {
  const {
    allTools, allGroups,
    showAddTool, setShowAddTool, newToolName, setNewToolName,
    newToolUrl, setNewToolUrl, newToolDesc, setNewToolDesc,
    showAddGroup, setShowAddGroup, newGroupName, setNewGroupName,
    newGroupDesc, setNewGroupDesc, newGroupToolIds, setNewGroupToolIds,
    setToolsField, toggleGroup, toggleTool, toggleDisabledTool,
    addCustomTool, deleteCustomTool, addCustomGroup, deleteCustomGroup,
  } = toolsCatalog
  const {
    capabilityConfig, pgConnectionString, setPgConnectionString, pgMaxRows, setPgMaxRows,
    pgTestResult, pgSaving, savePostgresConfig, togglePostgresEnabled, testPostgresConnection,
    scholarVenueFilter, setScholarVenueFilter, toggleScholarEnabled, saveScholarVenueFilter,
    toolContextEstimate,
  } = caps
  const {
    externalServers, showAddExternal, setShowAddExternal,
    newExtName, setNewExtName, newExtUrl, setNewExtUrl, mcpTestResults,
    addExternalMcpServer, removeExternalMcpServer, testExternalMcpServer,
  } = mcp

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
        {/* Whitelist toggle — restriction is the default posture */}
        <div className="mb-4 flex items-center justify-between px-3 py-2 bg-zinc-800/60 rounded">
          <div>
            <p className="text-sm text-zinc-200">Restrict to approved sources</p>
            <p className="text-xs text-zinc-500">
              {config.tools?.whitelistEnabled !== false
                ? 'The model can only fetch from the sources selected below.'
                : 'Whitelist off — the model can fetch any public website. Local network addresses are always blocked.'}
            </p>
          </div>
          <TogglePill
            checked={config.tools?.whitelistEnabled !== false}
            onToggle={() => setToolsField('whitelistEnabled', config.tools?.whitelistEnabled === false)}
            className="flex-shrink-0"
          />
        </div>

        {config.tools?.whitelistEnabled === false && (
          <div className="mb-4 px-3 py-2 rounded text-xs border bg-yellow-900/30 border-yellow-700 text-yellow-300">
            ⚠ Open web access: the model can reach any public site, including ones you haven't reviewed. Fetched pages can contain wrong or manipulative content. Sources selected below still power web_search and the model's source hints.
          </div>
        )}

        {/* Performance warning */}
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

        <div className="grid grid-cols-2 gap-6">
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
                        {tool.builtIn && !inActiveGroup && tool.kind === 'capability' &&
                          <span className="text-xs text-zinc-600 ml-2">{tool.id === 'postgres' ? 'Local database' : 'Local file output'}</span>}
                        {tool.builtIn && !inActiveGroup && tool.kind !== 'capability' && <span className="text-xs text-zinc-600 ml-2">{tool.baseUrl}</span>}
                      </div>
                    </label>
                    {!tool.builtIn && (
                      <button onClick={() => deleteCustomTool(tool.id)} className="text-xs text-zinc-600 hover:text-red-400 transition-colors flex-shrink-0 px-1">✕</button>
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
                  <button onClick={addCustomTool} className={btnCls.primary}>Save source</button>
                  <button onClick={() => { setShowAddTool(false); setNewToolName(''); setNewToolUrl(''); setNewToolDesc('') }} className={btnCls.secondary}>Cancel</button>
                </div>
              </div>
            )}

            <div className="flex items-center gap-3">
              <label className="text-xs text-zinc-400 whitespace-nowrap">Max tokens per fetch</label>
              <input
                type="number" min={500} max={8000} step={500}
                value={config.tools?.maxFetchTokens ?? 2000}
                onChange={e => setToolsField('maxFetchTokens', Math.max(500, Math.min(8000, parseInt(e.target.value) || 2000)))}
                className="w-24 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500"
              />
              <span className="text-xs text-zinc-600">of {config.ctxSize} ctx tokens</span>
            </div>

            {toolContextEstimate && toolContextEstimate.toolCount > 0 && (
              <p className={`text-xs mt-2 ${
                toolContextEstimate.approxTokens > config.ctxSize * 0.25 ? 'text-amber-400' : 'text-zinc-500'
              }`}>
                {toolContextEstimate.toolCount} active tool{toolContextEstimate.toolCount === 1 ? '' : 's'} ≈ {toolContextEstimate.approxTokens.toLocaleString()} tokens of context on every request
                {toolContextEstimate.approxTokens > config.ctxSize * 0.25
                  ? ` — over a quarter of your ${config.ctxSize.toLocaleString()}-token window. Consider activating fewer tools per profile.`
                  : ''}
              </p>
            )}
          </div>
        </div>

        {/* Capability configuration — global setup, activated per-profile above */}
        <div className="mt-6 pt-4 border-t border-zinc-700">
          <p className="text-xs uppercase tracking-widest text-zinc-500 mb-3">Local Capabilities</p>

          <div className="space-y-4">
            {/* Postgres */}
            <div className="bg-zinc-800/40 rounded px-3 py-2.5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-zinc-200">Postgres</span>
                <span className={`text-xs ${
                  capabilityConfig?.postgres.hasConnectionString
                    ? (capabilityConfig.postgres.enabled ? 'text-green-400' : 'text-zinc-500')
                    : 'text-zinc-600'
                }`}>
                  {capabilityConfig?.postgres.hasConnectionString
                    ? (capabilityConfig.postgres.enabled ? 'Configured · Enabled' : 'Configured · Disabled')
                    : 'Not configured'}
                </span>
              </div>
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
                {capabilityConfig?.postgres.hasConnectionString && (
                  <button onClick={togglePostgresEnabled} className={btnCls.chip}>
                    {capabilityConfig.postgres.enabled ? 'Disable' : 'Enable'}
                  </button>
                )}
                {pgTestResult && (
                  <span className={`text-xs ${pgTestResult.ok ? 'text-green-400' : 'text-red-400'}`}>{pgTestResult.message}</span>
                )}
              </div>
              <p className="text-xs text-zinc-600 mt-1.5">Queries run read-only. Use a database role with read-only grants for defense in depth.</p>
            </div>

            {FOLDER_CARDS.map(card => (
              <FolderCapabilityCard key={card.cap} caps={caps} {...card} />
            ))}

            {/* Scholar */}
            <div className="bg-zinc-800/40 rounded px-3 py-2.5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-zinc-200">Scholar</span>
                <span className={`text-xs ${capabilityConfig?.scholar.enabled ? 'text-green-400' : 'text-zinc-500'}`}>
                  {capabilityConfig?.scholar.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
              <div className="flex items-center gap-2 mb-1.5">
                <input
                  type="text" value={scholarVenueFilter} onChange={e => setScholarVenueFilter(e.target.value)}
                  placeholder="Optional venue whitelist: journal ISSNs and/or arXiv categories (e.g. 1932-6203, cs.CL)"
                  className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500 placeholder:text-zinc-600" />
                <button onClick={saveScholarVenueFilter} className={btnCls.chip}>Save filter</button>
                <button onClick={toggleScholarEnabled} className={btnCls.chip}>
                  {capabilityConfig?.scholar.enabled ? 'Disable' : 'Enable'}
                </button>
              </div>
              <p className="text-xs text-zinc-600 mt-1.5">Search open academic literature (OpenAlex, arXiv, PubMed) and save open-access PDFs into the Documents folder. Leave the whitelist empty for all venues; when set, searches and downloads are restricted to those journals/categories at the API level.</p>
            </div>
          </div>
        </div>
      </>) : (
        <p className="text-xs text-zinc-600">Enable web sources to allow the model to fetch live content from approved sites via the built-in MCP server. Settings are saved with the active profile.</p>
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
            ? <span className="text-green-400">http://localhost:{(config.port ?? 19080) + 2}/sse</span>
            : <span className="text-zinc-600">Starts with server (enable web sources above)</span>
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
                onClick={() => removeExternalMcpServer(server.id)}
                className="text-xs text-zinc-600 hover:text-red-400 transition-colors px-1 flex-shrink-0">
                ✕
              </button>
            </div>
          ))}
        </div>

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
            <div className="flex gap-2 pt-1">
              <button onClick={addExternalMcpServer} className={btnCls.primary}>
                Add server
              </button>
              <button onClick={() => { setShowAddExternal(false); setNewExtName(''); setNewExtUrl('') }} className={btnCls.secondary}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Banned tools — server-enforced, applies to every client */}
      <div className="mt-6 pt-4 border-t border-zinc-700">
        <p className="text-xs uppercase tracking-widest text-zinc-500 mb-1">Banned Tools</p>
        <p className="text-xs text-zinc-600 mb-3">
          Banned tools are removed from the model's vocabulary for every connected client — staff cannot re-enable them in their settings. Use this to enforce an org policy (e.g. disable file writes).
        </p>
        <div className="space-y-1.5">
          {allTools.filter(t => t.kind === 'capability').map(tool => {
            const banned = (config.tools?.disabledToolIds ?? []).includes(tool.id)
            return (
              <label key={tool.id} className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox" checked={banned}
                  onChange={() => toggleDisabledTool(tool.id)}
                  className="accent-orange-500"
                />
                <span className="text-sm text-zinc-200">{tool.name}</span>
                <span className="text-xs text-zinc-600">{tool.description}</span>
              </label>
            )
          })}
        </div>
      </div>
    </section>
  )
}
