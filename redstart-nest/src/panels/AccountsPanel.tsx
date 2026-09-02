import type { useAuthSetup } from '../hooks/useAuthSetup'
import { SectionTitle, TogglePill } from '../components/ui'

export function AccountsPanel({ auth }: { auth: ReturnType<typeof useAuthSetup> }) {
  const { authRequired, toggleAuthRequired } = auth

  return (
    <section>
      <SectionTitle>Accounts</SectionTitle>
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <TogglePill checked={authRequired} onToggle={toggleAuthRequired} />
        <span className="text-xs text-zinc-300">{authRequired ? 'Require login' : 'Login not required'}</span>
      </label>
      <p className="mt-1 text-xs text-zinc-600">Applies to every client on the network. This launcher signs in the same way (Settings → sign-in screen); it is not exempt.</p>
    </section>
  )
}
