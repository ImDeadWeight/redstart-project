// =============================================================================
// Image models suite — daemon/image-models.mjs (+ getImageRepo in hf-catalog)
// =============================================================================
// What has to hold:
//   - a family is recognised from the repo's own card where it says so (cases
//     taken from the live Hub, 2026-11-20)
//   - every companion is pinned (repo, revision, size, sha256)
//   - a download takes its size and checksum from the Hub, asked by the
//     daemon, never from the caller; only a top-level weight file listed by
//     the repo can be fetched; a gated repo is refused up front
//   - saved names are one contained component; companions are shared by the
//     family and fetched once
//   - a job gets absolute paths for every slot its family needs, or a reason
//
// No network: the repo lookup is faked, the transport shimmed.
// Run: node scripts/test-image-models.mjs
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
async function rejects(fn, re, why) {
  let err = null
  try { await fn() } catch (e) { err = e }
  assert(err, `expected a rejection: ${why}`)
  assert(re.test(err.message), `${why}: wrong error "${err.message}"`)
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-image-models-'))
const { initLogger } = await import('../daemon/logger.mjs')
initLogger(base)
const {
  FAMILIES, COMPANIONS, detectFamily, savedName, imageDir, readImageIndex, listImageModels,
  downloadImageModel, deleteImageModel, resolveImageModel, IMAGE_INDEX,
} = await import('../daemon/image-models.mjs')
const { setDownloadTransportForTests } = await import('../daemon/model-download.mjs')

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const modelsDir = path.join(base, 'Models')
fs.mkdirSync(modelsDir)

// ---------------------------------------------------------------------------
console.log('\n-- families --')

await test('🔍 the family comes from the repo\'s own card (live Hub cases)', () => {
  const cases = [
    [{ repoId: 'leejet/FLUX.1-schnell-gguf', baseModels: ['black-forest-labs/FLUX.1-schnell'] }, 'flux1-schnell'],
    [{ repoId: 'city96/FLUX.1-schnell-gguf', baseModels: ['black-forest-labs/FLUX.1-schnell'] }, 'flux1-schnell'],
    [{ repoId: 'black-forest-labs/FLUX.1-schnell' }, 'flux1-schnell'],
    [{ repoId: 'someone/fine-tune', baseModels: ['black-forest-labs/FLUX.1-dev'] }, 'flux1-dev'],
    [{ repoId: 'stabilityai/stable-diffusion-xl-base-1.0' }, 'sdxl'],
    [{ repoId: 'someone/anime-xl', tags: ['stable-diffusion-xl'] }, 'sdxl'],
    [{ repoId: 'stable-diffusion-v1-5/stable-diffusion-v1-5' }, 'sd1'],
    [{ repoId: 'someone/mystery-model', tags: ['text-to-image'] }, null],
  ]
  for (const [info, want] of cases) assert(detectFamily(info) === want, `${info.repoId}: ${detectFamily(info)} (wanted ${want})`)
})

await test('🔍 every companion is pinned, and every family names only pinned companions', () => {
  for (const [key, c] of Object.entries(COMPANIONS)) {
    assert(/^[0-9a-f]{40}$/.test(c.revision), `${key}: revision`)
    assert(/^[0-9a-f]{64}$/.test(c.sha256), `${key}: sha256`)
    assert(Number.isInteger(c.size) && c.size > 0, `${key}: size`)
    assert(['clipL', 't5xxl', 'vae', 'clipG', 'llm'].includes(c.slot), `${key}: slot ${c.slot}`)
  }
  for (const [id, f] of Object.entries(FAMILIES)) {
    for (const k of f.companions) assert(COMPANIONS[k], `${id} names an unpinned companion ${k}`)
    assert(['model', 'diffusionModel'].includes(f.slot), `${id}: slot`)
    assert(f.defaults.steps <= f.maxSteps, `${id}: default steps over its cap`)
  }
})

await test('🔍 saved names are one safe component, qualified by repo', () => {
  assert(savedName('leejet/FLUX.1-schnell-gguf', 'flux1-schnell-q4_k.gguf') === 'leejet_FLUX.1-schnell-gguf.flux1-schnell-q4_k.gguf', 'basic')
  for (const [r, f] of [['a/b', '../../x.gguf'], ['a/b', 'dir\\x.safetensors'], ['../x', 'm.gguf'], ['a/b', 'we ird?.safetensors']]) {
    const n = savedName(r, f)
    assert(n === path.basename(n) && !n.includes('..') && !/[\\/:?* ]/.test(n), `${r} + ${f} → ${n}`)
  }
  let threw = false
  try { savedName('a/b', 'model.exe') } catch { threw = true }
  assert(threw, 'a non-weight file got a name')
})

// ---------------------------------------------------------------------------
console.log('\n-- downloads --')

// Fake bytes, small, for the main file and every companion.
const bytes = {
  'flux1-schnell-q4_k.gguf': Buffer.from('FLUX'.repeat(50)),
  'model.safetensors': Buffer.from('SDXL'.repeat(40)),
}
for (const c of Object.values(COMPANIONS)) bytes[c.rfilename.split('/').pop()] = Buffer.from(`companion ${c.rfilename}`)
// The pinned companions carry real sizes and hashes; point them at the fakes.
const realCompanions = structuredClone(COMPANIONS)
for (const c of Object.values(COMPANIONS)) {
  const b = bytes[c.rfilename.split('/').pop()]
  c.size = b.length
  c.sha256 = sha256(b)
}

const requested = []
setDownloadTransportForTests(async (url) => {
  requested.push(url)
  const name = decodeURIComponent(url.split('/').pop())
  const b = bytes[name]
  return b ? new Response(b, { status: 200, headers: { 'content-length': String(b.length) } }) : new Response(null, { status: 404 })
})

const REV = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const repo = (files, extra = {}) => async (repoId) => ({ repoId, revision: REV, gated: false, files, ...extra })
const fluxFiles = [{ rfilename: 'flux1-schnell-q4_k.gguf', size: bytes['flux1-schnell-q4_k.gguf'].length, sha256: sha256(bytes['flux1-schnell-q4_k.gguf']) }]

await test('🔍 a FLUX model comes down with its three companions, checked against the Hub\'s hashes', async () => {
  requested.length = 0
  const r = await downloadImageModel({ repoId: 'leejet/FLUX.1-schnell-gguf', rfilename: 'flux1-schnell-q4_k.gguf', family: 'flux1-schnell', modelsDir, repoInfo: repo(fluxFiles) })
  assert(r.file === 'leejet_FLUX.1-schnell-gguf.flux1-schnell-q4_k.gguf', r.file)
  assert(requested.length === 4, `${requested.length} requests`)
  assert(requested.every((u) => u.startsWith('https://huggingface.co/')), requested.join(' '))
  assert(requested[0].includes(`/resolve/${REV}/`), 'the main file was not pinned to the revision')
  for (const c of Object.values(COMPANIONS)) assert(requested.some((u) => u.includes(`/resolve/${c.revision}/`)), `${c.rfilename} not pinned`)
  const listed = listImageModels(modelsDir)
  assert(listed.length === 1 && listed[0].ready && listed[0].family === 'flux1-schnell', JSON.stringify(listed))
})

await test('🔍 a second model of the same family reuses the companions', async () => {
  requested.length = 0
  await downloadImageModel({ repoId: 'city96/FLUX.1-schnell-gguf', rfilename: 'flux1-schnell-q4_k.gguf', family: 'flux1-schnell', modelsDir, repoInfo: repo(fluxFiles) })
  assert(requested.length === 1, `${requested.length} requests: companions were fetched again`)
})

await test('🔍 a checksum mismatch never lands, and nothing is indexed', async () => {
  const lying = [{ ...fluxFiles[0], sha256: 'f'.repeat(64) }]
  await rejects(() => downloadImageModel({ repoId: 'liar/FLUX-gguf', rfilename: 'flux1-schnell-q4_k.gguf', family: 'flux1-schnell', modelsDir, repoInfo: repo(lying) }), /Checksum/i, 'bad hash')
  assert(!fs.existsSync(path.join(imageDir(modelsDir), 'liar_FLUX-gguf.flux1-schnell-q4_k.gguf')), 'landed')
  assert(!readImageIndex(modelsDir)['liar_FLUX-gguf.flux1-schnell-q4_k.gguf'], 'indexed')
})

await test('🔍 only a top-level weight file the repo lists can be fetched; gated and unknown are refused up front', async () => {
  requested.length = 0
  await rejects(() => downloadImageModel({ repoId: 'a/b', rfilename: '../../secrets.gguf', family: 'sdxl', modelsDir, repoInfo: repo([]) }), /not a top-level/, 'unlisted file')
  await rejects(() => downloadImageModel({ repoId: 'a/b', rfilename: 'model.safetensors', family: 'sdxl', modelsDir, repoInfo: repo([{ rfilename: 'model.safetensors', size: 1, sha256: null }], { gated: true }) }), /Hugging Face account/, 'gated')
  await rejects(() => downloadImageModel({ repoId: 'a/b', rfilename: 'model.safetensors', family: 'midjourney', modelsDir, repoInfo: repo([]) }), /Unknown image model family/, 'family')
  await rejects(() => downloadImageModel({ repoId: 'not a repo', rfilename: 'x.gguf', family: 'sdxl', modelsDir, repoInfo: repo([]) }), /repository id/, 'repo id')
  assert(requested.length === 0, `${requested.length} requests made before refusing`)
})

await test('an SDXL checkpoint is one file, no companions', async () => {
  requested.length = 0
  const b = bytes['model.safetensors']
  await downloadImageModel({ repoId: 'someone/anime-xl', rfilename: 'model.safetensors', family: 'sdxl', modelsDir, repoInfo: repo([{ rfilename: 'model.safetensors', size: b.length, sha256: sha256(b) }]) })
  assert(requested.length === 1, `${requested.length} requests`)
})

// ---------------------------------------------------------------------------
console.log('\n-- the active model, for a job --')

await test('🔍 the job gets absolute paths for every slot its family needs, and its defaults', () => {
  const r = resolveImageModel({ model: 'leejet_FLUX.1-schnell-gguf.flux1-schnell-q4_k.gguf' }, modelsDir)
  assert(r.family === 'flux1-schnell' && r.defaults.steps === 4 && r.maxSteps === 8, JSON.stringify(r))
  for (const slot of ['diffusionModel', 'clipL', 't5xxl', 'vae']) assert(path.isAbsolute(r.components[slot]) && fs.existsSync(r.components[slot]), `${slot}: ${r.components[slot]}`)
  const x = resolveImageModel({ model: 'someone_anime-xl.model.safetensors' }, modelsDir)
  assert(Object.keys(x.components).join() === 'model', JSON.stringify(x.components))
})

await test('🔍 nothing chosen, a name not in the index, or a missing companion: a reason, not a job', () => {
  const fails = (cfg) => { try { resolveImageModel(cfg, modelsDir); return null } catch (e) { return e.message } }
  assert(/No image model is chosen/.test(fails({ model: null })), 'none chosen')
  assert(/No image model is chosen/.test(fails({ model: '../../etc/passwd' })), 'a path was accepted as a model')
  const vae = path.join(imageDir(modelsDir), savedName(COMPANIONS['flux1-vae'].repoId, COMPANIONS['flux1-vae'].rfilename))
  fs.renameSync(vae, vae + '.away')
  assert(/vae file is missing/.test(fails({ model: 'leejet_FLUX.1-schnell-gguf.flux1-schnell-q4_k.gguf' })), 'missing companion')
  assert(listImageModels(modelsDir).find((m) => m.family === 'flux1-schnell')?.ready === false, 'listed as ready without its VAE')
  fs.renameSync(vae + '.away', vae)
})

await test('deleting a model keeps the shared companions', () => {
  deleteImageModel(modelsDir, 'city96_FLUX.1-schnell-gguf.flux1-schnell-q4_k.gguf')
  assert(!readImageIndex(modelsDir)['city96_FLUX.1-schnell-gguf.flux1-schnell-q4_k.gguf'], 'still indexed')
  assert(resolveImageModel({ model: 'leejet_FLUX.1-schnell-gguf.flux1-schnell-q4_k.gguf' }, modelsDir).components.vae, 'companions went with it')
  let threw = false
  try { deleteImageModel(modelsDir, '../Models/x') } catch { threw = true }
  assert(threw, 'a path was accepted for deletion')
})

await test('a damaged index reads as empty', () => {
  fs.writeFileSync(path.join(imageDir(modelsDir), IMAGE_INDEX), '{nope')
  assert(Object.keys(readImageIndex(modelsDir)).length === 0, 'garbage parsed')
})

// ---------------------------------------------------------------------------

Object.assign(COMPANIONS, realCompanions)
setDownloadTransportForTests(null)
fs.rmSync(base, { recursive: true, force: true })
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
