'use strict'

// =============================================================================
// Redstart Nest — llama-server's own output, persisted
// =============================================================================
// A SEPARATE stream from logger.mjs's event log, and deliberately so.
// logger.mjs records the SHAPE of what happened (JSONL, privacy-filtered —
// BLOCKED_KEYS strips path/dir/file/url and more); llama-server's stdout is
// mostly paths and config, which is exactly what that filter exists to keep
// out. Routing process output through logEvent() would either gut the
// privacy filter or gut the process log. Two files, two contracts — do not
// merge them.
//
// THREE PIECES:
//  1. An in-memory ring buffer (~1000 lines) — what a late-joining SSE client
//     replays on connect, so reopening the admin page after a crash shows the
//     crash rather than a blank terminal.
//  2. One plain-text file PER LAUNCH, not one continuous file — "show me the
//     log from the run that died" is the question people actually ask, and a
//     continuous file makes you hunt for the boundary.
//  3. Caps, following the max-size/max-file shape Docker's json-file driver
//     uses: 10 runs kept, 5 MB per run (matches logger.mjs's own rotation
//     size), ~50 MB ceiling. A run that hits its cap keeps its NEWEST lines —
//     preserving head-and-tail with an elision marker is better (a failed
//     startup is diagnosed from the beginning, a crash from the end) but is
//     explicitly deferred: nobody may ever produce a 5 MB run, and it is
//     polish once someone does.
//
// No Electron import — plain fs/path, same shape as logger.mjs, so this and
// its test run under plain Node.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'

const RING_LIMIT = 1000
const RUN_LIMIT = 10
const MAX_RUN_BYTES = 5 * 1024 * 1024
const RUN_FILE_RE = /^run-(\d+)\.log$/

let logsDir = null
let ring = []       // plain strings, oldest first, capped at RING_LIMIT
let current = null  // { file, lines: string[], bytes: number, startedAt: number, capped: boolean }

export function initProcessLog(configDir) {
  logsDir = path.join(configDir, 'server-logs')
}

function ensureDir() {
  try { fs.mkdirSync(logsDir, { recursive: true }) } catch (err) { console.warn('[process-log] could not create server-logs:', err.message) }
}

/** The current ring buffer, oldest first — what a reconnecting client replays. */
export function ringBuffer() {
  return ring.slice()
}

function listRunFiles() {
  if (!logsDir) return []
  let entries
  try { entries = fs.readdirSync(logsDir) } catch { return [] }
  // Sortable lexically because the timestamp is a fixed-width decimal
  // (Date.now() only grows), so string sort == chronological sort.
  return entries.filter(f => RUN_FILE_RE.test(f)).sort()
}

function pruneOldRuns() {
  const files = listRunFiles()
  while (files.length > RUN_LIMIT) {
    const oldest = files.shift()
    try { fs.unlinkSync(path.join(logsDir, oldest)) } catch { /* already gone, or a permissions hiccup — not fatal */ }
  }
}

/** Rewrite the run's file from its in-memory line buffer — see rewriteFile(). */
function rewriteFile() {
  try {
    fs.writeFileSync(current.file, current.lines.length ? current.lines.join('\n') + '\n' : '')
  } catch (err) {
    console.warn('[process-log] could not write', current.file, err.message)
  }
}

/**
 * Start a new run's log file. Called once per `llama:launch`. Not idempotent
 * on purpose — calling it twice without an endRun() in between abandons the
 * previous run's in-memory buffer, matching serverState's own "one process at
 * a time" assumption.
 */
export function startRun() {
  if (!logsDir) throw new Error('initProcessLog() was not called before startRun()')
  ensureDir()
  const startedAt = Date.now()
  current = { file: path.join(logsDir, `run-${startedAt}.log`), lines: [], bytes: 0, startedAt, capped: false }
  rewriteFile() // touch the file immediately — an admin looking at server-logs/ during a slow startup should see it exists
  pruneOldRuns()
  return { startedAt, file: current.file }
}

/**
 * Append one line to the ring buffer and the current run's file (if a run is
 * active — a line arriving with no run started, e.g. from a stray late
 * callback, only reaches the ring).
 *
 * CAP BEHAVIOUR: once the run's total would exceed MAX_RUN_BYTES, oldest
 * lines are evicted from the front until it fits again, then (and only then)
 * the file is rewritten whole. The FAST path — every line before a run hits
 * its cap, which is nearly always every line — is a single appendFileSync,
 * not a rewrite; a full rewrite on every line, capped or not, was tried
 * first and made a run's log O(n^2) in its own line count. Once capped, every
 * further line does still cost a full rewrite, which is the traded-off cost
 * this guards against: an admin's log viewer, not a high-throughput sink —
 * the same "not optimized until someone hits it" call the design doc makes
 * about head+tail elision.
 */
export function appendLine(line) {
  ring.push(line)
  if (ring.length > RING_LIMIT) ring.shift()

  if (!current) return

  current.lines.push(line)
  current.bytes += Buffer.byteLength(line, 'utf8') + 1 // +1 for the joining newline

  if (current.bytes <= MAX_RUN_BYTES) {
    try {
      fs.appendFileSync(current.file, line + '\n')
    } catch (err) {
      console.warn('[process-log] could not append to', current.file, err.message)
    }
    return
  }

  current.capped = true
  while (current.bytes > MAX_RUN_BYTES && current.lines.length > 1) {
    const dropped = current.lines.shift()
    current.bytes -= Buffer.byteLength(dropped, 'utf8') + 1
  }
  rewriteFile()
}

/** Mark the run finished. The file stays on disk; only the in-memory line buffer clears. */
export function endRun() {
  current = null
}

/** Test/diagnostic hook. */
export function currentRunFile() {
  return current?.file ?? null
}
