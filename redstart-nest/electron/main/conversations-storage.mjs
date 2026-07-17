'use strict'

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

const STORAGE_PATH = path.join(app.getPath('userData'), 'conversations.json')
const CLEANUP_DAYS = 30

function getPath() {
  return STORAGE_PATH
}

function read() {
  if (!fs.existsSync(STORAGE_PATH)) return { conversations: [] }
  try { return JSON.parse(fs.readFileSync(STORAGE_PATH, 'utf8')) } catch { return { conversations: [] } }
}

function write(data) {
  fs.writeFileSync(STORAGE_PATH, JSON.stringify(data, null, 2), 'utf8')
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
