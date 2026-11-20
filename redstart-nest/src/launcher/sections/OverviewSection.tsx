// =============================================================================
// Overview — how this Nest is doing, and what's left to set up.
// =============================================================================
// Every line here is derived from live state the other sections already hold;
// nothing on this page is stored or edited on its own. The setup checklist's
// buttons only navigate.
// =============================================================================

import type { LlamaConfig, UpdateState } from '../types'
import type { useTls } from '../hooks/useTls'
import type { useUpdateSettings } from '../hooks/useUpdateSettings'
import type { ServerAddress } from '../panels/addresses'
import { Card, Chip, ConfirmDialog, PageHeader, SectionTitle, TogglePill, btnCls } from '../components/ui'
import { CopyButton, QrCode, localAddress } from './connect'
import type { SectionId } from './Sidebar'

const baseName = (p: string) => p.split(/[\\/]/).pop() || p

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-5 py-4">
      <div className="mb-1.5 text-[13px] text-zinc-400">{label}</div>
      <div className="break-words text-base font-semibold text-zinc-50">{value}</div>
      {sub && <div className="mt-1 text-[13px] text-zinc-500">{sub}</div>}
    </div>
  )
}

function updateLine(u: UpdateState): string {
  switch (u.state) {
    case 'checking': return 'Looking for a newer version…'
    case 'downloading': return `Downloading ${u.version ?? 'an update'} in the background…`
    case 'ready': return `Version ${u.version} has downloaded and its signature checks out. You’re on ${u.currentVersion}.`
    case 'error': return `The last check failed: ${u.error ?? 'unknown error'}`
    default: {
      if (!u.checkedAt) return `Redstart Nest ${u.currentVersion}. Not checked yet this session.`
      const at = new Date(u.checkedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      return `Redstart Nest ${u.currentVersion} is the latest. Last checked ${at}.`
    }
  }
}

function UpdatesCard({ updates }: { updates: ReturnType<typeof useUpdateSettings> }) {
  const { update, toggleUpdate, checkNow, checking, confirmInstall, setConfirmInstall, installing, requestInstall, confirmInstallNow } = updates
  // Hidden wherever this install does not update itself: a headless daemon
  // (updated with git), a dev run, macOS.
  if (!update?.supported) return null
  const ready = update.state === 'ready'
  const busy = checking || update.state === 'checking' || update.state === 'downloading'
  const chip = ready ? <Chip tone="warn">Update ready</Chip>
    : update.state === 'error' ? <Chip tone="error">Check failed</Chip>
    : busy ? <Chip tone="off">{update.state === 'downloading' ? 'Downloading…' : 'Checking…'}</Chip>
    : <Chip tone="ok">Up to date</Chip>

  return (
    <Card tone={ready ? 'attention' : 'default'} aria-label="Updates">
      <div className="mb-2 flex items-center gap-3">
        <SectionTitle className="flex-1 !mb-0">Updates</SectionTitle>
        {chip}
      </div>
      <p className="text-sm leading-relaxed text-zinc-300">{updateLine(update)}</p>
      {ready && (
        <p className="mt-2 text-[13px] text-zinc-400">
          Restarting stops the model for everyone for a minute or two. Otherwise it installs the next time Redstart quits.
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {ready
          ? <button type="button" onClick={requestInstall} disabled={installing} className={btnCls.primary}>{installing ? 'Restarting…' : 'Restart to update'}</button>
          : <button type="button" onClick={checkNow} disabled={busy} className={btnCls.secondary}>{busy ? 'Checking…' : 'Check now'}</button>}
        <div className="flex-1" />
        <label className="flex items-center gap-2.5 text-[13px] text-zinc-400">
          Check automatically
          <TogglePill checked={update.enabled} onToggle={toggleUpdate} />
        </label>
      </div>
      <p className="mt-3 text-[13px] text-zinc-500">
        Updates come from this project&rsquo;s GitHub releases. Checking sends GitHub this computer&rsquo;s address and Redstart&rsquo;s version, nothing else.
      </p>

      <ConfirmDialog
        open={ready && confirmInstall}
        title={`Restart and update to ${update.version}?`}
        confirmLabel="Restart and update"
        danger={false}
        onConfirm={confirmInstallNow}
        onCancel={() => setConfirmInstall(false)}>
        <p>The model stops and every device disconnects for a minute or two while the update installs.</p>
        <p>If Redstart was installed for all users, Windows asks for permission on this computer&rsquo;s screen first, and the update waits until someone there answers.</p>
      </ConfirmDialog>
    </Card>
  )
}

export function OverviewSection({
  config, modelChosen, binaryFound, networkMode, authRequired, tls, addresses, updates, onNavigate,
}: {
  config: LlamaConfig
  modelChosen: boolean
  binaryFound: boolean
  networkMode: boolean
  authRequired: boolean
  tls: ReturnType<typeof useTls>
  addresses: ServerAddress[]
  updates: ReturnType<typeof useUpdateSettings>
  onNavigate: (s: SectionId) => void
}) {
  const tlsMode = tls.status?.settings?.mode ?? 'off'
  const httpsServing = !!tls.status?.serving
  const toolsOn = config.tools?.enabled ? (config.tools.activeToolIds?.length ?? 0) + (config.tools.webAccessEnabled !== false ? 1 : 0) : 0
  const primary = addresses[0]

  const checklist: { title: string; hint: string; done: boolean; action: string; go: SectionId }[] = [
    { title: 'Choose a model', hint: modelChosen ? `${baseName(config.modelPath)} is chosen.` : 'Pick one you have, or download one.', done: modelChosen, action: 'Choose a model', go: 'model' },
    { title: 'Find the model engine', hint: binaryFound ? 'llama-server is ready.' : 'Nest needs llama-server to run models.', done: binaryFound, action: 'Choose llama-server', go: 'system' },
    { title: 'Let your network connect', hint: networkMode ? 'Phones and laptops on your network can sign in.' : 'Only this computer can use it right now.', done: networkMode, action: 'Choose who can connect', go: 'network' },
    { title: 'Turn on some tools', hint: toolsOn ? `${toolsOn} tool${toolsOn === 1 ? ' is' : 's are'} on for this profile.` : 'Without tools it can only chat.', done: toolsOn > 0, action: 'Choose tools', go: 'tools' },
    { title: 'Give it a secure address', hint: httpsServing ? 'Devices connect over HTTPS.' : tlsMode !== 'off' ? 'Set up, not working yet. See Network & access.' : 'So passwords aren’t sent across the network in the clear.', done: httpsServing, action: tlsMode !== 'off' ? 'See what’s wrong' : 'Set up HTTPS', go: 'network' },
  ]
  const doneCount = checklist.filter(c => c.done).length

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Overview">How your Nest is doing, and what&rsquo;s left to set up.</PageHeader>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Stat label="Model" value={modelChosen ? baseName(config.modelPath) : 'None chosen'}
          sub={`${(config.ctxSize / 1024).toFixed(0)}K tokens of memory per conversation`} />
        <Stat label="Who can connect" value={networkMode ? 'Everyone on your network' : 'Only this computer'}
          sub={`${authRequired ? 'Sign-in required' : 'No sign-in'} · ${httpsServing ? 'encrypted (HTTPS)' : 'not encrypted'}`} />
        <Stat label="Tools" value={config.tools?.enabled ? `${toolsOn} on` : 'Off'}
          sub="Nothing leaves this network unless a tool you turned on says so" />
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <SectionTitle className="mb-1">Setup checklist</SectionTitle>
          <p className="mb-3 text-sm text-zinc-400">
            {doneCount} of {checklist.length} done.{doneCount < checklist.length ? ' The rest are worth doing before an office relies on it.' : ' All set.'}
          </p>
          <ul>
            {checklist.map(c => (
              <li key={c.title} className="flex items-center gap-3 border-t border-zinc-800 py-3">
                {c.done
                  ? <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label="Done"><circle cx="12" cy="12" r="9" /><path d="M8 12l3 3 5-6" /></svg>
                  : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8e8e96" strokeWidth="2" role="img" aria-label="To do"><circle cx="12" cy="12" r="9" /></svg>}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-zinc-100">{c.title}</div>
                  <div className="text-[13px] text-zinc-400">{c.hint}</div>
                </div>
                {!c.done && <button type="button" onClick={() => onNavigate(c.go)} className={`${btnCls.chip} whitespace-nowrap`}>{c.action}</button>}
              </li>
            ))}
          </ul>
        </Card>

        <div className="flex flex-col gap-6 lg:col-span-2">
          <Card>
            <SectionTitle className="mb-1">Connect a phone or laptop</SectionTitle>
            {primary ? (<>
              <p className="mb-4 text-sm text-zinc-400">Scan with a phone camera, or type the address into any browser on your network.</p>
              <div className="flex items-center gap-4">
                <QrCode url={primary.url} size={112} />
                <div className="min-w-0 space-y-2">
                  <code className="block break-all text-sm text-orange-300">{primary.url}</code>
                  <CopyButton text={primary.url} tip="Copy the chat address" />
                </div>
              </div>
            </>) : (
              <p className="text-sm text-zinc-400">
                Only this computer can connect right now, at <code className="text-zinc-200">{localAddress(config.port)}</code>.
              </p>
            )}
            <button type="button" onClick={() => onNavigate('network')} className={`${btnCls.subtle} mt-4`}>Other addresses and HTTPS</button>
          </Card>

          <UpdatesCard updates={updates} />
        </div>
      </div>
    </div>
  )
}
