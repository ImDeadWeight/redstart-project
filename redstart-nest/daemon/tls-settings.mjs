'use strict'

import * as crypto from 'node:crypto'
import { nameServiceUrl } from './tls-names.mjs'

// =============================================================================
// Redstart Nest — the `tls` block of settings.json (TLS plan C9)
// =============================================================================
//   "tls": {
//     "mode": "own" | "off",
//     "own": { "provider": "duckdns" | "desec", "name": "...", "tokenEnc": "..." },
//     "requireHttps": false,
//     "acmeStaging": false
//   }
//
// "redstart" (Automatic) is refused until Product B exists (plan step 8).
//
// The token is stored ENCRYPTED (secrets.mjs), never returned by readTls(),
// and written only through applyTlsPatch(), which encrypts it. A patch that
// omits the token keeps the stored one (the Plugins-tab pattern: the field
// never shows a stored value, and saving without retyping keeps it). The
// re-key tool finds tokenEnc by its `Enc` suffix (secrets-migration.mjs);
// test-tls-settings.mjs pins that.
//
// Everything here is pure: encrypt/decrypt are passed in.
// =============================================================================

export const TLS_MODES_ACCEPTED = Object.freeze(['off', 'own', 'redstart'])
const REDSTART_ID = /^[abcdefghijkmnpqrstuvwxyz23456789]{6}$/
export const PROVIDERS = Object.freeze(['duckdns', 'desec'])

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const DUCKDNS_NAME = new RegExp(`^${LABEL}\\.duckdns\\.org$`)
const DESEC_NAME = new RegExp(`^(?=.{1,253}$)(?:${LABEL}\\.)+${LABEL}$`)
const TOKEN = /^[A-Za-z0-9._~+/=-]{8,200}$/

/** Lower-case and trim; a bare DuckDNS subdomain gets its suffix. */
export function normaliseName(provider, raw) {
  const name = String(raw ?? '').trim().toLowerCase().replace(/\.$/, '')
  if (provider === 'duckdns' && name && !name.includes('.')) return `${name}.duckdns.org`
  return name
}

/** @returns {string|null} why a name is unusable for this provider */
export function nameRejection(provider, name) {
  if (provider === 'duckdns') {
    return DUCKDNS_NAME.test(name) ? null : 'A DuckDNS name looks like yourname.duckdns.org.'
  }
  if (provider === 'desec') {
    return DESEC_NAME.test(name) && name.includes('.') ? null : 'A deSEC name looks like yourname.dedyn.io (or a domain you host there).'
  }
  return 'Choose DuckDNS or deSEC.'
}

/**
 * The tls block as the launcher may see it: no token, only whether one is set.
 * @param {object} settings the parsed settings.json
 */
export function readTls(settings) {
  const t = settings?.tls ?? {}
  const own = t.own ?? {}
  return {
    mode: TLS_MODES_ACCEPTED.includes(t.mode) ? t.mode : 'off',
    provider: PROVIDERS.includes(own.provider) ? own.provider : 'duckdns',
    name: typeof own.name === 'string' ? own.name : '',
    hasToken: typeof own.tokenEnc === 'string' && own.tokenEnc.length > 0,
    requireHttps: t.requireHttps === true,
    acmeStaging: t.acmeStaging === true,
    // Automatic (step 8): the name, once registered. Never the credential.
    automatic: readRedstart(settings) ? { hostname: readRedstart(settings).hostname } : null,
    // The consent screen (C8) has been answered, whichever way.
    consentAsked: t.consentAsked === true,
  }
}

/**
 * The stored Automatic registration, or null. `credentialEnc` is encrypted
 * like the own-name token and found by the re-key tool the same way.
 * @returns {{ id: string, hostname: string, credentialEnc: string, registeredAt: number } | null}
 */
export function readRedstart(settings) {
  const r = settings?.tls?.redstart
  if (!r || !REDSTART_ID.test(String(r.id)) || typeof r.credentialEnc !== 'string' || !r.credentialEnc) return null
  return { id: r.id, hostname: `${r.id}.nest.redstartdevelopment.com`, credentialEnc: r.credentialEnc, registeredAt: Number(r.registeredAt) || 0 }
}

/** Store a fresh registration (a copy of settings). The hostname is derived, not stored. */
export function withRedstart(settings, { id, credential }, { encrypt, now = Date.now() }) {
  if (!REDSTART_ID.test(String(id))) throw new Error('not a name-service id')
  return { ...settings, tls: { ...(settings?.tls ?? {}), redstart: { id, credentialEnc: encrypt(credential), registeredAt: now } } }
}

/** Forget the registration (a copy of settings). */
export function withoutRedstart(settings) {
  const tls = { ...(settings?.tls ?? {}) }
  delete tls.redstart
  return { ...settings, tls }
}

/**
 * Validate a patch from tls:set against what is stored.
 * @returns {{ ok: true, next: object } | { ok: false, error: string }}
 *   next = the full normalised tls view plus `token` (plaintext) when the patch sets one
 */
export function validateTlsPatch(patch, settings) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'Expected an object.' }
  const cur = readTls(settings)
  const allowed = new Set(['mode', 'provider', 'name', 'token', 'requireHttps', 'acmeStaging', 'consentAsked'])
  for (const k of Object.keys(patch)) if (!allowed.has(k)) return { ok: false, error: `Unknown setting: ${k}` }
  if ('consentAsked' in patch && patch.consentAsked !== true) return { ok: false, error: 'consentAsked can only be set, not cleared.' }

  const mode = patch.mode ?? cur.mode
  if (!TLS_MODES_ACCEPTED.includes(mode)) return { ok: false, error: 'Mode must be "redstart", "own" or "off".' }
  const provider = patch.provider ?? cur.provider
  if (!PROVIDERS.includes(provider)) return { ok: false, error: 'Choose DuckDNS or deSEC.' }
  for (const k of ['requireHttps', 'acmeStaging']) {
    if (k in patch && typeof patch[k] !== 'boolean') return { ok: false, error: `${k} must be true or false.` }
  }
  let token = null
  if ('token' in patch && patch.token !== undefined && patch.token !== '') {
    if (typeof patch.token !== 'string' || !TOKEN.test(patch.token.trim())) return { ok: false, error: 'That token does not look right.' }
    token = patch.token.trim()
  }
  const name = 'name' in patch ? normaliseName(provider, patch.name) : cur.name
  // A provider change invalidates the stored token (it belonged to the other one).
  const providerChanged = provider !== cur.provider
  const hasToken = token !== null || (cur.hasToken && !providerChanged)

  if (mode === 'own') {
    const why = nameRejection(provider, name)
    if (why) return { ok: false, error: why }
    if (!hasToken) return { ok: false, error: `Paste your ${provider === 'duckdns' ? 'DuckDNS' : 'deSEC'} token.` }
  }
  return {
    ok: true,
    next: {
      mode, provider, name, token, dropToken: providerChanged && token === null,
      requireHttps: 'requireHttps' in patch ? patch.requireHttps : cur.requireHttps,
      acmeStaging: 'acmeStaging' in patch ? patch.acmeStaging : cur.acmeStaging,
      // Choosing any HTTPS mode answers the consent question too.
      consentAsked: patch.consentAsked === true || cur.consentAsked || mode !== 'off',
    },
  }
}

/** Write a validated patch into settings (a copy). Encrypts the token. */
export function applyTlsPatch(settings, next, { encrypt }) {
  const prevOwn = settings?.tls?.own ?? {}
  const tokenEnc = next.token !== null ? encrypt(next.token) : (next.dropToken ? undefined : prevOwn.tokenEnc)
  const own = { provider: next.provider, name: next.name }
  if (tokenEnc) own.tokenEnc = tokenEnc
  const tls = { mode: next.mode, own, requireHttps: next.requireHttps, acmeStaging: next.acmeStaging, consentAsked: next.consentAsked }
  // The Automatic registration is lan.mjs's to make and release, never a
  // patch's: a save of any other field must not drop it.
  if (settings?.tls?.redstart) tls.redstart = settings.tls.redstart
  return { ...settings, tls }
}

/**
 * The provider block Caddy loads (placeholders only; caddy-config.mjs refuses
 * a literal credential) and the env var that carries the token.
 */
export function caddyDnsFor(provider) {
  if (provider === 'duckdns') return { name: 'duckdns', api_token: '{env.REDSTART_DNS_TOKEN}' }
  if (provider === 'desec') return { name: 'desec', token: '{env.REDSTART_DNS_TOKEN}' }
  throw new Error(`unknown provider ${provider}`)
}

/**
 * Everything lan.mjs needs to start Caddy, or null when HTTPS is off or
 * unusable (no token, or one that no longer decrypts).
 */
/**
 * Caddy also serves the control plane (:8443) when HTTPS is on and the admin
 * panel is meant to be reachable from other devices. The admin listener then
 * binds loopback (admin-listener.mjs effectiveAdminBindHost).
 */
export function adminProxied(settings) {
  const host = settings?.adminBindHost
  return readTls(settings).mode !== 'off' && typeof host === 'string' && !['127.0.0.1', '::1', 'localhost'].includes(host.trim())
}

export function tlsRuntime(settings, { decrypt }) {
  const t = readTls(settings)
  const base = t.mode === 'redstart' ? redstartRuntime(settings, t, { decrypt }) : ownRuntime(settings, t, { decrypt })
  return base ? { ...base, adminProxied: adminProxied(settings) } : null
}

function ownRuntime(settings, t, { decrypt }) {
  if (t.mode !== 'own' || nameRejection(t.provider, t.name) || !t.hasToken) return null
  let token
  try { token = decrypt(settings.tls.own.tokenEnc) } catch { return null }
  if (!token) return null
  return {
    hostname: t.name,
    provider: t.provider,
    dnsProvider: caddyDnsFor(t.provider),
    token,
    secrets: { REDSTART_DNS_TOKEN: token },
    requireHttps: t.requireHttps,
    acmeStaging: t.acmeStaging,
  }
}

/**
 * Automatic: Caddy's acmedns plugin, pointed at the name service, with the
 * install's id as user and subdomain and its credential as the password
 * (by environment, like every secret). Null until registered: lan.mjs
 * registers just before Caddy first starts, never earlier (invariant 6).
 */
function redstartRuntime(settings, t, { decrypt }) {
  const r = readRedstart(settings)
  if (!r) return null
  let credential
  try { credential = decrypt(r.credentialEnc) } catch { return null }
  if (!credential) return null
  return {
    hostname: r.hostname,
    provider: 'redstart',
    id: r.id,
    dnsProvider: { name: 'acmedns', username: r.id, password: '{env.REDSTART_DNS_TOKEN}', subdomain: r.id, server_url: nameServiceUrl() },
    token: credential,
    secrets: { REDSTART_DNS_TOKEN: credential },
    requireHttps: t.requireHttps,
    acmeStaging: t.acmeStaging,
  }
}

/**
 * A fingerprint of everything that changes Caddy's config: when it changes,
 * the owner restarts Caddy. Hashes the ciphertext, never the token.
 */
export function caddyKeyOf(settings) {
  const t = readTls(settings)
  if (t.mode === 'off') return ''
  const h = crypto.createHash('sha256')
  const auto = t.mode === 'redstart' ? readRedstart(settings) : null
  // Automatic: not the id or credential. Registration happens INSIDE Caddy's
  // first start (lan.mjs), and a key that changed then would restart Caddy at
  // once. A new registration only ever follows a mode change, which changes
  // the key anyway.
  void auto
  h.update(JSON.stringify(t.mode === 'redstart'
    ? ['redstart', t.requireHttps, t.acmeStaging, adminProxied(settings)]
    : [t.provider, t.name, settings?.tls?.own?.tokenEnc ?? '', t.requireHttps, t.acmeStaging, adminProxied(settings)]))
  return h.digest('hex').slice(0, 16)
}
