// =============================================================================
// Redstart Nest — renderer UI shell
// =============================================================================
// The launcher UI — a browser tab's worth of React, whether it is actually
// running in a browser or inside Electron's window: both are
// plain HTTP clients of the admin listener now, gated by AdminGate.tsx
// before this ever renders). All calls go through the RedstartAPI
// implementation installed by AdminGate (see api/redstart.ts).
//
// App itself is just the shell: layout, tab switching, and wiring the domain
// hooks (src/hooks/) into the panel/tab components (src/panels/, src/tabs/).
// Each hook owns one slice of state and its IPC calls; each component owns
// its own markup. Shared visual primitives live in components/ui.tsx.
// =============================================================================

import { useState, useEffect } from 'react'
import type { LlamaConfig } from './types'
import { DEFAULT_CONFIG } from './types'
import { api, getAPI } from './api/redstart'
import { useStatusMessage } from './hooks/useStatusMessage'
import { useAuthSetup } from './hooks/useAuthSetup'
import { useControlPlaneExposure } from './hooks/useControlPlaneExposure'
import { useStartupSettings } from './hooks/useStartupSettings'
import { useShutdown } from './hooks/useShutdown'
import { useWindowControlsOverlay } from './hooks/useWindowControlsOverlay'
import { TopBar, StatusPill } from './components/ui'
import { useExternalMcp } from './hooks/useExternalMcp'
import { useToolsCatalog } from './hooks/useToolsCatalog'
import { useCapabilities } from './hooks/useCapabilities'
import { usePlugins } from './hooks/usePlugins'
import { useHardwareAndBinary } from './hooks/useHardwareAndBinary'
import { useModelCatalog } from './hooks/useModelCatalog'
import { useProfiles } from './hooks/useProfiles'
import { useServerLifecycle } from './hooks/useServerLifecycle'
import { ConfigTab } from './tabs/ConfigTab'
import { ToolsTab } from './tabs/ToolsTab'
import { PluginsTab } from './tabs/PluginsTab'
import { ModelsTab } from './tabs/ModelsTab'
import { ServerTab, healthDisplay } from './tabs/ServerTab'
import { LaunchControls } from './components/LaunchControls'

export default function App() {
  const [config, setConfig] = useState<LlamaConfig>(DEFAULT_CONFIG)
  const [generatedCommand, setGeneratedCommand] = useState('')
  const [networkMode, setNetworkMode] = useState(true)
  const [localIp, setLocalIp] = useState('')
  const [activeTab, setActiveTab] = useState<'config' | 'models' | 'tools' | 'plugins' | 'server'>('config')

  const { statusMsg, show: showStatus, clear: clearStatus } = useStatusMessage()

  // Domain hooks — each owns one slice of state and its IPC calls.
  const auth = useAuthSetup(showStatus)
  const controlPlaneExposure = useControlPlaneExposure(showStatus)
  const startup = useStartupSettings(showStatus)
  const shutdown = useShutdown(showStatus)
  // Electron hides the OS title bar, so the header above doubles as it. See
  // the hook for why this is feature-detected rather than an "is Electron" check.
  const overlay = useWindowControlsOverlay()
  const mcp = useExternalMcp()
  const caps = useCapabilities(config)
  const plugins = usePlugins()
  const hw = useHardwareAndBinary(setConfig)
  const modelCatalog = useModelCatalog()
  // profilesHook and server are constructed BEFORE toolsCatalog so the latter
  // can close over them: every Tools-tab toggle needs to know whether the
  // profile it's editing is the one actually running, to decide whether to
  // push the change live (see syncToolsIfLive's own comment for why that
  // check exists — nothing stops the admin switching profiles mid-session).
  const profilesHook = useProfiles(config, setConfig, showStatus)
  const server = useServerLifecycle({
    config, showStatus, clearStatus,
    onLaunchStarted: () => setActiveTab('server'),
    selectedProfile: profilesHook.selectedProfile,
  })
  const toolsCatalog = useToolsCatalog(config, setConfig, server.syncToolsIfLive)

  // --- Bootstrap ---

  useEffect(() => {
    const a = getAPI()
    if (!a) {
      showStatus('ERROR: no session installed — AdminGate should have set one up before this rendered.', 0)
      return
    }
    a.server.getIp().then(setLocalIp)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

      {/* Also the window's title bar in Electron — see TopBar in
          components/ui.tsx, which the sign-in screen shares so the bar does not
          appear only after signing in. */}
      <TopBar
        overlay={overlay}
        right={<>
          <StatusPill
            tone={isRunning ? 'on' : isStopping || isStarting ? 'pending' : 'off'}
            label={serverState === 'running' ? healthLabel : serverState === 'stopping' ? 'Stopping…' : serverState === 'starting' ? 'Starting…' : 'Stopped'}
          />
          {isRunning && (
            <div className="text-xs text-zinc-400">
              <span className="text-orange-400 font-semibold">{tokensPerMin.toLocaleString()}</span> tok/min
            </div>
          )}
        </>}
      />

      <div className="flex flex-1 overflow-hidden">

        {/* ── Main content ──
            No sidebar (retired 2026-09-02): with only Profiles, Server
            Binary, Model, and Accounts living there, a fixed 256px rail was
            more chrome than content. Each moved to the tab that already
            governs the setting: Profiles + Server Binary into Configuration
            (profile at the top, since it's what everything below describes),
            Model selection + hardware scan into Models, and the two Accounts
            toggles into Configuration's Network card, which already showed
            the control-plane exposure warning they govern. */}
        <main className="flex-1 flex flex-col overflow-y-auto px-5 pb-5 gap-5">

          {/* ── Tab bar (browser-style) ──
              No top padding on <main> above — the tab bar is the first child
              and owns its own pt-5, so it sits flush at the scrollport's true
              top edge. Combining `sticky top-0` with a negative top margin
              (the previous approach) shifts the stuck offset itself, which is
              why lower content bled through above it when scrolled. */}
          <div className="flex items-end gap-1 border-b border-zinc-800 -mx-5 px-5 pt-5 sticky top-0 bg-zinc-950 z-20">
            {([
              ['config', 'Configuration'],
              ['models', 'Models'],
              ['plugins', 'Plugins'],
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
              onToggleNetworkMode={() => setNetworkMode(v => !v)}
              localIp={localIp}
              generatedCommand={generatedCommand}
              onGenerateCommand={generateCommand}
              profilesHook={profilesHook}
              hw={hw}
              auth={auth}
              controlPlaneExposure={controlPlaneExposure}
              startup={startup}
              shutdown={shutdown}
            />
          )}

          {activeTab === 'models' && (
            <ModelsTab
              catalog={modelCatalog}
              hw={hw}
              modelPath={config.modelPath}
              onGenerateDefaultProfiles={() => profilesHook.generateDefaultProfiles(hw.hardware)}
            />
          )}

          {activeTab === 'plugins' && (
            <PluginsTab plugins={plugins} />
          )}

          {activeTab === 'tools' && (
            <ToolsTab config={config} toolsCatalog={toolsCatalog} caps={caps} mcp={mcp} plugins={plugins} />
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
