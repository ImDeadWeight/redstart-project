// =============================================================================
// Skills — the SKILL.md format, the store, use_skill (master plan Phase 5)
// =============================================================================
// Pinned here:
//   - the format: front matter as the Agent Skills format has it (name,
//     description, metadata), the YAML subset this reader takes, and a
//     refusal with a line number for anything outside it; serialize then
//     parse returns the same skill; a workflow round-trips through a skill
//
// Run:  node scripts/test-skills.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-skills-test-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir

const fmt = await import('../daemon/skill-format.mjs')

const results = []
async function test(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false })
    console.log(`FAIL  - ${name}\n        ${err.stack ?? err.message}`)
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message)
}
function eq(actual, expected, message) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${message}\n        expected ${e}\n        got      ${a}`)
}

console.log('\n-- the SKILL.md format --')

await test('a plain SKILL.md parses: name, description, metadata, body', async () => {
  const r = fmt.parseSkillMd([
    '---',
    'name: weekly-report',
    'description: Turns shorthand notes into the weekly report. # a comment',
    'metadata:',
    '  redstart-title: "Weekly report"',
    "  author: 'Ann''s team'",
    '---',
    '',
    'Rewrite {{notes}} as the report.',
    '',
  ].join('\r\n'))
  assert(r.ok, r.error)
  eq([r.skill.name, r.skill.description, r.skill.metadata, r.skill.body],
    ['weekly-report', 'Turns shorthand notes into the weekly report.', { 'redstart-title': 'Weekly report', author: "Ann's team" }, 'Rewrite {{notes}} as the report.'], 'fields')
})

await test('block scalars, a list (allowed-tools, dropped) and a license, as other agents write them', async () => {
  const r = fmt.parseSkillMd([
    '---',
    'name: pdf-forms',
    'description: >',
    '  Fill in PDF forms.',
    '  Use when the user attaches a form.',
    'license: Apache-2.0',
    'allowed-tools:',
    '  - Read',
    '  - Bash',
    '---',
    '# PDF forms',
    'Steps.',
  ].join('\n'))
  assert(r.ok, r.error)
  eq([r.skill.description, r.skill.license, r.skill.body], ['Fill in PDF forms. Use when the user attaches a form.', 'Apache-2.0', '# PDF forms\nSteps.'], 'fields')
  const lit = fmt.parseSkillMd('---\nname: a\ndescription: |\n  one\n  two\n---\nx')
  assert(lit.ok && lit.skill.description === 'one\ntwo', JSON.stringify(lit))
})

await test('🔍 refused, with the reason: no front matter, unclosed, a bad name, no description, an unknown field, YAML this does not read', async () => {
  const cases = [
    ['no front matter', /must start with "---"/],
    ['---\nname: a\ndescription: x\n', /never closed/],
    ['---\nname: Weekly_Report\ndescription: x\n---\n', /name must be lowercase/],
    ['---\nname: a--b\ndescription: x\n---\n', /name must be lowercase/],
    ['---\nname: a\n---\n', /description is required/],
    ['---\nname: a\ndescription: x\nsecret: y\n---\n', /unknown field\(s\) secret/],
    ['---\nname: a\ndescription: &anchor x\n---\n', /line 3: anchors/],
    ['---\nname: a\ndescription: "open\n---\n', /line 3: an unclosed double quote/],
    ['---\nname: a\nname: b\ndescription: x\n---\n', /given twice/],
    ['---\nname: a\ndescription: x\nmetadata:\n  deep:\n    k: v\n---\n', /one level of nesting/],
    [`---\nname: a\ndescription: ${'d'.repeat(1025)}\n---\n`, /at most 1024/],
  ]
  for (const [text, re] of cases) {
    const r = fmt.parseSkillMd(text)
    assert(!r.ok && re.test(r.error), `${JSON.stringify(text.slice(0, 40))}: ${r.ok ? 'accepted' : r.error}`)
  }
  return `${cases.length} cases`
})

await test('🔒 serialize then parse is the same skill, whatever the text holds', async () => {
  const skill = {
    name: 'tricky',
    description: 'Quotes " and \' and a colon: here, a # hash, and\na newline.',
    license: 'MIT',
    metadata: { 'redstart-inputs': JSON.stringify([{ name: 'x', description: 'a "quoted" thing', required: true }]) },
    body: '---\nA body that starts with a rule.\n\n## And a heading',
  }
  const text = fmt.serializeSkillMd(skill)
  const r = fmt.parseSkillMd(text)
  assert(r.ok, r.error)
  eq(r.skill, { ...skill }, 'round trip')
})

await test('a workflow round-trips through a skill; a skill from another agent has no inputs or example', async () => {
  const w = {
    name: 'weekly-report', title: 'Weekly report', description: '',
    instructions: 'Rewrite {{notes}}.', inputs: [{ name: 'notes', description: 'the notes', required: true }],
    example: { input: 'a', output: 'b' },
  }
  const s = fmt.workflowToSkill(w)
  eq(s.description, 'Weekly report', 'an empty description takes the title (the format requires one)')
  const back = fmt.skillToWorkflowFields(fmt.parseSkillMd(fmt.serializeSkillMd(s)).skill)
  eq(back, { ...w, description: 'Weekly report' }, 'round trip')
  const foreign = fmt.skillToWorkflowFields({ name: 'x', description: 'd', metadata: { 'redstart-inputs': 'not json' }, body: 'b' })
  eq([foreign.inputs, foreign.example, foreign.title], [[], null, ''], 'foreign')
})

fs.rmSync(tmpDir, { recursive: true, force: true })
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
