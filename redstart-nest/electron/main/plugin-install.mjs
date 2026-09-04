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
import { configDir } from './platform-paths.mjs'
import { detectNpm, detectUv } from './plugin-runtimes.mjs'
import { createPluginClient } from './mcp-plugin-client.mjs'
import { PLUGIN_ID_PATTERN, getPlugin, removePlugin } from './plugin-registry.mjs'
import { stopAllPlugins } from './plugin-provider.mjs'
import { readJsonOr, writeJsonAtomic } from './json-store.mjs'
import { logEvent } from './logger.mjs'

/** Distinct failure reasons. The UI maps them; never merge two into one. */
export const INSTALL_REASON = {
  badId: 'bad-id',
  npmMissing: 'npm-missing',
  uvMissing: 'uv-missing', // pypi's equivalent of npmMissing
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
  return path.join(configDir(), 'plugins')
}

// Pulled out of installNpmPackage so `--ignore-scripts` — the one flag in
// this whole module that must never silently go missing — can be asserted on
// directly, against the built argv, without spawning a real npm process.
export function buildNpmInstallArgs({ cliPath, spec, dir }) {
  return [
    cliPath, 'install', spec,
    '--prefix', dir,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
  ]
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
  if (typeof id !== 'string' || !PLUGIN_ID_PATTERN.test(id)) {
    return { ok: false, reason: INSTALL_REASON.badId, detail: `invalid plugin id "${id}"` }
  }
  if (signal?.aborted) return { ok: false, reason: INSTALL_REASON.cancelled }

  const npm = await detectNpm()
  if (!npm.ok) return { ok: false, reason: INSTALL_REASON.npmMissing, detail: npm.reason }

  const dir = path.join(pluginsRoot(), id)

  // A project root of its own — so npm resolves dependencies against THIS
  // directory rather than walking up into Redstart's own package.json.
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: `redstart-plugin-${id}`, private: true }, null, 2) + '\n',
    'utf8',
  )

  const spec = `${packageName}@${version}`
  const args = buildNpmInstallArgs({ cliPath: npm.cliPath, spec, dir })

  onProgress?.({ state: 'installing', message: `Installing ${spec}...` })

  let aborted = false
  const onAbort = () => { aborted = true }
  signal?.addEventListener('abort', onAbort)

  let stderrTail = ''
  const captureStderr = (chunk) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000) // bounded — npm can be chatty even at loglevel=error
  }

  const spawnResult = await new Promise((resolve) => {
    let child
    try {
      child = spawn(process.execPath, args, {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
        shell: false, // real executable under our own binary — no cmd.exe layer (P4-1)
        signal,
      })
    } catch (err) {
      resolve({ ok: false, reason: INSTALL_REASON.installFailed, detail: err.message })
      return
    }

    child.stdout?.on('data', (chunk) => onProgress?.({ state: 'installing', message: chunk.toString('utf8').trim() }))
    child.stderr?.on('data', captureStderr)

    child.on('error', (err) => {
      if (aborted || err.name === 'AbortError' || err.code === 'ABORT_ERR') {
        resolve({ ok: false, reason: INSTALL_REASON.cancelled })
        return
      }
      resolve({ ok: false, reason: INSTALL_REASON.installFailed, detail: err.message })
    })

    child.on('exit', (code) => {
      if (aborted) {
        resolve({ ok: false, reason: INSTALL_REASON.cancelled })
        return
      }
      if (code === 0) {
        resolve({ ok: true })
        return
      }
      resolve({ ok: false, reason: classifyNpmFailure(stderrTail), detail: stderrTail.trim() || `npm exited with code ${code}` })
    })
  })

  signal?.removeEventListener('abort', onAbort)

  if (!spawnResult.ok) {
    // A half-installed tree must not be left behind, on failure or cancel alike.
    fs.rmSync(dir, { recursive: true, force: true })
    logEvent('plugin', 'install_failed', { plugin: id, reason: spawnResult.reason })
    return spawnResult
  }

  onProgress?.({ state: 'resolving', message: 'Resolving entry point...' })

  let entryPoint
  try {
    entryPoint = resolveEntryPoint(dir, packageName)
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true })
    logEvent('plugin', 'install_failed', { plugin: id, reason: INSTALL_REASON.noEntryPoint })
    return { ok: false, reason: INSTALL_REASON.noEntryPoint, detail: err.message }
  }

  const { resolvedVersion, integrity } = readLockfileInfo(dir, packageName)
  logEvent('plugin', 'installed', { plugin: id, version: resolvedVersion })

  return {
    ok: true,
    dir,
    resolvedVersion,
    integrity,
    command: process.execPath,
    args: [entryPoint],
  }
}

// Distinguishes the taxonomy in INSTALL_REASON from npm's own stderr. A
// single generic "install failed" would make the admin guess, which is
// exactly what spec R2 forbids.
function classifyNpmFailure(stderr) {
  if (/\bE404\b/.test(stderr) || /\bnot found\b/i.test(stderr)) return INSTALL_REASON.packageNotFound
  if (/\bETARGET\b/.test(stderr) || /no matching version/i.test(stderr)) return INSTALL_REASON.versionNotFound
  if (/\bENOTFOUND\b|\bECONNREFUSED\b|\bECONNRESET\b|\bETIMEDOUT\b|\bEAI_AGAIN\b/.test(stderr)) return INSTALL_REASON.network
  return INSTALL_REASON.installFailed
}

// `bin` (string, or the first value of the object form) is preferred over
// `main` — an MCP stdio server is normally published as an executable script,
// and `main` alone would resolve to a library entry point that never speaks
// the protocol on its own stdio.
function resolveEntryPoint(dir, packageName) {
  const pkgPath = path.join(dir, 'node_modules', ...packageName.split('/'), 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))

  let relative = null
  if (typeof pkg.bin === 'string') {
    relative = pkg.bin
  } else if (pkg.bin && typeof pkg.bin === 'object') {
    relative = Object.values(pkg.bin)[0]
  }
  if (!relative && typeof pkg.main === 'string') relative = pkg.main
  if (!relative) throw new Error(`"${packageName}" declares neither "bin" nor "main"`)

  const absolute = path.join(path.dirname(pkgPath), relative)
  if (!fs.existsSync(absolute)) throw new Error(`resolved entry point does not exist: ${absolute}`)
  return absolute
}

// npm writes both the resolved version and its integrity hash into
// package-lock.json (P4-6) — read them from there rather than trusting the
// version string the admin typed, which may have been a range.
function readLockfileInfo(dir, packageName) {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'))
    // npm v7+ ("packages" form) is the modern shape; v6 ("dependencies") is a
    // fallback for anything that still writes the old lockfile format.
    const packagesEntry = lock.packages?.[`node_modules/${packageName}`]
    if (packagesEntry) {
      return { resolvedVersion: packagesEntry.version ?? null, integrity: packagesEntry.integrity ?? null }
    }
    const depEntry = lock.dependencies?.[packageName]
    if (depEntry) {
      return { resolvedVersion: depEntry.version ?? null, integrity: depEntry.integrity ?? null }
    }
  } catch {
    // No lockfile, or a shape we don't recognise — not fatal, just less metadata.
  }
  return { resolvedVersion: null, integrity: null }
}

// ---------------------------------------------------------------------------
// Install (pypi, via uv)
// ---------------------------------------------------------------------------
//
// A second resolver alongside installNpmPackage, satisfying the same
// contract (pin at install time, never re-resolve at spawn — D5): given a
// pypi identifier + pinned version, produce a concrete command + args the
// registry stores and the client spawns unchanged forever after.
//
// Structurally different from npm in one way worth being explicit about:
// npm's install step is unconditionally non-executing (--ignore-scripts —
// see the giant warning above installNpmPackage). uv has no equivalent flag,
// because Python packaging has no equivalent hook: `uv tool install` from a
// prebuilt wheel runs no package code at all, but installing from a SOURCE
// distribution invokes that package's own PEP 517 build backend locally to
// produce the wheel it then installs — arbitrary code, inherent to how
// Python packaging works, not something uv can suppress the way npm can
// suppress lifecycle scripts. This is a real, honest asymmetry between the
// two runtimes, not an oversight; see D-e/D-g's own reasoning for why v1
// accepted the equivalent trust boundary on the npm side.

/** Argv construction pulled out for the same reason buildNpmInstallArgs is —
 *  asserted directly against the built array, without spawning a real uv. */
export function buildUvInstallArgs({ spec }) {
  return ['tool', 'install', '--python-preference', 'only-managed', spec]
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Distinguishes the taxonomy in INSTALL_REASON from uv's own stderr, mirroring
// classifyNpmFailure. Verified against real uv 0.10.10 output (2026-08-18):
// a missing package and a missing version both surface as "No solution found
// when resolving dependencies", so the INNER clause is what has to
// distinguish them, and package-not-found must be checked first — its own
// message also contains "no solution found".
function classifyUvFailure(stderr) {
  if (/was not found in the package registry/i.test(stderr)) return INSTALL_REASON.packageNotFound
  if (/no version of .*and you require/i.test(stderr) || /no solution found/i.test(stderr)) return INSTALL_REASON.versionNotFound
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|\bnetwork\b|\bconnection\b/i.test(stderr)) return INSTALL_REASON.network
  return INSTALL_REASON.installFailed
}

/**
 * Install one pypi package as an isolated uv tool, into its own directory.
 *
 * UV_TOOL_DIR/UV_TOOL_BIN_DIR (verified live, not assumed from docs) give uv
 * the same "one dir per plugin" isolation --prefix gives npm — nothing
 * ambient, nothing shared between plugins or with the admin's own machine.
 * uv itself creates the console-script shim (a real .exe on win32, per its
 * own P4-1-equivalent reasoning) — spawn it directly, no process.execPath /
 * ELECTRON_RUN_AS_NODE wrapping the way npm-sourced installs need.
 *
 * @param {{id: string, identifier: string, version: string,
 *          onProgress?: (p: object) => void, signal?: AbortSignal}} opts
 * @returns {Promise<{ok: true, dir: string, resolvedVersion: string, integrity: null,
 *                    command: string, args: string[]}
 *                 | {ok: false, reason: string, detail?: string}>}
 */
export async function installPypiPackage({ id, identifier, version, onProgress, signal }) {
  if (typeof id !== 'string' || !PLUGIN_ID_PATTERN.test(id)) {
    return { ok: false, reason: INSTALL_REASON.badId, detail: `invalid plugin id "${id}"` }
  }
  if (signal?.aborted) return { ok: false, reason: INSTALL_REASON.cancelled }

  const uv = await detectUv()
  if (!uv.ok) return { ok: false, reason: INSTALL_REASON.uvMissing, detail: uv.reason }

  const dir = path.join(pluginsRoot(), id)
  const toolDir = path.join(dir, 'tool')
  const binDir = path.join(dir, 'bin')
  fs.mkdirSync(toolDir, { recursive: true })
  fs.mkdirSync(binDir, { recursive: true })

  const spec = `${identifier}==${version}`
  const args = buildUvInstallArgs({ spec })

  onProgress?.({ state: 'installing', message: `Installing ${spec}...` })

  let aborted = false
  const onAbort = () => { aborted = true }
  signal?.addEventListener('abort', onAbort)

  // uv writes its ENTIRE progress/summary output to stderr — verified live
  // (2026-08-18, uv 0.10.10): stdout is completely empty on both success and
  // failure. That's the opposite of npm's split above, and it's why this is
  // its own capture pair rather than a shared one: the resolved-executable-
  // name parse below reads stderrTail, not stdoutTail.
  let stderrTail = ''
  const captureStderr = (chunk) => {
    const text = chunk.toString('utf8')
    stderrTail = (stderrTail + text).slice(-4000)
    onProgress?.({ state: 'installing', message: text.trim() })
  }

  const spawnResult = await new Promise((resolve) => {
    let child
    try {
      child = spawn(uv.execPath, args, {
        // UV_TOOL_DIR/UV_TOOL_BIN_DIR are what give this install its own
        // isolated directory — without them uv installs into its ambient
        // per-user tool directory, shared across every plugin (and outside
        // Redstart's control entirely).
        env: { ...process.env, UV_TOOL_DIR: toolDir, UV_TOOL_BIN_DIR: binDir },
        windowsHide: true,
        shell: false, // uv.exe is a real executable, not a shim (mirrors P4-1)
        signal,
      })
    } catch (err) {
      resolve({ ok: false, reason: INSTALL_REASON.installFailed, detail: err.message })
      return
    }

    child.stderr?.on('data', captureStderr)

    child.on('error', (err) => {
      if (aborted || err.name === 'AbortError' || err.code === 'ABORT_ERR') {
        resolve({ ok: false, reason: INSTALL_REASON.cancelled })
        return
      }
      resolve({ ok: false, reason: INSTALL_REASON.installFailed, detail: err.message })
    })

    child.on('exit', (code) => {
      if (aborted) {
        resolve({ ok: false, reason: INSTALL_REASON.cancelled })
        return
      }
      if (code === 0) {
        resolve({ ok: true })
        return
      }
      resolve({ ok: false, reason: classifyUvFailure(stderrTail), detail: stderrTail.trim() || `uv exited with code ${code}` })
    })
  })

  signal?.removeEventListener('abort', onAbort)

  if (!spawnResult.ok) {
    fs.rmSync(dir, { recursive: true, force: true })
    logEvent('plugin', 'install_failed', { plugin: id, reason: spawnResult.reason })
    return spawnResult
  }

  onProgress?.({ state: 'resolving', message: 'Resolving entry point...' })

  // uv states exactly which console-script(s) it created on success — parse
  // rather than guess, since a package's script name need not match its pypi
  // identifier. Verified format live: "Installed 1 executable: cowsay" /
  // "Installed 2 executables: pip-compile, pip-sync". On stderr, not stdout
  // (see the capture setup above) — this bit me on the first real run.
  const execMatch = stderrTail.match(/Installed \d+ executables?:\s*(.+)/)
  const names = execMatch ? execMatch[1].split(',').map((s) => s.trim()).filter(Boolean) : []
  if (names.length === 0) {
    fs.rmSync(dir, { recursive: true, force: true })
    logEvent('plugin', 'install_failed', { plugin: id, reason: INSTALL_REASON.noEntryPoint })
    return { ok: false, reason: INSTALL_REASON.noEntryPoint, detail: 'uv reported success but named no installed executable' }
  }
  const entryPath = path.join(binDir, process.platform === 'win32' ? `${names[0]}.exe` : names[0])
  if (!fs.existsSync(entryPath)) {
    fs.rmSync(dir, { recursive: true, force: true })
    logEvent('plugin', 'install_failed', { plugin: id, reason: INSTALL_REASON.noEntryPoint })
    return { ok: false, reason: INSTALL_REASON.noEntryPoint, detail: `expected executable not found: ${entryPath}` }
  }

  // "+ <name>==<version>" is uv's own resolution confirmation — read what it
  // actually resolved (P4-6's principle) rather than trusting the version
  // string the admin typed, which may have been a range. Falls back to the
  // requested version if the line's shape ever drifts — not fatal, just
  // less precise metadata, same posture readLockfileInfo takes on npm's side.
  const resolvedMatch = stderrTail.match(new RegExp(`\\+\\s+${escapeRegExp(identifier)}==(\\S+)`, 'i'))
  const resolvedVersion = resolvedMatch ? resolvedMatch[1] : version

  logEvent('plugin', 'installed', { plugin: id, version: resolvedVersion })

  return {
    ok: true,
    dir,
    resolvedVersion,
    integrity: null, // pypi wheels carry no npm-lockfile-style hash this cheaply readable
    command: entryPath,
    args: [],
  }
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
// Same filename convention shared/mcp-stdio-process.mjs's logStream() uses —
// duplicated rather than imported so this stays a plain file read, never a
// second change to that shared module.
function tailLogFile(logDir, id, maxChars = 2000) {
  if (!logDir) return ''
  try {
    const logPath = path.join(logDir, `${id.replace(/[^a-zA-Z0-9._-]/g, '_')}.log`)
    const text = fs.readFileSync(logPath, 'utf8')
    return text.length > maxChars ? text.slice(-maxChars) : text
  } catch {
    return '' // no log yet, or nothing written — not an error
  }
}

// mcp-plugin-client.mjs's own error messages are the only signal available
// here (it deliberately exposes no exit code / raw transport detail — see its
// header on why it stays a thin transport). Classify by the shape of the
// message; anything unrecognised falls back to 'not-mcp', the catch-all for
// "spawned, didn't crash, never spoke intelligible MCP".
function classifyProbeFailure(err) {
  const msg = err?.message || ''
  if (/^Failed to spawn/.test(msg)) return PROBE_REASON.spawnFailed
  if (/exited$/.test(msg)) return PROBE_REASON.exitedImmediately
  if (/did not respond within/.test(msg)) return PROBE_REASON.handshakeTimeout
  return PROBE_REASON.notMcp
}

export async function probePlugin({ command, args, env, timeoutMs, logDir }) {
  // A synthetic id, local to this one probe — never persisted, never reused
  // as a capability id. Random suffix so two probes run back to back (or
  // concurrently) don't share a log file or a process-manager key.
  const probeId = `probe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const client = createPluginClient({
    id: probeId,
    command,
    args: args ?? [],
    env: env ?? {},
    timeoutMs: timeoutMs ?? 15000,
    logDir,
  })

  try {
    try {
      await client.ensureReady()
    } catch (err) {
      const detail = [err.message, tailLogFile(logDir, probeId)].filter(Boolean).join('\n')
      return { ok: false, reason: classifyProbeFailure(err), detail }
    }

    let tools
    try {
      tools = await client.listTools()
    } catch (err) {
      const detail = [err.message, tailLogFile(logDir, probeId)].filter(Boolean).join('\n')
      return { ok: false, reason: classifyProbeFailure(err), detail }
    }

    if (!Array.isArray(tools) || tools.length === 0) {
      return { ok: false, reason: PROBE_REASON.noTools }
    }

    // Fail closed (D3/D-b): every discovered tool is classified 'destructive'
    // no matter what the child claims about itself. The admin promotes from
    // here, individually, in the Classify step.
    const classified = tools.map((t) => ({
      name: t.name,
      // MCP's optional display label, carried through so the picker can show
      // "Enqueue workflow" instead of "comfyui_mcp__enqueue_workflow". It is
      // taken raw here and sanitised by validatePlugin, which runs on every
      // read — capturing it clean and trusting it thereafter would leave an
      // entry written by any other path unsanitised.
      title: typeof t.title === 'string' ? t.title : '',
      description: typeof t.description === 'string' ? t.description : '',
      inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : {},
      class: 'destructive',
    }))

    // The client is pure transport and does not surface the initialize
    // response's serverInfo (see mcp-plugin-client.mjs) — nothing downstream
    // of the probe currently depends on its contents.
    return { ok: true, tools: classified, serverInfo: {} }
  } finally {
    // Installation must never leave a process running (spec R2) — on every
    // path, success or failure.
    client.stop()
  }
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
function pluginsJsonPath() {
  return path.join(configDir(), 'plugins.json')
}

// Record a directory whose delete failed, for sweepPendingDeletions() to
// retry at next startup. Reads and writes plugins.json's top-level
// `pendingDeletions` field directly (json-store, same primitives
// plugin-registry.mjs itself uses) rather than through that module — it has
// no accessor for a field that lives beside `plugins`, not inside an entry.
function appendPendingDeletion(dir) {
  const data = readJsonOr(pluginsJsonPath(), { plugins: [], pendingDeletions: [] })
  if (!Array.isArray(data.pendingDeletions)) data.pendingDeletions = []
  if (!data.pendingDeletions.includes(dir)) data.pendingDeletions.push(dir)
  writeJsonAtomic(pluginsJsonPath(), data)
}

export async function uninstallPlugin(id) {
  // stopAllPlugins() rather than a per-id stop: plugin-provider.mjs keeps its
  // client map private and exposes no targeted stop, and this task's file
  // list is plugin-install.mjs alone — see docs/notes/mcp-plugin-system-tasks.md
  // T16, which names this as the accepted option. Every plugin's client is
  // lazily recreated on its own next call, so this costs a respawn, not
  // correctness.
  stopAllPlugins()

  const plugin = getPlugin(id)
  const dir = plugin?.installDir ?? path.join(pluginsRoot(), id)

  let folderRemoved = true
  if (fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows will not delete files a still-open handle holds — expected,
      // not exceptional. Checked below via existsSync, not this catch.
    }
    folderRemoved = !fs.existsSync(dir)
  }

  // ORDER MATTERS (P4-4): the registry entry goes regardless of whether the
  // folder delete succeeded. A plugin that still reads as installed because a
  // file was locked is a bug the admin has no way to clear; an orphaned
  // folder is merely untidy, and pendingDeletions exists to clean it up later.
  removePlugin(id)
  if (!folderRemoved) appendPendingDeletion(dir)

  return { ok: true, folderRemoved }
}

/**
 * TODO(T16): retry the deletions that failed last time. Call once at startup.
 * Best-effort: a still-locked directory stays on the list, and a failure here
 * must never block startup.
 */
export function sweepPendingDeletions() {
  try {
    const data = readJsonOr(pluginsJsonPath(), { plugins: [], pendingDeletions: [] })
    const pending = Array.isArray(data.pendingDeletions) ? data.pendingDeletions : []
    if (pending.length === 0) return

    const stillPending = []
    for (const dir of pending) {
      try {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
        if (fs.existsSync(dir)) stillPending.push(dir)
      } catch {
        stillPending.push(dir) // still locked — try again next startup
      }
    }

    if (stillPending.length !== pending.length) {
      data.pendingDeletions = stillPending
      writeJsonAtomic(pluginsJsonPath(), data)
    }
  } catch (err) {
    // Best-effort by design — a sweep failure must never block startup.
    console.warn('[plugin-install] sweepPendingDeletions failed:', err.message)
  }
}
