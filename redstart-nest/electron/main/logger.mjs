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
// ONE documented exception exists: logAudit() at the bottom of this file records
// the path of a destructive (delete) operation, because a deletion nobody can
// name is a deletion nobody can undo. It is a closed allowlist of fields, it
// never records file contents, and nothing else in the codebase may use it.
//
// No Electron dependency: index.mjs calls initLogger(configDir()) once at
// startup — this module was the original model for platform-paths.mjs's
// take-a-plain-directory-argument shape. Until then (e.g. under the test
// harness) logging is a no-op beyond nothing — so importing this module
// never pulls in Electron and never pollutes test output.
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

// ---------------------------------------------------------------------------
// THE ONE EXCEPTION TO THE PRIVACY CONTRACT ABOVE.
//
// Destructive-class tool calls — currently only the File System capability's
// delete — record WHAT was deleted. Nothing else in Redstart logs a path, and
// this does not open the door to anything else doing so: the field list below
// is a closed allowlist, values are truncated, and file CONTENTS are never
// logged by anything, ever.
//
// Why this is worth an exception rather than a principle quietly bent. A model
// deciding what to delete is a different situation from a model reading or
// writing: the user finds out what happened after it has happened, and "which
// file did it remove?" is the first question they will ask. Deletions are
// recoverable (they go to the recycle bin), but recovery needs a name to
// recover. A log that records only "a destructive call succeeded in 12ms" is
// useless at precisely the moment logging exists to be useful.
//
// The path recorded is the one RELATIVE to the caller's own storage, so the log
// carries no server layout and no other account's namespace.
// ---------------------------------------------------------------------------
const AUDIT_FIELDS = ['tool', 'path', 'scope', 'kind', 'recoverable']
const MAX_AUDIT_VALUE = 512

export function logAudit(event, fields = {}) {
  const safe = {}
  for (const key of AUDIT_FIELDS) {
    const value = fields[key]
    if (value === null || value === undefined) continue
    const t = typeof value
    if (t !== 'string' && t !== 'number' && t !== 'boolean') continue
    safe[key] = t === 'string' ? value.slice(0, MAX_AUDIT_VALUE) : value
  }
  if (!stream) return
  const record = { t: new Date().toISOString(), cat: 'audit', event, ...safe }
  try { stream.write(JSON.stringify(record) + '\n') } catch { /* ignore write errors */ }
  console.log(`[audit] ${event} ${JSON.stringify(safe)}`)
}
