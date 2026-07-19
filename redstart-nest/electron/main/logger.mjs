'use strict'

// =============================================================================
// Redstart Nest — structured, privacy-aware logging
// =============================================================================
// Emits one JSON object per line (JSONL) to a rotating file in userData, plus
// a concise console line, for the operationally interesting events: auth,
// tool execution, server lifecycle, discovery, MCP registration.
//
// PRIVACY CONTRACT (this is the whole point of a first-party logger for a
// privacy-first tool): log the *shape* of what happened, never the content.
// Callers pass only safe scalar fields (tool name, class, decision, duration,
// port, username, role). As defense in depth the logger additionally drops any
// field whose key names sensitive data — tool args/results, message/conversation
// content, SQL, file paths/contents, URLs, secrets — and drops nested objects
// entirely, so a careless caller can never leak PII, credentials, or user data
// into a log line.
//
// No Electron dependency: index.mjs calls initLogger(app.getPath('userData'))
// once at startup. Until then (e.g. under the test harness) logging is a no-op
// beyond nothing — so importing this module never pulls in Electron and never
// pollutes test output.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'

const MAX_BYTES = 5 * 1024 * 1024  // rotate at 5 MB, keep one previous generation

// Keys that must never be written, even if a caller passes them by mistake.
const BLOCKED_KEYS = new Set([
  'args', 'arguments', 'input', 'result', 'results', 'output', 'content', 'text',
  'message', 'messages', 'prompt', 'completion', 'sql', 'query', 'body', 'data',
  'path', 'rootdir', 'dir', 'filename', 'file', 'url', 'baseurl',
  'password', 'token', 'apikey', 'secret', 'connectionstring', 'ciphertext',
])

let stream = null
let logPath = null

export function initLogger(userDataDir) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true })
    logPath = path.join(userDataDir, 'redstart.log')
    try {
      if (fs.statSync(logPath).size > MAX_BYTES) fs.renameSync(logPath, `${logPath}.1`)
    } catch { /* no existing file — fine */ }
    stream = fs.createWriteStream(logPath, { flags: 'a' })
    logEvent('app', 'logger_started', {})
  } catch (err) {
    stream = null
    console.warn(`[logger] file logging disabled: ${err.message}`)
  }
}

export function closeLogger() {
  try { stream?.end() } catch { /* ignore */ }
  stream = null
}

// Keep only safe scalars; drop blocked keys and any non-primitive value.
function redact(fields) {
  const out = {}
  for (const [key, value] of Object.entries(fields || {})) {
    if (BLOCKED_KEYS.has(key.toLowerCase())) continue
    if (value === null || value === undefined) continue
    const t = typeof value
    if (t === 'string' || t === 'number' || t === 'boolean') out[key] = value
    // objects/arrays intentionally dropped to prevent nested leakage
  }
  return out
}

export function logEvent(category, event, fields = {}) {
  const safe = redact(fields)
  // No-op for console when uninitialized (test harness): keeps suites clean.
  if (!stream) return
  const record = { t: new Date().toISOString(), cat: category, event, ...safe }
  try { stream.write(JSON.stringify(record) + '\n') } catch { /* ignore write errors */ }
  const extra = Object.keys(safe).length ? ' ' + JSON.stringify(safe) : ''
  console.log(`[${category}] ${event}${extra}`)
}
