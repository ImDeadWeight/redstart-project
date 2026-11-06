'use strict'

// =============================================================================
// Redstart Nest — files in tool results, as MCP resource links
// =============================================================================
// chat-tooling Phase 2. A tool that produced a file returns it as MCP's own
// `resource_link` content item, not as a Redstart text convention and not as
// base64. The bytes stay on disk, and the result carries a reference:
//
//   { type: 'resource_link', uri: '/files/download?path=chats/c1/fig-1.png',
//     name: 'fig-1.png', mimeType: 'image/png', size: 41231 }
//
// The uri is the gateway's own per-account download route, relative, so it is
// only meaningful to a client of THIS server (the chat UI resolves it against
// the server it talks to and fetches it with the session). /files/download
// resolves the path inside the caller's own folder, so a link copied into
// another account's hands resolves inside theirs and 404s.
//
// What the MODEL reads is not decided here: the chat UI turns each link into
// one line, `[file: <path>, <mime>, <size>]` (linkText below is the same
// format, for clients and tests that want it), so a model that cannot see
// images never receives bytes, and a chart costs a line of context instead of
// 50 KB of base64 in conversations.json.
// =============================================================================

import * as path from 'path'

export const DOWNLOAD_ROUTE = '/files/download'

const MIME_BY_EXTENSION = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.txt': 'text/plain', '.md': 'text/markdown',
  '.json': 'application/json', '.html': 'text/html', '.py': 'text/x-python',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.parquet': 'application/vnd.apache.parquet',
}

export function mimeFor(filePath) {
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * A resource_link for a file inside the caller's documents folder.
 *
 * @param {string} relPath  '/'-separated, relative to the account's documents root
 * @param {{ bytes?: number, mimeType?: string }} [opts]
 */
export function fileLink(relPath, { bytes, mimeType } = {}) {
  const rel = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '')
  return {
    type: 'resource_link',
    uri: `${DOWNLOAD_ROUTE}?path=${encodeURIComponent(rel)}`,
    name: rel.split('/').pop() || rel,
    mimeType: mimeType ?? mimeFor(rel),
    ...(Number.isFinite(bytes) ? { size: bytes } : {}),
  }
}

/** The path a link of ours refers to, or null for anyone else's link. */
export function linkPath(link) {
  if (link?.type !== 'resource_link' || typeof link.uri !== 'string') return null
  if (!link.uri.startsWith(`${DOWNLOAD_ROUTE}?`)) return null
  const p = new URLSearchParams(link.uri.slice(DOWNLOAD_ROUTE.length + 1)).get('path')
  return p || null
}

export function sizeLabel(bytes) {
  if (!Number.isFinite(bytes)) return 'size unknown'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

/**
 * The model's one-line copy of a link: `[file: <path>, <mime>, <size>]`.
 * Mirrors chat-ui's formatSingleContent; both are pinned by
 * scripts/test-tool-result-links.mjs.
 */
export function linkText(link) {
  const p = linkPath(link)
  if (!p) return `[resource: ${link?.name ?? 'unnamed'} (${link?.uri ?? 'no uri'})]`
  return `[file: ${p}, ${link.mimeType ?? mimeFor(p)}, ${sizeLabel(link.size)}]`
}
