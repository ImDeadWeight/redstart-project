// =============================================================================
// Redstart Nest — renderer UI shell
// =============================================================================
// The React app running inside Electron's renderer. It talks to the main
// process exclusively through the redstartAPI bridge (see api/redstart.ts) —
// renderer code can't directly call Node.js APIs for security reasons.
//
// App itself is just the shell: layout, tab switching, and wiring the domain
// hooks (src/hooks/) into the panel/tab components (src/panels/, src/tabs/).
// Each hook owns one slice of state and its IPC calls; each component owns
// its own markup. Shared visual primitives live in components/ui.tsx.
// =============================================================================

import { useState, useEffect } from 'react'
import QRCode from 'qrcode'
import type { LlamaConfig } from './types'
import { DEFAULT_CONFIG } from './types'
import { api, getAPI } from './api/redstart'
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
import { ToolsTab } from './tabs/ToolsTab'
import { ServerTab, healthDisplay } from './tabs/ServerTab'
import { LaunchControls } from './components/LaunchControls'

export default function App() {
  const [config, setConfig] = useState<LlamaConfig>(DEFAULT_CONFIG)
  const [generatedCommand, setGeneratedCommand] = useState('')
  const [networkMode, setNetworkMode] = useState(true)
  const [localIp, setLocalIp] = useState('')
  const [advertisedHost, setAdvertisedHost] = useState('redstart.local')
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [activeTab, setActiveTab] = useState<'config' | 'tools' | 'server'>('config')

  const { statusMsg, show: showStatus, clear: clearStatus } = useStatusMessage()

  // Domain hooks — each owns one slice of state and its IPC calls.
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

  // --- Network / QR ---
  // The QR code encodes a deep link in the format redstart://connect?url=http://...
  // When an Android user scans this with their camera, the OS routes it to the
  // Redstart Twig app (because the app registers the redstart:// URI scheme in its
  // manifest). The app then reads the url parameter and auto-configures itself.
  // A custom URI scheme is used over a plain URL because a plain http:// link
  // would just open the browser instead of the Redstart Twig app.

  // Sync advertisedHost to config whenever it changes. In network mode a blank
  // host defaults to redstart.local so mDNS always advertises a resolvable
  // .local name; localhost-only mode keeps whatever was typed (usually blank).
  useEffect(() => {
    const host = networkMode ? (advertisedHost.trim() || 'redstart.local') : advertisedHost
    setConfig(prev => ({ ...prev, advertisedHost: host }))
  }, [advertisedHost, networkMode])

  useEffect(() => {
    if (!networkMode) { setQrDataUrl(''); return }
    const host = (advertisedHost || localIp || '').trim()
    if (!host) { setQrDataUrl(''); return }
    const deepLink = `redstart://connect?url=${encodeURIComponent(`http://${host}:${config.port}`)}`
    QRCode.toDataURL(deepLink, { width: 200, margin: 1 }).then(setQrDataUrl).catch(() => setQrDataUrl(''))
  }, [networkMode, advertisedHost, localIp, config.port])

  useEffect(() => {
    setConfig(prev => ({ ...prev, networkMode }))
  }, [networkMode])

  // --- Command preview ---

  async function generateCommand() {
    const cmd = await api().llama.generateCommand(config)
    setGeneratedCommand(cmd)
  }

  // --- Derived state ---

  const { serverState, health, tokensPerMin } = server
  const isRunning = serverState === 'running'
  const isStopping = serverState === 'stopping'
  const isStarting = serverState === 'starting'
  const { label: healthLabel } = healthDisplay(health)

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
          <HardwarePanel hw={hw} onGenerateDefaults={() => profilesHook.generateDefaultProfiles(hw.hardware)} />
          <ProfilesPanel profilesHook={profilesHook} />
          <BinaryPanel hw={hw} />
          <ModelPanel modelPath={config.modelPath} onSelectModel={hw.selectModel} />
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

          {activeTab === 'tools' && (
            <ToolsTab config={config} toolsCatalog={toolsCatalog} caps={caps} mcp={mcp} />
          )}

          {/* Status message */}
          {statusMsg && (
            <div className="text-xs text-center text-zinc-400 px-4">{statusMsg}</div>
          )}

          <LaunchControls server={server} modelPath={config.modelPath} />

          {activeTab === 'server' && <ServerTab server={server} />}

        </main>
      </div>
    </div>
  )
}
