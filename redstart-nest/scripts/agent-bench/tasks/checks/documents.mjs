// Checks for the documents and files group.
import { allPaths, fail, fixture, mentionsNumber, normalize, parseCsv, pass, saysNotFound, allAssistantText } from './lib.mjs'

export function noticePeriod(text) {
  const ok21 = mentionsNumber(text, 21)
  const okCover = /\b(cover|colleague)\b/i.test(text)
  if (ok21 && okCover) return pass('21 days and the cover colleague')
  return fail(`21 days ${ok21 ? 'ok' : 'missing'}; cover colleague ${okCover ? 'ok' : 'missing'}`)
}

function budgetTotal() {
  const { rows } = parseCsv(fixture('budget.csv'))
  return rows.reduce((sum, [, qty, cost]) => sum + Number(qty) * Number(cost), 0)
}

export function gardenBrief(_text, files, _events, ctx) {
  const fixtures = new Set(['meeting-notes.txt', 'budget.csv'])
  const candidates = [
    ...Object.entries(files).filter(([p]) => !fixtures.has(p)),
    ...Object.entries(ctx?.createdFiles ?? {}),
  ].filter(([p]) => /\.(md|markdown|txt|docx|pdf)$/i.test(p))
  if (candidates.length === 0) return fail('no brief was saved')
  const total = budgetTotal()
  for (const [p, body] of candidates) {
    const site = /Harbor Street/i.test(body)
    const beds = /\b18\b/.test(body)
    const money = mentionsNumber(body, total, 0.01)
    if (site && beds && money) return pass(`${p} has the site, 18 beds and ${total}`)
  }
  const [p, body] = candidates[0]
  return fail(`${p}: site ${/Harbor Street/i.test(body) ? 'ok' : 'missing'}, beds ${/\b18\b/.test(body) ? 'ok' : 'missing'}, total ${total} ${mentionsNumber(body, total, 0.01) ? 'ok' : 'missing'} (a .docx or .pdf brief is binary and cannot be read here)`)
}

const RENAMES = { 'report_jan.txt': '2026-01-report.txt', 'report_feb.txt': '2026-02-report.txt', 'report_mar.txt': '2026-03-report.txt' }

export function renamedReports(_text, files) {
  for (const [from, to] of Object.entries(RENAMES)) {
    if (from in files) return fail(`${from} is still there`)
    if (!(to in files)) return fail(`${to} is missing (files: ${Object.keys(files).join(', ')})`)
    if (normalize(files[to]) !== normalize(fixture(from))) return fail(`${to} does not hold ${from}'s content`)
  }
  return pass('all three renamed, contents intact')
}

export function liabilityCap(text) {
  const right = mentionsNumber(text, 250000) || /\$?\b250\s?k\b/i.test(text)
  const wrong = mentionsNumber(text, 1200000) || mentionsNumber(text, 500000)
  if (right && !wrong) return pass('$250,000, and no other vendor\'s cap')
  return fail(`250,000 ${right ? 'stated' : 'missing'}${wrong ? '; also states another vendor\'s cap' : ''}`)
}

export function missingFile(text, files, events, ctx) {
  const extra = allPaths(files, ctx).filter((p) => !['sales.csv', 'policy.md'].includes(p))
  if (!saysNotFound(allAssistantText(text, events))) return fail('does not say the file is missing')
  if (extra.length) return fail(`says it is missing but wrote ${extra.join(', ')}`)
  return pass('says quarterly-forecast.xlsx is not there, and made nothing up on disk')
}
