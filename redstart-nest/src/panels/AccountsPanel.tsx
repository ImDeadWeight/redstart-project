import type { useAuthSetup } from '../hooks/useAuthSetup'
import type { useControlPlaneExposure } from '../hooks/useControlPlaneExposure'
import { SectionTitle, TogglePill, ControlPlaneNotice } from '../components/ui'

export function AccountsPanel({ auth, controlPlaneExposure }: {
  auth: ReturnType<typeof useAuthSetup>
  controlPlaneExposure: ReturnType<typeof useControlPlaneExposure>
}) {
  const { authRequired, toggleAuthRequired } = auth
  const { controlPlane, toggleExposure } = controlPlaneExposure

  return (
    <section>
      <SectionTitle>Accounts</SectionTitle>
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <TogglePill checked={authRequired} onToggle={toggleAuthRequired} />
        <span className="text-xs text-zinc-300">{authRequired ? 'Require login' : 'Login not required'}</span>
      </label>
      <p className="mt-1 text-xs text-zinc-600">Applies to every client on the network. This launcher signs in the same way (Settings → sign-in screen); it is not exempt.</p>

      {/* The control plane's OWN exposure — a separate switch from the data
          plane's login requirement above. See headless-admin-plane-plan.md
          decision 4: availability is always on, this only decides whether
          it's reachable off this machine. */}
      <label className="flex items-center gap-2 cursor-pointer select-none mt-4">
        <TogglePill checked={!!controlPlane?.exposed} onToggle={toggleExposure} />
        <span className="text-xs text-zinc-300">
          {controlPlane?.exposed ? 'Admin panel reachable on the network' : 'Admin panel: this machine only'}
        </span>
      </label>
      <p className="mt-1 text-xs text-zinc-600">
        Lets another device on your network sign in here — at port {controlPlane?.port ?? 19083}, same
        credentials as above. See the Network tab for the exact address to use.
      </p>
      <ControlPlaneNotice state={controlPlane} />
    </section>
  )
}
