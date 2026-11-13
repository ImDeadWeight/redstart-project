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
// TWO documented exceptions exist, each a closed allowlist of fields, and
// nothing else in the codebase may add one:
//   - logAudit() records the path of a destructive (delete) operation, because
//     a deletion nobody can name is a deletion nobody can undo. It never
//     records file contents.
//   - logPolicy() records what policy DECIDED (an approval denied or refused, a
//     standing grant added or revoked) and who, into its own file an owner can
//     read back (GET over the control plane, ipc/approvals.mjs). It never
//     records arguments, paths or summaries: the decision, the tool, the
//     account, the grant id. resource-grants-plan.md §7 designed it; agent-
//     runtime Phase 2 built it first.
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
let policyPath = null

export function initLogger(userDataDir) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true })
    policyPath = path.join(userDataDir, 'policy.jsonl')
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

// Resolves once the last close has flushed to disk. A caller that exits the
// process right after stopping (nestd --shell-pipe) waits on this, or the
// final lines, including the shutdown record itself, never reach the file.
let closed = Promise.resolve()

export function closeLogger() {
  const s = stream
  stream = null
  if (!s) return
  closed = new Promise((resolve) => {
    try { s.end(resolve) } catch { resolve() }
  })
}

export function whenLoggerClosed() {
  return closed
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

// ---------------------------------------------------------------------------
// THE SECOND EXCEPTION: the decision log (agent-runtime plan D14, designed in
// resource-grants-plan.md §7).
//
// What policy decided, for an owner to read back: an approval denied, an
// enforced call refused for want of one, a standing grant added or revoked.
// "Denials only" for access decisions: logging every permitted call would
// make this the tool log, which exists and is noisy already; the line worth
// keeping is the one where policy did something.
//
// Its own file, policy.jsonl, beside redstart.log rather than in it, so the
// trail is not rotated away by app chatter and an owner's read returns only
// policy lines. Written synchronously: a few lines a day, and a read right
// after a decision must see it.
//
// Closed allowlist, scalars only, cut to 128 characters. NEVER the call's
// arguments, a path, a summary or a query: the decision, the tool, whose it
// was, the grant, and who acted (an admin revoking someone else's grant).
// ---------------------------------------------------------------------------
const POLICY_FIELDS = ['account', 'tool', 'decision', 'grantId', 'capability', 'role', 'by', 'source']
export const POLICY_EVENTS = new Set(['approval.denied', 'approval.refused', 'grant.added', 'grant.revoked'])
const MAX_POLICY_VALUE = 128
const MAX_POLICY_BYTES = 2 * 1024 * 1024

export function logPolicy(event, fields = {}) {
  if (!POLICY_EVENTS.has(event)) throw new Error(`logPolicy: unknown event ${event}`)
  const safe = {}
  for (const key of POLICY_FIELDS) {
    const value = fields[key]
    if (value === null || value === undefined) continue
    const t = typeof value
    if (t !== 'string' && t !== 'number' && t !== 'boolean') continue
    safe[key] = t === 'string' ? value.slice(0, MAX_POLICY_VALUE) : value
  }
  console.log(`[policy] ${event} ${JSON.stringify(safe)}`)
  if (!policyPath) return
  const record = { t: new Date().toISOString(), event, ...safe }
  try {
    try {
      if (fs.statSync(policyPath).size > MAX_POLICY_BYTES) fs.renameSync(policyPath, `${policyPath}.1`)
    } catch { /* no file yet */ }
    fs.appendFileSync(policyPath, JSON.stringify(record) + '\n')
  } catch { /* a failed write must not fail the decision it records */ }
}

/**
 * The decision log, newest first: the current file, then the one rotated
 * before it. `before` pages: pass the `t` of the last record you got.
 *
 * @param {{ limit?: number, before?: string }} [opts]
 * @returns {{ records: Array<Record<string, unknown>>, more: boolean }}
 */
export function readPolicyLog({ limit = 100, before } = {}) {
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500)
  if (!policyPath) return { records: [], more: false }
  const lines = []
  for (const p of [`${policyPath}.1`, policyPath]) {
    try { lines.push(...fs.readFileSync(p, 'utf8').split('\n')) } catch { /* absent */ }
  }
  const records = []
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue
    let r
    try { r = JSON.parse(lines[i]) } catch { continue }
    if (typeof r?.t !== 'string' || !POLICY_EVENTS.has(r.event)) continue
    if (typeof before === 'string' && !(r.t < before)) continue
    records.push(r)
    if (records.length > n) break
  }
  return { records: records.slice(0, n), more: records.length > n }
}
