// =============================================================================
// Redstart Nest — the approval ledger: pending approvals (agent-runtime plan
// Phase 2, D12)
// =============================================================================
// An enforced tool (tools-definitions.mjs, isApprovalEnforced) called without
// an approval does nothing: mcp-server.mjs asks this ledger for a pending
// approval and returns it to the client. The client decides it with the
// person and posts the decision (gateway/approval-routes.mjs), then repeats
// the call with the approval's id, which consume() accepts ONCE, and only for
// the same account, the same tool and the same arguments.
//
// What that binding buys (security.md, "Approvals"): a decision is for one
// exact call. An approval for "delete notes/a.md" cannot be spent on
// "delete notes/b.md", by another account, twice, or after it expired. What
// it does not buy: the approval protects the user from the model, not the
// server from the user (D5). A client holding the account's key is the
// account, and could approve its own calls.
//
// In memory only. The gateway and the MCP server run in one daemon process
// (ipc/server.mjs), so the route that decides and the handler that consumes
// see the same map. A restart drops every pending approval; that costs the
// client one repeat, and is better than a decision outliving the process.
//
// The arguments are never stored, only their digest (sha256 over canonical
// JSON), and the summary a client may show, which is cut short.
// =============================================================================

import crypto from 'node:crypto'

/** A pending approval lives this long: the client shows its card before it calls (plan P2-d). */
export const APPROVAL_TTL_MS = 60_000
/** At most this many pending per account; the oldest goes first. */
export const MAX_PENDING_PER_ACCOUNT = 20
export const MAX_SUMMARY_CHARS = 200

/**
 * JSON with every object's keys sorted, recursively, so {a,b} and {b,a}
 * digest alike. Arrays keep their order (it is meaning).
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
}

/** @param {unknown} args */
export function argsDigest(args) {
  return crypto.createHash('sha256').update(canonicalJson(args ?? {})).digest('hex')
}

/** What a card may show: the tool and its arguments, cut short. */
export function approvalSummary(tool, args) {
  const text = `${tool} ${canonicalJson(args ?? {})}`
  return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS - 1)}…` : text
}

/**
 * @typedef {{ id: string, accountKey: string, tool: string, argsDigest: string,
 *   summary: string, expiresAt: number, decision: 'once' | 'always' | 'deny' | null, holder?: string | null }} Pending
 */

/** id → Pending */
const pending = new Map()

let now = () => Date.now()

/** Tests only: a fake clock. */
export function _setClock(fn) {
  now = fn ?? (() => Date.now())
}

/** Tests only: forget everything. */
export function _reset() {
  pending.clear()
}

function sweep() {
  const t = now()
  for (const [id, p] of pending) if (p.expiresAt <= t) pending.delete(id)
}

/**
 * A pending approval a background task holds (task-runner.mjs) lives this
 * long: nobody may look at the chat for days. The task withdraws it when it
 * ends (withdraw), and a restart drops it like any other.
 */
export const HELD_APPROVAL_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Called with (id, decision, pending) after every decision. */
const decidedListeners = new Set()

/**
 * Hear every decision (the task runner resumes a parked call on it).
 *
 * @param {(id: string, decision: 'once' | 'always' | 'deny', p: { accountKey: string, tool: string, holder: string | null }) => void} fn
 * @returns {() => void} stop listening
 */
export function onDecided(fn) {
  decidedListeners.add(fn)
  return () => decidedListeners.delete(fn)
}

/**
 * Open a pending approval for one call.
 *
 * `holder` (a task id) marks one a background task is parked on: it lives
 * HELD_APPROVAL_TTL_MS, and the per-account cap never evicts it. A chat
 * opening its twenty-first card must not silently strand a task.
 *
 * @param {{ accountKey: string, tool: string, args: unknown, holder?: string | null }} call
 * @returns {{ id: string, tool: string, summary: string, argsDigest: string, expiresAt: number }}
 */
export function requestApproval({ accountKey, tool, args, holder = null }) {
  if (typeof accountKey !== 'string' || !accountKey) throw new Error('requestApproval: accountKey is required')
  sweep()
  const mine = [...pending.values()].filter((p) => p.accountKey === accountKey && !p.holder)
  if (!holder && mine.length >= MAX_PENDING_PER_ACCOUNT) {
    // Map iteration is insertion order: the first of mine is the oldest.
    pending.delete(mine[0].id)
  }
  const p = {
    id: crypto.randomUUID(),
    accountKey,
    tool,
    argsDigest: argsDigest(args),
    summary: approvalSummary(tool, args),
    expiresAt: now() + (holder ? HELD_APPROVAL_TTL_MS : APPROVAL_TTL_MS),
    decision: null,
    holder: typeof holder === 'string' && holder ? holder : null,
  }
  pending.set(p.id, p)
  return { id: p.id, tool: p.tool, summary: p.summary, argsDigest: p.argsDigest, expiresAt: p.expiresAt }
}

/** Remove a pending approval its holder no longer waits on (the task ended). */
export function withdraw(id) {
  return pending.delete(id)
}

/**
 * Record the person's decision. One decision per approval.
 *
 * @param {string} id
 * @param {string} accountKey
 * @param {'once' | 'always' | 'deny'} decision
 * @returns {{ ok: true, tool: string } | { ok: false, error: 'not found' | 'already decided' }}
 *   'not found' also covers another account's id and an expired one: a
 *   prober learns nothing from the difference.
 */
export function decide(id, accountKey, decision) {
  sweep()
  const p = pending.get(id)
  if (!p || p.accountKey !== accountKey) return { ok: false, error: 'not found' }
  if (p.decision !== null) return { ok: false, error: 'already decided' }
  p.decision = decision
  if (decision === 'deny') pending.delete(id)
  for (const fn of decidedListeners) {
    try { fn(id, decision, { accountKey: p.accountKey, tool: p.tool, holder: p.holder ?? null }) } catch { /* a listener's failure is its own */ }
  }
  return { ok: true, tool: p.tool }
}

/**
 * Spend an approval on the call it was made for. True once; the approval is
 * gone afterwards whatever the answer, so a wrong call cannot be retried
 * against it either.
 *
 * @param {string} id
 * @param {{ accountKey: string, tool: string, args: unknown }} call
 */
export function consume(id, { accountKey, tool, args }) {
  sweep()
  const p = typeof id === 'string' ? pending.get(id) : undefined
  if (!p || p.accountKey !== accountKey) return false
  pending.delete(id)
  if (p.decision !== 'once' && p.decision !== 'always') return false
  return p.tool === tool && p.argsDigest === argsDigest(args)
}

/** Tests and diagnostics: how many are pending. */
export function pendingCount() {
  sweep()
  return pending.size
}
