// =============================================================================
// Redstart Nest — renderer UI
// =============================================================================
// This is the React app that runs inside Electron's renderer process. It's
// the control panel the user sees: scan hardware, pick a model, configure
// parameters, and launch/stop the llama-server. It communicates with the main
// process exclusively through the redstartAPI bridge defined in the preload
// script — renderer code can't directly call Node.js APIs for security reasons.
//
// I kept this as a single-file component intentionally. The app is small and
// the configuration state is all tightly related. Splitting it into many
// components would add indirection without much benefit at this scale.
// =============================================================================

import { useState, useEffect, useRef } from 'react'
import QRCode from 'qrcode'
import type { LlamaConfig } from './types'
import { DEFAULT_CONFIG } from './types'
import { api, getAPI } from './api/redstart'
import { TogglePill } from './components/ui'
import { useStatusMessage } from './hooks/useStatusMessage'
import { useAuthSetup } from './hooks/useAuthSetup'
import { useExternalMcp } from './hooks/useExternalMcp'
import { useToolsCatalog } from './hooks/useToolsCatalog'
import { useCapabilities } from './hooks/useCapabilities'
import { useHardwareAndBinary } from './hooks/useHardwareAndBinary'
import { useProfiles } from './hooks/useProfiles'
import { useServerLifecycle } from './hooks/useServerLifecycle'
import { HardwarePanel } from './panels/HardwarePanel'
import { ProfilesPanel } from './panels/ProfilesPanel'
import { BinaryPanel } from './panels/BinaryPanel'
import { ModelPanel } from './panels/ModelPanel'
import { NetworkPanel } from './panels/NetworkPanel'
import { AccountsPanel } from './panels/AccountsPanel'
import { ConfigTab } from './tabs/ConfigTab'

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function App() {
  const [config, setConfig] = useState<LlamaConfig>(DEFAULT_CONFIG)
  const [generatedCommand, setGeneratedCommand] = useState('')
  const [networkMode, setNetworkMode] = useState(true)
  const [localIp, setLocalIp] = useState('')
  const [advertisedHost, setAdvertisedHost] = useState('redstart.local')
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [activeTab, setActiveTab] = useState<'config' | 'tools' | 'server'>('config')
  const logEndRef = useRef<HTMLDivElement>(null)

  const { statusMsg, show: showStatus, clear: clearStatus } = useStatusMessage()

  // Domain hooks — each owns one slice of state and its IPC calls; App only
  // wires them together and renders. See src/hooks/.
  const auth = useAuthSetup(showStatus)
  const mcp = useExternalMcp()
  const toolsCatalog = useToolsCatalog(config, setConfig)
  const caps = useCapabilities(config)
  const hw = useHardwareAndBinary(setConfig)
  const profilesHook = useProfiles(config, setConfig, setAdvertisedHost, showStatus)
  const server = useServerLifecycle({
    config, showStatus, clearStatus,
    onLaunchStarted: () => setActiveTab('server'),
  })

  // --- Bootstrap ---

  useEffect(() => {
    const a = getAPI()
    if (!a) {
      showStatus('ERROR: redstartAPI not found — preload script may have failed to load.', 0)
      return
    }
    a.server.getIp().then(setLocalIp)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-scroll log to bottom on new lines
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'auto' })
  }, [server.logLines])

  // --- Update QR whenever network info changes ---
  // The QR code encodes a deep link in the format redstart://connect?url=http://...
  // When an Android user scans this with their camera, the OS routes it to the
  // Redstart Twig app (because the app registers the redstart:// URI scheme in its
  // manifest). The app then reads the url parameter and auto-configures itself.
  // I chose a custom URI scheme over a plain URL because a plain http:// link
  // would just open the browser instead of the Redstart Twig app.

  // Sync advertisedHost to config whenever it changes
  useEffect(() => {
    setConfig(prev => ({ ...prev, advertisedHost }))
  }, [advertisedHost])

  useEffect(() => {
    if (!networkMode) { setQrDataUrl(''); return }
    const host = (advertisedHost || localIp || '').trim()
    if (!host) { setQrDataUrl(''); return }
    const deepLink = `redstart://connect?url=${encodeURIComponent(`http://${host}:${config.port}`)}`
    QRCode.toDataURL(deepLink, { width: 200, margin: 1 }).then(setQrDataUrl).catch(() => setQrDataUrl(''))
  }, [networkMode, advertisedHost, localIp, config.port])

  // --- Config networkMode sync ---

  useEffect(() => {
    setConfig(prev => ({ ...prev, networkMode }))
  }, [networkMode])

  // --- Hook aliases ---
  // Local names matching what the JSX has always used. Phase 3 removes these
  // by passing the hook objects to the extracted panel/tab components directly.

  const { selectModel } = hw
  const generateDefaultProfiles = () => profilesHook.generateDefaultProfiles(hw.hardware)
  const {
    allTools, allGroups,
    showAddTool, setShowAddTool, newToolName, setNewToolName,
    newToolUrl, setNewToolUrl, newToolDesc, setNewToolDesc,
    showAddGroup, setShowAddGroup, newGroupName, setNewGroupName,
    newGroupDesc, setNewGroupDesc, newGroupToolIds, setNewGroupToolIds,
    setToolsField, toggleGroup, toggleTool,
    addCustomTool, deleteCustomTool, addCustomGroup, deleteCustomGroup,
  } = toolsCatalog
  const {
    capabilityConfig, pgConnectionString, setPgConnectionString, pgMaxRows, setPgMaxRows,
    pgTestResult, pgSaving, savePostgresConfig, togglePostgresEnabled, testPostgresConnection,
    scholarVenueFilter, setScholarVenueFilter, toggleScholarEnabled, saveScholarVenueFilter,
    toolContextEstimate,
  } = caps
  const docsSaving = caps.savingCap === 'documents'
  const sqliteSaving = caps.savingCap === 'sqlite'
  const chooseDocumentsFolder = () => caps.chooseFolder('documents')
  const toggleDocumentsEnabled = () => caps.toggleCapEnabled('documents')
  const chooseSqliteFolder = () => caps.chooseFolder('sqlite')
  const toggleSqliteEnabled = () => caps.toggleCapEnabled('sqlite')
  const chooseVaultFolder = () => caps.chooseFolder('vault')
  const toggleVaultEnabled = () => caps.toggleCapEnabled('vault')
  const chooseGitFolder = () => caps.chooseFolder('git')
  const toggleGitEnabled = () => caps.toggleCapEnabled('git')
  const chooseFileSystemFolder = () => caps.chooseFolder('file_system')
  const toggleFileSystemEnabled = () => caps.toggleCapEnabled('file_system')
  const {
    externalServers, showAddExternal, setShowAddExternal,
    newExtName, setNewExtName, newExtUrl, setNewExtUrl, mcpTestResults,
    addExternalMcpServer, removeExternalMcpServer, testExternalMcpServer,
  } = mcp
  const {
    serverState, health, tokensPerMin, logLines, clearLog,
    confirmStop, setConfirmStop, launchServer, requestStopServer, confirmStopServer,
  } = server

  // --- Command preview ---

  async function generateCommand() {
    const cmd = await api().llama.generateCommand(config)
    setGeneratedCommand(cmd)
  }

  // --- Derived state ---

  const isRunning = serverState === 'running'
  const isStopping = serverState === 'stopping'
  const isStarting = serverState === 'starting'
  const canLaunch = serverState === 'stopped' && !!config.modelPath

  const healthColor =
    health === 'ok' ? 'text-orange-400' :
    health === 'no slot available' ? 'text-amber-400' :
    health === 'starting' ? 'text-orange-300' : 'text-zinc-500'

  const healthLabel =
    health === 'ok' ? 'Idle' :
    health === 'no slot available' ? 'Processing' :
    health === 'starting' ? 'Starting…' :
    health === 'unreachable' ? 'Unreachable' :
    health ?? '—'

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-white font-mono text-sm overflow-hidden">

      {/* ── Top bar ── */}
      <header className="flex items-center justify-between px-5 py-3 bg-zinc-900 border-b border-zinc-800 shrink-0">
        <h1 className="text-lg font-bold tracking-wide">
          Redstart <span className="text-orange-500">/ LlamaCpp Launcher</span>
        </h1>
        <div className="flex items-center gap-5">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${isRunning ? 'bg-orange-500' : isStopping || isStarting ? 'bg-amber-400' : 'bg-zinc-600'}`} />
            <span className="text-xs uppercase tracking-widest text-zinc-400">
              {serverState === 'running' ? healthLabel : serverState === 'stopping' ? 'Stopping…' : serverState === 'starting' ? 'Starting…' : 'Stopped'}
            </span>
          </div>
          {isRunning && (
            <div className="text-xs text-zinc-400">
              <span className="text-orange-400 font-semibold">{tokensPerMin.toLocaleString()}</span> tok/min
            </div>
          )}
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">

        {/* ── Sidebar ── */}
        <aside className="w-64 bg-zinc-900 border-r border-zinc-800 flex flex-col gap-5 p-4 overflow-y-auto shrink-0">

          <HardwarePanel hw={hw} onGenerateDefaults={generateDefaultProfiles} />
          <ProfilesPanel profilesHook={profilesHook} />
          <BinaryPanel hw={hw} />
          <ModelPanel modelPath={config.modelPath} onSelectModel={selectModel} />

          <NetworkPanel
            networkMode={networkMode}
            onToggleNetworkMode={() => setNetworkMode(v => !v)}
            advertisedHost={advertisedHost}
            setAdvertisedHost={setAdvertisedHost}
            localIp={localIp}
            port={config.port}
            qrDataUrl={qrDataUrl}
          />

          <AccountsPanel auth={auth} />
        </aside>

        {/* ── Main content ── */}
        <main className="flex-1 flex flex-col overflow-y-auto p-5 gap-5">

          {/* ── Tab bar (browser-style) ── */}
          <div className="flex items-end gap-1 border-b border-zinc-800 -mx-5 px-5 -mt-2 pt-2 sticky top-0 bg-zinc-950 z-10">
            {([
              ['config', 'Configuration'],
              ['tools', 'Tools'],
              ['server', 'Server'],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={`px-4 py-2 rounded-t-lg text-sm border border-b-0 transition-colors flex items-center gap-2 ${
                  activeTab === id
                    ? 'bg-zinc-900 border-zinc-800 text-white'
                    : 'bg-transparent border-transparent text-zinc-500 hover:text-zinc-300'
                }`}>
                {label}
                {id === 'server' && serverState !== 'stopped' && (
                  <span className={`w-1.5 h-1.5 rounded-full ${serverState === 'running' ? 'bg-green-400' : 'bg-amber-400 animate-pulse'}`} />
                )}
              </button>
            ))}
          </div>

          {activeTab === 'config' && (
            <ConfigTab
              config={config}
              setConfig={setConfig}
              networkMode={networkMode}
              generatedCommand={generatedCommand}
              onGenerateCommand={generateCommand}
            />
          )}

          {/* Tools (Web Sources + MCP) */}
          {activeTab === 'tools' && (
          <section className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xs uppercase tracking-widest text-zinc-500">Tools</h2>
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
                    <button onClick={() => setShowAddGroup(true)}
                      className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
                      + Create custom group
                    </button>
                  ) : (
                    <div className="space-y-2 bg-zinc-800/60 p-3 rounded border border-zinc-700">
                      <input value={newGroupName} onChange={e => setNewGroupName(e.target.value)}
                        placeholder="Group name" className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500" />
                      <input value={newGroupDesc} onChange={e => setNewGroupDesc(e.target.value)}
                        placeholder="Description (optional)" className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500" />
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
                        <button onClick={addCustomGroup} className="px-3 py-1.5 bg-orange-500 hover:bg-orange-400 rounded text-xs font-medium transition-colors">Save group</button>
                        <button onClick={() => { setShowAddGroup(false); setNewGroupName(''); setNewGroupToolIds([]) }} className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors">Cancel</button>
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
                    <button onClick={() => setShowAddTool(true)}
                      className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors mb-4 block">
                      + Add custom source
                    </button>
                  ) : (
                    <div className="space-y-2 bg-zinc-800/60 p-3 rounded border border-zinc-700 mb-4">
                      <input value={newToolName} onChange={e => setNewToolName(e.target.value)}
                        placeholder="Source name" className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500" />
                      <input value={newToolUrl} onChange={e => setNewToolUrl(e.target.value)}
                        placeholder="Base URL (e.g. https://example.com)" className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500" />
                      <input value={newToolDesc} onChange={e => setNewToolDesc(e.target.value)}
                        placeholder="Description (optional)" className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500" />
                      <div className="flex gap-2 pt-1">
                        <button onClick={addCustomTool} className="px-3 py-1.5 bg-orange-500 hover:bg-orange-400 rounded text-xs font-medium transition-colors">Save source</button>
                        <button onClick={() => { setShowAddTool(false); setNewToolName(''); setNewToolUrl(''); setNewToolDesc('') }} className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors">Cancel</button>
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

              {/* Capability configuration (Postgres, Documents, SQLite, Vault, Git, Scholar) — global setup, activated per-profile above */}
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
                      <button onClick={testPostgresConnection} className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors">Test connection</button>
                      <button onClick={savePostgresConfig} disabled={pgSaving} className="px-2.5 py-1 bg-orange-500 hover:bg-orange-400 disabled:opacity-50 rounded text-xs font-medium transition-colors">
                        {pgSaving ? 'Saving…' : 'Save'}
                      </button>
                      {capabilityConfig?.postgres.hasConnectionString && (
                        <button onClick={togglePostgresEnabled} className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors">
                          {capabilityConfig.postgres.enabled ? 'Disable' : 'Enable'}
                        </button>
                      )}
                      {pgTestResult && (
                        <span className={`text-xs ${pgTestResult.ok ? 'text-green-400' : 'text-red-400'}`}>{pgTestResult.message}</span>
                      )}
                    </div>
                    <p className="text-xs text-zinc-600 mt-1.5">Queries run read-only. Use a database role with read-only grants for defense in depth.</p>
                  </div>

                  {/* Documents */}
                  <div className="bg-zinc-800/40 rounded px-3 py-2.5">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-zinc-200">Documents</span>
                      <span className={`text-xs ${capabilityConfig?.documents.outputDir ? (capabilityConfig.documents.enabled ? 'text-green-400' : 'text-zinc-500') : 'text-zinc-600'}`}>
                        {capabilityConfig?.documents.outputDir ? (capabilityConfig.documents.enabled ? 'Enabled' : 'Disabled') : 'Not configured'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="flex-1 min-w-0 text-xs text-zinc-400 truncate">
                        {capabilityConfig?.documents.outputDir || 'No output folder chosen'}
                      </span>
                      <button onClick={chooseDocumentsFolder} disabled={docsSaving} className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 rounded text-xs transition-colors flex-shrink-0">
                        Choose folder…
                      </button>
                      {capabilityConfig?.documents.outputDir && (
                        <button onClick={toggleDocumentsEnabled} className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors flex-shrink-0">
                          {capabilityConfig.documents.enabled ? 'Disable' : 'Enable'}
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-zinc-600 mt-1.5">The model can create documents in this folder and read documents and spreadsheets (.pdf, .docx, .txt, .md, .xlsx, .csv) you place in it. All extraction happens on-device.</p>
                  </div>

                  {/* SQLite */}
                  <div className="bg-zinc-800/40 rounded px-3 py-2.5">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-zinc-200">SQLite</span>
                      <span className={`text-xs ${capabilityConfig?.sqlite.rootDir ? (capabilityConfig.sqlite.enabled ? 'text-green-400' : 'text-zinc-500') : 'text-zinc-600'}`}>
                        {capabilityConfig?.sqlite.rootDir ? (capabilityConfig.sqlite.enabled ? 'Enabled' : 'Disabled') : 'Not configured'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="flex-1 min-w-0 text-xs text-zinc-400 truncate">
                        {capabilityConfig?.sqlite.rootDir || 'No database folder chosen'}
                      </span>
                      <button onClick={chooseSqliteFolder} disabled={sqliteSaving} className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 rounded text-xs transition-colors flex-shrink-0">
                        Choose folder…
                      </button>
                      {capabilityConfig?.sqlite.rootDir && (
                        <button onClick={toggleSqliteEnabled} className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors flex-shrink-0">
                          {capabilityConfig.sqlite.enabled ? 'Disable' : 'Enable'}
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-zinc-600 mt-1.5">Read-only queries against .sqlite/.db files in the chosen folder. The files are never opened for writing.</p>
                  </div>

                  {/* Vault */}
                  <div className="bg-zinc-800/40 rounded px-3 py-2.5">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-zinc-200">Vault</span>
                      <span className={`text-xs ${capabilityConfig?.vault.rootDir ? (capabilityConfig.vault.enabled ? 'text-green-400' : 'text-zinc-500') : 'text-zinc-600'}`}>
                        {capabilityConfig?.vault.rootDir ? (capabilityConfig.vault.enabled ? 'Enabled' : 'Disabled') : 'Not configured'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="flex-1 min-w-0 text-xs text-zinc-400 truncate">
                        {capabilityConfig?.vault.rootDir || 'No notes folder chosen'}
                      </span>
                      <button onClick={chooseVaultFolder} className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors flex-shrink-0">
                        Choose folder…
                      </button>
                      {capabilityConfig?.vault.rootDir && (
                        <button onClick={toggleVaultEnabled} className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors flex-shrink-0">
                          {capabilityConfig.vault.enabled ? 'Disable' : 'Enable'}
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-zinc-600 mt-1.5">Read-only search across markdown notes (Obsidian vault or any folder of .md files) — search, read notes, browse tags.</p>
                  </div>

                  {/* Git */}
                  <div className="bg-zinc-800/40 rounded px-3 py-2.5">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-zinc-200">Git</span>
                      <span className={`text-xs ${capabilityConfig?.git.rootDir ? (capabilityConfig.git.enabled ? 'text-green-400' : 'text-zinc-500') : 'text-zinc-600'}`}>
                        {capabilityConfig?.git.rootDir ? (capabilityConfig.git.enabled ? 'Enabled' : 'Disabled') : 'Not configured'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="flex-1 min-w-0 text-xs text-zinc-400 truncate">
                        {capabilityConfig?.git.rootDir || 'No repository folder chosen'}
                      </span>
                      <button onClick={chooseGitFolder} className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors flex-shrink-0">
                        Choose folder…
                      </button>
                      {capabilityConfig?.git.rootDir && (
                        <button onClick={toggleGitEnabled} className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors flex-shrink-0">
                          {capabilityConfig.git.enabled ? 'Disable' : 'Enable'}
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-zinc-600 mt-1.5">Read-only repository context (status, recent commits, uncommitted diffs). Choose a repository or a folder containing repositories. Requires git on the server machine.</p>
                  </div>

                  {/* File System */}
                  <div className="bg-zinc-800/40 rounded px-3 py-2.5">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-zinc-200">File System</span>
                      <span className={`text-xs ${capabilityConfig?.file_system.rootDir ? (capabilityConfig.file_system.enabled ? 'text-green-400' : 'text-zinc-500') : 'text-zinc-600'}`}>
                        {capabilityConfig?.file_system.rootDir ? (capabilityConfig.file_system.enabled ? 'Enabled' : 'Disabled') : 'Not configured'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="flex-1 min-w-0 text-xs text-zinc-400 truncate">
                        {capabilityConfig?.file_system.rootDir || 'No folder chosen'}
                      </span>
                      <button onClick={chooseFileSystemFolder} className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors flex-shrink-0">
                        Choose folder…
                      </button>
                      {capabilityConfig?.file_system.rootDir && (
                        <button onClick={toggleFileSystemEnabled} className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors flex-shrink-0">
                          {capabilityConfig.file_system.enabled ? 'Disable' : 'Enable'}
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-zinc-600 mt-1.5">Read and write files within a chosen folder — read configs, write scripts, edit project files. Paths are contained to the chosen root.</p>
                  </div>

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
                      <button onClick={saveScholarVenueFilter} className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors flex-shrink-0">Save filter</button>
                      <button onClick={toggleScholarEnabled} className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors flex-shrink-0">
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
                  <button
                    onClick={() => setShowAddExternal(true)}
                    className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
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
                    className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500" />
                  <input
                    value={newExtUrl} onChange={e => setNewExtUrl(e.target.value)}
                    placeholder="SSE URL (e.g. http://10.0.0.5:9000/sse)"
                    className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500" />
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={addExternalMcpServer}
                      className="px-3 py-1.5 bg-orange-500 hover:bg-orange-400 rounded text-xs font-medium transition-colors">
                      Add server
                    </button>
                    <button
                      onClick={() => { setShowAddExternal(false); setNewExtName(''); setNewExtUrl('') }}
                      className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>

          )}

          {/* Status message */}
          {statusMsg && (
            <div className="text-xs text-center text-zinc-400 px-4">{statusMsg}</div>
          )}

          {/* Launch / Stop */}
          <div className="flex items-center gap-3">
            {serverState === 'stopped' && (
              <button
                onClick={launchServer}
                disabled={!canLaunch}
                className="flex-1 py-3 bg-orange-500 hover:bg-orange-400 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed rounded-lg font-semibold text-sm transition-colors">
                {config.modelPath ? 'Launch LlamaCpp Server' : 'Select a model to launch'}
              </button>
            )}
            {serverState === 'starting' && (
              <div className="flex-1 py-3 bg-zinc-800 rounded-lg text-center text-sm text-orange-400 animate-pulse">
                Starting server…
              </div>
            )}
            {serverState === 'running' && !confirmStop && (
              <button
                onClick={requestStopServer}
                className="flex-1 py-3 bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 hover:border-zinc-500 rounded-lg font-semibold text-sm text-white transition-colors">
                Stop Server
              </button>
            )}
            {serverState === 'running' && confirmStop && (
              <div className="flex flex-1 items-center gap-3 rounded-lg border border-amber-800 bg-zinc-900 px-4 py-2">
                <span className="flex-1 text-xs text-amber-400">Stop now? Any active generation will be interrupted.</span>
                <button
                  onClick={confirmStopServer}
                  className="px-3 py-1.5 bg-red-700 hover:bg-red-600 text-white rounded text-xs font-semibold transition-colors">
                  Stop Now
                </button>
                <button
                  onClick={() => setConfirmStop(false)}
                  className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-white rounded text-xs transition-colors">
                  Cancel
                </button>
              </div>
            )}
            {serverState === 'stopping' && (
              <div className="flex-1 py-3 bg-zinc-800 rounded-lg text-center text-sm text-amber-400 animate-pulse">
                Stopping server…
              </div>
            )}

          </div>

          {/* ── Server tab: health + terminal ── */}
          {activeTab === 'server' && (
            <>
              {isRunning && (
                <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 flex items-center justify-between">
                  <span className="text-xs text-zinc-500">Server health</span>
                  <span className={`text-xs font-semibold ${healthColor}`}>{healthLabel}</span>
                </div>
              )}

              <section className="flex flex-col flex-1 min-h-64 bg-black rounded-lg border border-zinc-800 overflow-hidden">
                <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900 border-b border-zinc-800 shrink-0">
                  <span className="text-xs text-zinc-500 uppercase tracking-widest">Server Terminal</span>
                  <button
                    onClick={clearLog}
                    className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors">
                    Clear
                  </button>
                </div>
                <div className="flex-1 min-h-56 overflow-y-auto p-3 font-mono text-xs leading-relaxed">
                  {serverState === 'stopped' && logLines.length === 0 ? (
                    <span className="text-zinc-600">Server is not running. Launch it to see output here.</span>
                  ) : logLines.length === 0 ? (
                    <span className="text-zinc-600">Waiting for output…</span>
                  ) : (
                    logLines.map((line, i) => (
                      <div key={i} className={`whitespace-pre-wrap break-all ${
                        /error|fail|warn/i.test(line) ? 'text-red-400' :
                        /load|ready|listen/i.test(line) ? 'text-orange-400' :
                        'text-zinc-300'
                      }`}>{line}</div>
                    ))
                  )}
                  <div ref={logEndRef} />
                </div>
              </section>
            </>
          )}

        </main>
      </div>
    </div>
  )
}
