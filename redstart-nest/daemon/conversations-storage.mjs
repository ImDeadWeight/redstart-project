'use strict'

import * as path from 'path'
import { configDir } from './platform-paths.mjs'
import { readJsonOr, writeJsonAtomic } from './json-store.mjs'

const CLEANUP_DAYS = 30

// A function, not a module-level const: configDir() needs initPaths() to have
// run first, and this module is imported (evaluating module-level code)
// before app.whenReady() ever gets a chance to call it.
function getPath() {
  return path.join(configDir(), 'conversations.json')
}

function read() {
  return readJsonOr(getPath(), { conversations: [] })
}

function write(data) {
  writeJsonAtomic(getPath(), data)
}

// A chat in a project is exempt (projects-plan D12): putting it there is the
// user saying "keep this", and a project that silently empties after a month
// reads as data loss. Moving it out of the project makes it eligible again.
export function cleanupOldConversations() {
  const data = read()
  const cutoff = Date.now() - CLEANUP_DAYS * 24 * 60 * 60 * 1000
  const before = data.conversations.length
  data.conversations = data.conversations.filter(c => c.lastModified >= cutoff || !!c.projectId)
  const removed = before - data.conversations.length
  if (removed > 0) write(data)
  return removed
}

/** Every conversation id, across all accounts — for the workspace orphan sweep only. */
export function allConversationIds() {
  return new Set(read().conversations.map(c => c.id))
}

export function getConversations(accountId) {
  const data = read()
  return data.conversations
    .filter(c => c.accountId === accountId)
    .sort((a, b) => b.lastModified - a.lastModified)
}

export function getConversation(accountId, convId) {
  const c = read().conversations.find(c => c.id === convId && c.accountId === accountId)
  return c || null
}

/**
 * By id alone, for the auth-off case only (projects-storage
 * projectForConversation), where every caller shares one scope and the MCP
 * connection carries no device id. Never call this with auth on.
 */
export function getConversationAnyAccount(convId) {
  return read().conversations.find(c => c.id === convId) || null
}

export function createConversation(accountId, conv) {
  const data = read()
  const record = {
    ...conv,
    accountId,
    lastModified: Date.now()
  }
  data.conversations.push(record)
  write(data)
  return record
}

// Fields a client body may never set: the record's identity and owner. Before
// this list existed, a PUT carrying `accountId` moved the record into another
// account's list (found while planning projects, plan D11). `projectId: null`
// means "move out of its project" and removes the field.
// `activeTaskId` is the daemon's (setActiveTask): a client cannot claim a
// conversation for a task, nor free one a task holds.
const PROTECTED_FIELDS = ['id', 'accountId', 'activeTaskId']

// While a task holds a conversation (agent-runtime D25) the daemon is its only
// writer of these. chat-ui PUTs a conversation's WHOLE message array on every
// add, edit and delete, so a client holding the array from before the task's
// last turn would overwrite what the task appended. Title, project, pinned,
// plan and the rest are still accepted.
export const TASK_OWNED_FIELDS = Object.freeze(['messages', 'currNode'])

/** updateConversation's answer when a task holds the conversation and the update touches TASK_OWNED_FIELDS. */
export const LOCKED_BY_TASK = Symbol('locked by task')

export function updateConversation(accountId, convId, updates) {
  const data = read()
  const idx = data.conversations.findIndex(c => c.id === convId && c.accountId === accountId)
  if (idx === -1) return null
  if (data.conversations[idx].activeTaskId && TASK_OWNED_FIELDS.some((k) => k in (updates ?? {}))) return LOCKED_BY_TASK
  const safe = { ...updates }
  for (const k of PROTECTED_FIELDS) delete safe[k]
  const next = { ...data.conversations[idx], ...safe, lastModified: Date.now() }
  if (next.projectId === null) delete next.projectId
  // `plan: null` clears the update_plan checklist (conversation-routes.mjs).
  if (next.plan === null) delete next.plan
  data.conversations[idx] = next
  write(data)
  return next
}

// ---------------------------------------------------------------------------
// The daemon's own writes (agent-runtime Phase 3, D25): the task runner adds
// messages one at a time instead of PUTting an array, so it never overwrites
// what someone else wrote, and a client never overwrites it (TASK_OWNED_FIELDS).
// ---------------------------------------------------------------------------

/**
 * Claim the conversation for a task, or free it (null). Only the daemon calls
 * this; a client cannot set the field (PROTECTED_FIELDS).
 *
 * @returns {boolean} false: no such conversation
 */
export function setActiveTask(accountId, convId, taskId) {
  const data = read()
  const c = data.conversations.find(c => c.id === convId && c.accountId === accountId)
  if (!c) return false
  if (taskId) c.activeTaskId = taskId
  else delete c.activeTaskId
  write(data)
  return true
}

/**
 * Add one message under its parent and make it the current node. The parent
 * must exist (or be null for a root); `children` is set here, never taken
 * from the caller.
 *
 * @param {string} accountId the conversations scope
 * @param {string} convId
 * @param {{ id: string, parent: string | null } & Record<string, unknown>} message
 * @returns {object | null} the stored message; null: no such conversation or parent
 */
export function appendMessage(accountId, convId, message) {
  const data = read()
  const c = data.conversations.find(c => c.id === convId && c.accountId === accountId)
  if (!c || typeof message?.id !== 'string' || !message.id) return null
  if (!Array.isArray(c.messages)) c.messages = []
  if (c.messages.some((m) => m.id === message.id)) return null
  let parent = null
  if (message.parent !== null) {
    parent = c.messages.find((m) => m.id === message.parent)
    if (!parent) return null
  }
  const stored = { ...message, convId, children: [] }
  if (parent) parent.children = [...(parent.children ?? []), stored.id]
  c.messages.push(stored)
  c.currNode = stored.id
  c.lastModified = Date.now()
  write(data)
  return stored
}

/**
 * Change fields of one message. `id`, `parent`, `children` and `convId` are
 * the tree's and stay as they are.
 *
 * @returns {object | null} the message after; null: no such conversation or message
 */
export function patchMessage(accountId, convId, messageId, patch) {
  const data = read()
  const c = data.conversations.find(c => c.id === convId && c.accountId === accountId)
  const m = c?.messages?.find((m) => m.id === messageId)
  if (!m) return null
  const safe = { ...patch }
  for (const k of ['id', 'parent', 'children', 'convId']) delete safe[k]
  Object.assign(m, safe)
  c.lastModified = Date.now()
  write(data)
  return m
}

/**
 * A deleted project's chats move out to the ordinary list (projects-plan,
 * user decision): the reference is cleared, the chat is kept. Across every
 * record, not just the caller's: with auth off, chats are keyed by device id
 * while the project belongs to the shared scope, and a project id is a UUID,
 * so a match can only be a chat that pointed at THIS project. lastModified is
 * left alone, so moving out does not reorder anyone's list.
 *
 * @returns {number} how many chats moved out
 */
export function detachProject(projectId) {
  const data = read()
  let moved = 0
  for (const c of data.conversations) {
    if (c.projectId === projectId) {
      delete c.projectId
      moved++
    }
  }
  if (moved > 0) write(data)
  return moved
}

export function deleteConversation(accountId, convId) {
  const data = read()
  const idx = data.conversations.findIndex(c => c.id === convId && c.accountId === accountId)
  if (idx === -1) return false
  const [deleted] = data.conversations.splice(idx, 1)
  // Its forks survive the delete, so they move up to its parent (or become
  // top-level), as the chat-ui sidebar already shows them. Left alone they
  // would point at a conversation that no longer exists once the list is
  // reloaded. Only the caller's own forks: another account's copy is not this
  // caller's to rewrite.
  const newParent = deleted.forkedFromConversationId ?? null
  for (const c of data.conversations) {
    if (c.accountId === accountId && c.forkedFromConversationId === convId) {
      c.forkedFromConversationId = newParent
    }
  }
  write(data)
  return true
}

export function deleteConversationsWithForks(accountId, convId) {
  const data = read()
  const idsToDelete = new Set([convId])
  const queue = [convId]
  while (queue.length > 0) {
    const parentId = queue.pop()
    for (const c of data.conversations) {
      if (c.forkedFromConversationId === parentId && !idsToDelete.has(c.id)) {
        idsToDelete.add(c.id)
        queue.push(c.id)
      }
    }
  }
  data.conversations = data.conversations.filter(c => !idsToDelete.has(c.id) || c.accountId !== accountId)
  write(data)
  return idsToDelete.size
}
