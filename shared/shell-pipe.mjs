'use strict'

// =============================================================================
// Redstart Nest — the shell pipe (one channel between the desktop shell and nestd)
// =============================================================================
// The daemon split (docs/notes/daemon-split-tauri-plan.md D3). The desktop
// shell (Electron in T1, Tauri in T2) spawns `nestd --shell-pipe` and talks to
// it over the child's stdin/stdout, one JSON object per line.
//
// Why a pipe and not HTTP: no port, no token, nothing another local process
// can reach, and when either side dies the other sees EOF, which is how the
// daemon knows to stop (D2: the shell owns the daemon's lifetime).
//
// FRAMING. Every protocol line is a JSON object carrying "rs": 1. Anything
// else on the stream is NOISE, handed to onNoise and otherwise ignored, never
// a parse failure that tears the channel down. nestd routes its console
// output to stderr in this mode (bin/stdout-guard.mjs), so noise should not
// happen. If a dependency writes to stdout anyway, it costs a log line and
// nothing else.
//
// SHAPES:
//   { rs:1, type:'request',  id, method, params }    either direction
//   { rs:1, type:'response', id, ok, value | error } answers a request
//   { rs:1, type:<anything else>, ... }              a one-way message
//
// This module is transport only. What each message means lives with the two
// ends: bin/nestd.mjs (daemon side) and the shell. The Tauri shell
// reimplements this framing in Rust, so keep it boring.
// =============================================================================

export const PROTOCOL_VERSION = 1

// A request the other side never answers must not hang a caller forever. Long
// enough for a recycle-bin move of a large folder, short enough to notice.
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * @param {object} io
 * @param {NodeJS.ReadableStream} io.input
 * @param {(line: string) => void} io.write   writes one line (no newline added by caller)
 * @param {(line: string) => void} [io.onNoise]
 */
export function createPeer({ input, write, onNoise = () => {} }) {
  let nextId = 1
  let closed = false
  const pending = new Map()
  const typeHandlers = new Map()
  const requestHandlers = new Map()
  const closeHandlers = []

  function send(message) {
    if (closed) return false
    try {
      write(JSON.stringify({ rs: PROTOCOL_VERSION, ...message }) + '\n')
      return true
    } catch {
      return false
    }
  }

  function settle(id, fn) {
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    clearTimeout(p.timer)
    fn(p)
  }

  async function handleRequest(msg) {
    const handler = requestHandlers.get(msg.method)
    if (!handler) {
      send({ type: 'response', id: msg.id, ok: false, error: `Unknown method: ${msg.method}` })
      return
    }
    try {
      const value = await handler(msg.params ?? {})
      send({ type: 'response', id: msg.id, ok: true, value: value ?? null })
    } catch (err) {
      send({ type: 'response', id: msg.id, ok: false, error: String(err?.message ?? err) })
    }
  }

  function handleLine(line) {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg
    try { msg = JSON.parse(trimmed) } catch { onNoise(trimmed); return }
    if (!msg || typeof msg !== 'object' || msg.rs !== PROTOCOL_VERSION || typeof msg.type !== 'string') {
      onNoise(trimmed)
      return
    }
    if (msg.type === 'response') {
      settle(msg.id, (p) => (msg.ok ? p.resolve(msg.value) : p.reject(new Error(msg.error || 'request failed'))))
      return
    }
    if (msg.type === 'request') {
      handleRequest(msg)
      return
    }
    for (const fn of typeHandlers.get(msg.type) || []) {
      try { fn(msg) } catch (err) { onNoise(`handler for ${msg.type} threw: ${err.message}`) }
    }
  }

  let buffer = ''
  input.setEncoding?.('utf8')
  input.on('data', (chunk) => {
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      handleLine(line)
    }
  })
  const onEnd = () => {
    if (closed) return
    closed = true
    if (buffer.trim()) handleLine(buffer)
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('shell pipe closed')) }
    pending.clear()
    for (const fn of closeHandlers) { try { fn() } catch {} }
  }
  input.on('end', onEnd)
  input.on('close', onEnd)
  input.on('error', onEnd)

  return {
    send,
    /** Send a request; resolves with the other side's value, rejects with its error. */
    request(method, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
      if (closed) return Promise.reject(new Error('shell pipe closed'))
      const id = nextId++
      return new Promise((resolve, reject) => {
        // NOT unref'd: a pending request is work in flight, and an unref'd
        // timer lets an otherwise idle process exit with the caller's promise
        // never settled. The timer is bounded, so it can't hold a process forever.
        const timer = setTimeout(() => settle(id, (p) => p.reject(new Error(`${method}: no answer within ${timeoutMs} ms`))), timeoutMs)
        pending.set(id, { resolve, reject, timer })
        if (!send({ type: 'request', id, method, params })) settle(id, (p) => p.reject(new Error('shell pipe closed')))
      })
    },
    /** Handle a one-way message type. */
    on(type, fn) {
      if (!typeHandlers.has(type)) typeHandlers.set(type, [])
      typeHandlers.get(type).push(fn)
    },
    /** Answer requests for `method`. The handler may be async; its throw becomes the error. */
    handle(method, fn) { requestHandlers.set(method, fn) },
    /** EOF, error or close on the input: the other side is gone. */
    onClose(fn) { closeHandlers.push(fn) },
    /** Resolves with the first message of `type`, or rejects after timeoutMs or on close. */
    waitFor(type, timeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${type} within ${timeoutMs} ms`)), timeoutMs)
        this.on(type, (msg) => { clearTimeout(timer); resolve(msg) })
        this.onClose(() => { clearTimeout(timer); reject(new Error(`shell pipe closed before ${type}`)) })
      })
    },
    get closed() { return closed },
  }
}
