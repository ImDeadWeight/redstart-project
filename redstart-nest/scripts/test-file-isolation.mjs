// =============================================================================
// Per-account file isolation — user A must not reach user B's files, by ANY route
// =============================================================================
// Priority 1. Before per-account storage, this was a complete cross-account
// read on a live system: list_documents enumerated every readable file in the
// shared documents root to every caller, and GET /files/download authenticated
// the caller and then resolved the path against the shared roots with no
// account scoping at all. Filenames are server-derived slugs
// (quarterly-report.md), so they were guessable even without the listing.
//
// The fix is structural rather than a check: every path resolves inside the
// CALLER'S own folder, so another account's filename simply finds nothing.
// This suite proves that holds on each surface INDEPENDENTLY, because they are
// three different code paths to the same bytes and a suite that tests one and
// assumes the others is how the hole survived in the first place:
//
//   1. MCP tools        — documents (create/read/list), file system, scholar
//   2. GET /files/download — the HTTP path, which the model never touches
//   3. The storage layout itself — B's folder is not inside A's
//
// Mirrors scripts/test-conversation-isolation.mjs, which does the same job for
// conversations.
//
// Run:  node scripts/test-file-isolation.mjs
// =============================================================================

import { registerElectronStub } from './electron-stub-hooks.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const dirs = {
  userData: fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-file-iso-userdata-')),
  docs: fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-file-iso-docs-')),
  fs: fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-file-iso-fs-')),
}
process.env.REDSTART_TEST_USERDATA_DIR = dirs.userData

registerElectronStub()

// Explicit, main-thread trigger for the stub's platform-paths.mjs initialization.
// module.register() hooks run in a separate worker thread, so a side effect
// inside auth-test-loader.mjs itself can't reach this thread's copy of
// platform-paths.mjs -- only an ordinary import, resolved here in the main
// thread, can. Needed because production code no longer imports 'electron'
// at all in several modules this suite exercises, so nothing else would
// trigger the stub's initPaths() call.
await import('./electron-stub.mjs')

const documentsTool = await import('../daemon/documents-tool.mjs')
const { resolveUserRoot, resolveUserScope, userScopePath } = await import('../daemon/user-scope.mjs')

// ---------------------------------------------------------------------------
// Harness (mirrors scripts/test-path-scope.mjs)
// ---------------------------------------------------------------------------

const results = []

async function test(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true, detail })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false, detail: err.message })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}
function eq(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

// Two ordinary accounts, plus one whose username is chosen to try to reach the
// other's folder if the scope were ever built from the username alone.
const ALICE = { id: 'acct-alice-0001', username: 'alice' }
const BOB = { id: 'acct-bob-0002', username: 'bob' }
const HOSTILE = { id: 'acct-mallory-3', username: '../bob' }

const ctx = (account) => ({ account })
const docsCfg = { documents: { enabled: true, outputDir: dirs.docs } }
const textOf = (result) => (result?.content ?? []).map((c) => c.text).join('\n')

async function createDoc(account, title, content) {
  const res = await documentsTool.callTool(
    'create_document',
    { title, content, format: 'markdown' },
    docsCfg,
    ctx(account),
  )
  assert(!res?.isError, `create_document failed for ${account?.username}: ${textOf(res)}`)
  return res
}

// ---------------------------------------------------------------------------
// Storage layout
// ---------------------------------------------------------------------------

console.log('\n-- storage layout: separate folders, neither inside the other --')

await test('each account gets its own folder under the capability root', async () => {
  const a = resolveUserRoot(dirs.docs, ALICE, { create: true })
  const b = resolveUserRoot(dirs.docs, BOB, { create: true })
  assert(a !== b, 'both accounts resolved to the same folder')
  assert(path.relative(dirs.docs, a).startsWith('user_files'), `alice's root escaped: ${a}`)
  assert(path.relative(dirs.docs, b).startsWith('user_files'), `bob's root escaped: ${b}`)
  return `${path.basename(a)} vs ${path.basename(b)}`
})

await test('🔍 neither account\'s folder is nested inside the other', async () => {
  // If B's root were a subpath of A's, every containment check would pass while
  // still granting A access to B's files.
  const a = resolveUserRoot(dirs.docs, ALICE, { create: true })
  const b = resolveUserRoot(dirs.docs, BOB, { create: true })
  assert(path.relative(a, b).startsWith('..'), `bob's root is inside alice's: ${b}`)
  assert(path.relative(b, a).startsWith('..'), `alice's root is inside bob's: ${a}`)
})

await test('🔍 a username crafted to traverse cannot land in another account\'s folder', async () => {
  const hostile = resolveUserRoot(dirs.docs, HOSTILE, { create: true })
  const bob = resolveUserRoot(dirs.docs, BOB, { create: true })
  assert(hostile !== bob, 'a hostile username reached another account\'s folder')
  assert(path.relative(dirs.docs, hostile).startsWith('user_files'), `escaped the root: ${hostile}`)
  assert(!userScopePath(HOSTILE).includes('..'), `scope path contains ..: ${userScopePath(HOSTILE)}`)
  return resolveUserScope(HOSTILE)
})

// ---------------------------------------------------------------------------
// Surface 1 — MCP document tools
// ---------------------------------------------------------------------------

console.log('\n-- surface 1: MCP document tools --')

await createDoc(ALICE, 'Alice Secret Plan', 'alice-confidential-contents')
await createDoc(BOB, 'Bob Notes', 'bob-contents')

await test('a document created by one account lands in that account\'s folder', async () => {
  const aliceRoot = resolveUserRoot(dirs.docs, ALICE)
  const files = fs.readdirSync(aliceRoot)
  assert(files.includes('alice-secret-plan.md'), `not in alice's folder: ${files.join(', ')}`)
  assert(!fs.existsSync(path.join(dirs.docs, 'alice-secret-plan.md')), 'the file was written to the SHARED root')
})

await test('🔍 list_documents shows only the caller\'s own files', async () => {
  const res = await documentsTool.callTool('list_documents', {}, docsCfg, ctx(BOB))
  const listing = textOf(res)
  assert(listing.includes('bob-notes'), `bob cannot see his own file: ${listing}`)
  assert(!listing.includes('alice-secret-plan'), `LEAK — bob sees alice's document: ${listing}`)
})

await test('🔍 read_document cannot read another account\'s file by name', async () => {
  // The exact attack the old code allowed: names are predictable server-derived
  // slugs, so knowing the title is enough.
  const res = await documentsTool.callTool(
    'read_document',
    { path: 'alice-secret-plan.md' },
    docsCfg,
    ctx(BOB),
  )
  assert(res?.isError, `LEAK — bob read alice's document: ${textOf(res)}`)
  assert(!textOf(res).includes('alice-confidential'), `LEAK — contents returned: ${textOf(res)}`)
})

await test('🔍 read_document cannot traverse into another account\'s folder', async () => {
  const aliceScope = resolveUserScope(ALICE)
  for (const attempt of [
    `../${aliceScope}/alice-secret-plan.md`,
    `../../user_files/${aliceScope}/alice-secret-plan.md`,
    `..\\${aliceScope}\\alice-secret-plan.md`,
    path.join(resolveUserRoot(dirs.docs, ALICE), 'alice-secret-plan.md'),
  ]) {
    const res = await documentsTool.callTool('read_document', { path: attempt }, docsCfg, ctx(BOB))
    assert(res?.isError, `LEAK via "${attempt}": ${textOf(res)}`)
    assert(!textOf(res).includes('alice-confidential'), `LEAK — contents via "${attempt}"`)
  }
})

await test('an account can still read its OWN documents', async () => {
  // Isolation that also breaks the feature is not a fix.
  const res = await documentsTool.callTool(
    'read_document',
    { path: 'alice-secret-plan.md' },
    docsCfg,
    ctx(ALICE),
  )
  assert(!res?.isError, `alice cannot read her own document: ${textOf(res)}`)
  assert(textOf(res).includes('alice-confidential'), `unexpected contents: ${textOf(res)}`)
})

await test('read_document opens a file attached to the caller\'s conversation by its name alone', async () => {
  // Agent bench, 2026-11-11: the most common tool error on both models, and
  // two tasks ended with "the file was never attached".
  const ws = path.join(resolveUserRoot(dirs.docs, ALICE, { create: true }), 'chats', 'conv-alice-1')
  fs.mkdirSync(path.join(ws, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'readings.csv'), 'attached-to-conv-1')
  fs.writeFileSync(path.join(ws, 'sub', 'notes.txt'), 'nested-in-conv-1')
  fs.writeFileSync(path.join(ws, 'alice-secret-plan.md'), 'the-workspace-copy')
  const inConv = { account: ALICE, conversationId: 'conv-alice-1' }
  const read = async (p, c) => documentsTool.callTool('read_document', { path: p }, docsCfg, c)

  assert(textOf(await read('readings.csv', inConv)).includes('attached-to-conv-1'), 'bare name not found')
  assert(textOf(await read('sub/notes.txt', inConv)).includes('nested-in-conv-1'), 'nested path not found')
  assert(textOf(await read('chats/conv-alice-1/readings.csv', inConv)).includes('attached-to-conv-1'), 'the full path stopped working')
  // A path that exists in the documents folder still means that file.
  assert(textOf(await read('alice-secret-plan.md', inConv)).includes('alice-confidential'), 'the workspace copy shadowed the document')
  // No conversation, another conversation, a malformed id: not found, as before.
  for (const c of [ctx(ALICE), { account: ALICE, conversationId: 'conv-alice-2' }, { account: ALICE, conversationId: '../conv-alice-1' }]) {
    const res = await read('readings.csv', c)
    assert(res?.isError && textOf(res).includes('File not found: readings.csv'), `found without its conversation (${c.conversationId}): ${textOf(res)}`)
  }
})

await test('🔍 the conversation fallback never reaches another account\'s workspace', async () => {
  // Bob sends Alice's conversation id. mcp-server.mjs would have refused it
  // (verifiedConversationId); even past that check, the path is resolved in
  // BOB's folder, where no such workspace exists.
  const res = await documentsTool.callTool('read_document', { path: 'readings.csv' }, docsCfg, { account: BOB, conversationId: 'conv-alice-1' })
  assert(res?.isError, `LEAK — bob read alice's attachment: ${textOf(res)}`)
  for (const attempt of ['../conv-alice-1/readings.csv', '../../alice-secret-plan.md']) {
    const out = await documentsTool.callTool('read_document', { path: attempt }, docsCfg, { account: ALICE, conversationId: 'conv-alice-2' })
    assert(out?.isError, `"${attempt}" climbed out of the workspace: ${textOf(out)}`)
  }
})

await test('a File System "no such file" on an attached file says where the file is and which tool reaches it', async () => {
  // Agent bench, 2026-11-11: read_text_file("budget.csv") came back as a bare
  // ENOENT and the model told the user the file was never attached.
  const { attachmentHint, withAttachmentHint } = await import('../daemon/filesystem-mcp-provider.mjs')
  const cfg = { ...docsCfg, python: { enabled: true } }
  const inConv = { account: ALICE, conversationId: 'conv-alice-1' } // holds readings.csv (above)
  const enoent = (p) => `ENOENT: no such file or directory, open '${p}'`

  const hint = attachmentHint(enoent('readings.csv'), { path: 'readings.csv' }, cfg, inConv)
  assert(/^\("readings\.csv" is a file in this conversation's workspace/.test(hint ?? ''), `no hint: ${hint}`)
  assert(hint.includes('read_document("readings.csv")') && hint.includes('run_python'), `tools not named: ${hint}`)
  // move_file's arguments, and read_multiple_files' list
  assert(attachmentHint(enoent('readings.csv'), { source: 'readings.csv', destination: 'r.csv' }, cfg, inConv), 'source not checked')
  assert(attachmentHint(enoent('x'), { paths: ['nope.txt', 'sub/notes.txt'] }, cfg, inConv)?.includes('"sub/notes.txt"'), 'paths not checked')
  // The path list_documents prints, given to a File System tool
  const viaPrefix = attachmentHint(enoent('x'), { path: 'chats/conv-alice-1/new.txt', content: 'x' }, cfg, inConv)
  assert(viaPrefix?.startsWith("(chats/conv-alice-1/ is this conversation's workspace"), `prefix: ${viaPrefix}`)
  // Python off: not named
  assert(!attachmentHint(enoent('readings.csv'), { path: 'readings.csv' }, docsCfg, inConv).includes('run_python'), 'named a tool that is off')

  // Silent when it would be wrong: a name that is not attached, another error,
  // no conversation, another conversation, another account, Documents off.
  eq(attachmentHint(enoent('typo.csv'), { path: 'typo.csv' }, cfg, inConv), null, 'a name that is nowhere')
  eq(attachmentHint('EACCES: permission denied', { path: 'readings.csv' }, cfg, inConv), null, 'not a missing file')
  eq(attachmentHint(enoent('readings.csv'), { path: 'readings.csv' }, cfg, ctx(ALICE)), null, 'no conversation')
  eq(attachmentHint(enoent('readings.csv'), { path: 'readings.csv' }, cfg, { account: ALICE, conversationId: 'conv-alice-2' }), null, 'another conversation')
  eq(attachmentHint(enoent('readings.csv'), { path: 'readings.csv' }, cfg, { account: BOB, conversationId: 'conv-alice-1' }), null, 'another account')
  eq(attachmentHint(enoent('readings.csv'), { path: 'readings.csv' }, { python: { enabled: true } }, inConv), null, 'Documents off')
  eq(attachmentHint(enoent('x'), { path: '../../../etc/passwd' }, cfg, inConv), null, 'a path that climbs out')

  // On the result: added to an error, never to a success.
  const err = { isError: true, content: [{ type: 'text', text: enoent('readings.csv') }] }
  const out = withAttachmentHint(err, { path: 'readings.csv' }, cfg, inConv)
  eq(textOf(out).split('\n').length, 2, 'the error, then the hint')
  assert(textOf(out).startsWith(enoent('readings.csv')), 'the original error was changed')
  const fine = { content: [{ type: 'text', text: 'ENOENT appears in this file' }] }
  assert(withAttachmentHint(fine, { path: 'readings.csv' }, cfg, inConv) === fine, 'a success was touched')
})

await test('🔍 a File System error never names a folder outside the caller\'s own', async () => {
  // Agent bench, 2026-11-11, write_file under a folder that did not exist:
  // "ENOENT: no such file or directory, chdir 'E:\...\redstart-nest\shell' -> 'chats\x'".
  const { pathsToRelative } = await import('../daemon/filesystem-mcp-provider.mjs')
  const root = resolveUserRoot(dirs.fs, ALICE, { create: true })
  const err = (text) => textOf(pathsToRelative({ isError: true, content: [{ type: 'text', text }] }, root))
  for (const leaked of ['E:\\redstart-project\\redstart-nest\\shell', '/opt/redstart/nest', '\\\\server\\share\\nest']) {
    const out = err(`ENOENT: no such file or directory, chdir '${leaked}' -> 'chats\\conv-1'`)
    assert(!out.includes(leaked), `LEAK — the server's folder reached the model: ${out}`)
    assert(out.includes("-> 'chats\\conv-1'") && out.startsWith('ENOENT'), `the rest of the error was lost: ${out}`)
  }
  // The caller's own paths stay, relative as before.
  eq(err(`ENOENT: no such file or directory, open '${path.join(root, 'notes', 'a.txt')}'`), `ENOENT: no such file or directory, open 'notes${path.sep}a.txt'`, 'own path')
  // A success is the user's own content: left alone.
  const fine = pathsToRelative({ content: [{ type: 'text', text: "see '/etc/hosts' and 'C:\\Windows'" }] }, root)
  eq(textOf(fine), "see '/etc/hosts' and 'C:\\Windows'", 'a successful result was rewritten')
})

await test('two accounts can hold the same filename without collision', async () => {
  await createDoc(ALICE, 'Shared Title', 'alice-version')
  await createDoc(BOB, 'Shared Title', 'bob-version')
  const aliceRead = await documentsTool.callTool('read_document', { path: 'shared-title.md' }, docsCfg, ctx(ALICE))
  const bobRead = await documentsTool.callTool('read_document', { path: 'shared-title.md' }, docsCfg, ctx(BOB))
  assert(textOf(aliceRead).includes('alice-version'), `alice got: ${textOf(aliceRead)}`)
  assert(textOf(bobRead).includes('bob-version'), `bob got: ${textOf(bobRead)}`)
})

await test('files already in the shared root are not served to anyone', async () => {
  // Pre-existing content is left on disk untouched (that folder is often the
  // machine owner's real Documents directory), but serving it to every account
  // is the exposure this change closes.
  fs.writeFileSync(path.join(dirs.docs, 'legacy-report.md'), 'pre-existing', 'utf8')
  const res = await documentsTool.callTool('list_documents', {}, docsCfg, ctx(ALICE))
  assert(!textOf(res).includes('legacy-report'), `LEAK — shared-root file listed: ${textOf(res)}`)
  assert(fs.existsSync(path.join(dirs.docs, 'legacy-report.md')), 'the legacy file was moved or deleted')
})

// ---------------------------------------------------------------------------
// Auth-off
// ---------------------------------------------------------------------------

console.log('\n-- auth off: a defined folder, not the shared root --')

await test('🔍 with auth off, writes land in the anonymous folder, never the capability root', async () => {
  await createDoc(null, 'Anonymous Note', 'anon-contents')
  const anonRoot = resolveUserRoot(dirs.docs, null)
  assert(fs.existsSync(path.join(anonRoot, 'anonymous-note.md')), 'not written to the anonymous folder')
  assert(!fs.existsSync(path.join(dirs.docs, 'anonymous-note.md')), 'written to the SHARED root')
})

await test('an authenticated account cannot see anonymous-mode files', async () => {
  const res = await documentsTool.callTool('list_documents', {}, docsCfg, ctx(ALICE))
  assert(!textOf(res).includes('anonymous-note'), `LEAK — alice sees anon files: ${textOf(res)}`)
})

// ---------------------------------------------------------------------------
// Surface 2 — GET /files/download
// ---------------------------------------------------------------------------

console.log('\n-- surface 2: GET /files/download --')

const { startGateway, stopGateway, updateGatewayConfig } = await import('../daemon/tools-gateway.mjs')
const { setAuthRequired, createOwner, createAccount, login } = await import('../daemon/auth.mjs')

const GATEWAY_PORT = 48097

setAuthRequired(true)
// The owner is bootstrapped over IPC in production (no HTTP route by design),
// so seed it directly the way test-auth.mjs does, then create the second
// account through the normal admin path.
const owner = createOwner({ username: 'alice', password: 'alice-password-1' })
assert(owner.ok, `could not seed the owner account: ${owner.error}`)
const created = createAccount(owner.account, { username: 'bob', password: 'bob-password-1', role: 'user' })
assert(created.ok, `could not create the second account: ${created.error}`)

const aliceToken = login('alice', 'alice-password-1').token
const bobToken = login('bob', 'bob-password-1').token

// Real accounts have server-generated ids, so seed their folders through the
// same helper the endpoint uses rather than assuming the fixture ids above.
const realAlice = { id: owner.account.id, username: 'alice' }
const realBob = { id: created.account.id, username: 'bob' }
const aliceDownloadRoot = resolveUserRoot(dirs.docs, realAlice, { create: true })
resolveUserRoot(dirs.docs, realBob, { create: true })
fs.writeFileSync(path.join(aliceDownloadRoot, 'private.md'), 'alice-download-secret', 'utf8')

await startGateway(GATEWAY_PORT, {
  documents: { enabled: true, outputDir: dirs.docs },
  fileSystem: { enabled: true, rootDir: dirs.fs },
  webFetch: { enabled: false, whitelistEnabled: true, allowedBaseUrls: [], activeTools: [], maxFetchTokens: 2000 },
})
updateGatewayConfig({
  documents: { enabled: true, outputDir: dirs.docs },
  fileSystem: { enabled: true, rootDir: dirs.fs },
  webFetch: { enabled: false, whitelistEnabled: true, allowedBaseUrls: [], activeTools: [], maxFetchTokens: 2000 },
})

const download = (token, relPath) =>
  fetch(`http://127.0.0.1:${GATEWAY_PORT}/files/download?path=${encodeURIComponent(relPath)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })

await test('an account can download its own file', async () => {
  const res = await download(aliceToken, 'private.md')
  assert(res.status === 200, `expected 200, got ${res.status}`)
  assert((await res.text()).includes('alice-download-secret'), 'contents did not come back')
})

await test('🔍 another account cannot download it by name', async () => {
  // The live hole: authenticated, then resolved against the SHARED root.
  const res = await download(bobToken, 'private.md')
  assert(res.status !== 200, `LEAK — bob downloaded alice's file (${res.status})`)
  assert(!(await res.text()).includes('alice-download-secret'), 'LEAK — contents returned')
})

await test('🔍 another account cannot traverse to it', async () => {
  const aliceScope = path.basename(aliceDownloadRoot)
  for (const attempt of [
    `../${aliceScope}/private.md`,
    `../../user_files/${aliceScope}/private.md`,
    path.join(aliceDownloadRoot, 'private.md'),
  ]) {
    const res = await download(bobToken, attempt)
    assert(res.status !== 200, `LEAK via "${attempt}" (${res.status})`)
    assert(!(await res.text()).includes('alice-download-secret'), `LEAK — contents via "${attempt}"`)
  }
})

await test('🔍 a tool-result resource link (Phase 2) serves its owner and 404s for anyone else', async () => {
  // The exact URI a tool hands back: fileLink() from tool-result-links.mjs,
  // pointing into a conversation workspace.
  const { fileLink } = await import('../daemon/tool-result-links.mjs')
  const ws = path.join(aliceDownloadRoot, 'chats', 'conv-1')
  fs.mkdirSync(ws, { recursive: true })
  fs.writeFileSync(path.join(ws, 'fig-1.png'), 'alice-figure-bytes')
  const link = fileLink('chats/conv-1/fig-1.png', { bytes: 18 })
  const get = (token) => fetch(`http://127.0.0.1:${GATEWAY_PORT}${link.uri}`, { headers: { Authorization: `Bearer ${token}` } })
  const own = await get(aliceToken)
  assert(own.status === 200 && (await own.text()) === 'alice-figure-bytes', `owner got ${own.status}`)
  const other = await get(bobToken)
  assert(other.status !== 200, `LEAK — bob fetched alice's linked figure (${other.status})`)
  assert(!(await other.text()).includes('alice-figure-bytes'), 'LEAK — contents returned')
})

await test('an unauthenticated download is still rejected', async () => {
  const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/files/download?path=private.md`)
  assert(res.status === 401, `expected 401, got ${res.status}`)
})

// ---------------------------------------------------------------------------
// Surface 3 — the file explorer API
// ---------------------------------------------------------------------------

console.log('\n-- surface 3: file explorer API --')

const api = (token, path, init = {}) =>
  fetch(`http://127.0.0.1:${GATEWAY_PORT}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  })

const postJson = (token, path, body) =>
  api(token, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

fs.writeFileSync(path.join(aliceDownloadRoot, 'explorer-secret.md'), 'alice-explorer-secret', 'utf8')

await test('an account can list its own storage', async () => {
  const res = await api(aliceToken, '/files/list?space=documents&path=.')
  assert(res.status === 200, `expected 200, got ${res.status}`)
  const body = await res.json()
  assert(body.entries.some((e) => e.name === 'explorer-secret.md'), `own file missing: ${JSON.stringify(body.entries)}`)
})

await test('🔍 listing shows only the caller\'s own files, never another account\'s', async () => {
  const res = await api(bobToken, '/files/list?space=documents&path=.')
  const body = await res.json()
  const names = (body.entries ?? []).map((e) => e.name)
  assert(!names.includes('explorer-secret.md'), `LEAK — bob sees alice's file: ${names.join(', ')}`)
  assert(!names.includes('private.md'), `LEAK — bob sees alice's file: ${names.join(', ')}`)
})

await test('🔍 listing cannot traverse into another account\'s folder', async () => {
  const aliceScope = path.basename(aliceDownloadRoot)
  for (const attempt of ['..', `../${aliceScope}`, '../..', aliceDownloadRoot]) {
    const res = await api(bobToken, `/files/list?space=documents&path=${encodeURIComponent(attempt)}`)
    assert(res.status === 403 || res.status === 404, `traversal via "${attempt}" returned ${res.status}`)
  }
})

await test('🔍 preview cannot read another account\'s file', async () => {
  const res = await api(bobToken, '/files/preview?space=documents&path=explorer-secret.md')
  assert(res.status !== 200, `LEAK — bob previewed alice's file (${res.status})`)
  assert(!(await res.text()).includes('alice-explorer-secret'), 'LEAK — contents returned')
})

await test('🔍 delete cannot remove another account\'s file', async () => {
  const victim = path.join(aliceDownloadRoot, 'explorer-secret.md')
  for (const attempt of ['explorer-secret.md', `../${path.basename(aliceDownloadRoot)}/explorer-secret.md`, victim]) {
    await postJson(bobToken, '/files/delete', { space: 'documents', path: attempt })
    assert(fs.existsSync(victim), `ALICE'S FILE WAS DELETED via "${attempt}"`)
  }
})

await test('🔍 rename cannot move a file out of the caller\'s storage', async () => {
  // A rename has TWO path arguments; checking only the source would let the
  // destination write anywhere.
  const escapes = [
    { from: 'private.md', to: '../escaped.md' },
    { from: 'private.md', to: path.join(dirs.docs, 'escaped.md') },
    { from: '../' + path.basename(aliceDownloadRoot) + '/explorer-secret.md', to: 'stolen.md' },
  ]
  for (const body of escapes) {
    const res = await postJson(bobToken, '/files/rename', { space: 'documents', ...body })
    assert(res.status !== 200, `rename escaped via ${JSON.stringify(body)} (${res.status})`)
  }
  assert(!fs.existsSync(path.join(dirs.docs, 'escaped.md')), 'A FILE ESCAPED THE STORAGE ROOT')
})

await test('rename moves an item into another folder (what drag-and-drop does)', async () => {
	// The explorer's drag-to-move reuses this endpoint rather than adding a
	// second path-handling code path, so a move is just a rename with a
	// different parent.
	const bobRoot = resolveUserRoot(dirs.docs, realBob, { create: true })
	fs.mkdirSync(path.join(bobRoot, 'archive'), { recursive: true })
	fs.writeFileSync(path.join(bobRoot, 'movable.md'), 'move me', 'utf8')

	const res = await postJson(bobToken, '/files/rename', {
		space: 'documents',
		from: 'movable.md',
		to: 'archive/movable.md',
	})
	assert(res.status === 200, `expected 200, got ${res.status} ${await res.text()}`)
	assert(fs.existsSync(path.join(bobRoot, 'archive', 'movable.md')), 'the file did not arrive')
	assert(!fs.existsSync(path.join(bobRoot, 'movable.md')), 'the file is still at its old path')
})

await test('🔍 a folder cannot be moved inside itself', async () => {
	// One drag gesture away in the explorer: drop a folder onto a folder it
	// contains. fs.renameSync answers that with a bare EINVAL, which would
	// surface as an unexplained 500 rather than a reason.
	const bobRoot = resolveUserRoot(dirs.docs, realBob, { create: true })
	fs.mkdirSync(path.join(bobRoot, 'outer', 'inner'), { recursive: true })

	for (const to of ['outer/inner/outer', 'outer/outer']) {
		const res = await postJson(bobToken, '/files/rename', { space: 'documents', from: 'outer', to })
		assert(res.status === 400, `moving outer -> ${to} returned ${res.status}, expected 400`)
	}
	assert(fs.existsSync(path.join(bobRoot, 'outer', 'inner')), 'the folder was damaged')
})

await test('an account can delete its own file, recoverably', async () => {
  const own = path.join(resolveUserRoot(dirs.docs, realBob, { create: true }), 'bobs-own.md')
  fs.writeFileSync(own, 'bob content', 'utf8')
  const res = await postJson(bobToken, '/files/delete', { space: 'documents', path: 'bobs-own.md' })
  assert(res.status === 200, `expected 200, got ${res.status}`)
  const body = await res.json()
  assert(body.recoverable, 'the response does not say the delete is recoverable')
  assert(!fs.existsSync(own), 'the file is still at its original path')
})

await test('the storage root itself cannot be deleted or renamed', async () => {
  const bobRoot = resolveUserRoot(dirs.docs, realBob)
  for (const [route, body] of [
    ['/files/delete', { space: 'documents', path: '.' }],
    ['/files/rename', { space: 'documents', from: '.', to: 'renamed' }],
  ]) {
    const res = await postJson(bobToken, route, body)
    assert(res.status !== 200, `${route} accepted the storage root (${res.status})`)
  }
  assert(fs.existsSync(bobRoot), 'THE STORAGE ROOT WAS REMOVED')
})

await test('an unknown storage space is refused', async () => {
  // `space` selects a capability root server-side; an unvalidated value would be
  // a way to name a config path the caller was never granted.
  for (const space of ['vault', 'git', '../', '__proto__', 'constructor']) {
    const res = await api(bobToken, `/files/list?space=${encodeURIComponent(space)}`)
    assert(res.status === 400 || res.status === 404, `space "${space}" returned ${res.status}`)
  }
})

await test('every explorer route requires authentication', async () => {
  const unauth = (p, init) => fetch(`http://127.0.0.1:${GATEWAY_PORT}${p}`, init)
  for (const [p, init] of [
    ['/files/list?space=documents', {}],
    ['/files/preview?space=documents&path=private.md', {}],
    ['/files/spaces', {}],
    ['/files/delete', { method: 'POST', body: '{}' }],
    ['/files/rename', { method: 'POST', body: '{}' }],
    ['/files/mkdir', { method: 'POST', body: '{}' }],
    ['/files/upload?space=documents&name=x.txt', { method: 'POST', body: 'x' }],
  ]) {
    const res = await unauth(p, init)
    assert(res.status === 401, `${p} did not require auth (${res.status})`)
  }
})

console.log('\n-- surface 3: upload limits (the first non-model write path) --')

const upload = (token, name, body, dir = '.') =>
  api(token, `/files/upload?space=documents&path=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`, {
    method: 'POST',
    body,
  })

await test('a normal upload lands in the caller\'s own storage', async () => {
  const res = await upload(bobToken, 'notes.txt', 'hello from bob')
  assert(res.status === 201, `expected 201, got ${res.status} ${await res.text()}`)
  const bobRoot = resolveUserRoot(dirs.docs, realBob)
  assert(fs.readFileSync(path.join(bobRoot, 'notes.txt'), 'utf8') === 'hello from bob', 'contents differ')
  assert(!fs.existsSync(path.join(dirs.docs, 'notes.txt')), 'the upload landed in the SHARED root')
})

await test('🔍 executable file types are refused', async () => {
  for (const name of ['payload.exe', 'script.bat', 'run.ps1', 'x.cmd', 'a.vbs', 'b.js', 'c.sh', 'd.lnk', 'UPPER.EXE']) {
    const res = await upload(bobToken, name, 'MZ')
    assert(res.status === 415, `${name} was accepted (${res.status})`)
  }
})

await test('🔍 an upload cannot traverse out of the caller\'s storage', async () => {
  // Both halves are attacked: the name (stripped to a basename) and the
  // directory (re-checked by containment).
  for (const [name, dir] of [
    ['../escaped.txt', '.'],
    ['..\\escaped.txt', '.'],
    ['ok.txt', '..'],
    ['ok.txt', `../${path.basename(aliceDownloadRoot)}`],
    [path.join(dirs.docs, 'escaped.txt'), '.'],
  ]) {
    const res = await upload(bobToken, name, 'x', dir)
    assert(res.status !== 201, `escaped via name="${name}" dir="${dir}" (${res.status})`)
  }
  assert(!fs.existsSync(path.join(dirs.docs, 'escaped.txt')), 'A FILE ESCAPED THE STORAGE ROOT')
  assert(!fs.existsSync(path.join(aliceDownloadRoot, 'ok.txt')), 'A FILE LANDED IN ANOTHER ACCOUNT\'S FOLDER')
})

await test('an oversized upload is refused even when Content-Length lies', async () => {
  const { UPLOAD_LIMITS } = await import('../daemon/files-api.mjs')
  const tooBig = Buffer.alloc(UPLOAD_LIMITS.maxBytes + 1024, 0x61)
  const res = await upload(bobToken, 'huge.txt', tooBig)
  assert(res.status === 413, `expected 413, got ${res.status}`)
  const bobRoot = resolveUserRoot(dirs.docs, realBob)
  assert(!fs.existsSync(path.join(bobRoot, 'huge.txt')), 'the oversized file was written anyway')
})

await test('an upload does not silently overwrite an existing file', async () => {
  const res = await upload(bobToken, 'notes.txt', 'different content')
  assert(res.status === 409, `expected 409, got ${res.status}`)
  const bobRoot = resolveUserRoot(dirs.docs, realBob)
  assert(fs.readFileSync(path.join(bobRoot, 'notes.txt'), 'utf8') === 'hello from bob', 'the original was overwritten')
})

await test('an empty upload is refused', async () => {
  const res = await upload(bobToken, 'empty.txt', '')
  assert(res.status === 400, `expected 400, got ${res.status}`)
})

stopGateway()
// Let the closed sockets finish unwinding before the process tears down. Node's
// fetch keeps connections alive, and exiting mid-close aborts the process with a
// libuv handle assertion on win32 — which would read as a suite failure.
await new Promise((resolve) => setTimeout(resolve, 100))

// ---------------------------------------------------------------------------
// Cleanup + summary
// ---------------------------------------------------------------------------

for (const dir of Object.values(dirs)) fs.rmSync(dir, { recursive: true, force: true })

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
process.exit(0)
