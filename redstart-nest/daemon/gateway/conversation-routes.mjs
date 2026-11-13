'use strict'

// =============================================================================
// Redstart Nest — Gateway /conversations routes
// =============================================================================
// The conversation CRUD surface: list, read, create, update, delete (with the
// optional fork cascade). Every one of them is scoped by the accountId the
// gateway resolved before calling in — this module never inspects a header or
// a token, so there is exactly one place where identity is established and no
// way for a client to name a storage scope it is not.
//
// isConversationRoute() is exported alongside the handler because the gateway
// needs the same predicate one step earlier, to refuse a conversation request
// that carries no identity at all.
//
// This module knows nothing about llama-server, the proxy, or activeConfig.
// It talks only to conversations-storage.mjs.
// =============================================================================

import { getConversations, getConversation as getConv, createConversation, updateConversation, deleteConversation, deleteConversationsWithForks, LOCKED_BY_TASK } from '../conversations-storage.mjs'
import { sendJson, readJsonBody } from './http-json.mjs'
import { getCapabilities } from '../tools-storage.mjs'
import { trashWorkspace } from '../conversation-workspace.mjs'
import { dropKernel } from '../python-tool.mjs'
import { logEvent } from '../logger.mjs'
import { getProject } from '../projects-storage.mjs'
import { dropSuggestions } from '../memory-review-store.mjs'
import { validatePlanSteps } from '../../../shared/agent-core/update-plan.mjs'

// A conversation may name only one of the caller's own projects (projects-
// plan D11), checked on every write that carries the field. null moves it
// out. A foreign or unknown id gets the same answer, so ids cannot be probed.
function projectFieldError(body, account) {
  if (!body || !('projectId' in body) || body.projectId === null) return null
  return getProject(account, body.projectId) ? null : 'projectId does not name one of your projects'
}

// The conversation's plan (agent-runtime plan §4, 1.2): the update_plan
// checklist the client's loop keeps. null clears it. Otherwise the steps go
// through the same check the loop core applies to the model's call, and the
// server stamps updatedAt, so a stored plan is always one the loop could have
// produced. Rewrites body.plan in place to the normalised form.
function planFieldError(body) {
  if (!body || !('plan' in body) || body.plan === null) return null
  const checked = validatePlanSteps(body.plan?.steps)
  if (!checked.ok) return `plan: ${checked.error.replace(/^Error: /, '')}`
  body.plan = { steps: checked.steps, updatedAt: Date.now() }
  return null
}

// A deleted conversation's workspace (chat-tooling plan §2) goes to the trash
// with it, and its Python kernel stops. Diffed from the caller's own list
// rather than taken from the delete call: the fork walk in
// deleteConversationsWithForks visits other accounts' forks too, and only
// spares them at the end, so its id set is not the set that was deleted.
async function retireWorkspaces(account, deletedIds) {
  // A deleted chat's pending memory suggestions go with it (projects-plan D19).
  const gone = new Set(deletedIds)
  try { dropSuggestions(account, (s) => gone.has(s.conversationId)) } catch { /* malformed account: nothing stored */ }
  const documentsRoot = getCapabilities().documents?.outputDir
  for (const id of deletedIds) {
    dropKernel(account, id)
    if (!documentsRoot) continue
    const result = await trashWorkspace(documentsRoot, account, id)
    if (!result.ok) logEvent('workspace', 'trash_failed', { reason: result.error })
  }
}

export function isConversationRoute(urlPath) {
  return urlPath === '/conversations' || /^\/conversations\/[^/]+$/.test(urlPath)
}

// Returns true when the request was handled (a response has been written),
// false when the path is not ours and the gateway should keep dispatching.
export async function handleConversationRoute(req, res, urlPath, accountId, { account = null } = {}) {
  if (req.method === 'GET' && urlPath === '/conversations') {
    const convs = getConversations(accountId)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify(convs))
    return true
  }

  const convMatch = /^\/conversations\/([^/]+)$/.exec(urlPath)
  if (convMatch) {
    const [, convId] = convMatch

    if (req.method === 'GET') {
      const conv = getConv(accountId, convId)
      if (!conv) {
        sendJson(res, 404, { error: { message: 'Not found', type: 'not_found' } })
        return true
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify(conv))
      return true
    }

    if (req.method === 'PUT') {
      const body = await readJsonBody(req)
      if (!body) {
        sendJson(res, 400, { error: { message: 'Bad request', type: 'invalid_request_error' } })
        return true
      }
      const fieldError = projectFieldError(body, account) ?? planFieldError(body)
      if (fieldError) {
        sendJson(res, 400, { error: { message: fieldError, type: 'invalid_request_error' } })
        return true
      }
      const updated = updateConversation(accountId, convId, body)
      // A background task holds this conversation's messages (D25). 409 is
      // chat-ui's cue to reload the conversation rather than fail.
      if (updated === LOCKED_BY_TASK) {
        sendJson(res, 409, { error: { message: 'A background task is writing this conversation. Reload it, or cancel the task.', type: 'conflict', code: 'task_active' } })
        return true
      }
      if (!updated) {
        sendJson(res, 404, { error: { message: 'Not found', type: 'not_found' } })
        return true
      }
      sendJson(res, 200, updated)
      return true
    }

    if (req.method === 'DELETE') {
      const url = new URL(req.url, 'http://x')
      const deleteWithForks = url.searchParams.get('deleteWithForks') === 'true'
      const before = new Set(getConversations(accountId).map((c) => c.id))
      if (deleteWithForks) {
        deleteConversationsWithForks(accountId, convId)
      } else {
        deleteConversation(accountId, convId)
      }
      const after = new Set(getConversations(accountId).map((c) => c.id))
      await retireWorkspaces(account, [...before].filter((id) => !after.has(id)))
      sendJson(res, 204)
      return true
    }
  }

  if (req.method === 'POST' && urlPath === '/conversations') {
    const body = await readJsonBody(req)
    if (!body?.name) {
      sendJson(res, 400, { error: { message: 'Name required', type: 'invalid_request_error' } })
      return true
    }
    const projectError = projectFieldError(body, account)
    if (projectError) {
      sendJson(res, 400, { error: { message: projectError, type: 'invalid_request_error' } })
      return true
    }
    const conv = createConversation(accountId, {
      id: body.id || crypto.randomUUID(),
      name: body.name,
      currNode: body.currNode || '',
      lastModified: Date.now(),
      mcpServerOverrides: body.mcpServerOverrides,
      thinkingEnabled: body.thinkingEnabled,
      reasoningEffort: body.reasoningEffort,
      forkedFromConversationId: body.forkedFromConversationId,
      pinned: body.pinned,
      contextSummary: body.contextSummary,
      projectId: body.projectId || undefined,
      messages: body.messages || []
    })
    sendJson(res, 201, conv)
    return true
  }

  return false
}
