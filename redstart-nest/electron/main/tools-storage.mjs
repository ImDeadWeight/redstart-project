'use strict'

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

function getPath() {
  return path.join(app.getPath('userData'), 'tools.json')
}

function read() {
  const p = getPath()
  if (!fs.existsSync(p)) return { tools: [], groups: [] }
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return { tools: [], groups: [] } }
}

function write(data) {
  fs.writeFileSync(getPath(), JSON.stringify(data, null, 2), 'utf8')
}

export function getUserTools() { return read().tools }
export function getUserGroups() { return read().groups }

export function addUserTool(tool) {
  const data = read()
  data.tools = data.tools.filter(t => t.id !== tool.id)
  data.tools.push({ ...tool, builtIn: false })
  write(data)
  return true
}

export function deleteUserTool(id) {
  const data = read()
  data.tools = data.tools.filter(t => t.id !== id)
  write(data)
  return true
}

export function addUserGroup(group) {
  const data = read()
  data.groups = data.groups.filter(g => g.id !== group.id)
  data.groups.push({ ...group, builtIn: false })
  write(data)
  return true
}

export function deleteUserGroup(id) {
  const data = read()
  data.groups = data.groups.filter(g => g.id !== id)
  write(data)
  return true
}

// ---------------------------------------------------------------------------
// External MCP servers
// { id, name, url, enabled }
// ---------------------------------------------------------------------------

export function getExternalServers() { return read().externalServers || [] }

export function addExternalServer(server) {
  const data = read()
  if (!data.externalServers) data.externalServers = []
  data.externalServers = data.externalServers.filter(s => s.id !== server.id)
  data.externalServers.push(server)
  write(data)
  return true
}

export function deleteExternalServer(id) {
  const data = read()
  data.externalServers = (data.externalServers || []).filter(s => s.id !== id)
  write(data)
  return true
}

// ---------------------------------------------------------------------------
// Built-in capability providers (Postgres, Documents)
// Configured once globally here; per-profile activation lives in each
// profile's tools.activeToolIds, same as web sources.
// ---------------------------------------------------------------------------

// Registry of built-in capabilities and their global-config defaults.
// Adding a new capability provider (sqlite, vault, filesystem, ...) means
// adding ONE entry here (its defaults) plus its entry in
// tools-definitions.mjs BUILTIN_CAPABILITIES — getCapabilities/
// setCapabilityConfig below are registry-driven and need no edits.
//
// Convention: every capability has `enabled` (global on/off, distinct from
// per-profile activation) plus whatever config it needs. Directory-scoped
// capabilities name their root `rootDir` (Documents predates this and keeps
// `outputDir` for back-compat with existing tools.json files).
const DEFAULT_CAPABILITIES = {
  postgres:    { enabled: false, connectionStringEnc: null, maxRows: 200 },
  documents:   { enabled: false, outputDir: null },
  sqlite:      { enabled: false, rootDir: null, maxRows: 200, maxFileBytes: 200 * 1024 * 1024 },
  vault:       { enabled: false, rootDir: null },
  git:         { enabled: false, rootDir: null },
  // allowWrite / allowDestructive are the per-capability permission policy:
  // writes are on by design (File System is the read/write capability), but
  // destructive ops (fs_delete_file) are off by default — the model can't delete
  // local files until an admin explicitly opts in. Enforced server-side at the
  // MCP tools/call chokepoint (see mcp-server.mjs + tools-definitions classify).
  file_system: { enabled: false, rootDir: null, allowWrite: true, allowDestructive: false },
  scholar:     { enabled: false, venueFilter: null },
}

export function getCapabilities() {
  const data = read()
  const out = {}
  for (const [name, defaults] of Object.entries(DEFAULT_CAPABILITIES)) {
    out[name] = { ...defaults, ...(data.capabilities?.[name] || {}) }
  }
  return out
}

// Maps each folder-scoped capability to the subfolder it gets under the
// Redstart base directory (created at startup). Postgres has no folder.
const DEFAULT_FOLDER_NAMES = {
  documents:   { field: 'outputDir', folder: 'Documents' },
  sqlite:      { field: 'rootDir',   folder: 'Databases' },
  vault:       { field: 'rootDir',   folder: 'Notes' },
  git:         { field: 'rootDir',   folder: 'Repos' },
  file_system: { field: 'rootDir',   folder: 'Workspace' },
}

// Pre-provisions default folders for folder-scoped capabilities so enabling
// one is a single click instead of configure-then-enable. Called at startup
// with e.g. <user Documents>\Redstart as the base. Idempotent, and never
// touches a capability whose path the user has already set — only fills
// null/missing paths. Capabilities stay DISABLED; this sets paths only, so
// the two-key activation model (enable globally + activate per profile) is
// unchanged.
export function ensureDefaultCapabilityFolders(baseDir) {
  const capabilities = getCapabilities()
  const applied = {}
  for (const [name, { field, folder }] of Object.entries(DEFAULT_FOLDER_NAMES)) {
    if (capabilities[name][field]) continue // user already chose a path — leave it
    const dir = path.join(baseDir, folder)
    try {
      fs.mkdirSync(dir, { recursive: true })
      setCapabilityConfig(name, { [field]: dir })
      applied[name] = dir
    } catch (err) {
      // Non-fatal: the capability just stays "Not configured" as before.
      console.warn(`Could not provision default folder for ${name}:`, err.message)
    }
  }
  return applied
}

export function setCapabilityConfig(name, patch) {
  if (!DEFAULT_CAPABILITIES[name]) throw new Error(`Unknown capability: ${name}`)
  const data = read()
  if (!data.capabilities) data.capabilities = {}
  data.capabilities[name] = { ...DEFAULT_CAPABILITIES[name], ...(data.capabilities[name] || {}), ...patch }
  write(data)
  return data.capabilities[name]
}
