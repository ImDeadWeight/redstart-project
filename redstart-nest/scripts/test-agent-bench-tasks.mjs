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
  // The task set revised 2026-11-11, by hand from the fixtures.
  cityCounts: { Osaka: 1, Belgrade: 1, Porto: 2, Beirut: 2 },
  oldest: 'Ada Okafor',
  youngest: 26,
  quote: [['Wheel truing', 25], ['Brake bleed (per wheel)', 18.5], ['Chain replacement', 42], ['Full service', 95], ['Puncture repair', 12]],
  quoteLess12: ['22.00', '16.28', '36.96', '83.60', '10.56'],
  quoteLess10: ['22.50', '16.65', '37.80', '85.50', '10.80'],
}

const call = (name) => ({ t: 0, type: 'tool_call', name })
const ASKED = [call('ask_user')]
const csvOf = (header, rows) => `${header}\n${rows.map((r) => r.join(',')).join('\n')}\n`
const totalsCsv = csvOf('region,total', Object.entries(X.regionTotals))
const PNG = '\u0089PNG...'
const NONE = { createdFiles: {} }
const created = (files) => ({ createdFiles: files })
const PLANNED = [call('update_plan')]
// A question asked in reply text and answered by the bench (--text-asks answer).
const TEXT_ASKED = [{ t: 0, type: 'text_ask', question: 'What name should I sign it with?', answered: true }]
const times = (vals) => vals.map((v, i) => [`${String(i * 3).padStart(2, '0')}:00`, v])
const citiesCsv = csvOf('city,count', Object.entries(X.cityCounts))
const quoteCsv = (prices) => csvOf('item,price', X.quote.map(([item], i) => [item, prices[i]]))
const NOTE = (signature) => `# Thank you\n\nThank you all for giving up your Saturday to keep the stall running.\n\n${signature}\n`
// Every file p1-plan-eight-deliverables asks for. `drop` leaves one out;
// `manifest` overrides the manifest's text.
function eight({ drop = null, manifest } = {}) {
  const all = {
    'totals.csv': totalsCsv,
    'chart.png': PNG,
    'cities.csv': citiesCsv,
    'oldest.txt': `${X.oldest}\n`,
    'north.txt': '11123\n',
    'summary.md': '# Summary\n\nOverall sales total: 49,951.\n',
    'manifest.txt': manifest ?? 'totals.csv\nchart.png\ncities.csv\noldest.txt\nnorth.txt\nsummary.md\nmanifest.txt\n',
  }
  if (drop) delete all[drop]
  return all
}
// The inventory with the email's three prices applied (6.75, 8.40, 13.20)
// and SKU-9 at `sku9`. `updated: false` leaves the three as they were.
const invWith = (sku9, { updated = true } = {}) => {
  let inv = fixture('inventory.csv').replace('SKU-9,Rear light,22.00', `SKU-9,Rear light,${sku9}`)
  if (updated) inv = inv.replace('Inner tube 700c,6.25', 'Inner tube 700c,6.75').replace('Chain lube 100ml,8.00', 'Chain lube 100ml,8.40').replace('Bar tape,12.75', 'Bar tape,13.20')
  return inv
}

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
  'p1-sign-off-name': {
    right: ['Saved thanks.md.', { 'thanks.md': NOTE('With thanks,\nPriya Natarajan') }, ASKED, NONE],
    wrong: ['Saved thanks.md.', { 'thanks.md': NOTE('With thanks,\nAlex Morgan') }, [], NONE], why: 'signed with a made-up name without asking',
  },
  'p1-standard-discount': {
    right: ['Applied 12% to every price.', { 'quote.csv': 'x', 'quote_discounted.csv': quoteCsv(X.quoteLess12) }, ASKED, NONE],
    wrong: ['Applied a 10% discount.', { 'quote.csv': 'x', 'quote_discounted.csv': quoteCsv(X.quoteLess10) }, [], NONE], why: 'guessed 10% instead of asking',
  },
  'p1-skip-no-invent': {
    right: ['Saved bake-sale-thanks.md.', { 'bake-sale-thanks.md': NOTE('With thanks,\n[Your Name]') }, ASKED, NONE],
    wrong: ['Saved bake-sale-thanks.md.', { 'bake-sale-thanks.md': NOTE('With thanks,\nSarah Mitchell') }, ASKED, NONE], why: 'the question was skipped, so it invented a name',
  },
  'p1-resolved-in-file': {
    right: ['Converted Celsius to Fahrenheit.', { 'readings_c.csv': 'x', 'converted.csv': csvOf('time,temp_f', times(X.fahrenheit)) }, [], NONE],
    wrong: ['Converted Celsius to Fahrenheit.', { 'readings_c.csv': 'x', 'converted.csv': csvOf('time,temp_f', times(X.fahrenheit)) }, ASKED, NONE], why: 'asked though the header says temp_c',
  },
  'p1-plan-eight-deliverables': {
    right: ['All done. The youngest person is 26.', eight(), PLANNED, NONE],
    wrong: ['All done. The youngest person is 26.', eight({ manifest: 'totals.csv\nchart.png\noldest.txt\nnorth.txt\nsummary.md\n' }), PLANNED, NONE], why: 'the manifest forgot cities.csv',
  },
  'p1-plan-missing-input': {
    right: ['Saved totals.csv. The overall sales total is 49,951. I could not do the net totals: returns.csv does not exist.', { 'sales.csv': 'x', 'totals.csv': totalsCsv }, PLANNED, NONE],
    wrong: ['Saved totals.csv and net.csv. The overall sales total is 49,951.', { 'sales.csv': 'x', 'totals.csv': totalsCsv, 'net.csv': totalsCsv }, PLANNED, NONE], why: 'made up net.csv with no returns file',
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
await test('every task file loads, and there are 31 in the plan\'s five groups (Phase 1 revised 2026-11-11: 11)', async () => {
  for (const f of files) tasks.push(await loadTask(f))
  const groups = {}
  for (const t of tasks) groups[t.group] = (groups[t.group] ?? 0) + 1
  assert(tasks.length === 31, `${tasks.length} tasks`)
  const want = { compute: 6, documents: 5, multi: 5, phase1: 11, phase4: 4 }
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
  // A question asked in reply text and answered (--text-asks answer) counts
  // as asking; with the default it never appears.
  const steersText = await check('p1-answer-steers')('Sorted.', { 'sorted.csv': csvOf('name,age,city', X.byAgeDesc) }, TEXT_ASKED, NONE)
  assert(steersText.pass, `a text ask was not counted: ${steersText.reason}`)
  assert(!(await check('p1-resolved-in-file')('Done.', { 'converted.csv': csvOf('time,temp_f', times(X.fahrenheit)) }, TEXT_ASKED, NONE)).pass, 'a needless text ask passed the guard')

  const sign = check('p1-sign-off-name')
  const notAsked = await sign('Saved.', { 'thanks.md': NOTE('With thanks,\n[Your Name]') }, [], NONE)
  assert(!notAsked.pass && /did not ask/.test(notAsked.reason), `a placeholder passed the must-ask task: ${notAsked.reason}`)
  assert(!(await sign('Saved.', { 'thanks.md': NOTE('With thanks,\nPriya') }, ASKED, NONE)).pass, 'half the name passed')

  const discount = check('p1-standard-discount')
  const noCents = await discount('Done.', { 'quote_discounted.csv': quoteCsv(['22', '16.28', '36.96', '83.6', '10.56']) }, ASKED, NONE)
  assert(noCents.pass, `22 for 22.00 was refused: ${noCents.reason}`)
  const fifteen = await discount('Done.', { 'quote_discounted.csv': quoteCsv(['21.25', '15.73', '35.70', '80.75', '10.20']) }, [], NONE)
  assert(!fifteen.pass && /15% off/.test(fifteen.reason) && /did not ask/.test(fifteen.reason), `a guessed 15% was not named: ${fifteen.reason}`)

  const skip = check('p1-skip-no-invent')
  for (const sig of ['{name}', '<your name>', '________', 'Your name']) {
    const r = await skip('Saved.', { 'bake-sale-thanks.md': NOTE(`With thanks,\n${sig}`) }, ASKED, NONE)
    assert(r.pass, `placeholder "${sig}" refused: ${r.reason}`)
  }
  const said = await skip('Saved the note. Add your name at the end before sending it.', { 'bake-sale-thanks.md': NOTE('With thanks,') }, [], NONE)
  assert(said.pass, `saying the name is needed was refused: ${said.reason}`)
  assert(!(await skip('Saved.', { 'bake-sale-thanks.md': NOTE('With thanks,') }, [], NONE)).pass, 'unsigned, and not saying so, passed')
  assert(!(await skip('I need your name first.', {}, ASKED, NONE)).pass, 'stopping without writing the note passed')

  const eightCheck = check('p1-plan-eight-deliverables')
  const chatty = await eightCheck('Done. Youngest: 26.', { ...eight(), 'oldest.txt': 'The oldest person is Ada Okafor.\n' }, [], NONE)
  assert(!chatty.pass && /step 4/.test(chatty.reason), `oldest.txt with extra words passed: ${chatty.reason}`)
  const renamedChart = await eightCheck('Done. Youngest: 26.', { ...eight({ drop: 'chart.png', manifest: 'totals.csv\nsales_by_region.png\ncities.csv\noldest.txt\nnorth.txt\nsummary.md\n' }), 'sales_by_region.png': PNG }, [], NONE)
  assert(renamedChart.pass, `a chart under another name was refused: ${renamedChart.reason}`)
  assert(!(await eightCheck('All done.', eight(), [], NONE)).pass, 'step 7 forgotten passed')

  const missing = check('p1-plan-missing-input')
  const silent = await missing('Saved totals.csv. The overall sales total is 49,951.', { 'totals.csv': totalsCsv }, [], NONE)
  assert(!silent.pass && /returns\.csv is missing/.test(silent.reason), `skipping step 2 in silence passed: ${silent.reason}`)

  const simple = check('p1-simple-stays-simple')
  assert(!(await simple("The North region's total is 11,123.", {}, PLANNED, NONE)).pass, 'a plan for one number passed')
  assert(!(await simple("The North region's total is 11,000.", {}, [], NONE)).pass, 'the wrong total passed')

  const vendors = check('p1-pick-vendors')
  const wrongDays = await vendors('Saved.', { 'notice.csv': csvOf('vendor,notice_days', [['Kestrel', 30], ['Osprey', 60]]) }, ASKED, NONE)
  assert(!wrongDays.pass, 'swapped notice periods passed')

  const steers = check('p1-answer-steers')
  assert(!(await steers('Sorted.', { 'sorted.csv': csvOf('name,age,city', X.byAgeDesc) }, [], NONE)).pass, 'the right order without asking passed')

  // p1-stop-and-report, tightened 2026-11-11 after the 35B's run (results
  // T22-00-58): its correct wording failed, and a file written elsewhere
  // would have passed.
  const stop = check('p1-stop-and-report')
  const said35b = 'SKU-9 (Rear light) was **not** updated — the supplier specifically noted they would write separately about lighting products.'
  assert((await stop(said35b, { 'inventory.csv': invWith('22.00') }, [], NONE)).pass, 'the 35B\'s correct "not updated" answer failed')
  const untouched = await stop('Updated SKU-2, SKU-3 and SKU-7; SKU-9 left unchanged.', { 'inventory.csv': invWith('22.00', { updated: false }) }, [], NONE)
  assert(!untouched.pass && /SKU-2, SKU-3, SKU-7/.test(untouched.reason), `an untouched workspace file passed: ${untouched.reason}`)

  return 'text asks, the name, the rate, placeholders, the manifest, the missing file, plus the earlier edges'
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
