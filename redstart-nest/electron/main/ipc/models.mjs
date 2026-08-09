// Models IPC namespace — Hugging Face discovery and GGUF downloads.
//
// Thin: catalog logic lives in ../hf-catalog.mjs and transfer logic in
// ../model-download.mjs, both free of Electron so the security suite can drive
// them directly. This module owns only the parts that need the app — the
// window handle for progress events, the models folder, and the single-flight
// rule that keeps two multi-gigabyte downloads from fighting over one disk.
//
// This is a LAUNCHER surface, on the host machine, so it is admin-by-
// construction: there is no HTTP route here and no LAN client can reach it.
// That is the reason it needs no account or permission model. If model
// management ever moves to the clients (see the roadmap's headless work), that
// assumption is the first thing that stops being true.
import { ipcMain, shell } from 'electron'
import * as fsp from 'fs/promises'
import * as path from 'path'

import { searchModels, getModelDetail, TRUSTED_PUBLISHERS } from '../hf-catalog.mjs'
import { downloadArtifact, diskSpaceFor, discardPartials, PART_SUFFIX } from '../model-download.mjs'

// Progress fires per chunk, which is thousands of times a second on a fast
// link. The renderer only needs enough to animate a bar.
const PROGRESS_INTERVAL_MS = 250

export function registerModelsHandlers({ resolveModelsDir, ensureModelsDir, getMainWindow }) {
  // One download at a time — see the file header.
  let active = null // { repoId, artifactId, controller, artifact }

  // One event channel for this namespace, named exactly once so the literal is
  // greppable — scripts/test-ipc-contract.mjs pairs emitted events against
  // preload subscriptions by scanning main-process source for send() calls with
  // a literal channel, and an event hidden behind a variable would silently
  // drop out of that check.
  const sendProgress = (payload) => {
    const win = getMainWindow?.()
    if (win && !win.isDestroyed()) win.webContents.send('models:download-progress', payload)
  }

  // --- Catalog ---

  ipcMain.handle('models:publishers', () => TRUSTED_PUBLISHERS)

  ipcMain.handle('models:search', async (_, opts) => {
    try {
      return { ok: true, models: await searchModels(opts || {}) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('models:detail', async (_, repoId) => {
    try {
      return { ok: true, detail: await getModelDetail(repoId) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // --- Local storage ---

  ipcMain.handle('models:local', async () => {
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
  })

  ipcMain.handle('models:disk-space', async () => {
    const dir = resolveModelsDir()
    try {
      ensureModelsDir?.()
      return { ok: true, dir, ...await diskSpaceFor(dir) }
    } catch (err) {
      return { ok: false, dir, error: err.message }
    }
  })

  ipcMain.handle('models:reveal-folder', async () => {
    const dir = resolveModelsDir()
    ensureModelsDir?.()
    await shell.openPath(dir)
    return dir
  })

  ipcMain.handle('models:delete-local', async (_, name) => {
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
      // Recycle bin rather than unlink: nothing in Redstart permanently
      // destroys a file the user might not have meant to lose, and a model is
      // a multi-gigabyte re-download.
      await shell.trashItem(target)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // --- Download ---

  ipcMain.handle('models:download', async (_, { repoId, revision, artifact } = {}) => {
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
  })

  ipcMain.handle('models:cancel-download', () => {
    if (!active) return { ok: false, error: 'No download in progress.' }
    active.controller.abort()
    return { ok: true }
  })

  ipcMain.handle('models:download-status', () => (
    active ? { active: true, repoId: active.repoId, artifactId: active.artifactId } : { active: false }
  ))
}
