'use strict'

// =============================================================================
// Redstart Nest — the terminal's executable allowlist (agent-runtime plan D16,
// D17; Phase 4 calls P4-a, P4-b)
// =============================================================================
// An admin lists the programs run_command may start, by name (`git`) or by
// absolute path. Each entry is resolved HERE, once, when the list is saved,
// and stored as an absolute path. At call time nothing is looked up: the
// model names an entry, and the stored path is what runs. A PATH change, or
// a `git.exe` dropped into a folder earlier on PATH later, changes nothing
// until an admin saves the list again.
//
// Windows batch files (.cmd, .bat) are refused (D17). The one that matters is
// npm (and npx): `npm.cmd` cannot be spawned without cmd.exe, and through
// cmd.exe its arguments can be read as commands (verified 2026-11-10). So an
// `npm` entry resolves to the `node` beside npm and the npm CLI script, which
// shared/command-exec.mjs runs as `node <npm-cli.js> <args>`, no shell.
//
// Pure apart from reading the filesystem; every input that differs by machine
// (PATH, PATHEXT, platform) is a parameter, so the suite runs it on a fake
// layout (scripts/test-terminal-config.mjs).
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'

export const MAX_EXECUTABLES = 32
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/

// The CLI script each node package manager shim stands for.
const NODE_CLIS = { npm: 'npm-cli.js', npx: 'npx-cli.js' }

function isFile(p) {
  try { return fs.statSync(p).isFile() } catch { return false }
}

function isExecutable(p, platform) {
  if (!isFile(p)) return false
  if (platform === 'win32') return true
  try { fs.accessSync(p, fs.constants.X_OK); return true } catch { return false }
}

const isShim = (p, platform) => platform === 'win32' && /\.(cmd|bat)$/i.test(p)

/** The name a resolved file is addressed by: its base name, without a Windows extension. */
export function entryName(file, platform = process.platform) {
  const base = path.basename(file)
  return platform === 'win32' ? base.replace(/\.(exe|com|cmd|bat)$/i, '').toLowerCase() : base
}

/**
 * Every match for a bare name on PATH, in PATH order. Windows tries each
 * PATHEXT extension in each directory, the way cmd.exe does.
 */
function findOnPath(name, { pathEnv, pathExt, platform }) {
  const sep = platform === 'win32' ? ';' : ':'
  const dirs = String(pathEnv ?? '').split(sep).map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter((d) => d && path.isAbsolute(d))
  const exts = platform === 'win32'
    ? String(pathExt || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase()).filter(Boolean)
    : ['']
  const out = []
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      if (isExecutable(candidate, platform)) out.push(candidate)
    }
  }
  return out
}

/**
 * npm or npx, from where its shim is: the `node` in the same folder and the
 * CLI script under it. Windows: <dir>\node_modules\npm\bin\npm-cli.js beside
 * npm.cmd. POSIX: `npm` is a link to .../npm/bin/npm-cli.js, and `node` sits
 * beside the link.
 */
function resolveNodeCli(tool, shimPath, platform) {
  const cli = NODE_CLIS[tool]
  const dir = path.dirname(shimPath)
  const nodeFile = path.join(dir, platform === 'win32' ? 'node.exe' : 'node')
  let script = path.join(dir, 'node_modules', 'npm', 'bin', cli)
  if (platform !== 'win32' && !isFile(script)) {
    try {
      const real = fs.realpathSync(shimPath)
      if (path.basename(real) === cli) script = real
    } catch { /* falls through to the refusal below */ }
  }
  if (!isFile(script)) return { ok: false, reason: `${tool} was found at ${shimPath}, but its CLI script (${cli}) was not found beside it.` }
  if (!isExecutable(nodeFile, platform)) return { ok: false, reason: `${tool} was found at ${shimPath}, but there is no node beside it to run ${cli} with.` }
  return { ok: true, name: tool, file: nodeFile, prefixArgs: [script], dir }
}

/**
 * Resolve one allowlist entry to what run_command will spawn.
 *
 * @param {string} entry a bare name ("git") or an absolute path
 * @param {{ pathEnv?: string, pathExt?: string, platform?: string }} [env]
 * @returns {{ ok: true, entry: string, name: string, file: string, prefixArgs: string[], dir: string } | { ok: false, entry: string, reason: string }}
 */
export function resolveExecutable(entry, { pathEnv = process.env.PATH, pathExt = process.env.PATHEXT, platform = process.platform } = {}) {
  const raw = typeof entry === 'string' ? entry.trim() : ''
  const refuse = (reason) => ({ ok: false, entry: raw, reason })
  if (!raw) return refuse('An executable entry is empty.')
  if (raw.includes('\0')) return refuse('An executable entry contains an invalid character.')

  const pathApi = platform === 'win32' ? path.win32 : path.posix
  let file
  if (pathApi.isAbsolute(raw)) {
    if (!isExecutable(raw, platform)) return refuse(`${raw} is not an executable file on this machine.`)
    file = raw
  } else {
    if (/[\\/]/.test(raw)) return refuse(`"${raw}" is a relative path. Give a bare name to look up on PATH, or an absolute path.`)
    if (!NAME_PATTERN.test(raw)) return refuse(`"${raw}" is not a program name.`)
    const name = platform === 'win32' ? raw.toLowerCase().replace(/\.(exe|com|cmd|bat)$/i, '') : raw
    const found = findOnPath(name, { pathEnv, pathExt, platform })
    if (!found.length) return refuse(`"${raw}" was not found on this machine's PATH. Give its absolute path instead.`)
    // npm and npx: the shim is what identifies the install (P4-b).
    if (NODE_CLIS[name]) {
      const r = resolveNodeCli(name, found[0], platform)
      return r.ok ? { ...r, entry: raw } : refuse(r.reason)
    }
    file = found.find((f) => !isShim(f, platform)) ?? found[0]
  }

  const name = entryName(file, platform)
  if (isShim(file, platform)) {
    if (NODE_CLIS[name]) {
      const r = resolveNodeCli(name, file, platform)
      return r.ok ? { ...r, entry: raw } : refuse(r.reason)
    }
    return refuse(`${path.basename(file)} is a Windows batch file. It can only run through cmd.exe, where its arguments could be read as commands, so it is not supported. Add the program it starts instead.`)
  }
  if (!NAME_PATTERN.test(name)) return refuse(`${path.basename(file)} does not have a name the model could address.`)
  return { ok: true, entry: raw, name, file, prefixArgs: [], dir: path.dirname(file) }
}

/**
 * Resolve a whole list. The first refusal refuses the save (with its reason),
 * so an admin never stores a list in which some entry silently does nothing.
 * Two entries resolving to the same name are refused too: the model could not
 * tell them apart.
 *
 * @param {unknown} entries
 * @param {Parameters<typeof resolveExecutable>[1]} [env]
 */
export function resolveExecutableList(entries, env) {
  if (!Array.isArray(entries)) return { ok: false, reason: 'executables must be a list.' }
  if (entries.length > MAX_EXECUTABLES) return { ok: false, reason: `At most ${MAX_EXECUTABLES} executables.` }
  const out = []
  const names = new Set()
  for (const entry of entries) {
    const r = resolveExecutable(/** @type {string} */ (entry), env)
    if (!r.ok) return { ok: false, reason: r.reason }
    if (names.has(r.name)) return { ok: false, reason: `Two entries are both called "${r.name}".` }
    names.add(r.name)
    out.push({ entry: r.entry, name: r.name, file: r.file, prefixArgs: r.prefixArgs, dir: r.dir })
  }
  return { ok: true, executables: out }
}

/**
 * The stored list, checked again when the tool config is built: an entry
 * whose file has gone (an uninstall) drops out rather than failing at call
 * time. Never re-resolved on PATH.
 *
 * @param {unknown} stored
 */
export function liveExecutables(stored, platform = process.platform) {
  if (!Array.isArray(stored)) return []
  return stored.filter((e) => e && typeof e.name === 'string' && NAME_PATTERN.test(e.name)
    && typeof e.file === 'string' && path.isAbsolute(e.file) && !isShim(e.file, platform) && isFile(e.file)
    && Array.isArray(e.prefixArgs) && e.prefixArgs.every((a) => typeof a === 'string' && isFile(a)))
}

export const TERMINAL_LIMITS = {
  timeoutS: { min: 1, max: 3600 },
  outputCapBytes: { min: 1024, max: 1024 * 1024 },
}
