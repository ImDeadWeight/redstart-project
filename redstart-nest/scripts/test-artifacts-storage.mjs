// =============================================================================
// Artifact storage: drafts, revisions, limits, crash safety (artifacts plan §7)
// =============================================================================
// artifacts-storage.mjs keeps every artifact as numbered immutable revisions
// plus at most one draft. Pinned here:
//
//   - every write goes to the draft; seal makes the next revision; a draft
//     that changed nothing is discarded, not sealed
//   - reads come from the caller's own draft, else head, or a named revision
//   - the holder rule: another chat is refused while the draft is fresh, and
//     takes it over (sealing the old draft) once it is not; idle drafts seal
//   - restore is a NEW revision; history never rewinds
//   - fork copies what the caller can see; the source is untouched
//   - edit goes through the shared matcher, and a miss changes nothing
//   - paths: no traversal, no dot-files, no absolute or drive paths, only
//     allowed extensions; 255 files, 2 MB a file, 10 MB in all
//   - an interrupted seal is cleaned up at startup and the draft seals again
//   - delete moves it to the trash, recoverably
//
// Run:  node scripts/test-artifacts-storage.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-artifacts-storage-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir
register('./auth-test-loader.mjs', import.meta.url)
await import('./electron-stub.mjs')

const auth = await import('../daemon/auth.mjs')
const accounts = await import('../daemon/accounts-storage.mjs')
const store = await import('../daemon/artifacts-storage.mjs')

const results = []
async function test(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}
function assert(cond, message) { if (!cond) throw new Error(message) }
const ok = (r) => { if (!r.ok) throw new Error(JSON.stringify(r)); return r }
const text = (r) => ok(r).data.toString('utf8')

auth.setAuthRequired(true)
auth.createOwner({ username: 'owner', password: 'owner-pass-1' })
const OWNER = accounts.listAccounts().find((a) => a.tier === 'owner')
const ALICE = accounts.findById(auth.createAccount(OWNER, { username: 'alice', password: 'pass-1234', roleIds: ['full-access'] }).account.id)

const T0 = 1_000_000_000_000
const page = '<!doctype html>\n<html>\n<head><link rel="stylesheet" href="site.css"></head>\n<body>\n\t<nav class="sidebar">\n\t\t<a href="#">Home</a>\n\t</nav>\n</body>\n</html>\n'

console.log('\n-- drafts and revisions --')

let A
await test('create writes a draft held by the conversation; nothing is sealed yet', async () => {
  const r = ok(store.createArtifact(ALICE, { title: 'Dashboard', kind: 'web', files: [{ path: 'index.html', content: page }, { path: 'site.css', content: 'body{}' }] }, { conversationId: 'c1', now: T0 }))
  A = r.artifact
  assert(A.head === 0 && A.draft?.mine && A.draft.conversationId === 'c1', JSON.stringify(A))
  assert(r.placedIn === 'own', 'placed somewhere else')
  const m = ok(store.getManifest(ALICE, A.id))
  assert(m.source === 'draft' && m.entry === 'index.html' && m.files.length === 2, JSON.stringify(m))
})

await test('seal at turn end makes revision 1 and clears the draft', async () => {
  const s = ok(store.sealArtifact(ALICE, A.id, { conversationId: 'c1', now: T0 + 1000 }))
  assert(s.sealed && s.revision === 1, JSON.stringify(s))
  const m = ok(store.getManifest(ALICE, A.id))
  assert(m.source === 1 && m.artifact.draft === null, JSON.stringify(m))
})

await test('a draft that changed nothing is discarded, not sealed', async () => {
  ok(store.writeArtifactFile(ALICE, A.id, 'site.css', 'body{}', { conversationId: 'c1', now: T0 + 2000 }))
  const s = ok(store.sealArtifact(ALICE, A.id, { conversationId: 'c1', now: T0 + 3000 }))
  assert(!s.sealed && s.reason === 'unchanged' && s.revision === 1, JSON.stringify(s))
})

await test('edit goes through the shared matcher (indentation set aside) into the draft', async () => {
  const r = ok(store.editArtifactFile(ALICE, A.id, 'index.html', '<nav class="sidebar">\n\t<a href="#">Home</a>', '<nav class="sidebar narrow">\n\t<a href="#">Home</a>', { conversationId: 'c1', now: T0 + 4000 }))
  assert(/indentation set aside/.test(r.note ?? ''), JSON.stringify(r))
  assert(text(store.readArtifactFile(ALICE, A.id, 'index.html')).includes('\t<nav class="sidebar narrow">\n\t\t<a'), 'file indentation not kept')
  assert(!text(store.readArtifactFile(ALICE, A.id, 'index.html', { revision: 1 })).includes('narrow'), 'revision 1 changed')
})

await test('an edit that misses says where it came closest, and changes nothing', async () => {
  const before = text(store.readArtifactFile(ALICE, A.id, 'index.html'))
  const r = store.editArtifactFile(ALICE, A.id, 'index.html', '<nav class="topbar">', 'x', { conversationId: 'c1', now: T0 + 4500 })
  assert(!r.ok && /not found in index.html/.test(r.error), JSON.stringify(r))
  assert(text(store.readArtifactFile(ALICE, A.id, 'index.html')) === before, 'a miss changed the file')
  assert(/artifact_write creates/.test(store.editArtifactFile(ALICE, A.id, 'nope.html', 'a', 'b', { conversationId: 'c1', now: T0 + 4600 }).error), 'missing file not explained')
})

await test('write null deletes a file in the draft; head keeps it', async () => {
  ok(store.writeArtifactFile(ALICE, A.id, 'js/app.js', 'console.log(1)', { conversationId: 'c1', now: T0 + 5000 }))
  const del = ok(store.writeArtifactFile(ALICE, A.id, 'js/app.js', null, { conversationId: 'c1', now: T0 + 5100 }))
  assert(del.action === 'deleted', JSON.stringify(del))
  assert(!store.readArtifactFile(ALICE, A.id, 'js/app.js').ok, 'still there')
  const before = fs.readFileSync(path.join(store.artifactsRoot(), A.id, 'draft.json'), 'utf8')
  assert(store.writeArtifactFile(ALICE, A.id, 'js/app.js', null, { conversationId: 'c1', now: T0 + 5200 }).code === 'not_found', 'deleting nothing succeeded')
  assert(fs.readFileSync(path.join(store.artifactsRoot(), A.id, 'draft.json'), 'utf8') === before, 'a refused delete touched the draft')
})

console.log('\n-- the holder --')

await test('another chat is refused while the draft is fresh', async () => {
  const r = store.writeArtifactFile(ALICE, A.id, 'site.css', 'body{color:red}', { conversationId: 'c2', now: T0 + 5000 + store.HOLD_MS - 1 })
  assert(!r.ok && r.code === 'busy' && /another chat/.test(r.error), JSON.stringify(r))
})

await test('after HOLD_MS it takes over: the old draft is sealed first', async () => {
  const at = T0 + 5100 + store.HOLD_MS + 1
  ok(store.writeArtifactFile(ALICE, A.id, 'site.css', 'body{color:red}', { conversationId: 'c2', now: at }))
  const revs = ok(store.listRevisions(ALICE, A.id))
  assert(revs.head === 2 && revs.revisions[0].conversationId === 'c1', JSON.stringify(revs))
  assert(text(store.readArtifactFile(ALICE, A.id, 'index.html', { revision: 2 })).includes('narrow'), 'c1\'s edit not in revision 2')
  const m = ok(store.getManifest(ALICE, A.id))
  assert(m.artifact.draft.conversationId === 'c2', 'c2 does not hold it')
})

await test('seal from another chat leaves this one\'s draft alone', async () => {
  const s = ok(store.sealArtifact(ALICE, A.id, { conversationId: 'c1' }))
  assert(!s.sealed && s.reason === 'held by another chat', JSON.stringify(s))
})

await test('an idle draft seals on access and by the sweep', async () => {
  const later = T0 + 5100 + store.HOLD_MS + 1 + store.IDLE_SEAL_MS + 1
  assert(store.sealIdleDrafts(later) === 1, 'sweep sealed nothing')
  assert(store.getArtifact(ALICE, A.id).head === 3, 'not revision 3')
  ok(store.writeArtifactFile(ALICE, A.id, 'site.css', 'body{color:blue}', { conversationId: 'c2', now: later + 10 }))
  const got = store.getArtifact(ALICE, A.id, { now: later + 10 + store.IDLE_SEAL_MS + 1 })
  assert(got.head === 4 && got.draft === null, JSON.stringify(got))
})

console.log('\n-- restore and fork --')

await test('restore makes a new revision with the old content; history keeps every one', async () => {
  const r = ok(store.restoreRevision(ALICE, A.id, 1))
  assert(r.revision === 5, JSON.stringify(r))
  assert(!text(store.readArtifactFile(ALICE, A.id, 'index.html')).includes('narrow'), 'head is not revision 1\'s content')
  const revs = ok(store.listRevisions(ALICE, A.id)).revisions
  assert(revs.length === 5 && revs[0].restoredFrom === 1, JSON.stringify(revs))
  for (const n of [1, 2, 3, 4]) assert(store.readArtifactFile(ALICE, A.id, 'index.html', { revision: n }).ok, `revision ${n} gone`)
  assert(store.restoreRevision(ALICE, A.id, 99).code === 'not_found', 'restored a missing revision')
})

await test('fork copies what you can see; the original is untouched', async () => {
  const f = ok(store.createArtifact(ALICE, { from: A.id, title: 'Light dashboard', files: [{ path: 'site.css', content: 'body{background:#fff}' }] }, { conversationId: 'c3' }))
  assert(f.artifact.id !== A.id && f.artifact.kind === 'web', JSON.stringify(f.artifact))
  assert(text(store.readArtifactFile(ALICE, f.artifact.id, 'site.css')).includes('#fff'), 'fork lacks its own file')
  assert(text(store.readArtifactFile(ALICE, f.artifact.id, 'index.html')) === text(store.readArtifactFile(ALICE, A.id, 'index.html')), 'fork lacks the copy')
  assert(!text(store.readArtifactFile(ALICE, A.id, 'site.css')).includes('#fff'), 'the original changed')
  assert(!store.createArtifact(ALICE, { from: '00000000-0000-0000-0000-000000000000' }).ok, 'forked a missing artifact')
})

await test('sealNow makes revision 1 at once (the UI\'s New)', async () => {
  const r = ok(store.createArtifact(ALICE, { title: 'Logo', kind: 'svg', files: [{ path: 'logo.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"/>' }] }, { sealNow: true }))
  assert(r.artifact.head === 1 && r.artifact.draft === null, JSON.stringify(r.artifact))
  assert(ok(store.getManifest(ALICE, r.artifact.id)).entry === 'logo.svg', 'svg entry not found')
})

console.log('\n-- paths and limits --')

await test('paths that could escape or hide are refused', async () => {
  const bad = ['../x.html', 'a/../b.html', '/abs.html', 'C:/x.html', 'C:\\x.html', 'a\\b.html', '.env.html', 'a/.git/x.html', 'x.exe', 'x', '', 'a//b.html', 'a b.html', 'x.html\0.css', 'é.html', 'a/b/c/d/e/f/g/h/i.html']
  for (const p of bad) assert(!store.validatePath(p).ok, `accepted ${JSON.stringify(p)}`)
  for (const p of ['index.html', 'css/site.css', 'img/logo.SVG', 'data/v1.2.json', 'a-b_c.md']) assert(store.validatePath(p).ok, `refused ${p}`)
  assert(!store.writeArtifactFile(ALICE, A.id, '../../escape.html', 'x').ok, 'write accepted traversal')
  assert(!store.readArtifactFile(ALICE, A.id, '../record.json').ok, 'read accepted traversal')
  assert(!fs.existsSync(path.join(tmpDir, 'escape.html')), 'something escaped')
})

await test('2 MB a file, 255 files, 10 MB in all', async () => {
  const big = 'x'.repeat(store.MAX_FILE_BYTES + 1)
  assert(store.writeArtifactFile(ALICE, A.id, 'big.txt', big, { conversationId: 'c9' }).code === 'too_large', 'a file over 2 MB')
  const many = Array.from({ length: store.MAX_FILES + 1 }, (_, i) => ({ path: `f${i}.txt`, content: 'x' }))
  assert(/at most 255 files/.test(store.createArtifact(ALICE, { title: 'Many', files: many }).error ?? ''), 'over 255 files')
  const six = Array.from({ length: 6 }, (_, i) => ({ path: `p${i}.txt`, content: 'y'.repeat(store.MAX_FILE_BYTES - 10) }))
  assert(/MB in all/.test(store.createArtifact(ALICE, { title: 'Heavy', files: six }).error ?? ''), 'over 10 MB')
  assert(!store.createArtifact(ALICE, { title: 'x', kind: 'pdf' }).ok, 'unknown kind')
})

console.log('\n-- crash safety --')

await test('an interrupted seal is cleaned up at startup and the draft seals again', async () => {
  const r = ok(store.createArtifact(ALICE, { title: 'Crashy', files: [{ path: 'index.html', content: '<p>v1</p>' }] }, { sealNow: true }))
  const id = r.artifact.id
  ok(store.writeArtifactFile(ALICE, id, 'index.html', '<p>v2</p>', { conversationId: 'cx' }))
  const dir = path.join(store.artifactsRoot(), id)
  // As if the daemon died after the rename but before record.json: a revision
  // folder nothing names, a .tmp beside it, a temp file in the draft.
  fs.cpSync(path.join(dir, 'draft'), path.join(dir, 'revisions', '2'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'revisions', '3.tmp'))
  fs.writeFileSync(path.join(dir, 'draft', '.index.html.abcd.tmp'), 'partial')
  const c = store.cleanupArtifacts()
  assert(c.removed >= 3, JSON.stringify(c))
  assert(!fs.existsSync(path.join(dir, 'revisions', '2')) && !fs.existsSync(path.join(dir, 'revisions', '3.tmp')), 'leftovers kept')
  const s = ok(store.sealArtifact(ALICE, id, { conversationId: 'cx' }))
  assert(s.sealed && s.revision === 2, JSON.stringify(s))
  assert(text(store.readArtifactFile(ALICE, id, 'index.html', { revision: 2 })) === '<p>v2</p>', 'draft content lost')
  assert(!fs.readdirSync(path.join(dir, 'revisions', '2')).some((n) => n.startsWith('.')), 'a temp file was sealed')
})

await test('a draft folder without draft.json is removed; head follows the record', async () => {
  const r = ok(store.createArtifact(ALICE, { title: 'Orphan', files: [{ path: 'a.txt', content: '1' }] }, { sealNow: true }))
  const dir = path.join(store.artifactsRoot(), r.artifact.id)
  fs.mkdirSync(path.join(dir, 'draft'))
  const index = JSON.parse(fs.readFileSync(path.join(store.artifactsRoot(), 'index.json'), 'utf8'))
  index.artifacts.find((a) => a.id === r.artifact.id).head = 7
  fs.writeFileSync(path.join(store.artifactsRoot(), 'index.json'), JSON.stringify(index))
  store.cleanupArtifacts()
  assert(!fs.existsSync(path.join(dir, 'draft')), 'orphan draft kept')
  assert(store.getArtifact(ALICE, r.artifact.id).head === 1, 'head not put back')
})

console.log('\n-- view tokens\' reads, delete --')

await test('the content listener\'s read sees a revision, or only its own holder\'s draft', async () => {
  const r = ok(store.createArtifact(ALICE, { title: 'Live', files: [{ path: 'index.html', content: 'draft!' }] }, { conversationId: 'cl' }))
  const id = r.artifact.id
  assert(store.readForViewToken(id, 'index.html', { revision: 'draft', holderKey: ALICE.id })?.toString() === 'draft!', 'holder cannot see its draft')
  assert(store.readForViewToken(id, 'index.html', { revision: 'draft', holderKey: OWNER.id }) === null, 'another account saw the draft')
  assert(store.readForViewToken(id, 'index.html', { revision: 1 }) === null, 'a revision that does not exist')
  assert(store.readForViewToken(id, '../draft.json', { revision: 'draft', holderKey: ALICE.id }) === null, 'traversal through the token read')
  assert(store.entryForViewToken(id, { revision: 'draft', holderKey: ALICE.id }) === 'index.html', 'no entry')
})

await test('delete moves it to the trash and it is gone from the index', async () => {
  const r = ok(store.createArtifact(ALICE, { title: 'Doomed', files: [{ path: 'a.txt', content: '1' }] }, { sealNow: true }))
  const d = await store.deleteArtifact(ALICE, r.artifact.id)
  assert(d.ok, JSON.stringify(d))
  assert(store.getArtifact(ALICE, r.artifact.id) === null, 'still there')
  const trash = path.join(store.artifactsRoot(), '.trash')
  assert(fs.existsSync(trash) && fs.readdirSync(trash).length > 0, 'not in the trash')
})

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
fs.rmSync(tmpDir, { recursive: true, force: true })
if (failed.length) process.exit(1)
