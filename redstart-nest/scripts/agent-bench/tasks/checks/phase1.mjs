// Checks for the tasks that need Phase 1 (ask_user, update_plan). Written
// before the tools exist, so they fail until then: that is how Phase 1 proves
// itself (plan §3, 0.3).
import { asked, fail, findFile, fixture, groupSum, normalize, parseCsv, pass, saysNotFound } from './lib.mjs'

export function convertedAfterAsking(_text, files, events, ctx) {
  if (!asked(events)) return fail('did not ask which unit the readings are in (ask_user)')
  const f = findFile(files, ctx, /(^|\/)converted[^/]*\.csv$/i)
  if (!f) return fail('no converted.csv')
  const src = parseCsv(fixture('readings.csv')).rows
  const { header, rows } = parseCsv(f.text)
  const col = header.findIndex((h) => /temp|fahrenheit|°?f\b/.test(h))
  if (col < 0) return fail(`no temperature column in ${header.join(',')}`)
  for (let i = 0; i < src.length; i++) {
    const want = Number(src[i][1]) * 9 / 5 + 32
    if (!rows[i] || Math.abs(Number(rows[i][col]) - want) > 0.11) return fail(`row ${i + 1}: expected ${want}°F, got ${rows[i]?.[col]}`)
  }
  return pass('asked, then converted Celsius to Fahrenheit')
}

const TYPOS = /\b(recieve|seperate|commitee|watter)\b/i

export function fixedTheRightDraft(_text, files, events) {
  if (!asked(events)) return fail('did not ask which draft (ask_user)')
  const b = files['draft_b.md']
  if (!b) return fail('draft_b.md is gone')
  if (TYPOS.test(b)) return fail(`draft_b.md still has "${TYPOS.exec(b)[1]}"`)
  if (normalize(files['draft_a.md']) !== normalize(fixture('draft_a.md'))) return fail('draft_a.md was changed; only draft_b was asked for')
  return pass('asked, fixed draft_b.md, left draft_a.md alone')
}

export function fiveSteps(text, files, _events, ctx) {
  const totals = groupSum(fixture('sales.csv'), 'region', 'amount')
  const [top] = [...totals].sort((a, b) => b[1] - a[1])[0]
  const grand = [...totals.values()].reduce((a, b) => a + b, 0)
  const problems = []
  const csv = findFile(files, ctx, /(^|\/)totals[^/]*\.csv$/i)
  if (!csv) problems.push('step 1: no totals.csv')
  if (![...Object.keys(files), ...Object.keys(ctx?.createdFiles ?? {})].some((p) => /\.png$/i.test(p))) problems.push('step 2: no chart')
  if (!new RegExp(`\\b${top}\\b`).test(text)) problems.push(`step 3: top region ${top} not named`)
  const topFile = findFile(files, ctx, /(^|\/)top[^/]*\.txt$/i)
  if (!topFile) problems.push('step 4: no top.txt')
  else if (normalize(topFile.text) !== top) problems.push(`step 4: top.txt holds "${normalize(topFile.text)}", expected only "${top}"`)
  if (!new RegExp(`\\b${grand}\\b|${grand.toLocaleString('en-US')}`).test(text)) problems.push(`step 5: overall total ${grand} not stated`)
  return problems.length ? fail(problems.join('; ')) : pass('all five steps')
}

export function stoppedAtUnknownPrice(text, files) {
  const inv = files['inventory.csv']
  if (!inv) return fail('inventory.csv is gone')
  const row = parseCsv(inv).rows.find((r) => r[0] === 'SKU-9')
  if (!row) return fail('SKU-9 was removed from inventory.csv')
  if (Math.abs(Number(row[row.length - 1]) - 22) > 0.001) return fail(`SKU-9's price was changed to ${row[row.length - 1]}, a guess: the email gives none`)
  const reported = /SKU-9/i.test(text) && (saysNotFound(text) || /\b(unchanged|no (new )?price|left (it|as)|kept)\b/i.test(text))
  return reported ? pass('left SKU-9 alone and said why') : fail('SKU-9 left alone, but the answer does not say its price was not in the email')
}
