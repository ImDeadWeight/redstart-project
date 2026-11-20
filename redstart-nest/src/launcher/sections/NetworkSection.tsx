// =============================================================================
// Network & access — who can reach the assistant, and how safely.
// =============================================================================
// Was the bottom half of the old Configuration tab's Network card. Start at
// login, updates and Shut down moved out (System, Overview): they are about
// this computer, not about who can connect to it.
//
// Two planes, two switches, deliberately not merged: "Who can connect" is the
// DATA plane (the chat UI and API), "Manage Nest from another device" is the
// CONTROL plane (this panel). The admin panel can be on the network while the
// chat is not, so the copy states the resulting topology outright.
// =============================================================================

import type { useAuthSetup } from '../hooks/useAuthSetup'
import type { useControlPlaneExposure } from '../hooks/useControlPlaneExposure'
import type { useTls } from '../hooks/useTls'
import { Card, PageHeader, SectionTitle, TogglePill, ControlPlaneNotice } from '../components/ui'
import { SecureAddressSection } from '../panels/SecureAddressSection'
import { AddressRow, QrCode, addressesFor } from './connect'

function Choice({ checked, onSelect, title, children }: {
  checked: boolean
  onSelect: () => void
  title: string
  children: React.ReactNode
}) {
  return (
    <button type="button" role="radio" aria-checked={checked} onClick={onSelect}
      className={`flex flex-col items-start gap-1 rounded-xl border-2 bg-zinc-950/40 px-4 py-3.5 text-left transition-colors ${checked ? 'border-orange-500' : 'border-zinc-800 hover:border-zinc-600'}`}>
      <span className="text-sm font-semibold text-zinc-100">{title}</span>
      <span className="text-[13px] text-zinc-400">{children}</span>
    </button>
  )
}

function SettingRow({ title, children, control }: { title: string; children: React.ReactNode; control: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4 py-4 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-zinc-100">{title}</div>
        <div className="mt-0.5 text-[13px] leading-relaxed text-zinc-400">{children}</div>
      </div>
      <div className="pt-0.5">{control}</div>
    </div>
  )
}

export function NetworkSection({ networkMode, onSetNetworkMode, localIp, port, auth, controlPlaneExposure, tls }: {
  networkMode: boolean
  onSetNetworkMode: (on: boolean) => void
  localIp: string
  port: number
  auth: ReturnType<typeof useAuthSetup>
  controlPlaneExposure: ReturnType<typeof useControlPlaneExposure>
  tls: ReturnType<typeof useTls>
}) {
  const addresses = addressesFor(tls, localIp, port, networkMode)
  const primary = addresses[0]
  const httpsSetUp = !!tls.status?.settings && tls.status.settings.mode !== 'off'
  const { authRequired, toggleAuthRequired } = auth
  const { controlPlane, toggleExposure } = controlPlaneExposure

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Network & access">Who can reach the assistant, and how safely.</PageHeader>

      <Card>
        <SectionTitle className="mb-3">Who can connect</SectionTitle>
        <div role="radiogroup" aria-label="Who can connect" className="grid gap-3 sm:grid-cols-2">
          <Choice checked={!networkMode} onSelect={() => onSetNetworkMode(false)} title="Only this computer">
            Nothing else on the network can reach it, not even a sign-in page.
          </Choice>
          <Choice checked={networkMode} onSelect={() => onSetNetworkMode(true)} title="Everyone on my network">
            Phones and laptops on this network, after signing in.
          </Choice>
        </div>
        <p className="mt-3 text-[13px] text-zinc-500">Takes effect the next time the model starts.</p>
      </Card>

      {networkMode && addresses.length > 0 && (
        <Card>
          <SectionTitle className="mb-1">Addresses</SectionTitle>
          <p className="mb-4 text-sm text-zinc-400">Scan the code with a phone camera, or type an address into any browser on your network.</p>
          <div className="flex flex-wrap items-start gap-5">
            <QrCode url={primary?.url} size={128} />
            <div className="min-w-[16rem] flex-1 divide-y divide-zinc-800">
              {addresses.map((a, i) => <AddressRow key={a.key} address={a} primary={i === 0} />)}
            </div>
          </div>
        </Card>
      )}

      <Card tone={networkMode && !httpsSetUp ? 'attention' : 'default'}>
        <SecureAddressSection tls={tls} networkMode={networkMode} />
      </Card>

      <Card>
        <SectionTitle className="mb-4">Sign-in and administration</SectionTitle>
        <div className="divide-y divide-zinc-800">
          <SettingRow title="Require sign-in"
            control={<TogglePill checked={authRequired} onToggle={toggleAuthRequired} label="Require sign-in" />}>
            Everyone needs an account, on every device, this one included. Accounts and roles are managed in the chat&rsquo;s Settings.
          </SettingRow>

          <SettingRow title="Manage Nest from another device"
            control={<TogglePill checked={!!controlPlane?.exposed} onToggle={toggleExposure} label="Manage Nest from another device" />}>
            Opens this admin panel to your network, owner account only. It belongs to this computer, not to a profile, so switching profiles never changes it.
            {controlPlane?.exposed && (
              <dl className="mt-3 space-y-1.5 text-[13px]">
                <div className="flex flex-wrap gap-x-3">
                  <dt className="w-28 shrink-0 text-zinc-500">Admin panel</dt>
                  {controlPlane.viaHttps ? (
                    <dd className="font-mono text-green-400">
                      {controlPlane.httpsUrl ?? 'https://… (once Everyone on my network is on and HTTPS works)'}
                      <span className="ml-2 font-sans text-zinc-500">encrypted, your network</span>
                    </dd>
                  ) : (
                    <dd className="font-mono text-amber-300">
                      {localIp ? `${localIp}:${controlPlane.port}` : `:${controlPlane.port}`}
                      <span className="ml-2 font-sans text-zinc-500">your network, not encrypted</span>
                    </dd>
                  )}
                </div>
                <div className="flex flex-wrap gap-x-3">
                  <dt className="w-28 shrink-0 text-zinc-500">Chat</dt>
                  <dd className="font-mono text-zinc-300">
                    {/* Behind Caddy the gateway is on loopback; the LAN reaches it through Caddy. */}
                    {networkMode ? (primary?.url ?? `${localIp}:${port}`) : `127.0.0.1:${port}`}
                    <span className="ml-2 font-sans text-zinc-500">
                      {networkMode ? 'your network' : 'this computer only; the admin panel does not expose it'}
                    </span>
                  </dd>
                </div>
              </dl>
            )}
            <ControlPlaneNotice state={controlPlane} localIp={localIp} />
          </SettingRow>
        </div>
      </Card>
    </div>
  )
}
