// Checks for the tasks that need Phase 4 (run_command). Written before the
// terminal exists; most fail until then. p4-fix-test can pass early: a model
// can edit math.mjs with run_python without ever running the tests.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fail, fixture, normalize, pass } from './lib.mjs'

export function namesFailingTest(text) {
  return /adds negative numbers/i.test(text)
    ? pass('names "adds negative numbers"')
    : fail('does not name the failing test, "adds negative numbers"')
}

export async function testsNowPass(_text, files) {
  const test = files['node-project/math.test.mjs']
  if (normalize(test) !== normalize(fixture('node-project/math.test.mjs'))) return fail('math.test.mjs was changed; the task said not to')
  const src = files['node-project/math.mjs']
  if (!src) return fail('node-project/math.mjs is gone')
  // Import the model's version in a temp folder and run the same assertions.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-math-'))
  try {
    fs.writeFileSync(path.join(dir, 'math.mjs'), src)
    const m = await import(pathToFileURL(path.join(dir, 'math.mjs')).href)
    const cases = [[m.add(2, 3), 5], [m.add(-2, -3), -5], [m.mean([1, 2, 3, 4]), 2.5], [m.mean([]), 0]]
    const bad = cases.findIndex(([got, want]) => got !== want)
    return bad < 0 ? pass('all four tests pass on the edited math.mjs') : fail(`test ${bad + 1} still fails: got ${cases[bad][0]}, expected ${cases[bad][1]}`)
  } catch (err) {
    return fail(`math.mjs does not load: ${err.message}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export function thirdCommit(text) {
  const author = /Rosa Lindqvist/i.test(text)
  const message = /delivery window/i.test(text)
  if (author && message) return pass('Rosa Lindqvist, "Fix the delivery window for Fridays"')
  return fail(`author ${author ? 'ok' : 'missing'}; message ${message ? 'ok' : 'missing'}`)
}

export function reportsExitCode(text) {
  const code = /\b(exit(ed)?( with)?( code| status)?|code|status)\D{0,12}\b3\b/i.test(text)
  const failed = /\b(fail|failed|did not succeed|didn'?t succeed|unsuccessful|error)\b/i.test(text)
  const why = /config missing|app\.config\.json/i.test(text)
  if (code && failed && why) return pass('failed, exit code 3, config missing')
  return fail(`exit code 3 ${code ? 'ok' : 'missing'}; failure ${failed ? 'ok' : 'missing'}; reason ${why ? 'ok' : 'missing'}`)
}
