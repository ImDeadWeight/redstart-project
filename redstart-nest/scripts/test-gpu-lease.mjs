// =============================================================================
// GPU lease suite — daemon/gpu-lease.mjs
// =============================================================================
// What has to hold:
//   - one holder at a time, served in order; an abort while queued leaves the
//     queue working for everyone behind
//   - release() always resumes a paused model, once, however the job ended
//   - a busy model (drain timeout) or one that will not exit refuses the lease
//     and resumes nothing
//   - with no model running the lease pauses and resumes nothing
//   - the marker exists exactly while the lease is held, records the INTENT
//     to pause before the kill, and recovery relaunches the config it names
//
// Fakes for suspend/resume; the real ones are test-model-suspend.mjs's.
// Run: node scripts/test-gpu-lease.mjs
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-gpu-lease-'))
const { initLogger } = await import('../daemon/logger.mjs')
initLogger(dir)
const { initGpuLease, acquireGpu, recoverGpuLease, gpuLeaseHolder, LEASE_MARKER } = await import('../daemon/gpu-lease.mjs')
const marker = path.join(dir, LEASE_MARKER)
const readMarker = () => JSON.parse(fs.readFileSync(marker, 'utf8'))

const CONFIG = { modelPath: 'chat.gguf', port: 19080 }

function setup({ suspend, resume, config = CONFIG } = {}) {
  const log = []
  initGpuLease({
    suspend: suspend ?? (async (o) => { log.push(`suspend:${o.reason}`); return { ok: true } }),
    resume: resume ?? (async () => { log.push('resume'); return { ok: true, ms: 1 } }),
    markerDir: dir,
    currentConfig: () => config,
  })
  return log
}

// ---------------------------------------------------------------------------
console.log('\n-- holding and releasing --')

await test('🔍 acquire pauses the model; release resumes it, once, however often it is called', async () => {
  const log = setup()
  const lease = await acquireGpu({ reason: 'image generation' })
  assert(lease.paused === true, 'not paused')
  assert(gpuLeaseHolder()?.reason === 'image generation', JSON.stringify(gpuLeaseHolder()))
  const [a, b] = await Promise.all([lease.release(), lease.release()])
  await lease.release()
  assert(a.ok && a === b, 'release results differ')
  assert(JSON.stringify(log) === JSON.stringify(['suspend:image generation', 'resume']), log.join(','))
  assert(gpuLeaseHolder() === null, 'still held after release')
})

await test('🔍 one holder at a time, in order', async () => {
  const log = setup()
  const order = []
  const job = async (name, ms) => {
    const lease = await acquireGpu({ reason: name })
    order.push(`start ${name}`)
    await sleep(ms)
    order.push(`end ${name}`)
    await lease.release()
  }
  await Promise.all([job('a', 60), job('b', 10), job('c', 10)])
  assert(order.join(',') === 'start a,end a,start b,end b,start c,end c', order.join(','))
  assert(log.filter((x) => x === 'resume').length === 3, log.join(','))
})

await test('🔍 an abort while queued leaves, and the queue keeps working', async () => {
  setup()
  const first = await acquireGpu({ reason: 'first' })
  const ac = new AbortController()
  const queued = acquireGpu({ reason: 'aborted', signal: ac.signal }).then(() => 'acquired', (e) => e.name)
  const third = acquireGpu({ reason: 'third' })
  await sleep(20)
  ac.abort()
  assert(await queued === 'AbortError', 'the aborted caller acquired anyway')
  await first.release()
  const t = await Promise.race([third, sleep(1000).then(() => null)])
  assert(t, 'the caller behind an aborted one never got the GPU')
  await t.release()
})

await test('a release after a thrown job still resumes the model', async () => {
  const log = setup()
  const job = async () => {
    const lease = await acquireGpu()
    try { throw new Error('sd crashed') } finally { await lease.release() }
  }
  let threw = false
  try { await job() } catch { threw = true }
  assert(threw && log.at(-1) === 'resume', log.join(','))
})

// ---------------------------------------------------------------------------
console.log('\n-- refusals --')

await test('🔍 a busy model refuses the lease, resumes nothing, and frees the queue', async () => {
  const log = setup({ suspend: async () => ({ ok: false, busy: true, error: 'The model is still answering' }) })
  let msg = null
  try { await acquireGpu() } catch (err) { msg = err.message }
  assert(/still answering/.test(msg), msg)
  assert(!log.includes('resume'), 'resumed a model that was never paused')
  assert(!fs.existsSync(marker), 'marker left behind')
  setup()
  const next = await Promise.race([acquireGpu(), sleep(1000).then(() => null)])
  assert(next, 'the queue stayed blocked after a refusal')
  await next.release()
})

await test('🔍 with no model running, nothing is paused or resumed', async () => {
  const log = setup({ suspend: async () => ({ ok: false, notRunning: true }), config: null })
  const lease = await acquireGpu()
  assert(lease.paused === false, 'reported a pause')
  const r = await lease.release()
  assert(r.skipped && !log.includes('resume'), JSON.stringify(r))
})

await test('a resume that fails is reported by release, and the lease is still let go', async () => {
  setup({ resume: async () => ({ ok: false, error: 'did not come back' }) })
  const lease = await acquireGpu()
  const r = await lease.release()
  assert(r.ok === false && /did not come back/.test(r.error), JSON.stringify(r))
  assert(gpuLeaseHolder() === null && !fs.existsSync(marker), 'still held')
})

// ---------------------------------------------------------------------------
console.log('\n-- the marker and recovery --')

await test('🔍 the marker exists exactly while held, and says "paused" before the kill', async () => {
  let seenDuringSuspend = null
  setup({ suspend: async () => { seenDuringSuspend = readMarker(); return { ok: true } } })
  const lease = await acquireGpu()
  assert(seenDuringSuspend?.paused === true && seenDuringSuspend.config?.modelPath === 'chat.gguf', `marker during the pause: ${JSON.stringify(seenDuringSuspend)}`)
  assert(fs.existsSync(marker), 'no marker while held')
  await lease.release()
  assert(!fs.existsSync(marker), 'marker after release')
})

await test('🔍 recovery relaunches the paused config and removes the marker', async () => {
  fs.writeFileSync(marker, JSON.stringify({ since: 1, reason: 'image generation', paused: true, config: CONFIG }))
  let relaunched = null
  let reaped = false
  const r = await recoverGpuLease({ markerDir: dir, reap: async () => { reaped = true }, relaunch: async (c) => { relaunched = c; return { success: true } } })
  assert(r.found && r.relaunched, JSON.stringify(r))
  assert(relaunched?.modelPath === 'chat.gguf' && reaped, 'wrong config or no reap')
  assert(!fs.existsSync(marker), 'marker survived recovery')
})

await test('recovery with nothing paused, an unreadable marker, or no marker relaunches nothing', async () => {
  let calls = 0
  const relaunch = async () => { calls++; return { success: true } }
  fs.writeFileSync(marker, JSON.stringify({ paused: false, config: null }))
  assert((await recoverGpuLease({ markerDir: dir, relaunch })).relaunched === false, 'relaunched with nothing paused')
  fs.writeFileSync(marker, '{garbage')
  const g = await recoverGpuLease({ markerDir: dir, relaunch })
  assert(g.found && !g.relaunched && !fs.existsSync(marker), JSON.stringify(g))
  assert((await recoverGpuLease({ markerDir: dir, relaunch })).found === false, 'found a marker that is not there')
  assert(calls === 0, `relaunched ${calls} time(s)`)
})

await test('a relaunch that fails is reported, never thrown', async () => {
  fs.writeFileSync(marker, JSON.stringify({ paused: true, config: CONFIG }))
  const r = await recoverGpuLease({ markerDir: dir, relaunch: async () => { throw new Error('port in use') } })
  assert(r.found && !r.relaunched && /port in use/.test(r.error), JSON.stringify(r))
})

// ---------------------------------------------------------------------------

fs.rmSync(dir, { recursive: true, force: true })
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
