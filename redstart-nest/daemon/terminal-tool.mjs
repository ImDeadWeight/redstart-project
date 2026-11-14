'use strict'

// =============================================================================
// Redstart Nest — MCP Provider: run_command, the terminal (agent-runtime plan
// Phase 4: D15, D18, D19; U2, U3)
// =============================================================================
// One tool. The model names a program from the admin's allowlist and gives
// its arguments as a list; it gets back the exit code first, then the output,
// then the files the command changed in the conversation workspace.
//
// WHO: the owner account only (U3). A command runs as the daemon's OS user, so
// whatever its working directory it can read every account's files and the
// secrets key: owner-equivalent access to the host. permissions.mjs already
// turns the capability off for everyone else and for auth-off-on-the-LAN;
// this module checks the same again at call time, so a config path that
// forgets the rule still cannot run a command for an admin or a user.
//
// WHAT: only programs an admin listed, as absolute paths resolved when the
// list was saved (terminal-config.mjs). shared/command-exec.mjs spawns them
// with no shell, so an argument is never read as a command.
//
// WHERE: this conversation's workspace (the folder run_python and the
// documents tools share), or a subfolder of it, or a folder the admin listed
// in extraDirs. Every cwd goes through resolveWithinRoot, links included.
// HOME and TEMP are the workspace's `.home` folder (P4-d).
//
// APPROVAL: class 'execute', rule 'prompt', enforced (tools-definitions.mjs).
// The server refuses a call that carries neither an approval nor a standing
// grant for this program and first argument (approval-grants.mjs, 4.5).
//
// NOT A SANDBOX (D20, security.md → Terminal): the command can reach the
// network and anything the OS user can.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import { runCommand, buildEnv } from '../../shared/command-exec.mjs'
import { resolveWithinRoot } from './path-scope.mjs'
import { workspaceDir, workspaceRelative, changedFiles } from './conversation-workspace.mjs'
import { resolveUserScope } from './user-scope.mjs'
import { getAuthRequired } from './auth.mjs'
import { logEvent } from './logger.mjs'
import { fileLink } from './tool-result-links.mjs'

export const TOOL_NAME = 'run_command'
export const MAX_ARGS = 256
export const MAX_ARG_CHARS = 8192
export const HOME_DIR = '.home'
/** Never walked for "Files changed": the command's HOME, and what clones and installs fill. */
export const SKIP_DIRS = [HOME_DIR, '.git', 'node_modules']
const MAX_LINKS = 20

/** conversation key → AbortController of the command running there. */
const running = new Map()

/** Stop every running command (the MCP server is stopping). */
export function stopAllCommands() {
  for (const ac of running.values()) ac.abort()
}

/** For tests: how many commands are running. */
export function runningCount() { return running.size }

function names(cfg) {
  return (cfg?.terminal?.executables ?? []).map((e) => e.name)
}

export function toolDefs(cfg) {
  if (!cfg?.terminal?.enabled) return []
  const allowed = names(cfg)
  if (!allowed.length) return []
  return [{
    name: TOOL_NAME,
    description:
      `Run a program on the Redstart server and get back its exit code, its output and the files it changed. ` +
      `Allowed programs: ${allowed.join(', ')}. ` +
      `Put the program in "command" and each argument as its own string in "args". There is no shell: pipes (|), redirection (>), && and wildcards (*) do not work, and arguments need no quotes. ` +
      `It runs in this conversation's workspace, where the user's attached files are; "cwd" picks a subfolder of it. ` +
      `Check the exit code: anything but 0 means the command failed. The user approves each command unless they always allowed it. ` +
      `Example: {"command": "node", "args": ["--test"], "cwd": "node-project"}`,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: allowed, description: `The program to run: one of ${allowed.join(', ')}.` },
        args: { type: 'array', items: { type: 'string' }, description: 'The arguments, one string each, e.g. ["log", "-3", "--format=%an %s"].' },
        cwd: { type: 'string', description: 'Folder to run in, relative to the conversation workspace. Default: the workspace itself.' },
        timeout_s: { type: 'number', description: `Seconds before the command and everything it started is stopped (default ${cfg.terminal.defaultTimeoutS ?? 60}, max ${cfg.terminal.maxTimeoutS ?? 600}).` },
      },
      required: ['command'],
    },
  }]
}

/**
 * May this caller run a command at all? (U3, P4-c 3.) Null when yes, else the
 * reason, worded for the model to pass on.
 *
 * @param {any} account null only with auth off
 * @param {any} terminalCfg
 */
export function refusalFor(account, terminalCfg) {
  const ownerOnly = 'run_command is only available to the owner account of this Redstart server, because a command can read every account\'s files.'
  if (account) return account.tier === 'owner' ? null : ownerOnly
  // A null account with auth on is a plumbing fault, not a posture
  // (permissions.mjs DENY_ALL): refuse rather than treat it as the owner.
  if (getAuthRequired()) return ownerOnly
  if (terminalCfg?.networkExposed === true) {
    return 'run_command is off: sign-in is off and this server is open to the local network, so every device on it would be the caller. The owner can turn sign-in on, or network mode off.'
  }
  return null
}

function fail(text) {
  return { isError: true, content: [{ type: 'text', text }] }
}

const isDir = (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }

/**
 * The folder a command runs in: the workspace, a folder inside it, or inside
 * an admin-listed extra folder. Every candidate is realpath-checked, so a link
 * in the workspace that points out is refused, not followed.
 */
export function resolveCwd(ws, cwd, extraDirs = []) {
  if (cwd === undefined || cwd === null || cwd === '' || cwd === '.') return { ok: true, dir: ws }
  if (typeof cwd !== 'string') return { ok: false, reason: '"cwd" must be a string.' }
  let dir = null
  try { dir = resolveWithinRoot(ws, cwd) } catch { /* not in the workspace */ }
  if (!dir && path.isAbsolute(cwd)) {
    for (const extra of extraDirs) {
      try { dir = resolveWithinRoot(extra, cwd); break } catch { /* not in this one */ }
    }
  }
  if (!dir) return { ok: false, reason: `"${cwd}" is outside this conversation's workspace. Give a folder inside it, relative to it.` }
  if (!isDir(dir)) return { ok: false, reason: `"${cwd}" is not a folder in this conversation's workspace.` }
  return { ok: true, dir }
}

function seconds(ms) { return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s` }
function kb(n) { return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` }

/**
 * Word a run for the model. The exit code is the FIRST line, because ignoring
 * it is the failure the brainstorm names (D15). Pure; exported for the suite.
 */
export function formatResult({ result, command, args, cwdLabel, timeoutS, files }) {
  const lines = []
  if (result.timedOut) lines.push(`Timed out after ${timeoutS} s; the command and everything it started were stopped.`)
  else if (result.aborted) lines.push('Stopped before it finished; the command and everything it started were stopped.')
  else if (result.exitCode === null) lines.push(`Exit code: none (ended by signal ${result.signal ?? 'unknown'})`)
  else lines.push(`Exit code ${result.exitCode}${result.exitCode === 0 ? '' : ' (failed)'}`)
  lines.push(`Ran: ${[command, ...args].map((a) => (/^[\w./:=@%+,-]+$/.test(a) ? a : JSON.stringify(a))).join(' ')} in ${cwdLabel} (${seconds(result.durationMs)})`)
  const stdout = result.stdout.replace(/\s+$/, '')
  const stderr = result.stderr.replace(/\s+$/, '')
  if (stdout) lines.push(`stdout:\n${stdout}`)
  if (stderr) lines.push(`stderr:\n${stderr}`)
  if (!stdout && !stderr) lines.push('(no output)')
  if (files?.length) lines.push(`Files changed in the workspace: ${files.map((f) => `${f.path} (${kb(f.bytes)})`).join(', ')}`)
  return lines.join('\n')
}

export async function callTool(name, args, cfg, ctx) {
  if (name !== TOOL_NAME) return null
  const t = cfg?.terminal
  if (!t?.enabled) return fail('The terminal is not enabled on this server.')

  const account = ctx?.account ?? null
  const refusal = refusalFor(account, t)
  if (refusal) {
    logEvent('terminal', 'refused', { reason: account ? 'tier' : 'auth-off' })
    return fail(refusal)
  }

  const command = args?.command
  const allowed = t.executables ?? []
  const exe = typeof command === 'string'
    ? allowed.find((e) => e.name === command || (process.platform === 'win32' && e.name === command.toLowerCase().replace(/\.exe$/, '')))
    : null
  if (!exe) {
    return fail(`"${command}" is not a program this server allows. Allowed: ${allowed.map((e) => e.name).join(', ') || 'none'}. Use run_python for anything else.`)
  }

  const argv = args?.args ?? []
  if (!Array.isArray(argv) || !argv.every((a) => typeof a === 'string')) {
    return fail('"args" must be a list of strings, one per argument, e.g. ["status", "--short"].')
  }
  if (argv.length > MAX_ARGS) return fail(`At most ${MAX_ARGS} arguments.`)
  if (argv.some((a) => a.length > MAX_ARG_CHARS || a.includes('\0'))) return fail(`An argument is longer than ${MAX_ARG_CHARS} characters or contains a NUL.`)

  const conversationId = ctx?.conversationId ?? null
  let ws
  try {
    ws = workspaceDir(t.documentsRoot, account, conversationId, { create: true })
  } catch (err) {
    return fail(`Could not open this conversation's workspace: ${err.message}`)
  }
  const where = resolveCwd(ws, args?.cwd, t.extraDirs)
  if (!where.ok) return fail(where.reason)

  const maxS = t.maxTimeoutS ?? 600
  const asked = Number(args?.timeout_s)
  const timeoutS = Math.min(maxS, Math.max(1, Number.isFinite(asked) && asked > 0 ? Math.round(asked) : (t.defaultTimeoutS ?? 60)))

  // One command at a time per conversation (D18): two at once in one folder
  // would race on the same files, and the model would read interleaved results.
  const key = `${resolveUserScope(account)}/${conversationId ?? '_scratch'}`
  if (running.has(key)) return fail('Another command is still running in this conversation. Wait for its result, then run this one.')

  const home = path.join(ws, HOME_DIR)
  try { fs.mkdirSync(home, { recursive: true }) } catch (err) { return fail(`Could not prepare the command's home folder: ${err.message}`) }
  const env = buildEnv({
    pathDirs: allowed.map((e) => e.dir),
    home,
    // Fixed, never model input: git must not wait for a password prompt
    // nobody can answer (stdin is closed), and colour codes are noise.
    extra: { GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' },
  })

  const ac = new AbortController()
  running.set(key, ac)
  const startedAt = Date.now()
  let result
  try {
    result = await runCommand({
      file: exe.file,
      prefixArgs: exe.prefixArgs ?? [],
      args: argv,
      cwd: where.dir,
      env,
      timeoutMs: timeoutS * 1000,
      outputCap: t.outputCapBytes,
      signal: ac.signal,
    })
  } finally {
    running.delete(key)
  }
  if (!result.ok) return fail(result.reason)

  const wsRel = workspaceRelative(conversationId)
  const relCwd = path.relative(ws, where.dir).split(path.sep).join('/')
  const cwdLabel = where.dir === ws ? `the workspace (${wsRel}/)`
    : relCwd && !relCwd.startsWith('..') && !path.isAbsolute(relCwd) ? `${wsRel}/${relCwd}` : where.dir
  const files = changedFiles(ws, startedAt, { skipDirs: SKIP_DIRS })
  const text = formatResult({ result, command: exe.name, args: argv, cwdLabel, timeoutS, files })
  const content = [{ type: 'text', text }]
  for (const f of files.slice(0, MAX_LINKS)) content.push(fileLink(`${wsRel}/${f.path}`, { bytes: f.bytes }))

  // The program's name only: never argv, which can hold anything (logger.mjs
  // privacy contract).
  logEvent('terminal', 'run', {
    executable: exe.name,
    exitCode: result.exitCode ?? undefined,
    timedOut: result.timedOut,
    aborted: result.aborted,
    durationMs: result.durationMs,
    files: files.length,
  })
  const isError = result.timedOut || result.aborted || result.exitCode !== 0
  return { ...(isError ? { isError: true } : {}), content }
}
