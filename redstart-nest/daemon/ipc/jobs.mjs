'use strict'

// =============================================================================
// Redstart Nest — control plane: every account's background jobs
// (agent-runtime plan Phase 3, D31; called tasks until tasks plan Phase 0)
// =============================================================================
// Owner-only by the control plane's own gate (admin-listener.mjs), which runs
// before any table entry; nothing here checks a role again, and nothing here
// is reachable from the gateway.
//
//   jobs:list     every job, newest first, with the owning username. The
//                 record only: never the conversation's messages, the
//                 question text or an approval's summary, which are the
//                 account's own (the same line the decision log keeps).
//   jobs:cancel   stop one by id (logged).
//
// An account's own jobs are on the gateway (gateway/job-routes.mjs).
// Table-only, like approvals.mjs.
// =============================================================================

import { listJobs } from '../job-store.mjs'
import { cancelJob } from '../job-runner.mjs'
import { findById } from '../accounts-storage.mjs'
import { logEvent } from '../logger.mjs'

const MAX_LISTED = 200

/** @returns {{ jobs: object[] }} */
export function listAllJobs() {
  const names = new Map()
  const username = (id) => {
    if (!id) return null
    if (!names.has(id)) names.set(id, findById(id)?.username ?? '(deleted account)')
    return names.get(id)
  }
  return {
    jobs: listJobs().slice(0, MAX_LISTED).map((t) => ({
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
export function cancelAnyJob(id) {
  if (typeof id !== 'string' || !id) return { ok: false, error: 'not a job id' }
  const r = cancelJob(id, 'owner')
  if (!r.ok) return { ok: false, error: r.error }
  logEvent('task', 'cancelled_by_owner', {})
  return { ok: true }
}

export function jobsHandlers() {
  return {
    'jobs:list': () => listAllJobs(),
    'jobs:cancel': (id) => cancelAnyJob(id),
  }
}
