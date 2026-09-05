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

/**
 * Handshake and tools/list. A plugin that cannot say hello in fifteen seconds
 * is broken, not busy — there is nothing for it to be doing yet.
 */
export const DEFAULT_TIMEOUT_MS = 15_000
export const MIN_TIMEOUT_MS = 1_000
export const MAX_TIMEOUT_MS = 120_000

/**
 * tools/call, which is a different question entirely: a tool may legitimately
 * be installing an application, fetching model weights or training something.
 *
 * The default is the old MAXIMUM rather than a newly invented number — two
 * minutes was already the longest this system was willing to consider
 * reasonable, so it is the least surprising floor to raise the ordinary case
 * to. The ceiling is ten minutes, for the plugin whose job really does take
 * that long; past it, a tool should be reporting progress rather than blocking
 * a conversation.
 */
export const DEFAULT_CALL_TIMEOUT_MS = 120_000
export const MAX_CALL_TIMEOUT_MS = 600_000

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

/** A tool title is a display string, capped so it cannot dominate a picker row. */
export const MAX_TOOL_TITLE_LENGTH = 64

// A publisher-authored string that lands in the UI, so it is treated the way
// every other piece of untrusted publisher text in this tree is.
//
// What this does NOT try to do: stop a title from being misleading. A plugin
// may legitimately call its tool "Read File", and nothing here can tell that
// apart from one impersonating Redstart's own. Two things carry that weight
// instead — the group header naming the plugin, and the real wire name staying
// visible wherever identity matters (the ban list, any audit view). A title is
// never the thing a decision is made against.
export function sanitizeToolTitle(value) {
  if (typeof value !== 'string') return ''
  const cleaned = value
    // Control characters and every kind of line break: a title is one line,
    // and a newline in a picker row is a way to push the rest of a list off
    // the screen.
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, ' ')
    // Bidi controls reorder rendered text, which is a standing way to make a
    // label render as something other than what it says.
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.slice(0, MAX_TOOL_TITLE_LENGTH)
}

/** A plugin's display name gets the same cap and the same cleaning as a tool title. */
export const MAX_DISPLAY_NAME_LENGTH = 64

/**
 * The name a human reads for a plugin, wherever one is shown.
 *
 * Same treatment as sanitizeToolTitle and for the same reason — it is
 * publisher-authored text that lands in the UI — with one addition: it may not
 * be empty, because an empty display name would render as a blank row rather
 * than as a name, and the caller falls back to the id instead.
 */
export function sanitizeDisplayName(value) {
  return sanitizeToolTitle(value).slice(0, MAX_DISPLAY_NAME_LENGTH)
}

/**
 * A readable name derived from an MCP registry server name, for the servers
 * that publish no `title` of their own.
 *
 * `io.github.artokun/comfyui-mcp` -> `Comfyui MCP`. The publisher half is
 * dropped: it identifies who shipped it, which is what the id is for, and it is
 * the entire reason these names read as machine identifiers in the first place.
 *
 * The acronym list is small and deliberately so. This is a default an admin can
 * overwrite in one field, not a transformation that has to be right — the thing
 * that makes a name correct is that somebody can change it.
 */
const ACRONYMS = new Set(['mcp', 'ai', 'api', 'ui', 'cli', 'db', 'sql', 'http', 'io', 'os', 'pdf', 'gpu'])

export function humanizeServerName(serverName) {
  if (typeof serverName !== 'string' || !serverName.trim()) return ''
  const last = serverName.split('/').pop() ?? ''
  const words = last.split(/[-_.\s]+/).filter(Boolean)
  if (words.length === 0) return ''
  return sanitizeDisplayName(
    words
      .map(w => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
      .join(' '),
  )
}

/**
 * The publisher half of a reverse-DNS server name: the last dotted segment
 * before the slash. `io.github.artokun/comfyui-mcp` -> `artokun`.
 */
export function publisherOf(serverName) {
  if (typeof serverName !== 'string') return ''
  const [scope] = serverName.split('/')
  if (!scope || scope === serverName) return ''
  return sanitizeDisplayName(scope.split('.').pop() ?? '')
}

/**
 * The display name to offer for a server being installed.
 *
 * The registry's own `title` when it has one, otherwise a name derived from the
 * server name. Where that would duplicate a plugin already installed, the
 * publisher is added — two rows both reading "Comfyui MCP" is worse than a
 * long name, because the whole point of a display name is telling them apart.
 *
 * A suggestion, not a rule: it lands in an editable field.
 *
 * @param {{ title?: string, serverName?: string, taken?: Iterable<string> }} args
 * @returns {string}
 */
export function suggestDisplayName({ title, serverName, taken } = {}) {
  const base = sanitizeDisplayName(title) || humanizeServerName(serverName)
  if (!base) return ''
  const used = new Set([...(taken ?? [])].map(n => String(n).toLowerCase()))
  if (!used.has(base.toLowerCase())) return base
  const publisher = publisherOf(serverName)
  return publisher ? sanitizeDisplayName(`${base} (${publisher})`) : base
}

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
 *   - callTimeoutMs is a number within [MIN_TIMEOUT_MS, MAX_CALL_TIMEOUT_MS]
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
      // MCP's optional human-readable label for a tool. Sanitised HERE rather
      // than at render time because validatePlugin runs on every read, so an
      // entry written by an older build — or hand-edited into plugins.json — is
      // cleaned on the way out too, not only on the way in. Same reasoning
      // plugin-moderation-plan.md D3 gives for descriptions.
      title: sanitizeToolTitle(t.title),
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

  let callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS
  if (entry.callTimeoutMs !== undefined) {
    if (typeof entry.callTimeoutMs !== 'number' || !Number.isFinite(entry.callTimeoutMs) ||
        entry.callTimeoutMs < MIN_TIMEOUT_MS || entry.callTimeoutMs > MAX_CALL_TIMEOUT_MS) {
      return { ok: false, error: `plugin "${id}" has an invalid callTimeoutMs "${entry.callTimeoutMs}"` }
    }
    callTimeoutMs = entry.callTimeoutMs
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
    callTimeoutMs,
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
