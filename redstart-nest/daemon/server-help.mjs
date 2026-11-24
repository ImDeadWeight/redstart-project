'use strict'

// ---------------------------------------------------------------------------
// What a llama-server binary accepts, read from its own --help
// ---------------------------------------------------------------------------
// The bundled engine is upstream llama.cpp; a custom path can point at a
// TurboQuant+ build or an older upstream one. Their flags differ in two places
// a profile reaches, and getting either wrong stops llama-server at startup:
//
//   cache types   upstream lists no turbo* types       (see kv-cache.mjs)
//   mmap off      upstream b12651 replaced --mmap/--no-mmap with
//                 -lm/--load-mode MODE ("none" = no mmap); an older or
//                 TurboQuant+ build only knows --no-mmap. Each build rejects
//                 the other's form ("error: invalid argument: --no-mmap").
//
// probeServerHelp() runs `llama-server --help` once per binary (keyed on path,
// size and mtime, so a replaced binary is probed again) and answers both.
// ---------------------------------------------------------------------------

import * as fs from 'fs'
import * as path from 'path'
import { parseCacheTypes } from './kv-cache.mjs'

const HELP_TIMEOUT_MS = 30_000

// How each build turns memory-mapping off. buildArgs only ever emits one of
// these fixed lists, whatever a config file says.
export const MMAP_OFF_ARGS = {
  'load-mode': ['--load-mode', 'none'],
  'no-mmap': ['--no-mmap'],
}

/**
 * Which MMAP_OFF_ARGS key a `llama-server --help` text accepts, or null when
 * it shows neither. --load-mode wins: a build that has it dropped --no-mmap.
 */
export function parseMmapOffFlag(helpText) {
  if (typeof helpText !== 'string' || !helpText) return null
  if (/(^|[\s,])--load-mode\b/m.test(helpText)) return 'load-mode'
  if (/(^|[\s,])--no-mmap\b/m.test(helpText)) return 'no-mmap'
  return null
}

/**
 * Apply a profile's noMmap: returns the config with `mmapOffFlag` set (a
 * MMAP_OFF_ARGS key, or null for "decided: no flag") and a line for the run
 * log, or null when memory-mapping was not asked to be off. `flag` is
 * probeServerHelp()'s mmapOffFlag (null if the binary could not be asked).
 */
export function resolveMmap(config, flag) {
  // Always overwritten: mmapOffFlag is decided here, never read from a file.
  const next = { ...config, mmapOffFlag: null }
  if (!config?.noMmap) return { config: next, logLine: null }
  if (!flag || !Object.hasOwn(MMAP_OFF_ARGS, flag)) {
    // Neither form is accepted by every build, and mmap is a speed setting,
    // not a correctness one: launching with it on beats not launching.
    return { config: next, logLine: '[redstart] memory-mapping: left on — this llama-server could not be asked which flag turns it off' }
  }
  next.mmapOffFlag = flag
  return { config: next, logLine: `[redstart] memory-mapping: off (${MMAP_OFF_ARGS[flag].join(' ')})` }
}

const probeCache = new Map()

/** Forget every probed binary (tests). */
export function clearServerHelpProbes() { probeCache.clear() }

/**
 * Ask a llama-server binary what it accepts: { cacheTypes, mmapOffFlag },
 * either of which may be null when its help does not say. Never throws; an
 * unreadable binary is { cacheTypes: null, mmapOffFlag: null }.
 */
export async function probeServerHelp(binaryPath, { execFileAsync, statSync = fs.statSync } = {}) {
  const unknown = { cacheTypes: null, mmapOffFlag: null }
  if (!binaryPath || typeof execFileAsync !== 'function') return unknown
  let key
  try {
    const st = statSync(binaryPath)
    key = `${binaryPath}|${st.size}|${st.mtimeMs}`
  } catch {
    return unknown
  }
  if (probeCache.has(key)) return probeCache.get(key)
  let text
  try {
    const out = await execFileAsync(binaryPath, ['--help'], {
      cwd: path.dirname(binaryPath), timeout: HELP_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    })
    text = `${out?.stdout ?? ''}\n${out?.stderr ?? ''}`
  } catch (err) {
    // A non-zero exit still carries the output on the error object.
    text = `${err?.stdout ?? ''}\n${err?.stderr ?? ''}`
  }
  const help = { cacheTypes: parseCacheTypes(text), mmapOffFlag: parseMmapOffFlag(text) }
  // Only a definite answer is remembered; a failed probe is retried next launch.
  if (help.cacheTypes || help.mmapOffFlag) probeCache.set(key, help)
  return help
}
