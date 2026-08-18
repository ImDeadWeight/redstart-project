'use strict'

// =============================================================================
// Redstart Nest — Plugin runtime detection
// =============================================================================
// SKELETON. Every function throws until implemented — see
// docs/notes/mcp-plugin-system-tasks.md task T14.
//
// Answers "can this machine install and run this kind of plugin?" Consumed by
// the Phase 4b compatibility verdicts (so the UI can say "Not supported: needs
// Python" rather than silently hiding a result) and by the installer.
//
// WHY NOT JUST RUN `npm`. On Windows `npm` is `npm.cmd`, a shell shim, so
// spawning it forces shell:true and puts a cmd.exe between us and the install.
// Plugin children are spawned shell:false because a credential must not transit
// a shell environment (plan decision D-f), and the installer holds to the same
// rule. So we locate npm's JS ENTRY POINT and run it under our own executable
// with ELECTRON_RUN_AS_NODE — exactly the technique filesystem-mcp-provider.mjs
// uses for the pinned filesystem server, for the reasons in its header.
//
// WHY process.execPath CANNOT FIND npm. In a packaged build process.execPath is
// the Redstart binary, not node, so npm is not beneath it. Ambient node has to
// be located first, and npm derived from THAT.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import { execFile } from 'child_process'

/**
 * Machine-readable failure reasons. The UI maps these to sentences; prose baked
 * in here could not be reworded or translated, and callers would end up
 * matching on it.
 */
export const RUNTIME_REASON = {
  nodeNotFound: 'node-not-found',
  npmNotFound: 'npm-not-found',
  uvNotFound: 'uv-not-found',   // reserved for Phase 7 (Python)
}

/**
 * TODO(T14): locate an executable on PATH.
 * `where` on win32, `which` elsewhere. Return the first line of stdout,
 * trimmed, or null. Never throw — absence is the expected case.
 * @param {string} bin @returns {Promise<string|null>}
 */
function whichBinary(bin) {
  return new Promise((resolve) => {
    const finder = process.platform === 'win32' ? 'where' : 'which'
    execFile(finder, [bin], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null)
      // `where` can print multiple matches, one per line — the first is the
      // one PATH resolution would actually use.
      const first = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
      resolve(first ?? null)
    })
  })
}

function execFileText(execPath, args) {
  return new Promise((resolve, reject) => {
    execFile(execPath, args, { windowsHide: true }, (err, stdout) => {
      if (err) return reject(err)
      resolve(stdout.trim())
    })
  })
}

/**
 * TODO(T14): is Node installed on this machine, and where?
 *
 * NOT process.execPath — see the header. Resolve the real `node` on PATH.
 *
 * @returns {Promise<{ ok: true, execPath: string, version: string }
 *                  | { ok: false, reason: string }>}
 */
export async function detectNode() {
  const execPath = await whichBinary('node')
  if (!execPath) return { ok: false, reason: RUNTIME_REASON.nodeNotFound }
  let version
  try {
    version = await execFileText(execPath, ['--version'])
  } catch {
    // Found on PATH but refused to run — same practical outcome as absent.
    return { ok: false, reason: RUNTIME_REASON.nodeNotFound }
  }
  return { ok: true, execPath, version }
}

/**
 * TODO(T14): find npm's JS entry point, not the shell shim.
 *
 *   1. detectNode(); if that fails, propagate its reason unchanged — "node is
 *      missing" and "npm is missing" need different advice, so they must stay
 *      distinguishable all the way to the UI.
 *   2. Derive <dirname(node)>/node_modules/npm/bin/npm-cli.js.
 *   3. fs.existsSync it. Present -> ok. Absent -> RUNTIME_REASON.npmNotFound.
 *
 * @returns {Promise<{ ok: true, cliPath: string, version: string }
 *                  | { ok: false, reason: string }>}
 */
export async function detectNpm() {
  const node = await detectNode()
  if (!node.ok) return node // propagate the reason unchanged (node-not-found)

  const cliPath = path.join(path.dirname(node.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!fs.existsSync(cliPath)) return { ok: false, reason: RUNTIME_REASON.npmNotFound }

  // npm's own package.json sits two directories up from npm-cli.js
  // (node_modules/npm/bin/npm-cli.js -> node_modules/npm/package.json).
  let version = 'unknown'
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(cliPath), '..', 'package.json'), 'utf8'))
    if (typeof pkg.version === 'string') version = pkg.version
  } catch {
    // Non-fatal — the cli file existing is what matters for installability.
  }

  return { ok: true, cliPath, version }
}
