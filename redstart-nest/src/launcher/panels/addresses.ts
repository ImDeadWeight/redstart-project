// =============================================================================
// Server address derivation for the Network panel.
// =============================================================================
// Up to three URLs, because no single one reaches every client:
//
//   https    — the HTTPS name (TLS plan C7/C8), once it is SERVING. First,
//              default, and the one behind the QR code: padlock, no warning,
//              and the only one a browser treats as a secure context.
//   ip       — always works, no name resolution, works fully offline. With
//              HTTPS serving it is labelled "not encrypted" rather than
//              removed: it is still the fallback when the name will not
//              resolve (router rebinding protection, no internet DNS).
//   sslip    — public wildcard DNS that maps an encoded IP back to itself, so
//              it resolves through the client's normal DNS resolver. This is
//              what got Android a working *hostname* before HTTPS existed.
//              Dropped whenever an HTTPS name exists: that name does the same
//              job, with a certificate.
//
// A fourth option, mDNS (`redstart.local`), was retired: Android's
// resolver never answered `.local` lookups for browser navigation.
//
// Pure (plain TypeScript, erasable types only) so scripts/test-launcher-tls.mjs
// can run it under Node.
// =============================================================================

export type ServerAddress = {
  key: 'https' | 'ip' | 'sslip'
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
// only when the port actually is 80. (With HTTPS set up, buildAddresses drops
// it itself: Caddy owns :80 then.)
function withPort(host: string, port: number): string {
  return port === 80 ? `http://${host}` : `http://${host}:${port}`
}

/**
 * @param https  the HTTPS name when it is set up (null when HTTPS is off);
 *   .serving whether HTTPS is actually working right now; .requireHttps whether
 *   plain HTTP is refused while it is not
 */
export function buildAddresses(localIp: string, port: number, https: { name: string; serving: boolean; requireHttps?: boolean } | null = null): ServerAddress[] {
  const out: ServerAddress[] = []
  const lan = !!localIp && localIp !== '127.0.0.1'

  if (https?.serving) {
    out.push({
      key: 'https',
      url: `https://${https.name}`,
      label: 'Secure',
      note: 'Encrypted. The address to give people.',
    })
  }

  if (lan) {
    // With HTTPS set up, Caddy owns :80 and proxies it (or redirects it once
    // serving), so the plain address has no port.
    out.push({
      key: 'ip',
      url: https ? `http://${localIp}` : withPort(localIp, port),
      label: 'Direct IP',
      note: https
        ? (https.serving
          ? 'Not encrypted. Redirects to the secure address.'
          : https.requireHttps
            ? 'Switched off until the secure address works (Require HTTPS is on).'
            : 'Not encrypted. Works until the secure address is ready.')
        : 'Works on every device, including Android. No DNS involved.',
    })
  }

  const sslip = toSslipHost(localIp)
  if (sslip && !https) {
    out.push({
      key: 'sslip',
      url: withPort(sslip, port),
      label: 'DNS name',
      note: 'Hostname that works on Android. Needs internet DNS.',
    })
  }

  return out
}
