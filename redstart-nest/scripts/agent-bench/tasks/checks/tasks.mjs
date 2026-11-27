// =============================================================================
// Checks for the tasks group (tasks plan Phase 2, 2026-11-27)
// =============================================================================
// People's tasks are "assignments" to the model (assignment_create and
// friends), because "task" is the work in front of it in every prompt. These
// two measure the line between them:
//
//   tasks-plan-not-filed    multi-step work, no request for tasks: its steps
//                           stay its own (update_plan or none), and nothing
//                           lands on the team's list
//   tasks-file-action-items three action items asked for: all three added,
//                           in ONE assignment_create (one approval card)
//
// A call through call_tool counts as the tool itself (withCallTool).
// =============================================================================

import { pass, fail, fixture, groupSum, mentionsNumber, toolCallsNamed } from './lib.mjs'

const regionTotals = () => groupSum(fixture('sales.csv'), 'region', 'amount')

/** A call's own arguments, whether made directly or through call_tool. */
function argsOf(event) {
  let a = event?.arguments
  if (typeof a === 'string') {
    try { a = JSON.parse(a) } catch { return null }
  }
  if (event?.viaCallTool && a && typeof a === 'object' && 'arguments' in a) {
    a = typeof a.arguments === 'string' ? (() => { try { return JSON.parse(a.arguments) } catch { return null } })() : a.arguments
  }
  return a && typeof a === 'object' ? a : null
}

const filedCalls = (events) => [...toolCallsNamed(events, 'assignment_create'), ...toolCallsNamed(events, 'assignment_update')]

export function plannedWithoutFiling(text, _files, events) {
  if (filedCalls(events).length) return fail('put its own steps on the team\'s task list')
  const totals = regionTotals()
  const grand = [...totals.values()].reduce((a, b) => a + b, 0)
  const [top] = [...totals.entries()].sort((a, b) => b[1] - a[1])[0]
  if (!mentionsNumber(text, grand)) return fail(`the overall total ${grand} not stated`)
  if (!new RegExp(`\\b${top}\\b`, 'i').test(text)) return fail(`the top region (${top}) not named`)
  return pass(`answered (${grand}, ${top}) without filing tasks`)
}

const WANTED = [['school', /school/i], ['interpreter', /interpreter/i], ['referral form', /referral/i]]

export function filedActionItems(_text, _files, events) {
  const calls = toolCallsNamed(events, 'assignment_create')
  if (calls.length === 0) return fail('added no tasks')
  const items = calls.flatMap((c) => (Array.isArray(argsOf(c)?.items) ? argsOf(c).items : []))
  const titles = items.map((it) => `${it?.title ?? ''} ${it?.notes ?? ''}`)
  const missing = WANTED.filter(([, re]) => !titles.some((t) => re.test(t))).map(([name]) => name)
  if (missing.length) return fail(`missing: ${missing.join(', ')}`)
  if (items.length !== 3) return fail(`${items.length} tasks for three action items`)
  if (calls.length > 1) return fail(`three tasks in ${calls.length} calls: ${calls.length} approvals instead of one`)
  return pass('the three action items, in one call')
}
