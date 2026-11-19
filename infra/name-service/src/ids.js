// Install ids and credentials (TLS plan C12). Web Crypto only, so the same
// code runs in the Worker and under Node for the tests.

/** 32 symbols: lower-case letters and digits without 0/o/1/l, so an id read aloud or off a phone is unambiguous. */
export const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'
export const ID_LENGTH = 6
export const ID_RE = new RegExp(`^[${ID_ALPHABET}]{${ID_LENGTH}}$`)

/** A random install id: 6 symbols, 30 bits, no identifying content. */
export function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH))
  let out = ''
  for (const b of bytes) out += ID_ALPHABET[b % 32] // 256 is a multiple of 32: no bias
  return out
}

function base64url(bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 32 random bytes, base64url. Returned to the install once, never stored. */
export function newCredential() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

/** SHA-256, hex. Plain (not slow) hashing is right here: the input is 256 random bits, not a password. */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Constant-time comparison of two equal-length hex strings. */
export function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
