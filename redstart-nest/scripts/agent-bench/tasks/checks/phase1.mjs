// Checks for the tasks that need Phase 1 (ask_user, update_plan). Written
// before the tools exist, so they fail until then: that is how Phase 1 proves
// itself (plan §3, 0.3).
import { asked, fail, findFile, fixture, groupSum, mentionsNumber, normalize, parseCsv, pass, planned, saysNotFound } from './lib.mjs'

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

// The prices the email does give (fixtures/supplier-email.txt).
const EMAIL_PRICES = { 'SKU-2': 6.75, 'SKU-3': 8.4, 'SKU-7': 13.2 }

export function stoppedAtUnknownPrice(text, files) {
  const inv = files['inventory.csv']
  if (!inv) return fail('inventory.csv is gone')
  const { rows } = parseCsv(inv)
  const row = rows.find((r) => r[0] === 'SKU-9')
  if (!row) return fail('SKU-9 was removed from inventory.csv')
  if (Math.abs(Number(row[row.length - 1]) - 22) > 0.001) return fail(`SKU-9's price was changed to ${row[row.length - 1]}, a guess: the email gives none`)
  // Until 2026-11-11 this was never checked, so a run that wrote its update
  // to another folder (the 35B's write_file went to the File System root)
  // left the workspace file untouched and could pass on wording alone.
  const notUpdated = Object.entries(EMAIL_PRICES).filter(([sku, price]) => {
    const r = rows.find((x) => x[0] === sku)
    return !r || Math.abs(Number(r[r.length - 1]) - price) > 0.001
  })
  if (notUpdated.length) return fail(`inventory.csv in the workspace does not have the email's new price for ${notUpdated.map(([s]) => s).join(', ')}`)
  // "not updated" / "not changed" added 2026-11-11: the 35B's correct "SKU-9
  // (Rear light) was **not** updated — the supplier ... would write
  // separately" failed on wording.
  const reported = /SKU-9/i.test(text) && (saysNotFound(text) || /\b(unchanged|no (new )?price|left (it|as)|kept|not\W{0,4}(been\W+)?(updated|changed)|didn'?t (update|change))\b/i.test(text))
  return reported ? pass('left SKU-9 alone and said why') : fail('SKU-9 left alone, but the answer does not say its price was not in the email')
}

// ---------------------------------------------------------------------------
// Added 2026-11-11, once ask_user and update_plan existed: what the first four
// did not cover. An answer that changes the work, a choice among several, a
// question the user skips, a second many-deliverable task, and a guard that
// the tools are not used where they add nothing.
// ---------------------------------------------------------------------------

const people = () => JSON.parse(fixture('people.json'))

export function sortedAsAnswered(_text, files, events, ctx) {
  if (!asked(events)) return fail('did not ask which order (ask_user)')
  const f = findFile(files, ctx, /(^|\/)sorted[^/]*\.csv$/i)
  if (!f) return fail('no sorted.csv')
  const { header, rows } = parseCsv(f.text)
  const n = header.indexOf('name')
  if (n < 0) return fail(`no name column in ${header.join(',')}`)
  const want = [...people()].sort((a, b) => b.age - a.age).map((p) => p.name)
  const got = rows.map((r) => r[n])
  if (JSON.stringify(got) !== JSON.stringify(want)) return fail(`order ${got.join(', ')}; the user asked for age, oldest first: ${want.join(', ')}`)
  return pass('asked, then sorted by age, oldest first')
}

const NOTICE_DAYS = { kestrel: 60, osprey: 30, alder: 90 }

export function onlyTheChosenVendors(_text, files, events, ctx) {
  if (!asked(events)) return fail('did not ask which vendors (ask_user)')
  const f = findFile(files, ctx, /(^|\/)notice[^/]*\.csv$/i)
  if (!f) return fail('no notice.csv')
  const { header, rows } = parseCsv(f.text)
  const v = header.findIndex((h) => /vendor/.test(h))
  const d = header.findIndex((h) => /notice|days/.test(h))
  if (v < 0 || d < 0) return fail(`columns ${header.join(',')}; expected vendor, notice_days`)
  const rowFor = (name) => rows.find((r) => new RegExp(name, 'i').test(r[v]))
  if (rowFor('alder')) return fail('Alder is in the table; the user chose Kestrel and Osprey only')
  for (const name of ['kestrel', 'osprey']) {
    const r = rowFor(name)
    if (!r) return fail(`${name} is missing`)
    if (Number(String(r[d]).replace(/[^\d.]/g, '')) !== NOTICE_DAYS[name]) return fail(`${name}: ${r[d]} days, the contract says ${NOTICE_DAYS[name]}`)
  }
  return pass('asked, then Kestrel (60) and Osprey (30) only')
}

/** Every value of some column matches `convert` of the source temperatures. */
function convertedColumn(rows, src, convert) {
  const width = Math.max(0, ...rows.map((r) => r.length))
  for (let c = 0; c < width; c++) {
    if (src.every((s, i) => rows[i] && Math.abs(Number(rows[i][c]) - convert(Number(s[1]))) <= 0.11)) return true
  }
  return false
}

// Every assistant turn's text, not only the final answer: the person sees the
// whole reply. The 35B (T22-14-31) gave its reasoning ("consistent with
// Celsius ... so the data is in Celsius") a turn before its final answer.
const allAssistantText = (text, events) =>
  [...(events ?? []).filter((e) => e.type === 'assistant' && e.content).map((e) => e.content), text ?? ''].join('\n')

export function convertedWithStatedAssumption(text, files, events, ctx) {
  const f = findFile(files, ctx, /(^|\/)converted[^/]*\.csv$/i)
  if (!f) return fail('no converted.csv (a skipped question is no reason to stop)')
  const src = parseCsv(fixture('readings.csv')).rows
  const { rows } = parseCsv(f.text)
  const toF = convertedColumn(rows, src, (c) => c * 9 / 5 + 32)
  const toC = convertedColumn(rows, src, (fahr) => (fahr - 32) * 5 / 9)
  if (!toF && !toC) return fail('converted.csv holds neither Celsius-to-Fahrenheit nor Fahrenheit-to-Celsius values')
  const t = allAssistantText(text, events)
  // Saying the unit is not enough ("converted from Celsius to Fahrenheit"
  // states a guess as fact): it must say it was a judgement, or why.
  const statesAssumption =
    /\b(assum\w*|presum\w*|treat(ed|ing)?|took|taking|interpret\w*|guess\w*|consistent with|likely|probably|appear\w*|look(s)? like|suggest\w*|plausible|implausible)\b/i.test(t) &&
    /celsius|fahrenheit|°\s?[cf]\b/i.test(t)
  if (!statesAssumption) return fail('converted, but did not say which unit it assumed the readings were in')
  return pass(`converted (${toF ? 'as Celsius' : 'as Fahrenheit'}) and said what it assumed`)
}

export function perCityFiles(text, files, _events, ctx) {
  const byCity = new Map()
  for (const p of people()) byCity.set(p.city, [...(byCity.get(p.city) ?? []), p.name])
  const ages = people().map((p) => p.age)
  const avg = Math.round((ages.reduce((a, b) => a + b, 0) / ages.length) * 10) / 10
  const problems = []
  for (const [city, names] of byCity) {
    const f = findFile(files, ctx, new RegExp(`(^|/)${city}\\.txt$`, 'i'))
    if (!f) { problems.push(`no ${city}.txt`); continue }
    const got = normalize(f.text).split('\n').map((l) => l.replace(/^[-*\d.)\s]+/, '').trim()).filter(Boolean).sort()
    if (JSON.stringify(got) !== JSON.stringify([...names].sort())) problems.push(`${city}.txt lists ${got.join(', ') || 'nothing'}, expected ${names.join(', ')}`)
  }
  const csv = findFile(files, ctx, /(^|\/)cities[^/]*\.csv$/i)
  if (!csv) problems.push('no cities.csv')
  else {
    const { header, rows } = parseCsv(csv.text)
    const c = header.indexOf('city')
    const k = header.indexOf('count')
    if (c < 0 || k < 0) problems.push(`cities.csv columns ${header.join(',')}`)
    else for (const [city, names] of byCity) {
      const r = rows.find((row) => row[c]?.toLowerCase() === city.toLowerCase())
      if (!r || Number(r[k]) !== names.length) problems.push(`cities.csv: ${city} should be ${names.length}`)
    }
  }
  if (!mentionsNumber(text, avg, 0.05)) problems.push(`average age ${avg} not stated`)
  return problems.length ? fail(problems.join('; ')) : pass('four city files, cities.csv, and the average')
}

export function answeredWithoutAskingOrPlanning(text, _files, events) {
  const north = groupSum(fixture('sales.csv'), 'region', 'amount').get('North')
  if (asked(events)) return fail('asked the user a question the request already answers')
  if (planned(events)) return fail('made a plan for a one-number question')
  return mentionsNumber(text, north) ? pass(`answered ${north} directly`) : fail(`North's total ${north} not stated`)
}
