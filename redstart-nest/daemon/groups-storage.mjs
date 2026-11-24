'use strict'

// =============================================================================
// Redstart Nest — Groups
// =============================================================================
// A group is a named set of accounts that hold the same roles, the way a team
// does in Grafana or a group in Open WebUI: put "Legal" in the Legal role once
// instead of on each person. An account's roles are its own plus every role of
// every group it is in (auth.mjs rolesFor). Groups are flat: no group inside a
// group, so "why can this person do that?" always has a one-step answer.
//
// Groups are also what a project can be shared with (projects-storage.mjs), so
// adding someone to a group can give them projects as well as roles.
//
// <configDir>/groups.json: { groups: [{ id, name, description, memberIds,
// roleIds, createdAt, updatedAt }] }. Small, changed only by an admin, read on
// every permission decision, so cached and invalidated by the only writer.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import { configDir } from './platform-paths.mjs'
import { readJsonOr, writeJsonAtomic } from './json-store.mjs'

const MAX_GROUPS = 200

function getPath() {
  return path.join(configDir(), 'groups.json')
}

// Cached per path and file mtime: a hand edit, a restore from backup, or a
// test clearing the folder is picked up on the next read.
let cached = null
let cachedKey = null

function fileKey() {
  const p = getPath()
  try { return `${p}@${fs.statSync(p).mtimeMs}` } catch { return `${p}@none` }
}

function read() {
  const key = fileKey()
  if (!cached || cachedKey !== key) {
    const data = readJsonOr(getPath(), { groups: [] })
    if (!Array.isArray(data.groups)) data.groups = []
    cached = data
    cachedKey = key
  }
  return cached
}

function write(data) {
  writeJsonAtomic(getPath(), data)
  cached = data
  cachedKey = fileKey()
}

const ids = (v) => [...new Set(Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : [])]

export function listGroups() {
  return read().groups.map(g => ({ ...g, memberIds: ids(g.memberIds), roleIds: ids(g.roleIds) }))
}

export function findGroupById(id) {
  return listGroups().find(g => g.id === id) || null
}

/** The groups an account belongs to. */
export function groupsForAccount(accountId) {
  if (!accountId) return []
  return listGroups().filter(g => g.memberIds.includes(accountId))
}

/**
 * Create or replace a group. Validation of WHO may do this, and of the roles it
 * carries, is the caller's (auth.mjs saveGroup); this checks shape only.
 */
export function upsertGroup(group) {
  const data = read()
  const name = typeof group.name === 'string' ? group.name.trim().slice(0, 64) : ''
  if (!name) return { ok: false, error: 'Group name required' }
  const clash = data.groups.find(g => g.id !== group.id && g.name.toLowerCase() === name.toLowerCase())
  if (clash) return { ok: false, error: 'A group with that name already exists' }
  const idx = data.groups.findIndex(g => g.id === group.id)
  if (idx === -1 && data.groups.length >= MAX_GROUPS) return { ok: false, error: `At most ${MAX_GROUPS} groups` }
  const now = new Date().toISOString()
  const record = {
    id: group.id,
    name,
    description: typeof group.description === 'string' ? group.description.trim().slice(0, 280) : '',
    memberIds: ids(group.memberIds),
    roleIds: ids(group.roleIds),
    createdAt: idx === -1 ? now : data.groups[idx].createdAt,
    updatedAt: now,
  }
  if (idx === -1) data.groups.push(record)
  else data.groups[idx] = record
  write(data)
  return { ok: true, group: record }
}

export function deleteGroup(id) {
  const data = read()
  const before = data.groups.length
  data.groups = data.groups.filter(g => g.id !== id)
  if (data.groups.length === before) return { ok: false, error: 'Group not found' }
  write(data)
  return { ok: true }
}

/** Drop an account from every group (the account was deleted). */
export function removeMemberEverywhere(accountId) {
  const data = read()
  let changed = 0
  for (const g of data.groups) {
    const next = ids(g.memberIds).filter(id => id !== accountId)
    if (next.length !== ids(g.memberIds).length) { g.memberIds = next; changed++ }
  }
  if (changed) write(data)
  return changed
}

/** Drop a role from every group (the role was deleted). */
export function removeRoleEverywhere(roleId) {
  const data = read()
  let changed = 0
  for (const g of data.groups) {
    const next = ids(g.roleIds).filter(id => id !== roleId)
    if (next.length !== ids(g.roleIds).length) { g.roleIds = next; changed++ }
  }
  if (changed) write(data)
  return changed
}
