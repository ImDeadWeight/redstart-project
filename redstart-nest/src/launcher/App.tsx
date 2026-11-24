// =============================================================================
// Redstart Nest — renderer UI shell
// =============================================================================
// The launcher UI — a browser tab's worth of React, whether it is actually
// running in a browser or inside Electron's window: both are
// plain HTTP clients of the admin listener now, gated by AdminGate.tsx
// before this ever renders). All calls go through the RedstartAPI
// implementation installed by AdminGate (see api/redstart.ts).
//
// App itself is just the shell: the title bar (status, profile, chat address,
// Start/Stop), the section list, and wiring the domain hooks
// (src/launcher/hooks/) into the six sections (src/launcher/sections/), which
// in turn reuse the panels and tabs in src/launcher/panels/ and tabs/.
// Each hook owns one slice of state and its API calls; each component owns
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
import { useTls } from './hooks/useTls'
import { useUpdateSettings } from './hooks/useUpdateSettings'
import { useShutdown } from './hooks/useShutdown'
import { useWindowControlsOverlay } from './hooks/useWindowControlsOverlay'
import { TopBar, StatusPill, ConfirmDialog, Chip, btnCls } from './components/ui'
import { useExternalMcp } from './hooks/useExternalMcp'
import { useToolsCatalog } from './hooks/useToolsCatalog'
import { useCapabilities } from './hooks/useCapabilities'
import { usePlugins } from './hooks/usePlugins'
import { useHardwareAndBinary } from './hooks/useHardwareAndBinary'
import { useModelCatalog } from './hooks/useModelCatalog'
import { useProfiles } from './hooks/useProfiles'
import { useServerLifecycle } from './hooks/useServerLifecycle'
import { Sidebar, type SectionId } from './sections/Sidebar'
import { OverviewSection } from './sections/OverviewSection'
import { ModelSection } from './sections/ModelSection'
import { ToolsSection } from './sections/ToolsSection'
import { ImagesSection } from './sections/ImagesSection'
import { NetworkSection } from './sections/NetworkSection'
import { ActivitySection } from './sections/ActivitySection'
import { TerminalSection } from './sections/TerminalSection'
import { SystemSection } from './sections/SystemSection'
import { addressesFor, localAddress, CopyButton } from './sections/connect'

export default function App() {
  const [config, setConfig] = useState<LlamaConfig>(DEFAULT_CONFIG)
  const [generatedCommand, setGeneratedCommand] = useState('')
  const [networkMode, setNetworkMode] = useState(true)
  const [localIp, setLocalIp] = useState('')
  const [section, setSection] = useState<SectionId>('overview')

  const { statusMsg, show: showStatus, clear: clearStatus } = useStatusMessage()

  // Domain hooks — each owns one slice of state and its IPC calls.
  const auth = useAuthSetup(showStatus)
  const controlPlaneExposure = useControlPlaneExposure(showStatus)
  const startup = useStartupSettings(showStatus)
  const tls = useTls(showStatus)
  const updates = useUpdateSettings(showStatus)
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
    // Launch output is the first place to look if a start goes wrong.
    onLaunchStarted: () => setSection('terminal'),
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

  const { serverState, health, imageProgress } = server
  const paused = health === 'suspended'
  const imageStep = imageProgress?.step && imageProgress.steps
    ? `step ${imageProgress.step}/${imageProgress.steps}${(imageProgress.count ?? 1) > 1 ? `, image ${imageProgress.image ?? 1} of ${imageProgress.count}` : ''}`
    : imageProgress?.phase === 'decoding' || imageProgress?.phase === 'saving' ? 'finishing' : 'loading'
  const isRunning = serverState === 'running'
  const isStopping = serverState === 'stopping'
  const isStarting = serverState === 'starting'
  const modelName = config.modelPath ? (config.modelPath.split(/[\\/]/).pop() || config.modelPath) : ''
  const addresses = addressesFor(tls, localIp, config.port, networkMode)
  const chatAddress = addresses[0]?.url ?? localAddress(config.port)
  const { profiles, selectedProfile, selectProfile, unsaved, notInProfile } = profilesHook
  // A switch replaces the working settings; ask first when they exist nowhere else.
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null)

  function requestSwitchProfile(name: string) {
    if (!name || name === selectedProfile) return
    if (unsaved || notInProfile) setPendingSwitch(name)
    else switchProfile(name)
  }

  async function switchProfile(name: string) {
    setPendingSwitch(null)
    if (!name) return
    await selectProfile(name)
    showStatus(isRunning
      ? `Loaded "${name}". The model keeps its current settings until you stop and start it again.`
      : `Loaded "${name}". It takes effect when you press Start.`, 6000)
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-950 text-sm text-zinc-100">

      {/* Also the window's title bar in the desktop shell — see TopBar in
          components/ui.tsx, which the sign-in screen shares so the bar does not
          change shape at the moment someone signs in. */}
      <TopBar
        overlay={overlay}
        right={<>
          <div className="hidden items-center gap-2 xl:flex">
            <span className="text-[13px] text-zinc-400">Chat address</span>
            <code className="max-w-[18rem] truncate rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1 text-[12.5px] text-zinc-200">{chatAddress}</code>
            <CopyButton text={chatAddress} tip="Copy the chat address" />
          </div>
          {serverState === 'stopped' && (
            <button type="button" onClick={server.launchServer} disabled={!config.modelPath}
              data-tip={config.modelPath ? 'Load the model so people can chat' : 'Choose a model first'} data-tip-end=""
              className={`${btnCls.primary} px-5`}>Start</button>
          )}
          {isStarting && <button type="button" disabled className={`${btnCls.secondary} px-4`}>Starting…</button>}
          {isRunning && (
            <button type="button" onClick={server.requestStopServer} data-tip="Stop the model for everyone" data-tip-end=""
              className={`${btnCls.secondary} px-5 font-semibold`}>Stop</button>
          )}
          {isStopping && <button type="button" disabled className={`${btnCls.secondary} px-4`}>Stopping…</button>}
        </>}
      >
        <StatusPill
          tone={paused ? 'pending' : isRunning ? 'on' : isStopping || isStarting ? 'pending' : 'off'}
          label={paused ? 'Paused' : isRunning ? (health === 'no slot available' ? 'Busy' : health === 'unreachable' ? 'Not responding' : 'Running') : isStopping ? 'Stopping…' : isStarting ? 'Starting…' : 'Stopped'}
          detail={paused ? `making an image, ${imageStep}` : isRunning || isStarting ? modelName : undefined}
          tip={paused ? `${modelName} is paused while an image is made; it reloads by itself, and chats wait for it` : isRunning ? `Serving ${modelName}${health === 'no slot available' ? ', busy answering' : ''}` : config.modelPath ? 'Press Start to load the model' : 'No model chosen yet'}
        />
        <label className="hidden items-center gap-2 text-[13px] text-zinc-400 lg:flex">
          Profile
          {profiles.length > 0 ? (
            <select value={selectedProfile} onChange={e => requestSwitchProfile(e.target.value)}
              className="min-w-[10rem] max-w-[14rem] rounded-lg border border-zinc-800 bg-zinc-950/60 px-2.5 py-1 text-[13px] text-zinc-100 hover:border-zinc-600 focus:border-orange-500 focus:outline-none">
              <option value="">Choose a profile…</option>
              {profiles.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          ) : (
            <button type="button" onClick={() => setSection('system')} data-tip="Save your settings as a profile on the System page"
              className="rounded-lg border border-dashed border-zinc-700 px-2.5 py-1 text-[13px] text-zinc-400 hover:border-zinc-500">No profiles yet</button>
          )}
        </label>
        {/* Settings are kept across restarts either way; these say they are not
            in a profile, which is the copy that switching profiles leaves alone. */}
        {(unsaved || notInProfile) && (
          <button type="button" onClick={() => setSection('system')}
            data-tip={unsaved
              ? `Your settings differ from the saved "${selectedProfile}". They are kept when Nest closes, but switching profiles replaces them. Save them on the System page.`
              : 'Your settings are kept when Nest closes, but no profile holds them. Save them as a profile on the System page.'}
            className="hidden lg:inline-flex">
            <Chip tone="warn">{unsaved ? 'Unsaved changes' : 'Not saved to a profile'}</Chip>
          </button>
        )}
      </TopBar>

      {statusMsg && (
        <div role="status" className="flex shrink-0 items-center gap-3 border-b border-zinc-800 bg-[#14211a] px-5 py-2 text-sm text-green-100">
          <span className="min-w-0 flex-1">{statusMsg}</span>
          <button type="button" onClick={clearStatus} aria-label="Dismiss" data-tip="Dismiss" data-tip-end=""
            className="rounded-md px-2 text-lg leading-none text-green-200/70 hover:text-green-50">×</button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <Sidebar
          active={section}
          onSelect={setSection}
          badges={{
            overview: updates.update?.state === 'ready' ? 'warn' : undefined,
            terminal: isRunning ? 'live' : undefined,
          }}
        />

        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className={`mx-auto max-w-5xl px-4 pt-6 sm:px-8 sm:pt-8 ${section === 'terminal' ? 'flex h-full flex-col pb-6' : 'pb-12'}`}>
            {section === 'overview' && (
              <OverviewSection
                config={config}
                modelChosen={!!config.modelPath}
                binaryFound={!!hw.binaryPath}
                networkMode={networkMode}
                authRequired={auth.authRequired}
                tls={tls}
                addresses={addresses}
                updates={updates}
                onNavigate={setSection}
              />
            )}
            {section === 'model' && (
              <ModelSection
                config={config}
                setConfig={setConfig}
                networkMode={networkMode}
                hw={hw}
                catalog={modelCatalog}
                isRunning={isRunning}
                generatedCommand={generatedCommand}
                onGenerateCommand={generateCommand}
              />
            )}
            {section === 'images' && (
              <ImagesSection config={config} documentsConfigured={!!caps.capabilityConfig?.documents.outputDir} onNavigate={setSection}
                hardware={hw.hardware} onNeedHardware={hw.ensureHardware} diskFreeBytes={modelCatalog.disk.freeBytes} modelsDir={modelCatalog.modelsDir} />
            )}
            {section === 'tools' && (
              <ToolsSection config={config} toolsCatalog={toolsCatalog} caps={caps} mcp={mcp} plugins={plugins} onOpenImages={() => setSection('images')} />
            )}
            {section === 'network' && (
              <NetworkSection
                networkMode={networkMode}
                onSetNetworkMode={setNetworkMode}
                localIp={localIp}
                port={config.port}
                auth={auth}
                controlPlaneExposure={controlPlaneExposure}
                tls={tls}
              />
            )}
            {section === 'activity' && <ActivitySection />}
            {section === 'terminal' && <TerminalSection server={server} />}
            {section === 'system' && (
              <SystemSection profilesHook={profilesHook} hw={hw} startup={startup} shutdown={shutdown} />
            )}
          </div>
        </main>
      </div>

      <ConfirmDialog
        open={isRunning && server.confirmStop}
        title="Stop the model for everyone?"
        confirmLabel="Stop the model"
        onConfirm={server.confirmStopServer}
        onCancel={() => server.setConfirmStop(false)}>
        <p>Anyone chatting loses the reply being written now, and nobody can chat until the model starts again.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={pendingSwitch !== null}
        title={`Switch to "${pendingSwitch}"?`}
        confirmLabel="Switch and discard"
        onConfirm={() => pendingSwitch && switchProfile(pendingSwitch)}
        onCancel={() => setPendingSwitch(null)}>
        <p>{unsaved
          ? `Your changes to "${selectedProfile}" are not saved to it. Switching replaces them with "${pendingSwitch}".`
          : `Your current settings are not saved to any profile. Switching replaces them with "${pendingSwitch}".`}</p>
        <p>To keep them, cancel and save them on the System page first.</p>
      </ConfirmDialog>
    </div>
  )
}
