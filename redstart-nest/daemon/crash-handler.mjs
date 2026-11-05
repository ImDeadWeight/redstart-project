'use strict'

// =============================================================================
// Redstart Nest — crash detection and warning
// =============================================================================
// Explicit decision, made 2026-09-02, superseding a Task-Scheduler-based
// auto-restart idea floated and rejected in review: on a daemon crash, WARN
// — do not auto-restart. Crash-restart-with-backoff is the deployed systemd
// unit's job, and its own reasoning ("a crash-looping service that
// resurrects every time it is killed is its own outage") is exactly why
// that should not arrive on Windows early via a hand-rolled Task Scheduler
// policy nobody is watching. A visible failure with a human in the loop is
// the more honest state for something that is not yet supervised properly.
//
// WHAT THIS CATCHES: only what the process itself can catch before it dies
// — process.on('uncaughtException')/('unhandledRejection'), installed as
// early as possible in index.mjs's whenReady (before path/logger init, so a
// crash during startup itself is caught too). A hard kill (Task Manager,
// taskkill), an OOM kill, or a native-code crash (segfault) get no chance to
// run this at all — those stay silent until someone notices the tray icon
// is gone or the admin UI is unreachable. Named as a real, remaining gap
// rather than solved here; the honest fix is an external watcher (Task
// Scheduler, or a systemd unit), deliberately deferred rather than added
// quietly as a while-I'm-in-here addition.
//
// This module holds only the PURE half — err -> { log fields, notification
// text } — so that mapping is testable without Electron, same seam as
// ipc/admin.mjs's startup reconciliation.
// index.mjs does the actual process.on registration, the logEvent call, the
// Notification, and app.exit(1) — none of which this module touches.
// =============================================================================

/**
 * @param {unknown} err whatever uncaughtException/unhandledRejection handed
 *   us — usually an Error, but unhandledRejection can hand back anything a
 *   promise was rejected with.
 */
export function describeCrash(err) {
  const reason = (err && typeof err === 'object' && typeof err.message === 'string')
    ? err.message
    : String(err ?? 'unknown error')
  return {
    // Passed straight to logEvent('app', 'crash', logFields) — 'reason' is
    // not in logger.mjs's BLOCKED_KEYS, and an error message is exactly the
    // "shape of what happened" the privacy contract asks for, not content.
    logFields: { reason },
    notification: {
      title: 'Redstart Nest stopped unexpectedly',
      body: 'Reopen it from the Start menu to restart the server.',
    },
  }
}
