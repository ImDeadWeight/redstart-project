// =============================================================================
// Server address derivation for the Network panel.
// =============================================================================
// Three URLs are offered because no single one reaches every client:
//
//   ip       — always works, no name resolution, works fully offline. The only
//              universal option, and the one behind the QR code.
//   mdns     — resolves on iOS, macOS, Windows 10 1703+, and Linux with avahi
//              + nss-mdns. Android does NOT resolve .local for browser
//              navigation, so this can never be the primary path.
//   sslip    — public wildcard DNS that maps an encoded IP back to itself, so
//              it resolves through the client's normal DNS resolver. This is
//              what gets Android a working *hostname*. Costs an internet DNS
//              lookup, and routers with DNS-rebind protection (pfSense, some
//              OpenWRT/Fritz!Box setups) refuse public names pointing at
//              private IPs, so it is offered as an option, never a default.
// =============================================================================

export type ServerAddress = {
  key: 'ip' | 'mdns' | 'sslip'
  url: string
  label: string
  note: string
}

// 192.168.0.213 -> 192-168-0-213.sslip.io
// sslip.io accepts dashed and dotted forms; dashed is used because it survives
// being a single DNS label and avoids any ambiguity with real subdomains.
export function toSslipHost(ip: string): string | null {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return null
  return `${ip.replace(/\./g, '-')}.sslip.io`
}

// Port 80 is proxied to the gateway when it's free, so the suffix is dropped
// only when the port actually is 80. Otherwise every URL carries it.
function withPort(host: string, port: number): string {
  return port === 80 ? `http://${host}` : `http://${host}:${port}`
}

export function buildAddresses(localIp: string, advertisedHost: string, port: number): ServerAddress[] {
  const out: ServerAddress[] = []

  if (localIp && localIp !== '127.0.0.1') {
    out.push({
      key: 'ip',
      url: withPort(localIp, port),
      label: 'Direct IP',
      note: 'Works on every device, including Android. No DNS involved.',
    })
  }

  const host = advertisedHost.trim()
  if (host && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    out.push({
      key: 'mdns',
      url: withPort(host, port),
      label: 'mDNS name',
      note: 'iPhone, Mac, Windows, Linux with avahi. Not Android.',
    })
  }

  const sslip = toSslipHost(localIp)
  if (sslip) {
    out.push({
      key: 'sslip',
      url: withPort(sslip, port),
      label: 'DNS name',
      note: 'Hostname that works on Android. Needs internet DNS.',
    })
  }

  return out
}
