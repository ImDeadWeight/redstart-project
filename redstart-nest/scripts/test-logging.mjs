// =============================================================================
// Structured logging — the privacy contract must hold on disk, not just in
// the source comment.
// =============================================================================
// electron/main/logger.mjs promises two things:
//   - logEvent() drops a finite blocklist of sensitive-sounding keys, AND
//     (defense in depth) drops any object/array value under a key that
//     ISN'T blocked, so a future field name nobody thought to blocklist
//     still can't carry nested content into the log.
//   - logAudit() is a closed ALLOWLIST — only AUDIT_FIELDS survive — which
//     is a different, stronger guarantee than a blocklist and must not
//     quietly regress to one.
//
// Same philosophy as test-json-store.mjs: don't mock redact() and assert on
// its return value, read the actual redstart.log JSONL line back off disk.
//
// Run:  node scripts/test-logging.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { initLogger, closeLogger, logEvent, logAudit } from '../electron/main/logger.mjs'
import { describeCrash } from '../electron/main/crash-handler.mjs'

const results = []

// logger.mjs writes through fs.createWriteStream, which opens its fd
// asynchronously — a logEvent()/logAudit() call returns before the line is
// necessarily on disk. Every test below is async and polls for its write to
// land rather than assuming synchronous fs.WriteStream completion.
async function test(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true, detail })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false, detail: err.message })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

// Mirrors the BLOCKED_KEYS set in electron/main/logger.mjs — kept as a literal
// copy (not imported) so this suite notices if the source list ever drifts
// without a matching update here.
const BLOCKED_KEYS = [
  'args', 'arguments', 'input', 'result', 'results', 'output', 'content', 'text',
  'message', 'messages', 'prompt', 'completion', 'sql', 'query', 'body', 'data',
  'path', 'rootdir', 'dir', 'filename', 'file', 'url', 'baseurl',
  'password', 'token', 'apikey', 'secret', 'connectionstring', 'ciphertext',
]

const AUDIT_FIELDS = ['tool', 'path', 'scope', 'kind', 'recoverable']

// ---------------------------------------------------------------------------
// Group 5 (uninitialized) runs FIRST, before initLogger() is ever called —
// order matters here, this is the only point in the suite where that's true.
// ---------------------------------------------------------------------------
console.log('\n-- uninitialized / no-stream behavior --')

const preInitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-logging-preinit-'))
const preInitLogPath = path.join(preInitDir, 'redstart.log')

await test('logEvent before initLogger() does not throw and creates no file', () => {
  logEvent('test', 'probe', { safe: 'value' })
  assert(!fs.existsSync(preInitLogPath), 'a log file appeared before initLogger() was ever called')
  return 'no throw, no file'
})

await test('logAudit before initLogger() does not throw', () => {
  logAudit('deleted', { tool: 'x', path: 'a/b.txt' })
  assert(!fs.existsSync(preInitLogPath), 'a log file appeared before initLogger() was ever called')
  return 'no throw, no file'
})

fs.rmSync(preInitDir, { recursive: true, force: true })

// ---------------------------------------------------------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-logging-'))
initLogger(tmpDir)
const logPath = path.join(tmpDir, 'redstart.log')

function currentLines() {
  if (!fs.existsSync(logPath)) return []
  return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)
}

// Poll rather than assume synchronous fs.WriteStream completion — see the
// comment on test() above.
async function waitForNewLine(prevCount, timeoutMs = 2000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const lines = currentLines()
    if (lines.length > prevCount) return lines[lines.length - 1]
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for a new log line (still at ${currentLines().length})`)
}

// initLogger() itself writes a 'logger_started' line, so the baseline count
// isn't 0 for the very first real test — always compare against currentLines().

console.log('\n-- logEvent blocklist --')

await test('each blocked key is dropped, and its value never appears on the line', async () => {
  const failures = []
  for (const key of BLOCKED_KEYS) {
    const before = currentLines().length
    logEvent('test', 'probe', { [key]: 'sensitive-value' })
    const line = await waitForNewLine(before)
    const record = JSON.parse(line)
    if (key in record) failures.push(`${key}: key present in record`)
    if (line.includes('sensitive-value')) failures.push(`${key}: literal value leaked onto the line`)
  }
  assert(failures.length === 0, failures.join('; '))
  return `${BLOCKED_KEYS.length} keys checked`
})

await test('blocklist matching is case-insensitive', async () => {
  const failures = []
  for (const key of ['APIKEY', 'Password', 'ToKeN']) {
    const before = currentLines().length
    logEvent('test', 'probe', { [key]: 'sensitive-value' })
    const line = await waitForNewLine(before)
    if (JSON.parse(line)[key] !== undefined) failures.push(`${key}: not redacted`)
    if (line.includes('sensitive-value')) failures.push(`${key}: value leaked`)
  }
  assert(failures.length === 0, failures.join('; '))
  return 'APIKEY, Password, ToKeN'
})

console.log('\n-- scalars-only (defense in depth) --')

await test('an object under a non-blocked key is dropped whole, not flattened', async () => {
  const before = currentLines().length
  logEvent('test', 'probe', { safeKey: { nested: 'leaked-secret' } })
  const line = await waitForNewLine(before)
  assert(!line.includes('leaked-secret'), 'nested object value leaked onto the line')
  return 'nested object dropped'
})

await test('an array under a non-blocked key is dropped whole', async () => {
  const before = currentLines().length
  logEvent('test', 'probe', { safeKey: ['leaked-item'] })
  const line = await waitForNewLine(before)
  assert(!line.includes('leaked-item'), 'array value leaked onto the line')
  return 'array dropped'
})

await test('string, number, and boolean scalars survive intact when unblocked', async () => {
  const before = currentLines().length
  logEvent('test', 'probe', { str: 'hello', num: 42, bool: true })
  const record = JSON.parse(await waitForNewLine(before))
  assert(record.str === 'hello', 'string scalar changed or dropped')
  assert(record.num === 42, 'number scalar changed or dropped')
  assert(record.bool === true, 'boolean scalar changed or dropped')
  return 'string/number/boolean preserved'
})

await test('null and undefined values are dropped, not written as null', async () => {
  const before = currentLines().length
  logEvent('test', 'probe', { present: 'yes', nullish: null, missing: undefined })
  const record = JSON.parse(await waitForNewLine(before))
  assert(!('nullish' in record), 'null value was written')
  assert(!('missing' in record), 'undefined value was written')
  assert(record.present === 'yes', 'unrelated field lost')
  return 'no null literal noise'
})

console.log('\n-- logAudit allowlist --')

await test('a field outside AUDIT_FIELDS is rejected even though it looks harmless', async () => {
  const before = currentLines().length
  logAudit('deleted', {
    tool: 'x', path: 'a/b.txt', scope: 's', kind: 'file',
    recoverable: 'trash', extra: 'should-not-appear',
  })
  const record = JSON.parse(await waitForNewLine(before))
  assert(!('extra' in record), 'non-allowlisted field was written — this is a blocklist now, not an allowlist')
  for (const f of AUDIT_FIELDS) assert(record[f] !== undefined, `allowlisted field ${f} missing`)
  return 'closed allowlist holds'
})

await test('an allowlisted string value is truncated at 512 chars', async () => {
  const before = currentLines().length
  const longPath = 'a'.repeat(600)
  logAudit('deleted', { tool: 'x', path: longPath, scope: 's', kind: 'file', recoverable: 'trash' })
  const record = JSON.parse(await waitForNewLine(before))
  assert(record.path.length === 512, `expected 512 chars, got ${record.path.length}`)
  return '600 -> 512'
})

await test('a non-string value in an allowlisted field still passes through', async () => {
  const before = currentLines().length
  logAudit('deleted', { tool: 'x', path: 'a/b.txt', scope: 's', kind: 'file', recoverable: 123 })
  const record = JSON.parse(await waitForNewLine(before))
  assert(record.recoverable === 123, 'numeric allowlisted value was dropped or altered')
  return 'numbers/booleans survive under the allowlist'
})

console.log('\n-- category integrity --')

await test('logAudit() writes always carry cat:"audit"', async () => {
  const before = currentLines().length
  logAudit('deleted', { tool: 'x', path: 'a/b.txt', scope: 's', kind: 'file', recoverable: 'trash' })
  const record = JSON.parse(await waitForNewLine(before))
  assert(record.cat === 'audit', 'audit write did not carry cat:"audit"')
  return 'cat:audit'
})

await test('logEvent() writes carry the caller-supplied category', async () => {
  const before = currentLines().length
  logEvent('mycategory', 'probe', {})
  const record = JSON.parse(await waitForNewLine(before))
  assert(record.cat === 'mycategory', 'event write lost the caller category')
  return 'cat passthrough'
})

console.log('\n-- 🔍 Phase 7 §7.4a: crash-handler mapping survives logEvent() intact --')

await test('🔍 an Error\'s message becomes the logged reason, verbatim, on disk', async () => {
  const { logFields } = describeCrash(new Error('llama-server.exe binary not found'))
  assert(logFields.reason === 'llama-server.exe binary not found', `unexpected reason: ${JSON.stringify(logFields)}`)
  const before = currentLines().length
  logEvent('app', 'crash', logFields)
  const line = await waitForNewLine(before)
  const record = JSON.parse(line)
  assert(record.reason === 'llama-server.exe binary not found', `reason did not survive logEvent: ${line}`)
})

closeLogger()
fs.rmSync(tmpDir, { recursive: true, force: true })

console.log('\n-- real call-site sanity (static, light) --')

await test('every logAudit() call site passes only allowlisted fields', () => {
  const callSites = [
    path.join(import.meta.dirname, '../electron/main/files-api.mjs'),
    path.join(import.meta.dirname, '../electron/main/fs-delete-tool.mjs'),
  ]
  const allowed = new Set(AUDIT_FIELDS)
  const offenders = []
  let sitesChecked = 0

  for (const file of callSites) {
    const src = fs.readFileSync(file, 'utf8')
    // Match `logAudit('event', { ...object literal... })` calls and pull the
    // top-level keys out of the object literal argument.
    const callRe = /logAudit\(\s*['"][^'"]*['"]\s*,\s*\{([^}]*)\}/g
    let m
    while ((m = callRe.exec(src))) {
      sitesChecked++
      const body = m[1]
      const keyRe = /(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:/g
      let km
      while ((km = keyRe.exec(body))) {
        const key = km[1]
        if (!allowed.has(key)) offenders.push(`${path.basename(file)}: ${key}`)
      }
    }
  }

  assert(sitesChecked > 0, 'no logAudit( call sites found — grep pattern or file paths went stale')
  assert(offenders.length === 0, offenders.join('; '))
  return `${sitesChecked} call site(s) checked`
})

// ---------------------------------------------------------------------------
// Phase 7 §7.4a — crash-handler mapping, remaining pure cases
// ---------------------------------------------------------------------------
// describeCrash() is the err -> { log fields, notification text } mapping,
// deliberately split out of index.mjs's process.on('uncaughtException'/
// 'unhandledRejection') registration so it's testable without Electron —
// see crash-handler.mjs's own header. The disk round-trip lives above,
// before closeLogger(); these two need no logger at all.

console.log('\n-- 🔍 Phase 7 §7.4a: crash-handler mapping (pure cases) --')

await test('unhandledRejection can hand back a non-Error — still produces a string reason, not a throw', () => {
  for (const rejection of ['a plain string rejection', 42, { some: 'object' }, null, undefined]) {
    const { logFields } = describeCrash(rejection)
    assert(typeof logFields.reason === 'string' && logFields.reason.length > 0,
      `describeCrash(${JSON.stringify(rejection)}) produced a non-string or empty reason: ${JSON.stringify(logFields)}`)
  }
})

await test('the notification text never includes the raw error message', () => {
  // decision: warn with a generic, actionable message — not the exception
  // text itself, which could be arbitrarily long or, for an error thrown
  // from deep in a dependency, carry a stack-trace-shaped string that is
  // not useful in a toast notification.
  const { notification } = describeCrash(new Error('some very specific internal stack detail'))
  assert(!notification.body.includes('some very specific internal stack detail'), 'raw error text leaked into the notification body')
  assert(!notification.title.includes('some very specific internal stack detail'), 'raw error text leaked into the notification title')
  assert(notification.body.length > 0 && notification.title.length > 0, 'notification text must not be empty')
})

// ---------------------------------------------------------------------------

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
