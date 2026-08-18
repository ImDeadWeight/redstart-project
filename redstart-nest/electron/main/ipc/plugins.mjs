// Plugins IPC namespace — install, remove, classify and govern third-party MCP
// plugins. See docs/notes/mcp-plugin-system-tasks.md task T19.
//
// SKELETON. Handlers are registered but every body throws.
//
// Shaped on capabilities.mjs (validate-then-refuse, deps threaded in) and on
// models.mjs (a long-running operation: start / cancel / status handlers plus a
// progress EVENT pushed to the window). Installing a plugin takes 10-60s and
// fails in ways worth showing, so it cannot be a plain request/response call.
//
// TWO RULES THIS FILE MUST NOT BREAK.
//
//   1. Every handler registers through handle() from ./guard.mjs, never
//      ipcMain.handle directly. scripts/test-ipc-guard.mjs fails the build
//      otherwise — a wrapper every handler REMEMBERS to use is a convention,
//      not an invariant.
//
//   2. No projection returns a credential. plugins:list and plugins:get expose
//      `hasSecret: boolean` and nothing else about envEnc — mirroring
//      capabilities:get's hasConnectionString, which test-ipc-contract.mjs
//      already pins. There is no "show current value", ever.
//
// The renderer is untrusted. A generated form is not validation; validate here.

import { handle } from './guard.mjs'
import { isPlainObject, optional } from './validate.mjs'
import { logEvent } from '../logger.mjs'

function refuse(channel, reason) {
  logEvent('security', 'ipc_argument_rejected', { channel, reason })
  return { ok: false, error: reason }
}

/** One install at a time, like models.mjs's single active download. */
let activeInstall = null   // { id, controller: AbortController }

export function registerPluginsHandlers({ refreshLiveToolsConfig, getWindow }) {
  // --- inventory ----------------------------------------------------------

  /**
   * TODO(T19): list installed plugins for the Plugins tab.
   * Project each entry: id, displayName, source, resolvedVersion, enabled,
   * tools.length, lastError, lastErrorAt, and hasSecret. NEVER envEnc.
   */
  handle('plugins:list', () => {
    throw new Error('TODO(T19): plugins:list not implemented')
  })

  /** TODO(T19): one plugin, same projection as plugins:list plus its tool list. */
  handle('plugins:get', (_, id) => {
    throw new Error('TODO(T19): plugins:get not implemented')
  })

  // --- install ------------------------------------------------------------

  /**
   * TODO(T19): run an install.
   *
   * Refuse if activeInstall is set. Create an AbortController, store it, call
   * installNpmPackage() then probePlugin(), and push progress to the window on
   * the plugins:install-progress channel — copy ipc/models.mjs:38 exactly,
   * including its `win && !win.isDestroyed()` guard.
   *
   * NOTE: write that emit only when you also add the matching listener to
   * electron/preload/index.mjs. test-ipc-contract.mjs scans this directory for
   * webContents emit calls and fails if the renderer has no subscriber for one
   * — which is the point, but it means the two halves must land together.
   *
   * DO NOT WRITE A REGISTRY ENTRY HERE. The probe returns discovered tools for
   * the admin to classify; nothing persists until plugins:confirm-install.
   * Installation that self-commits removes the review step that the whole
   * classify-then-enable flow depends on.
   *
   * Secrets arrive in this payload in plaintext. Encrypt with encryptSecret
   * before they touch disk, never log the object, and never echo it back.
   */
  handle('plugins:install', async (_, req) => {
    throw new Error('TODO(T19): plugins:install not implemented')
  })

  /** TODO(T19): abort the active install; the installer removes its partial dir. */
  handle('plugins:cancel-install', () => {
    throw new Error('TODO(T19): plugins:cancel-install not implemented')
  })

  /** TODO(T19): is an install running, and for which plugin? */
  handle('plugins:install-status', () => {
    throw new Error('TODO(T19): plugins:install-status not implemented')
  })

  /**
   * TODO(T19): persist the reviewed entry.
   * Written with enabled:false regardless of what the renderer asks for —
   * enabling is a separate, deliberate act (spec R2 step 5).
   */
  handle('plugins:confirm-install', (_, entry) => {
    throw new Error('TODO(T19): plugins:confirm-install not implemented')
  })

  // --- lifecycle ----------------------------------------------------------

  /**
   * TODO(T19): the registry `enabled` master switch (Plugins tab).
   * NOT per-profile activation — that is activeToolIds on the Tools tab (D-a).
   * Call refreshLiveToolsConfig() afterwards so syncPluginProviders() stops the
   * child of a plugin just disabled.
   */
  handle('plugins:set-enabled', (_, id, enabled) => {
    throw new Error('TODO(T19): plugins:set-enabled not implemented')
  })

  /** TODO(T19): change one tool's admin-assigned class. Validate against VALID_TOOL_CLASSES. */
  handle('plugins:set-class', (_, id, toolName, cls) => {
    throw new Error('TODO(T19): plugins:set-class not implemented')
  })

  /** TODO(T19): uninstallPlugin(), then refreshLiveToolsConfig(). */
  handle('plugins:uninstall', async (_, id) => {
    throw new Error('TODO(T19): plugins:uninstall not implemented')
  })

  /**
   * TODO(T19): re-probe an installed plugin (the Test button).
   *
   * Report what was actually verified. A handshake proves the process starts
   * and speaks MCP; it proves NOTHING about credentials, which are not
   * exercised until a tool runs. Never return a bare success — say
   * "Connected, N tools; credentials are not verified until first use".
   * A green tick that has not tested the credential is worse than no tick,
   * because the admin now holds positive evidence that a broken thing works.
   */
  handle('plugins:test', async (_, id) => {
    throw new Error('TODO(T19): plugins:test not implemented')
  })

  // --- registry browsing --------------------------------------------------

  /** TODO(T19): searchRegistry() + verdictFor() per entry. Return ALL results with verdicts. */
  handle('plugins:search', async (_, opts) => {
    throw new Error('TODO(T19): plugins:search not implemented')
  })
}
