// =============================================================================
// Invariant tests for electron/main/user-scope.mjs — per-account storage names
// =============================================================================
// Priority 1 (path traversal). This module turns an account into the directory
// name that account's files live under. It is the FIRST of the two containment
// layers for per-user storage:
//
//     resolveWithinRoot(capabilityRoot, userScopePath(account))   <- this module
//     resolveWithinRoot(userRoot, modelSuppliedPath)              <- path-scope
//
// The threat here is different from path-scope's. There the hostile input is a
// path from the model; here it is the USERNAME — and usernames are not
// validated for charset anywhere in the account system (createAccount checks
// uniqueness and nothing else). So an account called "../../../etc", "CON", or
// "x." is creatable today, and the moment its name became a directory name it
// would be a traversal primitive or an un-creatable folder.
//
// Every test below is a username or id that must NOT be able to escape, collide
// or fail to create. The rule that makes this hold is structural rather than
// filter-based: the scope is always "<slug>-<id>", the slug is reduced to
// [a-z0-9-], and the id suffix means the result can never equal a Windows
// reserved device name.
//
// Pure module (crypto only, nothing electron), no server.
//
// Run:  node scripts/test-user-scope.mjs
// =============================================================================

import * as path from 'node:path'
import {
  ANONYMOUS_SCOPE,
  USER_FILES_DIR,
  resolveUserScope,
  userScopePath,
} from '../electron/main/user-scope.mjs'

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

const account = (username, id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890') => ({ id, username })

// Windows refuses to create a file or directory with any of these names, with
// or without an extension. A scope that produced one would break that account's
// storage entirely on the platform Redstart primarily runs on.
const WIN32_RESERVED = [
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]

// ---------------------------------------------------------------------------
// Hostile usernames
// ---------------------------------------------------------------------------

console.log('\n-- hostile usernames cannot escape or break the scope --')

const HOSTILE_USERNAMES = [
  '../../../etc',
  '..',
  '../',
  '..\\..\\windows\\system32',
  'C:\\Windows',
  '/etc/passwd',
  'a/b/c',
  'a\\b\\c',
  'CON',
  'con',
  'PRN.txt',
  'NUL',
  'COM1',
  'LPT9',
  'trailing.',
  'trailing ',
  ' leading',
  '.hidden',
  '...',
  '',
  '   ',
  '!!!',
  '\u0000null-byte',
  'emoji-🙂-user',
  '\u202Ereverse-override',
  'ünïcödé',
  'UPPER',
  'a'.repeat(500),
  'user name with spaces',
  '-leading-hyphen',
  'trailing-hyphen-',
]

await test('🔍 no hostile username produces a path separator', async () => {
  for (const username of HOSTILE_USERNAMES) {
    const scope = resolveUserScope(account(username))
    assert(!scope.includes('/'), `"${username}" -> "${scope}" contains a forward slash`)
    assert(!scope.includes('\\'), `"${username}" -> "${scope}" contains a backslash`)
    assert(!scope.includes('\0'), `"${username}" -> "${scope}" contains a NUL byte`)
  }
  return `${HOSTILE_USERNAMES.length} usernames`
})

await test('🔍 no hostile username escapes when joined to a root', async () => {
  // The real test of containment: join the scope to a root and confirm the
  // result is still inside it. Uses path.resolve/relative rather than string
  // comparison so ".." is actually collapsed the way the OS would collapse it.
  const root = process.platform === 'win32' ? 'C:\\redstart\\Documents' : '/srv/redstart/Documents'
  for (const username of HOSTILE_USERNAMES) {
    const full = path.resolve(root, userScopePath(account(username)))
    const rel = path.relative(root, full)
    assert(
      rel !== '' && !path.isAbsolute(rel) && !rel.startsWith('..'),
      `"${username}" escaped: ${full}`,
    )
  }
})

await test('🔍 no scope is a Windows reserved device name', async () => {
  // Structurally impossible — every scope is "<slug>-<id>" and no reserved name
  // contains a hyphen — but asserted because that is a load-bearing property of
  // the format, not an accident, and a future "drop the id when it's redundant"
  // optimisation would silently break it.
  const reserved = new Set(WIN32_RESERVED.map((n) => n.toLowerCase()))
  for (const username of HOSTILE_USERNAMES) {
    const scope = resolveUserScope(account(username)).toLowerCase()
    assert(!reserved.has(scope), `"${username}" -> reserved device name "${scope}"`)
    assert(!reserved.has(scope.split('.')[0]), `"${username}" -> reserved base name "${scope}"`)
  }
})

await test('every scope is a single non-empty segment of safe characters', async () => {
  for (const username of HOSTILE_USERNAMES) {
    const scope = resolveUserScope(account(username))
    assert(scope.length > 0, `"${username}" produced an empty scope`)
    assert(/^[a-z0-9-]+$/.test(scope), `"${username}" -> "${scope}" has unsafe characters`)
    assert(!scope.endsWith('.') && !scope.endsWith(' '), `"${username}" -> "${scope}" ends with . or space (invalid on win32)`)
  }
})

await test('a very long username does not produce an unbounded path segment', async () => {
  const scope = resolveUserScope(account('a'.repeat(5000)))
  assert(scope.length <= 64, `scope is ${scope.length} chars — deep paths would hit MAX_PATH`)
  return `${scope.length} chars`
})

// ---------------------------------------------------------------------------
// Identity: distinct accounts get distinct folders
// ---------------------------------------------------------------------------

console.log('\n-- accounts are distinguished by ID, not by display name --')

await test('🔍 two accounts whose usernames slugify identically do NOT collide', async () => {
  // The reason the id is in the name at all. "Pat Carswell", "pat-carswell" and
  // "pat.carswell" all slugify to the same thing; sharing a folder would mean
  // sharing files.
  const a = resolveUserScope({ id: 'id-one', username: 'Pat Carswell' })
  const b = resolveUserScope({ id: 'id-two', username: 'pat-carswell' })
  const c = resolveUserScope({ id: 'id-three', username: 'pat.carswell' })
  assert(new Set([a, b, c]).size === 3, `collision: ${a}, ${b}, ${c}`)
})

await test('the same account always resolves to the same scope', async () => {
  const a = resolveUserScope(account('patrick'))
  const b = resolveUserScope(account('patrick'))
  assert(a === b, `not deterministic: ${a} vs ${b}`)
})

await test('a rename keeps the account identifiable by its id fragment', async () => {
  // Renaming changes the readable half but not the id half, so an admin can
  // still tell which folder belongs to which account after a rename.
  const before = resolveUserScope({ id: 'stable-id-1234', username: 'oldname' })
  const after = resolveUserScope({ id: 'stable-id-1234', username: 'newname' })
  assert(before !== after, 'the slug did not follow the rename')
  const idFragment = before.split('-').pop()
  assert(after.endsWith(idFragment), `id fragment changed on rename: ${before} -> ${after}`)
})

await test('an unsafe or absurd id still yields a safe fragment', async () => {
  for (const id of ['../../etc', '!!!', 'x', '\u0000', 'C:\\x']) {
    const scope = resolveUserScope({ id, username: 'someone' })
    assert(/^[a-z0-9-]+$/.test(scope), `id ${JSON.stringify(id)} -> unsafe scope "${scope}"`)
    assert(!scope.includes('/') && !scope.includes('\\'), `id ${JSON.stringify(id)} escaped`)
  }
})

await test('different unsafe ids do not all collapse to the same scope', async () => {
  // Sanitising an id down to nothing and falling back to a constant would put
  // every such account in one shared folder — the hash fallback exists to stop
  // exactly that.
  const a = resolveUserScope({ id: '!!!', username: 'someone' })
  const b = resolveUserScope({ id: '???', username: 'someone' })
  assert(a !== b, `both unsafe ids produced "${a}"`)
})

// ---------------------------------------------------------------------------
// Auth-off
// ---------------------------------------------------------------------------

console.log('\n-- auth-off has a defined scope, not an accidental one --')

await test('🔍 a null account resolves to the named anonymous scope, never the root', async () => {
  // authenticate() returns account: null when auth is disabled. If that fell
  // through to "no subfolder", writes would land in the capability root — which
  // is today's behaviour by accident, and is the shared-space problem this whole
  // change exists to end.
  for (const value of [null, undefined]) {
    const scope = resolveUserScope(value)
    assert(scope === ANONYMOUS_SCOPE, `${JSON.stringify(value)} -> "${scope}", expected "${ANONYMOUS_SCOPE}"`)
    assert(scope.length > 0, 'anonymous scope is empty — writes would hit the capability root')
  }
})

await test('🔍 an account with no usable id THROWS rather than joining the anonymous scope', async () => {
  // "No identity at all" (auth off) and "an account that should have an id but
  // doesn't" are different failures. Treating the second as the first would put
  // a real user's files in the folder shared by every auth-off write and every
  // other malformed account — a cross-account leak arriving through a fallback
  // nobody would think to audit.
  for (const value of [{}, { username: 'no-id' }, { id: '', username: 'x' }, { id: '   ', username: 'x' }, { id: 42 }]) {
    let threw = false
    try {
      resolveUserScope(value)
    } catch {
      threw = true
    }
    assert(threw, `${JSON.stringify(value)} silently resolved instead of throwing`)
  }
})

await test('the anonymous scope cannot be impersonated by a real account', async () => {
  // A user named "_local" must not land in the anonymous folder. The id suffix
  // is what prevents it — the leading underscore is stripped by the slugifier,
  // so this asserts the id half is doing the work.
  const scope = resolveUserScope(account('_local'))
  assert(scope !== ANONYMOUS_SCOPE, `an account claimed the anonymous scope: "${scope}"`)
})

await test('userScopePath nests every scope under the user_files folder', async () => {
  assert(userScopePath(null) === `${USER_FILES_DIR}/${ANONYMOUS_SCOPE}`, `unexpected: ${userScopePath(null)}`)
  assert(
    userScopePath(account('patrick')).startsWith(`${USER_FILES_DIR}/`),
    `unexpected: ${userScopePath(account('patrick'))}`,
  )
  return userScopePath(account('patrick'))
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
