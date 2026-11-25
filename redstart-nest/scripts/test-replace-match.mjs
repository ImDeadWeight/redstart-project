// =============================================================================
// The shared old/new-string matcher (artifacts plan D3)
// =============================================================================
// shared/agent-core/replace-match.mjs, moved from Yellowscript's
// src/tools/replace-match.ts with its cases. ys_replace and artifact_edit both
// use it, so both agents get the same tolerance and the same errors:
//
//   - an exact match once is made; twice is refused unless replace_all
//   - a first line indented wrong is matched; the file keeps its indentation
//   - a block shifted by one tab throughout is shifted back, new lines with it
//   - indentation off by different amounts is not guessed at
//   - a loose match in two places is not made
//   - not found: the closest lines, the first difference, the file's text
//
// Run:  node scripts/test-replace-match.mjs
// =============================================================================

import { replaceInText, looseReplace, closestText, showLine } from '../../shared/agent-core/replace-match.mjs'

const results = []
function test(name, fn) {
  try {
    fn()
    results.push({ name, pass: true })
    console.log(`  ok  - ${name}`)
  } catch (err) {
    results.push({ name, pass: false })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}
function assert(cond, message) { if (!cond) throw new Error(message) }

// The redstart-website chats (2026-11-25): tab-indented CRLF Svelte files.
const page = [
  '<script>',
  '\tconst projects = [',
  '\t\t{',
  "\t\t\tname: 'Dungeonbooks',",
  "\t\t\tdescription: 'Old',",
  '\t\t},',
  '\t];',
  '</script>',
  '',
].join('\r\n')
const twice = '<div>\n\t<p>a</p>\n</div>\n<div>\n\t<p>a</p>\n</div>\n'

console.log('\n-- exact --')

test('an exact match once is made, and says its line', () => {
  const r = replaceInText(page, "'Old'", "'New'", { label: 'page.svelte' })
  assert(r.ok && r.after === page.replace("'Old'", "'New'") && r.at === 'line 5', JSON.stringify(r))
})

test('\\n in old_string matches a CRLF file', () => {
  const r = replaceInText(page, "\t\t{\n\t\t\tname: 'Dungeonbooks',", "\t\t{\n\t\t\tname: 'DB',")
  assert(r.ok && r.after.includes("\t\t{\r\n\t\t\tname: 'DB',\r\n"), JSON.stringify(r))
})

test('twice is refused unless replace_all, which replaces both', () => {
  const r = replaceInText(twice, '<p>a</p>', '<p>b</p>', { label: 'twice.svelte' })
  assert(!r.ok && /appears 2 times in twice.svelte \(lines 2, 5\)/.test(r.error), JSON.stringify(r))
  const all = replaceInText(twice, '<p>a</p>', '<p>b</p>', { replaceAll: true })
  assert(all.ok && !all.after.includes('<p>a</p>') && all.at === '2 occurrences', JSON.stringify(all))
})

test('empty old_string, and old equal to new, are refused', () => {
  assert(!replaceInText(page, '', 'x').ok, 'empty old_string made')
  assert(/the same/.test(/** @type {any} */ (replaceInText(page, 'Old', 'Old')).error), 'same text made')
})

console.log('\n-- indentation set aside --')

test('a first line indented wrong is matched, and the file keeps its indentation', () => {
  const r = replaceInText(page,
    "\t\t\t\t{\n\t\t\tname: 'Dungeonbooks',\n\t\t\tdescription: 'Old',",
    "\t\t\t\t{\n\t\t\tname: 'Dungeonbooks',\n\t\t\tdescription: 'Android and Windows',")
  assert(r.ok && r.after === page.replace("'Old'", "'Android and Windows'"), JSON.stringify(r))
  assert(r.at === 'line 3' && /indentation set aside/.test(r.note ?? ''), 'no line or note')
})

test('a block shifted by one tab throughout is shifted back, new lines with it', () => {
  const r = replaceInText(page,
    "\t\tname: 'Dungeonbooks',\n\t\tdescription: 'Old',",
    "\t\tname: 'Dungeonbooks',\n\t\ticon: '/db.png',\n\t\tdescription: 'Old',")
  assert(r.ok && r.after === page.replace('\t\t\tdescription', "\t\t\ticon: '/db.png',\r\n\t\t\tdescription"), JSON.stringify(r))
})

test('indentation off by different amounts on different lines is not guessed at', () => {
  const r = replaceInText(page, "\t{\n\tname: 'Dungeonbooks',\n\t\t\t\t\tdescription: 'Old',", 'x')
  assert(!r.ok, 'a guess was made')
  assert(/Closest: lines 3-5, where 3 of its 3 lines match with whitespace aside/.test(r.error), r.error)
  assert(/your line 1 is "\\t\{"; the file's line 3 is "\\t\\t\{"/.test(r.error), r.error)
  assert(/exactly as it has them:\n---\n\t\t\{\n\t\t\tname: 'Dungeonbooks',\n\t\t\tdescription: 'Old',\n---$/.test(r.error), r.error)
})

test('a loose match in two places is not made', () => {
  const r = replaceInText(twice, '<div>\n<p>a</p>', '<div>\n<p>b</p>')
  assert(!r.ok, 'made in one of two places')
  assert(looseReplace(twice, '<div>\n<p>a</p>', 'x') === null, 'looseReplace guessed')
})

test('replace_all never goes loose', () => {
  assert(!replaceInText(page, "\t\t\t\t{\n\t\t\tname: 'Dungeonbooks',", 'x', { replaceAll: true }).ok, 'loose with replace_all')
})

console.log('\n-- not found --')

test('a wrong line is pointed at, with the file text to copy', () => {
  const r = replaceInText(page, "\t\t\tname: 'Dungeonbooks',\n\t\t\tdescription: 'A digital tool',", 'x', { label: 'page.svelte' })
  assert(!r.ok && /^old_string was not found in page.svelte/.test(r.error), JSON.stringify(r))
  assert(/Closest: lines 4-5, where 1 of its 2 lines match/.test(r.error), r.error)
  assert(/your line 2 is "\\t\\t\\tdescription: 'A digital tool',"; the file's line 5 is "\\t\\t\\tdescription: 'Old',"/.test(r.error), r.error)
})

test('nothing in common says to read again', () => {
  const r = replaceInText(page, 'nowhere at all', 'x')
  assert(!r.ok && /None of its lines are in the file/.test(r.error), JSON.stringify(r))
  assert(closestText('a\n', 'one\ntwo\nthree') === null, 'a window longer than the file')
})

test('the seen state is said', () => {
  assert(/changed since you last read it/.test(/** @type {any} */ (replaceInText(page, 'zz', 'x', { seen: 'changed' })).error), 'changed not said')
  assert(/not read this file/.test(/** @type {any} */ (replaceInText(page, 'zz', 'x', { seen: 'unread' })).error), 'unread not said')
  assert(showLine('\t\tx  ') === '\\t\\tx', showLine('\t\tx  '))
})

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
