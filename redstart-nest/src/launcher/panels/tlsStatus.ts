// =============================================================================
// The "Secure address" status line: one sentence for every state (TLS plan C8)
// =============================================================================
// Pure, so scripts/test-launcher-tls.mjs can check every branch without a
// browser. Plain TypeScript with nothing but erasable types, which Node runs
// directly.
//
// The order of the checks IS the priority. What the admin must act on comes
// first (a failed apply, a stopped Caddy, a reverted switch), then progress
// (switching, waiting for a certificate), then "Ready".
// =============================================================================

import type { TlsStatus } from '../types'

export type TlsTone = 'ok' | 'progress' | 'warn' | 'error' | 'off'
export type TlsLine = { tone: TlsTone; text: string }

export function tlsStatusLine(s: TlsStatus | null, networkMode: boolean): TlsLine {
  if (!s || !s.settings) return { tone: 'off', text: 'Loading…' }
  if (s.settings.mode === 'off') {
    return { tone: 'off', text: 'Off. Devices on your network connect without encryption.' }
  }
  if (!networkMode || s.state === 'local') {
    return { tone: 'off', text: 'Turn on Local network to serve this name to other devices.' }
  }
  if (s.lastError) return { tone: 'error', text: `Couldn't apply the change: ${s.lastError}` }
  if (s.lastSwitchFailure) return { tone: 'warn', text: s.lastSwitchFailure }
  if (s.state === 'lan-https-fallback') {
    return { tone: 'warn', text: `HTTPS stopped (${s.caddy?.reason ?? 'unknown reason'}). Devices are using plain HTTP until you try again.` }
  }
  if (s.caddy?.state === 'failed') {
    const why = s.caddy.reason ?? 'unknown reason'
    return s.settings.requireHttps
      ? { tone: 'error', text: `HTTPS stopped (${why}). Require HTTPS is on, so devices on your network can't connect until it works.` }
      : { tone: 'error', text: `HTTPS stopped (${why}).` }
  }
  if (s.switching) {
    return { tone: 'progress', text: `Switching to ${s.switching.name}. If it isn't working within 5 minutes, the previous name comes back.` }
  }
  if (!s.serving) {
    const acme = s.caddy?.lastAcmeError
    return acme
      ? { tone: 'progress', text: `Waiting for the certificate. The last attempt said: ${acme}` }
      : { tone: 'progress', text: 'Waiting for the certificate (usually under a minute).' }
  }
  const staging = s.health?.cert?.staging ? ' (test certificate: browsers will warn)' : ''
  return { tone: 'ok', text: `Ready${staging}.` }
}

/** The one sentence about what HTTPS sends off the box (C10), for under the choices. */
export function egressSentence(s: TlsStatus | null): string {
  if (!s || !s.settings || s.settings.mode === 'off') return ''
  const provider = s.settings.provider === 'duckdns' ? 'DuckDNS' : 'deSEC'
  return `Sends: this computer's LAN address to ${provider} when it changes, and a verification record to ${provider} and Let's Encrypt about every 60 days. Nothing about your conversations.`
}
