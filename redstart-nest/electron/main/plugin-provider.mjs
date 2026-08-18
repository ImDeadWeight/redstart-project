'use strict'

// =============================================================================
// Redstart Nest — Plugin provider adapters
// =============================================================================
// SKELETON. Every function below throws until implemented — see
// docs/notes/mcp-plugin-system-tasks.md task T7. Nothing imports this module
// until T8, so an unfinished file here cannot affect a running app.
//
// Turns registry entries into objects mcp-server.mjs can put in its provider
// list, alongside the nine built-in providers. The contract is the same one
// every provider satisfies:
//
//     toolDefs(cfg) -> Array<{ name, description, inputSchema }>
//     callTool(name, args, cfg, ctx) -> result | null
//
// plus an optional shutdown() this file adds for the child processes.
//
// TWO THINGS THAT MUST NOT DRIFT.
//
// 1. `callTool` returns null to mean "not mine, let the next provider try".
//    That is load-bearing in mcp-server.mjs's dispatch loop. But a DISABLED
//    plugin must return an isError RESULT, not null — falling through would
//    let another provider answer for a capability the admin switched off, and
//    would report "Unknown tool" instead of "that is disabled".
//
// 2. Tool lists come from the REGISTRY, never from the child. toolDefs() is
//    synchronous and tools/list must answer before any child exists — which is
//    the whole reason the install probe captures the tool list up front (spec
//    R1). Children spawn lazily, on first callTool (spec R5), never at startup.
// =============================================================================

import * as path from 'path'
import { app } from 'electron'
import { listPlugins, getPlugin, NAMESPACE_SEPARATOR } from './plugin-registry.mjs'
import { createPluginClient } from './mcp-plugin-client.mjs'
import { decryptSecret } from './secrets.mjs'

/** Live clients by plugin id. Created lazily on first call, never at startup. */
const clients = new Map()

function logDir() {
  return path.join(app.getPath('userData'), 'mcp-plugin-logs')
}

/**
 * TODO(T7): get or create this plugin's client.
 *
 * Decrypt `plugin.envEnc` here — this is the only place a plugin credential
 * exists in plaintext, and it goes straight into the spawn env (plan decision
 * D-f). Never log it, never return it, never put it in an error message.
 *
 * @param {object} plugin registry entry
 */
function clientFor(plugin) {
  throw new Error('TODO(T7): clientFor not implemented')
}

/**
 * TODO(T7): is this plugin live for this request?
 *
 * BOTH switches must be on (plan decision D-a):
 *   1. plugin.enabled === true        — install-level master switch, admin-owned
 *   2. cfg?.[plugin.id]?.enabled      — per-profile activation via activeToolIds,
 *                                       written by buildGatewayConfig (T11)
 *
 * Checking only one is the likeliest bug in this file, and it fails OPEN.
 */
function isActive(plugin, cfg) {
  throw new Error('TODO(T7): isActive not implemented')
}

/**
 * TODO(T7): build one provider adapter for one plugin.
 *
 * toolDefs(cfg):
 *   - [] unless isActive(plugin, cfg)
 *   - otherwise plugin.tools mapped to
 *       { name: `${plugin.id}${NAMESPACE_SEPARATOR}${t.name}`,
 *         description: t.description, inputSchema: t.inputSchema }
 *   - do NOT pass the child's own `annotations` through. mcp-server.mjs stamps
 *     Redstart's classification via annotateTool(); a plugin's self-declared
 *     readOnlyHint must never reach a client looking like our verdict (D3).
 *
 * callTool(name, args, cfg, ctx):
 *   1. not a string, or no `${plugin.id}${NAMESPACE_SEPARATOR}` prefix -> return null EXPLICITLY
 *   2. !isActive -> isError result (NOT null — see the header)
 *   3. strip the prefix: name.slice(plugin.id.length + NAMESPACE_SEPARATOR.length)
 *   4. await client.ensureReady(), then client.callTool(bare, args)
 *   5. catch everything: return
 *      { isError: true, content: [{ type: 'text', text: `Plugin error: ${err.message}` }] }
 *      mcp-server.mjs does not wrap this call — an escaping exception takes out
 *      the request. On failure also record health via updatePlugin(id,
 *      { lastError, lastErrorAt }); clear both on the next success (plan
 *      section "Verifying an install").
 *
 * shutdown(): stop this plugin's client if one exists.
 *
 * @param {object} plugin registry entry
 */
function makeProvider(plugin) {
  throw new Error('TODO(T7): makeProvider not implemented')
}

/**
 * TODO(T7): one adapter per installed plugin, resolved fresh on every call.
 *
 * Called from mcp-server.mjs resolveProviders() at each of the three
 * PROVIDERS sites. Must not be cached in a module-scope const: an install or
 * uninstall has to take effect without restarting Nest (spec R3).
 *
 * Return adapters for ALL installed plugins and let toolDefs/callTool apply
 * the enable checks — not only the enabled ones. A disabled plugin still needs
 * to claim its namespace so a direct call gets "disabled" rather than
 * "unknown tool".
 *
 * @returns {object[]}
 */
export function pluginProviders() {
  throw new Error('TODO(T7): pluginProviders not implemented')
}

/**
 * TODO(T7): stop every running child.
 * Called from stopMcpServer (T8). Without it, plugin children are separate OS
 * processes that outlive the server that spawned them.
 */
export function stopAllPlugins() {
  throw new Error('TODO(T7): stopAllPlugins not implemented')
}

/**
 * TODO(T7): reconcile running children against current config.
 *
 * Stop the client of any plugin that is no longer active (registry-disabled,
 * deactivated for the profile, or uninstalled). Do NOT start anything here —
 * spawning stays lazy (spec R5).
 *
 * Called from createRefreshLiveToolsConfig (T11), which is what makes
 * "disabling a plugin terminates its child" true. Registry state alone does
 * not kill a process.
 *
 * @param {object} cfg from buildGatewayConfig
 */
export function syncPluginProviders(cfg) {
  throw new Error('TODO(T7): syncPluginProviders not implemented')
}
