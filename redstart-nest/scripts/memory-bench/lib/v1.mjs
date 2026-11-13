// =============================================================================
// Memory bench — the v1 reviewer, frozen (agent-runtime Phase 8.0, D33)
// =============================================================================
// A verbatim copy of daemon/memory-review.mjs's pure half as it stood before
// Phase 8 (feat/agent-core @ 10ea361): the input builder, the request, and the
// filter. 8.2 rewrites memory-review.mjs into v2; this copy stays so the
// baseline can be rerun against the same request on any later commit.
//
// Do not edit to "fix" anything. If v1 needs a change to run at all, say so
// in the commit message, because every v1 row is measured against this text.
// Delete it when Phase 8 closes.
// =============================================================================

import { normalizeText, MAX_MEMORY_CHARS } from '../../../daemon/memory-storage.mjs'

export const MAX_MESSAGE_CHARS = 2000
export const MAX_REVIEW_CHARS = 8000
export const MAX_OPS = 3
export const MAX_EXISTING_SHOWN = 60

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
          text: { type: 'string', maxLength: MAX_MEMORY_CHARS },
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
    enable_thinking: false,
    chat_template_kwargs: { enable_thinking: false },
  }
}

const SECRET_PATTERNS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /\b[A-Fa-f0-9]{32,}\b/,
  /\b[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/,
  /\b(?:password|passwd|passphrase|pin code|api[ _-]?key|secret|token)\b\s*(?:is|=|:)/i,
  /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,4}\b/,
]

export function looksSecret(text) {
  return SECRET_PATTERNS.some((re) => re.test(String(text ?? '')))
}

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
    const norm = normalizeText(raw.text)
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

/** The variant's whole surface, as the runner uses it. */
export const variant = {
  name: 'v1',
  turnsFor: (conversation) => userTurnsForReview(conversation, new Set()),
  buildReviewRequest,
  filterOps,
}
