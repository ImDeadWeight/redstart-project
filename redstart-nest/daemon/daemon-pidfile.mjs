'use strict'

// =============================================================================
// The daemon's own pid file
// =============================================================================
// process-supervision.mjs records the pid of the llama-server CHILD, so a
// crashed Nest can reap it at the next start. This is the other one: the pid of
// the daemon ITSELF, so a person can stop it without hunting through Task
// Manager, and so a script can answer "is it already running" without probing
// a port and guessing what answered.
//
// Both entrypoints write it — the Electron desktop app and bin/nestd.mjs — for
// the plain reason that both of them ARE the daemon. Which one is running is
// not a distinction anything reading this file cares about.
//
// WRITTEN LAST, AFTER THE CONTROL PLANE IS BOUND, and that ordering is the
// whole correctness argument. A second daemon that starts while one is already
// running fails at the port bind; if it had written the pid file on the way in,
// it would have overwritten the live daemon's entry and then exited, leaving a
// file pointing at a dead process while the real one kept running. Stop would
// then report "not running" about a daemon that plainly is.
//
// STALENESS IS EXPECTED, not exceptional. A hard kill, an OOM, or a power loss
// all leave the file behind — the same gap process-supervision.mjs was built
// around. So a reader must never trust the number alone: pid reuse is real, and
// after enough process churn that pid belongs to something else entirely.
// isLikelyOurProcess() (borrowed from process-supervision.mjs rather than
// reimplemented, because getting it wrong means killing a stranger) checks the
// image name too and refuses to confirm when it cannot tell.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import { isLikelyOurProcess } from './process-supervision.mjs'

export const DAEMON_PID_FILE = 'nestd.pid'

function pidPath(dir) {
  return path.join(dir, DAEMON_PID_FILE)
}

/**
 * Record this process as the running daemon.
 *
 * Best-effort: a directory that cannot be written is not a reason to refuse to
 * run. The daemon works fine without this file — what is lost is the scripted
 * stop, not the service.
 */
export function writeDaemonPid(dir, { pid = process.pid, execPath = process.execPath, startedAt = Date.now() } = {}) {
  try {
    fs.writeFileSync(pidPath(dir), JSON.stringify({ pid, execPath, startedAt }, null, 2))
    return true
  } catch (err) {
    console.warn('[daemon-pidfile] could not record the daemon pid:', err.message)
    return false
  }
}

export function readDaemonPid(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(pidPath(dir), 'utf8'))
    if (typeof data.pid !== 'number' || typeof data.execPath !== 'string') return null
    return data
  } catch {
    return null
  }
}

export function clearDaemonPid(dir) {
  try {
    fs.unlinkSync(pidPath(dir))
  } catch {
    /* never written, or already gone — both fine, this runs on cleanup paths */
  }
}

/**
 * Is a daemon running in this directory?
 *
 * Four outcomes, and they are deliberately distinguished rather than collapsed
 * into a boolean, because the right thing to DO differs for each:
 *
 *   'stopped'    no pid file. Nothing to stop; start one.
 *   'running'    a live process, and its image matches. Safe to signal.
 *   'stale'      a pid file whose process is gone. Clear it and move on — this
 *                is what a hard kill leaves behind and it is not an error.
 *   'unknown'    a live process whose identity could not be confirmed. Do NOT
 *                signal it. Either the pid was recycled by something unrelated
 *                or the platform query failed, and killing on a matching number
 *                alone is exactly the class of bug process-supervision.mjs
 *                exists to have removed.
 */
export async function daemonStatus(dir) {
  const recorded = readDaemonPid(dir)
  if (!recorded) return { state: 'stopped' }

  let alive = false
  try {
    // Signal 0 tests for existence without delivering anything — the one
    // portable "does this pid exist" check, Windows included.
    process.kill(recorded.pid, 0)
    alive = true
  } catch (err) {
    // EPERM means it exists but belongs to another user, which is still "alive"
    // for our purposes and still something we must not blindly signal.
    alive = err.code === 'EPERM'
  }
  if (!alive) return { state: 'stale', ...recorded }

  const ours = await isLikelyOurProcess(recorded.pid, recorded.execPath)
  return { state: ours ? 'running' : 'unknown', ...recorded }
}
