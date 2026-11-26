'use strict'

// =============================================================================
// Redstart Nest — closing and re-running what a restart left open
// =============================================================================
// job-runner.mjs re-enters a job after the daemon went down (resumeJobs,
// 3.7). A turn is stored only once it is complete, so the conversation says
// where the loop was: a trailing answer means the task had finished and only
// its status was not written; a trailing assistant message with calls that
// have no result means those calls were running or not yet reached. Split
// out of runOnce in master plan Phase 4.
// =============================================================================

import { runToolCalls } from '../../shared/agent-core/tool-calls.mjs'
import { createAgenticTimings, createTurnStats } from '../../shared/agent-core/timings.mjs'
import * as store from './job-store.mjs'

export const INTERRUPTED_BY_RESTART = 'Interrupted by a restart. Its effect is unknown: check before repeating it.'

/** The loop's last word was an answer: the task had finished (a crash between it and the status). */
export function finishedBeforeRestart(pass) {
  const last = pass.branch[pass.branch.length - 1]
  return last.role === 'assistant' && !last.toolCalls
}

/**
 * Calls the last assistant message asked for that have no result yet. The
 * one that was running when the daemon went down (the task's inFlight) is
 * closed as interrupted, since its effect is unknown; the rest run now,
 * through the same ports, so an open question or approval is put again.
 *
 * @returns {Promise<'stopped' | null>} 'stopped' when running them ended the flow
 */
export async function resumeOpenCalls(pass, { ports, callbacks }) {
  const last = pass.branch[pass.branch.length - 1]
  if (last.role !== 'assistant' || !last.toolCalls) return null
  let calls = []
  try { calls = JSON.parse(last.toolCalls) } catch { calls = [] }
  const answered = new Set(pass.branch.filter((m) => m.role === 'tool').map((m) => m.toolCallId))
  const open = calls.filter((c) => c?.id && !answered.has(c.id))
  if (open.length === 0) return null

  const inFlightId = store.getJob(pass.task.id).inFlight?.callId
  const toRun = []
  for (const c of open) {
    if (c.id === inFlightId) {
      await callbacks.createToolResultMessage(c.id, INTERRUPTED_BY_RESTART)
      pass.messages.push({ role: 'tool', tool_call_id: c.id, content: INTERRUPTED_BY_RESTART })
    } else {
      toRun.push(c)
    }
  }
  store.updateJob(pass.task.id, { inFlight: null })
  if (toRun.length > 0) {
    await pass.refresh({ needModel: false })
    const outcome = await runToolCalls({
      calls: toRun, messages: pass.messages, agenticTimings: createAgenticTimings(), turnStats: createTurnStats(0), capturedTimings: undefined,
      ports, callbacks, signal: pass.signal,
    })
    if (outcome === 'stopped') return 'stopped'
  }
  pass.newTurn()
  return null
}
