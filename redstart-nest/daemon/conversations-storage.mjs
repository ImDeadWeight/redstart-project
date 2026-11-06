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

export function cleanupOldConversations() {
  const data = read()
  const cutoff = Date.now() - CLEANUP_DAYS * 24 * 60 * 60 * 1000
  const before = data.conversations.length
  data.conversations = data.conversations.filter(c => c.lastModified >= cutoff)
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

export function updateConversation(accountId, convId, updates) {
  const data = read()
  const idx = data.conversations.findIndex(c => c.id === convId && c.accountId === accountId)
  if (idx === -1) return null
  data.conversations[idx] = { ...data.conversations[idx], ...updates, lastModified: Date.now() }
  write(data)
  return data.conversations[idx]
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
