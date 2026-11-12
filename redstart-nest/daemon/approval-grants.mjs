'use strict'

// =============================================================================
// Redstart Nest — standing grants: "always allow" on the server (agent-runtime
// plan Phase 2, D13)
// =============================================================================
// A standing grant lets an account's calls to one tool through without a card.
// Until Phase 2 that was chat-ui's localStorage set: per browser, invisible to
// every other client, and gone with the browser's data. Here it is per
// account, in one JSON file through json-store's atomic writes:
//
//   <config>/approvals.json
//   { accounts: { "<scope>": [ { id, tool, scope, createdAt, source } ] } }
//
// The key is memory-storage's: the account id, or '_local' with auth off,
// when every caller shares one set, as they share memories (security.md).
//
// A grant may name any tool but a destructive one. For a 'none' tool (a
// read) it only tells chat-ui not to show its card; Nest never asks about
// those. What Nest itself enforces: a grant only ever covers a tool whose
// approval rule is 'prompt'. An
// 'always' tool (destructive: delete_file, memory_forget) asks on every call,
// and addGrant refuses it, so neither a card's "always" nor the one-time
// import of an old localStorage set can make a delete unattended. covers()
// checks the rule again at read time, so a grant written before a tool was
// reclassified destructive stops counting the moment it is.
//
// `scope` is null: the grant covers every call to the tool. run_command
// (Phase 4) is the first tool whose grants are scoped (an executable and an
// argv prefix); the field exists so that change is not a migration.
// =============================================================================

import * as crypto from 'crypto'
import * as path from 'path'
import { configDir } from './platform-paths.mjs'
import { readJsonOr, writeJsonAtomic } from './json-store.mjs'
import { approvalRule } from './tools-definitions.mjs'

export const MAX_GRANTS_PER_ACCOUNT = 500
export const GRANT_SOURCES = ['card', 'import']

function file() { return path.join(configDir(), 'approvals.json') }
function read() {
  const data = readJsonOr(file(), { accounts: {} })
  if (!data.accounts || typeof data.accounts !== 'object' || Array.isArray(data.accounts)) data.accounts = {}
  return data
}
function write(data) { writeJsonAtomic(file(), data) }

const isToolName = (t) => typeof t === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(t)

/**
 * The account's grants, newest first.
 *
 * @param {string} accountKey memory-storage memoryKey(account)
 * @returns {Array<{ id: string, tool: string, scope: null, createdAt: number, source: string }>}
 */
export function listGrants(accountKey) {
  const list = read().accounts[accountKey]
  return Array.isArray(list) ? [...list].sort((a, b) => b.createdAt - a.createdAt) : []
}

/**
 * Grant a tool. Idempotent: a tool already granted returns its grant.
 *
 * @param {string} accountKey
 * @param {string} tool
 * @param {{ source?: 'card' | 'import' }} [opts]
 * @returns {{ ok: true, grant: object, created: boolean } | { ok: false, error: string }}
 */
export function addGrant(accountKey, tool, { source = 'card' } = {}) {
  if (!isToolName(tool)) return { ok: false, error: 'not a tool name' }
  const rule = approvalRule(tool)
  if (rule === 'always') return { ok: false, error: 'this tool asks on every call and cannot be always allowed' }
  // A 'none' tool (a read, a web fetch) is granted too. Nest never asks for
  // one, but chat-ui's card does, for every tool not always allowed, so the
  // grant is what stops the card. Until 2026-11-12 these were refused:
  // "Allow all tools from redstart-fetch" never stuck (the card kept asking),
  // and the one-time import dropped every read tool's old "Always allow".
  const data = read()
  const list = Array.isArray(data.accounts[accountKey]) ? data.accounts[accountKey] : []
  const existing = list.find((g) => g.tool === tool && g.scope === null)
  if (existing) return { ok: true, grant: existing, created: false }
  if (list.length >= MAX_GRANTS_PER_ACCOUNT) return { ok: false, error: 'too many standing grants' }
  const grant = {
    id: crypto.randomUUID(),
    tool,
    scope: null,
    createdAt: Date.now(),
    source: GRANT_SOURCES.includes(source) ? source : 'card',
  }
  data.accounts[accountKey] = [...list, grant]
  write(data)
  return { ok: true, grant, created: true }
}

/**
 * Remove one of the account's grants.
 *
 * @returns {object | null} the removed grant, or null (not this account's, or no such id)
 */
export function revokeGrant(accountKey, id) {
  const data = read()
  const list = Array.isArray(data.accounts[accountKey]) ? data.accounts[accountKey] : []
  const grant = list.find((g) => g.id === id)
  if (!grant) return null
  data.accounts[accountKey] = list.filter((g) => g.id !== id)
  write(data)
  return grant
}

/**
 * An admin removing anyone's grant, found by id alone.
 *
 * @returns {{ accountKey: string, grant: object } | null}
 */
export function revokeAnyGrant(id) {
  const data = read()
  for (const [accountKey, list] of Object.entries(data.accounts)) {
    if (!Array.isArray(list)) continue
    const grant = list.find((g) => g.id === id)
    if (!grant) continue
    data.accounts[accountKey] = list.filter((g) => g.id !== id)
    write(data)
    return { accountKey, grant }
  }
  return null
}

/** Does a standing grant let this account call the tool without a card? */
export function covers(accountKey, tool) {
  if (approvalRule(tool) !== 'prompt') return false
  return listGrants(accountKey).some((g) => g.tool === tool && g.scope === null)
}
