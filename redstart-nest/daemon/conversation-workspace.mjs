'use strict'

// =============================================================================
// Redstart Nest — the conversation workspace
// =============================================================================
// "The files belonging to this chat", built once for Phase 1 (run_python) and
// reused by Phase 2 (rendered results) and 5a (private RAG). See
// docs/notes/chat-tooling-plan.md §2.
//
//   <documents root>/user_files/<scope>/chats/<conversationId>/
//   <documents root>/user_files/<scope>/chats/_scratch/      (no usable id)
//
// Inside the documents capability's per-account root ON PURPOSE: the file
// explorer, /files/upload and /files/download already serve that root, and
// read_document can open what Python wrote, with no new route and no second
// containment implementation. Both path steps go through resolveUserRoot →
// resolveWithinRoot, the one audited primitive.
//
// The id is a FOLDER NAME, so it is charset-checked before it is ever joined.
// Ownership (does this id belong to the caller?) is checked by the caller that
// has the account, mcp-server.mjs; this module never trusts an id it was not
// handed through that check, and a forged one still lands inside the caller's
// own scope.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import { resolveUserRoot, USER_FILES_DIR } from './user-scope.mjs'
import { resolveWithinRoot } from './path-scope.mjs'
import { moveToTrash } from './trash.mjs'

export const CHATS_DIR = 'chats'
export const SCRATCH_ID = '_scratch'

// Plan §2's numbers. They are guesses (open question 2); a capability setting
// can override both.
export const DEFAULT_WORKSPACE_CAP_BYTES = 200 * 1024 * 1024
export const DEFAULT_ACCOUNT_CAP_BYTES = 2 * 1024 * 1024 * 1024

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** A conversation id that is safe to use as one path segment. */
export function isWellFormedConversationId(id) {
  return typeof id === 'string' && ID_RE.test(id) && id !== SCRATCH_ID && !/^\.+$/.test(id)
}

/** The `chats/` folder of an account's documents scope. */
export function chatsRoot(documentsRoot, account, { create = false } = {}) {
  const userRoot = resolveUserRoot(documentsRoot, account, { create })
  // resolveWithinRoot realpaths its ROOT, which must exist. A user root that
  // does not exist yet holds no links to follow, so the lexical join is the
  // same answer (the user root itself was just containment-checked).
  if (!create && !fs.existsSync(userRoot)) return path.join(userRoot, CHATS_DIR)
  const dir = resolveWithinRoot(userRoot, CHATS_DIR)
  if (create) fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * The workspace for one conversation, or the account's scratch workspace when
 * `conversationId` is absent. The id must already have passed the ownership
 * check; a malformed one is refused here rather than mapped to scratch, since
 * a caller that sends one has a bug worth seeing.
 */
export function workspaceDir(documentsRoot, account, conversationId, { create = false } = {}) {
  const id = conversationId ?? SCRATCH_ID
  if (id !== SCRATCH_ID && !isWellFormedConversationId(id)) {
    throw new Error('Malformed conversation id')
  }
  const chats = chatsRoot(documentsRoot, account, { create })
  // Same reasoning as chatsRoot; the id is charset-checked above.
  if (!create && !fs.existsSync(chats)) return path.join(chats, id)
  const dir = resolveWithinRoot(chats, id)
  if (create) fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** The workspace path relative to the account's documents root, '/'-separated. */
export function workspaceRelative(conversationId) {
  return `${CHATS_DIR}/${conversationId ?? SCRATCH_ID}`
}

/**
 * Bytes under a directory. lstat, never stat, so a link inside a workspace is
 * counted as itself and never followed out of it.
 */
export function directoryBytes(dir) {
  let total = 0
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += directoryBytes(full)
    else {
      try { total += fs.lstatSync(full).size } catch { /* vanished mid-walk */ }
    }
  }
  return total
}

/**
 * Is there room to run? Checked before a run and again after it (plan §2 says
 * "on write"; WASM writes are synchronous NODEFS calls, so per-write
 * enforcement isn't done here — see the implementation record's Deviations).
 *
 * @returns {{ ok: true, workspaceBytes: number, accountBytes: number } |
 *           { ok: false, reason: string, workspaceBytes: number, accountBytes: number }}
 */
export function checkCaps(documentsRoot, account, conversationId, {
  workspaceCapBytes = DEFAULT_WORKSPACE_CAP_BYTES,
  accountCapBytes = DEFAULT_ACCOUNT_CAP_BYTES,
} = {}) {
  const workspaceBytes = directoryBytes(workspaceDir(documentsRoot, account, conversationId))
  const accountBytes = directoryBytes(chatsRoot(documentsRoot, account))
  const mb = (n) => `${(n / 1048576).toFixed(0)} MB`
  if (workspaceBytes > workspaceCapBytes) {
    return { ok: false, workspaceBytes, accountBytes, reason: `This conversation's workspace holds ${mb(workspaceBytes)}, over its ${mb(workspaceCapBytes)} limit. Delete files from it (the file explorer's Documents tab, folder ${workspaceRelative(conversationId)}) before running more code.` }
  }
  if (accountBytes > accountCapBytes) {
    return { ok: false, workspaceBytes, accountBytes, reason: `Your conversation workspaces hold ${mb(accountBytes)} in total, over the ${mb(accountCapBytes)} limit. Delete old chats or their files (Documents tab, folder ${CHATS_DIR}/) first.` }
  }
  return { ok: true, workspaceBytes, accountBytes }
}

/**
 * Move a conversation's workspace to the trash, if it has one. Never throws:
 * a conversation delete must not fail because its files could not be moved.
 */
export async function trashWorkspace(documentsRoot, account, conversationId) {
  if (!documentsRoot || !isWellFormedConversationId(conversationId)) return { ok: true, moved: false }
  let dir
  try { dir = workspaceDir(documentsRoot, account, conversationId) } catch { return { ok: true, moved: false } }
  if (!fs.existsSync(dir)) return { ok: true, moved: false }
  const userRoot = resolveUserRoot(documentsRoot, account)
  const result = await moveToTrash(userRoot, dir)
  return result.ok ? { ok: true, moved: true } : { ok: false, error: result.error }
}

/**
 * Trash every workspace whose conversation no longer exists, across every
 * account scope. Run at startup after the 30-day prune.
 *
 * It walks folders rather than mapping account ids to scope slugs, because
 * conversations.json stores only an accountId (or an auth-off device id) and
 * a scope slug is derived from the username too. "No conversation anywhere
 * has this id" is the whole test, so a workspace can only be swept when its
 * conversation is gone for every account.
 *
 * @param {string} documentsRoot
 * @param {Set<string>} liveConversationIds
 * @returns {Promise<string[]>} the workspace paths moved
 */
export async function sweepOrphanWorkspaces(documentsRoot, liveConversationIds) {
  const moved = []
  if (!documentsRoot) return moved
  const userFiles = path.join(path.resolve(documentsRoot), USER_FILES_DIR)
  let scopes
  try { scopes = fs.readdirSync(userFiles, { withFileTypes: true }) } catch { return moved }
  for (const scope of scopes) {
    if (!scope.isDirectory()) continue
    const scopeRoot = path.join(userFiles, scope.name)
    const chats = path.join(scopeRoot, CHATS_DIR)
    let workspaces
    try { workspaces = fs.readdirSync(chats, { withFileTypes: true }) } catch { continue }
    for (const ws of workspaces) {
      if (!ws.isDirectory() || ws.name === SCRATCH_ID) continue
      if (!isWellFormedConversationId(ws.name)) continue
      if (liveConversationIds.has(ws.name)) continue
      const result = await moveToTrash(scopeRoot, path.join(chats, ws.name))
      if (result.ok) moved.push(path.join(chats, ws.name))
    }
  }
  return moved
}

/**
 * Files in a workspace modified at or after `sinceMs`, relative and
 * '/'-separated, every one re-resolved inside the workspace (so a link that
 * points out is dropped, not reported). Used for "Files changed:".
 */
export function changedFiles(dir, sinceMs, { limit = 50 } = {}) {
  const out = []
  const walk = (current) => {
    let entries
    try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (out.length >= limit) return
      const full = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) { walk(full); continue }
      let st
      try { st = fs.lstatSync(full) } catch { continue }
      if (st.mtimeMs + 1 < sinceMs) continue
      const rel = path.relative(dir, full).split(path.sep).join('/')
      try { resolveWithinRoot(dir, rel) } catch { continue }
      out.push({ path: rel, bytes: st.size })
    }
  }
  walk(dir)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}
