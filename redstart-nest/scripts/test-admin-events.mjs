// =============================================================================
// GET /admin/events — the control plane's live feed (Phase 5 §5.3).
// =============================================================================
// Three things worth pinning against a real socket:
//
//   1. THE GATE reaches this route the same way it reaches every other one —
//      admin-listener.mjs authenticates and authorises BEFORE dispatch, so
//      there is no separate check here to have forgotten.
//   2. A CONNECTING CLIENT REPLAYS THE RING BUFFER FIRST, as one batch, before
//      any live event — a reconnecting admin sees recent history immediately
//      rather than an empty terminal that slowly fills back in.
//   3. A PUBLISHED EVENT REACHES A CONNECTED CLIENT, framed as SSE
//      (`data: {...}\n\n`), which is what src/api/http.ts's reader parses.
//
// Run:  node scripts/test-admin-events.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-admin-events-test-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir

register('./auth-test-loader.mjs', import.meta.url)
await import('./electron-stub.mjs')

const { startAdminListener, stopAdminListener } = await import('../electron/main/admin-listener.mjs')
const { createOwner, createAccount, login, CONTROL_PLANE } = await import('../electron/main/auth.mjs')
const { publish } = await import('../electron/main/event-broker.mjs')
const { initProcessLog, appendLine: appendProcessLine } = await import('../electron/main/process-log.mjs')

const PORT = 48386
const admin = `http://127.0.0.1:${PORT}`

const results = []

async function test(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

initProcessLog(fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-admin-events-logs-')))
appendProcessLine('a line from before this client connected')

const ownerResult = createOwner({ username: 'owner', password: 'owner-pw-1234' })
if (!ownerResult.ok) throw new Error(`could not create the owner: ${ownerResult.error}`)
const subAdmin = createAccount(ownerResult.account, { username: 'sub', password: 'sub-pw-1234', tier: 'admin' })
if (!subAdmin.ok) throw new Error(`could not create the admin: ${subAdmin.error}`)

const ownerToken = login('owner', 'owner-pw-1234', CONTROL_PLANE).token
const adminToken = login('sub', 'sub-pw-1234', CONTROL_PLANE).token

await startAdminListener({ bindHost: '127.0.0.1', port: PORT })

/**
 * Reads SSE frames off a fetch Response body until `count` are collected or
 * it times out. Never issues a second concurrent reader.read() — each
 * pending read is re-raced against a fresh timeout rather than abandoned and
 * replaced, which is what a naive per-iteration timeout would do.
 */
async function readFrames(res, count, timeoutMs = 2000) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const frames = []
  let pending = reader.read()
  const deadline = Date.now() + timeoutMs
  while (frames.length < count) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const timedOut = Symbol('timeout')
    const result = await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve(timedOut), remaining)),
    ])
    if (result === timedOut) break
    if (result.done) break
    buf += decoder.decode(result.value, { stream: true })
    let sep
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, sep)
      buf = buf.slice(sep + 2)
      const dataLine = frame.split('\n').find(l => l.startsWith('data: '))
      if (dataLine) frames.push(JSON.parse(dataLine.slice('data: '.length)))
    }
    pending = reader.read()
  }
  reader.cancel().catch(() => {})
  return frames
}

console.log('\n-- the gate --')

await test('🔍 an anonymous caller is refused', async () => {
  const res = await fetch(`${admin}/admin/events`)
  assert(res.status === 401, `expected 401, got ${res.status}`)
})

await test('🔍 an admin-tier session is refused (403, not owner)', async () => {
  const res = await fetch(`${admin}/admin/events`, { headers: { Authorization: `Bearer ${adminToken}` } })
  assert(res.status === 403, `expected 403, got ${res.status}`)
})

await test('a POST is refused', async () => {
  const res = await fetch(`${admin}/admin/events`, { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}` } })
  assert(res.status === 405, `expected 405, got ${res.status}`)
})

console.log('\n-- the feed --')

await test('🔍 connecting replays the ring buffer before anything else', async () => {
  const res = await fetch(`${admin}/admin/events`, { headers: { Authorization: `Bearer ${ownerToken}` } })
  assert(res.status === 200, `expected 200, got ${res.status}`)
  assert(res.headers.get('content-type')?.includes('text/event-stream'), 'wrong content type')
  const [first] = await readFrames(res, 1)
  assert(first?.type === 'replay', `expected a replay frame first, got ${JSON.stringify(first)}`)
  assert(first.channel === 'server:log', 'replay carried the wrong channel')
  assert(first.lines.includes('a line from before this client connected'), 'the ring buffer was not replayed')
})

await test('🔍 a published event reaches a connected client', async () => {
  const res = await fetch(`${admin}/admin/events`, { headers: { Authorization: `Bearer ${ownerToken}` } })
  const framesPromise = readFrames(res, 2) // [0] replay, [1] the published event
  // Give the connection a moment to subscribe before publishing.
  await new Promise(r => setTimeout(r, 100))
  publish('server:tpm', 123)
  const frames = await framesPromise
  const event = frames.find(f => f.type === 'event')
  assert(event, `no live event arrived: ${JSON.stringify(frames)}`)
  assert(event.channel === 'server:tpm' && event.payload === 123, `wrong event: ${JSON.stringify(event)}`)
})

await stopAdminListener()

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
