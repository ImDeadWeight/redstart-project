'use strict'

// =============================================================================
// Redstart Nest — Gateway /artifacts routes (artifacts plan §12)
// =============================================================================
// What the web UI uses to list, open, share and manage artifacts. The tools
// (artifacts-tool.mjs) make and change content; sharing, handing over,
// restoring and deleting happen ONLY here (D8), so an instruction injected
// into a page the model read has nothing to call.
//
//   GET    /artifacts                 ?scope=mine|shared|project&projectId&query
//   POST   /artifacts                 { title, kind, projectId?, from?, files? } (UI "New" / fork)
//   GET    /artifacts/:id             record + role + files + url
//   PATCH  /artifacts/:id             { title?, description? }          editor+
//   DELETE /artifacts/:id             → trash                           owner, admin
//   PUT    /artifacts/:id/access      { projectAccess?, members? }      owner, admin
//   POST   /artifacts/:id/transfer    { accountId }                     owner, admin
//   GET    /artifacts/:id/revisions
//   POST   /artifacts/:id/revisions/:n/restore                          editor+
//   POST   /artifacts/:id/seal        { conversationId? }  the client's turn ended
//   POST   /artifacts/:id/view        { revision? | 'draft', report? } → { url, expiresAt, revision }
//   GET    /artifacts/:id/export.zip  ?revision
//   GET    /artifacts/:id/source/<path>  ?revision — one file as text/plain,
//                                     for the viewer's source view; NEVER as
//                                     HTML on this origin (nosniff)
//
// An id the caller cannot read answers 404, not 403 (ids cannot be probed);
// one they can read but not change answers 403.
//
// Every link is Nest's to build (D13): `url` is the chat app's page for the
// artifact on the origin the caller used, and a view's `url` is on the
// content origin (artifact-origin.mjs).
// =============================================================================

import {
  listArtifacts, getArtifact, getManifest, createArtifact, renameArtifact, deleteArtifact,
  setArtifactAccess, transferArtifact, listRevisions, restoreRevision, sealArtifact, readArtifactFile,
  isArtifactId, KINDS, MAX_FILES, MAX_FILE_BYTES, MAX_REVISION_BYTES, MAX_TITLE_CHARS, MAX_MEMBERS,
} from '../artifacts-storage.mjs'
import { issueViewToken, isEmbedderOrigin } from '../artifact-view-tokens.mjs'
import { contentOriginFor } from '../artifact-origin.mjs'
import { artifactContentTarget } from '../lan.mjs'
import { ownerKeyOf } from '../access-core.mjs'
import { listAccounts as listAccountRecords } from '../accounts-storage.mjs'
import { createZip } from '../zip.mjs'
import { ARTIFACT_CONTENT_PORT } from '../ports.mjs'
import { sendJson } from './http-json.mjs'
import { logEvent } from '../logger.mjs'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const ITEM = new RegExp(`^/artifacts/(${UUID})$`)
const SUB = new RegExp(`^/artifacts/(${UUID})/(access|transfer|revisions|seal|view|export\\.zip)$`)
const RESTORE = new RegExp(`^/artifacts/(${UUID})/revisions/(\\d{1,6})/restore$`)
const SOURCE = new RegExp(`^/artifacts/(${UUID})/source/(.+)$`)

/** Request bodies here are small JSON, except a UI create with files. */
const MAX_BODY_BYTES = MAX_REVISION_BYTES * 2

export function isArtifactRoute(urlPath) {
  return urlPath === '/artifacts' || ITEM.test(urlPath) || SUB.test(urlPath) || RESTORE.test(urlPath) || SOURCE.test(urlPath)
}

async function readBody(req, max = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > max) return { tooLarge: true }
    chunks.push(chunk)
  }
  try { return { body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } } catch { return { body: null } }
}

const NOT_FOUND = { error: { message: 'Not found', type: 'not_found' } }

function fail(res, r) {
  const status = r.code === 'not_found' ? 404 : r.code === 'forbidden' ? 403 : r.code === 'busy' ? 409 : r.code === 'too_large' ? 413 : 400
  const type = { 404: 'not_found', 403: 'permission_error', 409: 'conflict', 413: 'too_large' }[status] ?? 'invalid_request_error'
  sendJson(res, status, { error: { message: r.error, type } })
}

const FORWARDED_HOST = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/
const firstValue = (raw) => typeof raw === 'string' ? raw.split(',')[0].trim() || null : null

/** The chat app's origin as the caller reached it (the same reading as builtInMcpUrl). */
export function appOrigin(headers) {
  const proto = firstValue(headers['x-forwarded-proto'])?.toLowerCase()
  const host = (proto === 'http' || proto === 'https') ? (firstValue(headers['x-forwarded-host']) ?? headers.host) : headers.host
  const safeHost = typeof host === 'string' && FORWARDED_HOST.test(host) ? host : '127.0.0.1'
  return `${proto === 'https' ? 'https' : 'http'}://${safeHost}`
}

/** The chat app's page for one artifact. Nest builds every link (D13). */
export const pageUrl = (headers, id) => `${appOrigin(headers)}/#/artifacts/${id}`

const nameOf = (key) => key === '_local' ? null : (listAccountRecords().find((a) => a.id === key)?.username ?? null)
const view = (art, headers) => ({ ...art, ownerName: nameOf(art.ownerKey), url: pageUrl(headers, art.id) })

/**
 * Issue a view token and its URL. Exported for the tool provider's
 * artifact_check, which needs the same URL the viewer gets.
 * @returns {{ ok: true, url: string, expiresAt: number, revision: number | 'draft', origin: string } | { ok: false, code?: string, error: string }}
 */
export function viewUrlFor(account, id, { revision, report = false, headers = {}, embedder = null, now = Date.now() } = {}) {
  const m = getManifest(account, id, { revision })
  if (!m.ok) return m
  if (m.source === 0) return { ok: false, code: 'not_found', error: 'This artifact has nothing to show yet.' }
  if (!m.entry) return { ok: false, code: 'not_found', error: 'This artifact has no .html or .svg file to open.' }
  const where = contentOriginFor(headers, artifactContentTarget(), ARTIFACT_CONTENT_PORT)
  if (!where.origin) return { ok: false, code: 'unavailable', error: where.reason }
  const { token, expiresAt } = issueViewToken({
    artifactId: id, revision: m.source, accountKey: ownerKeyOf(account),
    origin: isEmbedderOrigin(embedder) ? embedder : null, report, now,
  })
  return { ok: true, url: `${where.origin}/a/${token}/${m.entry.split('/').map(encodeURIComponent).join('/')}`, expiresAt, revision: m.source, origin: where.origin }
}

export async function handleArtifactRoute(req, res, urlPath, account) {
  try {
    const query = new URL(req.url ?? '/', 'http://x').searchParams

    if (urlPath === '/artifacts' && req.method === 'GET') {
      const scope = ['mine', 'shared', 'project'].includes(query.get('scope') ?? '') ? query.get('scope') : undefined
      sendJson(res, 200, {
        artifacts: listArtifacts(account, { scope, projectId: query.get('projectId') || undefined, query: query.get('query') || undefined }).map((a) => view(a, req.headers)),
        limits: { kinds: KINDS, maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES, maxRevisionBytes: MAX_REVISION_BYTES, maxTitleChars: MAX_TITLE_CHARS, maxMembers: MAX_MEMBERS },
      })
      return true
    }

    if (urlPath === '/artifacts' && req.method === 'POST') {
      const { body, tooLarge } = await readBody(req, MAX_BODY_BYTES)
      if (tooLarge) { fail(res, { code: 'too_large', error: 'That is too large for one artifact.' }); return true }
      if (!body) { fail(res, { error: 'Expected a JSON body' }); return true }
      const r = createArtifact(account, { title: body.title, kind: body.kind, description: body.description, files: body.files, from: body.from }, { projectId: typeof body.projectId === 'string' ? body.projectId : null, sealNow: true })
      if (!r.ok) { fail(res, r); return true }
      logEvent('artifact', 'created', { account: account?.username ?? undefined, via: 'ui', forked: !!body.from, placedIn: r.placedIn })
      sendJson(res, 201, { ...view(r.artifact, req.headers), placedIn: r.placedIn, projectRefused: r.projectRefused })
      return true
    }

    const restore = RESTORE.exec(urlPath)
    if (restore) {
      if (req.method !== 'POST') return false
      const r = restoreRevision(account, restore[1], Number(restore[2]))
      if (!r.ok) { fail(res, r); return true }
      logEvent('artifact', 'restored', { account: account?.username ?? undefined, from: Number(restore[2]), to: r.revision })
      sendJson(res, 200, { ...view(r.artifact, req.headers), revision: r.revision })
      return true
    }

    const source = SOURCE.exec(urlPath)
    if (source) {
      if (req.method !== 'GET') return false
      let rel
      try { rel = decodeURIComponent(source[2]) } catch { fail(res, { error: 'Bad path' }); return true }
      const rev = query.get('revision')
      const r = readArtifactFile(account, source[1], rel, { revision: rev === null ? undefined : rev === 'draft' ? 'draft' : Number(rev) })
      if (!r.ok) { fail(res, r); return true }
      // Text, never rendered: an artifact's HTML must not run on this origin.
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'private, no-store',
        'Content-Length': r.data.length,
        'Access-Control-Allow-Origin': '*',
      })
      res.end(r.data)
      return true
    }

    const sub = SUB.exec(urlPath)
    if (sub) {
      const [, id, what] = sub
      if (what === 'access' && req.method === 'PUT') {
        const { body } = await readBody(req)
        const r = setArtifactAccess(account, id, body ?? {})
        if (!r.ok) { fail(res, r); return true }
        logEvent('artifact', 'shared', { account: account?.username ?? undefined, projectAccess: r.artifact.projectAccess, members: r.artifact.members.length })
        sendJson(res, 200, view(r.artifact, req.headers))
        return true
      }
      if (what === 'transfer' && req.method === 'POST') {
        const { body } = await readBody(req)
        const r = transferArtifact(account, id, body?.accountId)
        if (!r.ok) { fail(res, r); return true }
        logEvent('artifact', 'transferred', { account: account?.username ?? undefined })
        sendJson(res, 200, view(r.artifact, req.headers))
        return true
      }
      if (what === 'revisions' && req.method === 'GET') {
        const r = listRevisions(account, id)
        if (!r.ok) { fail(res, r); return true }
        sendJson(res, 200, { revisions: r.revisions.map((x) => ({ ...x, byName: x.by ? nameOf(x.by) : null })), head: r.head })
        return true
      }
      if (what === 'seal' && req.method === 'POST') {
        const { body } = await readBody(req)
        const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : body?.conversationId === null ? null : undefined
        const r = sealArtifact(account, id, { conversationId })
        if (!r.ok) { fail(res, r); return true }
        if (r.sealed) logEvent('artifact', 'sealed', { revision: r.revision })
        sendJson(res, 200, { sealed: r.sealed, reason: r.reason ?? null, revision: r.revision })
        return true
      }
      if (what === 'view' && req.method === 'POST') {
        const { body } = await readBody(req)
        const revision = body?.revision === 'draft' ? 'draft' : Number.isInteger(body?.revision) ? body.revision : undefined
        const embedder = typeof req.headers.origin === 'string' ? req.headers.origin : null
        const r = viewUrlFor(account, id, { revision, report: body?.report === true, headers: req.headers, embedder })
        if (!r.ok) {
          if (r.code === 'unavailable') { sendJson(res, 503, { error: { message: r.error, type: 'unavailable' } }); return true }
          fail(res, r); return true
        }
        sendJson(res, 200, { url: r.url, expiresAt: r.expiresAt, revision: r.revision })
        return true
      }
      if (what === 'export.zip' && req.method === 'GET') {
        const rev = query.get('revision')
        const m = getManifest(account, id, { revision: rev === null ? undefined : rev === 'draft' ? 'draft' : Number(rev) })
        if (!m.ok) { fail(res, m); return true }
        const files = {}
        for (const f of m.files) {
          const r = readArtifactFile(account, id, f.path, { revision: m.source === 0 ? undefined : m.source })
          if (r.ok) files[f.path] = r.data
        }
        const zip = createZip(files)
        const safe = m.artifact.title.replace(/[^A-Za-z0-9 ._-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'artifact'
        const label = m.source === 'draft' ? 'draft' : `r${m.source}`
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${safe}-${label}.zip"`,
          'Content-Length': zip.length,
          'Cache-Control': 'private, no-store',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'Content-Disposition',
        })
        res.end(zip)
        return true
      }
      return false
    }

    const item = ITEM.exec(urlPath)
    if (!item) return false
    const id = item[1]
    if (req.method === 'GET') {
      const art = getArtifact(account, id)
      if (!art) { sendJson(res, 404, NOT_FOUND); return true }
      const m = getManifest(account, id)
      sendJson(res, 200, { ...view(art, req.headers), files: m.ok ? m.files : [], entry: m.ok ? m.entry : null, source: m.ok ? m.source : 0 })
      return true
    }
    if (req.method === 'PATCH') {
      const { body } = await readBody(req)
      const r = renameArtifact(account, id, body ?? {})
      if (!r.ok) { fail(res, r); return true }
      sendJson(res, 200, view(r.artifact, req.headers))
      return true
    }
    if (req.method === 'DELETE') {
      if (!isArtifactId(id)) { sendJson(res, 404, NOT_FOUND); return true }
      const r = await deleteArtifact(account, id)
      if (!r.ok) { fail(res, r); return true }
      logEvent('artifact', 'deleted', { account: account?.username ?? undefined })
      sendJson(res, 200, { deleted: true, hint: r.hint })
      return true
    }
    return false
  } catch (err) {
    sendJson(res, 500, { error: { message: err.message, type: 'internal_error' } })
    return true
  }
}
