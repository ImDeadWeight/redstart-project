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

import { register } from 'node:module'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-skills-test-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir
register('./auth-test-loader.mjs', import.meta.url)
await import('./electron-stub.mjs')

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

console.log('\n-- the store (skills-storage.mjs) --')

const { configDir } = await import('../daemon/platform-paths.mjs')
const skills = await import('../daemon/skills-storage.mjs')
const workflows = await import('../daemon/workflows-storage.mjs')
const ann = { id: 'acct-ann', username: 'ann' }
const bob = { id: 'acct-bob', username: 'bob' }

await test('🔒 workflows.json migrates once into skill folders, keeping ids; the file itself is left alone', async () => {
  const wfFile = path.join(configDir(), 'workflows.json')
  fs.mkdirSync(configDir(), { recursive: true })
  const before = {
    personal: { 'acct-ann': [{ id: 'w1', name: 'weekly--report', title: 'Weekly', description: '', instructions: 'Do {{notes}}.', inputs: [{ name: 'notes', description: '', required: true }], example: null, createdAt: 5, updatedAt: 6, createdBy: 'ann' }] },
    org: [{ id: 'w2', name: 'summary', title: '', description: 'Summarise', instructions: 'Summarise it.', inputs: [], example: { input: 'i', output: 'o' }, createdAt: 1, updatedAt: 2, createdBy: 'admin' }],
  }
  fs.writeFileSync(wfFile, JSON.stringify(before))
  skills._resetMigrationForTests()
  const mine = workflows.listPersonal(ann)
  eq(mine.map((w) => [w.id, w.name, w.title, w.instructions, w.inputs.length, w.createdAt, w.updatedAt]), [['w1', 'weekly-report', 'Weekly', 'Do {{notes}}.', 1, 5, 6]], 'personal, "--" collapsed')
  eq(workflows.listOrg().map((w) => [w.id, w.name, w.example]), [['w2', 'summary', { input: 'i', output: 'o' }]], 'org')
  eq(JSON.parse(fs.readFileSync(wfFile, 'utf8')), before, 'workflows.json is untouched')
  assert(fs.existsSync(path.join(configDir(), 'skills', 'personal', 'acct-ann', 'weekly-report', 'SKILL.md')), 'no SKILL.md on disk')
  // Once: a second run (a new process) does not import again.
  fs.writeFileSync(wfFile, JSON.stringify({ personal: { 'acct-ann': [{ id: 'w3', name: 'late', instructions: 'x' }] }, org: [] }))
  skills._resetMigrationForTests()
  eq(workflows.listPersonal(ann).map((w) => w.id), ['w1'], 'migrated twice')
  eq(workflows.listPersonal(bob), [], 'another account sees nothing')
})

await test('🔒 a skill file path must be relative, forward-slashed, inside the folder and not a dot-file', async () => {
  for (const ok of ['notes.md', 'scripts/fill.py', 'a/b/c/d/e.txt']) assert(skills.validSkillFilePath(ok), `${ok} refused`)
  for (const bad of ['', '/etc/passwd', 'C:/x', '..\\x', '../x', 'a/../b', '.redstart.json', 'a/.hidden', 'a//b', 'a/b/c/d/e/f.txt', 'x\0y', 'a:b']) {
    assert(!skills.validSkillFilePath(bad), `${JSON.stringify(bad)} accepted`)
  }
  eq(skills.checkSkillFiles({ '../x': 'a' })?.startsWith('"../x" is not a path'), true, 'checkSkillFiles names the path')
  assert(/at most 20 files/.test(skills.checkSkillFiles(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`f${i}.txt`, 'x']))) ?? ''), 'count')
  assert(/over 200 KB/.test(skills.checkSkillFiles({ 'big.txt': Buffer.alloc(200 * 1024 + 1) }) ?? ''), 'size')
})

await test('writeSkill: create, rename on update, a conflict refused (a stray folder included), files replaced, reads contained', async () => {
  const mk = (name, body = 'b') => ({ name, description: `d ${name}`, metadata: {}, body })
  const a = skills.writeSkill(ann, 'personal', { skill: mk('alpha'), files: { 'ref/notes.md': 'hello', 'run.py': 'print(1)' } }, { by: 'ann' })
  assert(a.ok, a.error)
  eq(a.skill.files, ['ref/notes.md', 'run.py'], 'files')
  eq(skills.readSkillFile(a.skill, 'ref/notes.md')?.toString(), 'hello', 'read')
  eq(skills.readSkillFile(a.skill, '../SKILL.md'), null, 'a path out of the folder')
  const dupe = skills.writeSkill(ann, 'personal', { skill: mk('alpha') })
  eq([dupe.ok, dupe.code], [false, 'conflict'], 'same name')
  fs.mkdirSync(path.join(path.dirname(a.skill.dir), 'stray'), { recursive: true })
  const stray = skills.writeSkill(ann, 'personal', { skill: mk('stray') })
  eq([stray.ok, stray.code], [false, 'conflict'], 'a folder that is not a skill is not overwritten')
  const renamed = skills.writeSkill(ann, 'personal', { skill: mk('beta'), files: { 'only.txt': 'x' } }, { id: a.skill.id })
  assert(renamed.ok, renamed.error)
  eq([renamed.skill.name, renamed.skill.id, renamed.skill.files, fs.existsSync(a.skill.dir)], ['beta', a.skill.id, ['only.txt'], false], 'renamed, same id, files replaced')
  assert(skills.deleteSkill(ann, 'personal', a.skill.id) && !fs.existsSync(renamed.skill.dir), 'delete')
})

await test('a workflow edit keeps what an imported skill carried that the editor does not show', async () => {
  const imported = skills.writeSkill(ann, 'personal', { skill: { name: 'imported', description: 'From elsewhere', license: 'MIT', metadata: { author: 'Someone' }, body: 'Steps.' } })
  assert(imported.ok, imported.error)
  const w = workflows.getWorkflow(ann, 'personal', imported.skill.id)
  eq([w.name, w.description, w.instructions, w.inputs], ['imported', 'From elsewhere', 'Steps.', []], 'read as a workflow')
  const r = workflows.updateWorkflow(ann, 'personal', w.id, { ...w, instructions: 'New steps.' })
  assert(r.ok, r.error)
  const after = skills.getSkillById(ann, 'personal', w.id)
  eq([after.body, after.license, after.metadata.author], ['New steps.', 'MIT', 'Someone'], 'license and foreign metadata kept')
  const bad = workflows.createWorkflow(ann, 'personal', { name: 'two--hyphens', instructions: 'x' })
  assert(!bad.ok && /single inner hyphens/.test(bad.error), `a "--" name: ${JSON.stringify(bad)}`)
})

fs.rmSync(tmpDir, { recursive: true, force: true })
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
