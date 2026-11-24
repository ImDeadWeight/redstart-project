// =============================================================================
// Groups, several roles per account, and "only less than you" (2026-11-24)
// =============================================================================
// Pinned here:
//   - a group's roles reach its members, and leaving the group takes them away
//     on the very next check (nothing is cached on a session);
//   - an admin may give, define, or manage only access LESS than their own:
//     no peers, no extra capability, no admin permission they lack — through
//     an account, a role, or a group;
//   - deleting a role or an account cleans every account and group up;
//   - assigning roles that limit apps revokes the account-wide API key (the gap
//     where creation and key regeneration refused but assignment did not);
//   - describeAccess says which role came through which group.
//
// Run:  node scripts/test-groups.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-groups-'))
process.env.REDSTART_TEST_USERDATA_DIR = TEST_DIR
register('./auth-test-loader.mjs', import.meta.url)
await import('./electron-stub.mjs')

const accounts = await import('../daemon/accounts-storage.mjs')
const auth = await import('../daemon/auth.mjs')

const results = []
async function test(name, fn) {
  try {
    reset()
    const detail = await fn()
    results.push({ name, pass: true })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false, detail: err.message })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}
function assert(cond, message) { if (!cond) throw new Error(message) }

function reset() {
  for (const f of ['accounts.json', 'roles.json', 'groups.json', 'sessions.json']) fs.rmSync(path.join(TEST_DIR, f), { force: true })
}

function owner() {
  if (!accounts.hasOwner()) auth.createOwner({ username: 'owner', password: 'owner-pass' })
  return accounts.listAccounts().find(a => a.tier === 'owner')
}
function make(username, roleIds, actor = owner()) {
  const r = auth.createAccount(actor, { username, password: 'pass-1234', roleIds })
  assert(r.ok, `could not create ${username}: ${r.error}`)
  return accounts.findById(r.account.id)
}
function role(name, permissions, actor = owner()) {
  const r = auth.saveRole(actor, { name, permissions })
  assert(r.ok, `could not save ${name}: ${r.error}`)
  return r.role
}

console.log('\n-- groups give their roles to their members --')

await test('🔍 a group role reaches a member, and leaving the group removes it on the next check', async () => {
  const o = owner()
  const pg = role('Databases', { capabilities: ['postgres'] })
  const alice = make('alice', ['restricted'])
  assert(!auth.roleFor(alice).permissions.capabilities.includes('postgres'), 'postgres before joining')
  const g = auth.saveGroup(o, { name: 'Data team', memberIds: [alice.id], roleIds: [pg.id] })
  assert(g.ok, g.error)
  assert(auth.roleFor(alice).permissions.capabilities.includes('postgres'), 'the group role did not reach the member')
  auth.saveGroup(o, { id: g.group.id, name: 'Data team', memberIds: [], roleIds: [pg.id] })
  assert(!auth.roleFor(alice).permissions.capabilities.includes('postgres'), 'leaving the group kept postgres')
})

await test('a group can carry administration', async () => {
  const o = owner()
  const helpdesk = role('Helpdesk', { capabilities: null, admin: { manageAccounts: true } })
  const bob = make('bob', ['full-access'])
  assert(!auth.canDo(bob, 'manageAccounts'), 'admin before joining')
  auth.saveGroup(o, { name: 'IT', memberIds: [bob.id], roleIds: [helpdesk.id] })
  assert(auth.canDo(bob, 'manageAccounts') && auth.hasAdminAccess(bob), 'the group did not make bob an admin')
})

await test('describeAccess names the group a role came through', async () => {
  const o = owner()
  const pg = role('Databases', { capabilities: ['postgres'] })
  const carol = make('carol', ['restricted'])
  auth.saveGroup(o, { name: 'Data team', memberIds: [carol.id], roleIds: [pg.id] })
  const d = auth.describeAccess(o, carol.id)
  assert(d.roles.some(r => r.id === 'restricted' && r.via === null), 'direct role missing')
  assert(d.roles.some(r => r.id === pg.id && r.via?.name === 'Data team'), JSON.stringify(d.roles))
})

console.log('\n-- an admin gives only less than they hold --')

function helpdeskAdmin() {
  const hd = role('Helpdesk', { capabilities: ['documents', 'memory'], webSourceIds: null, admin: { manageAccounts: true, manageRoles: true } })
  return { hd, admin: make('helpdesk', [hd.id]) }
}

await test('🔍 an Administrator cannot create another Administrator, and cannot manage one', async () => {
  const a1 = make('a1', ['administrator'])
  const r = auth.createAccount(a1, { username: 'a2', password: 'pass-1234', roleIds: ['administrator'] })
  assert(!r.ok, 'an Administrator made a peer')
  const a2 = make('a2', ['administrator'])
  assert(!auth.deleteAccount(a1, a2.id).ok, 'an Administrator deleted a peer')
  assert(auth.createAccount(a1, { username: 'u', password: 'pass-1234', roleIds: ['full-access'] }).ok, 'an Administrator could not make a Full Access user')
})

await test('🔍 a limited admin cannot give a capability they lack, directly or through a role', async () => {
  const { admin } = helpdeskAdmin()
  const r1 = auth.createAccount(admin, { username: 'x', password: 'pass-1234', roleIds: ['full-access'] })
  assert(!r1.ok, 'Full Access (everything) given by an admin who holds two capabilities')
  const r2 = auth.saveRole(admin, { name: 'Sneaky', permissions: { capabilities: ['postgres'] } })
  assert(!r2.ok, 'a role granting postgres defined by an admin without it')
  const r3 = auth.saveRole(admin, { name: 'Notes', permissions: { capabilities: ['memory'] } })
  assert(r3.ok, `a role within the admin's own rights was refused: ${r3.error}`)
})

await test('🔍 a limited admin cannot put people in a group that gives more than they hold, or edit a group of peers', async () => {
  const o = owner()
  const { hd, admin } = helpdeskAdmin()
  const victim = make('dave', ['restricted'])
  assert(!auth.saveGroup(admin, { name: 'Everything', memberIds: [victim.id], roleIds: ['full-access'] }).ok, 'group with Full Access made by a limited admin')
  const peer = make('peer', [hd.id])
  const g = auth.saveGroup(o, { name: 'Peers', memberIds: [peer.id], roleIds: [] })
  assert(!auth.saveGroup(admin, { id: g.group.id, name: 'Peers', memberIds: [peer.id], roleIds: ['restricted'] }).ok, 'changed the roles of a group holding a peer')
  assert(!auth.deleteGroup(admin, g.group.id).ok, 'deleted a group holding a peer')
})

await test('🔍 an admin cannot edit or delete a role that grants more than they hold', async () => {
  const o = owner()
  const { admin } = helpdeskAdmin()
  const big = role('Big', { capabilities: ['postgres'] }, o)
  assert(!auth.saveRole(admin, { id: big.id, name: 'Big', permissions: { capabilities: [] } }).ok, 'edited a role above the admin')
  assert(!auth.deleteRole(admin, big.id).ok, 'deleted a role above the admin')
})

await test('the owner holds no roles and cannot be given any', async () => {
  const o = owner()
  assert(!auth.assignRoles(o, o.id, ['restricted']).ok, 'the owner was given a role')
})

console.log('\n-- clean-up --')

await test('deleting a role takes it off every account and group', async () => {
  const o = owner()
  const r = role('Temp', { capabilities: ['git'] })
  const eve = make('eve', [r.id, 'restricted'])
  const g = auth.saveGroup(o, { name: 'G', memberIds: [], roleIds: [r.id] })
  assert(auth.deleteRole(o, r.id).ok, 'delete failed')
  assert(JSON.stringify(accounts.findById(eve.id).roleIds) === '["restricted"]', JSON.stringify(accounts.findById(eve.id).roleIds))
  assert(auth.listGroups().find(x => x.id === g.group.id).roleIds.length === 0, 'the group kept the deleted role')
})

await test('deleting an account takes it out of every group', async () => {
  const o = owner()
  const fay = make('fay', ['restricted'])
  const g = auth.saveGroup(o, { name: 'G', memberIds: [fay.id], roleIds: [] })
  assert(auth.deleteAccount(o, fay.id).ok, 'delete failed')
  assert(auth.listGroups().find(x => x.id === g.group.id).memberIds.length === 0, 'the group kept a deleted account')
})

await test('🔍 roles that limit apps revoke the account-wide API key when assigned', async () => {
  const o = owner()
  const chatOnly = role('Chat only', { capabilities: [], surfaces: ['nest-chat'] })
  const gus = make('gus', ['full-access'])
  assert(accounts.findById(gus.id).apiKeyHash, 'no key to begin with')
  const r = auth.assignRoles(o, gus.id, [chatOnly.id])
  assert(r.ok && r.apiKeyRevoked === true, JSON.stringify(r))
  assert(!accounts.findById(gus.id).apiKeyHash, 'the key that names no app survived')
})

await test('old clients: role "admin" on create becomes Administrator, and the login answer still says admin', async () => {
  const o = owner()
  const r = auth.createAccount(o, { username: 'legacy', password: 'pass-1234', role: 'admin' })
  assert(r.ok && r.account.roleIds.includes('administrator'), JSON.stringify(r))
  const login = auth.login('legacy', 'pass-1234')
  assert(login.user.role === 'admin' && login.user.isAdmin === true, JSON.stringify(login.user))
})

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
fs.rmSync(TEST_DIR, { recursive: true, force: true })
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
