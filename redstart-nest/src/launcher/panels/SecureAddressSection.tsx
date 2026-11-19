import { useEffect, useState } from 'react'
import type { useTls } from '../hooks/useTls'
import type { TlsProvider, TlsSettingsView } from '../types'
import { TogglePill, btnCls } from '../components/ui'
import { tlsStatusLine, egressSentence, type TlsTone } from './tlsStatus'

// "Secure address (HTTPS)" in the Network panel (TLS plan C8). Product A:
// "My own name" (DuckDNS or deSEC) or "Off". "Automatic" arrives with the
// project's name service (plan step 8), and with it a consent screen; until
// then it does not appear at all.
//
// The token field NEVER shows a stored value (the Plugins-tab pattern):
// blank means "keep the stored one", and the placeholder says so.

const TONE: Record<TlsTone, string> = {
  ok: 'text-emerald-400',
  progress: 'text-sky-400',
  warn: 'text-amber-400',
  error: 'text-red-400',
  off: 'text-zinc-500',
}

const PROVIDERS: { id: TlsProvider; label: string; placeholder: string; help: string }[] = [
  { id: 'duckdns', label: 'DuckDNS', placeholder: 'yourname.duckdns.org', help: 'Free at duckdns.org. Sign in, add a name, and copy the token shown at the top of the page.' },
  { id: 'desec', label: 'deSEC', placeholder: 'yourname.dedyn.io', help: 'Free at desec.io. Register a dedyn.io name, then create a token under Token Management.' },
]

type Draft = { mode: 'off' | 'own'; provider: TlsProvider; name: string; token: string; requireHttps: boolean; acmeStaging: boolean }
const draftFrom = (s: TlsSettingsView): Draft => ({ mode: s.mode, provider: s.provider, name: s.name, token: '', requireHttps: s.requireHttps, acmeStaging: s.acmeStaging })

export function SecureAddressSection({ tls, networkMode }: { tls: ReturnType<typeof useTls>; networkMode: boolean }) {
  const { status, saving, save, checkNow, retry } = tls
  const [draft, setDraft] = useState<Draft | null>(null)
  const [dirty, setDirty] = useState(false)

  // Follow the daemon until the admin starts editing.
  useEffect(() => {
    if (status?.settings && !dirty) setDraft(draftFrom(status.settings))
  }, [status?.settings, dirty])

  if (!status?.settings || !draft) return null
  const stored = status.settings
  const edit = (patch: Partial<Draft>) => { setDraft({ ...draft, ...patch }); setDirty(true) }
  const provider = PROVIDERS.find((p) => p.id === draft.provider) ?? PROVIDERS[0]
  const line = tlsStatusLine(status, networkMode)
  const failed = status.state === 'lan-https-fallback' || status.caddy?.state === 'failed'
  // A provider change needs a new token; otherwise blank keeps the stored one.
  const tokenKept = stored.hasToken && draft.provider === stored.provider

  async function submit() {
    if (!draft) return
    const patch = draft.mode === 'off'
      ? { mode: 'off' as const, requireHttps: draft.requireHttps, acmeStaging: draft.acmeStaging }
      : {
          mode: 'own' as const, provider: draft.provider, name: draft.name,
          requireHttps: draft.requireHttps, acmeStaging: draft.acmeStaging,
          ...(draft.token ? { token: draft.token } : {}),
        }
    if (await save(patch)) setDirty(false)
  }

  return (
    <div className="mt-5 pt-4 border-t border-zinc-800">
      <h3 className="text-xs text-zinc-300 font-medium">Secure address (HTTPS)</h3>

      <div className="mt-3 space-y-3">
        <label className="flex items-start gap-2 cursor-pointer">
          <input type="radio" name="tls-mode" className="mt-0.5 accent-orange-500" checked={draft.mode === 'own'} onChange={() => edit({ mode: 'own' })} />
          <span className="text-xs text-zinc-300">My own name</span>
        </label>

        {draft.mode === 'own' && (
          <div className="ml-6 space-y-2">
            <div className="flex flex-wrap gap-2">
              <select
                value={draft.provider}
                onChange={(e) => edit({ provider: e.target.value as TlsProvider, token: '' })}
                className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200">
                {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              <input
                value={draft.name}
                onChange={(e) => edit({ name: e.target.value })}
                placeholder={provider.placeholder}
                spellCheck={false}
                className="flex-1 min-w-[12rem] bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs font-mono text-zinc-200" />
              <input
                type="password"
                value={draft.token}
                onChange={(e) => edit({ token: e.target.value })}
                placeholder={tokenKept ? 'Token stored (leave blank to keep it)' : `${provider.label} token`}
                autoComplete="off"
                className="flex-1 min-w-[12rem] bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs font-mono text-zinc-200" />
            </div>
            <p className="text-[11px] text-zinc-600">{provider.help}</p>
          </div>
        )}

        <label className="flex items-start gap-2 cursor-pointer">
          <input type="radio" name="tls-mode" className="mt-0.5 accent-orange-500" checked={draft.mode === 'off'} onChange={() => edit({ mode: 'off' })} />
          <span className="text-xs text-zinc-300">
            Off <span className="text-zinc-600">(devices on your network use plain HTTP, not encrypted)</span>
          </span>
        </label>

        {draft.mode === 'own' && (
          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
              <TogglePill checked={draft.requireHttps} onToggle={() => edit({ requireHttps: !draft.requireHttps })} />
              <span className="text-xs text-zinc-300">Require HTTPS</span>
            </label>
            <p className="text-[11px] text-zinc-600 -mt-1">
              Off: while HTTPS isn't working, devices still get chat over plain HTTP, labelled. On: they get nothing until it works.
            </p>
            <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
              <TogglePill checked={draft.acmeStaging} onToggle={() => edit({ acmeStaging: !draft.acmeStaging })} />
              <span className="text-xs text-zinc-300">Test certificates (Let's Encrypt staging)</span>
            </label>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button onClick={submit} disabled={saving || !dirty} className={`${btnCls.primary} text-white disabled:opacity-50 disabled:cursor-not-allowed`}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {dirty && (
            <button onClick={() => { setDirty(false); setDraft(draftFrom(stored)) }} className={btnCls.secondary}>Cancel</button>
          )}
          {stored.mode === 'own' && networkMode && <button onClick={checkNow} className={btnCls.subtle}>Check now</button>}
          {failed && <button onClick={retry} className={btnCls.secondary}>Try again</button>}
        </div>

        <p className={`text-xs ${TONE[line.tone]}`} role="status">{line.text}</p>

        {stored.mode === 'own' && status.warnings.length > 0 && (
          <ul className="space-y-1">
            {status.warnings.map((w) => <li key={w.kind} className="text-[11px] text-amber-400/90">{w.text}</li>)}
          </ul>
        )}

        {stored.mode === 'own' && status.address && !status.address.ok && (
          <p className="text-[11px] text-amber-400/90">Couldn't update the name: {status.address.detail}</p>
        )}

        {egressSentence(status) && <p className="text-[11px] text-zinc-600">{egressSentence(status)}</p>}
      </div>
    </div>
  )
}
