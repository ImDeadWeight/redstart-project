// =============================================================================
// Image engine suite — daemon/sd-runtime.mjs (the pinned download) and
// daemon/sd-job.mjs (sd-cli's arguments, progress and process).
// =============================================================================
// What has to hold:
//   - the pin is complete: every asset has a size and a sha256, and names
//     this release
//   - the install fetches only this release from GitHub (every redirect hop
//     checked), verifies before it opens a zip, refuses an entry with a path
//     in its name, and leaves nothing half-installed
//   - sd-cli gets an argv array in which nothing the model sent is a path,
//     every number is in range, and the prompt cannot pose as a flag
//   - a job that fails, hangs or is cancelled ends with the process gone, its
//     pidfile removed and a reason the model can read
//
// No network: a transport shim serves canned responses. node stands in for
// sd-cli. Run: node scripts/test-sd-runtime.mjs
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
  return err
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-sd-runtime-'))
const { initLogger } = await import('../daemon/logger.mjs')
initLogger(base)
const { SD_RELEASE, SD_BUILDS, chooseSdBuild, isSdReleaseUrl, flatEntryName, installSdRuntime, sdRuntimeStatus, sdRuntimeDir } = await import('../daemon/sd-runtime.mjs')
const { setDownloadTransportForTests } = await import('../daemon/model-download.mjs')
const { createZip } = await import('../daemon/zip.mjs')
const { buildSdArgs, createProgressParser, runSdJob, jobOutputs, SD_PID_FILE, LIMITS } = await import('../daemon/sd-job.mjs')

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

// ---------------------------------------------------------------------------
console.log('\n-- the pin --')

await test('🔍 every build is pinned: release in each name, a size and a sha256 per asset', () => {
  const short = SD_RELEASE.split('-').pop()
  for (const [key, b] of Object.entries(SD_BUILDS)) {
    assert(b.binary === (key.startsWith('win32') ? 'sd-cli.exe' : 'sd-cli'), `${key}: binary ${b.binary}`)
    for (const a of b.assets) {
      assert(/^[0-9a-f]{64}$/.test(a.sha256), `${key}/${a.file}: sha256`)
      assert(Number.isInteger(a.size) && a.size > 1_000_000, `${key}/${a.file}: size`)
      assert(a.file.includes(short) || a.file.startsWith('cudart-'), `${key}/${a.file}: not this release`)
    }
  }
  return `${SD_RELEASE}, ${Object.keys(SD_BUILDS).length} builds`
})

await test('the build follows the machine: CUDA with an NVIDIA GPU, Vulkan otherwise, Metal on Apple Silicon', () => {
  assert(chooseSdBuild({ platform: 'win32', arch: 'x64', nvidia: true }) === 'win32-x64-cuda', 'nvidia')
  assert(chooseSdBuild({ platform: 'win32', arch: 'x64', nvidia: false }) === 'win32-x64-vulkan', 'no nvidia')
  assert(chooseSdBuild({ platform: 'win32', arch: 'x64', nvidia: true, backend: 'vulkan' }) === 'win32-x64-vulkan', 'forced vulkan')
  assert(chooseSdBuild({ platform: 'win32', arch: 'x64', nvidia: false, backend: 'cuda' }) === 'win32-x64-cuda', 'forced cuda')
  assert(chooseSdBuild({ platform: 'linux', arch: 'x64' }) === 'linux-x64-vulkan', 'linux')
  assert(chooseSdBuild({ platform: 'darwin', arch: 'arm64' }) === 'darwin-arm64-metal', 'mac')
  assert(chooseSdBuild({ platform: 'darwin', arch: 'x64' }) === null && chooseSdBuild({ platform: 'win32', arch: 'arm64' }) === null, 'unsupported got a build')
})

await test('🔍 only this release on github.com, or GitHub\'s release-asset hosts, over https', () => {
  const ok = [
    `https://github.com/leejet/stable-diffusion.cpp/releases/download/${SD_RELEASE}/x.zip`,
    'https://objects.githubusercontent.com/github-production-release-asset/abc',
    'https://release-assets.githubusercontent.com/github-production-release-asset/abc',
  ]
  const bad = [
    `http://github.com/leejet/stable-diffusion.cpp/releases/download/${SD_RELEASE}/x.zip`,
    'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-1-0000000/x.zip',
    `https://github.com/someone/stable-diffusion.cpp/releases/download/${SD_RELEASE}/x.zip`,
    `https://github.com/leejet/stable-diffusion.cpp/releases/download/${SD_RELEASE}/../../evil`,
    'https://evil.githubusercontent.com.example/x',
    'https://user:pw@objects.githubusercontent.com/x',
    'https://objects.githubusercontent.com:8443/x',
    'not a url',
  ]
  for (const u of ok) assert(isSdReleaseUrl(u), `refused ${u}`)
  for (const u of bad) assert(!isSdReleaseUrl(u), `allowed ${u}`)
})

await test('🔍 a zip entry is a plain file name or it is refused', () => {
  for (const n of ['sd-cli.exe', 'ggml-cuda.dll', 'libwebp.so.7']) assert(flatEntryName(n) === n, n)
  for (const n of ['bin/sd-cli.exe', '..\\x.dll', '../x', '/etc/passwd', 'C:x.dll', '.hidden', '..', '', 'a\0b']) assert(flatEntryName(n) === null, `accepted ${JSON.stringify(n)}`)
})

// ---------------------------------------------------------------------------
console.log('\n-- the install --')

const binaryName = process.platform === 'win32' ? 'sd-cli.exe' : 'sd-cli'
function addTestBuild(key, zipBuf) {
  SD_BUILDS[key] = { label: 'test', binary: binaryName, assets: [{ file: `sd-master-test-${key}.zip`, size: zipBuf.length, sha256: sha256(zipBuf) }] }
}
const requested = []
function serve(map) {
  requested.length = 0
  setDownloadTransportForTests(async (url) => {
    requested.push(url)
    const name = url.split('/').pop()
    if (map.redirect) return new Response(null, { status: 302, headers: { location: map.redirect } })
    const buf = map[name]
    if (!buf) return new Response(null, { status: 404 })
    return new Response(buf, { status: 200, headers: { 'content-length': String(buf.length) } })
  })
}

await test('🔍 a verified zip is unpacked flat and recorded; status then says installed', async () => {
  const zip = createZip({ [binaryName]: Buffer.from('fake engine'), 'ggml.dll': Buffer.from('lib'), 'LICENSE.txt': Buffer.from('MIT') })
  addTestBuild('t-ok', zip)
  serve({ ['sd-master-test-t-ok.zip']: zip })
  const s = await installSdRuntime({ baseDir: base, buildKey: 't-ok' })
  assert(s.installed && s.binaryPath === path.join(sdRuntimeDir(base, 't-ok'), binaryName), JSON.stringify(s))
  assert(fs.readFileSync(path.join(sdRuntimeDir(base, 't-ok'), 'ggml.dll'), 'utf8') === 'lib', 'library not unpacked')
  assert(!fs.existsSync(`${sdRuntimeDir(base, 't-ok')}.staging`), 'staging left behind')
  assert(!fs.existsSync(path.join(base, 'runtimes', 'downloads', 'sd-master-test-t-ok.zip')), 'zip left behind after unpacking')
  assert(sdRuntimeStatus(base, 't-ok').installed, 'status disagrees')
  requested.length = 0
  await installSdRuntime({ baseDir: base, buildKey: 't-ok' })
  assert(requested.length === 0, 'an installed runtime was downloaded again')
})

await test('🔍 a zip that does not match its sha256 is never opened', async () => {
  const good = createZip({ [binaryName]: Buffer.from('x') })
  addTestBuild('t-hash', good)
  serve({ ['sd-master-test-t-hash.zip']: createZip({ [binaryName]: Buffer.from('tampered') }) })
  await rejects(() => installSdRuntime({ baseDir: base, buildKey: 't-hash' }), /checksum|size/i, 'tampered zip')
  assert(!fs.existsSync(sdRuntimeDir(base, 't-hash')) && !sdRuntimeStatus(base, 't-hash').installed, 'installed anyway')
})

await test('🔍 an entry with a path in its name refuses the whole install, leaving nothing', async () => {
  const zip = createZip({ [binaryName]: Buffer.from('x'), '../escape.dll': Buffer.from('evil') })
  addTestBuild('t-path', zip)
  serve({ ['sd-master-test-t-path.zip']: zip })
  await rejects(() => installSdRuntime({ baseDir: base, buildKey: 't-path' }), /path in its name/, 'traversal entry')
  assert(!fs.existsSync(path.join(base, 'runtimes', 'escape.dll')) && !fs.existsSync(path.join(base, 'escape.dll')), 'the entry escaped')
  assert(!fs.existsSync(sdRuntimeDir(base, 't-path')) && !fs.existsSync(`${sdRuntimeDir(base, 't-path')}.staging`), 'half-installed')
})

await test('a zip without the engine binary is refused', async () => {
  const zip = createZip({ 'README.txt': Buffer.from('no binary here') })
  addTestBuild('t-nobin', zip)
  serve({ ['sd-master-test-t-nobin.zip']: zip })
  await rejects(() => installSdRuntime({ baseDir: base, buildKey: 't-nobin' }), /did not contain/, 'missing binary')
  assert(!sdRuntimeStatus(base, 't-nobin').installed, 'installed without a binary')
})

await test('🔍 a redirect off GitHub is refused before it is followed', async () => {
  const zip = createZip({ [binaryName]: Buffer.from('x') })
  addTestBuild('t-redir', zip)
  serve({ redirect: 'https://evil.example/sd.zip' })
  await rejects(() => installSdRuntime({ baseDir: base, buildKey: 't-redir' }), /.+/, 'off-allowlist redirect')
  assert(!requested.some((u) => u.includes('evil.example')), `followed the redirect: ${requested.join(', ')}`)
})

// ---------------------------------------------------------------------------
console.log('\n-- sd-cli arguments --')

const abs = (p) => path.resolve(base, p)
const goodJob = () => ({
  components: { diffusionModel: abs('flux.gguf'), clipL: abs('clip_l.safetensors'), t5xxl: abs('t5.gguf'), vae: abs('ae.safetensors') },
  prompt: 'a red bird', width: 1024, height: 768, steps: 4, cfgScale: 1, sampler: 'euler', seed: 42, count: 1,
  outputDir: abs('job'),
})

await test('🔍 an argv array with each component flag, the numbers, and an output inside the job folder', () => {
  const args = buildSdArgs(goodJob())
  const at = (f) => args[args.indexOf(f) + 1]
  assert(at('--diffusion-model') === abs('flux.gguf') && at('--clip_l') && at('--t5xxl') && at('--vae'), args.join(' '))
  assert(at('-W') === '1024' && at('-H') === '768' && at('--steps') === '4' && at('-s') === '42' && at('-b') === '1', args.join(' '))
  assert(at('-o') === path.join(abs('job'), 'image_1.png'), at('-o'))
  assert(buildSdArgs({ ...goodJob(), count: 3 })[args.indexOf('-o') + 1].endsWith('image_%d.png'), 'batch output is not a pattern')
})

await test('🔍 a prompt that starts with "-" cannot pose as a flag; control characters are removed', () => {
  const args = buildSdArgs({ ...goodJob(), prompt: '--vae C:\\evil.safetensors', negativePrompt: '-x' })
  assert(args[args.indexOf('-p') + 1] === ' --vae C:\\evil.safetensors', 'leading dash kept')
  assert(args[args.indexOf('-n') + 1] === ' -x', 'negative leading dash kept')
  assert(args.filter((a) => a === '--vae').length === 1, 'the prompt added a flag')
  assert(buildSdArgs({ ...goodJob(), prompt: 'a\u0000b\u0007c' })[args.indexOf('-p') + 1] === 'a b c', 'control characters passed')
})

await test('🔍 out-of-range or malformed values are refused with a reason', () => {
  const bad = [
    [{ prompt: '' }, /empty/], [{ prompt: 'x'.repeat(LIMITS.promptChars + 1) }, /longer/],
    [{ width: 1000 }, /multiples/], [{ width: 4096 }, /Width/], [{ height: 128 }, /Height/],
    [{ steps: 0 }, /Steps/], [{ steps: 999 }, /Steps/], [{ count: 9 }, /Count/], [{ seed: -1 }, /Seed/],
    [{ cfgScale: 99 }, /cfg/], [{ sampler: 'rm -rf' }, /sampler/],
    [{ components: { diffusionModel: 'relative.gguf' } }, /absolute/],
    [{ components: { vae: abs('ae.safetensors') } }, /weights/],
    [{ components: { diffusionModel: abs('f.gguf'), lora: abs('x') } }, /Unknown model component/],
    [{ outputDir: 'relative' }, /absolute/], [{ outputDir: abs('100%') }, /%/],
  ]
  for (const [patch, re] of bad) {
    let msg = null
    try { buildSdArgs({ ...goodJob(), ...patch }) } catch (e) { msg = e.message }
    assert(msg && re.test(msg), `${JSON.stringify(patch).slice(0, 60)} → ${msg}`)
  }
})

// ---------------------------------------------------------------------------
console.log('\n-- progress --')

await test('progress is read off sd-cli\'s own output (captured from the pinned release)', () => {
  // Abridged from a real run (plan §8): ANSI erase codes, \r redraws, a batch of 2.
  const out = [
    '[I] get_sigmas with Flux scheduler --- denoiser.hpp:1199\n',
    '[I] sampling using Euler method --- request.cpp:478\n',
    '  |##################################################| 219/219 -   4.47GB/s\x1b[K\r',
    '[I] generating image: 1/1 - seed 7 --- image.cpp:1005\n',
    '  |============>                                     | 1/4 -  10.54s/it\x1b[K\r  |=========================>                        | 2/4 -   3.05s/it\x1b[K\r',
    '  |=====================================>            | 3/4\x1b[K\r  |==================================================| 4/4 -   3.05s/it\x1b[K\r',
    '  |============>                                     | 1/4\x1b[K\r  |==================================================| 4/4\x1b[K\r\n',
    '[I] decoding 2 latents --- image.cpp:689\n',
    "[I] save result image 0 to 'x.png' (success) --- main.cpp:501\n",
  ]
  const seen = []
  const p = createProgressParser((e) => seen.push(e))
  for (const c of out) p.push(Buffer.from(c))
  p.flush()
  const steps = seen.filter((e) => e.step > 0).map((e) => `${e.image}:${e.step}/${e.steps}`)
  assert(steps.join(' ') === '1:1/4 1:2/4 1:3/4 1:4/4 2:1/4 2:4/4', steps.join(' '))
  assert(!seen.some((e) => e.steps === 219), 'a tensor-loading bar was reported as sampling')
  const phases = [...new Set(seen.map((e) => e.phase))]
  assert(phases.join(',') === 'sampling,decoding,saving', phases.join(','))
})

// ---------------------------------------------------------------------------
console.log('\n-- the process --')

// node standing in for sd-cli: the script is the first argv.
const fakeBinary = process.execPath
const pidDir = path.join(base, 'pids')
fs.mkdirSync(pidDir, { recursive: true })
const script = (body) => ['-e', body]

await test('🔍 a job that writes its images resolves with them, and removes its pidfile', async () => {
  const outputDir = path.join(base, 'job-ok')
  const body = `const fs=require('fs');const p=require('path');console.log('[I] sampling using Euler method');process.stdout.write('  |====| 1/2\\r  |========| 2/2\\r\\n');fs.writeFileSync(p.join(${JSON.stringify(outputDir)},'image_0.png'),'png');fs.writeFileSync(p.join(${JSON.stringify(outputDir)},'image_1.png'),'png')`
  const seen = []
  const r = await runSdJob({ binaryPath: fakeBinary, args: script(body), outputDir, pidDir, onProgress: (e) => seen.push(e) })
  assert(r.files.length === 2 && r.files[0].endsWith('image_0.png'), JSON.stringify(r))
  assert(seen.some((e) => e.step === 2 && e.steps === 2), JSON.stringify(seen))
  assert(!fs.existsSync(path.join(pidDir, SD_PID_FILE)), 'pidfile left behind')
})

await test('🔍 a job that fails reports the end of its output', async () => {
  const outputDir = path.join(base, 'job-fail')
  const body = `console.error('[E] cudaMalloc failed: out of memory');process.exit(1)`
  const err = await rejects(() => runSdJob({ binaryPath: fakeBinary, args: script(body), outputDir, pidDir }), /exit 1.*out of memory/, 'failing job')
  assert(!fs.existsSync(path.join(pidDir, SD_PID_FILE)), 'pidfile left behind')
  return err.message
})

await test('a job that exits 0 but wrote nothing is a failure, not an empty success', async () => {
  await rejects(() => runSdJob({ binaryPath: fakeBinary, args: script('0'), outputDir: path.join(base, 'job-empty'), pidDir }), /failed/, 'no output')
})

await test('🔍 a hung job is killed at the timeout; a cancelled one at the abort', async () => {
  const hang = script('setInterval(() => {}, 1000)')
  await rejects(() => runSdJob({ binaryPath: fakeBinary, args: hang, outputDir: path.join(base, 'job-hang'), pidDir, timeoutMs: 300 }), /longer than/, 'timeout')
  const ac = new AbortController()
  const p = runSdJob({ binaryPath: fakeBinary, args: hang, outputDir: path.join(base, 'job-abort'), pidDir, signal: ac.signal })
  setTimeout(() => ac.abort(), 200)
  const err = await rejects(() => p, /cancelled/, 'abort')
  assert(err.name === 'AbortError', err.name)
  assert(!fs.existsSync(path.join(pidDir, SD_PID_FILE)), 'pidfile left behind')
})

await test('outputs are listed in order, and only the engine\'s own names', () => {
  const d = path.join(base, 'list')
  fs.mkdirSync(d)
  for (const n of ['image_10.png', 'image_2.png', 'other.png', 'image_1.png.part']) fs.writeFileSync(path.join(d, n), '')
  assert(jobOutputs(d).map((f) => path.basename(f)).join(',') === 'image_2.png,image_10.png', jobOutputs(d).join(','))
})

// ---------------------------------------------------------------------------

setDownloadTransportForTests(null)
fs.rmSync(base, { recursive: true, force: true })
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
