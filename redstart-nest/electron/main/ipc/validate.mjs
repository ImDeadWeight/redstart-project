'use strict'

// =============================================================================
// Redstart Nest — argument shapes for the mutating IPC channels
// =============================================================================
// A hardening layer, NOT the trust boundary. guard.mjs is what stops an
// untrusted sender; this is what stops a TRUSTED sender from sending nonsense —
// a renderer bug, a refactor that changes an argument's type, a value that
// arrived from the network and was never checked.
//
// Applied only where a call CHANGES STATE. Schema-ing a read-only handler like
// `models:publishers` buys nothing and is where this kind of work stalls.
//
// Hand-rolled rather than zod: `dependencies` is a short list of lean packages
// that all ship inside the installer, and this repo already hand-rolls its
// primitives by preference (path-scope.mjs, external-mcp-url.mjs, the PNG
// encoder in index.mjs). A schema library for a handful of call sites does not
// earn its place in the shipped bundle.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import { FIXED_PORTS, serverPortFamily } from '../ports.mjs'

/** Objects only — arrays and null are the two things `typeof x === 'object'` lies about. */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

export function isAbsolutePath(value) {
  return isNonEmptyString(value) && path.isAbsolute(value)
}

/** Absent (undefined/null) is fine; present means it must satisfy `check`. */
export function optional(value, check) {
  return value === undefined || value === null || check(value)
}

/**
 * The head of the escalation chain: this string becomes `spawn()`'s first
 * argument by way of resolveBinary(). Three independent conditions, because
 * each blocks a different thing — a non-string breaks the settings file, a
 * non-.exe is not a thing Windows would launch as a server, and a path that
 * does not exist is one an attacker could create later.
 *
 * @returns {string|null} the reason to refuse, or null if acceptable.
 */
export function binaryPathRejection(value) {
  if (!isNonEmptyString(value)) return 'A binary path must be a non-empty string.'
  if (!path.isAbsolute(value)) return 'A binary path must be absolute.'
  if (path.extname(value).toLowerCase() !== '.exe') return 'A server binary must be an .exe.'
  try {
    if (!fs.statSync(value).isFile()) return 'That path is not a file.'
  } catch {
    return 'That file does not exist.'
  }
  return null
}

/**
 * Refuse a config.port whose port family would take a port Nest already owns.
 *
 * config.port is user-settable and claims THREE ports — itself, +1 for
 * llama-server and +2 for the built-in MCP server (see ports.mjs). The fixed
 * ports are not settable and are bound for the daemon's whole life. So 19081
 * is a perfectly reasonable-looking choice that puts the MCP server on 19083
 * and takes the control plane's socket away from it, and 8763 does the same to
 * the beacon.
 *
 * The failure this prevents is worse than a port clash. The admin listener
 * binds at app start, long before any launch, so the collision does not show up
 * as "the control plane failed to start" — it shows up as the LAUNCH failing,
 * or worse, succeeding while one of its three servers silently did not, with
 * the visible symptom miles from the setting that caused it. Checked at launch
 * for the same reason binaryPathRejection() is checked at resolveBinary(): a
 * value already sitting in a saved profile from a build that predates this
 * check has never been through it.
 *
 * @returns {string|null} the reason to refuse, or null if acceptable.
 */
export function serverPortRejection(port) {
  if (!Number.isInteger(port)) return 'A port must be a whole number.'
  if (port < 1 || port > 65535) return 'A port must be between 1 and 65535.'

  for (const { port: claimed, what } of serverPortFamily(port)) {
    if (claimed > 65535) {
      return `Port ${port} leaves no room for ${what} on ${claimed} — the highest usable port is 65533.`
    }
    const owner = FIXED_PORTS[claimed]
    if (owner) {
      return claimed === port
        ? `Port ${port} is reserved for ${owner}.`
        : `Port ${port} puts ${what} on ${claimed}, which is reserved for ${owner}.`
    }
  }

  return null
}
