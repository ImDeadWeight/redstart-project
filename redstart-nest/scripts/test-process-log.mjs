// =============================================================================
// Unit tests for electron/main/process-log.mjs (Phase 5 §5.2) — llama-server's
// own output, persisted separately from logger.mjs's privacy-filtered event log.
// =============================================================================
// Pure Node, no Electron dependency.
//
// Run:  node scripts/test-process-log.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  initProcessLog, startRun, appendLine, endRun, ringBuffer, currentRunFile,
} from '../electron/main/process-log.mjs'

const results = []

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

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-process-log-'))
initProcessLog(base)

console.log('\n--- ring buffer ---')

await test('appendLine grows the ring buffer', () => {
  appendLine('line one')
  appendLine('line two')
  const ring = ringBuffer()
  assert(ring.length >= 2, 'expected at least 2 lines')
  assert(ring[ring.length - 2] === 'line one' && ring[ring.length - 1] === 'line two', 'lines out of order')
})

await test('the ring buffer is capped at 1000 lines, oldest dropped first', () => {
  // Fresh state so the count is exact.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-process-log-2-'))
  initProcessLog(dir2)
  for (let i = 0; i < 1500; i++) appendLine(`line ${i}`)
  const ring = ringBuffer()
  assert(ring.length === 1000, `expected 1000, got ${ring.length}`)
  assert(ring[0] === 'line 500', `expected oldest kept to be "line 500", got ${ring[0]}`)
  assert(ring[999] === 'line 1499', `expected newest to be "line 1499", got ${ring[999]}`)
  initProcessLog(base) // restore for the rest of the suite
})

console.log('\n--- per-launch files ---')

await test('startRun creates a new file immediately', () => {
  const { file } = startRun()
  assert(fs.existsSync(file), 'the run file was not created')
  assert(currentRunFile() === file, 'currentRunFile() disagrees with startRun()')
  endRun()
})

await test('appendLine writes to the current run file', () => {
  const { file } = startRun()
  appendLine('hello from the run')
  const content = fs.readFileSync(file, 'utf8')
  assert(content.includes('hello from the run'), 'the line was not written to disk')
  endRun()
})

await test('endRun stops writing to that file, but leaves it on disk', () => {
  const { file } = startRun()
  appendLine('before end')
  endRun()
  const before = fs.readFileSync(file, 'utf8')
  appendLine('after end — should not appear')
  const after = fs.readFileSync(file, 'utf8')
  assert(before === after, 'a line landed in a file after its run ended')
  assert(fs.existsSync(file), 'the file was deleted, not just closed')
})

await test('a run that exceeds the 5 MB cap keeps its newest lines', () => {
  const { file } = startRun()
  // Large lines (~50 KB) so the cap is crossed in ~100 lines rather than
  // ~30000 — appendLine() does a full-file rewrite on every line once
  // capped (documented in the module), so a fine-grained line count here
  // would make this test itself slow rather than exercising anything new.
  const filler = 'x'.repeat(50 * 1024)
  const total = 150
  for (let i = 0; i < total; i++) appendLine(`${i} ${filler}`)
  endRun()
  const size = fs.statSync(file).size
  assert(size <= 5 * 1024 * 1024, `run file exceeded the cap: ${size} bytes`)
  const content = fs.readFileSync(file, 'utf8')
  assert(content.includes(`${total - 1} `), 'the newest line was evicted instead of kept')
  assert(!content.includes('\n0 '), 'the oldest line should have been evicted')
})

console.log('\n--- retention (10 runs) ---')

await test('only the newest 10 run files are kept', async () => {
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-process-log-3-'))
  initProcessLog(dir3)
  const files = []
  for (let i = 0; i < 13; i++) {
    const { file } = startRun()
    appendLine(`run ${i}`)
    endRun()
    files.push(file)
    // startRun() timestamps with Date.now(); force distinct names even if
    // this loop runs faster than the clock ticks.
    if (i < 12) await new Promise(r => setTimeout(r, 2))
  }
  const remaining = fs.readdirSync(path.join(dir3, 'server-logs')).filter(f => /^run-\d+\.log$/.test(f))
  assert(remaining.length === 10, `expected 10 run files, found ${remaining.length}`)
  // The three oldest should be gone.
  for (const gone of files.slice(0, 3)) {
    assert(!fs.existsSync(gone), `${gone} should have been pruned`)
  }
  initProcessLog(base)
})

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
