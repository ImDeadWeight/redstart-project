// =============================================================================
// Background tasks survive, against the REAL daemon (agent-runtime Phase 3)
// =============================================================================
// Phase 3's acceptance: "a task survives a client disconnect, a model stop and
// start, and a daemon restart, each as a test against the real daemon."
// test-task-runtime.mjs proves the runner's logic with its seams replaced, and
// 3.7 killed a child process hosting the runner; neither is nestd. This runs
// `node bin/nestd.mjs` on a temp directory, launches a model through the
// admin API like the launcher does, and drives a task through the gateway
// like chat-ui does.
//
// The model is fake (scripts/lib/fake-llama-server.mjs), launched by the
// daemon itself through settings.serverBinPath and a binary shim
// (scripts/lib/fake-server-binary.mjs), so the daemon's own launch, gateway,
// MCP server, task runner and stop paths are the real ones. A prompt with
// "[hold]" makes the model's turn hang until the test releases it: a long
// generation in flight when the disconnect, stop or kill happens.
//
// What each case pins:
//   1. Client disconnect: the event stream is dropped mid-turn; the task does
//      not notice and finishes.
//   2. Model stop and start: the in-flight turn is cut; the task waits for a
//      model (waiting_model, seen on the control plane, since the gateway goes
//      down with the model), and when one is launched the turn runs again and
//      the task finishes with ONE reply, not a torn one plus a whole one.
//   3. Daemon restart: nestd is killed outright mid-turn. The next nestd on the
//      same directory resumes the task, which waits for a model (a boot never
//      starts one, §7.0), then finishes once a model is launched.
//
// SELF-SKIPS like test-daemon-smoke.mjs when the daemon's fixed ports are
// taken (Redstart running), and when no shim can be built (Windows without
// .NET Framework's csc.exe).
//
// Run:  node scripts/test-task-survival.mjs
// =============================================================================

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADMIN_PORT, BEACON_PORT } from '../daemon/ports.mjs'
import { makeFakeServerBinary } from './lib/fake-server-binary.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const nestd = path.join(here, '..', 'bin', 'nestd.mjs')
const admin = `http://127.0.0.1:${ADMIN_PORT}`
const PASSWORD = 'survival-test-pw-1234'

const results = []
async function test(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false })
    console.log(`FAIL  - ${name}\n        ${err.stack ?? err.message}`)
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port })
    s.setTimeout(500)
    s.on('connect', () => { s.destroy(); resolve(true) })
    s.on('timeout', () => { s.destroy(); resolve(false) })
    s.on('error', () => resolve(false))
  })
}

async function waitFor(what, fn, ms = 30_000) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    try {
      last = await fn()
      if (last) return last
    } catch (err) {
      last = err.message
    }
    await sleep(150)
  }
  throw new Error(`timed out waiting for ${what} (last: ${typeof last === 'string' ? last : JSON.stringify(last)})`)
}

console.log('\n-- background tasks survive, against the real daemon (Phase 3) --')

for (const port of [ADMIN_PORT, BEACON_PORT]) {
  if (await portInUse(port)) {
    console.log(`  SKIP - port ${port} is already in use; is Redstart running?`)
    console.log('\n0/0 passed (skipped)')
    process.exit(0)
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-task-survival-'))
const nestDir = path.join(root, 'nest')
const control = path.join(root, 'control')
fs.mkdirSync(path.join(nestDir, 'config'), { recursive: true })
fs.mkdirSync(control, { recursive: true })
const bin = makeFakeServerBinary(path.join(root, 'bin'), path.join(here, 'lib', 'fake-llama-server.mjs'))
if (!bin.path) {
  console.log(`  SKIP - ${bin.reason}`)
  console.log('\n0/0 passed (skipped)')
  process.exit(0)
}
fs.writeFileSync(path.join(nestDir, 'config', 'settings.json'), JSON.stringify({ serverBinPath: bin.path }))
const modelPath = path.join(root, 'fake-model.gguf')
fs.writeFileSync(modelPath, 'not a real model')

/** A free port triple (gateway, llama-server on +1, MCP on +2) away from the fixed ones. */
async function freeModelPort() {
  for (let p = 18600; p < 19000; p += 3) {
    if (!(await portInUse(p)) && !(await portInUse(p + 1)) && !(await portInUse(p + 2))) return p
  }
  throw new Error('no free port triple')
}
const MODEL_PORT = await freeModelPort()
const gw = `http://127.0.0.1:${MODEL_PORT}`

function startNestd() {
  const child = spawn(process.execPath, [nestd, '--dir', nestDir], {
    env: { ...process.env, FAKE_LLAMA_CONTROL: control },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const out = []
  child.stdout.on('data', (b) => out.push(b.toString()))
  child.stderr.on('data', (b) => out.push(b.toString()))
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })))
  return { child, exited, text: () => out.join('') }
}

async function json(res) {
  const text = await res.text()
  try { return { status: res.status, body: JSON.parse(text), text } } catch { return { status: res.status, body: null, text } }
}
const adminPost = (p, body, token) => fetch(admin + p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
})
async function call(channel, args, token) {
  const r = await json(await adminPost('/admin/api/' + channel.replace(':', '/'), { args }, token))
  if (r.status !== 200) throw new Error(`${channel}: ${r.status} ${r.text.slice(0, 200)}`)
  return r.body?.result
}

let daemon = null
let adminToken = null
let gwToken = null

async function bootAndLogin({ firstRun }) {
  daemon = startNestd()
  await waitFor('the control plane', async () => {
    if (daemon.child.exitCode !== null) throw new Error(`nestd exited:\n${daemon.text()}`)
    return portInUse(ADMIN_PORT)
  })
  if (firstRun) {
    const token = fs.readFileSync(path.join(nestDir, 'config', 'bootstrap-token.txt'), 'utf8').trim()
    const r = await json(await adminPost('/admin/bootstrap', { token, username: 'owner', password: PASSWORD }))
    assert(r.status === 200, `bootstrap: ${r.status} ${r.text}`)
  }
  const login = await json(await adminPost('/admin/auth/login', { username: 'owner', password: PASSWORD }))
  assert(login.status === 200, `login: ${login.status} ${login.text}`)
  adminToken = login.body.token
}

async function launchModel() {
  const r = await call('llama:launch', [{ modelPath, ctxSize: 4096, batchSize: 512, threads: 2, port: MODEL_PORT }], adminToken)
  assert(r?.success, `launch: ${JSON.stringify(r)}`)
  await waitFor('the gateway and the model', async () => {
    const h = await fetch(`http://127.0.0.1:${MODEL_PORT + 1}/health`).then((x) => x.ok, () => false)
    return h && portInUse(MODEL_PORT)
  })
  const login = await json(await fetch(gw + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: PASSWORD }),
  }))
  assert(login.status === 200, `gateway login: ${login.status} ${login.text}`)
  gwToken = login.body.token
}

async function stopModel() {
  await call('server:stop', [], adminToken)
  await waitFor('the model to stop', async () => !(await portInUse(MODEL_PORT + 1)))
}

const gwFetch = (p, init = {}) => fetch(gw + p, {
  ...init,
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gwToken}`, ...(init.headers ?? {}) },
})
async function gwJson(p, init) {
  const r = await json(await gwFetch(p, init))
  if (r.status >= 300) throw new Error(`${init?.method ?? 'GET'} ${p}: ${r.status} ${r.text.slice(0, 200)}`)
  return r.body
}

let convCounter = 0
async function startHeldTask() {
  const id = `survival-${++convCounter}-${Date.now()}`
  await gwJson('/conversations', { method: 'POST', body: JSON.stringify({ id, name: id }) })
  const task = await gwJson('/tasks', { method: 'POST', body: JSON.stringify({ conversationId: id, content: 'Write the report. [hold]' }) })
  return { conversationId: id, taskId: task.id }
}

const holds = () => {
  try { return fs.readFileSync(path.join(control, 'requests.log'), 'utf8').split('\n').filter((l) => / hold /.test(l)).length } catch { return 0 }
}
const release = () => fs.writeFileSync(path.join(control, 'release'), '')
const unrelease = () => fs.rmSync(path.join(control, 'release'), { force: true })

/** The task as the control plane sees it (works with no model and no gateway). */
async function adminTask(id) {
  const r = await call('tasks:list', [], adminToken)
  return r.tasks.find((t) => t.id === id) ?? null
}

/** The stored conversation's assistant replies on its current branch. */
async function replies(conversationId) {
  const conv = await gwJson(`/conversations/${encodeURIComponent(conversationId)}`)
  const byId = new Map((conv.messages ?? []).map((m) => [m.id, m]))
  const branch = []
  for (let m = byId.get(conv.currNode); m; m = m.parent ? byId.get(m.parent) : null) branch.unshift(m)
  return { conv, users: branch.filter((m) => m.role === 'user').map((m) => m.content), assistants: branch.filter((m) => m.role === 'assistant').map((m) => m.content) }
}

try {
  await bootAndLogin({ firstRun: true })
  await launchModel()

  await test('client disconnect: the event stream is dropped mid-turn, and the task finishes anyway', async () => {
    unrelease()
    const before = holds()
    const { conversationId, taskId } = await startHeldTask()
    await waitFor('the model to be generating', () => holds() > before)

    // A client following the task, then gone (a closed tab, a dropped Wi-Fi).
    const ac = new AbortController()
    const res = await gwFetch(`/tasks/${taskId}/events`, { signal: ac.signal, headers: { Accept: 'text/event-stream' } })
    assert(res.ok, `events: ${res.status}`)
    const reader = res.body.getReader()
    await reader.read()
    ac.abort()

    await sleep(500)
    release()
    const done = await waitFor('the task to finish', async () => {
      const t = await gwJson(`/tasks/${taskId}`)
      return ['done', 'failed', 'cancelled'].includes(t.status) ? t : null
    })
    assert(done.status === 'done', `status ${done.status} ${done.error ?? ''}`)
    const r = await replies(conversationId)
    assert(r.assistants.length === 1 && r.assistants[0] === 'Released.', `replies: ${JSON.stringify(r.assistants)}`)
    assert(!r.conv.activeTaskId, 'the chat is still held by the task')
    return 'done, one reply'
  })

  await test('model stop and start: the cut turn waits for a model, then runs again; one reply, not two', async () => {
    unrelease()
    const before = holds()
    const { conversationId, taskId } = await startHeldTask()
    await waitFor('the model to be generating', () => holds() > before)

    await stopModel()
    const waiting = await waitFor('waiting_model', async () => {
      const t = await adminTask(taskId)
      return t?.status === 'waiting_model' ? t : null
    })
    assert(waiting.waitingFor === 'model', `waitingFor ${waiting.waitingFor}`)

    const beforeRelaunch = holds()
    await launchModel()
    await waitFor('the turn to run again on the new model', () => holds() > beforeRelaunch)
    release()
    const done = await waitFor('the task to finish', async () => {
      const t = await gwJson(`/tasks/${taskId}`)
      return ['done', 'failed', 'cancelled'].includes(t.status) ? t : null
    })
    assert(done.status === 'done', `status ${done.status} ${done.error ?? ''}`)
    const r = await replies(conversationId)
    assert(r.users.length === 1, `user messages: ${JSON.stringify(r.users)}`)
    assert(r.assistants.length === 1 && r.assistants[0] === 'Released.', `replies: ${JSON.stringify(r.assistants)}`)
    return 'waiting_model, then done'
  })

  await test('daemon restart: nestd is killed mid-turn; the next one resumes the task, which finishes once a model is back', async () => {
    unrelease()
    const before = holds()
    const { conversationId, taskId } = await startHeldTask()
    await waitFor('the model to be generating', () => holds() > before)

    // Outright: no shutdown handler, no suspendAllTasks. What a crash or a
    // power cut leaves behind, the hardest case 3.7 covers.
    daemon.child.kill('SIGKILL')
    await daemon.exited
    await waitFor('the control plane to close', async () => !(await portInUse(ADMIN_PORT)))

    await bootAndLogin({ firstRun: false })
    // A boot never starts a model (§7.0): the resumed task waits for one. The
    // old model process was reaped by pid at boot (process-supervision.mjs),
    // or the relaunch below would find its port taken.
    const waiting = await waitFor('the resumed task to wait for a model', async () => {
      const t = await adminTask(taskId)
      return t?.status === 'waiting_model' ? t : null
    })
    assert(waiting, 'not resumed')

    release()
    await launchModel()
    const done = await waitFor('the task to finish', async () => {
      const t = await gwJson(`/tasks/${taskId}`)
      return ['done', 'failed', 'cancelled'].includes(t.status) ? t : null
    })
    assert(done.status === 'done', `status ${done.status} ${done.error ?? ''}`)
    const r = await replies(conversationId)
    assert(r.users.length === 1, `user messages: ${JSON.stringify(r.users)}`)
    assert(r.assistants.length === 1 && r.assistants[0] === 'Released.', `replies: ${JSON.stringify(r.assistants)}`)
    assert(!r.conv.activeTaskId, 'the chat is still held by the task')
    return 'resumed, waited for a model, done'
  })
} catch (err) {
  results.push({ name: 'setup', pass: false })
  console.log(`FAIL  - setup\n        ${err.stack ?? err.message}\n--- nestd output ---\n${daemon?.text() ?? ''}`)
} finally {
  try { await call('server:stop', [], adminToken) } catch { /* not running */ }
  try { await call('admin:shutdown', [], adminToken) } catch { /* already gone */ }
  if (daemon && daemon.child.exitCode === null) {
    await Promise.race([daemon.exited, sleep(5000)])
    if (daemon.child.exitCode === null) daemon.child.kill('SIGKILL')
  }
  await sleep(500)
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* a process may still hold a file */ }
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
