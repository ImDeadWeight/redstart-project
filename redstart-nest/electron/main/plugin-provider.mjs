'use strict'

// =============================================================================
// Redstart Nest — Plugin provider adapters
// =============================================================================
// Implemented per docs/notes/mcp-plugin-system-tasks.md task T7. Nothing
// imports this module until T8, so it cannot affect a running app yet.
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
import { configDir } from './platform-paths.mjs'
import { listPlugins, getPlugin, updatePlugin, NAMESPACE_SEPARATOR } from './plugin-registry.mjs'
import { createPluginClient } from './mcp-plugin-client.mjs'
import { decryptSecret } from './secrets.mjs'

/** Live clients by plugin id. Created lazily on first call, never at startup. */
const clients = new Map()

function logDir() {
  return path.join(configDir(), 'mcp-plugin-logs')
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
  const existing = clients.get(plugin.id)
  if (existing) return existing

  // Decrypt here, once, at spawn time — this merged env object is the ONLY
  // place a plugin credential exists in plaintext. It goes straight into the
  // client's spawn config and nowhere else (never logged, never returned).
  const env = { ...(plugin.env ?? {}) }
  if (plugin.envEnc) {
    for (const [key, ciphertext] of Object.entries(plugin.envEnc)) {
      env[key] = decryptSecret(ciphertext)
    }
  }

  const client = createPluginClient({
    id: plugin.id,
    command: plugin.resolvedCommand,
    args: plugin.resolvedArgs ?? [],
    env,
    timeoutMs: plugin.timeoutMs,
    logDir: logDir(),
  })
  clients.set(plugin.id, client)
  return client
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
  return plugin.enabled === true && cfg?.[plugin.id]?.enabled === true
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
  const prefix = `${plugin.id}${NAMESPACE_SEPARATOR}`

  return {
    toolDefs(cfg) {
      if (!isActive(plugin, cfg)) return []
      // Tool list comes from the REGISTRY, never the child — toolDefs is
      // synchronous and must answer before any child exists (spec R1/R5).
      // The child's own `annotations` (e.g. a self-declared readOnlyHint) are
      // deliberately dropped: mcp-server.mjs stamps Redstart's own
      // classification via annotateTool(), and a plugin's opinion about
      // itself must never masquerade as that verdict (plan decision D3).
      return plugin.tools.map((t) => ({
        name: `${prefix}${t.name}`,
        description: t.description,
        inputSchema: t.inputSchema,
      }))
    },

    async callTool(name, args, cfg, _ctx) {
      if (typeof name !== 'string' || !name.startsWith(prefix)) return null // not mine — let the next provider try

      if (!isActive(plugin, cfg)) {
        return { isError: true, content: [{ type: 'text', text: `The "${plugin.displayName || plugin.id}" plugin is disabled.` }] }
      }

      const bare = name.slice(prefix.length)
      try {
        const client = clientFor(plugin)
        await client.ensureReady()
        const result = await client.callTool(bare, args ?? {})
        // An in-band isError result (e.g. the server's own "401 Unauthorized")
        // is exactly the wrong-API-key scenario "Verifying an install" layer 4
        // exists for — a thrown exception is not the only way a real call
        // fails, and treating only the transport-level case as unhealthy would
        // leave the single most common credential fault unrecorded.
        if (result?.isError) {
          const detail = result.content?.find((c) => typeof c?.text === 'string')?.text || 'the plugin reported an error'
          updatePlugin(plugin.id, { lastError: detail, lastErrorAt: new Date().toISOString() })
        } else if (plugin.lastError) {
          // A successful call clears any previously recorded health fault —
          // most credential faults only surface on first real use, so a later
          // success is the honest all-clear.
          updatePlugin(plugin.id, { lastError: null, lastErrorAt: null })
        }
        return result
      } catch (err) {
        updatePlugin(plugin.id, { lastError: err.message, lastErrorAt: new Date().toISOString() })
        // mcp-server.mjs does not catch here — an escaping exception would
        // take out the whole request, not just this tool call.
        return { isError: true, content: [{ type: 'text', text: `Plugin error: ${err.message}` }] }
      }
    },

    shutdown() {
      clients.get(plugin.id)?.stop()
    },
  }
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
  return listPlugins().map(makeProvider)
}

/**
 * TODO(T7): stop every running child.
 * Called from stopMcpServer (T8). Without it, plugin children are separate OS
 * processes that outlive the server that spawned them.
 */
export function stopAllPlugins() {
  for (const client of clients.values()) client.stop()
  clients.clear()
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
  for (const [id, client] of clients) {
    const plugin = getPlugin(id)
    // Uninstalled, registry-disabled, or deactivated for this profile — any
    // of the three means this client has no business staying up. Spawning
    // stays lazy (spec R5); this function only ever stops, never starts.
    if (!plugin || !isActive(plugin, cfg)) {
      client.stop()
      clients.delete(id)
    }
  }
}
