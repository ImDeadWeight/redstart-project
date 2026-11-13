#!/usr/bin/env node
// =============================================================================
// A stand-in llama-server, for tests that run the real daemon
// =============================================================================
// Spawned BY nestd, through the binary shim in fake-server-binary.mjs, exactly
// where the daemon would spawn llama-server: same argv, same cwd rules. It
// answers what the daemon, the gateway and the task runner ask of a model:
//
//   GET  /health, /props, /v1/models, /slots
//   POST /tokenize                    one token per 4 characters
//   POST /v1/chat/completions         streamed (or not, for a non-stream
//                                     request such as a title or a summary)
//
// The model's behaviour is one rule, steered from the test by files in
// FAKE_LLAMA_CONTROL (an env var the daemon passes through untouched):
//
//   A request whose last user message contains "[hold]" streams nothing until
//   the file `release` exists in the control dir, then answers "Released."
//   Everything else answers "Done." at once. Each completion appends a line to
//   `requests.log` there, so a test can wait for "the model is generating".
//
// Lives as long as its parent: the daemon stops a model by killing the
// process it spawned, which on Windows is the .exe shim, not this. So it also
// exits when that parent is gone.
//
// Usage (as the daemon calls it): fake-llama-server.mjs -m <model> --port N --host H ...
// =============================================================================

import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const port = Number(arg('--port'))
const host = arg('--host') ?? '127.0.0.1'
const ctx = Number(arg('-c') ?? 4096)
const control = process.env.FAKE_LLAMA_CONTROL || null

if (!Number.isInteger(port)) {
  console.error('fake-llama-server: --port is required')
  process.exit(2)
}

function note(line) {
  if (control) fs.appendFileSync(path.join(control, 'requests.log'), line + '\n')
}

function released() {
  return control ? fs.existsSync(path.join(control, 'release')) : true
}

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function body(req) {
  const parts = []
  for await (const c of req) parts.push(c)
  try { return JSON.parse(Buffer.concat(parts).toString() || '{}') } catch { return {} }
}

const lastUserText = (messages) => {
  const m = [...(messages ?? [])].reverse().find((x) => x.role === 'user')
  if (!m) return ''
  return typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { status: 'ok' })
  if (req.method === 'GET' && url.pathname === '/props') {
    return json(res, 200, { model_path: 'fake-model.gguf', chat_template: '', default_generation_settings: { n_ctx: ctx }, total_slots: 1 })
  }
  if (req.method === 'GET' && url.pathname === '/v1/models') return json(res, 200, { object: 'list', data: [{ id: 'fake-model', object: 'model' }] })
  if (req.method === 'GET' && url.pathname === '/slots') return json(res, 200, [{ id: 0, is_processing: false }])
  if (req.method === 'POST' && url.pathname === '/tokenize') {
    const b = await body(req)
    const n = Math.ceil(String(b.content ?? '').length / 4)
    return json(res, 200, { tokens: Array.from({ length: n }, (_, i) => i) })
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const b = await body(req)
    const hold = /\[hold\]/.test(lastUserText(b.messages))
    note(`${Date.now()} ${hold ? 'hold' : 'answer'} stream=${b.stream !== false}`)
    let text = 'Done.'
    if (hold) {
      // A long generation in flight: nothing on the wire until released. If
      // the caller goes away (a model stop, a daemon kill), stop waiting.
      let gone = false
      req.on('close', () => { gone = true })
      res.on('close', () => { gone = true })
      while (!released() && !gone) await new Promise((r) => setTimeout(r, 100))
      if (gone) return
      text = 'Released.'
    }
    if (b.stream === false) {
      return json(res, 200, { choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }], model: 'fake-model' })
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }], model: 'fake-model' })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], timings: { prompt_n: 10, predicted_n: 2 } })}\n\n`)
    res.write('data: [DONE]\n\n')
    return res.end()
  }
  json(res, 404, { error: { message: `fake llama-server: no route ${req.method} ${url.pathname}` } })
})

server.listen(port, host, () => {
  // What llama-server prints when it is ready; the daemon logs it.
  console.log(`main: server is listening on http://${host}:${port} - starting the main loop`)
})

// The parent is the daemon (POSIX shim execs into this) or the .exe shim
// (Windows). Either way, once it is gone nobody will stop this process.
const parent = process.ppid
setInterval(() => {
  try { process.kill(parent, 0) } catch { process.exit(0) }
}, 500).unref()
