'use strict'

// =============================================================================
// Redstart Nest — control plane: every account's background tasks
// (agent-runtime plan Phase 3, D31)
// =============================================================================
// Owner-only by the control plane's own gate (admin-listener.mjs), which runs
// before any table entry; nothing here checks a role again, and nothing here
// is reachable from the gateway.
//
//   tasks:list    every task, newest first, with the owning username. The
//                 record only: never the conversation's messages, the
//                 question text or an approval's summary, which are the
//                 account's own (the same line the decision log keeps).
//   tasks:cancel  stop one by id (logged).
//
// An account's own tasks are on the gateway (gateway/task-routes.mjs).
// Table-only, like approvals.mjs.
// =============================================================================

import { listTasks } from '../task-store.mjs'
import { cancelTask } from '../task-runner.mjs'
import { findById } from '../accounts-storage.mjs'
import { logEvent } from '../logger.mjs'

const MAX_LISTED = 200

/** @returns {{ tasks: object[] }} */
export function listAllTasks() {
  const names = new Map()
  const username = (id) => {
    if (!id) return null
    if (!names.has(id)) names.set(id, findById(id)?.username ?? '(deleted account)')
    return names.get(id)
  }
  return {
    tasks: listTasks().slice(0, MAX_LISTED).map((t) => ({
      id: t.id,
      account: username(t.accountId),
      status: t.status,
      // What it waits for, by kind only.
      waitingFor: t.waiting?.kind ?? null,
      tool: t.waiting?.kind === 'approval' ? t.waiting.tool : null,
      error: t.error,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      endedAt: t.endedAt,
    })),
  }
}

/** @returns {{ ok: true } | { ok: false, error: string }} */
export function cancelAnyTask(id) {
  if (typeof id !== 'string' || !id) return { ok: false, error: 'not a task id' }
  const r = cancelTask(id, 'owner')
  if (!r.ok) return { ok: false, error: r.error }
  logEvent('task', 'cancelled_by_owner', {})
  return { ok: true }
}

export function tasksHandlers() {
  return {
    'tasks:list': () => listAllTasks(),
    'tasks:cancel': (id) => cancelAnyTask(id),
  }
}
