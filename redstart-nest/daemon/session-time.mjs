'use strict'

// =============================================================================
// Redstart Nest — the user's local date, for the session block
// =============================================================================
// The prompt used to state `now.toISOString().slice(0, 10)`: the UTC date. For
// a user west of Greenwich in the evening that is tomorrow, and the model
// answers "what's the date?" wrongly with full confidence.
//
// chat-ui now sends the browser's IANA zone (X-Redstart-Timezone). This module
// validates it and formats the date in it. Pure: no I/O, `now` is passed in.
//
// DATE, NOT TIME, ON PURPOSE. The composed prompt is the prefix of every
// request, and llama-server reuses its KV cache only while that prefix is
// unchanged. A clock to the minute there would make it re-process the whole
// conversation on nearly every turn. A date changes once a day, the same
// cadence the prompt had before.
// =============================================================================

// IANA names are letters, digits and `/ _ + -` (Etc/GMT+5, America/Port-au-Prince).
// Checked BEFORE Intl sees the value: the result is interpolated into the
// system prompt, and a header must not be a way to write prose there.
const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/

/**
 * A client-supplied zone, or null if it is not one this runtime can format.
 *
 * Validated by constructing a formatter, not against
 * Intl.supportedValuesOf('timeZone'): that list holds canonical names only,
 * and browsers report aliases (Asia/Calcutta), which would refuse real users.
 */
export function validateTimeZone(value) {
  if (typeof value !== 'string' || !ZONE_SHAPE.test(value)) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return value
  } catch {
    return null
  }
}

/** The zone this process runs in, e.g. 'America/Chicago'. Never throws. */
export function serverTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/**
 * The session block's date sentence.
 *
 *   valid client zone → "Current date: Thursday 2026-11-05 (America/Chicago, the user's timezone)."
 *   absent / invalid  → "Current date: Thursday 2026-11-05 (America/Chicago, the server's timezone; the user's is unknown)."
 *
 * The fallback is LABELLED: a server in another zone than its user would
 * otherwise state a date with the same confidence as a known one.
 */
export function sessionDateLine(now, clientZone) {
  const zone = validateTimeZone(clientZone)
  const effective = zone ?? serverTimeZone()
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: effective,
      weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now).map(p => [p.type, p.value]),
  )
  const date = `${parts.weekday} ${parts.year}-${parts.month}-${parts.day}`
  const label = zone ? "the user's timezone" : "the server's timezone; the user's is unknown"
  return `Current date: ${date} (${effective}, ${label}).`
}
