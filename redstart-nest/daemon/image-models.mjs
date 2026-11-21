'use strict'

// =============================================================================
// Redstart Nest — image models: family recipes, and the model you pick
// =============================================================================
// Nest does not bundle an image model (plan decision U-IG2). You pick one from
// Hugging Face; what makes that workable is that image models come in
// FAMILIES, and within a family any checkpoint or fine-tune is a drop-in.
// stable-diffusion.cpp itself is organised this way ("recipes" with
// component slots, its docs/models/*.md).
//
// A family fixes:
//   - which slot the file you picked fills: a single-file checkpoint (SD 1.x,
//     SDXL: text encoder and VAE inside) goes to --model; a bare diffusion
//     model (FLUX) goes to --diffusion-model;
//   - the COMPANION files it needs beside that (FLUX: CLIP-L, T5-XXL, the
//     FLUX VAE), shared by the whole family, pinned here by repo, revision,
//     size and sha256, and fetched once;
//   - defaults the model should not have to know: steps, cfg, sampler, size.
//
// Which family a repo is comes from its own card (base_model, tags) where it
// says; otherwise the admin chooses. A wrong choice fails in sd-cli with an
// error, it cannot do anything worse: the files are only ever weights.
//
// FILES live in <models>/image/, flat, saved as <owner>_<repo>.<file> (two
// repos' "model.safetensors" must not collide), contained like every other
// download, and listed in image-models.json there.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import { downloadFile } from './model-download.mjs'
import { getImageRepo, buildDownloadUrl, isValidRepoId, isValidRevision } from './hf-catalog.mjs'
import { resolveWithinRoot } from './path-scope.mjs'
import { logEvent } from './logger.mjs'

export const IMAGE_DIR = 'image'
export const IMAGE_INDEX = 'image-models.json'

/**
 * Shared files, pinned. FLUX's VAE comes from Comfy-Org/Z-Image-Turbo: the
 * byte-identical ae.safetensors (same sha256) without black-forest-labs'
 * login gate. All Apache-2.0.
 */
export const COMPANIONS = {
  'flux1-clip-l': { slot: 'clipL', repoId: 'comfyanonymous/flux_text_encoders', revision: '6af2a98e3f615bdfa612fbd85da93d1ed5f69ef5', rfilename: 'clip_l.safetensors', size: 246144152, sha256: '660c6f5b1abae9dc498ac2d21e1347d2abdb0cf6c0c0c8576cd796491d9a6cdd' },
  'flux1-t5xxl': { slot: 't5xxl', repoId: 'city96/t5-v1_1-xxl-encoder-gguf', revision: '005a6ea51a7d0b84d677b3e633bb52a8c85a83d9', rfilename: 't5-v1_1-xxl-encoder-Q4_K_M.gguf', size: 2896123072, sha256: '6be2b0b7e2de7cf2919340c88cb802a103a997ce46c53131cec91958c1db1af4' },
  'flux1-vae': { slot: 'vae', repoId: 'Comfy-Org/Z-Image-Turbo', revision: '6fc90a3b1b653e935a0d175e260736de25b84df5', rfilename: 'split_files/vae/ae.safetensors', size: 335304388, sha256: 'afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38' },
}

/** The families Nest knows. Exported for the suite and the launcher. */
export const FAMILIES = {
  'flux1-schnell': {
    label: 'FLUX.1 schnell',
    slot: 'diffusionModel',
    companions: ['flux1-clip-l', 'flux1-t5xxl', 'flux1-vae'],
    defaults: { steps: 4, cfgScale: 1, sampler: 'euler', width: 1024, height: 1024 },
    maxSteps: 8,
    baseModels: ['black-forest-labs/FLUX.1-schnell'],
    tags: ['flux-schnell'],
    note: 'Apache-2.0. Four steps is the design point.',
  },
  'flux1-dev': {
    label: 'FLUX.1 dev',
    slot: 'diffusionModel',
    companions: ['flux1-clip-l', 'flux1-t5xxl', 'flux1-vae'],
    defaults: { steps: 20, cfgScale: 1, sampler: 'euler', width: 1024, height: 1024 },
    maxSteps: 50,
    baseModels: ['black-forest-labs/FLUX.1-dev'],
    tags: ['flux-dev'],
    note: 'Non-commercial licence (FLUX.1 [dev]).',
  },
  sdxl: {
    label: 'Stable Diffusion XL',
    slot: 'model',
    companions: [],
    defaults: { steps: 25, cfgScale: 7, sampler: 'euler_a', width: 1024, height: 1024 },
    maxSteps: 60,
    baseModels: ['stabilityai/stable-diffusion-xl-base-1.0'],
    tags: ['stable-diffusion-xl', 'sdxl'],
    note: 'A single-file checkpoint (text encoders and VAE inside).',
  },
  sd1: {
    label: 'Stable Diffusion 1.x',
    slot: 'model',
    companions: [],
    defaults: { steps: 25, cfgScale: 7, sampler: 'euler_a', width: 512, height: 512 },
    maxSteps: 60,
    baseModels: ['stable-diffusion-v1-5/stable-diffusion-v1-5', 'runwayml/stable-diffusion-v1-5', 'CompVis/stable-diffusion-v1-4'],
    tags: ['stable-diffusion'],
    note: 'A single-file checkpoint. 512×512 native.',
  },
}

/**
 * The family a repo says it belongs to, or null. Its base_model first (the
 * Hub's structured pointer), then its tags; the repo id itself last.
 */
export function detectFamily({ repoId, baseModels = [], tags = [] }) {
  for (const [id, f] of Object.entries(FAMILIES)) {
    if (baseModels.some((b) => f.baseModels.some((x) => x.toLowerCase() === String(b).toLowerCase()))) return id
    if (f.baseModels.some((x) => x.toLowerCase() === String(repoId).toLowerCase())) return id
  }
  const lowerTags = tags.map((t) => String(t).toLowerCase())
  for (const [id, f] of Object.entries(FAMILIES)) {
    if (f.tags.some((t) => lowerTags.includes(t))) return id
  }
  const r = String(repoId).toLowerCase()
  if (r.includes('flux') && r.includes('schnell')) return 'flux1-schnell'
  if (r.includes('flux') && r.includes('dev')) return 'flux1-dev'
  if (r.includes('sdxl') || r.includes('xl-base')) return 'sdxl'
  return null
}

/** `<owner>_<repo>.<basename>`, one safe path component. */
export function savedName(repoId, rfilename) {
  const base = String(rfilename).split(/[/\\]/).pop() || ''
  if (!/\.(gguf|safetensors)$/i.test(base)) throw new Error(`Not an image weight file: ${base.slice(0, 80)}`)
  const safe = (s) => s.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_')
  return `${safe(String(repoId).replace('/', '_'))}.${safe(base)}`
}

export function imageDir(modelsDir) { return path.join(modelsDir, IMAGE_DIR) }

export function readImageIndex(modelsDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(imageDir(modelsDir), IMAGE_INDEX), 'utf8'))
    const models = parsed?.models && typeof parsed.models === 'object' && !Array.isArray(parsed.models) ? parsed.models : {}
    const out = {}
    for (const [file, m] of Object.entries(models)) {
      if (file !== path.basename(file) || !m || !FAMILIES[m.family]) continue
      out[file] = { repoId: String(m.repoId ?? ''), revision: String(m.revision ?? ''), rfilename: String(m.rfilename ?? ''), family: m.family, bytes: Number(m.bytes) || 0 }
    }
    return out
  } catch {
    return {}
  }
}

function writeImageIndex(modelsDir, models) {
  const file = path.join(imageDir(modelsDir), IMAGE_INDEX)
  fs.writeFileSync(file + '.tmp', JSON.stringify({ models }, null, 2))
  fs.renameSync(file + '.tmp', file)
}

function companionPath(modelsDir, key) {
  const c = COMPANIONS[key]
  return resolveWithinRoot(imageDir(modelsDir), savedName(c.repoId, c.rfilename))
}

/**
 * The image models on disk, each with its family and whether that family's
 * companions are all present.
 */
export function listImageModels(modelsDir) {
  const index = readImageIndex(modelsDir)
  return Object.entries(index)
    .filter(([file]) => fs.existsSync(path.join(imageDir(modelsDir), file)))
    .map(([file, m]) => {
      const family = FAMILIES[m.family]
      const missing = family.companions.filter((k) => !fs.existsSync(companionPath(modelsDir, k)))
      return { file, ...m, familyLabel: family.label, ready: missing.length === 0, missingCompanions: missing }
    })
}

/**
 * Download a model file you picked, plus its family's companions. The size
 * and checksum come from the Hub, asked here, never from the caller.
 *
 * @param {{ repoId: string, rfilename: string, family: string, modelsDir: string, signal?: AbortSignal, onProgress?: (p: object) => void }} opts
 */
export async function downloadImageModel({ repoId, rfilename, family, modelsDir, signal, onProgress, repoInfo = getImageRepo }) {
  if (!isValidRepoId(repoId)) throw new Error('A download needs a valid repository id.')
  const fam = FAMILIES[family]
  if (!fam) throw new Error(`Unknown image model family: ${String(family).slice(0, 40)}`)
  const info = await repoInfo(repoId)
  if (info.gated) throw new Error('This model requires a Hugging Face account to download; Nest does not sign in to Hugging Face.')
  if (!isValidRevision(info.revision)) throw new Error('Hugging Face did not report a revision to pin the download to.')
  const file = info.files.find((f) => f.rfilename === rfilename)
  if (!file) throw new Error(`${String(rfilename).slice(0, 80)} is not a top-level .gguf or .safetensors file in ${repoId}.`)

  const dir = imageDir(modelsDir)
  fs.mkdirSync(dir, { recursive: true })
  const name = savedName(repoId, rfilename)
  const targets = [{ url: buildDownloadUrl(repoId, info.revision, rfilename), destPath: resolveWithinRoot(dir, name), size: file.size, sha256: file.sha256, label: rfilename }]
  for (const key of fam.companions) {
    const c = COMPANIONS[key]
    targets.push({ url: buildDownloadUrl(c.repoId, c.revision, c.rfilename), destPath: companionPath(modelsDir, key), size: c.size, sha256: c.sha256, label: c.rfilename.split('/').pop() })
  }

  const total = targets.reduce((n, t) => n + (t.size || 0), 0)
  let done = 0
  for (const [i, t] of targets.entries()) {
    if (fs.existsSync(t.destPath)) { done += t.size || 0; continue }
    await downloadFile({
      url: t.url, destPath: t.destPath, expectedSha256: t.sha256, expectedSize: t.size, signal,
      onChunk: (received) => onProgress?.({ state: 'downloading', fileIndex: i, fileCount: targets.length, file: t.label, receivedBytes: done + received, totalBytes: total }),
    })
    done += t.size || 0
  }

  const index = readImageIndex(modelsDir)
  index[name] = { repoId, revision: info.revision, rfilename, family, bytes: file.size || 0 }
  writeImageIndex(modelsDir, index)
  logEvent('image', 'model_downloaded', { family })
  onProgress?.({ state: 'complete', receivedBytes: total, totalBytes: total })
  return { file: name, family }
}

/** Remove a model from the index and the folder. Companions stay (shared). */
export function deleteImageModel(modelsDir, file) {
  if (typeof file !== 'string' || file !== path.basename(file)) throw new Error('Invalid file name')
  const index = readImageIndex(modelsDir)
  if (!index[file]) throw new Error('Not an image model Nest downloaded.')
  fs.rmSync(resolveWithinRoot(imageDir(modelsDir), file), { force: true })
  delete index[file]
  writeImageIndex(modelsDir, index)
}

/**
 * What a job needs from the active model: absolute component paths, the
 * family's defaults and step cap. Throws a message fit for the model when
 * nothing usable is chosen.
 *
 * @param {{ model?: string|null }} capCfg  the image_generation capability config
 */
export function resolveImageModel(capCfg, modelsDir) {
  const index = readImageIndex(modelsDir)
  const chosen = capCfg?.model && index[capCfg.model] ? capCfg.model : null
  if (!chosen) throw new Error('No image model is chosen on this server. An admin picks one in Nest under Tools → Image generation.')
  const m = index[chosen]
  const fam = FAMILIES[m.family]
  const main = resolveWithinRoot(imageDir(modelsDir), chosen)
  if (!fs.existsSync(main)) throw new Error('The chosen image model file is missing from the models folder.')
  const components = { [fam.slot]: main }
  for (const key of fam.companions) {
    const p = companionPath(modelsDir, key)
    if (!fs.existsSync(p)) throw new Error(`The image model's ${COMPANIONS[key].slot} file is missing; download the model again from Tools → Image generation.`)
    components[COMPANIONS[key].slot] = p
  }
  return { file: chosen, family: m.family, familyLabel: fam.label, components, defaults: fam.defaults, maxSteps: fam.maxSteps }
}
