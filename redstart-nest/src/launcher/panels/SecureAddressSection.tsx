import { useEffect, useState } from 'react'
import type { useTls } from '../hooks/useTls'
import type { TlsMode, TlsProvider, TlsSettingsView } from '../types'
import { TogglePill, btnCls } from '../components/ui'
import { tlsStatusLine, egressSentence, type TlsTone } from './tlsStatus'

// "Secure address (HTTPS)" in the Network panel (TLS plan C8).
//
//   Automatic     a name from Redstart's name service (Product B, step 8)
//   My own name   DuckDNS or deSEC, the admin's account and token
//   Off           plain HTTP on the LAN
//
// CONSENT, NOT A PRESELECTED RADIO (review R8). The first time network mode
// is on and HTTPS has never been chosen, the section is one question instead:
// what Automatic sends, and three answers. Nothing is registered until the
// admin picks Automatic, and even then only when HTTPS first starts with
// network mode on (the daemon's rule, not this screen's). Redstart is
// local-first: sending a LAN address to a service we run is a fair trade,
// but it is the admin's to make.
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

const AUTOMATIC_SENDS = "This computer's LAN address (when it changes) to Redstart's name service, a weekly \"still here\", and a record that proves the name for its certificate about every 60 days. Nothing about your conversations, which never leave your network."

type Draft = { mode: TlsMode; provider: TlsProvider; name: string; token: string; requireHttps: boolean; acmeStaging: boolean }
const draftFrom = (s: TlsSettingsView): Draft => ({ mode: s.mode, provider: s.provider, name: s.name, token: '', requireHttps: s.requireHttps, acmeStaging: s.acmeStaging })

function ConsentCard({ onChoose, saving }: { onChoose: (choice: 'automatic' | 'own' | 'later') => void; saving: boolean }) {
  return (
    <div className="mt-3 rounded-xl border border-zinc-700 bg-zinc-950/60 p-4" role="group" aria-label="Choose how devices connect securely">
      <p className="text-sm text-zinc-100 font-medium">Give this computer a secure address?</p>
      <p className="mt-2 text-sm text-zinc-400">
        Phones and laptops on your network can connect over HTTPS, with a padlock and no warnings. The simplest way is an
        automatic name like <span className="font-mono text-zinc-300">k7f3q2.nest.redstartdevelopment.com</span>, from Redstart's name service.
      </p>
      <p className="mt-2 text-[13px] text-zinc-500">
        <span className="text-zinc-400">What Automatic sends:</span> {AUTOMATIC_SENDS}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button disabled={saving} onClick={() => onChoose('automatic')} className={btnCls.primary}>Use an automatic name</button>
        <button disabled={saving} onClick={() => onChoose('own')} className={`${btnCls.secondary} disabled:opacity-50`}>I'll use my own name</button>
        <button disabled={saving} onClick={() => onChoose('later')} className={`${btnCls.subtle} disabled:opacity-50`}>Not now</button>
      </div>
      <p className="mt-2 text-[13px] text-zinc-500">You can change this any time below. "Not now" keeps plain HTTP and sends nothing.</p>
    </div>
  )
}

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
  const askConsent = networkMode && stored.mode === 'off' && !stored.consentAsked

  async function choose(choice: 'automatic' | 'own' | 'later') {
    if (choice === 'automatic') { if (await save({ mode: 'redstart' })) setDirty(false); return }
    if (await save({ consentAsked: true }) && choice === 'own') { setDraft({ ...draftFrom(stored), mode: 'own' }); setDirty(true) }
  }

  async function submit() {
    if (!draft) return
    const common = { requireHttps: draft.requireHttps, acmeStaging: draft.acmeStaging }
    const patch = draft.mode === 'off'
      ? { mode: 'off' as const, ...common }
      : draft.mode === 'redstart'
        ? { mode: 'redstart' as const, ...common }
        : { mode: 'own' as const, provider: draft.provider, name: draft.name, ...common, ...(draft.token ? { token: draft.token } : {}) }
    if (await save(patch)) setDirty(false)
  }

  const radio = (mode: TlsMode, label: React.ReactNode) => (
    <label className="flex items-start gap-2 cursor-pointer">
      <input type="radio" name="tls-mode" className="mt-0.5 accent-orange-500" checked={draft.mode === mode} onChange={() => edit({ mode })} />
      <span className="text-sm text-zinc-200">{label}</span>
    </label>
  )

  return (
    <div>
      <h2 className="text-base font-semibold text-zinc-100">Secure address (HTTPS)</h2>

      {askConsent ? <ConsentCard onChoose={choose} saving={saving} /> : (
        <div className="mt-3 space-y-3">
          {radio('redstart', <>Automatic {stored.automatic
            ? <span className="font-mono text-zinc-400">{stored.automatic.hostname}</span>
            : <span className="text-zinc-500">(a name is created when HTTPS starts)</span>}</>)}
          {draft.mode === 'redstart' && <p className="ml-6 text-[13px] text-zinc-500">{AUTOMATIC_SENDS}</p>}

          {radio('own', 'My own name')}
          {draft.mode === 'own' && (
            <div className="ml-6 space-y-2">
              <div className="flex flex-wrap gap-2">
                <select
                  value={draft.provider}
                  onChange={(e) => edit({ provider: e.target.value as TlsProvider, token: '' })}
                  className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200">
                  {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
                <input
                  value={draft.name}
                  onChange={(e) => edit({ name: e.target.value })}
                  placeholder={provider.placeholder}
                  spellCheck={false}
                  className="flex-1 min-w-[12rem] bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm font-mono text-zinc-200" />
                <input
                  type="password"
                  value={draft.token}
                  onChange={(e) => edit({ token: e.target.value })}
                  placeholder={tokenKept ? 'Token stored (leave blank to keep it)' : `${provider.label} token`}
                  autoComplete="off"
                  className="flex-1 min-w-[12rem] bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm font-mono text-zinc-200" />
              </div>
              <p className="text-[13px] text-zinc-500">{provider.help}</p>
            </div>
          )}

          {radio('off', <>Off <span className="text-zinc-500">(devices on your network use plain HTTP, not encrypted)</span></>)}

          {draft.mode !== 'off' && (
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
                <TogglePill checked={draft.requireHttps} onToggle={() => edit({ requireHttps: !draft.requireHttps })} />
                <span className="text-sm text-zinc-200">Require HTTPS</span>
              </label>
              <p className="text-[13px] text-zinc-500 -mt-1">
                Off: while HTTPS isn't working, devices still get chat over plain HTTP, labelled. On: they get nothing until it works.
              </p>
              <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
                <TogglePill checked={draft.acmeStaging} onToggle={() => edit({ acmeStaging: !draft.acmeStaging })} />
                <span className="text-sm text-zinc-200">Test certificates (Let's Encrypt staging)</span>
              </label>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button onClick={submit} disabled={saving || !dirty} className={btnCls.primary}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            {dirty && (
              <button onClick={() => { setDirty(false); setDraft(draftFrom(stored)) }} className={btnCls.secondary}>Cancel</button>
            )}
            {stored.mode !== 'off' && networkMode && <button onClick={checkNow} className={btnCls.subtle}>Check now</button>}
            {failed && <button onClick={retry} className={btnCls.secondary}>Try again</button>}
          </div>
          {draft.mode === 'off' && stored.mode === 'redstart' && dirty && (
            <p className="text-[13px] text-amber-400/90">Turning HTTPS off gives the automatic name back. Turning Automatic on again later gets a new one.</p>
          )}
        </div>
      )}

      {!askConsent && <p className={`mt-3 text-sm ${TONE[line.tone]}`} role="status">{line.text}</p>}

      {!askConsent && stored.mode !== 'off' && status.warnings.length > 0 && (
        <ul className="mt-2 space-y-1">
          {status.warnings.map((w) => <li key={w.kind} className="text-[13px] text-amber-400/90">{w.text}</li>)}
        </ul>
      )}

      {!askConsent && stored.mode !== 'off' && status.address && !status.address.ok && (
        <p className="mt-1 text-[13px] text-amber-400/90">Couldn't update the name: {status.address.detail}</p>
      )}

      {!askConsent && egressSentence(status) && <p className="mt-2 text-[13px] text-zinc-500">{egressSentence(status)}</p>}
    </div>
  )
}
