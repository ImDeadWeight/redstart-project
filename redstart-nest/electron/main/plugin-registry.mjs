'use strict'

// =============================================================================
// Redstart Nest — Installed MCP plugin registry
// =============================================================================
// Implemented per docs/notes/mcp-plugin-system-tasks.md task T4. Nothing
// imports this module until T12, so it cannot affect a running app yet.
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
import { configDir } from './platform-paths.mjs'
import { readJsonOr, writeJsonAtomic } from './json-store.mjs'
import { logEvent } from './logger.mjs'
import { BUILTIN_CAPABILITY_TOOL_NAMES, CLIENT_APPS, CLIENT_APP_TOOL_NAMES } from './tools-definitions.mjs'

// Collision sets for validatePlugin's id check. Deliberately built from the
// BUILTIN_* exports, not capabilityToolNames()/capabilityIds() — those already
// include installed plugins, so a re-validation of an existing plugin would
// collide with itself on every read.
const BUILTIN_CAPABILITY_IDS = new Set(Object.keys(BUILTIN_CAPABILITY_TOOL_NAMES))
const CLIENT_APP_IDS = new Set(CLIENT_APPS.map((a) => a.id))
const BUILTIN_TOOL_NAMES = new Set([
  ...Object.values(BUILTIN_CAPABILITY_TOOL_NAMES).flat(),
  ...Object.values(CLIENT_APP_TOOL_NAMES).flat(),
])

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
  return path.join(configDir(), 'plugins.json')
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
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, error: 'plugin entry is not an object' }
  }

  const id = entry.id
  if (typeof id !== 'string' || !PLUGIN_ID_PATTERN.test(id)) {
    return { ok: false, error: `invalid plugin id "${id}"` }
  }
  if (id.includes(NAMESPACE_SEPARATOR)) {
    return { ok: false, error: `plugin id "${id}" must not contain "${NAMESPACE_SEPARATOR}" (reserved as the namespace separator)` }
  }
  if (BUILTIN_CAPABILITY_IDS.has(id)) {
    return { ok: false, error: `plugin id "${id}" collides with a built-in capability id` }
  }
  if (CLIENT_APP_IDS.has(id)) {
    return { ok: false, error: `plugin id "${id}" collides with a client-app id` }
  }
  if (BUILTIN_TOOL_NAMES.has(id)) {
    return { ok: false, error: `plugin id "${id}" collides with a built-in tool name` }
  }

  const rawTools = Array.isArray(entry.tools) ? entry.tools : []
  const tools = []
  for (const t of rawTools) {
    if (!t || typeof t.name !== 'string' || !t.name) {
      return { ok: false, error: `plugin "${id}" has a tool with no name` }
    }
    if (!VALID_TOOL_CLASSES.has(t.class)) {
      return { ok: false, error: `plugin "${id}" tool "${t.name}" has an invalid class "${t.class}"` }
    }
    tools.push({
      name: t.name,
      description: typeof t.description === 'string' ? t.description : '',
      inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : {},
      class: t.class,
    })
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS
  if (entry.timeoutMs !== undefined) {
    if (typeof entry.timeoutMs !== 'number' || !Number.isFinite(entry.timeoutMs) ||
        entry.timeoutMs < MIN_TIMEOUT_MS || entry.timeoutMs > MAX_TIMEOUT_MS) {
      return { ok: false, error: `plugin "${id}" has an invalid timeoutMs "${entry.timeoutMs}"` }
    }
    timeoutMs = entry.timeoutMs
  }

  const boolOr = (value, fieldName) => {
    if (value === undefined) return { ok: true, value: false }
    if (typeof value !== 'boolean') return { ok: false, error: `plugin "${id}" field "${fieldName}" must be a boolean` }
    return { ok: true, value }
  }
  const enabledResult = boolOr(entry.enabled, 'enabled')
  if (!enabledResult.ok) return enabledResult
  const allowWriteResult = boolOr(entry.allowWrite, 'allowWrite')
  if (!allowWriteResult.ok) return allowWriteResult
  const allowDestructiveResult = boolOr(entry.allowDestructive, 'allowDestructive')
  if (!allowDestructiveResult.ok) return allowDestructiveResult

  // envEnc holds ciphertext and nothing else — added by T17, accepted and
  // preserved here so an entry written later is not dropped by an older
  // validator.
  if (entry.envEnc !== undefined) {
    if (typeof entry.envEnc !== 'object' || entry.envEnc === null || Array.isArray(entry.envEnc)) {
      return { ok: false, error: `plugin "${id}" has an invalid envEnc` }
    }
    for (const [key, value] of Object.entries(entry.envEnc)) {
      if (typeof value !== 'string') {
        return { ok: false, error: `plugin "${id}" envEnc.${key} is not a string` }
      }
    }
  }

  // Unknown fields are preserved, not stripped — a validator that dropped what
  // it does not recognise would silently erase fields added by later tasks
  // (resolvedVersion, integrity, installDir, lastError, lastErrorAt, ...) on
  // the very next write.
  const plugin = {
    ...entry,
    id,
    tools,
    timeoutMs,
    enabled: enabledResult.value,
    allowWrite: allowWriteResult.value,
    allowDestructive: allowDestructiveResult.value,
  }

  return { ok: true, plugin }
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
  const data = read()
  const rawList = Array.isArray(data.plugins) ? data.plugins : []
  const out = []
  for (const entry of rawList) {
    const result = validatePlugin(entry)
    if (result.ok) {
      out.push(result.plugin)
    } else {
      logEvent('plugin', 'invalid_entry', { plugin: entry?.id, error: result.error })
    }
  }
  return out
}

/** @param {string} id @returns {object|null} */
export function getPlugin(id) {
  return listPlugins().find((p) => p.id === id) ?? null
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** @param {object} plugin @returns {{ok: true} | {ok: false, error: string}} */
export function addPlugin(plugin) {
  const result = validatePlugin(plugin)
  if (!result.ok) return { ok: false, error: result.error }

  const data = read()
  if (!Array.isArray(data.plugins)) data.plugins = []
  if (data.plugins.some((p) => p?.id === result.plugin.id)) {
    return { ok: false, error: `a plugin with id "${result.plugin.id}" is already installed` }
  }

  const now = new Date().toISOString()
  // Defaults first, plugin's own values (if the caller supplied them) win —
  // spread order matters here.
  const stamped = {
    installedAt: now,
    lastHandshakeAt: null,
    lastError: null,
    lastErrorAt: null,
    ...result.plugin,
  }
  data.plugins.push(stamped)
  write(data)
  return { ok: true }
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
  const data = read()
  if (!Array.isArray(data.plugins)) data.plugins = []
  const idx = data.plugins.findIndex((p) => p?.id === id)
  if (idx === -1) return { ok: false, error: `no plugin with id "${id}"` }

  const merged = { ...data.plugins[idx], ...patch, id }
  const result = validatePlugin(merged)
  if (!result.ok) return { ok: false, error: result.error }

  data.plugins[idx] = result.plugin
  write(data)
  return { ok: true }
}

/** @param {string} id @returns {{ok: true}} */
export function removePlugin(id) {
  const data = read()
  data.plugins = (Array.isArray(data.plugins) ? data.plugins : []).filter((p) => p?.id !== id)
  write(data)
  return { ok: true }
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
  const out = {}
  for (const plugin of listPlugins()) {
    const toolNames = []
    const classes = {}
    for (const t of plugin.tools) {
      const namespaced = `${plugin.id}${NAMESPACE_SEPARATOR}${t.name}`
      toolNames.push(namespaced)
      classes[namespaced] = t.class
    }
    out[plugin.id] = { toolNames, classes }
  }
  return out
}
