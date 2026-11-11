// =============================================================================
// The agent benchmark's task set: every task loads, and every check can tell
// a right answer from a wrong one
// =============================================================================
// Agent-runtime plan Phase 0.3. A check that passes everything inflates the
// baseline; one that fails everything hides a real gain. So each of the 29
// tasks gets two cases here: a correct outcome, which must pass, and the
// plausible wrong outcome a small model actually produces (a near-miss
// number, the wrong file, a guess, a skipped step), which must fail.
//
// The expected values below were computed independently, in Python from the
// fixture files (not by the checks' own JavaScript), so a check and this
// suite cannot share a bug.
//
// Run:  node scripts/test-agent-bench-tasks.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findTaskFiles, loadTask } from './agent-bench/lib/task-file.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const TASKS = path.join(here, 'agent-bench', 'tasks')
const FX = path.join(TASKS, 'fixtures')
const fixture = (n) => fs.readFileSync(path.join(FX, n), 'utf8')

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

// Independent answers (Python, stdlib, from the fixtures).
const X = {
  arithmetic: 481283227,
  days: 1000,
  weekday: 'Friday',
  regionTotals: { North: 11123, South: 13905, East: 12754, West: 12169 },
  topRegion: 'South',
  grand: 49951,
  topCustomer: ['Chen Wei', 4242.92],
  people: [['Ada Okafor', 71, 'Osaka'], ['Bruno Silva', 46, 'Belgrade'], ['Chen Wei', 67, 'Porto'], ['Dana Kowalski', 26, 'Beirut'], ['Emeka Obi', 34, 'Beirut'], ['Farah Haddad', 57, 'Porto']],
  avgScore: 71.73,
  chain: 368,
  budget: 4011,
  fahrenheit: [69.8, 84.2, 37.4, 42.8, 39.2, 62.6, 42.8, 60.8],
  // Phase 1 additions (2026-11-11), by hand from the fixtures.
  byAgeDesc: [['Ada Okafor', 71, 'Osaka'], ['Chen Wei', 67, 'Porto'], ['Farah Haddad', 57, 'Porto'], ['Bruno Silva', 46, 'Belgrade'], ['Emeka Obi', 34, 'Beirut'], ['Dana Kowalski', 26, 'Beirut']],
  celsiusIfFahrenheit: [-6.1, -1.7, -16.1, -14.4, -15.6, -8.3, -14.4, -8.9],
  cities: { Osaka: ['Ada Okafor'], Belgrade: ['Bruno Silva'], Porto: ['Chen Wei', 'Farah Haddad'], Beirut: ['Dana Kowalski', 'Emeka Obi'] },
  averageAge: 50.2,
}

const call = (name) => ({ t: 0, type: 'tool_call', name })
const ASKED = [call('ask_user')]
const csvOf = (header, rows) => `${header}\n${rows.map((r) => r.join(',')).join('\n')}\n`
const totalsCsv = csvOf('region,total', Object.entries(X.regionTotals))
const PNG = '\u0089PNG...'
const NONE = { createdFiles: {} }
const created = (files) => ({ createdFiles: files })
const fixedB = fixture('draft_b.md').replace('recieve', 'receive').replace('seperate', 'separate').replace('commitee', 'committee')
const PLANNED = [call('update_plan')]
const times = (vals) => vals.map((v, i) => [`${String(i * 3).padStart(2, '0')}:00`, v])
const cityFiles = (skip) => Object.fromEntries(Object.entries(X.cities).filter(([c]) => c !== skip).map(([c, names]) => [`${c}.txt`, `${names.join('\n')}\n`]))
const citiesCsv = csvOf('city,count', Object.entries(X.cities).map(([c, n]) => [c, n.length]))
const invWith = (sku9) => fixture('inventory.csv').replace('SKU-9,Rear light,22.00', `SKU-9,Rear light,${sku9}`)

/**
 * id → { right: [text, files, events, ctx], wrong: [...] , why }
 * `why` names the mistake the wrong case models.
 */
const CASES = {
  'compute-arithmetic': {
    right: ['48271 × 9973 − 123456 = 481,283,227.'],
    wrong: ['That comes to about 481,283,000.'], why: 'an estimate',
  },
  'compute-csv-summary': {
    right: ['North: 11,123; South: 13,905; East: 12,754; West: 12,169. South has the highest total.'],
    wrong: ['North: 11,123; South: 13,905; East: 12,754; West: 12,169. East has the highest total.'], why: 'the wrong top region',
  },
  'compute-chart': {
    right: ['Saved.', { 'sales.csv': 'x', 'region_totals.png': PNG }, [], NONE],
    wrong: ['Here is the chart: [image]', { 'sales.csv': 'x' }, [], NONE], why: 'claims a chart, saved none',
  },
  'compute-dates': {
    right: ['There are 1,000 days between them, and 4 July 2031 is a Friday.'],
    wrong: ['There are 999 days between them, and 4 July 2031 is a Friday.'], why: 'off by one',
  },
  'compute-join': {
    right: ['Chen Wei has the highest total, 4242.92.'],
    wrong: ['Chen Wei has the most orders, 9 of them.'], why: 'the right name, the wrong measure',
  },
  'compute-convert': {
    right: ['Done.', { 'people.json': 'x', 'people.csv': csvOf('name,age,city', X.people) }, [], NONE],
    wrong: ['Done.', { 'people.json': 'x', 'people.csv': csvOf('name,city,age', X.people.map(([n, a, c]) => [n, c, a])) }, [], NONE], why: 'columns in the wrong order',
  },
  'docs-find-fact': {
    right: ['At least 21 days\' notice, and the request must name a colleague who agreed to cover urgent work.'],
    wrong: ['At least 10 days\' notice.'], why: 'the four-day-to-two-week rule',
  },
  'docs-two-sources': {
    right: ['Saved.', {}, [], created({ 'Garden project brief.md': '# Garden project brief\n\nSite: Harbor Street lot.\n\n18 raised beds.\n\nTotal budget: $4,011.00.' })],
    wrong: ['Saved.', {}, [], created({ 'Garden project brief.md': '# Garden project brief\n\nSite: Harbor Street lot.\n\n18 raised beds.\n\nTotal budget: $1,500.50.' })], why: 'summed unit costs, not quantity × cost',
  },
  'docs-rename': {
    right: ['Renamed.', { '2026-01-report.txt': fixture('report_jan.txt'), '2026-02-report.txt': fixture('report_feb.txt'), '2026-03-report.txt': fixture('report_mar.txt') }],
    wrong: ['Renamed.', { 'report_jan.txt': fixture('report_jan.txt'), '2026-01-report.txt': fixture('report_jan.txt'), '2026-02-report.txt': fixture('report_feb.txt'), '2026-03-report.txt': fixture('report_mar.txt') }], why: 'copied instead of renamed',
  },
  'docs-search': {
    right: ['The Kestrel Analytics agreement (KX-4471-Q) caps the vendor\'s liability at $250,000 [1].'],
    wrong: ['The cap is $1,200,000 [1].'], why: 'another vendor\'s cap',
  },
  'docs-missing-file': {
    right: ['I couldn\'t find quarterly-forecast.xlsx in your workspace. I can see sales.csv and policy.md.', { 'sales.csv': 'x', 'policy.md': 'x' }, [], NONE],
    wrong: ['The quarterly forecast shows revenue growing 12% to $4.2M.', { 'sales.csv': 'x', 'policy.md': 'x' }, [], NONE], why: 'invents a summary',
  },
  'multi-three-deliverables': {
    right: ['Saved totals.csv and the chart. The overall total is 49,951.', { 'totals.csv': totalsCsv, 'chart.png': PNG }, [], NONE],
    wrong: ['Saved totals.csv. The overall total is 49,951.', { 'totals.csv': totalsCsv }, [], NONE], why: 'skipped the chart',
  },
  'multi-recover': {
    right: ['The average of the 30 well-formed rows is 71.73.'],
    wrong: ['The average is 70.84.'], why: 'kept the malformed rows',
  },
  'multi-chain': {
    right: ['Following all twelve links, the final number is 368.'],
    wrong: ['After the first few files the number is 120.'], why: 'stopped early',
  },
  'multi-find-tool': {
    right: ['There are 4 documents in this conversation\'s workspace.', {}, [call('list_documents')], NONE],
    wrong: ['There are 4 files.', {}, [call('run_python')], NONE], why: 'ran code when told not to',
  },
  'multi-distractor': {
    right: ['The internal codename is BLUE HERON.'],
    wrong: ['I could not read project-notes.md: read_text_file says the file does not exist.'], why: 'went to the File System root and gave up',
  },
  'p1-ambiguous-units': {
    right: ['Converted to Fahrenheit.', { 'readings.csv': 'x', 'converted.csv': csvOf('time,temp_f', X.fahrenheit.map((f, i) => [`${String(i * 3).padStart(2, '0')}:00`, f])) }, ASKED, NONE],
    wrong: ['Converted to Fahrenheit.', { 'readings.csv': 'x', 'converted.csv': csvOf('time,temp_f', X.fahrenheit.map((f, i) => [`${String(i * 3).padStart(2, '0')}:00`, f])) }, [], NONE], why: 'right result, guessed the unit without asking',
  },
  'p1-which-draft': {
    right: ['Fixed draft_b.md.', { 'draft_a.md': fixture('draft_a.md'), 'draft_b.md': fixedB }, ASKED, NONE],
    wrong: ['Fixed both drafts.', { 'draft_a.md': fixture('draft_a.md').replace('watter', 'water'), 'draft_b.md': fixedB }, ASKED, NONE], why: 'changed the draft that was not chosen',
  },
  'p1-five-steps': {
    right: ['South has the highest total. The overall total is 49951.', { 'totals.csv': totalsCsv, 'chart.png': PNG, 'top.txt': 'South\n' }, [], NONE],
    wrong: ['South has the highest total. The overall total is 49951.', { 'totals.csv': totalsCsv, 'chart.png': PNG }, [], NONE], why: 'forgot step 4',
  },
  'p1-stop-and-report': {
    right: ['Updated SKU-2, SKU-3 and SKU-7. The email has no new price for SKU-9, so I left it unchanged.', { 'inventory.csv': invWith('22.00') }, [], NONE],
    wrong: ['Updated all four, setting SKU-9 to 23.00.', { 'inventory.csv': invWith('23.00') }, [], NONE], why: 'guessed a price',
  },
  'p1-answer-steers': {
    right: ['Sorted by age, oldest first.', { 'people.json': 'x', 'sorted.csv': csvOf('name,age,city', X.byAgeDesc) }, ASKED, NONE],
    wrong: ['Sorted.', { 'people.json': 'x', 'sorted.csv': csvOf('name,age,city', X.people) }, ASKED, NONE], why: 'asked, then sorted by name anyway',
  },
  'p1-pick-vendors': {
    right: ['Saved notice.csv for Kestrel and Osprey.', { 'notice.csv': csvOf('vendor,notice_days', [['Kestrel Analytics', 60], ['Osprey Building Services', 30]]) }, ASKED, NONE],
    wrong: ['Saved notice.csv.', { 'notice.csv': csvOf('vendor,notice_days', [['Alder Logistics', 90], ['Kestrel Analytics', 60], ['Osprey Building Services', 30]]) }, [], NONE], why: 'did all three without asking',
  },
  'p1-assume-on-skip': {
    right: ['I assumed the readings are in Celsius and converted them to Fahrenheit.', { 'readings.csv': 'x', 'converted.csv': csvOf('time,temp_f', times(X.fahrenheit)) }, ASKED, NONE],
    wrong: ['Converted and saved converted.csv.', { 'readings.csv': 'x', 'converted.csv': csvOf('time,temp_f', times(X.fahrenheit)) }, ASKED, NONE], why: 'converted without saying what it assumed',
  },
  'p1-plan-per-city': {
    right: [`Done. The average age is ${X.averageAge}.`, { 'people.json': 'x', ...cityFiles(null), 'cities.csv': citiesCsv }, PLANNED, NONE],
    wrong: [`Done. The average age is ${X.averageAge}.`, { 'people.json': 'x', ...cityFiles('Belgrade'), 'cities.csv': citiesCsv }, PLANNED, NONE], why: 'lost track of one city',
  },
  'p1-simple-stays-simple': {
    right: ['The North region\'s total is 11,123.'],
    wrong: ['The North region\'s total is 11,123.', {}, ASKED, NONE], why: 'asked a question the request answers',
  },
  'p4-run-tests': {
    right: ['One test fails: "adds negative numbers". add() takes Math.abs of both arguments, so add(-2, -3) returns 5.'],
    wrong: ['All tests pass.'], why: 'did not run them',
  },
  'p4-fix-test': {
    right: ['Fixed.', { 'node-project/math.mjs': fixture('node-project/math.mjs').replace('return Math.abs(a) + Math.abs(b)', 'return a + b'), 'node-project/math.test.mjs': fixture('node-project/math.test.mjs') }],
    wrong: ['Fixed.', { 'node-project/math.mjs': fixture('node-project/math.mjs'), 'node-project/math.test.mjs': fixture('node-project/math.test.mjs').replace('-5)', '5)') }], why: 'changed the test instead',
  },
  'p4-git-log': {
    right: ['The third most recent commit is "Fix the delivery window for Fridays" by Rosa Lindqvist.'],
    wrong: ['The third most recent commit is "Record the new loading-bay code" by Mei Tanaka.'], why: 'off by one in the history',
  },
  'p4-exit-code': {
    right: ['It failed with exit code 3: "config missing: app.config.json was not found".'],
    wrong: ['It ran and printed a message.'], why: 'ignored the exit code',
  },
}

const withDefaults = ([text, files = {}, events = [], ctx = NONE]) => [text, files, events, ctx]

console.log('\n-- the task set --')

const files = findTaskFiles(TASKS)
const tasks = []
await test('every task file loads, and there are 29 in the plan\'s five groups (24, plus 5 Phase 1 added 2026-11-11)', async () => {
  for (const f of files) tasks.push(await loadTask(f))
  const groups = {}
  for (const t of tasks) groups[t.group] = (groups[t.group] ?? 0) + 1
  assert(tasks.length === 29, `${tasks.length} tasks`)
  const want = { compute: 6, documents: 5, multi: 5, phase1: 9, phase4: 4 }
  assert(JSON.stringify(groups, Object.keys(want)) === JSON.stringify(want), `groups ${JSON.stringify(groups)}`)
  return JSON.stringify(groups)
})

await test('tasks for a later phase say which, and only they do', async () => {
  for (const t of tasks) {
    const expected = t.group === 'phase1' ? 1 : t.group === 'phase4' ? 4 : 0
    assert(t.phase === expected, `${t.id}: phase ${t.phase}, expected ${expected}`)
  }
})

await test('every fixture a task names exists, and fixtures are byte-stable (-text)', async () => {
  const attrs = fs.readFileSync(path.join(FX, '.gitattributes'), 'utf8')
  assert(/^\* -text$/m.test(attrs), 'fixtures/.gitattributes must mark everything -text')
  return `${tasks.reduce((n, t) => n + t.fixtures.length, 0)} fixture uploads`
})

await test('every task has a right and a wrong case below', async () => {
  const missing = tasks.map((t) => t.id).filter((id) => !CASES[id])
  const extra = Object.keys(CASES).filter((id) => !tasks.some((t) => t.id === id))
  assert(missing.length === 0 && extra.length === 0, `missing ${missing}; extra ${extra}`)
})

console.log('\n-- each check passes the right outcome and fails the wrong one --')

for (const task of tasks) {
  const c = CASES[task.id]
  if (!c) continue
  await test(`${task.id}: right passes, wrong (${c.why}) fails`, async () => {
    const right = await task.check(...withDefaults(c.right))
    assert(right?.pass === true, `right case failed: ${right?.reason}`)
    const wrong = await task.check(...withDefaults(c.wrong))
    assert(wrong?.pass === false, `wrong case passed: ${wrong?.reason}`)
    return wrong.reason
  })
}

await test('Phase 1 checks: the edges one right/wrong pair does not reach', async () => {
  const check = (id) => tasks.find((t) => t.id === id).check
  const skip = check('p1-assume-on-skip')
  // Either direction is a fair assumption, as long as it is said.
  const asF = await skip('I treated them as Fahrenheit and converted to Celsius.', { 'converted.csv': csvOf('time,temp_c', times(X.celsiusIfFahrenheit)) }, [], NONE)
  assert(asF.pass, `Fahrenheit-to-Celsius refused: ${asF.reason}`)
  const stopped = await skip('You did not say which unit, so I stopped.', {}, ASKED, NONE)
  assert(!stopped.pass, 'stopping at the skipped question passed')
  const wrongMaths = await skip('I assumed Celsius.', { 'converted.csv': csvOf('time,temp_f', times(X.fahrenheit.map((f) => f + 1))) }, [], NONE)
  assert(!wrongMaths.pass, 'a wrong conversion passed')

  const simple = check('p1-simple-stays-simple')
  assert(!(await simple("The North region's total is 11,123.", {}, PLANNED, NONE)).pass, 'a plan for one number passed')
  assert(!(await simple("The North region's total is 11,000.", {}, [], NONE)).pass, 'the wrong total passed')

  const vendors = check('p1-pick-vendors')
  const wrongDays = await vendors('Saved.', { 'notice.csv': csvOf('vendor,notice_days', [['Kestrel', 30], ['Osprey', 60]]) }, ASKED, NONE)
  assert(!wrongDays.pass, 'swapped notice periods passed')

  const steers = check('p1-answer-steers')
  assert(!(await steers('Sorted.', { 'sorted.csv': csvOf('name,age,city', X.byAgeDesc) }, [], NONE)).pass, 'the right order without asking passed')

  const city = check('p1-plan-per-city')
  const noAvg = await city('Done.', { ...cityFiles(null), 'cities.csv': citiesCsv }, [], NONE)
  assert(!noAvg.pass && /average age/.test(noAvg.reason), `missing average: ${noAvg.reason}`)
  const bulleted = await city(`Average ${X.averageAge}.`, { ...Object.fromEntries(Object.entries(X.cities).map(([c, n]) => [`${c}.txt`, n.map((x) => `- ${x}`).join('\n')])), 'cities.csv': citiesCsv }, [], NONE)
  assert(bulleted.pass, `a bulleted list was refused: ${bulleted.reason}`)
  // The task does not require a plan: solvable without one.
  return 'either unit, stop, maths, plan on a simple task, swapped days, unasked order, missing average, bullets'
})

await test('saysNotFound: absence stated around a file name, and not a figure of speech', async () => {
  const { saysNotFound } = await import('./agent-bench/tasks/checks/lib.mjs')
  for (const yes of [
    // The 35B's own answer, 2026-11-11 (results T20-24-08), judged wrong then.
    'It looks like the only files available are `policy.md` and `sales.csv` — there is no `quarterly-forecast.xlsx` on this server.',
    'quarterly-forecast.xlsx is not in your documents folder.',
    "There's no such file here.",
    "I couldn't find quarterly-forecast.xlsx anywhere.",
  ]) assert(saysNotFound(yes), `missed: ${yes}`)
  for (const no of [
    'There is no doubt the forecast shows strong growth.',
    'The quarterly forecast shows revenue growing 12% to $4.2M.',
  ]) assert(!saysNotFound(no), `took for "not found": ${no}`)
})

const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed\n`)
if (passed !== results.length) process.exit(1)
