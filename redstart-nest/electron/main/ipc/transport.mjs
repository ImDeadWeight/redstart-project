'use strict'

// =============================================================================
// Redstart Nest — one handler table, two transports
// =============================================================================
// Every IPC handler BODY is a plain function, and the BINDING comes out too.
// Each ipc/*.mjs module exports a table — `{ 'llama:launch': (config) => ..., ... }`
// — and the two transports consume the same object:
//
//   registerAll(table)        binds it to ipcMain, via guard.mjs's sender check
//   buildAdminApi(deps)       exposes it as routes on the admin listener
//
// WHY NOT JUST RECORD WHAT ipcMain REGISTERED. That was the obvious shortcut and
// it is wrong in the one direction that matters: on the appliance there is no
// ipcMain, so a route table derived from IPC registration would be EMPTY on the
// only platform HTTP-only exists for. The table has to be the
// source and both transports the readers, not one transport the source.
//
// The payoff is that "every RedstartAPI method has a route" stops being a thing
// to check and starts being a thing that is true by construction — the same
// invariant scripts/test-ipc-contract.mjs pins for the preload bridge.
//
// This module is deliberately free of any `electron` import so the table can be
// read on a platform that has none. registerAll() lives in guard.mjs, which is
// the half that does need it.
// =============================================================================

const LOCAL_ONLY = Symbol('redstart.localOnly')

/**
 * Mark a handler as reachable over IPC but NOT over HTTP.
 *
 * For the handlers that act on the CLIENT'S machine rather than the daemon's: a
 * native file picker browses the disk of whoever is looking at the window, and
 * "reveal in explorer" opens a window on it. Identical while client and daemon
 * share a box, wrong the moment the launcher points at a remote Nest — you would
 * pick a path on your laptop and save it as a path on the server. A
 * server-side browser replaces these and gates the native one on "the daemon
 * is local".
 *
 * A marker rather than an exclusion list kept somewhere else, so the fact that a
 * handler is local-only is written at the handler, where someone adding one will
 * see it. The route test refuses a channel that is neither routable nor marked.
 */
export function localOnly(fn) {
  fn[LOCAL_ONLY] = true
  return fn
}

export function isLocalOnly(fn) {
  return !!fn?.[LOCAL_ONLY]
}
