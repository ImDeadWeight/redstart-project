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

import { getConversations, getConversation as getConv, createConversation, updateConversation, deleteConversation, deleteConversationsWithForks } from '../conversations-storage.mjs'
import { sendJson, readJsonBody } from './http-json.mjs'

export function isConversationRoute(urlPath) {
  return urlPath === '/conversations' || /^\/conversations\/[^/]+$/.test(urlPath)
}

// Returns true when the request was handled (a response has been written),
// false when the path is not ours and the gateway should keep dispatching.
export async function handleConversationRoute(req, res, urlPath, accountId) {
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
      const updated = updateConversation(accountId, convId, body)
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
      if (deleteWithForks) {
        deleteConversationsWithForks(accountId, convId)
      } else {
        deleteConversation(accountId, convId)
      }
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
      messages: body.messages || []
    })
    sendJson(res, 201, conv)
    return true
  }

  return false
}
