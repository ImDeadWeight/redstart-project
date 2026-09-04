'use strict'

// =============================================================================
// Redstart Nest — llama-server process supervision
// =============================================================================
// Replaces killOrphanedServers()'s `taskkill /F /IM llama-server.exe`, which
// ran at every startup AND every quit and killed every llama-server on the
// machine by image name — including one the user started themselves in a
// terminal for unrelated work. Its own justification was also wrong on the
// facts: it claimed a stale llama-server "holds port 19080", but llama-server
// binds config.port + 1 (llama-args.mjs); 19080 is the in-process gateway and
// can never be stale.
//
// This tracks the specific child PID Nest itself spawned, in a PID file beside
// Nest's other state, and only ever acts on THAT pid — never a blanket sweep by
// name.
//
// No native dependencies: a Windows job object would be the stronger
// mechanism (the OS reaps children even if the parent is hard-killed), but
// this tree carries none by deliberate choice (see auth.mjs's header on why
// password hashing is scrypt via the built-in crypto module rather than a
// native KDF) and adding the first one for this would be the wrong trade.
//
// The accepted tradeoff: unlike a job object, a hard-killed Nest (Task
// Manager, power loss) leaves the child running until the NEXT startup's
// cleanup finds it via the PID file. That gap is deliberate, not
// invisible — reapStaleProcess() is what closes it, and it is why the
// startup call is not optional.
// =============================================================================

import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

function pidFilePath(dir) {
  return path.join(dir, 'llama-server.pid')
}

/**
 * Record the PID of the llama-server Nest just spawned. Called right after
 * spawn(); if the process fails to actually start, the error/exit handlers in
 * ipc/server.mjs clean this file up, same as a normal exit does.
 */
export function writePidFile(dir, { pid, binaryPath, startedAt }) {
  try {
    fs.writeFileSync(pidFilePath(dir), JSON.stringify({ pid, binaryPath, startedAt }))
  } catch (err) {
    // Best-effort: worst case a future startup can't reap this one specific
    // orphan. Not worth failing the launch over.
    console.warn('[process-supervision] could not write pid file:', err.message)
  }
}

export function deletePidFile(dir) {
  try {
    fs.unlinkSync(pidFilePath(dir))
  } catch {
    /* already gone — fine, this is called from multiple cleanup paths */
  }
}

export function readPidFile(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(pidFilePath(dir), 'utf8'))
    if (typeof data.pid !== 'number' || typeof data.binaryPath !== 'string') return null
    return data
  } catch {
    return null
  }
}

/**
 * Kill one specific process (and its tree, where the platform supports it).
 * Never by name — only ever a pid this module itself recorded or verified,
 * which is the entire point of this file existing.
 */
export async function killByPid(pid, { tree = true } = {}) {
  if (process.platform === 'win32') {
    const args = ['/F', '/PID', String(pid)]
    if (tree) args.push('/T')
    try {
      await execFileAsync('taskkill', args)
    } catch {
      /* already gone, or never existed — not worth surfacing */
    }
    return
  }
  // POSIX: the spawn call in ipc/server.mjs must use { detached: true } for a
  // negative pid (process-group kill) to reach the whole tree here.
  try {
    process.kill(tree ? -pid : pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

/**
 * Does a live process with this pid still exist, and is it plausibly the one
 * we launched? PID reuse is real — after enough process churn, `pid` can
 * belong to something else entirely, and killing on nothing more than a
 * matching number would be exactly the class of bug this module replaces. So
 * this checks the image name too, and refuses to act if it can't confirm the
 * match.
 */
export async function isLikelyOurProcess(pid, expectedBinaryPath) {
  const expectedName = path.basename(expectedBinaryPath).toLowerCase()
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
      const line = stdout.trim()
      if (!line || line.startsWith('INFO:')) return false // "no tasks match" case
      const name = line.split('","')[0]?.replace(/^"/, '').toLowerCase()
      return name === expectedName
    } catch {
      return false
    }
  }
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'comm='])
    const name = stdout.trim().toLowerCase()
    return name === expectedName || name.endsWith('/' + expectedName)
  } catch {
    return false
  }
}

/**
 * Startup cleanup. If a previous session left a PID file behind — a crash,
 * a kill from Task Manager, power loss, anything that skipped the normal
 * server:stop / before-quit path — verify the recorded pid is still that
 * same binary before reaping it, then always clear the file either way. A
 * mismatch means the pid was recycled by something unrelated; leave it alone.
 */
export async function reapStaleProcess(dir) {
  const recorded = readPidFile(dir)
  deletePidFile(dir) // stale either way, whether or not anything gets killed below
  if (!recorded) return
  if (await isLikelyOurProcess(recorded.pid, recorded.binaryPath)) {
    await killByPid(recorded.pid)
  }
}
