'use strict'

// =============================================================================
// Redstart Nest — Gateway /workflows routes
// =============================================================================
// Backs chat-ui's Workflows page (the sidebar entry beside New chat).
//
//   GET    /workflows                 { personal, org, canEditOrg, limits }
//   POST   /workflows/personal        create one of the caller's own
//   PUT    /workflows/personal/:id    edit one of the caller's own
//   DELETE /workflows/personal/:id
//   POST   /workflows/org             manageOrgWorkflows
//   PUT    /workflows/org/:id         manageOrgWorkflows
//   DELETE /workflows/org/:id         manageOrgWorkflows
//
// Personal routes are scoped to the authenticated account (or the shared
// auth-off scope), never to an id the client names — the same rule as
// /memories. They are not gated by any capability or role: anyone may keep
// their own workflows (plan D5).
//
// Org READ is open to every authenticated account, because an org workflow
// exists to be run by everyone. Org WRITE is the admin permission
// manageOrgWorkflows (permissions.mjs). With auth off the account is null and
// canDo(null) is false, so an auth-off deployment cannot write org workflows
// over HTTP at all; it has one shared personal scope instead.
// =============================================================================

import { canDo } from '../auth.mjs'
import {
  listPersonal, listOrg, createWorkflow, updateWorkflow, deleteWorkflow,
  MAX_INSTRUCTIONS_CHARS, MAX_EXAMPLE_CHARS, MAX_INPUTS, MAX_NAME_CHARS,
  MAX_TITLE_CHARS, MAX_DESCRIPTION_CHARS, MAX_PERSONAL_PER_ACCOUNT, MAX_ORG,
} from '../workflows-storage.mjs'
import { sendJson, readJsonBody } from './http-json.mjs'
import { logEvent } from '../logger.mjs'

const ID = '[A-Za-z0-9-]{1,64}'
const ITEM = new RegExp(`^/workflows/(personal|org)/(${ID})$`)
const COLLECTION = /^\/workflows\/(personal|org)$/

export function isWorkflowRoute(urlPath) {
  return urlPath === '/workflows' || COLLECTION.test(urlPath) || ITEM.test(urlPath)
}

function fail(res, r) {
  const status = r.code === 'not_found' ? 404 : r.code === 'conflict' ? 409 : 400
  const type = r.code === 'not_found' ? 'not_found' : r.code === 'conflict' ? 'conflict' : 'invalid_request_error'
  sendJson(res, status, { error: { message: r.error, type } })
}

export async function handleWorkflowRoute(req, res, urlPath, account) {
  try {
    if (urlPath === '/workflows' && req.method === 'GET') {
      sendJson(res, 200, {
        personal: listPersonal(account),
        org: listOrg(),
        canEditOrg: canDo(account, 'manageOrgWorkflows'),
        limits: {
          maxNameChars: MAX_NAME_CHARS,
          maxTitleChars: MAX_TITLE_CHARS,
          maxDescriptionChars: MAX_DESCRIPTION_CHARS,
          maxInstructionsChars: MAX_INSTRUCTIONS_CHARS,
          maxExampleChars: MAX_EXAMPLE_CHARS,
          maxInputs: MAX_INPUTS,
          maxPersonal: MAX_PERSONAL_PER_ACCOUNT,
          maxOrg: MAX_ORG,
        },
      })
      return true
    }

    const coll = COLLECTION.exec(urlPath)
    const item = coll ? null : ITEM.exec(urlPath)
    const scope = coll?.[1] ?? item?.[1]
    if (!scope) return false

    // Checked before the body is read: a refused writer learns nothing about
    // whether their payload would have validated.
    if (scope === 'org' && req.method !== 'GET' && !canDo(account, 'manageOrgWorkflows')) {
      sendJson(res, 403, { error: { message: 'Your role does not permit "manageOrgWorkflows"', type: 'permission_error' } })
      return true
    }

    if (coll && req.method === 'POST') {
      const body = await readJsonBody(req)
      const r = createWorkflow(account, scope, body)
      if (!r.ok) { fail(res, r); return true }
      logEvent('workflow', 'created', { scope, name: r.workflow.name, account: account?.username ?? undefined })
      sendJson(res, 201, r.workflow)
      return true
    }

    if (item && req.method === 'PUT') {
      const body = await readJsonBody(req)
      const r = updateWorkflow(account, scope, item[2], body)
      if (!r.ok) { fail(res, r); return true }
      logEvent('workflow', 'updated', { scope, name: r.workflow.name, account: account?.username ?? undefined })
      sendJson(res, 200, r.workflow)
      return true
    }

    if (item && req.method === 'DELETE') {
      const removed = deleteWorkflow(account, scope, item[2])
      if (removed) logEvent('workflow', 'deleted', { scope, account: account?.username ?? undefined })
      sendJson(res, removed ? 204 : 404, removed ? undefined : { error: { message: 'Not found', type: 'not_found' } })
      return true
    }

    return false
  } catch (err) {
    sendJson(res, 500, { error: { message: err.message, type: 'internal_error' } })
    return true
  }
}
