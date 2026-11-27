'use strict'

// =============================================================================
// Redstart Nest — a task given to the assistant (tasks plan Phase 4)
// =============================================================================
// When a task on the team's list is given to the assistant, it runs as a
// background job (task-runner.mjs), the same machinery as /task:
//
//   - as the person who gave it the task, with their tools and their access,
//     never more (the job runner's own per-turn account check applies);
//   - in a new chat of theirs, in the task's project when it has one, so the
//     project's instructions and files are there and the person can follow
//     it, answer its questions and approve its writes like any job;
//   - with the task's own words as the request: the title, notes and due date
//     the person wrote, so this is user-tier text, never an instruction from
//     Nest.
//
// While it runs the task shows "In progress". When the job ends, the task
// goes back to that person (assignments-storage recordAgentEnd): To do after
// a finished job, Blocked after a failed or stopped one, with a comment that
// points at the chat. A person checks the work; the assistant never marks it
// done.
//
// Survives a restart: the job runner resumes its jobs, and at start-up any
// task whose job ended while Nest was down is settled (reconcile below).
// =============================================================================

import * as crypto from 'node:crypto'
import * as store from './assignments-storage.mjs'
import { startTask, onTaskEnded } from './task-runner.mjs'
import { getTask, TERMINAL_STATES } from './task-store.mjs'
import { createConversation } from './conversations-storage.mjs'
import { logEvent } from './logger.mjs'

/** The request the job starts with: the task as the person wrote it. */
export function requestFor(item, giverName) {
  const lines = [
    `This task from ${giverName ? `${giverName}'s` : 'my'} task list is yours to do. Do it, then say briefly what you did and anything that still needs a person.`,
    '',
    `Task: ${item.title}`,
  ]
  if (item.notes) lines.push(`Notes: ${item.notes}`)
  if (item.dueDate) lines.push(`Due: ${item.dueDate}`)
  return lines.join('\n')
}

/**
 * Start the assistant on a task just given to it. `who` is the route's
 * caller: the account, the conversations scope, the surface and time zone,
 * as the /tasks route passes them to the job runner.
 *
 * @returns {{ ok: true, jobId: string, conversationId: string } | { ok: false, error: string }}
 */
export function startAgentOn(item, who) {
  if (item?.assignee?.type !== 'agent') return { ok: false, error: 'not the assistant\'s' }
  if (item.agentRun && !item.agentRun.endedAt) return { ok: false, error: 'already running' }
  const account = who.account ?? null
  if (!account) return { ok: false, error: 'The assistant can take tasks only with sign-in on.' }
  const conversationId = crypto.randomUUID()
  createConversation(who.storeAccountId, {
    id: conversationId,
    name: `Task: ${item.title}`.slice(0, 120),
    ...(item.projectId ? { projectId: item.projectId } : {}),
    currNode: '',
    messages: [],
  })
  const r = startTask({
    account,
    storeAccountId: who.storeAccountId,
    conversationId,
    content: requestFor(item, account.username),
    origin: 'background',
    surface: who.surface ?? null,
    timeZone: who.timeZone ?? null,
  })
  if (!r.ok) {
    logEvent('assignment', 'agent_not_started', { reason: r.error })
    return { ok: false, error: r.error }
  }
  const jobId = r.task?.id ?? r.id
  store.recordAgentStart(item.id, { jobId, conversationId, by: account.id })
  logEvent('assignment', 'agent_started', {})
  return { ok: true, jobId, conversationId }
}

/**
 * A task given to the assistant whose job could not start goes straight back,
 * Blocked, with the reason; nothing is left looking as if it were in hand.
 */
export function handBackUnstarted(account, item, reason) {
  const back = account ? { type: 'account', id: account.id } : null
  store.updateAssignment(account, item.id, { assignee: back, status: 'blocked' }, { via: 'assistant' })
  return store.addComment(account, item.id, { text: `The assistant could not start: ${reason}` })
}

let initialized = false

/**
 * Called once at start-up (daemon.mjs), after the job runner has resumed its
 * jobs: listen for jobs ending, and settle any task whose job ended while
 * Nest was down (or whose job record is gone).
 */
export function initAssignmentAgent() {
  if (initialized) return
  initialized = true
  onTaskEnded((task, status, error) => {
    const id = store.recordAgentEnd(task.id, status, error)
    if (id) logEvent('assignment', 'agent_ended', { outcome: status })
  })
  reconcile()
}

export function reconcile() {
  let settled = 0
  for (const { jobId } of store.openAgentRuns()) {
    const job = getTask(jobId)
    if (!job) { store.recordAgentEnd(jobId, 'failed', 'The job record is gone.'); settled++; continue }
    if (TERMINAL_STATES.includes(job.status)) { store.recordAgentEnd(jobId, job.status, job.error ?? null); settled++ }
  }
  return settled
}

/** For tests. */
export function _resetForTests() { initialized = false }

