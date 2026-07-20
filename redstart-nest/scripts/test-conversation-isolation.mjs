// =============================================================================
// Unit tests for electron/main/conversations-storage.mjs — per-account
// conversation isolation.
// =============================================================================
// This is a Priority-8 invariant and, in the multi-application ecosystem Core
// is heading toward, a load-bearing one: many apps and many users share a
// single Core, so "a user can never see or touch another user's conversation"
// must be a tested guarantee, not an implementation detail.
//
// conversations-storage.mjs is account-keyed (every read/write is filtered by
// accountId). These tests drive those exported functions directly against a
// throwaway conversations.json, asserting that account B is completely inert
// against account A's data on every path: read, list, update, delete, and
// fork-aware delete.
//
// Pure Node — the only Electron touch is app.getPath('userData'), stubbed by
// auth-test-loader.mjs the same way test-auth.mjs does it. STORAGE_PATH is
// computed at import time, so the temp userData dir must be set BEFORE the
// module is imported.
//
// Run:  node scripts/test-conversation-isolation.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-convo-iso-test-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir

register('./auth-test-loader.mjs', import.meta.url)

const store = await import('../electron/main/conversations-storage.mjs')

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

// Wipe the store between tests so each case starts from a known state.
const STORAGE_FILE = path.join(tmpDir, 'conversations.json')
function reset() {
  fs.rmSync(STORAGE_FILE, { force: true })
}

const ALICE = 'account-alice'
const BOB = 'account-bob'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log(`userData dir: ${tmpDir}`)
console.log('\n-- conversation isolation --')

await test('getConversations returns only the caller\'s conversations', async () => {
  reset()
  store.createConversation(ALICE, { id: 'a1', title: 'Alice one' })
  store.createConversation(ALICE, { id: 'a2', title: 'Alice two' })
  store.createConversation(BOB, { id: 'b1', title: 'Bob one' })

  const alices = store.getConversations(ALICE)
  const bobs = store.getConversations(BOB)
  assert(alices.length === 2, `Alice should see 2, saw ${alices.length}`)
  assert(bobs.length === 1, `Bob should see 1, saw ${bobs.length}`)
  assert(alices.every(c => c.accountId === ALICE), 'Alice list leaked a non-Alice conversation')
  assert(!bobs.some(c => c.id === 'a1' || c.id === 'a2'), 'Bob list leaked an Alice conversation')
})

await test('🔍 getConversation cannot read another account\'s conversation by id', async () => {
  reset()
  store.createConversation(ALICE, { id: 'a1', title: 'Alice secret' })

  assert(store.getConversation(ALICE, 'a1') !== null, 'Alice cannot read her own conversation')
  assert(store.getConversation(BOB, 'a1') === null, 'Bob was able to read Alice\'s conversation by id')
})

await test('🔍 updateConversation cannot modify another account\'s conversation', async () => {
  reset()
  store.createConversation(ALICE, { id: 'a1', title: 'Original' })

  const result = store.updateConversation(BOB, 'a1', { title: 'Hijacked by Bob' })
  assert(result === null, 'updateConversation returned a record for a cross-account write')

  const after = store.getConversation(ALICE, 'a1')
  assert(after.title === 'Original', `Alice's conversation was mutated cross-account: ${after.title}`)
})

await test('🔍 deleteConversation cannot delete another account\'s conversation', async () => {
  reset()
  store.createConversation(ALICE, { id: 'a1', title: 'Alice one' })

  const deleted = store.deleteConversation(BOB, 'a1')
  assert(deleted === false, 'deleteConversation reported success on a cross-account delete')
  assert(store.getConversation(ALICE, 'a1') !== null, 'Alice\'s conversation was deleted by Bob')
})

await test('deleteConversation removes the caller\'s own conversation', async () => {
  reset()
  store.createConversation(ALICE, { id: 'a1', title: 'Alice one' })

  assert(store.deleteConversation(ALICE, 'a1') === true, 'owner could not delete her own conversation')
  assert(store.getConversation(ALICE, 'a1') === null, 'conversation survived its own owner\'s delete')
})

await test('🔍 deleteConversationsWithForks only removes the caller\'s own tree, sparing cross-account forks', async () => {
  reset()
  // Alice owns a root; Bob forked it into his own account. Alice deleting her
  // tree must not reach into Bob's forked copy.
  store.createConversation(ALICE, { id: 'root', title: 'Alice root' })
  store.createConversation(ALICE, { id: 'alice-fork', title: 'Alice fork', forkedFromConversationId: 'root' })
  store.createConversation(BOB, { id: 'bob-fork', title: 'Bob fork', forkedFromConversationId: 'root' })

  store.deleteConversationsWithForks(ALICE, 'root')

  assert(store.getConversation(ALICE, 'root') === null, 'Alice root survived her own fork-delete')
  assert(store.getConversation(ALICE, 'alice-fork') === null, 'Alice fork survived her own fork-delete')
  assert(store.getConversation(BOB, 'bob-fork') !== null, 'Bob\'s fork was deleted by Alice\'s fork-delete')
})

await test('createConversation stamps the owning accountId, ignoring any spoofed value in the payload', async () => {
  reset()
  // A caller who tries to plant someone else's accountId in the conversation
  // body must not be able to write into that account's space — the accountId
  // argument is authoritative.
  const rec = store.createConversation(ALICE, { id: 'a1', title: 'x', accountId: BOB })
  assert(rec.accountId === ALICE, `spoofed accountId won: ${rec.accountId}`)
  assert(store.getConversation(BOB, 'a1') === null, 'spoofed payload accountId landed in Bob\'s space')
  assert(store.getConversation(ALICE, 'a1') !== null, 'conversation not stored under the authoritative account')
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

fs.rmSync(tmpDir, { recursive: true, force: true })

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
