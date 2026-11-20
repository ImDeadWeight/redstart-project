'use strict'

// =============================================================================
// Redstart Nest — vision projectors (mmproj)
// =============================================================================
// A vision model in GGUF form is two files: the language model and a
// multimodal projector (`mmproj-*.gguf`) that turns an image into tokens it
// can read. llama-server loads the second with `--mmproj`, and only then does
// /props report `modalities.vision` — which is the switch the chat UI keys
// every image path on (attachments, pasted images, images in tool results).
// Without a projector, a vision model is a text model.
//
// Three facts shape this module:
//
//   - On the Hub, projectors sit beside the quants and are almost always
//     named `mmproj-F16.gguf` / `mmproj-BF16.gguf` / `mmproj-<model>-f16.gguf`.
//     The catalog must not offer one as a model (parseQuant reads "F16" and
//     it looks like any other quant), and every repo's is called the same
//     thing, so a flat models folder needs a name that says whose it is.
//   - A projector belongs to a model family, not a quant: one projector serves
//     every quant in its repo. So it is downloaded once per repo and recorded
//     against each model file that uses it.
//   - The pairing is a fact about files on disk, so it lives on disk, in
//     PROJECTOR_INDEX inside the models folder, and travels with the folder.
//
// At launch, resolveProjector() decides the --mmproj path:
//
//   config.vision === false             → none (the profile turned it off)
//   config.mmprojPath set, file exists  → that file ('profile')
//   config.mmprojPath set, file missing → none, with a warning
//   paired in PROJECTOR_INDEX, exists   → that file ('paired')
//   otherwise                           → none
//
// Applied by ipc/server.mjs to both the launch and the command preview, like
// the chat-template choice, so the preview shows what will run.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'

/** The pairing file, inside the models folder. Not a .gguf, so no listing shows it. */
export const PROJECTOR_INDEX = 'projectors.json'

/** Whether a file name (Hub path or basename) is a vision projector. */
export function isProjectorFile(name) {
  if (typeof name !== 'string') return false
  return /mmproj/i.test(name.split(/[/\\]/).pop() || '')
}

// Preferred precision first. F16/BF16 are what llama.cpp's own docs use and
// are small next to the model (a projector is ~0.5-1.5 GB); a quantised
// projector costs image understanding for little saving.
const PRECISION_ORDER = ['f16', 'bf16', 'q8_0', 'f32']

function precisionRank(rfilename) {
  const lower = rfilename.toLowerCase()
  const i = PRECISION_ORDER.findIndex(p => new RegExp(`(^|[-_.])${p}(\\.gguf$|[-_.])`).test(lower))
  return i === -1 ? PRECISION_ORDER.length : i
}

/**
 * The one projector to download for a repo, from its sibling list.
 *
 * @param {{ rfilename: string, size?: number, lfs?: { sha256?: string, size?: number } }[]} siblings
 * @returns {{ rfilename: string, size: number|null, sha256: string|null } | null}
 */
export function pickProjector(siblings) {
  const candidates = (siblings || [])
    .filter(s => typeof s?.rfilename === 'string' && s.rfilename.toLowerCase().endsWith('.gguf') && isProjectorFile(s.rfilename))
    .sort((a, b) => precisionRank(a.rfilename) - precisionRank(b.rfilename) || a.rfilename.localeCompare(b.rfilename))
  const s = candidates[0]
  if (!s) return null
  return {
    rfilename: s.rfilename,
    size: typeof s.size === 'number' ? s.size : (s.lfs?.size ?? null),
    sha256: s.lfs?.sha256 || null,
  }
}

/**
 * The flat name a projector is saved under: the repo it came from, then its
 * own basename, so two repos' `mmproj-F16.gguf` cannot overwrite each other.
 *
 *   unsloth/Qwen3-VL-8B-Instruct-GGUF + mmproj-F16.gguf
 *     → unsloth_Qwen3-VL-8B-Instruct-GGUF.mmproj-F16.gguf
 *
 * Everything outside [A-Za-z0-9._-] becomes '_', so the result is a single
 * path component whatever the Hub sends. The caller still contains it.
 */
export function projectorDestName(repoId, rfilename) {
  const base = String(rfilename).split(/[/\\]/).pop() || ''
  if (!isProjectorFile(base) || !base.toLowerCase().endsWith('.gguf')) {
    throw new Error(`Not a projector file: ${base.slice(0, 80)}`)
  }
  const safe = (s) => s.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_')
  return `${safe(String(repoId).replace('/', '_'))}.${safe(base)}`
}

function indexPath(modelsDir) { return path.join(modelsDir, PROJECTOR_INDEX) }

/** model basename → projector basename. Unreadable or malformed reads as empty. */
export function readProjectorIndex(modelsDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath(modelsDir), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && k === path.basename(k) && v === path.basename(v)) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function writeIndex(modelsDir, index) {
  const tmp = indexPath(modelsDir) + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2))
  fs.renameSync(tmp, indexPath(modelsDir))
}

/** Pair a model file with a projector file, both basenames in modelsDir. */
export function recordProjector(modelsDir, modelFile, projectorFile) {
  const index = readProjectorIndex(modelsDir)
  index[path.basename(modelFile)] = path.basename(projectorFile)
  writeIndex(modelsDir, index)
}

/**
 * Drop whatever the index says about a file that is going away: its own
 * pairing if it is a model, every pairing to it if it is a projector.
 */
export function forgetProjectorPairing(modelsDir, file) {
  const name = path.basename(file)
  const index = readProjectorIndex(modelsDir)
  let changed = false
  for (const [model, projector] of Object.entries(index)) {
    if (model === name || projector === name) { delete index[model]; changed = true }
  }
  if (changed) writeIndex(modelsDir, index)
}

/**
 * The --mmproj decision for a launch. Returns the config to build args from
 * (with mmprojPath set or removed) and the decision, for the run log and the
 * status.
 *
 * @param {object} config  a llama profile config
 * @returns {{ config: object, decision: { source: 'profile'|'paired'|'none', projector: string|null, warning: string|null }, logLine: string }}
 */
export function resolveProjector(config) {
  const { mmprojPath: explicit, ...rest } = config || {}
  const none = (warning = null) => ({
    config: rest,
    decision: { source: 'none', projector: null, warning },
    logLine: warning ? `[redstart] vision: off — ${warning}` : '[redstart] vision: off (no projector for this model)',
  })
  const use = (source, file) => ({
    config: { ...rest, mmprojPath: file },
    decision: { source, projector: path.basename(file), warning: null },
    logLine: `[redstart] vision: on — projector ${path.basename(file)} (${source})`,
  })

  if (config?.vision === false) {
    return { ...none(), logLine: '[redstart] vision: off (turned off in this profile)' }
  }
  if (typeof explicit === 'string' && explicit.trim()) {
    const file = explicit.trim()
    if (fs.existsSync(file)) return use('profile', file)
    return none(`the profile's projector file is missing: ${path.basename(file)}`)
  }
  const modelPath = typeof config?.modelPath === 'string' ? config.modelPath.trim() : ''
  if (!modelPath) return none()
  const dir = path.dirname(modelPath)
  const paired = readProjectorIndex(dir)[path.basename(modelPath)]
  if (!paired) return none()
  const file = path.join(dir, paired)
  if (!fs.existsSync(file)) return none(`the paired projector is missing: ${paired}`)
  return use('paired', file)
}
