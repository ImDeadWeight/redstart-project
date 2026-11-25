/**
 * agent-core/replace-match — old/new-string replacement that a small model
 * can recover from.
 *
 * Moved here from Yellowscript's src/tools/replace-match.ts (artifacts plan
 * D3) so both agents get the same tolerance and the same "closest text"
 * error: Yellowscript's ys_replace, and Nest's artifact_edit.
 *
 * In the redstart-website chats (Qwen 3.6 35B-A3B, 2026-11-25) 44 of 173
 * ys_replace calls failed, nearly all on the indentation: the model read the
 * file, then wrote the first line one or two tabs short, and the error said
 * only "not found". So it sent the same call again.
 *
 * Three pieces, all pure:
 *
 *   looseReplace   old_string matches exactly one run of whole lines once
 *                  each line's leading and trailing whitespace is set aside:
 *                  the edit is made there, and new_string is re-indented the
 *                  way old_string was off (its first line on its own, the
 *                  rest by one consistent shift). When the shift is not
 *                  consistent there is no safe guess, and it is not made.
 *
 *   closestText    otherwise, the window of the file most like old_string,
 *                  where they first differ, and the file's own text there,
 *                  so the next call can copy it without reading again.
 *
 *   replaceInText  the whole decision: exact match (once, or every one with
 *                  replaceAll), then looseReplace, then a not-found error
 *                  built from closestText. What a host does with the result
 *                  (a diff review, a draft write) is its own.
 *
 * Pure: no I/O. Pinned by redstart-nest/scripts/test-replace-match.mjs.
 */

/** @param {string} line @returns {string} a line's leading whitespace */
function indentOf(line) {
  return /** @type {RegExpExecArray} */ (/^[ \t]*/.exec(line))[0]
}

/** Lines of `text` without a final empty one; \r\n read as \n. @param {string} text */
function linesOf(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()
  return lines
}

/** @param {string} line */
const strip = (line) => line.replace(/\r$/, '').trim()

/**
 * Start lines (0-based) where `wanted` matches whole file lines, whitespace aside.
 * @param {readonly string[]} fileLines @param {readonly string[]} wanted
 */
function looseStarts(fileLines, wanted) {
  /** @type {number[]} */
  const starts = []
  const target = wanted.map(strip)
  for (let s = 0; s + target.length <= fileLines.length; s++) {
    let ok = true
    for (let i = 0; i < target.length && ok; i++) ok = strip(fileLines[s + i]) === target[i]
    if (ok) starts.push(s)
  }
  return starts
}

/** @typedef {{ add: string } | { remove: string }} Shift  how old_string's indentation becomes the file's */

/** @param {string} from @param {string} to @returns {Shift | null} */
function shiftBetween(from, to) {
  if (to.endsWith(from)) return { add: to.slice(0, to.length - from.length) }
  if (from.endsWith(to)) return { remove: from.slice(0, from.length - to.length) }
  return null
}

/** @param {Shift} a @param {Shift} b */
const sameShift = (a, b) =>
  'add' in a ? 'add' in b && a.add === b.add : 'remove' in b && a.remove === b.remove

/** @param {string} line @param {Shift} shift */
function applyShift(line, shift) {
  if (line.trim() === '') return line
  if ('add' in shift) return shift.add + line
  return line.startsWith(shift.remove) ? line.slice(shift.remove.length) : line
}

/**
 * The edit, when old_string matches exactly one run of whole lines with its
 * indentation set aside and the indentation can be carried over to
 * new_string; otherwise null. Only called after the exact match failed.
 *
 * @param {string} file @param {string} oldString @param {string} newString
 * @returns {{ after: string, line: number } | null}  `line` is the 1-based first line replaced
 */
export function looseReplace(file, oldString, newString) {
  const wanted = linesOf(oldString)
  if (wanted.every((l) => l.trim() === '')) return null
  const fileLines = file.split('\n')
  const starts = looseStarts(fileLines, wanted)
  if (starts.length !== 1) return null
  const s = starts[0]
  const region = fileLines.slice(s, s + wanted.length).map((l) => l.replace(/\r$/, ''))

  // The first line on its own: that is where the model is most often off.
  const first = { from: indentOf(wanted[0]), to: indentOf(region[0]) }
  // The rest by one shift, the same on every non-blank line.
  /** @type {Shift | null} */
  let shift = null
  for (let i = 1; i < wanted.length; i++) {
    if (wanted[i].trim() === '') continue
    const here = shiftBetween(indentOf(wanted[i]), indentOf(region[i]))
    if (!here || (shift && !sameShift(shift, here))) return null
    shift ??= here
  }
  // One line: its own shift is the shift.
  shift ??= shiftBetween(first.from, first.to)
  if (!shift) return null
  const finalShift = shift

  const replacement = linesOf(newString).map((line, i) =>
    i === 0 && indentOf(line) === first.from && line.trim() !== '' ? first.to + line.slice(first.from.length) : applyShift(line, finalShift),
  )
  const crlf = file.includes('\r\n')
  const lastHadCr = fileLines[s + wanted.length - 1].endsWith('\r')
  const body =
    newString === ''
      ? []
      : [replacement.join(crlf ? '\r\n' : '\n') + (lastHadCr ? '\r' : '')]
  const after = [...fileLines.slice(0, s), ...body, ...fileLines.slice(s + wanted.length)].join('\n')
  return { after, line: s + 1 }
}

/**
 * @typedef {object} ClosestText
 * @property {number} startLine  1-based, inclusive
 * @property {number} endLine
 * @property {number} matched    how many of old_string's lines are there, whitespace aside
 * @property {number} total
 * @property {{ wantedLine: number, wanted: string, fileLine: number, actual: string } | null} firstDiff
 * @property {string} text       the file's text over those lines, as it is
 */

/** The most lines shown back, and the most characters. */
const SHOW_LINES = 40
const SHOW_CHARS = 2500
/** Past this many line comparisons the search is not worth it. */
const MAX_WORK = 2_000_000

/**
 * The window most like old_string, or null when not one line of it is there.
 * @param {string} file @param {string} oldString @returns {ClosestText | null}
 */
export function closestText(file, oldString) {
  const wanted = linesOf(oldString)
  const fileLines = file.split('\n').map((l) => l.replace(/\r$/, ''))
  if (fileLines.length > 1 && fileLines.at(-1) === '') fileLines.pop()
  const n = wanted.length
  if (n === 0 || fileLines.length * n > MAX_WORK) return null
  const target = wanted.map(strip)
  const stripped = fileLines.map(strip)

  let best = { start: -1, score: 0 }
  for (let s = 0; s + n <= fileLines.length; s++) {
    let score = 0
    for (let i = 0; i < n; i++) if (target[i] !== '' && stripped[s + i] === target[i]) score++
    if (score > best.score) best = { start: s, score }
  }
  // A shorter file than old_string, or nothing in common.
  if (best.start === -1) return null

  const s = best.start
  /** @type {ClosestText['firstDiff']} */
  let firstDiff = null
  for (let i = 0; i < n; i++) {
    if (fileLines[s + i] !== wanted[i]) {
      firstDiff = { wantedLine: i + 1, wanted: wanted[i], fileLine: s + i + 1, actual: fileLines[s + i] }
      break
    }
  }
  const shown = fileLines.slice(s, s + Math.min(n, SHOW_LINES)).join('\n')
  return {
    startLine: s + 1,
    endLine: s + n,
    matched: best.score,
    total: target.filter((t) => t !== '').length,
    firstDiff,
    text: shown.length > SHOW_CHARS ? `${shown.slice(0, SHOW_CHARS)}\n…` : shown,
  }
}

/** A whitespace-visible copy of one line for the error: tabs as \t. @param {string} line */
export function showLine(line) {
  const indent = indentOf(line)
  return JSON.stringify(indent + line.slice(indent.length).trimEnd()).slice(1, -1)
}

// ---------------------------------------------------------------------------
// The whole decision
// ---------------------------------------------------------------------------

/** Every start offset of `needle` in `haystack`, non-overlapping. @param {string} haystack @param {string} needle */
function occurrences(haystack, needle) {
  /** @type {number[]} */
  const found = []
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) found.push(i)
  return found
}

/** The 1-based line a character offset falls on. @param {string} text @param {number} offset */
function lineOf(text, offset) {
  let line = 1
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/**
 * The text as the file has it, when `wanted` differs only in line endings.
 * Models write \n; a Windows checkout often holds \r\n.
 * @param {string} file @param {string} wanted
 */
export function matchLineEndings(file, wanted) {
  if (!file.includes('\r\n') || wanted.includes('\r\n')) return wanted
  return wanted.replace(/\n/g, '\r\n')
}

/** What replaceInText says when a loose match was made. */
export const LOOSE_NOTE = "old_string matched once with its indentation set aside, so the file's indentation was kept and new_string was indented to fit. Copy indentation exactly next time."

/**
 * Why old_string is not there, and the file's own text where it comes
 * closest, so the next call can copy from it without another read.
 *
 * @param {string} label  how the file is named to the model
 * @param {string} file
 * @param {string} oldString
 * @param {'unread' | 'current' | 'changed'} [seen]  what the host knows of the model's last read
 */
export function notFoundText(label, file, oldString, seen = 'current') {
  const lines = [`old_string was not found in ${label}. It must match the file exactly, including indentation and blank lines.`]
  if (seen === 'changed') lines.push('The file has changed since you last read it (your own earlier edits are in it), so text from that read may be out of date.')
  else if (seen === 'unread') lines.push('You have not read this file in this run; old_string must be copied from the file, not recalled.')
  const near = closestText(file, oldString)
  if (!near || near.matched === 0) {
    lines.push('None of its lines are in the file. Read the file again and copy the text from it.')
    return lines.join('\n')
  }
  const range = near.startLine === near.endLine ? `line ${near.startLine}` : `lines ${near.startLine}-${near.endLine}`
  lines.push(`Closest: ${range}, where ${near.matched} of its ${near.total} lines match with whitespace aside.`)
  if (near.firstDiff) {
    lines.push(
      `First difference: your line ${near.firstDiff.wantedLine} is "${showLine(near.firstDiff.wanted)}"; ` +
        `the file's line ${near.firstDiff.fileLine} is "${showLine(near.firstDiff.actual)}" (\\t is a tab).`,
    )
  }
  lines.push(`The file's ${range}, exactly as it has them:`, '---', near.text, '---')
  return lines.join('\n')
}

/**
 * @typedef {{ ok: true, after: string, at: string, note?: string }
 *         | { ok: false, error: string }} ReplaceResult
 *   `at` says where: "line 12", or "3 occurrences" with replaceAll
 */

/**
 * Replace old_string with new_string in `file`, the way ys_replace and
 * artifact_edit both do: exactly once (or every occurrence with replaceAll);
 * failing that, once with the indentation set aside; failing that, an error
 * that shows the closest text.
 *
 * @param {string} file
 * @param {string} oldRaw
 * @param {string} newRaw
 * @param {{ replaceAll?: boolean, label?: string, seen?: 'unread' | 'current' | 'changed' }} [opts]
 * @returns {ReplaceResult}
 */
export function replaceInText(file, oldRaw, newRaw, { replaceAll = false, label = 'the file', seen = 'current' } = {}) {
  if (oldRaw === '') return { ok: false, error: 'old_string must not be empty.' }
  const oldString = matchLineEndings(file, oldRaw)
  const newString = matchLineEndings(file, newRaw)
  if (oldString === newString) return { ok: false, error: 'old_string and new_string are the same; there is nothing to change.' }

  const found = occurrences(file, oldString)
  if (found.length === 0) {
    const loose = replaceAll ? null : looseReplace(file, oldRaw, newRaw)
    if (loose) return { ok: true, after: loose.after, at: `line ${loose.line}`, note: LOOSE_NOTE }
    return { ok: false, error: notFoundText(label, file, oldRaw, seen) }
  }
  if (found.length > 1 && !replaceAll) {
    const lines = found.slice(0, 5).map((i) => lineOf(file, i)).join(', ')
    return {
      ok: false,
      error:
        `old_string appears ${found.length} times in ${label} (lines ${lines}${found.length > 5 ? ', …' : ''}). ` +
        'Include more surrounding text so it matches once, or set replace_all to true.',
    }
  }
  const after = replaceAll ? file.split(oldString).join(newString) : file.replace(oldString, () => newString)
  const at = replaceAll ? `${found.length} occurrence${found.length === 1 ? '' : 's'}` : `line ${lineOf(file, found[0])}`
  return { ok: true, after, at }
}
