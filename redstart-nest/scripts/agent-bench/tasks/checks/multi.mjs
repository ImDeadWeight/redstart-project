// Checks for the multi-step group.
import { allPaths, fail, findFile, fixture, groupSum, mentionsNumber, numbersIn, parseCsv, pass, round2, toolCallsNamed } from './lib.mjs'

/** totals.csv with one row per region and the right totals. */
function totalsCsvProblem(files, ctx) {
  const f = findFile(files, ctx, /(^|\/)totals[^/]*\.csv$/i)
  if (!f) return 'no totals.csv'
  const want = groupSum(fixture('sales.csv'), 'region', 'amount')
  const { rows } = parseCsv(f.text)
  for (const [region, total] of want) {
    const row = rows.find((r) => r[0] === region)
    if (!row) return `totals.csv has no row for ${region}`
    if (!row.slice(1).some((cell) => Math.abs(Number(cell) - total) < 0.01)) return `totals.csv: ${region} is ${row.slice(1).join(',')}, expected ${total}`
  }
  return null
}

const salesGrandTotal = () => [...groupSum(fixture('sales.csv'), 'region', 'amount').values()].reduce((a, b) => a + b, 0)

export function threeDeliverables(text, files, _events, ctx) {
  const problems = []
  const csv = totalsCsvProblem(files, ctx)
  if (csv) problems.push(csv)
  if (!allPaths(files, ctx).some((p) => /\.png$/i.test(p))) problems.push('no chart (.png)')
  const grand = salesGrandTotal()
  if (!mentionsNumber(text, grand)) problems.push(`overall total ${grand} not stated`)
  return problems.length ? fail(problems.join('; ')) : pass('totals.csv, a chart, and the overall total')
}

export function averageScore(text) {
  const lines = fixture('scores.csv').trim().split('\n').slice(1)
  const valid = lines.map((l) => l.split(',')).filter((cells) => cells.length === 2).map((c) => Number(c[1]))
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length
  return mentionsNumber(text, round2(mean), 0.051)
    ? pass(`average ${round2(mean)} over ${valid.length} valid rows`)
    : fail(`expected ${round2(mean)} (the ${valid.length} well-formed rows), saw ${numbersIn(text).join(', ') || 'no numbers'}`)
}

export function chainResult(text) {
  let n = Number(/Start with (\d+)/.exec(fixture('start.txt'))[1])
  let next = /Next file: (\S+)/.exec(fixture('start.txt'))[1]
  let steps = 0
  while (next) {
    const body = fixture(next)
    n += Number(/Add (\d+)/.exec(body)[1])
    next = /Next file: (\S+)/.exec(body)?.[1]
    steps++
  }
  return mentionsNumber(text, n) ? pass(`${n} after ${steps} files`) : fail(`expected ${n} after ${steps} files, saw ${numbersIn(text).join(', ') || 'no numbers'}`)
}

export function listedWithoutCode(text, _files, events) {
  const fixtures = 4
  const usedList = toolCallsNamed(events, 'list_documents').length > 0
  const usedPython = toolCallsNamed(events, 'run_python').length > 0
  if (usedPython) return fail('ran Python, which the prompt ruled out')
  if (!usedList) return fail('never called list_documents')
  return mentionsNumber(text, fixtures) || /\bfour\b/i.test(text) ? pass('list_documents, and 4 files') : fail(`expected 4 files, saw ${numbersIn(text).join(', ') || 'no numbers'}`)
}

export function codename(text) {
  return /\bblue heron\b/i.test(text) ? pass('BLUE HERON') : fail('the codename BLUE HERON is not in the answer')
}
