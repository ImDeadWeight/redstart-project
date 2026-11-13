// =============================================================================
// Memory bench — case files (agent-runtime Phase 8.0)
// =============================================================================
// One JSON file per case in scripts/memory-bench/cases/:
//
//   {
//     "id": "corr-run-from-e",          unique, matches the file name
//     "group": "corrections",           one of GROUPS
//     "about": "why this case exists",  for the reader; not used
//     "project": { "name": "..." },     optional: the chat is in a project
//     "existing": {                     optional: memories already saved
//       "user":    [{ "id": "u1", "text": "...", "kind"?, "ageDays"? }],
//       "project": [{ "id": "p1", "text": "...", "kind"?, "ageDays"? }]
//     },
//     "messages": [                     the branch, oldest first
//       { "role": "user" | "assistant", "content": "..." ,
//         "tool_calls"?: [{ "id", "name", "arguments" }] },
//       { "role": "tool", "tool_call_id": "...", "name": "...",
//         "content": "...", "is_error"?: true }
//     ],
//     "expect": [                       every one must be met
//       { "op": "add" | "update" | "forget", "kind"?, "scope"?, "target"?,
//         "terms": [["alt", "alt"], ["alt"]] }
//     ],
//     "forbid": [{ "terms": [[...]] }], optional: no op may match
//     "strict": true,                   optional: any op at all fails
//     "answers": {                      for the harness test only
//       "right": [op, ...],             ops that should pass
//       "wrong": [op, ...]              plausible ops that should fail
//     }
//   }
//
// A term group matches when any of its alternatives occurs, case-insensitive,
// in the op's text or why. An expectation is met by one op with the same `op`
// (and `target`, `scope`, `kind` where given and the op carries them) whose
// text meets every group.
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'

export const GROUPS = ['facts', 'corrections', 'confirmations', 'state', 'retractions', 'injection', 'secrets', 'nothing']
const OPS = ['add', 'update', 'forget']
const KINDS = ['fact', 'guidance', 'state']
const DAY_MS = 24 * 60 * 60 * 1000
/** The fixed "now" every case is built at, so a memory's age is reproducible. */
export const CASE_NOW = Date.UTC(2026, 10, 12, 12, 0, 0)

function fail(file, message) {
  throw new Error(`${path.basename(file)}: ${message}`)
}

function checkTerms(file, where, terms) {
  if (!Array.isArray(terms) || terms.length === 0) fail(file, `${where}.terms must be a non-empty list of term groups`)
  for (const g of terms) {
    if (!Array.isArray(g) || g.length === 0 || g.some((t) => typeof t !== 'string' || !t.trim())) {
      fail(file, `${where}.terms: each group is a non-empty list of strings`)
    }
  }
}

/** @param {string} file */
export function loadCase(file) {
  let c
  try {
    c = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    fail(file, `not JSON: ${err.message}`)
  }
  if (typeof c.id !== 'string' || !c.id) fail(file, 'id is required')
  if (path.basename(file, '.json') !== c.id) fail(file, `id "${c.id}" does not match the file name`)
  if (!GROUPS.includes(c.group)) fail(file, `group must be one of ${GROUPS.join(', ')}`)
  if (!Array.isArray(c.messages) || !c.messages.some((m) => m.role === 'user')) fail(file, 'messages needs at least one user message')
  for (const [i, m] of c.messages.entries()) {
    if (!['user', 'assistant', 'tool'].includes(m.role)) fail(file, `messages[${i}].role must be user, assistant or tool`)
    if (typeof m.content !== 'string') fail(file, `messages[${i}].content must be a string`)
    if (m.role === 'tool' && typeof m.tool_call_id !== 'string') fail(file, `messages[${i}] (tool) needs tool_call_id`)
  }
  const expect = c.expect ?? []
  if (!Array.isArray(expect)) fail(file, 'expect must be a list')
  for (const [i, e] of expect.entries()) {
    if (!OPS.includes(e.op)) fail(file, `expect[${i}].op must be one of ${OPS.join(', ')}`)
    if (e.kind !== undefined && !KINDS.includes(e.kind)) fail(file, `expect[${i}].kind must be one of ${KINDS.join(', ')}`)
    if (e.scope !== undefined && !['user', 'project'].includes(e.scope)) fail(file, `expect[${i}].scope must be user or project`)
    if (e.op !== 'add' && typeof e.target !== 'string') fail(file, `expect[${i}]: an ${e.op} needs target (an existing memory id)`)
    if (e.op === 'forget') { if (e.terms !== undefined) checkTerms(file, `expect[${i}]`, e.terms) } else checkTerms(file, `expect[${i}]`, e.terms)
  }
  for (const [i, f] of (c.forbid ?? []).entries()) checkTerms(file, `forbid[${i}]`, f.terms)
  if (c.strict && expect.length) fail(file, 'a strict case expects nothing')
  if (!c.strict && expect.length === 0 && !(c.forbid ?? []).length) fail(file, 'a case with no expectation needs strict or a forbid')
  const ids = new Set([...(c.existing?.user ?? []), ...(c.existing?.project ?? [])].map((m) => m.id))
  for (const e of expect) if (e.target && !ids.has(e.target)) fail(file, `target "${e.target}" is not an existing memory`)
  if (!c.answers || !Array.isArray(c.answers.right) || !Array.isArray(c.answers.wrong)) fail(file, 'answers.right and answers.wrong are required (the harness test scores them)')
  return { ...c, expect, forbid: c.forbid ?? [], file }
}

export function findCaseFiles(dirOrGlob) {
  const dir = fs.statSync(dirOrGlob, { throwIfNoEntry: false })?.isDirectory() ? dirOrGlob : path.dirname(dirOrGlob)
  const pattern = dir === dirOrGlob ? null : new RegExp(`^${path.basename(dirOrGlob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && (!pattern || pattern.test(f))).sort().map((f) => path.join(dir, f))
}

/** A memory record as memory-storage keeps it, from a case's short form. */
function memoryRecord(m) {
  const at = CASE_NOW - (m.ageDays ?? 30) * DAY_MS
  return { id: m.id, text: m.text, createdAt: at, updatedAt: at, source: { conversationId: null }, fromWebTurn: false, ...(m.kind ? { kind: m.kind } : {}), ...(m.why ? { why: m.why } : {}), ...(m.kind === 'state' ? { asOf: new Date(at).toISOString().slice(0, 10) } : {}) }
}

/**
 * The stored conversation the reviewer reads: the case's messages as one
 * branch (chat-ui's DatabaseMessage shape: id, parent, role, content,
 * toolCalls as a JSON string, toolCallId), plus the memories and project.
 */
export function caseWorld(c) {
  const messages = [{ id: 'root', parent: null, type: 'root', role: 'system', content: '', timestamp: CASE_NOW - 3600_000 }]
  let parent = 'root'
  c.messages.forEach((m, i) => {
    const id = `m${i + 1}`
    messages.push({
      id, parent, type: 'text', role: m.role, content: m.content, timestamp: CASE_NOW - 3600_000 + (i + 1) * 1000,
      toolCalls: m.tool_calls ? JSON.stringify(m.tool_calls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments ?? '{}' } }))) : '',
      ...(m.role === 'tool' ? { toolCallId: m.tool_call_id, isError: !!m.is_error } : {}),
    })
    parent = id
  })
  const project = c.project ? { id: 'proj-bench', name: c.project.name } : null
  return {
    conversation: { id: `bench-${c.id}`, currNode: parent, messages, ...(project ? { projectId: project.id } : {}) },
    project,
    userMemories: (c.existing?.user ?? []).map(memoryRecord),
    projectMemories: (c.existing?.project ?? []).map(memoryRecord),
  }
}
