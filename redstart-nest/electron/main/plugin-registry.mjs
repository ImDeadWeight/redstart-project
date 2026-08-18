'use strict'

// =============================================================================
// Redstart Nest — Installed MCP plugin registry
// =============================================================================
// SKELETON. Every function below throws until implemented — see
// docs/notes/mcp-plugin-system-tasks.md task T4. Nothing imports this module
// until T12, so an unfinished file here cannot affect a running app.
//
// Persistent record of third-party stdio MCP servers an admin has installed.
// One JSON file in userData, same storage pattern as tools-storage.mjs (import
// `app`, resolve the path lazily, atomic writes) — the test suites swap
// `electron` for scripts/electron-stub.mjs via a resolve hook, so the
// conventional import is what makes this testable under plain node.
//
// WHAT THIS MODULE IS FOR. A plugin is a capability (plan decision D1), and
// capability identity is resolved from here: tools-definitions.mjs calls
// pluginCapabilities() through setPluginCapabilityProvider() to answer
// capabilityForTool(), classifyTool(), capabilityIds() and
// expandDisabledToolIds() for plugin tool names.
//
// VALIDATION IS THE POINT. A registry entry decides what a third-party process
// is allowed to do — which tools it advertises, what class each one is, whether
// writes and deletes are permitted. A half-parsed entry is therefore DROPPED,
// never repaired: guessing at the intent of a corrupt record is guessing at a
// permission grant. readJsonOr already preserves an unparseable file as
// <name>.corrupt, so a human still has something to recover from.
// =============================================================================

import * as path from 'path'
import { app } from 'electron'
import { readJsonOr, writeJsonAtomic } from './json-store.mjs'
import { logEvent } from './logger.mjs'

// Plugin tools are advertised as `<pluginId>__<toolName>`. DOUBLE underscore:
// single would be ambiguous against the many built-in names that already
// contain one (read_text_file, postgres_query), and capabilityForTool() has to
// parse the prefix back out.
//
// tools-definitions.mjs deliberately hardcodes this separator rather than
// importing it — that module is imported BY this one (for the built-in id list
// below), so importing back would be circular. If you change it here, change
// the comment and the indexOf('__') in capabilityForTool() too.
export const NAMESPACE_SEPARATOR = '__'

/** Tool classes an admin may assign. Mirrors TOOL_CLASS in tools-definitions.mjs. */
export const VALID_TOOL_CLASSES = new Set(['read', 'write', 'destructive', 'network'])

/** Lowercase, underscore-separated, 2–32 chars. Also used as the namespace prefix. */
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9_]{1,31}$/

export const DEFAULT_TIMEOUT_MS = 15_000
export const MIN_TIMEOUT_MS = 1_000
export const MAX_TIMEOUT_MS = 120_000

function getPath() {
  return path.join(app.getPath('userData'), 'plugins.json')
}

function read() {
  return readJsonOr(getPath(), { plugins: [] })
}

function write(data) {
  writeJsonAtomic(getPath(), data)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Is this entry safe to trust as a permission record?
 *
 * Rules (all required — see T4):
 *   - id matches PLUGIN_ID_PATTERN
 *   - id does not contain NAMESPACE_SEPARATOR
 *   - id collides with no built-in capability id, no CLIENT_APPS id ('twig'),
 *     and no built-in tool name
 *   - every tools[].class is in VALID_TOOL_CLASSES
 *   - timeoutMs is a number within [MIN_TIMEOUT_MS, MAX_TIMEOUT_MS]
 *   - enabled / allowWrite / allowDestructive are booleans
 *
 * Import the built-in id and tool-name sources from tools-definitions.mjs.
 * Do NOT import capabilityToolNames() for the collision check — that function
 * includes plugins, so a plugin would collide with itself on every re-read.
 * Use the BUILTIN_* exports.
 *
 * @param {object} entry
 * @returns {{ ok: true, plugin: object } | { ok: false, error: string }}
 *   On success returns the NORMALISED entry (defaults applied), not the input.
 */
export function validatePlugin(entry) {
  throw new Error('TODO(T4): validatePlugin not implemented')
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Every installed plugin that survives validation.
 *
 * An entry that fails is dropped and logged with
 * logEvent('plugin', 'invalid_entry', { plugin: <id> }) — never repaired, and
 * never allowed to abort the read of the others.
 *
 * @returns {object[]}
 */
export function listPlugins() {
  throw new Error('TODO(T4): listPlugins not implemented')
}

/** @param {string} id @returns {object|null} */
export function getPlugin(id) {
  throw new Error('TODO(T4): getPlugin not implemented')
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** @param {object} plugin @returns {{ok: true} | {ok: false, error: string}} */
export function addPlugin(plugin) {
  throw new Error('TODO(T4): addPlugin not implemented')
}

/**
 * Merge `patch` into an existing entry, re-validate the RESULT, then write.
 * Validating the merged entry rather than the patch is what stops a partial
 * update producing a record that would have been rejected on install.
 *
 * @param {string} id @param {object} patch
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function updatePlugin(id, patch) {
  throw new Error('TODO(T4): updatePlugin not implemented')
}

/** @param {string} id @returns {{ok: true}} */
export function removePlugin(id) {
  throw new Error('TODO(T4): removePlugin not implemented')
}

// ---------------------------------------------------------------------------
// Capability projection — the bridge into tools-definitions.mjs
// ---------------------------------------------------------------------------

/**
 * Namespaced tool names and admin-assigned classes, keyed by plugin id.
 *
 * INCLUDES DISABLED PLUGINS. This is deliberate and it is the thing most
 * likely to be "fixed" into a bug. This projection feeds the IDENTITY and
 * CLASSIFICATION layer — capabilityForTool(), classifyTool(), capabilityIds()
 * and expandDisabledToolIds(). Filtering to enabled plugins here would mean a
 * disabled plugin's tools classify as unknown, its id vanishes from the roles
 * editor so an admin cannot pre-restrict it before switching it on, and a ban
 * on its id expands to nothing.
 *
 * Enablement is enforced in the two places that already do it correctly:
 * plugin-provider.mjs toolDefs() and buildGatewayConfig().
 *
 * @returns {Record<string, { toolNames: string[], classes: Record<string, string> }>}
 */
export function pluginCapabilities() {
  throw new Error('TODO(T4): pluginCapabilities not implemented')
}
