'use strict'

// =============================================================================
// Redstart Nest — Gateway /work-items routes (tasks plan Phase 1)
// =============================================================================
// The tasks people give each other. Under /work-items, not /tasks: /tasks was
// the assistant's background jobs and is still their alias (job-routes.mjs),
// so an old client's job call must never reach this API.
//
//   GET    /work-items/mine        ?include=done ?today=YYYY-MM-DD
//                                  { items, counts: { open, overdue }, limits }
//   GET    /work-items/count       ?today=  { open, overdue } — the sidebar badge
//   GET    /work-items/created     ?include=done  tasks I made with no project
//   GET    /work-items/assignees   ?projectId=  who a task can be given to
//   GET    /work-items             ?projectId= (required) ?include=deleted
//   POST   /work-items             { title, notes?, projectId?, assignee?, dueDate?, status? }
//   GET    /work-items/:id         one task, with its history
//   PATCH  /work-items/:id         any of title, notes, status, dueDate, assignee, projectId
//   DELETE /work-items/:id         marks it deleted (restorable for 30 days)
//   POST   /work-items/:id/claim   a member of the assigned group takes it
//   POST   /work-items/:id/release hands a claimed task back to its group
//   POST   /work-items/:id/restore
//
// Access is decided only by work-items-storage (accessOf there). A task the
// caller may not see answers 404, not 403, so ids cannot be probed; one they
// may see but not change answers 403. Each task in a response carries `can`,
// so a client never works the rules out for itself.
//
// This is the contract a later planning client (Greenhouse) uses too:
// documented in docs/connector-contract.md.
// =============================================================================

import {
  listMine, listCreated, listForProject, listAssignees, getWorkItem, createWorkItem, updateWorkItem,
  claimWorkItem, releaseWorkItem, deleteWorkItem, restoreWorkItem, countMine, isDate,
  MAX_TITLE_CHARS, MAX_NOTES_CHARS, MAX_ITEMS_PER_PROJECT, MAX_DIRECT_PER_ACCOUNT, STATUSES,
} from '../work-items-storage.mjs'
import { sendJson } from './http-json.mjs'
import { logEvent } from '../logger.mjs'

const ITEM = /^\/work-items\/([0-9a-f-]{36})$/
const ACTION = /^\/work-items\/([0-9a-f-]{36})\/(claim|release|restore)$/
const LISTS = new Set(['/work-items', '/work-items/mine', '/work-items/count', '/work-items/created', '/work-items/assignees'])
/** A task's JSON body: the notes limit, with room for the rest. */
const MAX_BODY_BYTES = 64 * 1024

export const WORK_ITEM_LIMITS = Object.freeze({
  maxTitleChars: MAX_TITLE_CHARS,
  maxNotesChars: MAX_NOTES_CHARS,
  maxPerProject: MAX_ITEMS_PER_PROJECT,
  maxWithoutProject: MAX_DIRECT_PER_ACCOUNT,
  statuses: STATUSES,
})

export function isWorkItemRoute(urlPath) {
  return LISTS.has(urlPath) || ITEM.test(urlPath) || ACTION.test(urlPath)
}

function query(req) {
  try { return new URL(req.url ?? '/', 'http://x').searchParams } catch { return new URLSearchParams() }
}
function includes(q) {
  return new Set((q.get('include') || '').split(',').map((s) => s.trim()).filter(Boolean))
}
/** The caller's own date, so "overdue" is theirs and not the server's. */
function todayOf(q) {
  const t = q.get('today')
  return t && isDate(t) ? t : null
}

async function readCappedJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { return null }
}

/** Logged by name only: never the values, and never a key the client made up. */
const PATCH_FIELDS = ['title', 'notes', 'status', 'dueDate', 'assignee', 'projectId']

const NOT_FOUND = { error: { message: 'Not found', type: 'not_found' } }

function fail(res, r) {
  const status = r.code === 'not_found' ? 404 : r.code === 'conflict' ? 409 : r.code === 'forbidden' ? 403 : 400
  const type = r.code === 'not_found' ? 'not_found' : r.code === 'conflict' ? 'conflict' : r.code === 'forbidden' ? 'permission_error' : 'invalid_request_error'
  sendJson(res, status, { error: { message: r.code === 'not_found' ? 'Not found' : r.error, type } })
}

const who = (account) => account?.username ?? undefined

export async function handleWorkItemRoute(req, res, urlPath, account) {
  try {
    const q = query(req)

    if (urlPath === '/work-items/mine' && req.method === 'GET') {
      const r = listMine(account, { includeDone: includes(q).has('done'), today: todayOf(q) })
      sendJson(res, 200, { ...r, limits: WORK_ITEM_LIMITS })
      return true
    }
    if (urlPath === '/work-items/count' && req.method === 'GET') {
      sendJson(res, 200, countMine(account, { today: todayOf(q) }))
      return true
    }
    if (urlPath === '/work-items/created' && req.method === 'GET') {
      sendJson(res, 200, { ...listCreated(account, { includeDone: includes(q).has('done') }), limits: WORK_ITEM_LIMITS })
      return true
    }
    if (urlPath === '/work-items/assignees' && req.method === 'GET') {
      const r = listAssignees(account, q.get('projectId') || null)
      if (!r.ok) { fail(res, r); return true }
      sendJson(res, 200, { accounts: r.accounts, groups: r.groups })
      return true
    }
    if (urlPath === '/work-items' && req.method === 'GET') {
      const projectId = q.get('projectId')
      if (!projectId) {
        sendJson(res, 400, { error: { message: 'projectId is required; your own tasks are /work-items/mine', type: 'invalid_request_error' } })
        return true
      }
      const inc = includes(q)
      const r = listForProject(account, projectId, { includeDone: true, includeDeleted: inc.has('deleted') })
      if (!r.ok) { fail(res, r); return true }
      sendJson(res, 200, { items: r.items, limits: WORK_ITEM_LIMITS })
      return true
    }
    if (urlPath === '/work-items' && req.method === 'POST') {
      const body = await readCappedJson(req)
      if (!body) { sendJson(res, 400, { error: { message: 'Expected a JSON task of at most 64 KB', type: 'invalid_request_error' } }); return true }
      const r = createWorkItem(account, body)
      if (!r.ok) { fail(res, r); return true }
      logEvent('work_item', 'created', { account: who(account), project: !!r.item.projectId, assigned: !!r.item.assignee })
      sendJson(res, 201, r.item)
      return true
    }
    if (LISTS.has(urlPath)) return false

    const action = ACTION.exec(urlPath)
    if (action) {
      if (req.method !== 'POST') return false
      const [, id, verb] = action
      const r = verb === 'claim' ? claimWorkItem(account, id) : verb === 'release' ? releaseWorkItem(account, id) : restoreWorkItem(account, id)
      if (!r.ok) { fail(res, r); return true }
      logEvent('work_item', verb === 'claim' ? 'claimed' : verb === 'release' ? 'released' : 'restored', { account: who(account) })
      sendJson(res, 200, r.item)
      return true
    }

    const item = ITEM.exec(urlPath)
    if (!item) return false
    const id = item[1]

    if (req.method === 'GET') {
      const r = getWorkItem(account, id)
      if (!r.ok) { sendJson(res, 404, NOT_FOUND); return true }
      sendJson(res, 200, r.item)
      return true
    }
    if (req.method === 'PATCH') {
      const body = await readCappedJson(req)
      if (!body) { sendJson(res, 400, { error: { message: 'Expected a JSON object of at most 64 KB', type: 'invalid_request_error' } }); return true }
      const r = updateWorkItem(account, id, body)
      if (!r.ok) { fail(res, r); return true }
      logEvent('work_item', 'updated', { account: who(account), fields: PATCH_FIELDS.filter((k) => k in body).join(',') })
      sendJson(res, 200, r.item)
      return true
    }
    if (req.method === 'DELETE') {
      const r = deleteWorkItem(account, id)
      if (!r.ok) { fail(res, r); return true }
      logEvent('work_item', 'deleted', { account: who(account) })
      sendJson(res, 200, { deleted: true })
      return true
    }
    return false
  } catch (err) {
    sendJson(res, 500, { error: { message: err.message, type: 'internal_error' } })
    return true
  }
}

