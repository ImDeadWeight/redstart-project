// =============================================================================
// Server address derivation for the Network panel.
// =============================================================================
// Two URLs are offered because no single one reaches every client:
//
//   ip       — always works, no name resolution, works fully offline. The only
//              universal option, and the one behind the QR code.
//   sslip    — public wildcard DNS that maps an encoded IP back to itself, so
//              it resolves through the client's normal DNS resolver. This is
//              what gets Android a working *hostname*. Costs an internet DNS
//              lookup, and routers with DNS-rebind protection (pfSense, some
//              OpenWRT/Fritz!Box setups) refuse public names pointing at
//              private IPs, so it is offered as an option, never a default.
//
// A third option, mDNS (`redstart.local`), was retired in Phase 6.5: Android's
// resolver never answered `.local` lookups for browser navigation, so a name
// that failed on the one platform most clients are wasn't worth the UDP 5353
// firewall rule and the elevated-prompt cost of keeping it. See
// docs/notes/headless-admin-plane-implementation.md §6.5 for the record.
// =============================================================================

export type ServerAddress = {
  key: 'ip' | 'sslip'
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

export function buildAddresses(localIp: string, port: number): ServerAddress[] {
  const out: ServerAddress[] = []

  if (localIp && localIp !== '127.0.0.1') {
    out.push({
      key: 'ip',
      url: withPort(localIp, port),
      label: 'Direct IP',
      note: 'Works on every device, including Android. No DNS involved.',
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
