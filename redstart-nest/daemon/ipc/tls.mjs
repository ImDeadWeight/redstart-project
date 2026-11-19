// TLS IPC namespace (TLS plan C9): the launcher's "Secure address" section.
//
//   tls:get    the panel's whole view: settings (never the token, only
//              whether one is stored), the LAN state, Caddy, the serving
//              verdict, warnings, the last address publish, a switch in
//              progress, and what HTTPS sends off the box (C10)
//   tls:set    validate + store (token encrypted) + apply
//   tls:check  "Check now"
//   tls:retry  "Try again" after Caddy gave up
//
// Control plane only (admin/api-table.mjs): the data plane never sees these.
// Handler bodies are exported as plain functions, like every namespace.

import { validateTlsPatch, applyTlsPatch, readTls } from '../tls-settings.mjs'
import { applyTlsSettings, beginSwitch, checkTlsNow, retryCaddy, lanStatus } from '../lan.mjs'
import { lastKnownDiscovery } from '../discovery.mjs'
import { serverPortRejection } from './validate.mjs'
import { encryptSecret } from '../secrets.mjs'
import { logEvent } from '../logger.mjs'

export function getTls() {
  return lanStatus()
}

/**
 * @param {object} patch  { mode?, provider?, name?, token?, requireHttps?, acmeStaging? }
 * @param {{ readSettings: () => object, writeSettings: (s: object) => void, encrypt?: (p: string) => string }} deps
 */
export async function setTls(patch, { readSettings, writeSettings, encrypt = encryptSecret }) {
  const settings = readSettings()
  const v = validateTlsPatch(patch, settings)
  if (!v.ok) {
    logEvent('security', 'ipc_argument_rejected', { channel: 'tls:set', reason: v.error })
    return { ok: false, error: v.error, status: lanStatus() }
  }
  // While Caddy fronts, it owns 80 and 443: a gateway port there could not bind.
  if (v.next.mode !== 'off') {
    const { gatewayPort } = lastKnownDiscovery(settings)
    const clash = serverPortRejection(gatewayPort, { httpsFronted: true })
    if (clash) return { ok: false, error: clash, status: lanStatus() }
  }
  const before = readTls(settings)
  const previousTls = settings.tls
  const next = applyTlsPatch(settings, v.next, { encrypt })
  writeSettings(next)
  logEvent('tls', 'settings_saved', { mode: v.next.mode, provider: v.next.provider })
  // Name to name while one is working: try the new one, revert if it never serves.
  const switching = before.mode === 'own' && v.next.mode === 'own' && lanStatus().serving
    && (before.name !== v.next.name || before.provider !== v.next.provider)
  if (switching) beginSwitch(previousTls, v.next.name)
  await applyTlsSettings({ clearFailure: true })
  return { ok: true, status: lanStatus() }
}

export function tlsHandlers(deps) {
  return {
    'tls:get': () => getTls(),
    'tls:set': (patch) => setTls(patch, deps),
    'tls:check': () => checkTlsNow(),
    'tls:retry': async () => { await retryCaddy(); return lanStatus() },
  }
}
