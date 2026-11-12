'use strict'

// =============================================================================
// Redstart Nest — control plane: the decision log and everyone's standing
// grants (agent-runtime plan Phase 2, D13/D14)
// =============================================================================
// Owner-only by the control plane's own gate (admin-listener.mjs,
// mayAccessControlPlane), which runs before any table entry: nothing here
// checks a role again, and nothing here is reachable from the gateway.
//
//   audit:list            the decision log, newest first, paged by `before`
//   approvals:list-grants one account's standing grants, by username
//   approvals:revoke-grant  remove anyone's grant by id (logged, by: owner)
//
// An account's own grants (list, revoke, decide) are on the GATEWAY,
// gateway/approval-routes.mjs. This is the admin's view of all of them.
//
// Table-only, like browse: never registered over IPC, which is retired
// (admin/api-table.mjs explains why that is not drift).
// =============================================================================

import { readPolicyLog, logPolicy } from '../logger.mjs'
import { listGrants, revokeAnyGrant } from '../approval-grants.mjs'
import { findByUsername, findById } from '../accounts-storage.mjs'
import { memoryKey, ANONYMOUS_KEY } from '../memory-storage.mjs'

export function listAudit(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  return readPolicyLog({ limit: o.limit, before: typeof o.before === 'string' ? o.before : undefined })
}

/**
 * @param {string | null} username null: the shared auth-off set
 * @returns {{ ok: true, grants: object[] } | { ok: false, error: string }}
 */
export function listAccountGrants(username) {
  if (username === null || username === undefined || username === '') {
    return { ok: true, grants: listGrants(ANONYMOUS_KEY) }
  }
  if (typeof username !== 'string') return { ok: false, error: 'not a username' }
  const account = findByUsername(username)
  if (!account) return { ok: false, error: 'no such account' }
  return { ok: true, grants: listGrants(memoryKey(account)) }
}

/** @returns {{ ok: true, tool: string } | { ok: false, error: string }} */
export function revokeAccountGrant(id) {
  if (typeof id !== 'string' || !id) return { ok: false, error: 'not a grant id' }
  const removed = revokeAnyGrant(id)
  if (!removed) return { ok: false, error: 'no such grant' }
  const owner = removed.accountKey === ANONYMOUS_KEY ? null : findById(removed.accountKey)
  logPolicy('grant.revoked', {
    account: owner?.username ?? (removed.accountKey === ANONYMOUS_KEY ? '(auth off)' : '(deleted account)'),
    tool: removed.grant.tool,
    grantId: removed.grant.id,
    by: 'owner',
  })
  return { ok: true, tool: removed.grant.tool }
}

export function approvalsHandlers() {
  return {
    'audit:list': (opts) => listAudit(opts),
    'approvals:list-grants': (username) => listAccountGrants(username),
    'approvals:revoke-grant': (id) => revokeAccountGrant(id),
  }
}
