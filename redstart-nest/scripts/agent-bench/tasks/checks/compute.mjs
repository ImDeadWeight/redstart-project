// Checks for the compute and data group.
import { allPaths, fail, findFile, fixture, groupSum, mentionsNumber, numbersIn, parseCsv, pass, round2 } from './lib.mjs'

export function arithmetic(text) {
  const expected = 48271 * 9973 - 123456
  return mentionsNumber(text, expected) ? pass(`states ${expected}`) : fail(`expected ${expected}, saw ${numbersIn(text).join(', ') || 'no numbers'}`)
}

const DAY_MS = 86400000
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function dates(text) {
  const days = (Date.UTC(2026, 10, 10) - Date.UTC(2024, 1, 14)) / DAY_MS
  const weekday = WEEKDAYS[new Date(Date.UTC(2031, 6, 4)).getUTCDay()]
  const okDays = mentionsNumber(text, days)
  const okWeekday = new RegExp(`\\b${weekday}\\b`, 'i').test(text)
  if (okDays && okWeekday) return pass(`${days} days, ${weekday}`)
  return fail(`expected ${days} days (${okDays ? 'ok' : 'missing'}) and ${weekday} (${okWeekday ? 'ok' : 'missing'})`)
}

export function regionTotals(text) {
  const totals = groupSum(fixture('sales.csv'), 'region', 'amount')
  const missing = [...totals].filter(([, v]) => !mentionsNumber(text, v)).map(([k, v]) => `${k} ${v}`)
  const [top] = [...totals].sort((a, b) => b[1] - a[1])[0]
  const namesTop = new RegExp(`\\b${top}\\b[^.]{0,80}\\b(highest|largest|most|top|biggest)|\\b(highest|largest|most|top|biggest)\\b[^.]{0,80}\\b${top}\\b`, 'i').test(text)
  if (missing.length === 0 && namesTop) return pass(`all four totals and ${top} as highest`)
  return fail(`${missing.length ? `missing totals: ${missing.join('; ')}` : 'totals ok'}; ${namesTop ? '' : `does not name ${top} as highest`}`)
}

export function chartSaved(_text, files, _events, ctx) {
  const png = allPaths(files, ctx).filter((p) => /\.png$/i.test(p))
  return png.length > 0 ? pass(`chart: ${png.join(', ')}`) : fail('no .png in the workspace or created files')
}

export function topCustomer(text) {
  const names = new Map(parseCsv(fixture('customers.csv')).rows.map(([id, name]) => [id, name]))
  const byCustomer = groupSum(fixture('orders.csv'), 'customer_id', 'amount')
  const [id, total] = [...byCustomer].sort((a, b) => b[1] - a[1])[0]
  const name = names.get(id)
  const okName = text.includes(name)
  const okTotal = mentionsNumber(text, round2(total), 0.011)
  if (okName && okTotal) return pass(`${name}, ${round2(total)}`)
  return fail(`expected ${name} (${okName ? 'ok' : 'missing'}) with ${round2(total)} (${okTotal ? 'ok' : 'missing'})`)
}

export function peopleCsv(_text, files, _events, ctx) {
  const f = findFile(files, ctx, /(^|\/)people[^/]*\.csv$/i)
  if (!f) return fail('no people.csv')
  const { header, rows } = parseCsv(f.text)
  if (header.join(',') !== 'name,age,city') return fail(`header is ${header.join(',')}, expected name,age,city`)
  const want = JSON.parse(fixture('people.json'))
  if (rows.length !== want.length) return fail(`${rows.length} rows, expected ${want.length}`)
  for (let i = 0; i < want.length; i++) {
    const [name, age, city] = rows[i]
    if (name !== want[i].name || Number(age) !== want[i].age || city !== want[i].city) {
      return fail(`row ${i + 1} is ${rows[i].join(',')}, expected ${want[i].name},${want[i].age},${want[i].city}`)
    }
  }
  return pass(`${f.path}: ${rows.length} rows, in order`)
}
