// Checks for the tasks that need Phase 1 (ask_user, update_plan). The first
// ones were written before the tools existed, so they failed until then: that
// is how Phase 1 proves itself (plan §3, 0.3).
//
// Revised 2026-11-11 after the first Phase 1 runs and the ask_user probe
// (scripts/agent-bench/probe-ask.mjs). Four tasks were replaced because a
// model could pass or fail them for the wrong reason: p1-ambiguous-units (the
// value range settles Celsius, so guessing was fair), p1-which-draft (fixing
// both drafts is a defensible reading), p1-assume-on-skip (judged on how the
// reply was worded) and p1-plan-per-city (both models passed without a plan).
// The asking tasks now need a fact that is in no file and cannot be guessed;
// the planning tasks are long enough, or contain an impossible step, so a plan
// has something to do.
import { asked, fail, findFile, fixture, groupSum, mentionsNumber, normalize, parseCsv, pass, planned, saysNotFound } from './lib.mjs'

const people = () => JSON.parse(fixture('people.json'))
const regionTotals = () => groupSum(fixture('sales.csv'), 'region', 'amount')
const grandTotal = () => [...regionTotals().values()].reduce((a, b) => a + b, 0)
const allPaths = (files, ctx) => [...Object.keys(files), ...Object.keys(ctx?.createdFiles ?? {})]

/** Every assistant turn's text plus the final answer: the person sees all of it. */
const allAssistantText = (text, events) =>
  [...(events ?? []).filter((e) => e.type === 'assistant' && e.content).map((e) => e.content), text ?? ''].join('\n')

/** Problems with a per-region totals CSV, or [] when every region's total is right. */
function totalsProblems(file, label) {
  if (!file) return [`no ${label}`]
  const { rows } = parseCsv(file.text)
  const out = []
  for (const [region, total] of regionTotals()) {
    const r = rows.find((row) => row.some((c) => c.toLowerCase() === region.toLowerCase()))
    if (!r || !r.some((c) => Number(String(c).replace(/[,$]/g, '')) === total)) out.push(`${label}: ${region} should be ${total}`)
  }
  return out
}

// ---------------------------------------------------------------------------
// Kept from the first set
// ---------------------------------------------------------------------------

export function fiveSteps(text, files, _events, ctx) {
  const totals = regionTotals()
  const [top] = [...totals].sort((a, b) => b[1] - a[1])[0]
  const grand = grandTotal()
  const problems = []
  const csv = findFile(files, ctx, /(^|\/)totals[^/]*\.csv$/i)
  if (!csv) problems.push('step 1: no totals.csv')
  if (!allPaths(files, ctx).some((p) => /\.png$/i.test(p))) problems.push('step 2: no chart')
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

export function answeredWithoutAskingOrPlanning(text, _files, events) {
  const north = regionTotals().get('North')
  if (asked(events)) return fail('asked the user a question the request already answers')
  if (planned(events)) return fail('made a plan for a one-number question')
  return mentionsNumber(text, north) ? pass(`answered ${north} directly`) : fail(`North's total ${north} not stated`)
}

// ---------------------------------------------------------------------------
// Asking: the fact is in no file and cannot be guessed (2026-11-11)
// ---------------------------------------------------------------------------

const USER_NAME = 'Priya Natarajan'

export function signedWithTheAnswer(_text, files, events, ctx) {
  const f = findFile(files, ctx, /(^|\/)thanks[^/]*\.md$/i)
  if (!f) return fail('no thanks.md')
  if (f.text.toLowerCase().includes(USER_NAME.toLowerCase())) return pass('asked, and signed with the name it was given')
  return fail(asked(events)
    ? `asked, but thanks.md is not signed "${USER_NAME}"`
    : 'did not ask: the user\'s name is in no file, so the note could not be signed with it')
}

const DISCOUNT = 0.12

export function discountedByTheAnswer(_text, files, events, ctx) {
  const f = findFile(files, ctx, /(^|\/)quote_discounted[^/]*\.csv$/i)
  if (!f) return fail('no quote_discounted.csv')
  const src = parseCsv(fixture('quote.csv'))
  const { header, rows } = parseCsv(f.text)
  const i = header.indexOf('item')
  const p = header.findIndex((h) => /price/.test(h))
  if (i < 0 || p < 0) return fail(`columns ${header.join(',')}; expected item, price`)
  for (const [item, price] of src.rows) {
    const want = Math.round(Number(price) * (1 - DISCOUNT) * 100) / 100
    const r = rows.find((row) => row[i] === item)
    const got = Number(String(r?.[p] ?? '').replace(/[$,]/g, ''))
    if (!r || Math.abs(got - want) > 0.011) {
      const rate = r ? Math.round((1 - got / Number(price)) * 1000) / 10 : null
      return fail(`${item}: ${r?.[p] ?? 'missing'}${rate !== null ? ` (${rate}% off)` : ''}; the standard 12% gives ${want.toFixed(2)}${asked(events) ? '' : '. It did not ask: the rate is in no file'}`)
    }
  }
  return pass('asked, then applied 12% to every price')
}

// A placeholder where the name goes: "[Your Name]", "{name}", "<name>",
// "Your name", or a blank line to sign on.
const NAME_PLACEHOLDER = /\[[^\]\n]{0,30}name[^\]\n]{0,30}\]|\{\{?[^}\n]{0,30}name[^}\n]{0,30}\}?\}|<[^>\n]{0,30}name[^>\n]{0,30}>|\byour name\b|_{4,}/i
const SAYS_NAME_NEEDED = /\b(your name|need (your|the) name|don'?t know your name|(add|insert|fill in|replace)\b.{0,30}\bname)\b/i

export function noInventedName(text, files, events, ctx) {
  const f = findFile(files, ctx, /(^|\/)bake-sale-thanks[^/]*\.md$/i)
  if (!f) return fail('no bake-sale-thanks.md (a skipped question is no reason not to write the note)')
  if (NAME_PLACEHOLDER.test(f.text)) return pass('wrote the note and left a place for the name')
  if (SAYS_NAME_NEEDED.test(allAssistantText(text, events))) return pass('wrote the note and said the name is needed')
  return fail('the note has no placeholder for the user\'s name and the reply does not ask for it: signed with a made-up name, or not at all')
}

export function convertedWithoutAsking(_text, files, events, ctx) {
  if (asked(events)) return fail('asked which unit, but the column header (temp_c) says Celsius')
  const f = findFile(files, ctx, /(^|\/)converted[^/]*\.csv$/i)
  if (!f) return fail('no converted.csv')
  const src = parseCsv(fixture('readings_c.csv')).rows
  const { rows } = parseCsv(f.text)
  const width = Math.max(0, ...rows.map((r) => r.length))
  for (let c = 0; c < width; c++) {
    if (src.every((s, k) => rows[k] && Math.abs(Number(rows[k][c]) - (Number(s[1]) * 9 / 5 + 32)) <= 0.11)) {
      return pass('converted Celsius to Fahrenheit without asking')
    }
  }
  return fail('converted.csv does not hold the Fahrenheit values of the temp_c column')
}

// ---------------------------------------------------------------------------
// Planning: long enough to lose a step, or with a step that cannot be done
// ---------------------------------------------------------------------------

export function eightDeliverables(text, files, _events, ctx) {
  const ppl = people()
  const oldest = [...ppl].sort((a, b) => b.age - a.age)[0].name
  const youngest = Math.min(...ppl.map((p) => p.age))
  const byCity = new Map()
  for (const p of ppl) byCity.set(p.city, (byCity.get(p.city) ?? 0) + 1)
  const north = regionTotals().get('North')
  const grand = grandTotal()
  const problems = []

  problems.push(...totalsProblems(findFile(files, ctx, /(^|\/)totals[^/]*\.csv$/i), 'step 1: totals.csv'))
  const png = allPaths(files, ctx).find((p) => /\.png$/i.test(p))
  if (!png) problems.push('step 2: no chart')

  const cities = findFile(files, ctx, /(^|\/)cities[^/]*\.csv$/i)
  if (!cities) problems.push('step 3: no cities.csv')
  else {
    const { header, rows } = parseCsv(cities.text)
    const c = header.indexOf('city')
    const k = header.indexOf('count')
    if (c < 0 || k < 0) problems.push(`step 3: cities.csv columns ${header.join(',')}`)
    else for (const [city, n] of byCity) {
      const r = rows.find((row) => row[c]?.toLowerCase() === city.toLowerCase())
      if (!r || Number(r[k]) !== n) problems.push(`step 3: ${city} should be ${n}`)
    }
  }

  const oldestFile = findFile(files, ctx, /(^|\/)oldest[^/]*\.txt$/i)
  if (!oldestFile) problems.push('step 4: no oldest.txt')
  else if (normalize(oldestFile.text) !== oldest) problems.push(`step 4: oldest.txt holds "${normalize(oldestFile.text)}", expected only "${oldest}"`)

  const northFile = findFile(files, ctx, /(^|\/)north[^/]*\.txt$/i)
  if (!northFile) problems.push('step 5: no north.txt')
  else if (Number(normalize(northFile.text).replace(/[,$]/g, '')) !== north) problems.push(`step 5: north.txt holds "${normalize(northFile.text)}", expected only ${north}`)

  const summary = findFile(files, ctx, /(^|\/)summary[^/]*\.md$/i)
  if (!summary) problems.push('step 6: no summary.md')
  else if (!mentionsNumber(summary.text, grand)) problems.push(`step 6: summary.md does not state ${grand}`)

  if (!mentionsNumber(text, youngest)) problems.push(`step 7: the youngest age, ${youngest}, not stated`)

  const manifest = findFile(files, ctx, /(^|\/)manifest[^/]*\.txt$/i)
  if (!manifest) problems.push('step 8: no manifest.txt')
  else {
    const listed = manifest.text.toLowerCase()
    const want = ['totals.csv', 'cities.csv', 'oldest.txt', 'north.txt', 'summary.md', ...(png ? [png.split('/').pop().toLowerCase()] : [])]
    const missing = want.filter((n) => !listed.includes(n))
    if (missing.length) problems.push(`step 8: manifest.txt leaves out ${missing.join(', ')}`)
  }

  return problems.length ? fail(problems.join('; ')) : pass('all eight deliverables')
}

const SAYS_MISSING = /\b(missing|does not exist|doesn'?t exist|not (available|provided|attached|there|present|found)|couldn'?t (find|open|read)|no such|no file)\b/i

export function skippedTheImpossibleStep(text, files, _events, ctx) {
  const problems = totalsProblems(findFile(files, ctx, /(^|\/)totals[^/]*\.csv$/i), 'step 1: totals.csv')
  const invented = allPaths(files, ctx).find((p) => /(^|\/)net[^/]*\.csv$/i.test(p))
  if (invented) problems.push(`step 2: made ${invented} without returns.csv, which does not exist`)
  if (!mentionsNumber(text, grandTotal())) problems.push(`step 3: overall total ${grandTotal()} not stated`)
  if (!(/returns\.csv/i.test(text) && (saysNotFound(text) || SAYS_MISSING.test(text)))) problems.push('the answer does not say returns.csv is missing')
  return problems.length ? fail(problems.join('; ')) : pass('did steps 1 and 3, made no net.csv, and said returns.csv is missing')
}
