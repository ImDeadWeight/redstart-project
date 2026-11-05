'use strict'

import { spawn as nodeSpawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

import { buildEmbedArgs } from './llama-args.mjs'
import { logEvent } from './logger.mjs'
import { EMBED_PORT } from './ports.mjs'
import { EMBED_MODEL } from './embed-model.mjs'
import { truncateForEmbedding } from './tool-retrieval.mjs'
import { writePidFile, deletePidFile, reapStaleProcess } from './process-supervision.mjs'

// =============================================================================
// Redstart Nest — the embedding server
// =============================================================================
// The second llama-server: a small embedding model behind tool retrieval. Much
// smaller than ipc/server.mjs's launch — no EMA, no process log, no discovery,
// no gateway — because none of that describes an internal component with no UI
// and no user-visible output.
//
// Its lifetime is tied to the DAEMON, not to whether a chat model is running.
// That is what lets the vector cache warm before the first completion and what
// keeps a tool search answerable while no model is loaded.
//
// INVARIANT — this is never load-bearing. Every failure here (no model, no
// binary, a spawn that dies, a server that never answers) resolves to a status,
// never to a throw. A crashed embedding process must not be able to fail a
// completion: callers fall back to the full post-ban tool list, which is
// today's behaviour byte for byte.
//
// It takes resolveBinary and its directories as ARGUMENTS rather than importing
// them, so nothing here reaches for electron and the headless daemon can start
// it the same way the desktop app does.
// =============================================================================

/**
 * Its own PID file, deliberately not llama-server.pid: reapStaleProcess()
 * verifies a recorded pid against a recorded binary path, and both servers are
 * the same binary — so a shared file would let one server's startup reap the
 * other's live process with the check passing.
 */
export const EMBED_PID_FILE = 'embed-server.pid'

/** @type {{ process: any, pid: number|null, startedAt: number|null, state: string, reason: string|null }} */
const state = {
  process: null,
  pid: null,
  startedAt: null,
  state: 'stopped',
  reason: null,
}

/**
 * How long to keep asking before saying so. Generous: a cold page cache on a
 * slow disk is the case this must not give up on, and giving up costs nothing
 * anyway — the state is a report, and the next embed call will work whenever
 * the server is ready regardless of what this concluded.
 */
const READY_TIMEOUT_MS = 30000
const READY_POLL_MS = 250

/**
 * Watch a freshly spawned server until it answers, then flip 'starting' to
 * 'running'.
 *
 * Uses `/health` rather than an embed call: llama-server returns 503 there
 * while it loads and 200 once it can serve, so readiness is a fact it reports
 * rather than one inferred from a failure. It also keeps embedTexts' one-line-
 * per-outage log out of ordinary startup, which would otherwise record a
 * connection refusal every time the daemon starts.
 *
 * Deliberately NOT awaited by startEmbedServer. Blocking the daemon's start on
 * a model load would make retrieval — an optimization that must never be load
 * bearing — the slowest thing in the boot path.
 */
async function watchUntilReady({ fetchImpl, timeoutMs, pollMs }) {
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs

  while (state.process && state.state === 'starting') {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${EMBED_PORT}/health`, {
        signal: AbortSignal.timeout(1000),
      })
      if (response.ok) {
        state.state = 'running'
        state.reason = null
        logEvent('retrieval', 'embed_server_ready', { ms: Date.now() - startedAt })
        return
      }
    } catch {
      /* refused or timed out — still loading, or gone; the loop decides which */
    }

    if (Date.now() >= deadline) {
      // Stay 'starting': the process is alive and may still come up. Saying
      // 'unavailable' would claim a failure that has not happened.
      state.reason = 'the embedding server has not finished loading the model yet'
      logEvent('retrieval', 'embed_server_slow_start', { ms: Date.now() - startedAt })
      return
    }
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
}

function unavailable(reason) {
  state.process = null
  state.pid = null
  state.startedAt = null
  state.state = 'unavailable'
  state.reason = reason
  return embedServerStatus()
}

/**
 * What the embedding server is doing, as a plain object safe to hand to the
 * control plane.
 *
 * `state` is one of:
 *   'stopped'     — not running, and nothing is wrong; nobody has started it.
 *   'starting'    — spawned, but not yet answering. llama-server accepts the
 *                   connection before it has loaded the model, so this is a
 *                   real interval and not a formality: measured at ~900ms for
 *                   bge-small on a warm page cache.
 *   'running'     — answering. `/health` has returned 200 at least once.
 *   'unavailable' — cannot run, and `reason` says why in a sentence an admin
 *                   can act on. Not an error: retrieval is simply off.
 *
 * 'starting' exists because the first real run of this path found the status
 * lying. The state was set to 'running' the instant spawn() returned, so the
 * Tools tab reported a working sidecar while every embed call was still being
 * refused — which is exactly the "switch reading on for a server doing no
 * retrieval" the control was built to avoid. Nothing was broken by it (the
 * filter fails open and the full tool list goes out), but an admin watching
 * the switch was told the wrong thing.
 */
export function embedServerStatus() {
  return {
    state: state.state,
    reason: state.reason,
    pid: state.pid,
    startedAt: state.startedAt,
    port: EMBED_PORT,
  }
}

/**
 * Start the embedding server. Idempotent, and never throws.
 *
 * @param {{
 *   resolveBinary: () => string,
 *   configDir: string,
 *   modelPath: string|null|undefined,
 *   spawn?: typeof nodeSpawn,
 *   fetchImpl?: typeof fetch,
 *   readyTimeoutMs?: number,
 *   readyPollMs?: number,
 * }} deps
 * @returns {Promise<ReturnType<typeof embedServerStatus>>}
 */
export async function startEmbedServer({
  resolveBinary, configDir, modelPath, spawn = nodeSpawn,
  fetchImpl = fetch, readyTimeoutMs = READY_TIMEOUT_MS, readyPollMs = READY_POLL_MS,
}) {
  if (state.process) return embedServerStatus()

  // A previous session that never ran its exit handler may have left one of
  // these running. Same reasoning as the chat server's startup reap, against
  // this server's own record.
  try {
    await reapStaleProcess(configDir, { name: EMBED_PID_FILE })
  } catch {
    /* best effort — a failed reap must not stop a start */
  }

  // The ordinary case on a fresh install: the model is fetched on first need,
  // not at install, so a user who never enables retrieval never downloads it.
  if (!modelPath || !fs.existsSync(modelPath)) {
    return unavailable('the embedding model has not been downloaded yet')
  }

  let binaryPath
  try {
    binaryPath = resolveBinary()
  } catch (err) {
    return unavailable(`the server binary could not be resolved: ${err.message}`)
  }
  if (!binaryPath || !fs.existsSync(binaryPath)) {
    return unavailable('no llama-server binary was found')
  }

  let child
  try {
    child = spawn(binaryPath, buildEmbedArgs(modelPath, true), {
      // Nothing reads this server's output — it has no log tab and no token
      // counter. Ignoring the pipes means a full stdout buffer can never wedge
      // the process, which is a real failure mode for a child nobody drains.
      stdio: 'ignore',
      cwd: path.dirname(binaryPath),
      // POSIX only: puts the child in its own process group so killByPid's
      // negative-pid signal reaches any grandchildren. Windows uses taskkill /T.
      detached: process.platform !== 'win32',
    })
  } catch (err) {
    return unavailable(`the embedding server could not be started: ${err.message}`)
  }

  child.on('error', err => {
    logEvent('retrieval', 'embed_server_error', { message: err.message })
    deletePidFile(configDir, { name: EMBED_PID_FILE })
    unavailable(`the embedding server failed to start: ${err.message}`)
  })

  child.on('exit', (code, signal) => {
    deletePidFile(configDir, { name: EMBED_PID_FILE })
    state.process = null
    state.pid = null
    state.startedAt = null
    // A clean stop leaves 'stopped'; anything else is a fact an admin may need,
    // and retrieval silently going away is exactly what a status is for.
    if (state.state !== 'stopped') {
      state.state = 'unavailable'
      state.reason = `the embedding server exited (code ${code}, signal ${signal})`
      logEvent('retrieval', 'embed_server_exited', { code, signal })
    }
  })

  state.process = child
  state.pid = child.pid ?? null
  state.startedAt = Date.now()
  // NOT 'running' — see the state list above. It is spawned, not answering.
  state.state = 'starting'
  state.reason = null

  if (child.pid) {
    writePidFile(configDir, { pid: child.pid, binaryPath, startedAt: state.startedAt }, { name: EMBED_PID_FILE })
  }
  logEvent('retrieval', 'embed_server_started', { port: EMBED_PORT })

  // Fire and forget: the status catches up on its own, and nothing waits on it.
  void watchUntilReady({ fetchImpl, timeoutMs: readyTimeoutMs, pollMs: readyPollMs })

  return embedServerStatus()
}

/**
 * Stop the embedding server. Idempotent — called from daemon shutdown, which
 * runs on paths where it was never started.
 *
 * @param {{ configDir: string }} deps
 */
export function stopEmbedServer({ configDir }) {
  const child = state.process
  // Set before the kill, so the exit handler above reads a deliberate stop
  // rather than reporting a crash.
  state.process = null
  state.pid = null
  state.startedAt = null
  state.state = 'stopped'
  state.reason = null
  if (child) {
    try {
      child.kill()
    } catch {
      /* already gone */
    }
    deletePidFile(configDir, { name: EMBED_PID_FILE })
  }
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/**
 * How long one batch of embeddings may take before the request gives up and the
 * caller falls back to the full tool list. Generous for a CPU model on a busy
 * machine, and still an order of magnitude under a chat turn's time to first
 * token, which is what this must never visibly add to.
 */
export const EMBED_TIMEOUT_MS = 5000

// D7's fail-open contract produces exactly one log line per outage rather than
// one per request: a sidecar that is down is down for every request, and a
// per-request line would bury the log under the symptom of a single cause.
let lastFailureReason = null

/**
 * Embed a batch of texts. Returns an array of Float32Array in the SAME ORDER as
 * the input, or null.
 *
 * INVARIANT — this never throws and never rejects. Sidecar down, model absent,
 * connection refused, timeout, malformed JSON, a body with the wrong number of
 * vectors: all of them are null, which callers read as "send the full post-ban
 * tool list". Retrieval is an optimization; there is no failure here that is
 * allowed to become a failed completion.
 *
 * There is deliberately no lexical fallback scorer. A second implementation
 * that disagrees with the first is two behaviours to reason about on a path
 * that should be rare, and the fallback that already exists — every tool the
 * request was going to carry anyway — is both correct and free.
 *
 * @param {string[]} texts
 * @param {{ port?: number, timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<Float32Array[]|null>}
 */
export async function embedTexts(texts, { port = EMBED_PORT, timeoutMs = EMBED_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return []

  // Last line of defence, applied to EVERY caller rather than trusted to each.
  // An input past the model's positional limit is not a degraded embedding, it
  // is a 500 that fails the whole batch — so the one function that knows the
  // server's limits is the one that enforces them.
  const bounded = texts.map(t => truncateForEmbedding(String(t ?? ''), EMBED_MODEL.maxTokens))

  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: bounded }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return failure(`the embedding server answered ${response.status}`)

    const body = await response.json()
    const data = body?.data
    if (!Array.isArray(data) || data.length !== bounded.length) {
      return failure('the embedding server returned a body this client does not understand')
    }

    // The response carries an `index` per row, and llama.cpp is not required to
    // emit them in request order. Place by index rather than by position: a
    // reordered batch would silently attach every tool to the wrong vector,
    // which is the one failure mode here that produces bad results rather than
    // no results.
    const out = new Array(bounded.length)
    for (const row of data) {
      const at = Number.isInteger(row?.index) ? row.index : data.indexOf(row)
      const vector = row?.embedding
      if (at < 0 || at >= bounded.length || !Array.isArray(vector) || vector.length === 0) {
        return failure('the embedding server returned a row with no usable vector')
      }
      out[at] = Float32Array.from(vector)
    }
    if (out.some(v => !v)) return failure('the embedding server skipped a row')

    lastFailureReason = null
    return out
  } catch (err) {
    // AbortSignal.timeout, connection refused, a body that is not JSON.
    return failure(err?.name === 'TimeoutError' ? `no answer within ${timeoutMs}ms` : err?.message ?? 'unknown error')
  }
}

function failure(reason) {
  if (reason !== lastFailureReason) {
    lastFailureReason = reason
    logEvent('retrieval', 'embed_failed', { reason })
  }
  return null
}

/** Test seam: forget the last failure so the once-per-outage log can be re-armed. */
export function resetEmbedFailureLog() {
  lastFailureReason = null
}
