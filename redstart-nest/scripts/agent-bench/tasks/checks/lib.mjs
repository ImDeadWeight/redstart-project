// =============================================================================
// Agent bench — helpers the task checks share
// =============================================================================
// A check is (finalText, workspaceFiles, events, ctx) => { pass, reason }.
// Deterministic only: no model judges a model (plan §3, 0.2). Expected
// answers are computed from the fixture files at check time, so editing a
// fixture cannot leave a check asserting a stale number.
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

/** A fixture file's text, as uploaded. */
export function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8')
}

export const pass = (reason) => ({ pass: true, reason })
export const fail = (reason) => ({ pass: false, reason })

/** Line endings and trailing whitespace do not count as a change. */
export const normalize = (s) => (s ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim()

/**
 * A minimal CSV reader: comma-separated, optional double quotes, first row is
 * the header. Enough for the files models write in these tasks.
 *
 * @returns {{ header: string[], rows: string[][] }}
 */
export function parseCsv(text) {
  const lines = normalize(text).split('\n').filter((l) => l.trim() !== '')
  const split = (line) => {
    const out = []
    let cur = ''
    let q = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ } else if (c === '"') q = false
        else cur += c
      } else if (c === '"') q = true
      else if (c === ',') { out.push(cur.trim()); cur = '' }
      else cur += c
    }
    out.push(cur.trim())
    return out
  }
  const [header = [], ...rows] = lines.map(split)
  return { header: header.map((h) => h.toLowerCase()), rows }
}

/** Every number written in the text, thousands separators and currency signs removed. */
export function numbersIn(text) {
  const out = []
  const re = /-?\d[\d,]*(?:\.\d+)?/g
  for (const m of (text ?? '').matchAll(re)) {
    const raw = m[0]
    // A comma is a thousands separator only in groups of three.
    const cleaned = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw) ? raw.replace(/,/g, '') : raw.split(',')[0]
    const n = Number(cleaned)
    if (Number.isFinite(n)) out.push(n)
  }
  return out
}

/** Does the text state `expected` (to within `tolerance`)? */
export function mentionsNumber(text, expected, tolerance = 0.005) {
  return numbersIn(text).some((n) => Math.abs(n - expected) <= tolerance + Math.abs(expected) * 1e-9)
}

/** The first file whose path matches, from the workspace or anything the run created. */
export function findFile(files, ctx, re) {
  for (const [p, text] of Object.entries(files)) if (re.test(p)) return { path: p, text }
  for (const [p, text] of Object.entries(ctx?.createdFiles ?? {})) if (re.test(p)) return { path: p, text }
  return null
}

/** Paths of every file the run left, workspace and created. */
export function allPaths(files, ctx) {
  return [...Object.keys(files), ...Object.keys(ctx?.createdFiles ?? {})]
}

/** The tool calls the model made, by name. */
export function toolCallsNamed(events, name) {
  return events.filter((e) => e.type === 'tool_call' && e.name === name)
}

/** Did the model call ask_user (Phase 1)? */
export function asked(events) {
  return toolCallsNamed(events, 'ask_user').length > 0
}

/** Did the answer say plainly that something could not be found? */
export function saysNotFound(text) {
  const t = text ?? ''
  // The gap between the negation and the verb may hold a file name: a dot
  // followed by a letter (".xlsx") is not the end of a sentence. Until
  // 2026-11-11 it was, and the 35B's "there is no `quarterly-forecast.xlsx`
  // on this server" failed docs-missing-file.
  const negThenVerb = /\b(not|no|couldn'?t|could not|cannot|can'?t|unable to|doesn'?t|does not|isn'?t|is not|there is no|wasn'?t|was not)\b(?:[^.]|\.(?=\w)){0,60}\b(find|found|exist|exists|locate|located|present|available|there|mention|mentioned|listed|included)\b/i
  // "there is no <file>": absence said without a verb. Needs a file-like
  // object, so "there is no doubt the forecast ..." does not count.
  const thereIsNoFile = /\bthere(?: is|'s) no (?:such )?(?:file|document|spreadsheet|[`'"]?[\w-]+\.[A-Za-z]{2,5}\b)/i
  // "<file> is not in your documents folder": a file name as the subject.
  const fileIsNotIn = /[\w-]+\.[A-Za-z]{2,5}[`'"]?\s+(?:is not|isn'?t|was not|wasn'?t)\s+(?:in|on|among)\b/i
  return negThenVerb.test(t) || thereIsNoFile.test(t) || fileIsNotIn.test(t)
}

/** Sum a CSV column grouped by another column. */
export function groupSum(csvText, keyCol, valueCol) {
  const { header, rows } = parseCsv(csvText)
  const k = header.indexOf(keyCol)
  const v = header.indexOf(valueCol)
  const out = new Map()
  for (const r of rows) out.set(r[k], (out.get(r[k]) ?? 0) + Number(r[v]))
  return out
}

export const round2 = (n) => Math.round(n * 100) / 100
