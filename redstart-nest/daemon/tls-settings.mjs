'use strict'

import * as crypto from 'node:crypto'

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

export const TLS_MODES_ACCEPTED = Object.freeze(['off', 'own'])
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
  }
}

/**
 * Validate a patch from tls:set against what is stored.
 * @returns {{ ok: true, next: object } | { ok: false, error: string }}
 *   next = the full normalised tls view plus `token` (plaintext) when the patch sets one
 */
export function validateTlsPatch(patch, settings) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'Expected an object.' }
  const cur = readTls(settings)
  const allowed = new Set(['mode', 'provider', 'name', 'token', 'requireHttps', 'acmeStaging'])
  for (const k of Object.keys(patch)) if (!allowed.has(k)) return { ok: false, error: `Unknown setting: ${k}` }

  const mode = patch.mode ?? cur.mode
  if (mode === 'redstart') return { ok: false, error: 'Automatic names are not available yet.' }
  if (!TLS_MODES_ACCEPTED.includes(mode)) return { ok: false, error: 'Mode must be "own" or "off".' }
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
    },
  }
}

/** Write a validated patch into settings (a copy). Encrypts the token. */
export function applyTlsPatch(settings, next, { encrypt }) {
  const prevOwn = settings?.tls?.own ?? {}
  const tokenEnc = next.token !== null ? encrypt(next.token) : (next.dropToken ? undefined : prevOwn.tokenEnc)
  const own = { provider: next.provider, name: next.name }
  if (tokenEnc) own.tokenEnc = tokenEnc
  return {
    ...settings,
    tls: { mode: next.mode, own, requireHttps: next.requireHttps, acmeStaging: next.acmeStaging },
  }
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
export function tlsRuntime(settings, { decrypt }) {
  const t = readTls(settings)
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
 * A fingerprint of everything that changes Caddy's config: when it changes,
 * the owner restarts Caddy. Hashes the ciphertext, never the token.
 */
export function caddyKeyOf(settings) {
  const t = readTls(settings)
  if (t.mode === 'off') return ''
  const h = crypto.createHash('sha256')
  h.update(JSON.stringify([t.provider, t.name, settings?.tls?.own?.tokenEnc ?? '', t.requireHttps, t.acmeStaging]))
  return h.digest('hex').slice(0, 16)
}
