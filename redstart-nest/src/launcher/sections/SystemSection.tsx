// =============================================================================
// System — profiles, the model engine, starting with the computer, shutting down.
// =============================================================================

import type { useProfiles } from '../hooks/useProfiles'
import type { useHardwareAndBinary } from '../hooks/useHardwareAndBinary'
import type { useStartupSettings } from '../hooks/useStartupSettings'
import type { useShutdown } from '../hooks/useShutdown'
import { Card, ConfirmDialog, PageHeader, SectionTitle, TogglePill, btnCls } from '../components/ui'
import { FolderPicker } from '../components/FolderPicker'
import { ProfilesPanel } from '../panels/ProfilesPanel'

export function SystemSection({ profilesHook, hw, startup, shutdown }: {
  profilesHook: ReturnType<typeof useProfiles>
  hw: ReturnType<typeof useHardwareAndBinary>
  startup: ReturnType<typeof useStartupSettings>
  shutdown: ReturnType<typeof useShutdown>
}) {
  const { binaryPath, applyBinaryPath, clearBinaryOverride } = hw
  const { startup: startupState, toggleStartup } = startup
  const { confirmShutdown, setConfirmShutdown, shuttingDown, requestShutdown, confirmShutdownNow } = shutdown

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="System">Profiles, the model engine, starting with the computer, and shutting down.</PageHeader>

      <ProfilesPanel profilesHook={profilesHook} hardware={hw.hardware} />

      <Card>
        <div className="divide-y divide-zinc-800">
          <div className="flex flex-wrap items-center gap-3 pb-4">
            <div className="min-w-[16rem] flex-1">
              <SectionTitle className="mb-0.5">Model engine (llama-server)</SectionTitle>
              {binaryPath
                ? <code className="block break-all text-[13px] text-zinc-400">{binaryPath}</code>
                : <p className="text-[13px] text-red-400">Not found. Choose the llama-server program to run models.</p>}
            </div>
            <FolderPicker mode="file" extensions={['exe']} extensionLabel="Executable" title="Choose llama-server"
              startPath={binaryPath ?? undefined} onPick={applyBinaryPath}
              className={binaryPath ? btnCls.secondary : btnCls.primary}>
              {binaryPath ? 'Use a different one…' : 'Choose llama-server…'}
            </FolderPicker>
            {binaryPath && (
              <button type="button" onClick={clearBinaryOverride} className={btnCls.subtle}
                data-tip="Forget the chosen file and look for llama-server automatically" data-tip-end="">
                Find automatically
              </button>
            )}
          </div>

          {/* Hidden entirely, not disabled, when the daemon has no login item
              to offer (a headless install): a greyed-out switch invites
              someone to work out why it will not move. */}
          {startupState?.supported && (
            <div className="flex items-start gap-4 pt-4">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-zinc-100">Start Redstart when I sign in</div>
                <div className="mt-0.5 text-[13px] text-zinc-400">
                  Starts in the tray only, with no window and no model loaded. Open it from the tray icon or the Start menu.
                </div>
              </div>
              <TogglePill checked={!!startupState.startAtLogin} onToggle={toggleStartup} label="Start Redstart when I sign in" />
            </div>
          )}
        </div>
      </Card>

      {/* The one deliberate way to stop the daemon, now that closing the
          window does not. Behind a confirm: it takes the box off the network
          for every client, and a remote admin cannot walk over and restart it. */}
      <Card tone="danger" className="flex flex-wrap items-center gap-4">
        <div className="min-w-[16rem] flex-1">
          <SectionTitle className="mb-0.5">Shut down Redstart</SectionTitle>
          <p className="text-sm text-zinc-400">
            Stops the model, the tray and this panel, for every device. Closing the window doesn&rsquo;t do this.
          </p>
        </div>
        <button type="button" onClick={requestShutdown} disabled={shuttingDown} className={btnCls.dangerOutline}>
          {shuttingDown ? 'Shutting down…' : 'Shut down…'}
        </button>
      </Card>

      <ConfirmDialog
        open={confirmShutdown}
        title="Shut down Redstart?"
        confirmLabel="Shut down"
        onConfirm={confirmShutdownNow}
        onCancel={() => setConfirmShutdown(false)}>
        <p>This stops the model and takes this computer off the network for every device, this one included. Nobody can restart it remotely.</p>
        {/* A desktop install's login item brings Redstart back at the next
            sign-in. With no login item (a service install, most likely)
            nothing will: a supervisor leaves a clean exit stopped. */}
        {startupState?.supported === false
          ? <p>Nothing will start it again on its own, not a reboot and not the service manager. Someone will need access to this computer.</p>
          : <p>Start it again from the Start menu or the desktop shortcut.</p>}
      </ConfirmDialog>
    </div>
  )
}
