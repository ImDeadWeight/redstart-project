// Plugins IPC namespace — install, remove, classify and govern third-party MCP
// plugins. See docs/notes/mcp-plugin-system-tasks.md task T19.
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
//
// TWO-STEP INSTALL. plugins:install fetches (or resolves) the server and
// probes it — nothing persists. plugins:confirm-install is what writes the
// registry entry, after the admin has reviewed the discovered tools and
// classified them. A single combined call would remove the review step the
// whole classify-then-enable flow depends on (plan spec R2 step 5).
//
// Handler bodies are exported as plain functions (Phase 1, §1.3 of the
// headless-admin-plane implementation plan) so an HTTP route can call them
// directly without dragging IPC registration in — importing this module never
// registers anything; only registerPluginsHandlers() does that.

import * as fs from 'fs'
import * as path from 'path'
import { dialog } from 'electron'
import { configDir } from '../platform-paths.mjs'
import { handle } from './guard.mjs'
import { isPlainObject, isNonEmptyString, optional } from './validate.mjs'
import { logEvent } from '../logger.mjs'
import {
  listPlugins, getPlugin, addPlugin, updatePlugin,
  PLUGIN_ID_PATTERN, VALID_TOOL_CLASSES,
} from '../plugin-registry.mjs'
import { installNpmPackage, installPypiPackage, probePlugin, uninstallPlugin } from '../plugin-install.mjs'
import { encryptSecret, decryptSecret } from '../secrets.mjs'
import { searchRegistry, verdictFor, formFieldsFor } from '../plugin-registry-api.mjs'

function refuse(channel, reason) {
  logEvent('security', 'ipc_argument_rejected', { channel, reason })
  return { ok: false, error: reason }
}

/** One install (or re-probe) at a time, like models.mjs's single active download. */
let activeInstall = null // { id, controller: AbortController }

function pluginLogDir() {
  // Same directory plugin-provider.mjs's logDir() writes into — the install
  // probe and a running plugin's child share one log per id, which is exactly
  // what lets the probe read a stderr tail without a second change to
  // shared/mcp-stdio-process.mjs (Trap 8).
  return path.join(configDir(), 'mcp-plugin-logs')
}

// Mirrors evaluateToolPolicy's plugin branch in mcp-server.mjs exactly: only
// destructive/write are class-gated for a plugin (read/network always pass).
// Kept in sync by test-mcp-capabilities.mjs's ban-propagation suite, which
// drives the real gate end to end against a live plugin.
function isAdvertised(tool, plugin) {
  if (tool.class === 'destructive') return plugin.allowDestructive === true
  if (tool.class === 'write') return plugin.allowWrite === true
  return true
}

/** Never a credential, never envEnc — the projection every list/get shares. */
function projectPlugin(p) {
  return {
    id: p.id,
    displayName: p.displayName || p.id,
    source: p.source ?? null,
    resolvedVersion: p.resolvedVersion ?? null,
    enabled: p.enabled === true,
    allowWrite: p.allowWrite === true,
    allowDestructive: p.allowDestructive === true,
    toolCount: p.tools.length,
    // How many of the discovered tools actually reach tools/list right now,
    // independent of whether any profile has this plugin activated at all —
    // purely a function of classification + this plugin's own write/
    // destructive policy. A fresh install starts every tool 'destructive'
    // (D-b) with both policy flags off, so advertisedCount starts at 0 even
    // though toolCount is honest about what was discovered. Surfaced on the
    // card so "healthy, 40 tools" can no longer read as "40 tools reach the
    // model" when the true number is zero — that gap is what actually
    // happened in production and had no visible signal anywhere.
    advertisedCount: p.tools.filter((t) => isAdvertised(t, p)).length,
    hasSecret: !!(p.envEnc && Object.keys(p.envEnc).length > 0),
    lastError: p.lastError ?? null,
    lastErrorAt: p.lastErrorAt ?? null,
    installedAt: p.installedAt ?? null,
    lastHandshakeAt: p.lastHandshakeAt ?? null,
  }
}

// A 'path' source points at either a directory (resolved the same way an npm
// package's entry point is — prefer `bin`, else `main`) or a file (a .js
// entry run under our own binary, or an executable run directly). No install
// step: the admin already has this on disk.
function resolveLocalSource(target) {
  let stat
  try {
    stat = fs.statSync(target)
  } catch (err) {
    return { ok: false, error: `cannot read "${target}": ${err.message}` }
  }

  if (stat.isDirectory()) {
    const pkgPath = path.join(target, 'package.json')
    if (!fs.existsSync(pkgPath)) return { ok: false, error: `no package.json found in "${target}"` }
    let pkg
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    } catch (err) {
      return { ok: false, error: `"${pkgPath}" is not valid JSON: ${err.message}` }
    }
    let relative = null
    if (typeof pkg.bin === 'string') relative = pkg.bin
    else if (pkg.bin && typeof pkg.bin === 'object') relative = Object.values(pkg.bin)[0]
    if (!relative && typeof pkg.main === 'string') relative = pkg.main
    if (!relative) return { ok: false, error: `"${target}" declares neither "bin" nor "main"` }
    const absolute = path.join(target, relative)
    if (!fs.existsSync(absolute)) return { ok: false, error: `resolved entry point does not exist: ${absolute}` }
    return { ok: true, command: process.execPath, args: [absolute], runAsNode: true }
  }

  if (stat.isFile()) {
    if (target.toLowerCase().endsWith('.js')) {
      return { ok: true, command: process.execPath, args: [target], runAsNode: true }
    }
    return { ok: true, command: target, args: [], runAsNode: false }
  }

  return { ok: false, error: `"${target}" is neither a file nor a directory` }
}

// --- inventory ----------------------------------------------------------

export function listAllPlugins() {
  return listPlugins().map(projectPlugin)
}

export function getPluginDetail(id) {
  if (typeof id !== 'string') return null
  const plugin = getPlugin(id)
  if (!plugin) return null
  return {
    ...projectPlugin(plugin),
    tools: plugin.tools.map((t) => ({ name: t.name, description: t.description, class: t.class })),
  }
}

// --- install --------------------------------------------------------------
//
// Runs the source resolution (npm fetch, or a direct point at a local path
// or command) and the discovery probe, and returns the result for the admin
// to review. Nothing is written to plugins.json here — see the file header.

export async function installPlugin(req, { getWindow }) {
  if (activeInstall) return refuse('plugins:install', 'An install is already in progress.')
  if (!isPlainObject(req)) return refuse('plugins:install', 'plugins:install expects a request object.')

  const { id, source, env, timeoutMs } = req
  if (typeof id !== 'string' || !PLUGIN_ID_PATTERN.test(id)) {
    return refuse('plugins:install', 'Invalid plugin id.')
  }
  if (getPlugin(id)) return refuse('plugins:install', `A plugin with id "${id}" is already installed.`)
  if (!isPlainObject(source) || !['npm', 'pypi', 'command', 'path'].includes(source.kind)) {
    return refuse('plugins:install', 'A valid source (npm, pypi, command, or path) is required.')
  }
  if (!optional(timeoutMs, (v) => typeof v === 'number')) {
    return refuse('plugins:install', 'timeoutMs must be a number.')
  }

  // Values arrive in plaintext for this one round trip — the probe spawns a
  // real child and needs them. Nothing here is written to disk; encryption
  // happens in plugins:confirm-install, the only place a value is persisted.
  const plainEnv = {}
  if (isPlainObject(env)) {
    for (const [key, entry] of Object.entries(env)) {
      if (isPlainObject(entry) && typeof entry.value === 'string') plainEnv[key] = entry.value
    }
  }

  const controller = new AbortController()
  activeInstall = { id, controller }

  const sendProgress = (payload) => {
    const win = getWindow?.()
    if (win && !win.isDestroyed()) win.webContents.send('plugins:install-progress', { id, ...payload })
  }

  try {
    let resolvedCommand, resolvedArgs, resolvedVersion = null, integrity = null, installDir = null, runAsNode = false

    if (source.kind === 'npm') {
      if (!isNonEmptyString(source.packageName) || !isNonEmptyString(source.version)) {
        return refuse('plugins:install', 'An npm source needs a package name and a pinned version.')
      }
      sendProgress({ state: 'resolving', message: 'Checking npm...' })
      const result = await installNpmPackage({
        id, packageName: source.packageName, version: source.version,
        onProgress: sendProgress, signal: controller.signal,
      })
      if (!result.ok) {
        sendProgress({ state: 'error', message: result.detail || result.reason })
        return { ok: false, reason: result.reason, detail: result.detail }
      }
      resolvedCommand = result.command
      resolvedArgs = result.args
      resolvedVersion = result.resolvedVersion
      integrity = result.integrity
      installDir = result.dir
      runAsNode = true // installNpmPackage always returns process.execPath + an entry .js
    } else if (source.kind === 'pypi') {
      // Phase 7. identifier/version, not packageName — pypi's own
      // terminology (matches the registry API's package entries), kept
      // distinct from npm's field name so a source object's shape alone
      // says which resolver it needs.
      if (!isNonEmptyString(source.identifier) || !isNonEmptyString(source.version)) {
        return refuse('plugins:install', 'A pypi source needs a package identifier and a pinned version.')
      }
      sendProgress({ state: 'resolving', message: 'Checking uv...' })
      const result = await installPypiPackage({
        id, identifier: source.identifier, version: source.version,
        onProgress: sendProgress, signal: controller.signal,
      })
      if (!result.ok) {
        sendProgress({ state: 'error', message: result.detail || result.reason })
        return { ok: false, reason: result.reason, detail: result.detail }
      }
      resolvedCommand = result.command
      resolvedArgs = result.args
      resolvedVersion = result.resolvedVersion
      integrity = result.integrity
      installDir = result.dir
      runAsNode = false // uv's own console-script shim IS the executable — no ELECTRON_RUN_AS_NODE wrapping
    } else if (source.kind === 'command') {
      if (!isNonEmptyString(source.command)) return refuse('plugins:install', 'A command source needs a command.')
      resolvedCommand = source.command
      resolvedArgs = Array.isArray(source.args) ? source.args.filter(isNonEmptyString) : []
    } else {
      if (!isNonEmptyString(source.path)) return refuse('plugins:install', 'A path source needs a path.')
      const resolved = resolveLocalSource(source.path)
      if (!resolved.ok) return { ok: false, reason: 'no-entry-point', detail: resolved.error }
      resolvedCommand = resolved.command
      resolvedArgs = resolved.args
      runAsNode = resolved.runAsNode
    }

    if (controller.signal.aborted) return { ok: false, reason: 'cancelled' }

    // process.execPath is Redstart's own binary, not a plain node — it must
    // be told to run as node or it launches another copy of the app instead
    // of speaking MCP. Plaintext, allowlisted (R8), same technique
    // filesystem-mcp-provider.mjs uses for the pinned FS server.
    const spawnEnv = runAsNode ? { ELECTRON_RUN_AS_NODE: '1', ...plainEnv } : plainEnv

    sendProgress({ state: 'probing', message: 'Starting the server to discover its tools...' })
    const probe = await probePlugin({
      command: resolvedCommand,
      args: resolvedArgs,
      env: spawnEnv,
      timeoutMs,
      logDir: pluginLogDir(),
    })
    if (!probe.ok) {
      sendProgress({ state: 'error', message: probe.detail || probe.reason })
      return { ok: false, reason: probe.reason, detail: probe.detail }
    }

    sendProgress({ state: 'done', message: `Connected — ${probe.tools.length} tool${probe.tools.length === 1 ? '' : 's'}.` })
    return {
      ok: true,
      tools: probe.tools,
      resolvedCommand,
      resolvedArgs,
      resolvedVersion,
      integrity,
      installDir,
      runAsNode,
    }
  } finally {
    activeInstall = null
  }
}

export function cancelPluginInstall() {
  if (!activeInstall) return { ok: false, error: 'No install in progress.' }
  activeInstall.controller.abort()
  return { ok: true }
}

export function getPluginInstallStatus() {
  return activeInstall ? { active: true, id: activeInstall.id } : { active: false }
}

export function confirmPluginInstall(entry, { refreshLiveToolsConfig }) {
  if (!isPlainObject(entry)) return refuse('plugins:confirm-install', 'plugins:confirm-install expects an entry object.')
  const {
    id, displayName, source,
    resolvedCommand, resolvedArgs, resolvedVersion, integrity, installDir, runAsNode,
    timeoutMs, tools, env,
  } = entry

  if (typeof id !== 'string' || !PLUGIN_ID_PATTERN.test(id)) return refuse('plugins:confirm-install', 'Invalid plugin id.')
  if (getPlugin(id)) return refuse('plugins:confirm-install', `A plugin with id "${id}" is already installed.`)
  if (!isNonEmptyString(resolvedCommand)) return refuse('plugins:confirm-install', 'Missing resolved command — run plugins:install first.')
  if (!Array.isArray(tools) || tools.length === 0) return refuse('plugins:confirm-install', 'At least one classified tool is required.')
  for (const t of tools) {
    if (!t || typeof t.name !== 'string' || !VALID_TOOL_CLASSES.has(t.class)) {
      return refuse('plugins:confirm-install', `Invalid tool entry for "${t?.name}".`)
    }
  }

  const plainEnv = runAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}
  const envEnc = {}
  if (isPlainObject(env)) {
    for (const [key, e] of Object.entries(env)) {
      if (!isPlainObject(e) || typeof e.value !== 'string' || !e.value) continue
      if (e.isSecret) {
        try {
          envEnc[key] = encryptSecret(e.value)
        } catch (err) {
          // Mirrors Postgres: refuse rather than ever falling back to
          // plaintext storage (open question #3 in the plan).
          return { ok: false, error: err.message }
        }
      } else {
        plainEnv[key] = e.value
      }
    }
  }

  const plugin = {
    id,
    displayName: isNonEmptyString(displayName) ? displayName : id,
    source: isPlainObject(source) ? source : null,
    resolvedCommand,
    resolvedArgs: Array.isArray(resolvedArgs) ? resolvedArgs : [],
    resolvedVersion: typeof resolvedVersion === 'string' ? resolvedVersion : null,
    integrity: typeof integrity === 'string' ? integrity : null,
    installDir: typeof installDir === 'string' ? installDir : null,
    env: plainEnv,
    ...(Object.keys(envEnc).length > 0 ? { envEnc } : {}),
    ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
    tools: tools.map((t) => ({
      name: t.name,
      description: typeof t.description === 'string' ? t.description : '',
      inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : {},
      class: t.class,
    })),
    // Saved disabled regardless of what the renderer sends — enabling is a
    // separate, deliberate act (spec R2 step 5).
    enabled: false,
  }

  const result = addPlugin(plugin)
  if (!result.ok) return { ok: false, error: result.error }
  refreshLiveToolsConfig()
  return { ok: true }
}

// --- lifecycle ------------------------------------------------------------

export function setPluginEnabled(id, enabled, { refreshLiveToolsConfig }) {
  if (typeof id !== 'string') return refuse('plugins:set-enabled', 'id must be a string.')
  if (typeof enabled !== 'boolean') return refuse('plugins:set-enabled', 'enabled must be a boolean.')
  const result = updatePlugin(id, { enabled })
  if (!result.ok) return { ok: false, error: result.error }
  // Terminates the child of a plugin just disabled — registry state alone
  // does not kill a process (Trap 2).
  refreshLiveToolsConfig()
  return { ok: true }
}

export function setPluginToolClass(id, toolName, cls) {
  if (typeof id !== 'string') return refuse('plugins:set-class', 'id must be a string.')
  if (typeof toolName !== 'string') return refuse('plugins:set-class', 'toolName must be a string.')
  if (!VALID_TOOL_CLASSES.has(cls)) return refuse('plugins:set-class', `Invalid class "${cls}".`)
  const plugin = getPlugin(id)
  if (!plugin) return { ok: false, error: `no plugin with id "${id}"` }
  if (!plugin.tools.some((t) => t.name === toolName)) return { ok: false, error: `plugin "${id}" has no tool "${toolName}"` }
  const tools = plugin.tools.map((t) => (t.name === toolName ? { ...t, class: cls } : t))
  const result = updatePlugin(id, { tools })
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true }
}

// Bulk classify — an admin reviewing a 40-tool plugin one dropdown at a
// time is exactly the kind of friction that makes people give up and flip
// allowDestructive instead (which promotes nothing, it just waves every
// tool through regardless of class — see D-c). This still requires a
// deliberate admin action naming every affected tool explicitly; it is
// not a default and does not change what a fresh install starts at (D-b).
export function setPluginToolClasses(id, toolNames, cls) {
  if (typeof id !== 'string') return refuse('plugins:set-classes', 'id must be a string.')
  if (!Array.isArray(toolNames) || toolNames.length === 0 || !toolNames.every(isNonEmptyString)) {
    return refuse('plugins:set-classes', 'toolNames must be a non-empty array of strings.')
  }
  if (!VALID_TOOL_CLASSES.has(cls)) return refuse('plugins:set-classes', `Invalid class "${cls}".`)
  const plugin = getPlugin(id)
  if (!plugin) return { ok: false, error: `no plugin with id "${id}"` }
  const known = new Set(plugin.tools.map((t) => t.name))
  const unknown = toolNames.filter((n) => !known.has(n))
  if (unknown.length > 0) return { ok: false, error: `plugin "${id}" has no tool(s): ${unknown.join(', ')}` }
  const targets = new Set(toolNames)
  const tools = plugin.tools.map((t) => (targets.has(t.name) ? { ...t, class: cls } : t))
  const result = updatePlugin(id, { tools })
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, updated: toolNames.length }
}

export async function uninstallPluginById(id, { refreshLiveToolsConfig }) {
  if (typeof id !== 'string') return refuse('plugins:uninstall', 'id must be a string.')
  const result = await uninstallPlugin(id)
  refreshLiveToolsConfig()
  return result
}

export async function testPlugin(id) {
  if (typeof id !== 'string') return refuse('plugins:test', 'id must be a string.')
  const plugin = getPlugin(id)
  if (!plugin) return { ok: false, message: `No plugin with id "${id}".` }

  const env = { ...(plugin.env ?? {}) }
  if (plugin.envEnc) {
    for (const [key, ciphertext] of Object.entries(plugin.envEnc)) {
      try {
        env[key] = decryptSecret(ciphertext)
      } catch (err) {
        return { ok: false, message: `Could not decrypt stored credentials: ${err.message}` }
      }
    }
  }

  const probe = await probePlugin({
    command: plugin.resolvedCommand,
    args: plugin.resolvedArgs ?? [],
    env,
    timeoutMs: plugin.timeoutMs,
    logDir: pluginLogDir(),
  })

  // Report what was actually verified — a handshake proves the process
  // starts and speaks MCP, nothing about credentials (see "Verifying an
  // install"). Health is recorded either way so the card reflects reality.
  if (!probe.ok) {
    updatePlugin(id, { lastError: probe.detail || probe.reason, lastErrorAt: new Date().toISOString() })
    return { ok: false, message: `${probe.reason}${probe.detail ? `: ${probe.detail}` : ''}` }
  }
  if (plugin.lastError) updatePlugin(id, { lastError: null, lastErrorAt: null })
  return {
    ok: true,
    message: `Connected — ${probe.tools.length} tool${probe.tools.length === 1 ? '' : 's'}. Credentials aren't verified until first use.`,
  }
}

// --- registry browsing ------------------------------------------------------

export async function searchPluginRegistry(opts) {
  const query = isPlainObject(opts) && typeof opts.query === 'string' ? opts.query : ''
  const cursor = isPlainObject(opts) && typeof opts.cursor === 'string' ? opts.cursor : undefined
  const result = await searchRegistry({ query, cursor })
  if (result.error) return { ok: false, error: result.error }

  // Every result gets a verdict — never filtered silently (Phase 4b
  // "Compatibility verdicts"). The renderer decides how to display each state.
  const entries = result.entries.map((entry) => {
    const verdict = verdictFor(entry)
    const fields = verdict.packageRef ? formFieldsFor(verdict.packageRef).fields : []
    return {
      name: entry?.server?.name ?? '(unnamed)',
      description: entry?.server?.description ?? '',
      packageName: verdict.packageRef?.identifier,
      version: verdict.packageRef?.version,
      // Phase 7: the renderer needs this to know which install source kind
      // ('npm' vs 'pypi') to submit when the admin clicks Install on a
      // registry result — the two resolvers are not interchangeable.
      registryType: verdict.packageRef?.registryType,
      verdict: { state: verdict.state, reason: verdict.reason },
      fields,
    }
  })
  return { ok: true, entries, nextCursor: result.nextCursor }
}

export async function pickPluginFolder() {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  return result.canceled ? null : result.filePaths[0]
}

export function registerPluginsHandlers(deps) {
  // --- inventory ----------------------------------------------------------

  handle('plugins:list', () => listAllPlugins())
  handle('plugins:get', (_, id) => getPluginDetail(id))

  // --- install --------------------------------------------------------------

  handle('plugins:install', async (_, req) => installPlugin(req, deps))
  handle('plugins:cancel-install', () => cancelPluginInstall())
  handle('plugins:install-status', () => getPluginInstallStatus())
  handle('plugins:confirm-install', (_, entry) => confirmPluginInstall(entry, deps))

  // --- lifecycle ------------------------------------------------------------

  handle('plugins:set-enabled', (_, id, enabled) => setPluginEnabled(id, enabled, deps))
  handle('plugins:set-class', (_, id, toolName, cls) => setPluginToolClass(id, toolName, cls))
  handle('plugins:set-classes', (_, id, toolNames, cls) => setPluginToolClasses(id, toolNames, cls))
  handle('plugins:uninstall', async (_, id) => uninstallPluginById(id, deps))
  handle('plugins:test', async (_, id) => testPlugin(id))

  // --- registry browsing ------------------------------------------------------

  handle('plugins:search', async (_, opts) => searchPluginRegistry(opts))
  handle('plugins:pick-folder', async () => pickPluginFolder())
}
