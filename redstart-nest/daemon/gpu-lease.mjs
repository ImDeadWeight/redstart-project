'use strict'

// =============================================================================
// Redstart Nest — the GPU lease (image generation)
// =============================================================================
// One image job holds the GPU at a time. acquireGpu() queues the caller
// (FIFO, abortable while queued), pauses the chat model (ipc/server.mjs
// suspendModel: hold new requests, drain, kill the child only), and hands back
// release(), which resumes it. release() is idempotent and the caller runs it
// in a finally: every path out of an image job — success, throw, abort,
// timeout — gives the model back.
//
// With no model running, the lease pauses nothing and resumes nothing: the
// GPU is free already.
//
// A MARKER FILE (LEASE_MARKER, in the config dir) exists exactly while a lease
// is held. If the daemon dies mid-job (power loss, Task Manager), the next
// start finds it: recoverGpuLease() reaps any sd process left behind and, if a
// model was paused, launches the config that was running (plan decision
// U-IG4: reload the profile's model) — otherwise the box would come back with
// no model and nothing saying why.
//
// Dependencies are injected by initGpuLease() (daemon.mjs), so this module
// imports nothing from ipc/ and the suite can drive it with fakes.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import { logEvent } from './logger.mjs'

export const LEASE_MARKER = 'gpu-lease.json'

/** @type {null | { suspend: Function, resume: Function, markerDir: string, currentConfig: () => object|null }} */
let deps = null
let tail = Promise.resolve()
let held = null

/**
 * @param {{ suspend: (opts: { reason: string }) => Promise<any>, resume: () => Promise<any>, markerDir: string, currentConfig: () => object|null }} d
 */
export function initGpuLease(d) {
  deps = d
  tail = Promise.resolve()
  held = null
}

function markerPath() { return path.join(deps.markerDir, LEASE_MARKER) }

function writeMarker(record) {
  const tmp = markerPath() + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(record))
  fs.renameSync(tmp, markerPath())
}

function removeMarker() {
  try { fs.rmSync(markerPath(), { force: true }) } catch { /* best effort */ }
}

/** What holds the GPU right now, for status: { reason, since, paused } or null. */
export function gpuLeaseHolder() {
  return held ? { reason: held.reason, since: held.since, paused: held.paused } : null
}

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('Cancelled while waiting for the GPU.'), { name: 'AbortError' })
}

/**
 * Take the GPU. Resolves once it is free (the model paused, or none running).
 *
 * @param {{ reason?: string, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ paused: boolean, release: () => Promise<{ ok: boolean, error?: string, ms?: number, skipped?: boolean }> }>}
 * @throws when the model is busy past the drain time, will not exit, or the
 *   caller aborts while queued.
 */
export async function acquireGpu({ reason = 'image generation', signal } = {}) {
  if (!deps) throw new Error('The GPU lease is not initialised.')
  if (signal?.aborted) throw abortError(signal)

  // Queue: wait for whoever is ahead, without letting their failure or our
  // abort break the chain for whoever is behind.
  let releaseTurn
  const turn = new Promise((resolve) => { releaseTurn = resolve })
  const ahead = tail
  tail = ahead.then(() => turn)

  let onAbort
  try {
    await new Promise((resolve, reject) => {
      onAbort = () => reject(abortError(signal))
      signal?.addEventListener('abort', onAbort, { once: true })
      ahead.then(resolve)
    })
  } catch (err) {
    releaseTurn()
    throw err
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }

  const since = Date.now()
  const config = deps.currentConfig?.() ?? null
  try {
    // paused is the INTENT, written before the kill: a daemon that dies
    // mid-pause must still come back with its model.
    writeMarker({ since, reason, daemonPid: process.pid, config: config ? { ...config } : null, paused: config !== null })
  } catch (err) {
    releaseTurn()
    throw new Error(`Could not record the GPU lease: ${err.message}`)
  }

  let result
  try {
    result = await deps.suspend({ reason })
  } catch (err) {
    result = { ok: false, error: err.message }
  }
  const paused = result?.ok === true
  if (!paused && !result?.notRunning) {
    removeMarker()
    releaseTurn()
    throw new Error(result?.error || 'The GPU could not be freed.')
  }
  if (!paused && config !== null) {
    // Nothing was running after all: nothing to bring back.
    try { writeMarker({ since, reason, daemonPid: process.pid, config: null, paused: false }) } catch { /* the first marker stands */ }
  }
  held = { reason, since, paused }
  logEvent('gpu', 'lease_acquired', { reason, paused })

  let released = null
  const release = () => {
    if (released) return released
    released = (async () => {
      let r = { ok: true, skipped: true }
      try {
        if (paused) r = await deps.resume()
      } catch (err) {
        r = { ok: false, error: err.message }
      } finally {
        held = null
        removeMarker()
        logEvent('gpu', 'lease_released', { reason, paused, ok: r?.ok !== false, ms: Date.now() - since })
        releaseTurn()
      }
      return r
    })()
    return released
  }
  return { paused, release }
}

/**
 * At daemon start: a marker means the daemon died holding the lease. Remove
 * it, let the caller reap image processes, and relaunch the model that was
 * paused. Never throws.
 *
 * @param {{ markerDir: string, reap?: () => Promise<void>, relaunch?: (config: object) => Promise<{ success: boolean, error?: string }> }} opts
 * @returns {Promise<{ found: boolean, relaunched?: boolean, error?: string }>}
 */
export async function recoverGpuLease({ markerDir, reap, relaunch }) {
  const file = path.join(markerDir, LEASE_MARKER)
  let record = null
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return { found: false }
    // Unreadable: still a lease that was never released.
  }
  try { fs.rmSync(file, { force: true }) } catch { /* best effort */ }
  try { await reap?.() } catch { /* best effort */ }
  logEvent('gpu', 'lease_recovered', { paused: !!record?.paused })
  if (!record?.paused || !record.config || !relaunch) return { found: true, relaunched: false }
  try {
    const r = await relaunch(record.config)
    if (!r?.success) return { found: true, relaunched: false, error: r?.error }
    return { found: true, relaunched: true }
  } catch (err) {
    return { found: true, relaunched: false, error: err.message }
  }
}
