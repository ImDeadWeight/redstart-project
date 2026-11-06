'use strict'

// =============================================================================
// Redstart Nest — Gateway /memories routes (chat-tooling Phase 3)
// =============================================================================
// The user's own view of what the assistant remembers about them: list, edit,
// delete. Backs chat-ui's Settings → Memory tab and the Undo on a save chip.
//
// Scoped to the authenticated account (or the shared auth-off scope), never to
// an id the client names: the account comes from the gateway's authenticate()
// call, the same way /files/* and /conversations get theirs.
//
// Available whether or not the capability is on for the caller's profile. A
// user must always be able to see and delete what was saved about them, and
// that matters most exactly when an admin has just switched memory off.
// =============================================================================

import { listMemories, updateMemory, deleteMemory } from '../memory-storage.mjs'
import { sendJson, readJsonBody } from './http-json.mjs'
import { logEvent } from '../logger.mjs'

export function isMemoryRoute(urlPath) {
  return urlPath === '/memories' || /^\/memories\/[A-Za-z0-9-]{1,64}$/.test(urlPath)
}

export async function handleMemoryRoute(req, res, urlPath, account) {
  try {
    if (urlPath === '/memories' && req.method === 'GET') {
      sendJson(res, 200, { memories: listMemories(account) })
      return true
    }
    const m = /^\/memories\/([A-Za-z0-9-]{1,64})$/.exec(urlPath)
    if (m) {
      const id = m[1]
      if (req.method === 'DELETE') {
        const removed = deleteMemory(account, id)
        if (removed) logEvent('memory', 'deleted_by_user', {})
        sendJson(res, removed ? 204 : 404, removed ? undefined : { error: { message: 'Not found', type: 'not_found' } })
        return true
      }
      if (req.method === 'PUT') {
        const body = await readJsonBody(req)
        const r = updateMemory(account, id, body?.text)
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
