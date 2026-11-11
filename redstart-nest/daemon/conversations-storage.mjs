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
const PROTECTED_FIELDS = ['id', 'accountId']

export function updateConversation(accountId, convId, updates) {
  const data = read()
  const idx = data.conversations.findIndex(c => c.id === convId && c.accountId === accountId)
  if (idx === -1) return null
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
  data.conversations.splice(idx, 1)
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
