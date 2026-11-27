'use strict'

// =============================================================================
// Redstart Nest — assignments: the tasks people give each other (tasks plan)
// =============================================================================
// An assignment is a task: a title, notes, a status, a due date, and one
// assignee — a person or a group. It may belong to a project, or to none.
// People call them "tasks"; the code calls them assignments, because "task"
// is already the assistant's own background work (task-store.mjs) and, in
// every prompt, the work in front of the model. When the model gets tools for
// these (tasks plan Phase 2) they are assignment_*, for the same reason.
//
//   <config>/assignments/project-<project id>.json   one project's tasks
//   <config>/assignments/direct.json                 every task with no project
//   each { version: 1, items: [item] }
//
// NEST KEEPS THE ONE COPY (plan D1). Chat-ui reads and writes these over
// /assignments (gateway/assignment-routes.mjs); a later planning client
// (Greenhouse) uses the same routes and keeps no copy of its own.
//
// ACCESS (plan D4) is decided in one place, accessOf() below, and nowhere
// else. A project task follows its project — accessFor() in
// projects-storage.mjs, never a key comparison of our own:
//
//   see        anyone who can read the project
//   change     editors, the owner, an admin (title, notes, due date,
//              assignee, project, delete, restore)
//   status     those, and the assignee
//
// A task with no project belongs to the person who made it:
//
//   see        the creator, the assigned person, members of the assigned group
//   change     the creator
//   status     the creator and the assignee
//
// "The assignee" is every member of an assigned group until one of them
// CLAIMS it (plan D3): the task then names that person and remembers the group
// in `claimedFrom`, so it can be handed back. An admin who manages all
// projects reaches project tasks through accessFor(), but never someone
// else's task that has no project.
//
// RESERVED FIELDS (startDate, estimate, blockedBy, milestoneId) are
// documented in the plan for the phases that use them and are refused here
// until then, so no client stores them early.
//
// THE ASSISTANT AS ASSIGNEE (tasks plan Phase 4): `{ type: 'agent', id:
// 'assistant' }`. Giving a task to it starts a background job as the person
// who gave it (assignment-agent.mjs), recorded in `agentRun`; when the job
// ends the task goes back to that person, with a comment, for a person to
// check. The assistant never marks its own work done.
//
// NOTHING IS LOST (plan D7, D8). A delete only marks the record; it is purged
// 30 days later, on the next write to its file. When a project, an account or
// a group goes, the hooks at the bottom move or unassign its tasks instead.
// =============================================================================

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { configDir } from './platform-paths.mjs'
import { readJsonOr, writeJsonAtomic } from './json-store.mjs'
import { ownerKeyOf } from './access-core.mjs'
import { accessFor, findProjectById, isProjectId } from './projects-storage.mjs'
import { findGroupById, groupsForAccount, listGroups } from './groups-storage.mjs'
import { findById as findAccountById, listAccounts } from './accounts-storage.mjs'

export const MAX_TITLE_CHARS = 200
export const MAX_NOTES_CHARS = 8000
export const MAX_ITEMS_PER_PROJECT = 2000
export const MAX_DIRECT_PER_ACCOUNT = 500
export const MAX_HISTORY = 100
/** Comments kept per task (the newest), and the length of one (tasks plan Phase 3). */
export const MAX_COMMENTS = 200
export const MAX_COMMENT_CHARS = 4000
export const PURGE_AFTER_MS = 30 * 24 * 60 * 60 * 1000
export const STATUSES = Object.freeze(['open', 'in_progress', 'blocked', 'done'])
/** Written into the plan for later phases; refused until then. */
export const RESERVED_FIELDS = Object.freeze(['startDate', 'estimate', 'blockedBy', 'milestoneId'])

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const PROJECT_FILE = /^project-([A-Za-z0-9-]{1,64})\.json$/

export function isAssignmentId(id) {
  return typeof id === 'string' && ID.test(id)
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function dir() { return path.join(configDir(), 'assignments') }
function directFile() { return path.join(dir(), 'direct.json') }
function projectFile(projectId) { return path.join(dir(), `project-${projectId}.json`) }
function fileFor(projectId) { return projectId ? projectFile(projectId) : directFile() }

function load(file, now = Date.now()) {
  const data = readJsonOr(file, { version: 1, items: [] })
  const items = Array.isArray(data?.items) ? data.items : []
  // Records deleted over 30 days ago are gone to every reader, whether or not
  // a write has purged them from the file yet.
  return { version: 1, items: items.filter((t) => !t.deletedAt || now - t.deletedAt < PURGE_AFTER_MS) }
}
function save(file, data) {
  fs.mkdirSync(dir(), { recursive: true })
  writeJsonAtomic(file, { version: 1, items: data.items })
}

/** The project ids that have a task file. */
function projectIdsWithFiles() {
  let names = []
  try { names = fs.readdirSync(dir()) } catch { return [] }
  return names.map((n) => PROJECT_FILE.exec(n)?.[1]).filter((id) => id && isProjectId(id))
}

/** Every file with the items in it: direct first, then each project's. */
function allFiles(now) {
  const out = [{ projectId: null, file: directFile() }]
  for (const projectId of projectIdsWithFiles()) out.push({ projectId, file: projectFile(projectId) })
  return out.map((f) => ({ ...f, data: load(f.file, now) }))
}

/** The file holding this item, its data, and the item's index in it. */
function locate(id, now) {
  if (!isAssignmentId(id)) return null
  for (const f of allFiles(now)) {
    const index = f.data.items.findIndex((t) => t.id === id)
    if (index !== -1) return { ...f, index, item: f.data.items[index] }
  }
  return null
}

// ---------------------------------------------------------------------------
// Names — resolved on every read, never stored (plan, Data model)
// ---------------------------------------------------------------------------

function accountName(key) {
  if (!key || key === '_local') return null
  return findAccountById(key)?.username ?? null
}
function assigneeName(a) {
  if (!a) return null
  if (a.type === 'account') return accountName(a.id)
  if (a.type === 'group') return findGroupById(a.id)?.name ?? null
  if (a.type === 'agent') return 'the assistant'
  return null
}

// ---------------------------------------------------------------------------
// Access — the one place it is decided (plan D4)
// ---------------------------------------------------------------------------

const NONE = Object.freeze({ see: false, edit: false, status: false, assign: false, claim: false, release: false, delete: false, move: false })

function inGroup(account, groupId) {
  return !!account && !!groupId && groupsForAccount(account.id).some((g) => g.id === groupId)
}

/**
 * What this caller may do with this item. `project` is the item's project
 * record when the caller already has it (a list over one project), else it
 * is looked up.
 */
function accessOf(item, account, project = undefined) {
  if (!item) return NONE
  const key = ownerKeyOf(account)
  if (key === null) return NONE
  const a = item.assignee
  const isClaimer = !!account && a?.type === 'account' && a.id === account.id && !!item.claimedFrom
  const isAssignee = (!!account && a?.type === 'account' && a.id === account.id) || (a?.type === 'group' && inGroup(account, a.id))
  const claim = a?.type === 'group' && inGroup(account, a.id)

  if (item.projectId) {
    const p = project === undefined ? findProjectById(item.projectId) : project
    const level = p ? accessFor(p, account) : null
    if (!level) return NONE
    const write = level === 'owner' || level === 'admin' || level === 'editor'
    return {
      see: true, edit: write, assign: write, move: write, delete: write,
      status: write || isAssignee,
      claim,
      release: !!item.claimedFrom && (isClaimer || write),
    }
  }

  const isCreator = item.createdBy === key
  if (!isCreator && !isAssignee) return NONE
  return {
    see: true, edit: isCreator, assign: isCreator, move: isCreator, delete: isCreator,
    status: isCreator || isAssignee,
    claim,
    release: !!item.claimedFrom && (isClaimer || isCreator),
  }
}

/** May this person or group be given a task in this project (or with none)? */
function assigneeAllowed(assignee, project) {
  // The assistant works as whoever gives it the task, so it can open
  // whatever they can (assignment-agent.mjs).
  if (assignee.type === 'agent') return { ok: true }
  if (assignee.type === 'account') {
    const acct = findAccountById(assignee.id)
    if (!acct || acct.status === 'disabled') return { ok: false, error: 'No such account' }
    if (project && !accessFor(project, acct)) return { ok: false, error: `${acct.username} cannot open this project, so cannot be given its tasks. Share the project with them first.` }
    return { ok: true }
  }
  const group = findGroupById(assignee.id)
  if (!group) return { ok: false, error: 'No such group' }
  if (project && !(project.members || []).some((m) => m.type === 'group' && m.id === group.id)) {
    return { ok: false, error: `The group "${group.name}" is not a member of this project. Share the project with the group first.` }
  }
  return { ok: true }
}

/** True when a project task's assignee can no longer open the project. */
function assigneeLeft(item, project) {
  if (!item.projectId || !item.assignee) return false
  if (!project) return false
  return !assigneeAllowed(item.assignee, project).ok
}

// ---------------------------------------------------------------------------
// Validation — pure apart from the assignee lookup
// ---------------------------------------------------------------------------

export function isDate(s) {
  const m = typeof s === 'string' ? DATE.exec(s) : null
  if (!m) return false
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]
}

/**
 * @param {unknown} body
 * @param {{ partial?: boolean }} opts  partial: a PATCH, where absent fields keep their value
 * @returns {{ ok: true, fields: object } | { ok: false, error: string }}
 */
export function validateAssignment(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'a JSON object is required' }
  const reserved = RESERVED_FIELDS.filter((f) => body[f] !== undefined)
  if (reserved.length) return { ok: false, error: `not supported yet: ${reserved.join(', ')}` }
  const fields = {}

  if (body.title !== undefined || !partial) {
    if (typeof body.title !== 'string') return { ok: false, error: 'title must be a string' }
    const title = body.title.replace(/\s+/g, ' ').trim()
    if (!title) return { ok: false, error: 'title is required' }
    if (title.length > MAX_TITLE_CHARS) return { ok: false, error: `title is at most ${MAX_TITLE_CHARS} characters` }
    fields.title = title
  }

  if (body.notes !== undefined) {
    const raw = body.notes ?? ''
    if (typeof raw !== 'string') return { ok: false, error: 'notes must be a string' }
    const notes = raw.replace(/\r\n?/g, '\n').trim()
    if (notes.length > MAX_NOTES_CHARS) return { ok: false, error: `notes are at most ${MAX_NOTES_CHARS} characters; these are ${notes.length}` }
    fields.notes = notes
  }

  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) return { ok: false, error: `status is one of ${STATUSES.join(', ')}` }
    fields.status = body.status
  }

  if (body.dueDate !== undefined) {
    if (body.dueDate !== null && !isDate(body.dueDate)) return { ok: false, error: 'dueDate is a date as YYYY-MM-DD, or null' }
    fields.dueDate = body.dueDate
  }

  if (body.projectId !== undefined) {
    if (body.projectId !== null && !isProjectId(body.projectId)) return { ok: false, error: 'projectId is a project id, or null' }
    fields.projectId = body.projectId
  }

  if (body.assignee !== undefined) {
    const a = body.assignee
    if (a === null) fields.assignee = null
    else if (a && typeof a === 'object' && a.type === 'agent') fields.assignee = { type: 'agent', id: 'assistant' }
    else if (a && typeof a === 'object' && (a.type === 'account' || a.type === 'group') && typeof a.id === 'string' && a.id) {
      fields.assignee = { type: a.type, id: a.id }
    } else return { ok: false, error: 'assignee is { type: "account" | "group", id }, { type: "agent" } (the assistant), or null' }
  }

  return { ok: true, fields }
}

// ---------------------------------------------------------------------------
// What a response carries (plan, Data model)
// ---------------------------------------------------------------------------

function historyView(h) {
  const out = { ...h, byName: accountName(h.by) }
  if (h.action === 'assigned' || h.action === 'claimed' || h.action === 'released' || h.action === 'unassigned') {
    if (h.from && typeof h.from === 'object') out.fromName = h.from.name ?? assigneeName(h.from)
    if (h.to && typeof h.to === 'object') out.toName = h.to.name ?? assigneeName(h.to)
  }
  if (h.action === 'moved') {
    if (h.from) out.fromName = findProjectById(h.from)?.name ?? null
    if (h.to) out.toName = findProjectById(h.to)?.name ?? null
  }
  return out
}

/**
 * When the task last came to whoever has it now: the newest assign, claim
 * or hand-back in its history, else when it was made. A client marks a task
 * "new" from this (tasks plan Phase 3).
 */
function assignedAtOf(item) {
  const h = item.history || []
  for (let i = h.length - 1; i >= 0; i--) {
    if (['assigned', 'claimed', 'released', 'unassigned'].includes(h[i].action)) return h[i].at
  }
  return item.createdAt
}

function commentView(c, account, canEdit) {
  const key = ownerKeyOf(account)
  return { ...c, byName: accountName(c.by), canDelete: canEdit || (key !== null && c.by !== null && c.by === key) }
}

/**
 * What a response says about the assistant's run. The chat it ran in is
 * private to whoever gave it the task (every chat is), so only they get its id.
 */
function agentRunView(run, account) {
  if (!run) return null
  const mine = ownerKeyOf(account) !== null && run.by === ownerKeyOf(account)
  return {
    running: !run.endedAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? null,
    outcome: run.outcome ?? null,
    byName: accountName(run.by),
    conversationId: mine ? run.conversationId : null,
  }
}

function view(item, account, { project = undefined, withHistory = false } = {}) {
  const p = item.projectId ? (project === undefined ? findProjectById(item.projectId) : project) : null
  const can = accessOf(item, account, item.projectId ? p : undefined)
  const { history, comments, agentRun, ...rest } = item
  const out = {
    ...rest,
    agentRun: agentRunView(agentRun, account),
    commentCount: (comments || []).length,
    assignedAt: assignedAtOf(item),
    assigneeName: assigneeName(item.assignee),
    claimedFromName: item.claimedFrom ? (findGroupById(item.claimedFrom)?.name ?? null) : null,
    createdByName: accountName(item.createdBy),
    projectName: p?.name ?? null,
    assigneeLeft: assigneeLeft(item, p),
    can: { edit: can.edit, status: can.status, assign: can.assign, claim: can.claim, release: can.release, delete: can.delete, move: can.move, comment: can.see },
  }
  if (withHistory) {
    out.history = (history || []).map(historyView)
    out.comments = (comments || []).map((c) => commentView(c, account, can.edit))
  }
  return out
}

/**
 * History entries made by the assistant on someone's behalf say so
 * (`via: 'assistant'`, tasks plan Phase 2); the person is still `by`.
 */
function viaOf(via) {
  return via === 'assistant' ? { via: 'assistant' } : {}
}

function addHistory(item, entry) {
  item.history = [...(item.history || []), entry].slice(-MAX_HISTORY)
}

/** The parts of a list a client shows as counts. `today` is the caller's date. */
function countsOf(items, today) {
  const open = items.filter((t) => t.status !== 'done')
  return {
    open: open.length,
    overdue: open.filter((t) => t.dueDate && today && t.dueDate < today).length,
    // For the once-a-day reminder (tasks plan Phase 3).
    dueToday: open.filter((t) => t.dueDate && today && t.dueDate === today).length,
  }
}

/** Today's date where the server is, for a caller that sent none. */
export function serverToday(now = Date.now()) {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const sortForList = (a, b) =>
  (a.status === 'done') - (b.status === 'done') ||
  (a.dueDate ?? '9999-99-99').localeCompare(b.dueDate ?? '9999-99-99') ||
  b.updatedAt - a.updatedAt

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/**
 * The caller's tasks: given to them, or to a group they are in and not yet
 * claimed, across every project they can open and the tasks with no project.
 * With sign-in off nobody is given anything, so it is every task there is:
 * one personal list, shared by every auth-off caller as projects are.
 */
export function listMine(account, { includeDone = false, today = null, now = Date.now() } = {}) {
  if (ownerKeyOf(account) === null) return { items: [], counts: { open: 0, overdue: 0, dueToday: 0 } }
  const myGroups = new Set(account ? groupsForAccount(account.id).map((g) => g.id) : [])
  const out = []
  for (const f of allFiles(now)) {
    const project = f.projectId ? findProjectById(f.projectId) : null
    if (f.projectId && (!project || !accessFor(project, account))) continue
    for (const t of f.data.items) {
      if (t.deletedAt) continue
      const a = t.assignee
      const mine = account
        ? (a?.type === 'account' && a.id === account.id) || (a?.type === 'group' && myGroups.has(a.id))
        : accessOf(t, null, f.projectId ? project : undefined).see
      if (!mine) continue
      out.push(view(t, account, { project: f.projectId ? project : undefined }))
    }
  }
  const counts = countsOf(out, today ?? serverToday(now))
  return { items: out.filter((t) => includeDone || t.status !== 'done').sort(sortForList), counts }
}

/** Tasks with no project that the caller made, whoever has them now. */
export function listCreated(account, { includeDone = false, now = Date.now() } = {}) {
  const key = ownerKeyOf(account)
  if (key === null) return { items: [] }
  const items = load(directFile(), now).items
    .filter((t) => t.createdBy === key && !t.deletedAt && (includeDone || t.status !== 'done'))
    .map((t) => view(t, account))
    .sort(sortForList)
  return { items }
}

/** One project's tasks, for anyone who can open the project. */
export function listForProject(account, projectId, { includeDone = true, includeDeleted = false, now = Date.now() } = {}) {
  const project = findProjectById(projectId)
  if (!project || !accessFor(project, account)) return { ok: false, error: 'not found', code: 'not_found' }
  const items = load(projectFile(projectId), now).items
    .filter((t) => (includeDeleted ? true : !t.deletedAt) && (includeDone || t.status !== 'done'))
    .map((t) => view(t, account, { project }))
    .sort(sortForList)
  return { ok: true, items }
}

/**
 * Who a task can be given to: in a project, the people and groups who can
 * open it; with no project, everyone in the directory. Names only, as
 * /directory. With sign-in off there is nobody to give tasks to.
 */
export function listAssignees(account, projectId = null) {
  if (!account) return { ok: true, accounts: [], groups: [] }
  const accounts = listAccounts().filter((a) => a.status !== 'disabled')
  const groups = listGroups()
  if (!projectId) {
    return { ok: true, accounts: accounts.map((a) => ({ id: a.id, username: a.username })), groups: groups.map((g) => ({ id: g.id, name: g.name })) }
  }
  const project = findProjectById(projectId)
  if (!project || !accessFor(project, account)) return { ok: false, error: 'not found', code: 'not_found' }
  return {
    ok: true,
    accounts: accounts.filter((a) => accessFor(project, a)).map((a) => ({ id: a.id, username: a.username })),
    groups: groups.filter((g) => (project.members || []).some((m) => m.type === 'group' && m.id === g.id)).map((g) => ({ id: g.id, name: g.name })),
  }
}

// ---------------------------------------------------------------------------
// One item
// ---------------------------------------------------------------------------

const NOT_FOUND = { ok: false, error: 'not found', code: 'not_found' }

/** One item the caller can see, with its history; deleted ones too, for restore. */
export function getAssignment(account, id, { now = Date.now() } = {}) {
  const found = locate(id, now)
  if (!found || !accessOf(found.item, account).see) return NOT_FOUND
  return { ok: true, item: view(found.item, account, { withHistory: true }) }
}

/** @returns {{ ok: true, item: object } | { ok: false, error: string, code?: string }} */
export function createAssignment(account, body, { now = Date.now(), via = null } = {}) {
  const key = ownerKeyOf(account)
  if (key === null) return { ok: false, error: 'sign in to create tasks', code: 'forbidden' }
  const v = validateAssignment(body)
  if (!v.ok) return v
  const f = v.fields
  const projectId = f.projectId ?? null

  let project = null
  if (projectId) {
    project = findProjectById(projectId)
    const level = project ? accessFor(project, account) : null
    if (!level) return { ok: false, error: 'No such project', code: 'not_found' }
    if (!['owner', 'admin', 'editor'].includes(level)) return { ok: false, error: 'You can view this project but not add tasks to it', code: 'forbidden' }
  }
  if (f.assignee) {
    if (!account) return { ok: false, error: 'tasks can be given to people only with sign-in on' }
    const allowed = assigneeAllowed(f.assignee, project)
    if (!allowed.ok) return allowed
  }

  const file = fileFor(projectId)
  const data = load(file, now)
  if (projectId && data.items.length >= MAX_ITEMS_PER_PROJECT) {
    return { ok: false, error: `this project has reached its limit of ${MAX_ITEMS_PER_PROJECT} tasks; delete some first` }
  }
  if (!projectId && data.items.filter((t) => t.createdBy === key).length >= MAX_DIRECT_PER_ACCOUNT) {
    return { ok: false, error: `the limit of ${MAX_DIRECT_PER_ACCOUNT} tasks outside projects is reached; delete some first` }
  }

  const status = f.status ?? 'open'
  const item = {
    id: crypto.randomUUID(),
    title: f.title,
    notes: f.notes ?? '',
    status,
    projectId,
    assignee: f.assignee ?? null,
    claimedFrom: null,
    formerAssignee: null,
    dueDate: f.dueDate ?? null,
    createdBy: key,
    createdAt: now,
    updatedAt: now,
    completedAt: status === 'done' ? now : null,
    deletedAt: null,
    history: [],
  }
  addHistory(item, { at: now, by: key, ...viaOf(via), action: 'created' })
  if (item.assignee) addHistory(item, { at: now, by: key, ...viaOf(via), action: 'assigned', from: null, to: item.assignee })
  data.items.push(item)
  save(file, data)
  return { ok: true, item: view(item, account, { project: projectId ? project : undefined, withHistory: true }) }
}

/**
 * Change some fields. Each is checked against what the caller may do, and one
 * they may not change refuses the whole request: nothing is half-applied.
 */
export function updateAssignment(account, id, body, { now = Date.now(), via = null } = {}) {
  const v = validateAssignment(body, { partial: true })
  if (!v.ok) return v
  const found = locate(id, now)
  if (!found) return NOT_FOUND
  const can = accessOf(found.item, account)
  if (!can.see) return NOT_FOUND
  if (found.item.deletedAt) return { ok: false, error: 'this task is deleted; restore it first', code: 'conflict' }
  const f = v.fields
  const key = ownerKeyOf(account)

  const needs = []
  if ('title' in f || 'notes' in f || 'dueDate' in f) needs.push(['edit', 'title, notes or due date'])
  if ('status' in f) needs.push(['status', 'status'])
  if ('assignee' in f) needs.push(['assign', 'assignee'])
  if ('projectId' in f && f.projectId !== found.item.projectId) needs.push(['move', 'project'])
  const denied = needs.filter(([flag]) => !can[flag]).map(([, what]) => what)
  if (denied.length) return { ok: false, error: `You cannot change this task's ${denied.join(', ')}`, code: 'forbidden' }

  const item = { ...found.item }
  const before = found.item

  // Where it will live, checked before anything changes.
  const targetProjectId = 'projectId' in f ? f.projectId : before.projectId
  const moving = targetProjectId !== before.projectId
  let targetProject = targetProjectId ? findProjectById(targetProjectId) : null
  if (moving && targetProjectId) {
    const level = targetProject ? accessFor(targetProject, account) : null
    if (!level) return { ok: false, error: 'No such project', code: 'not_found' }
    if (!['owner', 'admin', 'editor'].includes(level)) return { ok: false, error: 'You can view that project but not add tasks to it', code: 'forbidden' }
    if (load(projectFile(targetProjectId), now).items.length >= MAX_ITEMS_PER_PROJECT) {
      return { ok: false, error: `that project has reached its limit of ${MAX_ITEMS_PER_PROJECT} tasks` }
    }
  }
  if (moving && !targetProjectId && key !== null && key !== before.createdBy) {
    // Out of a project, a task belongs to its creator; whoever moves it out
    // becomes that, or they would lose sight of what they just moved.
    item.createdBy = key
  }

  const nextAssignee = 'assignee' in f ? f.assignee : before.assignee
  if (nextAssignee && ('assignee' in f || moving)) {
    if (!account) return { ok: false, error: 'tasks can be given to people only with sign-in on' }
    const allowed = assigneeAllowed(nextAssignee, targetProject)
    if (!allowed.ok) return moving && !('assignee' in f) ? { ok: false, error: `${allowed.error.replace(/ Share.*$/, '')} Choose someone else, or no one, when moving it.` } : allowed
  }

  const changed = []
  for (const k of ['title', 'notes', 'dueDate']) {
    if (k in f && f[k] !== before[k]) { item[k] = f[k]; changed.push(k) }
  }
  if (changed.length) addHistory(item, { at: now, by: key, ...viaOf(via), action: 'edited', fields: changed })

  if ('status' in f && f.status !== before.status) {
    item.status = f.status
    item.completedAt = f.status === 'done' ? now : null
    addHistory(item, { at: now, by: key, ...viaOf(via), action: 'status', from: before.status, to: f.status })
  }

  if ('assignee' in f && !sameAssignee(f.assignee, before.assignee)) {
    item.assignee = f.assignee
    item.claimedFrom = null
    item.formerAssignee = null
    addHistory(item, { at: now, by: key, ...viaOf(via), action: 'assigned', from: before.assignee, to: f.assignee })
  }

  if (moving) {
    item.projectId = targetProjectId
    addHistory(item, { at: now, by: key, ...viaOf(via), action: 'moved', from: before.projectId, to: targetProjectId })
  }

  const touched = changed.length || item.status !== before.status || !sameAssignee(item.assignee, before.assignee) || moving
  if (!touched) return { ok: true, item: view(before, account, { withHistory: true }) }
  item.updatedAt = now

  if (moving) {
    // Write the new home first: a crash between the two leaves a duplicate,
    // which is visible and fixable, never a task lost.
    const target = load(fileFor(targetProjectId), now)
    target.items.push(item)
    save(fileFor(targetProjectId), target)
    const source = load(found.file, now)
    source.items = source.items.filter((t) => t.id !== id)
    save(found.file, source)
  } else {
    found.data.items[found.index] = item
    save(found.file, found.data)
  }
  return { ok: true, item: view(item, account, { withHistory: true }) }
}

function sameAssignee(a, b) {
  if (!a || !b) return !a && !b
  return a.type === b.type && a.id === b.id
}

/** A member of the assigned group takes the task (plan D3). */
export function claimAssignment(account, id, { now = Date.now() } = {}) {
  const found = locate(id, now)
  if (!found) return NOT_FOUND
  const can = accessOf(found.item, account)
  if (!can.see) return NOT_FOUND
  if (found.item.deletedAt) return { ok: false, error: 'this task is deleted', code: 'conflict' }
  if (found.item.assignee?.type !== 'group') {
    return { ok: false, error: found.item.claimedFrom ? 'Someone has already taken this task' : 'This task is not given to a group', code: 'conflict' }
  }
  if (!can.claim) return { ok: false, error: 'Only a member of the group can take this task', code: 'forbidden' }
  const item = found.item
  const from = item.assignee
  item.claimedFrom = from.id
  item.assignee = { type: 'account', id: account.id }
  item.updatedAt = now
  addHistory(item, { at: now, by: ownerKeyOf(account), action: 'claimed', from, to: item.assignee })
  save(found.file, found.data)
  return { ok: true, item: view(item, account, { withHistory: true }) }
}

/** Give a claimed task back to its group. */
export function releaseAssignment(account, id, { now = Date.now() } = {}) {
  const found = locate(id, now)
  if (!found) return NOT_FOUND
  const can = accessOf(found.item, account)
  if (!can.see) return NOT_FOUND
  if (!found.item.claimedFrom) return { ok: false, error: 'This task was not taken from a group', code: 'conflict' }
  if (!can.release) return { ok: false, error: 'Only whoever took it, or someone who can change the task, can hand it back', code: 'forbidden' }
  const item = found.item
  const from = item.assignee
  item.assignee = findGroupById(item.claimedFrom) ? { type: 'group', id: item.claimedFrom } : null
  item.claimedFrom = null
  item.updatedAt = now
  addHistory(item, { at: now, by: ownerKeyOf(account), action: 'released', from, to: item.assignee })
  save(found.file, found.data)
  return { ok: true, item: view(item, account, { withHistory: true }) }
}

/** Mark it deleted; it can be restored for 30 days (plan D7). */
export function deleteAssignment(account, id, { now = Date.now() } = {}) {
  const found = locate(id, now)
  if (!found) return NOT_FOUND
  const can = accessOf(found.item, account)
  if (!can.see) return NOT_FOUND
  if (!can.delete) return { ok: false, error: 'You cannot delete this task', code: 'forbidden' }
  if (found.item.deletedAt) return { ok: true }
  found.item.deletedAt = now
  found.item.updatedAt = now
  addHistory(found.item, { at: now, by: ownerKeyOf(account), action: 'deleted' })
  save(found.file, found.data)
  return { ok: true }
}

export function restoreAssignment(account, id, { now = Date.now() } = {}) {
  const found = locate(id, now)
  if (!found) return NOT_FOUND
  const can = accessOf(found.item, account)
  if (!can.see) return NOT_FOUND
  if (!can.delete) return { ok: false, error: 'You cannot restore this task', code: 'forbidden' }
  if (!found.item.deletedAt) return { ok: true, item: view(found.item, account, { withHistory: true }) }
  found.item.deletedAt = null
  found.item.updatedAt = now
  addHistory(found.item, { at: now, by: ownerKeyOf(account), action: 'restored' })
  save(found.file, found.data)
  return { ok: true, item: view(found.item, account, { withHistory: true }) }
}

// ---------------------------------------------------------------------------
// Comments (tasks plan Phase 3)
// ---------------------------------------------------------------------------
// Anyone who can see a task may comment on it, a viewer included: a comment
// changes nothing about the task. Its author deletes it, and so does anyone
// who can change the task. Kept on the record, the newest MAX_COMMENTS.

export function addComment(account, id, body, { now = Date.now() } = {}) {
  const found = locate(id, now)
  if (!found || !accessOf(found.item, account).see) return NOT_FOUND
  if (found.item.deletedAt) return { ok: false, error: 'this task is deleted; restore it first', code: 'conflict' }
  const raw = typeof body?.text === 'string' ? body.text.replace(/\r\n?/g, '\n').trim() : ''
  if (!raw) return { ok: false, error: 'a comment needs text' }
  if (raw.length > MAX_COMMENT_CHARS) return { ok: false, error: `a comment is at most ${MAX_COMMENT_CHARS} characters; this is ${raw.length}` }
  const comment = { id: crypto.randomUUID(), at: now, by: ownerKeyOf(account), text: raw }
  found.item.comments = [...(found.item.comments || []), comment].slice(-MAX_COMMENTS)
  found.item.updatedAt = now
  save(found.file, found.data)
  return { ok: true, item: view(found.item, account, { withHistory: true }) }
}

export function deleteComment(account, id, commentId, { now = Date.now() } = {}) {
  const found = locate(id, now)
  if (!found) return NOT_FOUND
  const can = accessOf(found.item, account)
  if (!can.see) return NOT_FOUND
  const comment = (found.item.comments || []).find((c) => c.id === commentId)
  if (!comment) return NOT_FOUND
  if (!(can.edit || comment.by === ownerKeyOf(account))) return { ok: false, error: 'Only its author, or someone who can change the task, can delete a comment', code: 'forbidden' }
  found.item.comments = found.item.comments.filter((c) => c.id !== commentId)
  save(found.file, found.data)
  return { ok: true, item: view(found.item, account, { withHistory: true }) }
}

// ---------------------------------------------------------------------------
// The assistant's runs (tasks plan Phase 4)
// ---------------------------------------------------------------------------
// assignment-agent.mjs starts a job and calls these. They take no account:
// the access check was the route's, before the job was started.

/** The job started: note it, and show the task as in progress. */
export function recordAgentStart(id, { jobId, conversationId, by }, { now = Date.now() } = {}) {
  const found = locate(id, now)
  if (!found) return false
  const item = found.item
  item.agentRun = { jobId, conversationId, by, startedAt: now }
  if (item.status === 'open' || item.status === 'blocked') item.status = 'in_progress'
  item.updatedAt = now
  addHistory(item, { at: now, by, via: 'assistant', action: 'agent_started' })
  save(found.file, found.data)
  return true
}

/** Tasks whose run has not been recorded as ended, for the start-up check. */
export function openAgentRuns({ now = Date.now() } = {}) {
  const out = []
  for (const f of allFiles(now)) for (const t of f.data.items) if (t.agentRun && !t.agentRun.endedAt) out.push({ id: t.id, jobId: t.agentRun.jobId })
  return out
}

const OUTCOME_COMMENT = {
  done: 'The assistant finished this. Its chat has what it did: check it, then mark the task done.',
  failed: 'The assistant could not finish this',
  cancelled: 'The assistant\'s job was stopped before it finished.',
}

/**
 * The job ended. If the task is still the assistant's, it goes back to whoever
 * gave it, as To do after a finished job and Blocked otherwise, so a person
 * checks the work. A comment says what happened either way.
 */
export function recordAgentEnd(jobId, outcome, error = null, { now = Date.now() } = {}) {
  for (const f of allFiles(now)) {
    const item = f.data.items.find((t) => t.agentRun?.jobId === jobId && !t.agentRun.endedAt)
    if (!item) continue
    const run = item.agentRun
    run.endedAt = now
    run.outcome = outcome
    const back = run.by && findAccountById(run.by) ? { type: 'account', id: run.by } : null
    if (item.assignee?.type === 'agent') {
      addHistory(item, { at: now, by: null, via: 'assistant', action: 'unassigned', from: item.assignee, to: back, reason: `assistant ${outcome}` })
      item.assignee = back
      // Someone marked it done meanwhile: that stands.
      if (item.status !== 'done') item.status = outcome === 'done' ? 'open' : 'blocked'
    }
    const text = outcome === 'failed' && error ? `${OUTCOME_COMMENT.failed}: ${String(error).slice(0, 500)}` : (OUTCOME_COMMENT[outcome] ?? OUTCOME_COMMENT.failed)
    item.comments = [...(item.comments || []), { id: crypto.randomUUID(), at: now, by: null, via: 'assistant', text }].slice(-MAX_COMMENTS)
    addHistory(item, { at: now, by: null, via: 'assistant', action: 'agent_finished', outcome })
    item.updatedAt = now
    save(f.file, f.data)
    return item.id
  }
  return null
}

/** Counts for the sidebar badge. */
export function countMine(account, { today = null, now = Date.now() } = {}) {
  return listMine(account, { includeDone: false, today, now }).counts
}

// ---------------------------------------------------------------------------
// When projects, accounts and groups go (plan D8)
// ---------------------------------------------------------------------------
// Called by the routes that delete them, after the record is gone. None of
// them loses a task: a project's become tasks with no project, a person's or
// a group's become unassigned and say who had them.

/** A project was deleted: its tasks lose their project and keep the rest. */
export function detachProjectAssignments(projectId, { now = Date.now() } = {}) {
  if (!isProjectId(projectId)) return 0
  const file = projectFile(projectId)
  if (!fs.existsSync(file)) return 0
  const moving = load(file, now).items
  if (moving.length) {
    const direct = load(directFile(), now)
    for (const t of moving) {
      const item = { ...t, projectId: null, updatedAt: now }
      // A group assignee was valid because the group was in the project; it
      // still names real people, so it stays.
      addHistory(item, { at: now, by: null, action: 'moved', from: projectId, to: null, reason: 'project deleted' })
      direct.items.push(item)
    }
    save(directFile(), direct)
  }
  fs.rmSync(file, { force: true })
  return moving.length
}

function eachItem(fn, now) {
  let changed = 0
  for (const f of allFiles(now)) {
    let dirty = false
    for (const t of f.data.items) if (fn(t)) dirty = true
    if (dirty) { save(f.file, f.data); changed++ }
  }
  return changed
}

/**
 * An account is being deleted. Tasks given to it go back to the group they
 * were claimed from, or become unassigned and say who had them; tasks it made
 * pass to `toAccountId` (whoever takes over its projects).
 */
export function handOverAccountAssignments(accountId, username, toAccountId, { now = Date.now() } = {}) {
  let unassigned = 0
  let handedOver = 0
  eachItem((t) => {
    let dirty = false
    if (t.assignee?.type === 'account' && t.assignee.id === accountId) {
      const from = { type: 'account', id: accountId, name: username ?? null }
      if (t.claimedFrom && findGroupById(t.claimedFrom)) {
        t.assignee = { type: 'group', id: t.claimedFrom }
      } else {
        t.assignee = null
        t.formerAssignee = { type: 'account', name: username ?? null }
      }
      t.claimedFrom = null
      t.updatedAt = now
      addHistory(t, { at: now, by: null, action: 'unassigned', from, to: t.assignee, reason: 'account deleted' })
      unassigned++
      dirty = true
    }
    if (t.createdBy === accountId && toAccountId) {
      t.createdBy = toAccountId
      handedOver++
      dirty = true
    }
    return dirty
  }, now)
  return { unassigned, handedOver }
}

/** A group was deleted: its tasks become unassigned and say which group had them. */
export function unassignGroupAssignments(groupId, groupName, { now = Date.now() } = {}) {
  let unassigned = 0
  eachItem((t) => {
    let dirty = false
    if (t.assignee?.type === 'group' && t.assignee.id === groupId) {
      addHistory(t, { at: now, by: null, action: 'unassigned', from: { type: 'group', id: groupId, name: groupName ?? null }, to: null, reason: 'group deleted' })
      t.assignee = null
      t.formerAssignee = { type: 'group', name: groupName ?? null }
      t.updatedAt = now
      unassigned++
      dirty = true
    }
    // Claimed from it: the person keeps the task; it just cannot go back.
    if (t.claimedFrom === groupId) { t.claimedFrom = null; dirty = true }
    return dirty
  }, now)
  return unassigned
}
