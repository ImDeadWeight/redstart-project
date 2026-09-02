'use strict'

// =============================================================================
// Redstart Nest — the per-box bootstrap token
// =============================================================================
// The router is the precedent, and it supplies both halves: a unique password on
// a label underneath, and a recessed reset button that wipes to factory. This is
// the label (headless-admin-plane-plan.md §3.2). One CSPRNG token per unit,
// generated on that unit at first run, and the only thing that opens
// POST /admin/bootstrap — which both CREATES the first owner and RESETS an
// existing one, because they are the same question.
//
// WHY IT IS NOT OPTIONAL. `auth:create-first-admin` grants ownership to any
// caller when no owner exists, and is safe today only because IPC is its sole
// door. Two things make that unsafe the moment bootstrap moves to HTTP: the
// route becomes LAN-reachable, and "no owner exists" is reachable by CORRUPTION
// as well as by newness — accounts-storage reads a torn accounts.json as no
// accounts. Without a token, first-to-arrive owns the box. Recovery comes along
// for free because it is the same door.
//
// STORED IN PLAINTEXT, deliberately, and this is the one place in the tree where
// that is the right answer. The Electron client must read the file and submit it
// so Windows setup looks exactly as it does today — the user sees the same
// create-owner form and never sees a token. Hashing would cost that flow and buy
// nothing against the only threat that reaches the file: anyone who can read
// this directory can rewrite accounts.json anyway, which is ownership by a
// shorter route. Compare secrets.mjs, where the threat is a stolen file and
// encryption is therefore worth its cost.
//
// NOT BAKED INTO AN IMAGE. Generated on first run of the daemon on that unit. A
// token shipped in an appliance image is the default-password failure with extra
// steps, and a label has to match the box it is stuck to.
// =============================================================================

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { configDir } from './platform-paths.mjs'
import { logEvent } from './logger.mjs'

const TOKEN_FILE = 'bootstrap-token.txt'

// Grouped in fives like a product key, because someone reads this off a chassis
// label and types it into a phone. Crockford's alphabet: no I, L, O or U, so the
// characters people confuse are not in it and the ones they might swear at are
// not either. 20 characters over a 32-symbol alphabet is 100 bits.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TOKEN_CHARS = 20
const GROUP = 5

function tokenPath() {
  return path.join(configDir(), TOKEN_FILE)
}

export function generateBootstrapToken() {
  // Rejection-free because 256 is a multiple of 32: every byte maps to exactly
  // eight symbols, so no value is more likely than another.
  const bytes = crypto.randomBytes(TOKEN_CHARS)
  let out = ''
  for (let i = 0; i < TOKEN_CHARS; i++) {
    if (i > 0 && i % GROUP === 0) out += '-'
    out += ALPHABET[bytes[i] % ALPHABET.length]
  }
  return out
}

/** Strip the grouping and case so a token typed by a human matches the stored one. */
function canonical(token) {
  return String(token ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '')
}

/**
 * The box's token, generating and writing one if this unit has none.
 *
 * Called at daemon start so an EXISTING install mints one on its next run
 * rather than at the moment someone needs it — a token that only appears when
 * an admin is already locked out is a token they cannot get to.
 */
export function ensureBootstrapToken() {
  const existing = readBootstrapToken()
  if (existing) return existing

  const token = generateBootstrapToken()
  writeToken(token)
  logEvent('admin', 'bootstrap_token_created', {})
  return token
}

/** The stored token, or null if this unit has none yet. Never throws. */
export function readBootstrapToken() {
  try {
    const raw = fs.readFileSync(tokenPath(), 'utf8').trim()
    return raw || null
  } catch {
    return null
  }
}

function writeToken(token) {
  const target = tokenPath()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  // Written 0600 where the platform honours it. On Windows this is close to
  // decorative — the directory ACL is what protects the file — but it costs
  // nothing and is correct on the appliance, which is where the daemon runs as
  // its own account and other local users exist.
  fs.writeFileSync(target, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
}

/**
 * Mint a new token, invalidating the old one.
 *
 * For an organisation that relocated the box, photographed the label, or handed
 * it to someone who has since left. The label is then wrong, which is the
 * owner's problem to reprint — the software's job is to make re-keying possible,
 * not to manage custody.
 */
export function rotateBootstrapToken() {
  const token = generateBootstrapToken()
  writeToken(token)
  logEvent('admin', 'bootstrap_token_rotated', {})
  return token
}

/**
 * Is this the box's token?
 *
 * Compared in constant time. The entropy makes guessing hopeless and a timing
 * side channel on a 100-bit secret is not the way anyone gets in — but the
 * comparison is one line either way, and a plain `===` here is the kind of thing
 * that gets copied to somewhere it does matter.
 *
 * Fails closed when no token exists at all: a unit with no token is not a unit
 * where every candidate is correct.
 */
export function verifyBootstrapToken(candidate) {
  const stored = readBootstrapToken()
  if (!stored) return false

  const a = Buffer.from(canonical(stored), 'utf8')
  const b = Buffer.from(canonical(candidate), 'utf8')
  if (a.length === 0 || a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
