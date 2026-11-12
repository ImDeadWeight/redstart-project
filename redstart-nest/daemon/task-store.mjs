'use strict'

// =============================================================================
// Redstart Nest — the task store (agent-runtime plan Phase 3, D22-D24)
// =============================================================================
// A task is one agent flow the daemon runs on its own, against one of the
// account's conversations, with no client attached (task-runner.mjs). This
// module only keeps its record and its log; it never runs anything.
//
//   <config>/tasks/<id>/task.json     the record, rewritten whole (it is small)
//   <config>/tasks/<id>/events.jsonl  append-only, one event per line, each
//                                     numbered (`seq`) so an SSE client that
//                                     reconnects replays from where it was
//                                     (Last-Event-ID, gateway/task-routes.mjs)
//
// A record, for D23's states:
//   queued            created, waiting for its first turn
//   running           generating or calling tools
//   waiting_user      a question (ask_user) or the turn-limit prompt is open;
//                     `waiting` says which
//   waiting_approval  a call is parked on a pending approval (`waiting`)
//   waiting_model     no model is loaded, or it stopped: resumes when one is
//   done | failed | cancelled   terminal
//
// Ownership is the account's memoryKey (memory-storage.mjs): the account id,
// or '_local' with auth off. `storeAccountId` is the conversations scope
// (conversations-storage.mjs keys records by account id, or by the client's
// device id with auth off), kept apart because with auth off the two differ.
//
// Subscribers (an open SSE stream) hear each event as it is appended. That is
// in memory: a client that was not connected reads the log.
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { configDir } from './platform-paths.mjs'
import { writeJsonAtomic, readJsonOr } from './json-store.mjs'

export const TASK_STATES = Object.freeze([
  'queued', 'running', 'waiting_user', 'waiting_approval', 'waiting_model', 'done', 'failed', 'cancelled',
])
export const TERMINAL_STATES = Object.freeze(['done', 'failed', 'cancelled'])
export const WAITING_STATES = Object.freeze(['waiting_user', 'waiting_approval', 'waiting_model'])
/** Kept, newest first, per account; older finished tasks are removed with their logs. */
export const MAX_FINISHED_PER_ACCOUNT = 50
/** One event's JSON is cut to this; a tool result in an event is a preview, the message holds it whole. */
export const MAX_EVENT_CHARS = 8000

const ID_RE = /^[0-9a-f-]{36}$/

function tasksDir() {
  return path.join(configDir(), 'tasks')
}

function taskDir(id) {
  return path.join(tasksDir(), id)
}

/** @param {unknown} id */
export function isTaskId(id) {
  return typeof id === 'string' && ID_RE.test(id)
}

/** The highest seq written per task, so appends need not re-read the log. */
const lastSeq = new Map()
/** id → Set<listener> */
const subscribers = new Map()

/**
 * @typedef {{
 *   id: string, accountKey: string, accountId: string | null, storeAccountId: string,
 *   conversationId: string, surface: string | null, status: string, waiting: object | null,
 *   limits: { maxTurns: number }, timeZone: string | null, error: string | null,
 *   inFlight: { callId: string, name: string } | null,
 *   createdAt: number, updatedAt: number, endedAt: number | null
 * }} TaskRecord
 */

/**
 * @param {{ accountKey: string, accountId?: string | null, storeAccountId: string, conversationId: string,
 *   surface?: string | null, limits?: { maxTurns?: number }, timeZone?: string | null }} spec
 * @returns {TaskRecord}
 */
export function createTask(spec) {
  if (typeof spec?.accountKey !== 'string' || !spec.accountKey) throw new Error('createTask: accountKey is required')
  if (typeof spec.storeAccountId !== 'string' || !spec.storeAccountId) throw new Error('createTask: storeAccountId is required')
  if (typeof spec.conversationId !== 'string' || !spec.conversationId) throw new Error('createTask: conversationId is required')
  const now = Date.now()
  /** @type {TaskRecord} */
  const task = {
    id: crypto.randomUUID(),
    accountKey: spec.accountKey,
    accountId: spec.accountId ?? null,
    storeAccountId: spec.storeAccountId,
    conversationId: spec.conversationId,
    surface: spec.surface ?? null,
    status: 'queued',
    waiting: null,
    limits: { maxTurns: Number.isInteger(spec.limits?.maxTurns) && spec.limits.maxTurns > 0 ? spec.limits.maxTurns : 100 },
    timeZone: typeof spec.timeZone === 'string' ? spec.timeZone : null,
    error: null,
    inFlight: null,
    createdAt: now,
    updatedAt: now,
    endedAt: null,
  }
  fs.mkdirSync(taskDir(task.id), { recursive: true })
  writeJsonAtomic(path.join(taskDir(task.id), 'task.json'), task)
  lastSeq.set(task.id, 0)
  appendEvent(task.id, { type: 'created', status: task.status })
  pruneFinished(task.accountKey)
  return task
}

/** @returns {TaskRecord | null} */
export function getTask(id) {
  if (!isTaskId(id)) return null
  return readJsonOr(path.join(taskDir(id), 'task.json'), null)
}

/**
 * Every task, or one account's, newest first.
 *
 * @param {string} [accountKey]
 * @returns {TaskRecord[]}
 */
export function listTasks(accountKey) {
  let names = []
  try { names = fs.readdirSync(tasksDir()) } catch { return [] }
  const out = []
  for (const name of names) {
    if (!isTaskId(name)) continue
    const t = getTask(name)
    if (!t) continue
    if (accountKey !== undefined && t.accountKey !== accountKey) continue
    out.push(t)
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

/** The task that holds this conversation, if one is still going. */
export function activeTaskFor(storeAccountId, conversationId) {
  return listTasks().find((t) => t.storeAccountId === storeAccountId && t.conversationId === conversationId
    && !TERMINAL_STATES.includes(t.status)) ?? null
}

/**
 * Change a task's record. `status` must be one of TASK_STATES; a terminal
 * task never changes again (a late callback from a cancelled run cannot
 * bring it back). A status change is logged as an event.
 *
 * @param {string} id
 * @param {Partial<Pick<TaskRecord, 'status' | 'waiting' | 'error' | 'inFlight'>>} patch
 * @returns {TaskRecord | null} null: no such task, or it had already ended
 */
export function updateTask(id, patch) {
  const t = getTask(id)
  if (!t || TERMINAL_STATES.includes(t.status)) return null
  const next = { ...t }
  if ('status' in patch) {
    if (!TASK_STATES.includes(patch.status)) throw new Error(`updateTask: unknown status ${patch.status}`)
    next.status = patch.status
    if (TERMINAL_STATES.includes(patch.status)) next.endedAt = Date.now()
    // Waiting is a property of a waiting state: leaving one clears it.
    if (!WAITING_STATES.includes(patch.status) && !('waiting' in patch)) next.waiting = null
  }
  if ('waiting' in patch) next.waiting = patch.waiting ?? null
  if ('error' in patch) next.error = typeof patch.error === 'string' ? patch.error.slice(0, 2000) : null
  if ('inFlight' in patch) next.inFlight = patch.inFlight ?? null
  next.updatedAt = Date.now()
  writeJsonAtomic(path.join(taskDir(id), 'task.json'), next)
  if ('status' in patch && patch.status !== t.status) {
    appendEvent(id, { type: 'status', status: next.status, waiting: next.waiting, error: next.error ?? undefined })
  }
  return next
}

function readLastSeq(id) {
  if (lastSeq.has(id)) return lastSeq.get(id)
  // First append since this process started. A crash mid-write can leave a
  // last line with no newline; the next append would be glued onto it and
  // lost with it, so close it first.
  const file = path.join(taskDir(id), 'events.jsonl')
  try {
    const raw = fs.readFileSync(file, 'utf8')
    if (raw && !raw.endsWith('\n')) fs.appendFileSync(file, '\n')
  } catch { /* no log yet */ }
  const events = readEvents(id, 0)
  const seq = events.length ? events[events.length - 1].seq : 0
  lastSeq.set(id, seq)
  return seq
}

/**
 * Append one event; subscribers hear it. Returns it with its seq and time.
 * An event too large for MAX_EVENT_CHARS keeps its type and says it was cut.
 *
 * @param {string} id
 * @param {{ type: string } & Record<string, unknown>} event
 */
export function appendEvent(id, event) {
  if (!isTaskId(id)) throw new Error('appendEvent: not a task id')
  const seq = readLastSeq(id) + 1
  let full = { seq, at: Date.now(), ...event }
  let line = JSON.stringify(full)
  if (line.length > MAX_EVENT_CHARS) {
    full = { seq, at: full.at, type: event.type, truncated: true }
    line = JSON.stringify(full)
  }
  fs.appendFileSync(path.join(taskDir(id), 'events.jsonl'), `${line}\n`)
  lastSeq.set(id, seq)
  for (const fn of subscribers.get(id) ?? []) {
    try { fn(full) } catch { /* a subscriber's failure is its own */ }
  }
  return full
}

/**
 * The events after `afterSeq`, oldest first. A line that does not parse (a
 * write cut short by a crash) is skipped.
 */
export function readEvents(id, afterSeq = 0) {
  if (!isTaskId(id)) return []
  let raw = ''
  try { raw = fs.readFileSync(path.join(taskDir(id), 'events.jsonl'), 'utf8') } catch { return [] }
  const out = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      const e = JSON.parse(line)
      if (typeof e?.seq === 'number' && e.seq > afterSeq) out.push(e)
    } catch { /* torn line */ }
  }
  return out
}

/** @returns {() => void} unsubscribe */
export function subscribe(id, fn) {
  if (!subscribers.has(id)) subscribers.set(id, new Set())
  subscribers.get(id).add(fn)
  return () => {
    const set = subscribers.get(id)
    if (!set) return
    set.delete(fn)
    if (set.size === 0) subscribers.delete(id)
  }
}

/** Finished tasks past MAX_FINISHED_PER_ACCOUNT are removed, oldest first, with their logs. */
function pruneFinished(accountKey) {
  const finished = listTasks(accountKey).filter((t) => TERMINAL_STATES.includes(t.status))
  for (const t of finished.slice(MAX_FINISHED_PER_ACCOUNT)) {
    try { fs.rmSync(taskDir(t.id), { recursive: true, force: true }) } catch { /* next time */ }
    lastSeq.delete(t.id)
  }
}

/** Tests only. */
export function _resetMemory() {
  lastSeq.clear()
  subscribers.clear()
}
