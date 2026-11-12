'use strict'

// =============================================================================
// Redstart Nest — gateway routes for approvals and standing grants (agent-
// runtime plan Phase 2, D12/D13)
// =============================================================================
// The account's own view. Every route acts on the caller's scope only: the
// account id, or the shared '_local' set with auth off (memory-storage's
// memoryKey). An admin's view of everyone's is on the control plane
// (ipc/approvals.mjs).
//
//   POST   /approvals/:id            { decision: 'once' | 'always' | 'deny' }
//          Decide a pending approval the MCP server handed out (D12).
//          'always' on a 'prompt' tool also adds a standing grant; on an
//          'always' tool (destructive) it counts as once.
//   GET    /approvals/grants         the caller's standing grants
//   POST   /approvals/grants         { tool }  "Always allow" from a card
//   DELETE /approvals/grants/:id     revoke one
//   POST   /approvals/grants/import  { tools: string[] }  chat-ui's one-time
//          import of its old localStorage set; anything not 'prompt' is
//          dropped, so a stale "always" for a delete cannot come back.
//
// Logged to the decision log (logger.mjs logPolicy): a deny, and every grant
// added or revoked. Never arguments.
// =============================================================================

import { sendJson, readJsonBody } from './http-json.mjs'
import { decide } from '../approval-ledger.mjs'
import { listGrants, addGrant, revokeGrant } from '../approval-grants.mjs'
import { approvalRule } from '../tools-definitions.mjs'
import { memoryKey } from '../memory-storage.mjs'
import { logPolicy } from '../logger.mjs'
import { APPROVAL_DECISIONS } from '../../../shared/agent-core/approval.mjs'

const NOT_FOUND = { error: { message: 'Not found', type: 'not_found' } }
const bad = (message) => ({ error: { message, type: 'invalid_request_error' } })
const MAX_IMPORT = 200
const DECIDE = /^\/approvals\/([A-Za-z0-9-]{1,64})$/
const GRANT = /^\/approvals\/grants\/([A-Za-z0-9-]{1,64})$/

export function isApprovalRoute(urlPath) {
  return urlPath === '/approvals/grants' || urlPath === '/approvals/grants/import' || GRANT.test(urlPath) || DECIDE.test(urlPath)
}

const who = (account) => account?.username ?? '(auth off)'

function grantAdded(account, grant, source) {
  logPolicy('grant.added', { account: who(account), tool: grant.tool, grantId: grant.id, source })
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} urlPath
 * @param {object | null} account null only with auth off
 * @returns {Promise<boolean>} false: not ours
 */
export async function handleApprovalRoute(req, res, urlPath, account) {
  const key = memoryKey(account)
  try {
    if (urlPath === '/approvals/grants') {
      if (req.method === 'GET') {
        sendJson(res, 200, { grants: listGrants(key) })
        return true
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        const r = addGrant(key, body?.tool, { source: 'card' })
        if (!r.ok) { sendJson(res, 400, bad(r.error)); return true }
        if (r.created) grantAdded(account, r.grant, 'card')
        sendJson(res, r.created ? 201 : 200, r.grant)
        return true
      }
      return false
    }

    if (urlPath === '/approvals/grants/import') {
      if (req.method !== 'POST') return false
      const body = await readJsonBody(req)
      const tools = Array.isArray(body?.tools) ? body.tools.filter((t) => typeof t === 'string').slice(0, MAX_IMPORT) : null
      if (!tools) { sendJson(res, 400, bad('Expected { tools: [...] }')); return true }
      const imported = []
      const dropped = []
      for (const tool of new Set(tools)) {
        const r = addGrant(key, tool, { source: 'import' })
        if (!r.ok) { dropped.push(tool); continue }
        imported.push(tool)
        if (r.created) grantAdded(account, r.grant, 'import')
      }
      sendJson(res, 200, { imported, dropped })
      return true
    }

    const g = GRANT.exec(urlPath)
    if (g) {
      if (req.method !== 'DELETE') return false
      const removed = revokeGrant(key, g[1])
      if (!removed) { sendJson(res, 404, NOT_FOUND); return true }
      logPolicy('grant.revoked', { account: who(account), tool: removed.tool, grantId: removed.id, by: who(account) })
      sendJson(res, 204)
      return true
    }

    const d = DECIDE.exec(urlPath)
    if (d) {
      if (req.method !== 'POST') return false
      const body = await readJsonBody(req)
      const decision = body?.decision
      if (!APPROVAL_DECISIONS.includes(decision)) { sendJson(res, 400, bad(`decision must be one of ${APPROVAL_DECISIONS.join(', ')}`)); return true }
      const r = decide(d[1], key, decision)
      // 'not found' covers another account's id and an expired one: a prober
      // learns nothing from the difference.
      if (!r.ok) { sendJson(res, r.error === 'not found' ? 404 : 409, r.error === 'not found' ? NOT_FOUND : bad(r.error)); return true }
      let grant = null
      if (decision === 'deny') {
        logPolicy('approval.denied', { account: who(account), tool: r.tool, decision })
      } else if (decision === 'always' && approvalRule(r.tool) === 'prompt') {
        const added = addGrant(key, r.tool, { source: 'card' })
        if (added.ok) {
          grant = added.grant
          if (added.created) grantAdded(account, added.grant, 'card')
        }
      }
      sendJson(res, 200, { ok: true, tool: r.tool, grant })
      return true
    }

    return false
  } catch (err) {
    sendJson(res, 500, { error: { message: err.message, type: 'internal_error' } })
    return true
  }
}
