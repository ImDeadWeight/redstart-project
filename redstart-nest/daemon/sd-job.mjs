'use strict'

// =============================================================================
// Redstart Nest — one image job: sd-cli's arguments, the process, its progress
// =============================================================================
// A job is ONE process (plan §1, "why a one-shot CLI"): the GPU lease has
// already paused the chat model, sd-cli loads the image model, generates
// `count` images, writes them, and exits — and process exit is the only VRAM
// release that is certain.
//
// THE ARGUMENTS (buildSdArgs) are an argv array, never a shell string. Every
// path in them is one Nest chose: the model files come from a recipe's
// downloaded components, the output folder is a fresh job folder Nest made.
// Nothing the model sends becomes a path; what it sends (prompt, negative
// prompt, size, steps, seed, count) is validated and capped here, whoever
// called. Windows' command line is 32 K characters, so prompts are capped well
// under that.
//
// THE OUTPUT goes to a job folder of Nest's own (`<config>/image-jobs/<id>/`),
// not straight into a workspace: sd-cli reads a `%d` in the output path as a
// printf pattern, and a user's folder name may contain '%'. The caller moves
// the PNGs into the workspace afterwards.
//
// THE PROGRESS is read off sd-cli's own console bars (format captured from
// the pinned release, plan §8): tensor loading draws `#`, sampling draws `=`,
// each with "n/N". Phases come from its log lines.
// =============================================================================

import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { writePidFile, deletePidFile } from './process-supervision.mjs'

export const SD_PID_FILE = 'sd.pid'

export const LIMITS = {
  promptChars: 2000,
  negativeChars: 1000,
  minSide: 256,
  maxSide: 2048,
  sideMultiple: 64,
  maxPixels: 2048 * 2048,
  maxSteps: 60,
  maxCount: 4,
  maxCfg: 30,
}

const COMPONENT_FLAGS = {
  model: '--model',
  diffusionModel: '--diffusion-model',
  clipL: '--clip_l',
  clipG: '--clip_g',
  t5xxl: '--t5xxl',
  llm: '--llm',
  vae: '--vae',
}

export const SAMPLERS = ['euler', 'euler_a', 'heun', 'dpm2', 'dpm++2s_a', 'dpm++2m', 'dpm++2mv2', 'ipndm', 'ipndm_v', 'lcm', 'ddim_trailing', 'tcd']

function cleanText(value, max, what) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error(`${what} must be text.`)
  // Control characters (NUL above all) have no place in a prompt or argv.
  const text = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim()
  if (text.length > max) throw new Error(`${what} is longer than ${max} characters.`)
  return text
}

function intIn(value, min, max, what) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${what} must be a whole number from ${min} to ${max}.`)
  return n
}

// sd-cli reads the token after -p as the prompt, but a prompt that itself
// starts with '-' is safer not to look like a flag at all.
const notAFlag = (text) => (text.startsWith('-') ? ` ${text}` : text)

/**
 * argv for sd-cli. Throws with a message fit for the model on bad input.
 *
 * @param {{
 *   components: Record<string, string>,  // absolute paths, keyed as COMPONENT_FLAGS
 *   prompt: string, negativePrompt?: string,
 *   width: number, height: number, steps: number, cfgScale: number,
 *   sampler: string, seed: number, count: number,
 *   outputDir: string,                    // absolute, Nest's own job folder
 *   extraArgs?: string[],                 // from the recipe, never from the model
 * }} job
 * @returns {string[]}
 */
export function buildSdArgs(job) {
  const args = []
  const components = job.components || {}
  let haveWeights = false
  for (const [key, flag] of Object.entries(COMPONENT_FLAGS)) {
    const p = components[key]
    if (p === undefined || p === null) continue
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error(`The ${key} file path must be absolute.`)
    args.push(flag, p)
    if (key === 'model' || key === 'diffusionModel') haveWeights = true
  }
  for (const key of Object.keys(components)) {
    if (!(key in COMPONENT_FLAGS)) throw new Error(`Unknown model component: ${key}`)
  }
  if (!haveWeights) throw new Error('No image model weights were given.')

  const prompt = cleanText(job.prompt, LIMITS.promptChars, 'The prompt')
  if (!prompt) throw new Error('The prompt is empty.')
  const negative = cleanText(job.negativePrompt, LIMITS.negativeChars, 'The negative prompt')

  const width = intIn(job.width, LIMITS.minSide, LIMITS.maxSide, 'Width')
  const height = intIn(job.height, LIMITS.minSide, LIMITS.maxSide, 'Height')
  if (width % LIMITS.sideMultiple || height % LIMITS.sideMultiple) throw new Error(`Width and height must be multiples of ${LIMITS.sideMultiple}.`)
  if (width * height > LIMITS.maxPixels) throw new Error('That image is too large.')
  const steps = intIn(job.steps, 1, LIMITS.maxSteps, 'Steps')
  const count = intIn(job.count ?? 1, 1, LIMITS.maxCount, 'Count')
  const seed = intIn(job.seed, 0, 2 ** 31 - 1, 'Seed')
  const cfg = Number(job.cfgScale)
  if (!Number.isFinite(cfg) || cfg < 0 || cfg > LIMITS.maxCfg) throw new Error(`cfg_scale must be from 0 to ${LIMITS.maxCfg}.`)
  if (!SAMPLERS.includes(job.sampler)) throw new Error(`Unknown sampler: ${String(job.sampler).slice(0, 40)}`)

  if (typeof job.outputDir !== 'string' || !path.isAbsolute(job.outputDir)) throw new Error('The output folder must be absolute.')
  if (job.outputDir.includes('%')) throw new Error('The output folder may not contain "%" (sd-cli reads it as a pattern).')

  args.push('-p', notAFlag(prompt))
  if (negative) args.push('-n', notAFlag(negative))
  args.push(
    '-W', String(width), '-H', String(height),
    '--steps', String(steps),
    '--cfg-scale', String(cfg),
    '--sampling-method', job.sampler,
    '-s', String(seed),
    '-b', String(count),
    '-o', path.join(job.outputDir, count > 1 ? 'image_%d.png' : 'image_1.png'),
  )
  for (const a of job.extraArgs || []) {
    if (typeof a !== 'string') throw new Error('A recipe argument is not text.')
    args.push(a)
  }
  return args
}

/** The PNGs a finished job wrote, in order. */
export function jobOutputs(outputDir) {
  try {
    return fs.readdirSync(outputDir)
      .filter((n) => /^image_\d+\.png$/.test(n))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
      .map((n) => path.join(outputDir, n))
  } catch {
    return []
  }
}

/**
 * Turns sd-cli's console output into progress events. Feed it raw chunks.
 * Phases: loading → sampling (step/steps, and which image of a batch) →
 * decoding → saving. (The pinned release logs "sampling using" before the
 * text encoders finish, so 'encoding' is rarely seen; it is reported when it is.)
 */
export function createProgressParser(onProgress) {
  let buffer = ''
  let phase = 'loading'
  // With a batch, sampling's n/N restarts per image; a smaller n than the
  // last one means the next image.
  let image = 1
  let lastStep = 0
  const emit = (p) => onProgress?.(p)
  const handle = (piece) => {
    const line = piece.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim()
    if (!line) return
    if (/get_learned_condition|conditioning/i.test(line) && phase === 'loading') { phase = 'encoding'; emit({ phase }) }
    if (/sampling using|generating image/i.test(line) && phase !== 'sampling') { phase = 'sampling'; emit({ phase, step: 0 }) }
    if (/decoding \d+ latents|decode_first_stage/i.test(line) && phase !== 'decoding') { phase = 'decoding'; emit({ phase }) }
    if (/save result image/i.test(line) && phase !== 'saving') { phase = 'saving'; emit({ phase }) }
    // Sampling bars are drawn with '='; loading bars with '#'.
    const bar = /\|([=>\s]+)\|\s*(\d+)\/(\d+)/.exec(line)
    if (bar && phase === 'sampling') {
      const step = Number(bar[2])
      if (step < lastStep) image++
      lastStep = step
      emit({ phase, step, steps: Number(bar[3]), image })
    }
  }
  return {
    push(chunk) {
      buffer += chunk.toString()
      // Bars redraw with \r (and \x1b[K); log lines end with \n.
      const parts = buffer.split(/\r|\n/)
      buffer = parts.pop()
      for (const p of parts) handle(p)
    },
    flush() { if (buffer) handle(buffer); buffer = '' },
  }
}

/**
 * Run one sd-cli process. Resolves with the output files; rejects with the
 * tail of its output on a non-zero exit, a timeout, or an abort.
 *
 * @param {{ binaryPath: string, args: string[], outputDir: string, pidDir: string, signal?: AbortSignal, timeoutMs?: number, onProgress?: (p: object) => void, spawnImpl?: typeof spawn }} opts
 * @returns {Promise<{ files: string[], ms: number }>}
 */
export function runSdJob({ binaryPath, args, outputDir, pidDir, signal, timeoutMs = 240_000, onProgress, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Image generation was cancelled.'), { name: 'AbortError' }))
    fs.mkdirSync(outputDir, { recursive: true })
    const started = Date.now()
    const child = spawnImpl(binaryPath, args, {
      cwd: path.dirname(binaryPath),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    writePidFile(pidDir, { pid: child.pid, binaryPath, startedAt: started }, { name: SD_PID_FILE })

    const tail = []
    const parser = createProgressParser(onProgress)
    const onData = (chunk) => {
      parser.push(chunk)
      for (const l of chunk.toString().split(/\r|\n/)) {
        const clean = l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim()
        if (clean && !/^\|/.test(clean)) { tail.push(clean); if (tail.length > 30) tail.shift() }
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    let ended = false
    let why = null
    const kill = (reason) => {
      if (ended) return
      why = reason
      try { child.kill() } catch { /* gone */ }
    }
    const timer = setTimeout(() => kill(`Image generation took longer than ${Math.round(timeoutMs / 1000)} s and was stopped.`), timeoutMs)
    const onAbort = () => kill('Image generation was cancelled.')
    signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (err, value) => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      deletePidFile(pidDir, { name: SD_PID_FILE })
      parser.flush()
      if (err) reject(err)
      else resolve(value)
    }
    child.on('error', (err) => finish(new Error(`The image engine could not start: ${err.message}`)))
    child.on('exit', (code, sig) => {
      if (why) return finish(Object.assign(new Error(why), why.includes('cancelled') ? { name: 'AbortError' } : {}))
      const files = jobOutputs(outputDir)
      if (code === 0 && files.length > 0) return finish(null, { files, ms: Date.now() - started })
      const last = tail.slice(-6).join(' | ')
      finish(new Error(`The image engine failed (exit ${code ?? sig})${last ? `: ${last}` : ''}`))
    })
  })
}
