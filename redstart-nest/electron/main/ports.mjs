'use strict'

// =============================================================================
// Redstart Nest — the ports Nest owns
// =============================================================================
// Two kinds of port live in this app and they behave differently:
//
//   FIXED     Chosen by Nest, never user-settable, bound for the lifetime of
//             the daemon. The beacon (8765) and the admin listener (19083).
//             A client can rely on finding them without being told.
//
//   DERIVED   config.port and the two ports arithmetically downstream of it —
//             llama-server on +1 and the built-in MCP server on +2. The user
//             sets the base, so the whole family moves with it.
//
// Those two facts collide: a user who sets config.port to 19081 puts the MCP
// server on 19083, which is the admin listener's, and the control plane loses
// its socket to the data plane. The rule that stops it is here rather than at
// either listener because it is a statement ABOUT BOTH, and neither one is
// entitled to be the place it lives. serverPortRejection() in ipc/validate.mjs
// is the enforcement point; this module is the map it reads.
//
// The +1/+2 arithmetic still has its canonical homes (llama-args.mjs builds the
// llama-server port, ipc/server.mjs the MCP one). serverPortFamily() below is
// deliberately a SECOND expression of it, used only to ask "which ports would
// this base claim?" — collapsing the two would mean the collision check and the
// thing it checks could never disagree, which is the whole point of checking.
// If they do drift, the test suite is what says so.
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

/** config.port's default, duplicated in src/types.ts's DEFAULT_CONFIG. */
export const DEFAULT_GATEWAY_PORT = 19080

/** Every fixed port, mapped to what it is, for error messages. */
export const FIXED_PORTS = Object.freeze({
  [BEACON_PORT]: 'the discovery beacon',
  [ADMIN_PORT]: 'the admin listener',
})

/**
 * A startup bind failure, rewritten to name what actually went wrong.
 *
 * Node's own text for this is `listen EADDRINUSE: address already in use
 * 0.0.0.0:8765`, which states the mechanism and hides the cause. The cause is
 * almost always a second daemon: both fixed ports are taken for the daemon's
 * whole lifetime, so whoever holds one is the Redstart already running. That
 * matters most headless, where this string is the entire failure report —
 * there is no window and no tray to notice anything.
 *
 * Returns null for anything it cannot improve on, so callers fall back to the
 * original error rather than losing detail to a guess.
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
