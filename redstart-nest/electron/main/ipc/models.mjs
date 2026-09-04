// Models IPC namespace — Hugging Face discovery and GGUF downloads.
//
// Thin: catalog logic lives in ../hf-catalog.mjs and transfer logic in
// ../model-download.mjs, both free of Electron so the security suite can drive
// them directly. This module owns only the parts that need the app — the
// models folder and the single-flight rule that keeps two multi-gigabyte
// downloads from fighting over one disk. Every method here is owner-gated
// over the control plane like any other admin/api-table.mjs namespace —
// reveal-folder used to be the one exception and retired along with the
// rest of the local/remote distinction.
//
// Handler bodies are exported as plain functions so an HTTP route can call them
// directly without dragging IPC registration in — importing this module never
// registers anything; only registerModelsHandlers() does that. The
// single-flight `active` download tracker used to be a variable local to
// registerModelsHandlers' closure; it is module-level state now (same shape
// as auth.mjs's `sessions` map) so a plain function and the IPC handler that
// wraps it see the exact same live download, not two independent trackers.
import { hasRecycleBin, moveToRecycleBin } from '../desktop-integration.mjs'
import { publish } from '../event-broker.mjs'
import * as fsp from 'fs/promises'
import * as path from 'path'

import { searchModels, getModelDetail, getModelDescription, TRUSTED_PUBLISHERS } from '../hf-catalog.mjs'
import { downloadArtifact, diskSpaceFor, discardPartials, PART_SUFFIX } from '../model-download.mjs'
import { isPlainObject, isNonEmptyString, optional } from './validate.mjs'

// Progress fires per chunk, which is thousands of times a second on a fast
// link. The renderer only needs enough to animate a bar.
const PROGRESS_INTERVAL_MS = 250

// One download at a time — see the file header. { repoId, artifactId,
// controller, artifact, modelsDir } while a download is running, else null.
let active = null

export function listTrustedPublishers() {
  return TRUSTED_PUBLISHERS
}

export async function searchModelCatalog(opts) {
  try {
    return { ok: true, models: await searchModels(opts || {}) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

export async function getModelDetailById(repoId) {
  try {
    return { ok: true, detail: await getModelDetail(repoId) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

// Deliberately NOT folded into getModelDetailById. A description costs one or
// two more round trips (the card, and usually the upstream model's card before
// it), and the artifact list is what the user opened the model to see. Keeping
// them separate lets the tab render the sizes immediately and fill the prose in
// when it arrives, instead of holding the whole panel for it.
export async function getModelDescriptionById(repoId) {
  try {
    return { ok: true, description: await getModelDescription(repoId) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

export async function listLocalModels({ resolveModelsDir, ensureModelsDir }) {
  const dir = resolveModelsDir()
  try {
    ensureModelsDir?.()
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    const files = []
    for (const e of entries) {
      if (!e.isFile()) continue
      const lower = e.name.toLowerCase()
      // .part files are surfaced too — an interrupted 18 GB download is
      // occupying the disk and the user needs to see it to clean it up.
      if (!lower.endsWith('.gguf') && !lower.endsWith('.gguf' + PART_SUFFIX)) continue
      const st = await fsp.stat(path.join(dir, e.name))
      files.push({
        name: e.name,
        path: path.join(dir, e.name),
        size: st.size,
        modified: st.mtimeMs,
        partial: lower.endsWith(PART_SUFFIX),
      })
    }
    files.sort((a, b) => b.modified - a.modified)
    return { ok: true, dir, files }
  } catch (err) {
    return { ok: false, dir, files: [], error: err.message }
  }
}

export async function getModelsDiskSpace({ resolveModelsDir, ensureModelsDir }) {
  const dir = resolveModelsDir()
  try {
    ensureModelsDir?.()
    return { ok: true, dir, ...await diskSpaceFor(dir) }
  } catch (err) {
    return { ok: false, dir, error: err.message }
  }
}

// revealModelsFolder() is retired. Opening a file-explorer
// window is inherently an action on whichever machine runs it, and once IPC
// no longer distinguishes "the caller is sitting at this machine" from
// "the caller is a browser anywhere on the network", there is no safe
// caller left for it: firing on an anonymous-looking HTTP request would pop
// a window on the daemon's own desktop for whoever is physically there,
// triggered by someone who is not. The UI shows the path as text with a
// copy button instead, for every caller alike.

export async function deleteLocalModel(name, { resolveModelsDir }) {
  // Only ever a bare name from our own listing, resolved against the models
  // folder — never a path from the renderer.
  if (typeof name !== 'string' || !name || name !== path.basename(name)) {
    return { ok: false, error: 'Invalid file name' }
  }
  const dir = resolveModelsDir()
  const target = path.join(dir, name)
  const lower = name.toLowerCase()
  if (!lower.endsWith('.gguf') && !lower.endsWith('.gguf' + PART_SUFFIX)) {
    return { ok: false, error: 'Not a model file' }
  }
  try {
    // Recycle bin rather than unlink where there is one: nothing in Redstart
    // permanently destroys a file the user might not have meant to lose, and
    // a model is a multi-gigabyte re-download.
    if (hasRecycleBin()) {
      await moveToRecycleBin(target)
      return { ok: true }
    }
    // Headless, there is no recycle bin — and unlike trash.mjs (which moves a
    // user's documents into a .trash/ folder rather than ever destroying
    // them), the right answer for a MODEL is to actually delete it. A 40GB
    // file parked in a directory nothing ever empties is the outcome the
    // admin was trying to avoid by pressing delete, and a model is
    // re-downloadable in a way a user's own file is not. Deliberate
    // divergence from the recoverable-delete rule, for this one file type.
    await fsp.unlink(target)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

// Shape only. The values themselves are already checked where they are used
// and that stays authoritative: assertValidRepoId/isValidRevision in
// hf-catalog.mjs build the URL, destinationFor() in model-download.mjs
// contains the filename. What was missing was the edge check — a malformed
// request got as far as `active` before failing, and a request with no
// `files` array died on a bare property read several modules deep.
export async function startModelDownload(req, { resolveModelsDir, sendProgress }) {
  if (!isPlainObject(req)) return { ok: false, error: 'A download request must be an object.' }
  const { repoId, revision, artifact } = req
  if (!isNonEmptyString(repoId)) return { ok: false, error: 'A download needs a repository id.' }
  if (!optional(revision, isNonEmptyString)) return { ok: false, error: 'Revision must be a string.' }
  if (!isPlainObject(artifact) || !Array.isArray(artifact.files) || artifact.files.length === 0) {
    return { ok: false, error: 'A download needs an artifact with at least one file.' }
  }
  if (!artifact.files.every(isPlainObject)) {
    return { ok: false, error: 'Every artifact file must be an object.' }
  }
  if (active) {
    return { ok: false, error: 'A download is already in progress.' }
  }
  const modelsDir = resolveModelsDir()
  const controller = new AbortController()
  active = { repoId, artifactId: artifact?.id, controller, artifact, modelsDir }

  let lastSent = 0
  const onProgress = (p) => {
    const now = Date.now()
    // Always let a terminal state through; only the streaming updates are
    // throttled.
    if (p.state === 'downloading' && now - lastSent < PROGRESS_INTERVAL_MS) return
    lastSent = now
    sendProgress({ repoId, artifactId: artifact?.id, ...p })
  }

  try {
    const result = await downloadArtifact({
      repoId, revision, artifact, modelsDir,
      signal: controller.signal,
      onProgress,
    })
    sendProgress({
      repoId, artifactId: artifact?.id, state: 'complete',
      receivedBytes: result.totalBytes, totalBytes: result.totalBytes,
    })
    return { ok: true, result }
  } catch (err) {
    const cancelled = controller.signal.aborted
    if (cancelled) {
      // User cancellation discards the staging file. A network failure does
      // NOT — that .part is what makes the retry a resume.
      await discardPartials(modelsDir, artifact).catch(() => {})
    }
    sendProgress({
      repoId, artifactId: artifact?.id,
      state: cancelled ? 'cancelled' : 'error',
      error: cancelled ? null : err.message,
    })
    return { ok: false, cancelled, error: cancelled ? 'Download cancelled.' : err.message }
  } finally {
    active = null
  }
}

export function cancelModelDownload() {
  if (!active) return { ok: false, error: 'No download in progress.' }
  active.controller.abort()
  return { ok: true }
}

export function getModelDownloadStatus() {
  return active ? { active: true, repoId: active.repoId, artifactId: active.artifactId } : { active: false }
}

export function modelsHandlers(deps) {
  // One event channel for this namespace, named exactly once so the literal is
  // greppable — scripts/test-ipc-contract.mjs pairs emitted events against
  // preload subscriptions by scanning main-process source for a literal
  // channel, and an event hidden behind a variable would silently drop out
  // of that check.
  //
  // Published to the shared broker, not pushed to the window
  // directly — an HTTP caller subscribed to /admin/events now sees the same
  // progress the window does, closing the gap this comment used to describe.
  const sendProgress = (payload) => publish('models:download-progress', payload)

  return {
    // --- Catalog ---
    'models:publishers': () => listTrustedPublishers(),
    'models:search': async (opts) => searchModelCatalog(opts),
    'models:detail': async (repoId) => getModelDetailById(repoId),
    'models:describe': async (repoId) => getModelDescriptionById(repoId),

    // --- Local storage ---
    'models:local': async () => listLocalModels(deps),
    'models:disk-space': async () => getModelsDiskSpace(deps),
    'models:delete-local': async (name) => deleteLocalModel(name, deps),

    // --- Download ---
    'models:download': async (req) => startModelDownload(req, { ...deps, sendProgress }),
    'models:cancel-download': () => cancelModelDownload(),
    'models:download-status': () => getModelDownloadStatus(),
  }
}
