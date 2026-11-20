// =============================================================================
// Where people connect: the address list and its QR code.
// =============================================================================
// Shared by Overview (the "connect a phone" card) and Network & access (the
// full list), and by the header's address. The derivation itself is
// panels/addresses.ts, kept pure so test-launcher-tls.mjs can run it.
// =============================================================================

import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { useTls } from '../hooks/useTls'
import { buildAddresses, type ServerAddress } from '../panels/addresses'
import { btnCls } from '../components/ui'

/** The addresses devices can use right now, best first. Empty when only this computer can connect. */
export function addressesFor(tls: ReturnType<typeof useTls>, localIp: string, port: number, networkMode: boolean): ServerAddress[] {
  const s = tls.status?.settings
  const nameInUse = s?.mode === 'own' ? s.name : s?.mode === 'redstart' ? s.automatic?.hostname : null
  const httpsName = nameInUse && tls.status?.state !== 'local'
    ? { name: nameInUse, serving: !!tls.status?.serving, requireHttps: !!s?.requireHttps }
    : null
  if (!networkMode) return []
  return buildAddresses(localIp, port, httpsName)
}

/** The address for this computer when nothing else can connect. */
export function localAddress(port: number): string {
  return `http://127.0.0.1:${port}`
}

export function CopyButton({ text, label = 'Copy', tip }: { text: string; label?: string; tip?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    }).catch(() => {})
  }
  return (
    <button type="button" onClick={copy} data-tip={tip} className={`${btnCls.secondary} min-w-[4.5rem] py-1.5`} aria-live="polite">
      {copied ? 'Copied' : label}
    </button>
  )
}

/** A QR code for `url`, drawn locally: nothing is fetched to make it. */
export function QrCode({ url, size = 112 }: { url: string | undefined; size?: number }) {
  const [src, setSrc] = useState('')
  useEffect(() => {
    if (!url) { setSrc(''); return }
    let stale = false
    QRCode.toDataURL(url, { width: 240, margin: 1, color: { dark: '#18181b', light: '#ffffff' } })
      .then(d => { if (!stale) setSrc(d) })
      .catch(() => { if (!stale) setSrc('') })
    return () => { stale = true }
  }, [url])
  if (!src) return null
  return <img src={src} alt={`QR code for ${url}`} width={size} height={size} className="shrink-0 rounded-lg bg-white" style={{ width: size, height: size }} />
}

export function AddressRow({ address, primary }: { address: ServerAddress; primary?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-zinc-400">{address.label}</div>
        <code className={`block break-all ${primary ? 'text-[15px] font-medium text-orange-300' : 'text-sm text-zinc-200'}`}>{address.url}</code>
        <div className="mt-0.5 text-[13px] text-zinc-500">{address.note}</div>
      </div>
      <CopyButton text={address.url} tip="Copy this address" />
    </div>
  )
}
