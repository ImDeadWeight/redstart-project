import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { SectionTitle, TogglePill, inputCls, btnCls } from '../components/ui'
import { buildAddresses } from './addresses'

// Lives in the Configuration tab rather than the sidebar: it sits next to the
// Host/Port fields it depends on, and the QR code plus three-address list needs
// more width than the 256px sidebar allowed.

// One row per reachable URL. The IP row leads because it is the only address
// that resolves on every client; the hostname rows are conveniences that each
// fail on some platform (see addresses.ts for which and why).
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

export function NetworkPanel({ networkMode, onToggleNetworkMode, advertisedHost, setAdvertisedHost, localIp, port }: {
  networkMode: boolean
  onToggleNetworkMode: () => void
  advertisedHost: string
  setAdvertisedHost: (host: string) => void
  localIp: string
  port: number
}) {
  const addresses = buildAddresses(localIp, advertisedHost, port)
  const primary = addresses[0]
  const [qr, setQr] = useState('')

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

      {networkMode && (
        <div className="mt-4 grid grid-cols-3 gap-4">
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Advertised hostname <span className="text-zinc-600">(blank = auto-detect IP)</span></label>
            <input
              type="text"
              value={advertisedHost}
              onChange={e => setAdvertisedHost(e.target.value)}
              placeholder="e.g. redstart.local"
              className={inputCls.sm}
            />
            <p className="text-[10px] text-zinc-600 mt-1 leading-relaxed">
              Advertised over mDNS. Convenience only — the direct IP is the address that reaches every device.
            </p>
          </div>

          {addresses.length > 0 && (
            <div className="col-span-2 flex gap-4">
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
        </div>
      )}
    </section>
  )
}
