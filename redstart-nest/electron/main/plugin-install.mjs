'use strict'

// =============================================================================
// Redstart Nest — Plugin install pipeline
// =============================================================================
// SKELETON. Every function throws until implemented — see
// docs/notes/mcp-plugin-system-tasks.md tasks T15 (install) and T16 (probe +
// uninstall).
//
// Fetches a third-party npm package, works out how to run it, asks it what
// tools it has, and tears it back down. Nothing here decides whether a plugin
// is allowed to do anything — that is the registry entry the admin confirms
// afterwards.
//
// THE SECURITY PROPERTY THIS MODULE EXISTS TO PRESERVE: installing must mean
// FETCH AND INSPECT, not EXECUTE. See the --ignore-scripts note on
// installNpmPackage. If that flag ever comes off, every downstream control in
// the plugin system is guarding a door that has already been walked through.
//
// Long-running and cancellable, so it follows model-download.mjs: an
// AbortSignal, staged work discarded on cancel, and progress reported by
// callback rather than returned at the end.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import { app } from 'electron'
import { detectNpm } from './plugin-runtimes.mjs'
import { createPluginClient } from './mcp-plugin-client.mjs'
import { PLUGIN_ID_PATTERN, getPlugin, removePlugin } from './plugin-registry.mjs'
import { logEvent } from './logger.mjs'

/** Distinct failure reasons. The UI maps them; never merge two into one. */
export const INSTALL_REASON = {
  badId: 'bad-id',
  npmMissing: 'npm-missing',
  packageNotFound: 'package-not-found',
  versionNotFound: 'version-not-found',
  network: 'network',
  installFailed: 'install-failed',
  noEntryPoint: 'no-entry-point',
  cancelled: 'cancelled',
}

/** Distinct probe failures — the taxonomy spec R2 requires. */
export const PROBE_REASON = {
  spawnFailed: 'spawn-failed',
  exitedImmediately: 'exited-immediately',
  notMcp: 'not-mcp',
  handshakeTimeout: 'handshake-timeout',
  noTools: 'no-tools',
}

export function pluginsRoot() {
  return path.join(app.getPath('userData'), 'plugins')
}

// ---------------------------------------------------------------------------
// T15 — install
// ---------------------------------------------------------------------------

/**
 * TODO(T15): install one npm package into its own directory.
 *
 * Steps:
 *   1. Validate `id` against PLUGIN_ID_PATTERN before touching the filesystem.
 *      This value becomes a directory name; an unvalidated one is a path
 *      traversal. Fail with INSTALL_REASON.badId.
 *   2. dir = path.join(pluginsRoot(), id). Write a minimal package.json
 *      ({ name: `redstart-plugin-${id}`, private: true }) so npm treats it as a
 *      project root instead of walking up into Redstart's own tree.
 *   3. detectNpm(); on failure return INSTALL_REASON.npmMissing.
 *   4. Spawn:
 *        process.execPath  <cliPath>  install  <packageName>@<version>
 *            --prefix <dir> --ignore-scripts --no-audit --no-fund --loglevel=error
 *      with env { ELECTRON_RUN_AS_NODE: '1' } and shell: false.
 *
 *      ##################################################################
 *      # --ignore-scripts IS NOT NEGOTIABLE. Do not remove it, do not   #
 *      # make it configurable, do not add an "advanced" override.       #
 *      #                                                                #
 *      # Without it npm runs preinstall/install/postinstall for EVERY    #
 *      # package in the dependency tree, as this user, at install time — #
 *      # before the admin has classified a single tool and before the    #
 *      # plugin is enabled. The trust model ("plugin code runs in a      #
 *      # separate process when you enable it") would simply be false.    #
 *      #                                                                #
 *      # Measured cost: ~15% of sampled npm MCP servers declare an       #
 *      # install hook, but 12 of 16 are one publisher and several are    #
 *      # cosmetic (echo) or already `|| true`. Direct dependencies: 1%.  #
 *      # A package that truly needs its scripts fails HERE, loudly, and  #
 *      # the admin can install it themselves and use the path source.    #
 *      ##################################################################
 *
 *   5. Report progress via onProgress. Honour `signal`: on abort, kill the
 *      child and remove `dir` entirely — a half-installed tree must not be
 *      left behind (model-download.mjs discards its staging file the same way).
 *   6. Resolve the entry point from <dir>/node_modules/<packageName>/package.json:
 *      prefer `bin` (string form, else the first value of the object form),
 *      else `main`. Return it ABSOLUTE. No entry -> INSTALL_REASON.noEntryPoint.
 *   7. Read resolvedVersion + integrity from <dir>/package-lock.json (P4-6).
 *
 * Distinguish `package-not-found` from `version-not-found` from `network` by
 * matching npm's stderr. A single generic "install failed" makes the admin
 * guess, which is exactly what spec R2 forbids.
 *
 * Returned command/args are what the registry stores and the client spawns:
 * process.execPath + [<absolute entry .js>], run with ELECTRON_RUN_AS_NODE=1,
 * shell:false. RESOLVED ONCE, HERE. Never re-resolved at spawn (D5).
 *
 * @param {{id: string, packageName: string, version: string,
 *          onProgress?: (p: object) => void, signal?: AbortSignal}} opts
 * @returns {Promise<{ok: true, dir: string, resolvedVersion: string, integrity: string|null,
 *                    command: string, args: string[]}
 *                 | {ok: false, reason: string, detail?: string}>}
 */
export async function installNpmPackage({ id, packageName, version, onProgress, signal }) {
  throw new Error('TODO(T15): installNpmPackage not implemented')
}

// ---------------------------------------------------------------------------
// T16 — probe
// ---------------------------------------------------------------------------

/**
 * TODO(T16): start the server, ask what it can do, shut it down.
 *
 * createPluginClient() -> ensureReady() -> listTools() -> stop().
 * ALWAYS stop, on every path including failure. Installation must not leave a
 * process running (spec R2).
 *
 * Every returned tool is classified 'destructive' (D3 / D-b). Do NOT read the
 * child's annotations.readOnlyHint — a server's self-declared hints are not
 * trusted for policy. scripts/fixtures/fake-mcp-server.mjs declares
 * readOnlyHint:true on `write_thing` specifically to catch an implementation
 * that does.
 *
 * On failure, distinguish the PROBE_REASON cases and put the tail of the
 * child's stderr log in `detail`. Read that by tailing the log file the
 * supervisor already writes into logDir — do NOT add a callback to
 * shared/mcp-stdio-process.mjs. That module is shared with redstart-twig and
 * has been modified once already (T5); a second change multiplies the risk for
 * no gain.
 *
 * @returns {Promise<{ok: true, tools: object[], serverInfo: object}
 *                 | {ok: false, reason: string, detail?: string}>}
 */
export async function probePlugin({ command, args, env, timeoutMs, logDir }) {
  throw new Error('TODO(T16): probePlugin not implemented')
}

// ---------------------------------------------------------------------------
// T16 — uninstall
// ---------------------------------------------------------------------------

/**
 * TODO(T16): stop the child, delete the folder, remove the entry.
 *
 * ORDER MATTERS AND IS NOT NEGOTIABLE (P4-4):
 *   1. Stop this plugin's client.
 *   2. Try fs.rmSync(dir, { recursive: true, force: true }).
 *   3. REMOVE THE REGISTRY ENTRY WHETHER OR NOT STEP 2 SUCCEEDED.
 *   4. If step 2 failed, append dir to `pendingDeletions` in plugins.json.
 *
 * Windows will not delete files a live process still holds open, and handles
 * are not always released the instant a process exits. Deferring the delete is
 * the standard answer — MoveFileEx(MOVEFILE_DELAY_UNTIL_REBOOT), Chrome's
 * old_chrome.exe rename, and Electron's own updaters all do a version of it.
 *
 * The ordering is the part that matters: an orphaned folder is untidy, but a
 * plugin that still reads as installed because a file was locked is a bug the
 * admin has no way to clear.
 *
 * @param {string} id
 * @returns {Promise<{ok: true, folderRemoved: boolean}>}
 */
export async function uninstallPlugin(id) {
  throw new Error('TODO(T16): uninstallPlugin not implemented')
}

/**
 * TODO(T16): retry the deletions that failed last time. Call once at startup.
 * Best-effort: a still-locked directory stays on the list, and a failure here
 * must never block startup.
 */
export function sweepPendingDeletions() {
  throw new Error('TODO(T16): sweepPendingDeletions not implemented')
}
