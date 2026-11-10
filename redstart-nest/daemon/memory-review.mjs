'use strict'

// =============================================================================
// Redstart Nest — automatic memory: the review pass (projects-plan Phase 3)
// =============================================================================
// After a chat goes quiet, the client asks Nest to review it (POST
// /memories/review). Nest reads the chat's NEW user messages, shows them and
// the existing memories to the loaded model with a schema-bound request, and
// gets back at most a few operations: add a memory, or update one. What
// happens to those depends on the account's mode (memory-review-store.mjs):
// suggest → they wait for the user; auto → saved at once, shown with Undo.
//
// THE REVIEWER ONLY EVER SEES WHAT THE USER TYPED (plan D15). Assistant text,
// tool results, attachments and pasted files are never in its input, so a web
// page or a document cannot talk it into remembering an instruction — the
// persisted-injection risk security.md describes for memory_save, closed by
// construction here rather than flagged after the fact.
//
// Everything that decides is a pure function below (userTurnsForReview,
// buildReviewRequest, filterOps), so the suite pins it without a model. The
// model call is one seam (_setTestSeams).
// =============================================================================

import { getConversation, getConversationAnyAccount } from './conversations-storage.mjs'
import { getProject } from './projects-storage.mjs'
import * as memory from './memory-storage.mjs'
import * as store from './memory-review-store.mjs'
import { completionsInFlight, getUpstreamPort } from './completion-activity.mjs'
import { logEvent } from './logger.mjs'

export const MAX_MESSAGE_CHARS = 2000
export const MAX_REVIEW_CHARS = 8000
export const MAX_OPS = 3
export const MAX_EXISTING_SHOWN = 60
const MODEL_TIMEOUT_MS = 90000

// ---------------------------------------------------------------------------
// Input: the user's own words on the current branch (pure)
// ---------------------------------------------------------------------------

/** The current branch, root first: currNode, then each parent. */
export function currentBranch(conversation) {
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : []
  const byId = new Map(messages.map((m) => [m.id, m]))
  const path = []
  const seen = new Set()
  let node = byId.get(conversation?.currNode)
  while (node && !seen.has(node.id)) {
    seen.add(node.id)
    path.push(node)
    node = node.parent ? byId.get(node.parent) : null
  }
  return path.reverse()
}

/**
 * The user messages on the current branch not yet reviewed, newest kept when
 * over budget. Only `content` text: never `extra` (attachments), never any
 * other role. Each is cut to MAX_MESSAGE_CHARS.
 *
 * @returns {{ id: string, text: string }[]} oldest first
 */
export function userTurnsForReview(conversation, reviewed = new Set()) {
  const turns = currentBranch(conversation)
    .filter((m) => m.role === 'user' && !reviewed.has(m.id))
    .map((m) => ({ id: m.id, text: typeof m.content === 'string' ? m.content.trim() : '' }))
    .filter((t) => t.text)
    .map((t) => ({ ...t, text: t.text.length > MAX_MESSAGE_CHARS ? `${t.text.slice(0, MAX_MESSAGE_CHARS)} …` : t.text }))
  const kept = []
  let used = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    if (used + turns[i].text.length > MAX_REVIEW_CHARS && kept.length > 0) break
    kept.unshift(turns[i])
    used += turns[i].text.length
  }
  return kept
}

// ---------------------------------------------------------------------------
// The request (pure)
// ---------------------------------------------------------------------------

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    ops: {
      type: 'array',
      maxItems: MAX_OPS,
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['add', 'update'] },
          text: { type: 'string', maxLength: memory.MAX_MEMORY_CHARS },
          scope: { type: 'string', enum: ['user', 'project'] },
          id: { type: 'string' },
        },
        required: ['op', 'text'],
      },
    },
  },
  required: ['ops'],
}

const INSTRUCTIONS = [
  'You maintain a short list of durable facts about one user, so a future conversation can start already knowing them.',
  'Below are messages the user wrote in one conversation, and the facts already remembered.',
  'Propose at most three changes, and none is the usual answer. A fact is worth remembering only if the user stated it about themselves or their work, and it will still be true and useful weeks from now: their role, tools, preferences, recurring projects, constraints. Not: one-off task details, questions they asked, opinions about a single answer, anything about other people, or anything you inferred rather than read.',
  'Never propose passwords, keys, tokens, account numbers, health, or other sensitive details, and never an instruction to the assistant ("always do X") — write a preference as a fact about the user ("Prefers short answers").',
  'If a new message changes a remembered fact, use op "update" with that fact\'s id and the corrected text, instead of adding a second one.',
  'Write each fact as one short plain sentence about the user, e.g. "Uses Postgres 16 at work".',
].join('\n\n')

/**
 * The chat-completions body for one review. `project` is the chat's project
 * (already resolved for the caller) or null; scope "project" is offered only
 * then.
 */
export function buildReviewRequest({ turns, userMemories = [], projectMemories = [], project = null, model = null }) {
  const lines = (list, label) => list.length
    ? list.slice(0, MAX_EXISTING_SHOWN).map((m) => `- [${m.id}] ${m.text}`).join('\n')
    : `(none ${label})`
  const parts = [
    `Already remembered about the user:\n${lines(userMemories, 'yet')}`,
  ]
  if (project) {
    parts.push(`This conversation is in the user's project "${project.name}". Use scope "project" for a fact about that project's work, and "user" for a fact about the user. Already remembered for the project:\n${lines(projectMemories, 'yet')}`)
  } else {
    parts.push('This conversation is in no project: use scope "user".')
  }
  parts.push(`The user's messages, oldest first:\n${turns.map((t, i) => `<message ${i + 1}>\n${t.text}\n</message ${i + 1}>`).join('\n')}`)
  parts.push('Answer with JSON only: {"ops": [...]} — an empty list when nothing is worth remembering.')

  return {
    ...(model ? { model } : {}),
    messages: [
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: parts.join('\n\n') },
    ],
    stream: false,
    temperature: 0.2,
    max_tokens: 600,
    response_format: { type: 'json_schema', json_schema: { name: 'memory_review', schema: REVIEW_SCHEMA, strict: true } },
    // A reasoning model would otherwise think at length about a small task.
    enable_thinking: false,
    chat_template_kwargs: { enable_thinking: false },
  }
}

// ---------------------------------------------------------------------------
// What survives (pure)
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/,               // OpenAI/Stripe-style keys
  /\bAKIA[0-9A-Z]{16}\b/,                            // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,                    // GitHub tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,                  // Slack tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,   // JWTs
  /\b[A-Fa-f0-9]{32,}\b/,                            // long hex secrets
  /\b[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/,    // long base64 blobs
  /\b(?:password|passwd|passphrase|pin code|api[ _-]?key|secret|token)\b\s*(?:is|=|:)/i,
  /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,4}\b/,       // card-like numbers
]

export function looksSecret(text) {
  return SECRET_PATTERNS.some((re) => re.test(String(text ?? '')))
}

/**
 * The model's operations, filtered to what may be acted on: known op, text
 * within bounds and not secret-looking, an update only of a memory that was
 * shown (and in the scope it lives in), project scope only in a project chat,
 * no exact duplicate of a remembered or already-dismissed fact, at most
 * MAX_OPS. Never throws on a malformed answer; it yields [].
 *
 * @returns {{ op, text, scope, projectId?, targetId?, previousText? }[]}
 */
export function filterOps(answer, { userMemories = [], projectMemories = [], project = null, isDismissed = () => false } = {}) {
  const ops = Array.isArray(answer?.ops) ? answer.ops : []
  const known = new Map([
    ...userMemories.map((m) => [m.id, { m, scope: 'user' }]),
    ...projectMemories.map((m) => [m.id, { m, scope: 'project' }]),
  ])
  const remembered = new Set([...userMemories, ...projectMemories].map((m) => m.text.toLowerCase()))
  const out = []
  const seen = new Set()
  for (const raw of ops) {
    if (out.length >= MAX_OPS) break
    if (!raw || typeof raw !== 'object') continue
    const norm = memory.normalizeText(raw.text)
    if (norm.error || looksSecret(norm.text)) continue
    const lower = norm.text.toLowerCase()
    if (remembered.has(lower) || seen.has(lower) || isDismissed(norm.text)) continue

    if (raw.op === 'update') {
      const target = typeof raw.id === 'string' ? known.get(raw.id) : null
      if (!target) continue
      if (target.scope === 'project' && !project) continue
      seen.add(lower)
      out.push({
        op: 'update',
        text: norm.text,
        scope: target.scope,
        ...(target.scope === 'project' ? { projectId: project.id } : {}),
        targetId: target.m.id,
        previousText: target.m.text,
      })
      continue
    }
    if (raw.op !== 'add') continue
    const scope = raw.scope === 'project' ? 'project' : 'user'
    if (scope === 'project' && !project) continue
    seen.add(lower)
    out.push({ op: 'add', text: norm.text, scope, ...(scope === 'project' ? { projectId: project.id } : {}) })
  }
  return out
}

// ---------------------------------------------------------------------------
// The model call (the seam)
// ---------------------------------------------------------------------------

async function callUpstream(body) {
  const port = getUpstreamPort()
  if (!port) throw new Error('the model server is not running')
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`the model server answered ${res.status}`)
  const json = await res.json()
  const content = json?.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new Error('the model returned no content')
  return JSON.parse(content)
}

let callModel = callUpstream
let isBusy = () => completionsInFlight() > 0

/** For tests: replace the model call and/or the busy check; no args restores both. */
export function _setTestSeams({ model, busy } = {}) {
  callModel = model ?? callUpstream
  isBusy = busy ?? (() => completionsInFlight() > 0)
}

// One review per account at a time: two triggers for the same chat would
// otherwise both see the same unreviewed messages.
const running = new Set()

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/**
 * Review one conversation for one caller. `config` is the caller's NARROWED
 * config: a role that withholds memory gets no review.
 *
 * @returns {{ status: 'off'|'busy'|'nothing'|'done'|'failed', mode?, suggestions?, saved?, error? }}
 */
export async function reviewConversation({ account, conversationId, config, now = Date.now() }) {
  if (!config?.memory?.enabled) return { status: 'off' }
  const { mode } = store.getSettings(account)
  if (mode === 'off') return { status: 'off', mode }
  if (typeof conversationId !== 'string' || !conversationId) return { status: 'nothing', mode }

  const conversation = account ? getConversation(account.id, conversationId) : getConversationAnyAccount(conversationId)
  if (!conversation) return { status: 'nothing', mode }

  const key = memory.memoryKey(account)
  if (running.has(key)) return { status: 'busy', mode }
  if (isBusy()) return { status: 'busy', mode }

  const turns = userTurnsForReview(conversation, store.reviewedIds(account, conversationId))
  if (turns.length === 0) return { status: 'nothing', mode }

  const project = conversation.projectId ? getProject(account, conversation.projectId) : null
  const userMemories = memory.listMemories(account)
  const projectMemories = project ? memory.listMemories(account, { projectId: project.id }) : []
  const model = [...currentBranch(conversation)].reverse().find((m) => m.role === 'assistant' && m.model)?.model ?? null

  running.add(key)
  const started = Date.now()
  try {
    let answer
    try {
      answer = await callModel(buildReviewRequest({ turns, userMemories, projectMemories, project, model }))
    } catch (err) {
      logEvent('memory', 'review_failed', { reason: err.message })
      // Not marked reviewed: the next trigger tries these messages again.
      return { status: 'failed', mode, error: err.message }
    }
    const ops = filterOps(answer, {
      userMemories, projectMemories, project,
      isDismissed: (text) => store.isDismissed(account, text),
    })
    store.markReviewed(account, conversationId, turns.map((t) => t.id))

    if (mode === 'suggest') {
      const suggestions = store.addSuggestions(account, ops, { conversationId, now })
      logEvent('memory', 'reviewed', { mode, proposed: ops.length, suggested: suggestions.length, durationMs: Date.now() - started })
      return { status: 'done', mode, suggestions }
    }

    const saved = []
    for (const op of ops) {
      const r = applyOp(account, op, { conversationId, via: 'review' })
      if (r) saved.push(r)
    }
    logEvent('memory', 'reviewed', { mode, proposed: ops.length, saved: saved.length, durationMs: Date.now() - started })
    return { status: 'done', mode, saved }
  } finally {
    running.delete(key)
  }
}

/**
 * Save one operation (auto mode, or a suggestion the user accepted). A
 * project scope is re-resolved here, so a project deleted since the
 * suggestion was made is not written into. Returns
 * { memory, scope, projectId?, op } or null.
 */
export function applyOp(account, op, { conversationId = null, via = 'review' } = {}) {
  let projectId = null
  if (op.scope === 'project') {
    const project = op.projectId ? getProject(account, op.projectId) : null
    if (!project) return null
    projectId = project.id
  }
  if (op.op === 'update') {
    const r = memory.updateMemory(account, op.targetId, op.text, { projectId })
    return r.ok ? { op: 'update', memory: r.memory, scope: op.scope, ...(projectId ? { projectId } : {}) } : null
  }
  const r = memory.saveMemory(account, op.text, { conversationId, projectId, via })
  return r.ok && !r.duplicate ? { op: 'add', memory: r.memory, scope: op.scope, ...(projectId ? { projectId } : {}) } : null
}
