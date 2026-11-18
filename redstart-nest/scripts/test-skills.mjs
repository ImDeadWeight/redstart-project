// =============================================================================
// Skills — the SKILL.md format, the store, use_skill (master plan Phase 5)
// =============================================================================
// Pinned here:
//   - the format: front matter as the Agent Skills format has it (name,
//     description, metadata), the YAML subset this reader takes, and a
//     refusal with a line number for anything outside it; serialize then
//     parse returns the same skill; a workflow round-trips through a skill
//   - the store: workflows.json migrates once and is left alone; file paths
//     are checked; a rename moves the folder and a name clash is refused
//   - use_skill: the prompt lists names and descriptions only with the tool;
//     another account's skills are never reached; .py files are copied for
//     run_python and nothing else is
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

console.log('\n-- use_skill and the prompt (skills-tool.mjs) --')

const tool = await import('../daemon/skills-tool.mjs')
const { composePrompt } = await import('../daemon/system-prompt.mjs')
const call = async (account, args, cfg = {}, conversationId = null) => tool.callTool('use_skill', args, cfg, { account, conversationId })
const textOf = (r) => r.content[0].text
const carol = { id: 'acct-carol', username: 'carol' }

const report = skills.writeSkill(carol, 'personal', {
  skill: { name: 'report', description: 'Weekly\nreport format', metadata: { 'redstart-example': JSON.stringify({ input: 'in', output: 'out' }) }, body: 'Write the report.' },
  files: { 'reference/format.md': '# Format', 'scripts/fill.py': 'print("filled")', 'data.bin': Buffer.from([1, 0, 2]) },
})
assert(report.ok, report.error)
skills.writeSkill(null, 'org', { skill: { name: 'style', description: 'House style', metadata: {}, body: 'Use British spelling.' } })

await test('the prompt lists a caller\'s skills, personal then org (org- prefixed), one line each, and only with use_skill', async () => {
  const p = tool.skillsForPrompt(carol)
  eq(p.skills.map((s) => s.name), ['report', 'org-style', 'org-summary'], 'names (org-summary is the migrated one)')
  eq(p.skills[0].description, 'Weekly report format', 'one line')
  const base = { config: {}, hasTools: true, skills: p.skills, skillsOmitted: 2 }
  const withTool = composePrompt({ ...base, toolNames: ['use_skill'] })
  assert(withTool.blocks.includes('skills') && /- org-style: House style/.test(withTool.prompt) && /2 more are not listed/.test(withTool.prompt), withTool.prompt)
  // After the precedence clause: user-tier, like memories.
  assert(withTool.blocks.indexOf('skills') > withTool.blocks.indexOf('precedence'), `order: ${withTool.blocks}`)
  const without = composePrompt({ ...base, toolNames: ['run_python'] })
  assert(!without.blocks.includes('skills'), 'listed with no use_skill to load them')
  const long = Array.from({ length: 45 }, (_, i) => `s${String(i).padStart(2, '0')}`)
  const many = { id: 'acct-many', username: 'many' }
  for (const n of long) skills.writeSkill(many, 'personal', { skill: { name: n, description: 'd'.repeat(300), metadata: {}, body: 'b' } })
  const capped = tool.skillsForPrompt(many)
  eq([capped.skills.length, capped.skillsOmitted, capped.skills[0].name, capped.skills[0].description.length], [40, 7, 's00', 200], 'capped, sorted, cut (45 personal and 2 org)')
})

await test('🔒 use_skill: lists, loads the body with its example and files, reads a file; never another account\'s skill', async () => {
  const list = JSON.parse(textOf(await call(carol, {})))
  eq(list.skills.map((s) => s.name), ['report', 'org-style', 'org-summary'], 'list')
  const loaded = textOf(await call(carol, { name: 'report' }))
  assert(/^Skill: report\n\nWrite the report\./.test(loaded) && /Example input:\nin/.test(loaded) && /data\.bin, reference\/format\.md/.test(loaded), loaded)
  eq(textOf(await call(carol, { name: 'report', file: 'reference/format.md' })), '# Format', 'a file')
  assert((await call(carol, { name: 'report', file: 'data.bin' })).isError, 'a binary file came back as text')
  for (const bad of ['../../../../secrets-key.json', '.redstart.json', 'SKILL.md/../x']) {
    assert((await call(carol, { name: 'report', file: bad })).isError, `${bad} was read`)
  }
  eq(textOf(await call(carol, { name: 'org-style' })).split('\n')[0], 'Skill: org-style', 'org by its prefix')
  assert((await call(ann, { name: 'report' })).isError, 'another account loaded carol\'s skill')
  assert(!JSON.stringify(JSON.parse(textOf(await call(ann, {}))).skills).includes('"report"'), 'another account listed it')
})

await test('🔒 a skill\'s .py files are copied into the conversation workspace for run_python, and nothing else is, and only with run_python', async () => {
  const docs = path.join(tmpDir, 'docs')
  fs.mkdirSync(docs, { recursive: true })
  const py = { enabled: true, documentsRoot: docs, workspaceCapBytes: 10 * 1024 * 1024, accountCapBytes: 50 * 1024 * 1024 }
  const conv = 'conv-skill-1'
  const out = textOf(await call(carol, { name: 'report' }, { python: py }, conv))
  assert(/run them with run_python/.test(out), out)
  const { workspaceDir } = await import('../daemon/conversation-workspace.mjs')
  const ws = workspaceDir(docs, carol, conv)
  eq(fs.readFileSync(path.join(ws, 'skills', 'report', 'scripts', 'fill.py'), 'utf8'), 'print("filled")', 'staged')
  assert(!fs.existsSync(path.join(ws, 'skills', 'report', 'reference')) && !fs.existsSync(path.join(ws, 'skills', 'report', 'data.bin')), 'a non-Python file was copied where code runs')
  const off = textOf(await call(carol, { name: 'report' }, {}, 'conv-skill-2'))
  assert(/run_python is not available here/.test(off), off)
})

console.log('\n-- import and export (zip.mjs, the /workflows routes) --')

const zip = await import('../daemon/zip.mjs')
const { Readable } = await import('node:stream')
const { handleWorkflowRoute } = await import('../daemon/gateway/workflow-routes.mjs')
const LIMITS = { maxEntries: 30, maxEntryBytes: 200 * 1024, maxTotalBytes: 2 * 1024 * 1024 }

await test('🔒 zip: a round trip; a lying size, an encrypted entry and a bomb are refused before they cost anything', async () => {
  const files = { 'a/SKILL.md': '---\nname: a\ndescription: d\n---\nbody', 'a/big.txt': 'x'.repeat(50000), 'a/empty.txt': '' }
  const z = zip.createZip(files)
  assert(zip.isZip(z), 'not a zip')
  const back = zip.readZip(z, LIMITS)
  assert(back.ok, back.error)
  eq(Object.fromEntries(Object.entries(back.files).map(([k, v]) => [k, v.toString()])), files, 'round trip')
  eq(zip.createZip(files).equals(z), true, 'the same files are the same bytes')
  // A header that understates the size: inflation stops at the declared size.
  const lying = Buffer.from(z)
  const cd = lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  const cd2 = lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), cd + 4)
  lying.writeUInt32LE(10, cd2 + 24)
  const lie = zip.readZip(lying, LIMITS)
  assert(!lie.ok && /big\.txt/.test(lie.error), JSON.stringify(lie))
  const enc = Buffer.from(z)
  enc.writeUInt16LE(enc.readUInt16LE(cd + 8) | 1, cd + 8)
  assert(/encrypted/.test(zip.readZip(enc, LIMITS).error ?? ''), 'encrypted read')
  const bomb = zip.createZip({ 'b.txt': Buffer.alloc(5 * 1024 * 1024) })
  assert(/over 200 KB/.test(zip.readZip(bomb, LIMITS).error ?? ''), 'a 5 MB entry (a few KB compressed) was inflated')
  assert(!zip.readZip(Buffer.from('not a zip at all, just text'), LIMITS).ok, 'text read as a zip')
})

await test('an upload: a zip with its folder on top, OS junk dropped, a bare SKILL.md; a bad path refused', async () => {
  const md = '---\nname: notes\ndescription: Notes\n---\nTake notes.'
  const up = skills.skillFromUpload(zip.createZip({ 'notes/SKILL.md': md, 'notes/ref/a.md': 'A', '__MACOSX/notes/._SKILL.md': 'junk', 'notes/.DS_Store': 'junk' }))
  assert(up.ok, up.error)
  eq([up.skill.name, Object.keys(up.files)], ['notes', ['ref/a.md']], 'folder stripped, junk dropped')
  const bare = skills.skillFromUpload(Buffer.from(md))
  assert(bare.ok && bare.skill.body === 'Take notes.', JSON.stringify(bare))
  const evil = skills.skillFromUpload(zip.createZip({ 'SKILL.md': md, '../escape.txt': 'x' }))
  assert(!evil.ok && /not a path a skill may hold/.test(evil.error), JSON.stringify(evil))
  assert(!skills.skillFromUpload(zip.createZip({ 'x/readme.md': 'no skill' })).ok, 'a zip with no SKILL.md')
})

function fakeReq(method, url, body) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [])
  req.method = method; req.url = url; req.headers = {}
  return req
}
function fakeRes() {
  return { status: 0, headers: {}, body: '', writeHead(s, h) { this.status = s; Object.assign(this.headers, h ?? {}); return this }, setHeader(k, v) { this.headers[k] = v }, end(b) { this.body = b ?? '' } }
}
async function route(method, url, account, body) {
  const res = fakeRes()
  const handled = await handleWorkflowRoute(fakeReq(method, url, body), res, url.split('?')[0], account)
  assert(handled, `${method} ${url} was not handled`)
  return res
}

await test('🔒 the routes: import (personal; org needs the permission), export as zip and as SKILL.md, never another account\'s', async () => {
  const dave = { id: 'acct-dave', username: 'dave' }
  const pkg = zip.createZip({ 'tidy/SKILL.md': '---\nname: tidy\ndescription: Tidy a list\nmetadata:\n  author: "x"\n---\nSort it.', 'tidy/helper.py': 'print(2)' })
  const imp = await route('POST', '/workflows/personal/import', dave, { file: pkg.toString('base64') })
  eq(imp.status, 201, `import: ${imp.body}`)
  const w = JSON.parse(imp.body)
  eq([w.name, w.instructions], ['tidy', 'Sort it.'], 'imported as a workflow')
  eq((await route('POST', '/workflows/personal/import', dave, { file: pkg.toString('base64') })).status, 409, 'a second import of the same name')
  eq((await route('POST', '/workflows/org/import', dave, { file: pkg.toString('base64') })).status, 403, 'org import without manageOrgWorkflows')
  eq((await route('POST', '/workflows/personal/import', dave, { file: '' })).status, 400, 'no file')
  const orgPrefixed = zip.createZip({ 'SKILL.md': '---\nname: org-x\ndescription: d\n---\nb' })
  eq((await route('POST', '/workflows/personal/import', dave, { file: orgPrefixed.toString('base64') })).status, 400, 'a personal org- name')

  const ex = await route('GET', `/workflows/personal/${w.id}/export`, dave)
  eq([ex.status, ex.headers['Content-Type'], ex.headers['Content-Disposition']], [200, 'application/zip', 'attachment; filename="tidy.zip"'], 'zip headers')
  const unz = zip.readZip(ex.body, LIMITS)
  assert(unz.ok, unz.error)
  eq(Object.keys(unz.files).sort(), ['tidy/SKILL.md', 'tidy/helper.py'], 'the folder, and never .redstart.json')
  assert(/author: "x"/.test(unz.files['tidy/SKILL.md'].toString()), 'foreign metadata kept on the way out')
  const mdEx = await route('GET', `/workflows/personal/${w.id}/export?format=md`, dave)
  assert(mdEx.status === 200 && /^---\nname: tidy\n/.test(mdEx.body.toString()), String(mdEx.body))
  eq((await route('GET', `/workflows/personal/${w.id}/export`, ann)).status, 404, 'another account exported dave\'s')
})

fs.rmSync(tmpDir, { recursive: true, force: true })
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
