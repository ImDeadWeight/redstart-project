'use strict'

// =============================================================================
// Redstart Nest — the system tray (Phase 7 §7.3)
// =============================================================================
// Nothing in the tree used Electron's Tray before this. Design decision 10
// already settled its framing: the tray is a CLIENT affordance, not the
// daemon — it holds no state of its own (decision 14). Everything it shows
// (model running/stopped) is read from the same admin:get-status shape
// ipc/admin.mjs's getFullStatus() already returns, via the same
// server:started/server:stopped events the launcher UI subscribes to
// (event-broker.mjs, Phase 5 §5.1) — so the tray tracks a model launched
// from a phone or a browser tab exactly like one launched from this window,
// and can never show something the admin UI disagrees with because nothing
// computes the answer twice.
//
// No state of its own also means: this module never reads or writes
// serverState directly, never calls stopServer() itself — it is handed
// callbacks by index.mjs (the daemon-side glue that already has serverState
// and app in scope) and only decides WHEN to call them and what label to
// show while running.
// =============================================================================

import { Tray, Menu } from 'electron'
import { subscribeToEvents } from './event-broker.mjs'
import { logEvent } from './logger.mjs'

let tray = null
let modelRunning = false
let currentHandlers = null

function buildMenu({ onOpen, onStopModel, onQuit }) {
  const template = [
    { label: 'Open Redstart', click: onOpen },
    { type: 'separator' },
    // Non-interactive status line (design decision 14's "tooltip carries the
    // same status" partner) — disabled so it reads as a label, not a button.
    { label: modelRunning ? 'Model: running' : 'Model: stopped', enabled: false },
  ]
  if (modelRunning) {
    template.push({ label: 'Stop model', click: onStopModel })
  }
  template.push({ type: 'separator' })
  template.push({ label: 'Quit Redstart', click: onQuit })
  return Menu.buildFromTemplate(template)
}

function refresh() {
  if (!tray || !currentHandlers) return
  tray.setToolTip(`Redstart — ${modelRunning ? 'model running' : 'model stopped'}`)
  tray.setContextMenu(buildMenu(currentHandlers))
}

/**
 * @param {object} opts
 * @param {import('electron').NativeImage} opts.icon a 16px-appropriate icon
 *   (the caller resizes the shared redstart icon — no separate asset yet;
 *   see docs/notes/headless-admin-plane-implementation.md §7.3).
 * @param {() => void} opts.onOpen create-or-focus the window (left-click,
 *   Windows convention — right-click shows the context menu, which Electron
 *   already does on its own once setContextMenu() is called, no extra
 *   wiring needed for that half).
 * @param {() => void} opts.onStopModel stop the running llama-server.
 * @param {() => void} opts.onQuit the ONE deliberate-quit path this module
 *   offers — expected to set the caller's isQuitting flag before calling
 *   app.quit() (index.mjs §7.2's isQuitting, consumed here for the first
 *   time).
 * @param {boolean} opts.initiallyRunning seed state from serverState at
 *   startup, so the tray never has to guess before its first event.
 * @returns {() => void} teardown — unsubscribes from the broker and
 *   destroys the tray icon.
 */
export function startTray({ icon, onOpen, onStopModel, onQuit, initiallyRunning }) {
  modelRunning = !!initiallyRunning
  currentHandlers = { onOpen, onStopModel, onQuit }

  tray = new Tray(icon)
  tray.on('click', onOpen)
  refresh()

  const unsubscribe = subscribeToEvents((channel) => {
    if (channel === 'server:started') {
      modelRunning = true
      refresh()
    } else if (channel === 'server:stopped') {
      modelRunning = false
      refresh()
    }
  })

  logEvent('app', 'tray_started', {})

  return function stopTray() {
    unsubscribe()
    tray?.destroy()
    tray = null
    currentHandlers = null
  }
}
