'use strict'

// =============================================================================
// Redstart Nest — the ports Nest owns
// =============================================================================
// FIXED ports (beacon 8765, admin listener 19083, embedding server 19084) are
// chosen by Nest and bound for the daemon's lifetime. DERIVED ports are
// config.port and the two ports arithmetically downstream of it — llama-server
// on +1, the built-in MCP server on +2 — so a user setting config.port to 19081
// would put the MCP server on 19083 and steal the admin listener's socket.
// Note that 19082 collides with TWO fixed ports at once, which is why the
// rejection message names every collision rather than the first one. serverPortRejection()
// in ipc/validate.mjs is the enforcement point; this module is the map it reads.
//
// serverPortFamily() below is deliberately a SECOND expression of the +1/+2
// arithmetic (the canonical one lives in llama-args.mjs and ipc/server.mjs) —
// collapsing the two would mean the collision check and the thing it checks
// could never disagree, which is the whole point of checking. The test suite
// is what says so if they drift.
//
// Pure constants: imports nothing, so ipc/validate.mjs can read it without
// growing a dependency on an HTTP server.
// =============================================================================

/** Discovery beacon. See beacon.mjs — Redstart Twig scans for this. */
export const BEACON_PORT = 8765

/**
 * The control plane. Bound at daemon start regardless of whether a
 * llama-server is running, which is what makes it a control plane rather
 * than a feature of the thing it controls.
 */
export const ADMIN_PORT = 19083

/**
 * The embedding server for tool retrieval — a second llama-server, localhost
 * only, CPU only. Reserved unconditionally, whether or not retrieval is
 * enabled: a port that is only claimed while a feature is on is a port a user
 * can be sitting on the day they turn that feature on.
 */
export const EMBED_PORT = 19084

/** config.port's default, duplicated in src/types.ts's DEFAULT_CONFIG. */
export const DEFAULT_GATEWAY_PORT = 19080

/** Every fixed port, mapped to what it is, for error messages. */
export const FIXED_PORTS = Object.freeze({
  [BEACON_PORT]: 'the discovery beacon',
  [ADMIN_PORT]: 'the admin listener',
  [EMBED_PORT]: 'the embedding server',
})

/**
 * A startup bind failure, rewritten to name what actually went wrong.
 *
 * Node's raw text ("address already in use 0.0.0.0:8765") states the
 * mechanism and hides the cause: a second daemon, almost always, since both
 * fixed ports are held for the whole lifetime of whichever one got there
 * first. Matters most headless, where this string is the entire failure
 * report. Returns null for anything it cannot improve on, so callers fall
 * back to the original error.
 *
 * @param {NodeJS.ErrnoException & { port?: number }} err
 * @returns {string|null}
 */
export function portConflictMessage(err) {
  if (!err || err.code !== 'EADDRINUSE') return null
  const owner = FIXED_PORTS[err.port]
  if (!owner) return null
  return `port ${err.port} (${owner}) is already in use — a Redstart Nest daemon is almost certainly running on this machine already. Stop it before starting another.`
}

/**
 * The three ports a given config.port claims: the gateway, llama-server, and
 * the built-in MCP server.
 *
 * @param {number} port config.port
 * @returns {{ port: number, what: string }[]}
 */
export function serverPortFamily(port) {
  return [
    { port, what: 'the tool gateway' },
    { port: port + 1, what: 'llama-server' },
    { port: port + 2, what: 'the built-in MCP server' },
  ]
}
