// Image generation's control-plane methods, merged into the capabilities
// namespace (ipc/capabilities.mjs) so the channel table and its contract tests
// keep one namespace per page of the launcher:
//
//   capabilities:image-generation          status: settings, models, engine
//   capabilities:set-image-generation      { model?, backend?, timeoutS? }
//   capabilities:install-image-engine      download the engine now
//   capabilities:search-image-models       { query }
//   capabilities:image-repo                repoId → files + detected family
//   capabilities:download-image-model      { repoId, rfilename, family }
//   capabilities:cancel-image-download
//   capabilities:delete-image-model        file name
//
// Owner-only like every control-plane method (the listener's gate).

import { getCapabilities, setCapabilityConfig } from '../tools-storage.mjs'
import { configDir } from '../platform-paths.mjs'
import { logEvent } from '../logger.mjs'
import { publish } from '../event-broker.mjs'
import { isPlainObject } from './validate.mjs'
import { searchImageModels, getImageRepo, getModelDescription, IMAGE_PUBLISHERS } from '../hf-catalog.mjs'
import {
  FAMILIES, COMPANIONS, detectFamily, listImageModels, downloadImageModel, deleteImageModel, readImageIndex,
} from '../image-models.mjs'
import { SD_BUILDS, chooseSdBuild, hasNvidiaGpu, installSdRuntime, sdRuntimeStatus, SD_RELEASE } from '../sd-runtime.mjs'
import { gpuLeaseHolder } from '../gpu-lease.mjs'

const BACKENDS = ['auto', 'cuda', 'vulkan', 'metal']
let nvidia = null
let engineInstall = null
let download = null

function refuse(channel, error) {
  logEvent('security', 'ipc_validation_failed', { channel, reason: error })
  return { ok: false, error }
}

async function engineFor(backend) {
  if (nvidia === null) nvidia = await hasNvidiaGpu()
  const buildKey = chooseSdBuild({ nvidia, backend })
  return { buildKey, nvidia, status: buildKey ? sdRuntimeStatus(configDir(), buildKey) : null }
}

export async function getImageGenerationStatus({ resolveModelsDir }) {
  const cfg = getCapabilities().image_generation
  const modelsDir = resolveModelsDir()
  const engine = await engineFor(cfg.backend)
  return {
    enabled: cfg.enabled,
    model: cfg.model && readImageIndex(modelsDir)[cfg.model] ? cfg.model : null,
    backend: cfg.backend,
    timeoutS: cfg.timeoutS,
    models: listImageModels(modelsDir),
    families: Object.entries(FAMILIES).map(([id, f]) => ({
      id, label: f.label, note: f.note, defaults: f.defaults,
      companionBytes: f.companions.reduce((n, k) => n + COMPANIONS[k].size, 0),
    })),
    engine: {
      release: SD_RELEASE,
      nvidia: engine.nvidia,
      buildKey: engine.buildKey,
      label: engine.status?.label ?? null,
      installed: engine.status?.installed ?? false,
      downloadBytes: engine.status?.downloadBytes ?? 0,
      installing: engineInstall !== null,
      available: Object.keys(SD_BUILDS),
    },
    downloading: download ? { repoId: download.repoId, rfilename: download.rfilename } : null,
    publishers: IMAGE_PUBLISHERS,
    busy: gpuLeaseHolder(),
  }
}

export function setImageGenerationConfig(config, { refreshLiveToolsConfig, resolveModelsDir }) {
  const channel = 'capabilities:set-image-generation'
  if (!isPlainObject(config)) return refuse(channel, 'expected an object')
  const patch = {}
  if (config.model !== undefined) {
    if (config.model === null) patch.model = null
    else if (typeof config.model !== 'string' || !readImageIndex(resolveModelsDir())[config.model]) return refuse(channel, 'model must be an image model in the models folder, or null')
    else patch.model = config.model
  }
  if (config.backend !== undefined) {
    if (!BACKENDS.includes(config.backend)) return refuse(channel, `backend must be one of ${BACKENDS.join(', ')}`)
    patch.backend = config.backend
  }
  if (config.timeoutS !== undefined) {
    if (!Number.isInteger(config.timeoutS) || config.timeoutS < 30 || config.timeoutS > 280) return refuse(channel, 'timeoutS must be a whole number from 30 to 280 (the chat UI gives a tool 300 s)')
    patch.timeoutS = config.timeoutS
  }
  setCapabilityConfig('image_generation', patch)
  refreshLiveToolsConfig()
  return { ok: true }
}

export async function installImageEngine() {
  const cfg = getCapabilities().image_generation
  const { buildKey } = await engineFor(cfg.backend)
  if (!buildKey) return { ok: false, error: 'No image engine build for this platform.' }
  if (!engineInstall) {
    engineInstall = installSdRuntime({
      baseDir: configDir(), buildKey,
      onProgress: (p) => publish('image:runtime-progress', { buildKey, ...p }),
    })
      .then(() => ({ ok: true }), (err) => ({ ok: false, error: err.message }))
      .finally(() => { engineInstall = null })
  }
  return engineInstall
}

export async function searchImageModelCatalog(opts) {
  try {
    const o = isPlainObject(opts) ? opts : {}
    return { ok: true, results: await searchImageModels({ query: String(o.query ?? ''), publisher: String(o.publisher ?? '') }) }
  } catch (err) {
    return { ok: false, error: err.message, results: [] }
  }
}

export async function getImageRepoDetail(repoId) {
  try {
    const info = await getImageRepo(repoId)
    // The upstream model's card first (what the model is), this repo's second
    // (often only how it was converted). Never fails the lookup.
    let description = null
    try { description = await getModelDescription(info.repoId, { detail: { baseModel: info.baseModels[0] ?? null, revision: info.revision } }) } catch { /* none */ }
    return { ok: true, ...info, family: detectFamily(info), description }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

export async function startImageModelDownload(req, { resolveModelsDir }) {
  const channel = 'capabilities:download-image-model'
  if (!isPlainObject(req)) return refuse(channel, 'expected an object')
  const { repoId, rfilename, family } = req
  if (typeof repoId !== 'string' || typeof rfilename !== 'string' || typeof family !== 'string') return refuse(channel, 'repoId, rfilename and family are required')
  if (download) return { ok: false, error: 'An image model download is already in progress.' }
  const controller = new AbortController()
  download = { repoId, rfilename, controller }
  try {
    const r = await downloadImageModel({
      repoId, rfilename, family, modelsDir: resolveModelsDir(), signal: controller.signal,
      onProgress: (p) => publish('image:download-progress', { repoId, rfilename, ...p }),
    })
    // The first model downloaded becomes the active one.
    if (!getCapabilities().image_generation.model) setCapabilityConfig('image_generation', { model: r.file })
    return { ok: true, ...r }
  } catch (err) {
    const cancelled = controller.signal.aborted
    publish('image:download-progress', { repoId, rfilename, state: cancelled ? 'cancelled' : 'error', error: cancelled ? null : err.message })
    return { ok: false, cancelled, error: cancelled ? 'Download cancelled.' : err.message }
  } finally {
    download = null
  }
}

export function cancelImageModelDownload() {
  download?.controller.abort()
  return { ok: true }
}

export function deleteImageModelFile(file, { resolveModelsDir, refreshLiveToolsConfig }) {
  try {
    deleteImageModel(resolveModelsDir(), file)
    if (getCapabilities().image_generation.model === file) {
      setCapabilityConfig('image_generation', { model: null })
      refreshLiveToolsConfig()
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

export function imageGenerationHandlers(deps) {
  return {
    'capabilities:image-generation': async () => getImageGenerationStatus(deps),
    'capabilities:set-image-generation': (config) => setImageGenerationConfig(config, deps),
    'capabilities:install-image-engine': async () => installImageEngine(),
    'capabilities:search-image-models': async (opts) => searchImageModelCatalog(opts),
    'capabilities:image-repo': async (repoId) => getImageRepoDetail(repoId),
    'capabilities:download-image-model': async (req) => startImageModelDownload(req, deps),
    'capabilities:cancel-image-download': () => cancelImageModelDownload(),
    'capabilities:delete-image-model': (file) => deleteImageModelFile(file, deps),
  }
}
