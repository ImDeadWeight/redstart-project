'use strict'

// =============================================================================
// Redstart Nest — Gateway GET /files/download
// =============================================================================
// Serves files written by the capabilities that produce them — File System
// (write_file) and Documents (create_document) — and is the containment
// boundary for both. Two rules make it safe, and both live here:
//
//   1. The caller is authenticated, then scoped to their OWN folder inside
//      each configured root, so another account's path resolves inside your
//      folder and 404s. There is no ownership comparison to get wrong.
//   2. A path that escapes every root is a containment violation (403); one
//      that resolves inside a root but has no file there is missing (404).
//
// The sibling /files/* explorer surface lives in files-api.mjs; this route
// predates it and stays separate because it is a raw byte stream rather than
// a JSON API.
//
// This module knows nothing about the proxy, the prompt injector, or the
// route table. It is handed the live config and answers one request.
// =============================================================================

import * as path from 'path'
import * as fs from 'fs'
import { authenticate } from '../auth.mjs'
import { resolveWithinRoot } from '../path-scope.mjs'
import { resolveUserRoot } from '../user-scope.mjs'

export function handleDownloadRoute(req, res, config) {
  const authResult = authenticate(req)
  if (!authResult.ok) {
    res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ error: { message: 'Unauthorized', type: 'auth_error' } }))
    return
  }

  // Two capabilities write files a client may need to fetch: File System
  // (write_file) and Documents (create_document). Each has its own root
  // and neither is a subpath of the other, so try both — containment is
  // still enforced per-root by resolveWithinRoot.
  //
  // Scoped to the CALLER'S OWN folder inside each root, matching where
  // the tools now write. This endpoint authenticated the caller and then
  // resolved against the shared roots with no account scoping at all, so
  // any signed-in user could download any other user's files by naming
  // them — and list_documents handed out the names. Scoping it here means
  // another account's path resolves inside your own folder and 404s;
  // there is no ownership comparison to get wrong.
  const scopedRoot = (root) => {
    if (!root) return null
    try {
      return resolveUserRoot(root, authResult.account)
    } catch {
      return null // malformed account — serve nothing rather than the shared root
    }
  }
  const servedRoots = [
    scopedRoot(config?.fileSystem?.rootDir),
    scopedRoot(config?.documents?.outputDir),
  ].filter(Boolean)

  if (servedRoots.length === 0) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ error: { message: 'No file-serving capability is configured', type: 'not_found' } }))
    return
  }

  const url = new URL(req.url, 'http://x')
  const relPath = url.searchParams.get('path')
  if (!relPath) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ error: { message: 'Missing required query parameter: path', type: 'invalid_request_error' } }))
    return
  }

  // A path that escapes EVERY root is a containment violation (403); one
  // that resolves inside a root but has no file there is simply missing
  // (404). Keeping those distinct preserves the endpoint's contract.
  let fullPath = null
  let containedInSomeRoot = false
  for (const root of servedRoots) {
    let candidate
    try {
      candidate = resolveWithinRoot(root, relPath)
    } catch {
      continue // outside this root — try the next
    }
    containedInSomeRoot = true
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      fullPath = candidate
      break
    }
  }

  if (!containedInSomeRoot) {
    res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ error: { message: 'Path is outside the configured file roots', type: 'forbidden' } }))
    return
  }

  if (!fullPath) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ error: { message: 'File not found', type: 'not_found' } }))
    return
  }

  const stat = fs.statSync(fullPath)
  const fileName = path.basename(fullPath)
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${fileName}"`,
    'Access-Control-Allow-Origin': '*',
  })
  const readStream = fs.createReadStream(fullPath)
  readStream.pipe(res)
  readStream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ error: { message: 'Failed to read file', type: 'internal_error' } }))
    }
  })
}
