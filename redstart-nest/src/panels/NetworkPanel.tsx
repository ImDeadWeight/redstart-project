import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { useAuthSetup } from '../hooks/useAuthSetup'
import type { useControlPlaneExposure } from '../hooks/useControlPlaneExposure'
import type { useStartupSettings } from '../hooks/useStartupSettings'
import type { useShutdown } from '../hooks/useShutdown'
import { SectionTitle, TogglePill, btnCls, ControlPlaneNotice } from '../components/ui'
import { buildAddresses } from './addresses'

// Lives in the Configuration tab rather than the sidebar: it sits next to the
// Host/Port fields it depends on, and the QR code plus address list needs more
// width than the 256px sidebar allowed.

// One row per reachable URL. The IP row leads because it is the only address
// that resolves on every client; the sslip row is a hostname convenience that
// costs an internet DNS lookup (see addresses.ts for which and why).
function AddressRow({ url, label, note, primary }: {
  url: string
  label: string
  note: string
  primary?: boolean
}) {
  const [copied, setCopied] = useState(false)

  const copy = () => {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    }).catch(() => {})
  }

  return (
    <div className="flex items-baseline gap-3">
      <span className="text-[10px] uppercase tracking-wider text-zinc-600 w-16 shrink-0">{label}</span>
      <div className="min-w-0 flex-1">
        <div className={`font-mono truncate ${primary ? 'text-sm text-orange-400 font-semibold' : 'text-xs text-zinc-300'}`}>
          {url}
        </div>
        <p className="text-[10px] text-zinc-600 mt-0.5">{note}</p>
      </div>
      <button onClick={copy} className={`${btnCls.subtle} shrink-0`} title="Copy to clipboard">
        {copied ? 'copied' : 'copy'}
      </button>
    </div>
  )
}

// Deliberately not the same warning as the DATA plane's own network mode.
// Two planes, two risks, and they are not the same size: the gateway serves
// inference to devices on the LAN, which is what people install this for,
// while the control plane spawns processes and edits accounts. A warning
// that fires on the ordinary case is a warning people learn to dismiss.

export function NetworkPanel({
  networkMode, onToggleNetworkMode, localIp, port,
  auth, controlPlaneExposure, startup, shutdown,
}: {
  networkMode: boolean
  onToggleNetworkMode: () => void
  localIp: string
  port: number
  auth: ReturnType<typeof useAuthSetup>
  controlPlaneExposure: ReturnType<typeof useControlPlaneExposure>
  startup: ReturnType<typeof useStartupSettings>
  shutdown: ReturnType<typeof useShutdown>
}) {
  const addresses = buildAddresses(localIp, port)
  const primary = addresses[0]
  const [qr, setQr] = useState('')
  const { authRequired, toggleAuthRequired } = auth
  const { controlPlane, toggleExposure } = controlPlaneExposure
  const { startup: startupState, toggleStartup } = startup
  const { confirmShutdown, setConfirmShutdown, shuttingDown, requestShutdown, confirmShutdownNow } = shutdown

  // The QR encodes the direct-IP URL — pointing a phone camera at it needs no
  // name resolution at all, which is the only approach that works on every
  // client. Regenerated whenever the IP or port moves.
  useEffect(() => {
    if (!networkMode || !primary) {
      setQr('')
      return
    }
    let stale = false
    QRCode.toDataURL(primary.url, {
      width: 240,
      margin: 1,
      color: { dark: '#18181b', light: '#ffffff' },
    })
      .then(url => { if (!stale) setQr(url) })
      .catch(() => { if (!stale) setQr('') })
    return () => { stale = true }
  }, [networkMode, primary?.url])

  return (
    <section className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">
      <SectionTitle className="mb-4">Network</SectionTitle>

      <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
        <TogglePill checked={networkMode} onToggle={onToggleNetworkMode} />
        <span className="text-xs text-zinc-300">{networkMode ? 'Local network (HTTP)' : 'Localhost only'}</span>
      </label>

      {networkMode && addresses.length > 0 && (
        <div className="mt-4 flex gap-4">
          {qr && (
            <div className="shrink-0">
              <img src={qr} alt={`QR code for ${primary.url}`} className="w-[104px] h-[104px] rounded bg-white" />
              <p className="text-[9px] text-zinc-600 text-center mt-1">scan to open</p>
            </div>
          )}
          <div className="min-w-0 flex-1 space-y-2.5">
            {addresses.map(({ key, ...a }, i) => (
              <AddressRow key={key} {...a} primary={i === 0} />
            ))}
          </div>
        </div>
      )}

      {/* Access control — merged in from the old sidebar's Accounts panel.
          Belongs here, not off on its own: both toggles govern who can reach
          this box, which is exactly what the addresses above describe. */}
      <div className="mt-5 pt-4 border-t border-zinc-800 space-y-4">
        <div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <TogglePill checked={authRequired} onToggle={toggleAuthRequired} />
            <span className="text-xs text-zinc-300">{authRequired ? 'Require login' : 'Login not required'}</span>
          </label>
          <p className="mt-1 text-xs text-zinc-600">
            Applies to every client on the network. This launcher signs in the same way
            (Settings → sign-in screen); it is not exempt.
          </p>
        </div>

        {/* The control plane's OWN exposure — a separate switch from the data
            plane's login requirement above. See headless-admin-plane-plan.md
            decision 4: availability is always on, this only decides whether
            it's reachable off this machine. Also settable per-profile via
            LlamaConfig.exposeControlPlane (docs/notes/admingate-access-ui-plan.md
            §3) — this toggle is still the source of truth; selecting a
            profile that saved a different value changes it the same way this
            click does. */}
        <div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <TogglePill checked={!!controlPlane?.exposed} onToggle={toggleExposure} />
            <span className="text-xs text-zinc-300">
              {controlPlane?.exposed ? 'Admin panel reachable on the network' : 'Admin panel: this machine only'}
            </span>
          </label>
          <p className="mt-1 text-xs text-zinc-600">
            Lets another device sign in here with the credentials above, at port{' '}
            {controlPlane?.port ?? 19083} on the same address(es) listed above. Saved with
            whichever profile is active when you save it, so switching profiles can restore it.
          </p>
          <ControlPlaneNotice state={controlPlane} />
        </div>

        {/* Phase 7 §7.4 — the daemon now outlives the window, so "start at
            login" is meaningful for the first time: it registers a
            windowless (tray-only) login item with Windows rather than only
            remembering a preference nothing acts on. Reconciled against the
            OS's own record on every load (useStartupSettings), so this
            reflects reality even if it was changed from Task Manager's
            Startup tab. */}
        <div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <TogglePill checked={!!startupState?.startAtLogin} onToggle={toggleStartup} />
            <span className="text-xs text-zinc-300">
              {startupState?.startAtLogin ? 'Start Redstart at login' : 'Do not start at login'}
            </span>
          </label>
          <p className="mt-1 text-xs text-zinc-600">
            Starts in the tray only, with no window and no model loaded — open it from the tray
            icon or the Start menu when you want it.
          </p>
        </div>

        {/* Phase 7 §7.5 — the ONE deliberate way left to stop the daemon,
            now that closing the window no longer does (§7.2). Two-step
            confirm: this stops the model AND takes the box off the network
            for every other client, and a remote admin cannot walk over and
            restart it. */}
        <div>
          {!confirmShutdown && (
            <button
              onClick={requestShutdown}
              disabled={shuttingDown}
              className={`${btnCls.subtle} disabled:opacity-50 disabled:cursor-not-allowed`}>
              {shuttingDown ? 'Shutting down…' : 'Shut down Redstart'}
            </button>
          )}
          {confirmShutdown && (
            <div className="flex items-center gap-3 rounded-lg border border-amber-800 bg-zinc-900 px-4 py-2">
              <span className="flex-1 text-xs text-amber-400">
                Shut down now? This stops the model and takes this box off the network for
                every client — including this one. Nobody can restart it remotely.
              </span>
              <button
                onClick={confirmShutdownNow}
                className="px-3 py-1.5 bg-red-700 hover:bg-red-600 text-white rounded text-xs font-semibold transition-colors shrink-0">
                Shut Down Now
              </button>
              <button
                onClick={() => setConfirmShutdown(false)}
                className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-white rounded text-xs transition-colors shrink-0">
                Cancel
              </button>
            </div>
          )}
          <p className="mt-1 text-xs text-zinc-600">
            Stops Redstart entirely — the model, the tray, and the admin panel on every device.
            Start it again from the Start menu or the desktop shortcut.
          </p>
        </div>
      </div>
    </section>
  )
}
