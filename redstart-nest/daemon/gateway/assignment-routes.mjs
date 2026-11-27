'use strict'

// =============================================================================
// Redstart Nest — Gateway /assignments routes (tasks plan Phase 1)
// =============================================================================
// The tasks people give each other, called assignments in code. Not under
// /tasks: that is the assistant's background work (task-routes.mjs).
//
//   GET    /assignments/mine        ?include=done ?today=YYYY-MM-DD
//                                  { items, counts: { open, overdue }, limits }
//   GET    /assignments/count       ?today=  { open, overdue } — the sidebar badge
//   GET    /assignments/created     ?include=done  tasks I made with no project
//   GET    /assignments/assignees   ?projectId=  who a task can be given to
//   GET    /assignments             ?projectId= (required) ?include=deleted
//   POST   /assignments             { title, notes?, projectId?, assignee?, dueDate?, status? }
//   GET    /assignments/:id         one task, with its history
//   PATCH  /assignments/:id         any of title, notes, status, dueDate, assignee, projectId
//   DELETE /assignments/:id         marks it deleted (restorable for 30 days)
//   POST   /assignments/:id/claim   a member of the assigned group takes it
//   POST   /assignments/:id/release hands a claimed task back to its group
//   POST   /assignments/:id/restore
//   POST   /assignments/:id/comments          { text }   anyone who can see it
//   DELETE /assignments/:id/comments/:cid     its author, or whoever can change the task
//
// Access is decided only by assignments-storage (accessOf there). A task the
// caller may not see answers 404, not 403, so ids cannot be probed; one they
// may see but not change answers 403. Each task in a response carries `can`,
// so a client never works the rules out for itself.
//
// This is the contract a later planning client (Greenhouse) uses too:
// documented in docs/connector-contract.md.
// =============================================================================

import {
  listMine, listCreated, listForProject, listAssignees, getAssignment, createAssignment, updateAssignment,
  claimAssignment, releaseAssignment, deleteAssignment, restoreAssignment, countMine, isDate,
  addComment, deleteComment, MAX_COMMENT_CHARS,
  MAX_TITLE_CHARS, MAX_NOTES_CHARS, MAX_ITEMS_PER_PROJECT, MAX_DIRECT_PER_ACCOUNT, STATUSES,
} from '../assignments-storage.mjs'
import { sendJson } from './http-json.mjs'
import { logEvent } from '../logger.mjs'

const ITEM = /^\/assignments\/([0-9a-f-]{36})$/
const ACTION = /^\/assignments\/([0-9a-f-]{36})\/(claim|release|restore)$/
const COMMENTS = /^\/assignments\/([0-9a-f-]{36})\/comments$/
const COMMENT = /^\/assignments\/([0-9a-f-]{36})\/comments\/([0-9a-f-]{36})$/
const LISTS = new Set(['/assignments', '/assignments/mine', '/assignments/count', '/assignments/created', '/assignments/assignees'])
/** A task's JSON body: the notes limit, with room for the rest. */
const MAX_BODY_BYTES = 64 * 1024

export const ASSIGNMENT_LIMITS = Object.freeze({
  maxTitleChars: MAX_TITLE_CHARS,
  maxNotesChars: MAX_NOTES_CHARS,
  maxPerProject: MAX_ITEMS_PER_PROJECT,
  maxWithoutProject: MAX_DIRECT_PER_ACCOUNT,
  statuses: STATUSES,
  maxCommentChars: MAX_COMMENT_CHARS,
})

export function isAssignmentRoute(urlPath) {
  return LISTS.has(urlPath) || ITEM.test(urlPath) || ACTION.test(urlPath) || COMMENTS.test(urlPath) || COMMENT.test(urlPath)
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

export async function handleAssignmentRoute(req, res, urlPath, account) {
  try {
    const q = query(req)

    if (urlPath === '/assignments/mine' && req.method === 'GET') {
      const r = listMine(account, { includeDone: includes(q).has('done'), today: todayOf(q) })
      sendJson(res, 200, { ...r, limits: ASSIGNMENT_LIMITS })
      return true
    }
    if (urlPath === '/assignments/count' && req.method === 'GET') {
      sendJson(res, 200, countMine(account, { today: todayOf(q) }))
      return true
    }
    if (urlPath === '/assignments/created' && req.method === 'GET') {
      sendJson(res, 200, { ...listCreated(account, { includeDone: includes(q).has('done') }), limits: ASSIGNMENT_LIMITS })
      return true
    }
    if (urlPath === '/assignments/assignees' && req.method === 'GET') {
      const r = listAssignees(account, q.get('projectId') || null)
      if (!r.ok) { fail(res, r); return true }
      sendJson(res, 200, { accounts: r.accounts, groups: r.groups })
      return true
    }
    if (urlPath === '/assignments' && req.method === 'GET') {
      const projectId = q.get('projectId')
      if (!projectId) {
        sendJson(res, 400, { error: { message: 'projectId is required; your own tasks are /assignments/mine', type: 'invalid_request_error' } })
        return true
      }
      const inc = includes(q)
      const r = listForProject(account, projectId, { includeDone: true, includeDeleted: inc.has('deleted') })
      if (!r.ok) { fail(res, r); return true }
      sendJson(res, 200, { items: r.items, limits: ASSIGNMENT_LIMITS })
      return true
    }
    if (urlPath === '/assignments' && req.method === 'POST') {
      const body = await readCappedJson(req)
      if (!body) { sendJson(res, 400, { error: { message: 'Expected a JSON task of at most 64 KB', type: 'invalid_request_error' } }); return true }
      const r = createAssignment(account, body)
      if (!r.ok) { fail(res, r); return true }
      logEvent('assignment', 'created', { account: who(account), project: !!r.item.projectId, assigned: !!r.item.assignee })
      sendJson(res, 201, r.item)
      return true
    }
    if (LISTS.has(urlPath)) return false

    // Comments (tasks plan Phase 3): anyone who can see the task adds one;
    // its author, or anyone who can change the task, deletes it.
    const comments = COMMENTS.exec(urlPath)
    if (comments) {
      if (req.method !== 'POST') return false
      const body = await readCappedJson(req)
      if (!body) { sendJson(res, 400, { error: { message: 'Expected { text } of at most 64 KB', type: 'invalid_request_error' } }); return true }
      const r = addComment(account, comments[1], body)
      if (!r.ok) { fail(res, r); return true }
      logEvent('assignment', 'commented', { account: who(account) })
      sendJson(res, 201, r.item)
      return true
    }
    const comment = COMMENT.exec(urlPath)
    if (comment) {
      if (req.method !== 'DELETE') return false
      const r = deleteComment(account, comment[1], comment[2])
      if (!r.ok) { fail(res, r); return true }
      logEvent('assignment', 'comment_deleted', { account: who(account) })
      sendJson(res, 200, r.item)
      return true
    }

    const action = ACTION.exec(urlPath)
    if (action) {
      if (req.method !== 'POST') return false
      const [, id, verb] = action
      const r = verb === 'claim' ? claimAssignment(account, id) : verb === 'release' ? releaseAssignment(account, id) : restoreAssignment(account, id)
      if (!r.ok) { fail(res, r); return true }
      logEvent('assignment', verb === 'claim' ? 'claimed' : verb === 'release' ? 'released' : 'restored', { account: who(account) })
      sendJson(res, 200, r.item)
      return true
    }

    const item = ITEM.exec(urlPath)
    if (!item) return false
    const id = item[1]

    if (req.method === 'GET') {
      const r = getAssignment(account, id)
      if (!r.ok) { sendJson(res, 404, NOT_FOUND); return true }
      sendJson(res, 200, r.item)
      return true
    }
    if (req.method === 'PATCH') {
      const body = await readCappedJson(req)
      if (!body) { sendJson(res, 400, { error: { message: 'Expected a JSON object of at most 64 KB', type: 'invalid_request_error' } }); return true }
      const r = updateAssignment(account, id, body)
      if (!r.ok) { fail(res, r); return true }
      logEvent('assignment', 'updated', { account: who(account), fields: PATCH_FIELDS.filter((k) => k in body).join(',') })
      sendJson(res, 200, r.item)
      return true
    }
    if (req.method === 'DELETE') {
      const r = deleteAssignment(account, id)
      if (!r.ok) { fail(res, r); return true }
      logEvent('assignment', 'deleted', { account: who(account) })
      sendJson(res, 200, { deleted: true })
      return true
    }
    return false
  } catch (err) {
    sendJson(res, 500, { error: { message: err.message, type: 'internal_error' } })
    return true
  }
}

