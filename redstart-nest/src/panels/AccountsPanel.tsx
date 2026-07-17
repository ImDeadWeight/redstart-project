import type { useAuthSetup } from '../hooks/useAuthSetup'
import { SectionTitle, TogglePill, btnCls, inputCls } from '../components/ui'

export function AccountsPanel({ auth }: { auth: ReturnType<typeof useAuthSetup> }) {
  const {
    authRequired, hasOwnerAccount, confirmEnableAuthNoAdmin, setConfirmEnableAuthNoAdmin,
    bootstrapUsername, setBootstrapUsername, bootstrapPassword, setBootstrapPassword,
    revealedApiKey, setRevealedApiKey, applyAuthRequired, toggleAuthRequired, createFirstAdmin,
  } = auth

  return (
    <section>
      <SectionTitle>Accounts</SectionTitle>
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <TogglePill checked={authRequired} onToggle={toggleAuthRequired} />
        <span className="text-xs text-zinc-300">{authRequired ? 'Require login' : 'Login not required'}</span>
      </label>
      <p className="mt-1 text-xs text-zinc-600">Requests from this PC are always exempt — only LAN/remote clients are gated.</p>

      {confirmEnableAuthNoAdmin && (
        <div className="mt-2 rounded-lg border border-amber-800 bg-zinc-900 px-3 py-2 space-y-2">
          <p className="text-xs text-amber-400">No owner account exists yet — LAN/remote users won't be able to log in until you create one below. Enable anyway?</p>
          <div className="flex gap-2">
            <button onClick={() => applyAuthRequired(true)} className={`flex-1 ${btnCls.danger}`}>
              Enable Anyway
            </button>
            <button onClick={() => setConfirmEnableAuthNoAdmin(false)}
              className="flex-1 px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-white rounded text-xs transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {!hasOwnerAccount && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-zinc-500">Create the owner account — the one sys-admin account that can create/remove Admin accounts. Admins then manage regular Users from the chat UI's Accounts tab.</p>
          <input
            value={bootstrapUsername}
            onChange={e => setBootstrapUsername(e.target.value)}
            placeholder="Owner username"
            className={inputCls.xs}
          />
          <input
            type="password"
            value={bootstrapPassword}
            onChange={e => setBootstrapPassword(e.target.value)}
            placeholder="Owner password"
            className={inputCls.xs}
          />
          <button onClick={createFirstAdmin}
            disabled={!bootstrapUsername.trim() || !bootstrapPassword}
            className="w-full px-3 py-1.5 bg-orange-500 hover:bg-orange-400 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed text-white rounded text-xs font-semibold transition-colors">
            Create Owner Account
          </button>
        </div>
      )}

      {revealedApiKey && (
        <div className="mt-3 rounded-lg border border-orange-800 bg-zinc-900 px-3 py-2 space-y-1">
          <p className="text-xs text-orange-400">API key (also works as a Kilo Code / Continue Bearer token) — shown once, copy it now:</p>
          <div className="flex gap-1">
            <code className="flex-1 text-xs text-zinc-200 bg-zinc-800 rounded px-2 py-1 break-all">{revealedApiKey}</code>
            <button onClick={() => navigator.clipboard.writeText(revealedApiKey)}
              className="px-2 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors">Copy</button>
          </div>
          <button onClick={() => setRevealedApiKey(null)} className={btnCls.link}>Dismiss</button>
        </div>
      )}
    </section>
  )
}
