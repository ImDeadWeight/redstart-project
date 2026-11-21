// =============================================================================
// Vision projector suite — daemon/projector.mjs, its use in llama-args.mjs and
// ipc/models.mjs.
// =============================================================================
// What has to hold:
//   - a projector is told apart from a model by name, wherever it comes from
//   - its saved name is one contained path component, qualified by repo, so
//     two repos' mmproj-F16.gguf cannot overwrite each other
//   - the pairing file survives garbage and never yields a path
//   - --mmproj is passed exactly when resolveProjector says so, and never for
//     a missing file or a profile that turned vision off
//   - the listing marks projectors (not chat models) and the paired model,
//     and deleting either side drops the pairing
//
// No network, no llama-server. Run:  node scripts/test-projector.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

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

// buildArgs reads isPackaged, which platform-paths refuses before init (see
// test-llama-args.mjs). Neither directory is touched here.
const { initPaths } = await import('../daemon/platform-paths.mjs')
initPaths({ config: 'unused-by-buildArgs/config', capabilityBase: 'unused-by-buildArgs/data', isPackaged: false })

const {
  isProjectorFile, pickProjector, projectorDestName, readProjectorIndex,
  recordProjector, forgetProjectorPairing, resolveProjector, PROJECTOR_INDEX,
} = await import('../daemon/projector.mjs')
const { buildArgs } = await import('../daemon/llama-args.mjs')
const { listLocalModels, deleteLocalModel } = await import('../daemon/ipc/models.mjs')

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-projector-'))
const modelsDir = path.join(base, 'Models')
fs.mkdirSync(modelsDir)
const touch = (name, bytes = 'x') => { fs.writeFileSync(path.join(modelsDir, name), bytes); return path.join(modelsDir, name) }

const baseConfig = { modelPath: '', ctxSize: 4096, batchSize: 512, threads: 4, port: 19080 }

// ---------------------------------------------------------------------------
console.log('\n-- telling a projector apart --')

await test('🔍 mmproj files are projectors, by basename, in any case', () => {
  for (const n of ['mmproj-F16.gguf', 'MMPROJ-BF16.GGUF', 'sub/mmproj-model-f16.gguf', 'x\\Qwen3-VL-mmproj-f16.gguf']) {
    assert(isProjectorFile(n), `${n} not recognised`)
  }
  for (const n of ['Qwen3-VL-8B-Q4_K_M.gguf', 'mmproj/model-Q4_K_M.gguf', '', null, 42]) {
    assert(!isProjectorFile(n), `${n} taken for a projector`)
  }
})

await test('the preferred precision is F16, then BF16, Q8_0, F32, then anything', () => {
  const pick = (names) => pickProjector(names.map(rfilename => ({ rfilename, size: 1 })))?.rfilename
  assert(pick(['mmproj-Q8_0.gguf', 'mmproj-F32.gguf', 'mmproj-F16.gguf']) === 'mmproj-F16.gguf', 'F16 not first')
  assert(pick(['mmproj-Q8_0.gguf', 'mmproj-BF16.gguf']) === 'mmproj-BF16.gguf', 'BF16 not before Q8_0')
  assert(pick(['mmproj-model-q4_k.gguf']) === 'mmproj-model-q4_k.gguf', 'an unranked projector was dropped')
  assert(pick(['model-Q4_K_M.gguf', 'README.md']) === undefined, 'invented a projector')
  assert(pickProjector([{ rfilename: 'mmproj-F16.gguf', lfs: { sha256: 'h', size: 7 } }]).size === 7, 'lfs size not used')
})

// ---------------------------------------------------------------------------
console.log('\n-- the saved name --')

await test('🔍 the saved name is one path component, qualified by repo', () => {
  const a = projectorDestName('unsloth/Qwen3-VL-8B-Instruct-GGUF', 'mmproj-F16.gguf')
  const b = projectorDestName('bartowski/Qwen3-VL-8B-Instruct-GGUF', 'mmproj-F16.gguf')
  assert(a === 'unsloth_Qwen3-VL-8B-Instruct-GGUF.mmproj-F16.gguf', a)
  assert(a !== b, 'two repos map to the same file')
  for (const [repo, file] of [['a/b', '../../mmproj-F16.gguf'], ['a/b', '..\\..\\mmproj-F16.gguf'], ['../x', 'mmproj-F16.gguf'], ['a/b', 'dir/mmproj f16?.gguf']]) {
    const n = projectorDestName(repo, file)
    assert(n === path.basename(n) && !n.includes('..') && !/[\\/:?* ]/.test(n), `${repo} + ${file} → ${n}`)
    assert(isProjectorFile(n) && n.endsWith('.gguf'), `${n} no longer reads as a projector GGUF`)
  }
  return a
})

await test('🔍 only an mmproj GGUF gets a saved name', () => {
  for (const f of ['model-F16.gguf', 'mmproj-F16.exe', 'mmproj.json']) {
    let threw = false
    try { projectorDestName('a/b', f) } catch { threw = true }
    assert(threw, `${f} was given a name`)
  }
})

// ---------------------------------------------------------------------------
console.log('\n-- the pairing file --')

await test('record, read and forget a pairing', () => {
  recordProjector(modelsDir, 'a-Q4.gguf', 'r_a.mmproj-F16.gguf')
  recordProjector(modelsDir, 'a-Q8.gguf', 'r_a.mmproj-F16.gguf')
  recordProjector(modelsDir, 'b-Q4.gguf', 'r_b.mmproj-F16.gguf')
  assert(readProjectorIndex(modelsDir)['a-Q8.gguf'] === 'r_a.mmproj-F16.gguf', 'not recorded')
  forgetProjectorPairing(modelsDir, 'b-Q4.gguf')
  assert(!('b-Q4.gguf' in readProjectorIndex(modelsDir)), 'model side not forgotten')
  forgetProjectorPairing(modelsDir, 'r_a.mmproj-F16.gguf')
  assert(Object.keys(readProjectorIndex(modelsDir)).length === 0, 'projector side left pairings behind')
})

await test('🔍 a damaged pairing file reads as empty, and an entry with a path in it is dropped', () => {
  fs.writeFileSync(path.join(modelsDir, PROJECTOR_INDEX), '{not json')
  assert(Object.keys(readProjectorIndex(modelsDir)).length === 0, 'garbage parsed')
  fs.writeFileSync(path.join(modelsDir, PROJECTOR_INDEX), '[1,2]')
  assert(Object.keys(readProjectorIndex(modelsDir)).length === 0, 'an array was taken for a map')
  fs.writeFileSync(path.join(modelsDir, PROJECTOR_INDEX), JSON.stringify({
    'ok.gguf': 'p.mmproj.gguf', 'evil.gguf': '../../etc/passwd', '../up.gguf': 'p.gguf', 'n.gguf': 5,
  }))
  const idx = readProjectorIndex(modelsDir)
  assert(JSON.stringify(idx) === JSON.stringify({ 'ok.gguf': 'p.mmproj.gguf' }), JSON.stringify(idx))
  fs.rmSync(path.join(modelsDir, PROJECTOR_INDEX))
})

// ---------------------------------------------------------------------------
console.log('\n-- the launch decision and --mmproj --')

const mmprojOf = (config) => {
  const args = buildArgs(resolveProjector(config).config, true)
  const i = args.indexOf('--mmproj')
  return i === -1 ? null : args[i + 1]
}

await test('🔍 a paired model launches with --mmproj and its projector', () => {
  const model = touch('vis-Q4_K_M.gguf')
  const proj = touch('r_vis.mmproj-F16.gguf')
  recordProjector(modelsDir, 'vis-Q4_K_M.gguf', 'r_vis.mmproj-F16.gguf')
  const r = resolveProjector({ ...baseConfig, modelPath: model })
  assert(r.decision.source === 'paired', r.decision.source)
  assert(mmprojOf({ ...baseConfig, modelPath: model }) === proj, 'wrong or no --mmproj')
  assert(/vision: on/.test(r.logLine), r.logLine)
  return r.logLine
})

await test('🔍 a text model launches with no --mmproj at all', () => {
  const model = touch('text-Q4_K_M.gguf')
  assert(mmprojOf({ ...baseConfig, modelPath: model }) === null, '--mmproj on a text model')
  assert(mmprojOf({ ...baseConfig, modelPath: '' }) === null, '--mmproj with no model')
})

await test('🔍 a paired projector that has gone missing is a warning, never a dangling --mmproj', () => {
  const model = touch('gone-Q4.gguf')
  recordProjector(modelsDir, 'gone-Q4.gguf', 'r_gone.mmproj-F16.gguf')
  const r = resolveProjector({ ...baseConfig, modelPath: model })
  assert(r.decision.source === 'none' && /missing/.test(r.decision.warning), JSON.stringify(r.decision))
  assert(mmprojOf({ ...baseConfig, modelPath: model }) === null, 'passed a missing file')
})

await test('the profile\'s own projector wins over the pairing; a missing one is a warning', () => {
  const model = path.join(modelsDir, 'vis-Q4_K_M.gguf')
  const own = touch('my-own-mmproj.gguf')
  assert(mmprojOf({ ...baseConfig, modelPath: model, mmprojPath: own }) === own, 'profile projector ignored')
  const r = resolveProjector({ ...baseConfig, modelPath: model, mmprojPath: path.join(modelsDir, 'nope.gguf') })
  assert(r.decision.source === 'none' && /missing/.test(r.decision.warning), JSON.stringify(r.decision))
  assert(!('mmprojPath' in r.config), 'a missing profile projector reached buildArgs')
})

await test('🔍 vision: false turns it off even for a paired model', () => {
  const model = path.join(modelsDir, 'vis-Q4_K_M.gguf')
  assert(mmprojOf({ ...baseConfig, modelPath: model, vision: false }) === null, 'vision:false still passed --mmproj')
  assert(mmprojOf({ ...baseConfig, modelPath: model, vision: false, mmprojPath: path.join(modelsDir, 'my-own-mmproj.gguf') }) === null, 'vision:false lost to mmprojPath')
})

await test('the preview quotes the projector path like every other path', () => {
  const args = buildArgs({ ...baseConfig, modelPath: 'C:\\m dir\\m.gguf', mmprojPath: 'C:\\m dir\\p.mmproj.gguf' })
  assert(args[args.indexOf('--mmproj') + 1] === '"C:\\m dir\\p.mmproj.gguf"', args.join(' '))
})

// ---------------------------------------------------------------------------
console.log('\n-- the models listing --')

await test('🔍 the listing marks a projector as not-a-chat-model and names a paired model\'s projector', async () => {
  const res = await listLocalModels({ resolveModelsDir: () => modelsDir })
  const by = Object.fromEntries(res.files.map(f => [f.name, f]))
  assert(by['r_vis.mmproj-F16.gguf'].projector === true, 'projector not flagged')
  assert(by['vis-Q4_K_M.gguf'].projector === false, 'model flagged as a projector')
  assert(by['vis-Q4_K_M.gguf'].visionProjector === 'r_vis.mmproj-F16.gguf', 'pairing not reported')
  assert(by['text-Q4_K_M.gguf'].visionProjector === null, 'a text model reported a projector')
  assert(!(PROJECTOR_INDEX in by), 'the pairing file was listed as a model')
})

await test('deleting a model drops its pairing', async () => {
  const r = await deleteLocalModel('vis-Q4_K_M.gguf', { resolveModelsDir: () => modelsDir })
  assert(r.ok, r.error)
  assert(!('vis-Q4_K_M.gguf' in readProjectorIndex(modelsDir)), 'pairing survived the delete')
})

// ---------------------------------------------------------------------------

fs.rmSync(base, { recursive: true, force: true })

const passed = results.filter(r => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
