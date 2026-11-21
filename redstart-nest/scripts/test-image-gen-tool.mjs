// =============================================================================
// generate_image suite — daemon/image-gen-tool.mjs
// =============================================================================
// What has to hold:
//   - off means absent: no tool advertised, a call refused
//   - everything that can fail without the GPU fails BEFORE the lease is
//     taken, so a bad request never pauses the chat model
//   - the lease is always released (and the model resumed) whatever the job
//     did; a failed job leaves no output folder behind
//   - images land in the caller's own chat workspace, are real PNGs, and come
//     back as links, never bytes; anything else the engine wrote is ignored
//   - a model that did not reload is reported, not hidden
//
// Fakes: the GPU lease's suspend/resume, the job runner. The real ones are
// tested in test-gpu-lease / test-model-suspend / test-sd-runtime, and the
// whole chain was run for real (plan §8). Run: node scripts/test-image-gen-tool.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'

const results = []
async function test(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false, err })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-image-tool-'))
const { initLogger } = await import('../daemon/logger.mjs')
initLogger(base)
const { initImageGenTool, toolDefs, callTool, sizeFor, TOOL_NAME } = await import('../daemon/image-gen-tool.mjs')
const { initGpuLease } = await import('../daemon/gpu-lease.mjs')
const { savedName, imageDir, COMPANIONS, IMAGE_INDEX } = await import('../daemon/image-models.mjs')
const { chooseSdBuild, sdRuntimeDir, SD_BUILDS, SD_RELEASE } = await import('../daemon/sd-runtime.mjs')
const { userScopePath } = await import('../daemon/user-scope.mjs')

// --- A models folder with an indexed FLUX model and its companions. ---
const modelsDir = path.join(base, 'Models')
fs.mkdirSync(imageDir(modelsDir), { recursive: true })
const MAIN = savedName('leejet/FLUX.1-schnell-gguf', 'flux1-schnell-q4_k.gguf')
for (const n of [MAIN, ...Object.values(COMPANIONS).map((c) => savedName(c.repoId, c.rfilename))]) fs.writeFileSync(path.join(imageDir(modelsDir), n), 'weights')
fs.writeFileSync(path.join(imageDir(modelsDir), IMAGE_INDEX), JSON.stringify({ models: { [MAIN]: { repoId: 'leejet/FLUX.1-schnell-gguf', revision: 'r', rfilename: 'flux1-schnell-q4_k.gguf', family: 'flux1-schnell', bytes: 7 } } }))

// --- An "installed" engine (never run: the job runner is faked). ---
const buildKey = chooseSdBuild({ nvidia: false })
fs.mkdirSync(sdRuntimeDir(base, buildKey), { recursive: true })
fs.writeFileSync(path.join(sdRuntimeDir(base, buildKey), SD_BUILDS[buildKey].binary), '')
fs.writeFileSync(path.join(sdRuntimeDir(base, buildKey), 'install.json'), JSON.stringify({ release: SD_RELEASE, buildKey }))

const docs = path.join(base, 'Documents')
fs.mkdirSync(docs)
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(13)])
PNG.writeUInt32BE(1344, 16); PNG.writeUInt32BE(768, 20)

let log
let jobs
function setup({ job, suspend, resume } = {}) {
  log = []
  jobs = []
  initGpuLease({
    suspend: suspend ?? (async () => { log.push('suspend'); return { ok: true } }),
    resume: resume ?? (async () => { log.push('resume'); return { ok: true } }),
    markerDir: base,
    currentConfig: () => ({ modelPath: 'chat.gguf' }),
  })
  initImageGenTool({
    resolveModelsDir: () => modelsDir,
    baseDir: base,
    nvidia: async () => false,
    runJob: async (opts) => {
      jobs.push(opts)
      log.push('job')
      fs.mkdirSync(opts.outputDir, { recursive: true }) // as the real runSdJob does
      return (job ?? defaultJob)(opts)
    },
  })
}
const defaultJob = async ({ outputDir, args }) => {
  const n = Number(args[args.indexOf('-b') + 1])
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(outputDir, `image_${n > 1 ? i : 1}.png`), PNG)
  return { files: fs.readdirSync(outputDir).sort().map((f) => path.join(outputDir, f)), ms: 1234 }
}

const cfg = (over = {}) => ({ imageGeneration: { enabled: true, documentsRoot: docs, model: MAIN, backend: 'auto', timeoutS: 60, workspaceCapBytes: 200 * 2 ** 20, accountCapBytes: 2 * 2 ** 30, ...over } })
const ctx = { account: null, conversationId: 'conv-1' }
const ws = path.join(docs, userScopePath(null), 'chats', 'conv-1')
const textOf = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')

// ---------------------------------------------------------------------------
console.log('\n-- off means absent --')

await test('🔍 not advertised and refused while the capability is off', async () => {
  setup()
  assert(toolDefs({ imageGeneration: { enabled: false } }).length === 0, 'advertised while off')
  assert(toolDefs({}).length === 0, 'advertised with no config')
  assert(toolDefs(cfg())[0]?.name === TOOL_NAME, 'not advertised while on')
  const r = await callTool(TOOL_NAME, { prompt: 'x' }, { imageGeneration: { enabled: false } }, ctx)
  assert(r.isError && log.length === 0, JSON.stringify(r))
  assert(await callTool('other_tool', {}, cfg(), ctx) === null, 'claimed another tool')
})

// ---------------------------------------------------------------------------
console.log('\n-- refused before the GPU is touched --')

await test('🔍 a bad request never pauses the chat model', async () => {
  setup()
  const bad = [
    [{ prompt: '' }, /empty/],
    [{ prompt: 'x'.repeat(5000) }, /longer/],
    [{ prompt: 'x', aspect: 'panorama' }, /aspect/],
    [{ prompt: 'x', steps: 50 }, /steps.*1 to 8/],
    [{ prompt: 'x', count: 9 }, /Count/],
    [{ prompt: 'x', seed: -4 }, /Seed/],
  ]
  for (const [args, re] of bad) {
    const r = await callTool(TOOL_NAME, args, cfg(), ctx)
    assert(r.isError && re.test(textOf(r)), `${JSON.stringify(args).slice(0, 40)} → ${textOf(r)}`)
  }
  assert(log.length === 0, `the GPU was touched: ${log.join(',')}`)
})

await test('🔍 no model chosen, or a missing model file: refused before the GPU', async () => {
  setup()
  const none = await callTool(TOOL_NAME, { prompt: 'x' }, cfg({ model: null }), ctx)
  assert(none.isError && /No image model is chosen/.test(textOf(none)), textOf(none))
  const vae = path.join(imageDir(modelsDir), savedName(COMPANIONS['flux1-vae'].repoId, COMPANIONS['flux1-vae'].rfilename))
  fs.renameSync(vae, vae + '.x')
  const missing = await callTool(TOOL_NAME, { prompt: 'x' }, cfg(), ctx)
  fs.renameSync(vae + '.x', vae)
  assert(missing.isError && /missing/.test(textOf(missing)), textOf(missing))
  assert(log.length === 0, `the GPU was touched: ${log.join(',')}`)
})

await test('a workspace over its cap is refused before the GPU', async () => {
  setup()
  fs.mkdirSync(ws, { recursive: true })
  fs.writeFileSync(path.join(ws, 'big.bin'), Buffer.alloc(2048))
  const r = await callTool(TOOL_NAME, { prompt: 'x' }, cfg({ workspaceCapBytes: 1024 }), ctx)
  fs.rmSync(path.join(ws, 'big.bin'))
  assert(r.isError && /limit/.test(textOf(r)) && log.length === 0, textOf(r))
})

// ---------------------------------------------------------------------------
console.log('\n-- the job --')

await test('🔍 an image lands in the chat workspace as a PNG link, and the model is resumed', async () => {
  setup()
  const r = await callTool(TOOL_NAME, { prompt: 'a cozy reading nook', aspect: 'landscape', seed: 9 }, cfg(), ctx)
  assert(!r.isError, textOf(r))
  assert(log.join(',') === 'suspend,job,resume', log.join(','))
  const links = r.content.filter((c) => c.type === 'resource_link')
  assert(links.length === 1 && links[0].mimeType === 'image/png', JSON.stringify(links))
  const rel = decodeURIComponent(links[0].uri.split('path=')[1])
  assert(rel.startsWith('chats/conv-1/image-') && fs.existsSync(path.join(docs, userScopePath(null), rel)), rel)
  assert(!JSON.stringify(r).includes('base64'), 'bytes in the result')
  assert(/1344×768, 4 steps, seed 9/.test(textOf(r)) && /paused/.test(textOf(r)), textOf(r))
  const args = jobs[0].args
  assert(args[args.indexOf('-W') + 1] === '1344' && args[args.indexOf('--steps') + 1] === '4' && args[args.indexOf('--cfg-scale') + 1] === '1', args.join(' '))
  assert(!fs.existsSync(jobs[0].outputDir), 'the job folder was left behind')
  return textOf(r)
})

await test('a batch of three gives three numbered images', async () => {
  setup()
  const r = await callTool(TOOL_NAME, { prompt: 'variations', count: 3 }, cfg(), ctx)
  const names = r.content.filter((c) => c.type === 'resource_link').map((c) => c.name)
  assert(names.length === 3 && names.every((n, i) => n.endsWith(`-${i + 1}.png`)), names.join(','))
})

await test('🔍 a failed job still resumes the model, cleans up, and says why', async () => {
  setup({ job: async ({ outputDir }) => { fs.writeFileSync(path.join(outputDir, 'partial.tmp'), 'x'); throw new Error('The image engine failed (exit 1): out of memory') } })
  const r = await callTool(TOOL_NAME, { prompt: 'x' }, cfg(), ctx)
  assert(r.isError && /out of memory/.test(textOf(r)), textOf(r))
  assert(log.join(',') === 'suspend,job,resume', log.join(','))
  assert(!fs.existsSync(jobs[0].outputDir), 'the failed job\'s folder was left behind')
})

await test('🔍 a file the engine wrote that is not a PNG is never linked', async () => {
  setup({ job: async ({ outputDir }) => {
    fs.writeFileSync(path.join(outputDir, 'image_1.png'), 'not a png at all')
    return { files: [path.join(outputDir, 'image_1.png')], ms: 5 }
  } })
  const r = await callTool(TOOL_NAME, { prompt: 'x' }, cfg(), ctx)
  assert(r.isError && /no usable PNG/.test(textOf(r)), textOf(r))
})

await test('🔍 a busy chat model: the image is not started, and nothing is resumed', async () => {
  setup({ suspend: async () => { log.push('suspend'); return { ok: false, busy: true, error: 'The model is still answering after 60 s' } } })
  const r = await callTool(TOOL_NAME, { prompt: 'x' }, cfg(), ctx)
  assert(r.isError && /not started.*still answering/.test(textOf(r)), textOf(r))
  assert(log.join(',') === 'suspend', log.join(','))
})

await test('🔍 a chat model that did not reload is reported with the image', async () => {
  setup({ resume: async () => { log.push('resume'); return { ok: false, error: 'did not come back within 180 s' } } })
  const r = await callTool(TOOL_NAME, { prompt: 'x' }, cfg(), ctx)
  assert(!r.isError && /did not reload afterwards.*180 s/.test(textOf(r)), textOf(r))
})

await test('FLUX ignores a negative prompt; the size follows the family\'s native square', () => {
  assert(JSON.stringify(sizeFor('square', { width: 1024, height: 1024 })) === '{"width":1024,"height":1024}', 'square')
  assert(JSON.stringify(sizeFor('portrait', { width: 1024, height: 1024 })) === '{"width":768,"height":1344}', 'portrait')
  assert(JSON.stringify(sizeFor('landscape', { width: 512, height: 512 })) === '{"width":704,"height":384}', 'sd1 landscape')
})

await test('the negative prompt is not passed for FLUX', async () => {
  setup()
  await callTool(TOOL_NAME, { prompt: 'x', negative_prompt: 'blurry' }, cfg(), ctx)
  assert(!jobs[0].args.includes('-n'), jobs[0].args.join(' '))
})

// ---------------------------------------------------------------------------

fs.rmSync(base, { recursive: true, force: true })
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
