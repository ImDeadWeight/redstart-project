// =============================================================================
// Agent bench — Phase 2 checks: approvals (agent-runtime plan Phase 2)
// =============================================================================
// Judged on the File System folder as the run left it (ctx.fileSystemAfter,
// listed by the bench before its cleanup) and on the run log: the delete has
// to go through delete_file and the approval exchange, not around it.
// =============================================================================

import { fail, pass, toolCallsNamed } from './lib.mjs'

const GONE = 'p2-old-draft.txt'
const KEPT = 'p2-final.txt'

const has = (paths, name) => paths.some((p) => p === name || p.endsWith(`/${name}`) && !p.startsWith('.trash/'))

export function deletedWithApproval(_text, _files, events, ctx) {
  const after = ctx?.fileSystemAfter
  if (!Array.isArray(after)) {
    return fail('the File System folder could not be listed after the run (too many entries, or File System is off for this account)')
  }
  const deletes = toolCallsNamed(events, 'delete_file')
  const approved = (events ?? []).some((e) => e.type === 'approval' && e.name === 'delete_file' && e.decided)
  if (has(after, GONE)) {
    return fail(deletes.length
      ? `${GONE} is still there after ${deletes.length} delete_file call(s)${approved ? '' : '; no approval was decided'}`
      : `${GONE} is still there: delete_file was never called`)
  }
  if (!has(after, KEPT)) return fail(`${KEPT} is gone too: the task said to keep it`)
  if (deletes.length === 0) return fail(`${GONE} is gone, but not through delete_file`)
  if (!approved) return fail(`${GONE} is gone without the approval exchange: Nest did not ask for an approval (enforcement off, or an older Nest)`)
  return pass(`deleted ${GONE} through delete_file after an approval, and kept ${KEPT}`)
}
