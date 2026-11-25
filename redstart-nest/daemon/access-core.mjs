'use strict'

// =============================================================================
// Redstart Nest — the shared core of "who may do what" to a shared record
// =============================================================================
// Projects (projects-storage.mjs) and artifacts (artifacts-storage.mjs) are
// both records an account owns and shares with accounts and groups. The parts
// of the decision they have in common live here (artifacts plan D4), so there
// is one owner check, one admin check and one group lookup to audit:
//
//   ownerKeyOf(account)        the key a record's ownerKey is compared with:
//                              the account id, or '_local' with auth off
//   memberRoles(members, acct) the roles the account holds through its own
//                              entry and through its groups' entries
//
// What each kind of record does with those roles differs, and stays with it:
// projects take the highest role (projects-plan D7); artifacts let the most
// specific entry win, so an account entry of 'none' can hide one artifact
// from one project member (artifacts plan §5).
// =============================================================================

import { memoryKey } from './memory-storage.mjs'
import { groupsForAccount } from './groups-storage.mjs'
import { canDo } from './auth.mjs'

/** Ranks for "highest wins". 'none' is below every role. */
export const ROLE_RANK = { none: 0, viewer: 1, editor: 2, admin: 3, owner: 4 }

/**
 * The key a record's ownerKey is compared with, or null when the caller has
 * none (auth on, no account). memoryKey decides: the account id, or '_local'
 * with auth off, which every auth-off caller shares.
 */
export function ownerKeyOf(account) {
  try { return memoryKey(account) } catch { return null }
}

/** May this account manage every project (manageProjects, or the Nest owner)? */
export function managesAllProjects(account) {
  return !!account && canDo(account, 'manageProjects')
}

/**
 * The roles this account holds in a member list: `account` is its own
 * entry's role (or null), `groups` the roles of every entry for a group it is
 * in. Members are `{ type: 'account' | 'group', id, role }`.
 *
 * @param {Array<{ type: string, id: string, role: string }> | undefined} members
 * @param {{ id: string } | null} account
 * @returns {{ account: string | null, groups: string[] }}
 */
export function memberRoles(members, account) {
  const out = { account: /** @type {string | null} */ (null), groups: /** @type {string[]} */ ([]) }
  if (!account || !Array.isArray(members) || members.length === 0) return out
  let groupIds = null
  for (const m of members) {
    if (m?.type === 'account' && m.id === account.id) out.account = m.role
    else if (m?.type === 'group') {
      groupIds ??= new Set(groupsForAccount(account.id).map((g) => g.id))
      if (groupIds.has(m.id)) out.groups.push(m.role)
    }
  }
  return out
}

/** The highest of some roles by ROLE_RANK, or null for none given. @param {Array<string | null>} roles */
export function highestRole(roles) {
  let best = null
  for (const r of roles) {
    if (r == null || !(r in ROLE_RANK)) continue
    if (best === null || ROLE_RANK[r] > ROLE_RANK[best]) best = r
  }
  return best
}
