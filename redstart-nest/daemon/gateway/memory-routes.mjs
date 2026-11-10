'use strict'

// =============================================================================
// Redstart Nest — Gateway /memories routes (chat-tooling Phase 3)
// =============================================================================
// The user's own view of what the assistant remembers about them: list, edit,
// delete. Backs chat-ui's Settings → Memory tab and the Undo on a save chip.
// Plus create, for the composer's /remember command (projects-plan D5): a
// memory the USER typed, so fromWebTurn is always false.
//
// Scoped to the authenticated account (or the shared auth-off scope), never to
// an id the client names: the account comes from the gateway's authenticate()
// call, the same way /files/* and /conversations get theirs.
//
// Reading, editing and deleting are available whether or not the capability
// is on for the caller's profile. A user must always be able to see and delete
// what was saved about them, and that matters most exactly when an admin has
// just switched memory off. CREATING is not: a role that withholds memory
// withholds the prompt block, so a save would be invisible to the model and
// would read as a broken feature. It is refused, against the caller's
// NARROWED config, which the gateway passes in.
// =============================================================================

import { listMemories, saveMemory, updateMemory, deleteMemory } from '../memory-storage.mjs'
import { getProject } from '../projects-storage.mjs'
import { sendJson, readJsonBody } from './http-json.mjs'
import { logEvent } from '../logger.mjs'

export function isMemoryRoute(urlPath) {
  return urlPath === '/memories' || /^\/memories\/[A-Za-z0-9-]{1,64}$/.test(urlPath)
}

const NOT_FOUND = { error: { message: 'Not found', type: 'not_found' } }

/**
 * `?projectId=` selects a project's memories instead of the user's own
 * (projects-plan D13). Resolved through getProject, so only a project the
 * caller may read is reachable; anything else is 404, the same answer as an
 * unknown memory, so project ids cannot be probed.
 *
 * @returns {{ projectId: string | null } | { missing: true }}
 */
function scopeOf(req, account) {
  let claimed = null
  try { claimed = new URL(req.url ?? '/', 'http://x').searchParams.get('projectId') } catch { /* no query */ }
  if (!claimed) return { projectId: null }
  return getProject(account, claimed) ? { projectId: claimed } : { missing: true }
}

export async function handleMemoryRoute(req, res, urlPath, account, { config } = {}) {
  try {
    const isCollection = urlPath === '/memories'
    const m = isCollection ? null : /^\/memories\/([A-Za-z0-9-]{1,64})$/.exec(urlPath)
    if (!isCollection && !m) return false

    const scope = scopeOf(req, account)
    if (scope.missing) { sendJson(res, 404, NOT_FOUND); return true }
    const { projectId } = scope

    if (isCollection && req.method === 'GET') {
      sendJson(res, 200, { memories: listMemories(account, { projectId }) })
      return true
    }
    if (isCollection && req.method === 'POST') {
      if (!config?.memory?.enabled) {
        sendJson(res, 403, { error: { message: 'Memory is turned off for your account', type: 'permission_error' } })
        return true
      }
      const body = await readJsonBody(req)
      const conversationId = typeof body?.conversationId === 'string' && body.conversationId.length <= 128
        ? body.conversationId : null
      const r = saveMemory(account, body?.text, { conversationId, fromWebTurn: false, projectId })
      if (!r.ok) {
        sendJson(res, 400, { error: { message: r.error, type: 'invalid_request_error' } })
        return true
      }
      if (!r.duplicate) logEvent('memory', 'saved_by_user', { project: !!projectId })
      // 200 for a duplicate: nothing was created, and the client shows the
      // same "remembered" toast either way.
      sendJson(res, r.duplicate ? 200 : 201, { ...r.memory, duplicate: r.duplicate === true })
      return true
    }
    if (m) {
      const id = m[1]
      if (req.method === 'DELETE') {
        const removed = deleteMemory(account, id, { projectId })
        if (removed) logEvent('memory', 'deleted_by_user', { project: !!projectId })
        sendJson(res, removed ? 204 : 404, removed ? undefined : NOT_FOUND)
        return true
      }
      if (req.method === 'PUT') {
        const body = await readJsonBody(req)
        const r = updateMemory(account, id, body?.text, { projectId })
        if (!r.ok) {
          sendJson(res, r.error === 'not found' ? 404 : 400, { error: { message: r.error, type: r.error === 'not found' ? 'not_found' : 'invalid_request_error' } })
          return true
        }
        sendJson(res, 200, r.memory)
        return true
      }
    }
    return false
  } catch (err) {
    sendJson(res, 500, { error: { message: err.message, type: 'internal_error' } })
    return true
  }
}
