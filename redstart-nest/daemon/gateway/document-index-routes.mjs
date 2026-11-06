'use strict'

// =============================================================================
// Redstart Nest — Gateway /documents/reindex (chat-tooling Phase 5a)
// =============================================================================
// The manual half of rag-plan §4's "mtime-on-access plus a manual button": the
// caller forgets their own index, and the next search_documents rebuilds it
// from their folder. Per account by construction: the account comes from the
// gateway's authenticate(), and the index scope is derived from it, never named
// by the client.
// =============================================================================

import { rebuildIndexFor } from '../document-search-tool.mjs'
import { sendJson } from './http-json.mjs'
import { logEvent } from '../logger.mjs'

export function isDocumentIndexRoute(urlPath) {
  return urlPath === '/documents/reindex'
}

export async function handleDocumentIndexRoute(req, res, urlPath, account) {
  if (urlPath !== '/documents/reindex' || req.method !== 'POST') return false
  try {
    await rebuildIndexFor(account)
    logEvent('documents', 'index_cleared_by_user', {})
    sendJson(res, 200, { ok: true })
  } catch (err) {
    sendJson(res, 500, { error: { message: err.message, type: 'internal_error' } })
  }
  return true
}
