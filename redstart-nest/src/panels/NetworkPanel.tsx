import { SectionTitle, TogglePill, inputCls } from '../components/ui'

export function NetworkPanel({ networkMode, onToggleNetworkMode, advertisedHost, setAdvertisedHost, localIp, port }: {
  networkMode: boolean
  onToggleNetworkMode: () => void
  advertisedHost: string
  setAdvertisedHost: (host: string) => void
  localIp: string
  port: number
}) {
  return (
    <section>
      <SectionTitle>Network</SectionTitle>
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <TogglePill checked={networkMode} onToggle={onToggleNetworkMode} />
        <span className="text-xs text-zinc-300">{networkMode ? 'Local network (HTTP)' : 'Localhost only'}</span>
      </label>

      {networkMode && (
        <div className="mt-3 space-y-2">
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Advertised hostname <span className="text-zinc-600">(blank = auto-detect IP)</span></label>
            <input
              type="text"
              value={advertisedHost}
              onChange={e => setAdvertisedHost(e.target.value)}
              placeholder="e.g. redstart.local"
              className={inputCls.sm}
            />
            <p className="text-[10px] text-zinc-600 mt-1">Use a hostname like redstart.local for mDNS, or a custom IP. Leave blank to use the detected device IP.</p>
          </div>
          <div className="text-xs text-zinc-400">
            Server address: <span className="text-orange-400 font-semibold">{(advertisedHost || localIp)}:{port}</span>
            {advertisedHost && <span className="text-zinc-500 ml-1">(mDNS: {advertisedHost})</span>}
          </div>
        </div>
      )}
    </section>
  )
}
