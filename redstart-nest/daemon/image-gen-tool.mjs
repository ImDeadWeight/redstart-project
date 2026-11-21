'use strict'

// =============================================================================
// Redstart Nest — generate_image (the Image generation capability)
// =============================================================================
// One call: check the request, take the GPU (gpu-lease.mjs: the chat model is
// paused, new requests held, replies in flight let finish), run one sd-cli
// job (sd-job.mjs) with the chosen model's family recipe (image-models.mjs),
// give the GPU back (the model reloads), and put the PNGs in this chat's
// workspace, returned as resource links — the chat UI shows them, and a
// vision model is shown them with the result.
//
// The order is chosen so the model is paused for as little as possible:
// everything that can fail without the GPU (arguments, the model files, the
// workspace caps, the engine install) is settled BEFORE the lease is taken.
//
// The engine is downloaded on first use (plan U-IG1). If that takes longer
// than the call can wait, the install carries on and the model is told to try
// again; the admin can also install it ahead of time from the Tools page.
//
// Who may call it: the capability is off until an admin turns it on, and a
// role can withhold it like any capability (plan U-IG3) — it pauses the chat
// model for every account on the server.
// =============================================================================

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { randomUUID, randomInt } from 'crypto'
import { workspaceDir, workspaceRelative, checkCaps } from './conversation-workspace.mjs'
import { fileLink } from './tool-result-links.mjs'
import { resolveImageModel } from './image-models.mjs'
import { chooseSdBuild, hasNvidiaGpu, installSdRuntime, sdRuntimeStatus } from './sd-runtime.mjs'
import { buildSdArgs, runSdJob, LIMITS } from './sd-job.mjs'
import { acquireGpu } from './gpu-lease.mjs'
import { inspectImageFile } from './image-info.mjs'
import { publish } from './event-broker.mjs'
import { logEvent } from './logger.mjs'

export const TOOL_NAME = 'generate_image'
export const ASPECTS = ['square', 'landscape', 'portrait']

/** How long one call waits for a first-time engine download before saying "try again". */
const INSTALL_WAIT_MS = 90_000
const DEFAULT_TIMEOUT_S = 240

/** @type {{ resolveModelsDir: () => string, baseDir: string, nvidia: () => Promise<boolean>, runJob: typeof runSdJob } | null} */
let env = null
let nvidiaOnce = null

/**
 * Called by daemon.mjs: where the models folder is, and Nest's config dir.
 * nvidia and runJob are seams for the suite; production takes the defaults.
 */
export function initImageGenTool({ resolveModelsDir, baseDir, nvidia = hasNvidiaGpu, runJob = runSdJob }) {
  env = { resolveModelsDir, baseDir, nvidia, runJob }
  nvidiaOnce = null
}

function hasNvidia() {
  if (!nvidiaOnce) nvidiaOnce = env.nvidia()
  return nvidiaOnce
}

const round64 = (n) => Math.max(LIMITS.minSide, Math.round(n / 64) * 64)

/** Width and height for an aspect, from the family's native square. */
export function sizeFor(aspect, defaults) {
  const side = defaults.width
  if (aspect === 'landscape') return { width: round64(side * 1.3125), height: round64(side * 0.75) }
  if (aspect === 'portrait') return { width: round64(side * 0.75), height: round64(side * 1.3125) }
  return { width: defaults.width, height: defaults.height }
}

export function toolDefs(cfg) {
  if (!cfg?.imageGeneration?.enabled) return []
  return [{
    name: TOOL_NAME,
    description:
      'Make a picture from a text description, with the image model on this Redstart server. ' +
      'Takes 20 to 60 seconds, and the chat model pauses while it runs, so make one call with a good prompt rather than many: ' +
      'describe the subject, setting, style, lighting and composition in plain words. ' +
      'The image is saved in this conversation\'s workspace and shown to the user automatically; do not describe how to view it. ' +
      'Use it only when the user asks for an image.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: `What the picture shows, in detail (at most ${LIMITS.promptChars} characters).` },
        negative_prompt: { type: 'string', description: 'Optional: what to keep out of the picture. Ignored by FLUX models.' },
        aspect: { type: 'string', enum: ASPECTS, description: 'Shape of the picture (default square).' },
        count: { type: 'integer', minimum: 1, maximum: LIMITS.maxCount, description: `How many variations, 1 to ${LIMITS.maxCount} (default 1). Each adds time.` },
        seed: { type: 'integer', minimum: 0, description: 'Optional: repeat a picture exactly by passing the seed a previous result reported.' },
        steps: { type: 'integer', minimum: 1, description: 'Optional: leave unset; the model\'s own default is right almost always.' },
      },
      required: ['prompt'],
    },
  }]
}

const text = (t) => ({ type: 'text', text: t })
const fail = (t) => ({ isError: true, content: [text(t)] })

/** The engine for this machine, installed or being installed. */
async function ensureEngine(backend) {
  const buildKey = chooseSdBuild({ nvidia: await hasNvidia(), backend })
  if (!buildKey) return { ok: false, error: 'Image generation has no engine build for this platform.' }
  const status = sdRuntimeStatus(env.baseDir, buildKey)
  if (status.installed) return { ok: true, binaryPath: status.binaryPath }
  logEvent('image', 'runtime_install_on_first_use', { buildKey })
  const install = installSdRuntime({
    baseDir: env.baseDir, buildKey,
    onProgress: (p) => publish('image:runtime-progress', { buildKey, ...p }),
  })
  install.catch(() => { /* reported below, or by the next call */ })
  const winner = await Promise.race([
    install.then((s) => ({ s }), (err) => ({ err })),
    new Promise((resolve) => setTimeout(() => resolve(null), INSTALL_WAIT_MS).unref?.()),
  ])
  if (winner === null) {
    const mb = Math.round(status.downloadBytes / 1048576)
    return { ok: false, error: `The image engine (${status.label}, ${mb} MB) is downloading for the first time. Tell the user it is not ready yet and to ask again in a few minutes.` }
  }
  if (winner.err) return { ok: false, error: `The image engine could not be installed: ${winner.err.message}` }
  return { ok: true, binaryPath: winner.s.binaryPath }
}

/** A folder for this job's raw output, without '%' (sd-cli reads -o as a pattern). */
function jobFolder() {
  const root = path.join(env.baseDir, 'image-jobs')
  const dir = root.includes('%') ? path.join(os.tmpdir(), 'redstart-image-jobs') : root
  return path.join(dir, randomUUID())
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export async function callTool(name, args, cfg, ctx) {
  if (name !== TOOL_NAME) return null
  const ig = cfg?.imageGeneration
  if (!ig?.enabled) return fail('Image generation is not enabled on this server.')
  if (!env) return fail('Image generation is not initialised.')

  // --- Everything that can fail without the GPU, first. ---
  let model
  try {
    model = resolveImageModel(ig, env.resolveModelsDir())
  } catch (err) {
    return fail(err.message)
  }
  const aspect = args?.aspect === undefined ? 'square' : args.aspect
  if (!ASPECTS.includes(aspect)) return fail(`aspect must be one of ${ASPECTS.join(', ')}.`)
  const { width, height } = sizeFor(aspect, model.defaults)
  const steps = args?.steps === undefined ? model.defaults.steps : args.steps
  if (!Number.isInteger(steps) || steps < 1 || steps > model.maxSteps) return fail(`steps must be a whole number from 1 to ${model.maxSteps} for ${model.familyLabel}.`)
  const seed = args?.seed === undefined ? randomInt(0, 2 ** 31 - 1) : args.seed
  const count = args?.count === undefined ? 1 : args.count
  const job = {
    components: model.components,
    prompt: args?.prompt,
    negativePrompt: model.family.startsWith('flux') ? undefined : args?.negative_prompt,
    width, height, steps, seed, count,
    cfgScale: model.defaults.cfgScale,
    sampler: model.defaults.sampler,
    outputDir: jobFolder(),
  }
  let sdArgs
  try {
    sdArgs = buildSdArgs(job)
  } catch (err) {
    return fail(err.message)
  }

  const account = ctx?.account ?? null
  const conversationId = ctx?.conversationId ?? null
  let ws
  try {
    ws = workspaceDir(ig.documentsRoot, account, conversationId, { create: true })
  } catch (err) {
    return fail(`Could not open this conversation's workspace: ${err.message}`)
  }
  const caps = checkCaps(ig.documentsRoot, account, conversationId, { workspaceCapBytes: ig.workspaceCapBytes, accountCapBytes: ig.accountCapBytes })
  if (!caps.ok) return fail(caps.reason)

  const engine = await ensureEngine(ig.backend ?? 'auto')
  if (!engine.ok) return fail(engine.error)

  // --- The GPU. ---
  const started = Date.now()
  let lease
  try {
    lease = await acquireGpu({ reason: 'image generation' })
  } catch (err) {
    return fail(`The image was not started: ${err.message}`)
  }
  publish('image:progress', { phase: 'starting', count })
  let outcome
  let resume
  try {
    outcome = await env.runJob({
      binaryPath: engine.binaryPath,
      args: sdArgs,
      outputDir: job.outputDir,
      pidDir: env.baseDir,
      timeoutMs: (ig.timeoutS ?? DEFAULT_TIMEOUT_S) * 1000,
      onProgress: (p) => publish('image:progress', { ...p, count }),
    }).then((r) => ({ ok: true, ...r }), (err) => ({ ok: false, error: err.message }))
  } finally {
    resume = await lease.release()
    publish('image:progress', { phase: 'done' })
  }
  const pausedS = lease.paused ? Math.round((Date.now() - started) / 1000) : 0
  const resumeNote = lease.paused && resume?.ok === false ? ` The chat model did not reload afterwards (${resume.error}); an admin needs to start it again.` : ''

  if (!outcome.ok) {
    fs.rmSync(job.outputDir, { recursive: true, force: true })
    logEvent('image', 'generate_failed', { family: model.family })
    return fail(`${outcome.error}${resumeNote}`)
  }

  // --- Into the workspace, as links. ---
  const wsRel = workspaceRelative(conversationId)
  const prefix = `image-${stamp()}`
  const links = []
  for (const [i, src] of outcome.files.entries()) {
    const info = inspectImageFile(src)
    if (!info.ok || info.mimeType !== 'image/png') continue
    const name = count > 1 ? `${prefix}-${i + 1}.png` : `${prefix}.png`
    const dest = path.join(ws, name)
    fs.copyFileSync(src, dest)
    links.push(fileLink(`${wsRel}/${name}`, { bytes: info.bytes, mimeType: 'image/png' }))
  }
  fs.rmSync(job.outputDir, { recursive: true, force: true })
  if (links.length === 0) return fail(`The image engine finished but wrote no usable PNG.${resumeNote}`)

  const seconds = Math.round(outcome.ms / 1000)
  logEvent('image', 'generated', { family: model.family, count: links.length, seconds, paused: lease.paused })
  const summary =
    `Made ${links.length} image${links.length === 1 ? '' : 's'} with ${model.familyLabel}: ${width}×${height}, ${steps} steps, seed ${seed}` +
    `${count > 1 ? ` (one batch; the same seed and count repeat it)` : ''}, in ${seconds} s.` +
    (lease.paused ? ` The chat model was paused for about ${pausedS} s.` : '') +
    ' They are shown to the user already.' + resumeNote
  return { content: [text(summary), ...links] }
}
