'use strict'

// =============================================================================
// Redstart Nest — skills on disk (master plan Phase 5)
// =============================================================================
// A skill is a folder, as the Agent Skills format has it:
//
//   <config>/skills/personal/<scope key>/<name>/SKILL.md   one account's own
//   <config>/skills/org/<name>/SKILL.md                    everyone's
//
// beside SKILL.md: up to MAX_SKILL_FILES more files (reference text, and .py
// scripts that run only through run_python, U-S2), and `.redstart.json` (the
// id, timestamps and authorship, which an export leaves out). The scope key
// and the org rule are workflows.json's: the account id, or '_local' with
// auth off (memory-storage.mjs memoryKey).
//
// workflows-storage.mjs keeps its API and stores through this module; the
// /workflows routes, the MCP prompts and chat-ui's Workflows page read the
// same records as before.
//
// MIGRATION. The first read moves every workflow in workflows.json into a
// skill folder, keeping its id and timestamps, and writes a marker so it runs
// once. workflows.json itself is left as it was: nothing deletes the user's
// data, and the old file is the backup.
//
// PATHS. A skill's own files are named by whoever made the skill (an import
// is a file from anywhere), so every relative path is checked here: no
// absolute path, no `..`, no backslash, no dot-file (the metadata file is
// ours), at most four folders deep. A path that fails is refused, never
// cleaned up into something else.
// =============================================================================

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { configDir } from './platform-paths.mjs'
import { readJsonOr, writeJsonAtomic } from './json-store.mjs'
import { memoryKey } from './memory-storage.mjs'
import { parseSkillMd, serializeSkillMd, validSkillName, workflowToSkill } from './skill-format.mjs'

export const MAX_SKILL_FILES = 20
export const MAX_SKILL_FILE_BYTES = 200 * 1024
export const MAX_SKILL_TOTAL_BYTES = 1024 * 1024

const META_FILE = '.redstart.json'
const MIGRATED_MARKER = '.migrated-from-workflows-json'

function root() { return path.join(configDir(), 'skills') }

/** The folder name for one account's personal skills. */
function scopeFolder(account) {
  const key = memoryKey(account)
  // Account ids are UUIDs and '_local'; anything else is hashed rather than
  // trusted as a folder name.
  return /^[A-Za-z0-9_-]{1,100}$/.test(key) ? key : `k-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 32)}`
}

function scopeDir(account, scope) {
  return scope === 'org' ? path.join(root(), 'org') : path.join(root(), 'personal', scopeFolder(account))
}

/**
 * Is `rel` a path a skill may hold a file at? Forward slashes only.
 *
 * @param {string} rel
 */
export function validSkillFilePath(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 200) return false
  if (rel.includes('\\') || rel.includes('\0') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return false
  const parts = rel.split('/')
  if (parts.length > 5) return false
  return parts.every((p) => p && p !== '.' && p !== '..' && !p.startsWith('.') && !/[<>:"|?*]/.test(p))
}

function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

/** Every file under a skill folder but SKILL.md and our own metadata, as relative paths. */
function listFiles(dir) {
  const out = []
  const walk = (d, prefix) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(d, e.name), rel)
      else if (e.isFile() && rel !== 'SKILL.md') out.push(rel)
    }
  }
  try { walk(dir, '') } catch { /* a folder that went away lists nothing */ }
  return out.sort()
}

/**
 * One skill folder as a record, or null when it is not a readable skill (a
 * SKILL.md that does not parse is skipped, not fatal: one bad folder must
 * not hide the rest).
 */
function readSkillDir(dir) {
  let text
  try { text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8') } catch { return null }
  const parsed = parseSkillMd(text)
  if (!parsed.ok) return null
  const meta = readJsonOr(path.join(dir, META_FILE), {})
  return {
    ...parsed.skill,
    id: typeof meta.id === 'string' ? meta.id : null,
    createdAt: Number.isFinite(meta.createdAt) ? meta.createdAt : 0,
    updatedAt: Number.isFinite(meta.updatedAt) ? meta.updatedAt : 0,
    createdBy: meta.createdBy ?? null,
    updatedBy: meta.updatedBy ?? null,
    files: listFiles(dir),
    dir,
  }
}

// ---------------------------------------------------------------------------
// Migration from workflows.json (runs once)
// ---------------------------------------------------------------------------

/** A workflow slug as a skill name: the format forbids "--", which a slug allowed. */
function skillNameFor(slug) {
  return slug.replace(/-{2,}/g, '-')
}

let migrated = false

function ensureMigrated() {
  if (migrated) return
  const marker = path.join(root(), MIGRATED_MARKER)
  if (fs.existsSync(marker)) { migrated = true; return }
  const data = readJsonOr(path.join(configDir(), 'workflows.json'), null)
  const put = (dir, w) => {
    const base = skillNameFor(w.name)
    let name = base
    for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${base}-${n}`
    if (!validSkillName(name)) return
    const target = path.join(dir, name)
    writeTextAtomic(path.join(target, 'SKILL.md'), serializeSkillMd(workflowToSkill({ ...w, name })))
    writeJsonAtomic(path.join(target, META_FILE), {
      id: w.id ?? crypto.randomUUID(),
      createdAt: w.createdAt ?? Date.now(),
      updatedAt: w.updatedAt ?? w.createdAt ?? Date.now(),
      createdBy: w.createdBy ?? null,
      updatedBy: w.updatedBy ?? null,
    })
  }
  if (data && typeof data === 'object') {
    for (const [key, list] of Object.entries(data.personal ?? {})) {
      if (!Array.isArray(list)) continue
      const folder = /^[A-Za-z0-9_-]{1,100}$/.test(key) ? key : `k-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 32)}`
      for (const w of list) if (w?.name && w?.instructions) put(path.join(root(), 'personal', folder), w)
    }
    for (const w of Array.isArray(data.org) ? data.org : []) if (w?.name && w?.instructions) put(path.join(root(), 'org'), w)
  }
  fs.mkdirSync(root(), { recursive: true })
  fs.writeFileSync(marker, `${new Date().toISOString()}\n`)
  migrated = true
}

/** Tests: forget that the migration ran in this process. */
export function _resetMigrationForTests() { migrated = false }

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** Every readable skill in one scope, newest-updated first. */
export function listSkills(account, scope) {
  ensureMigrated()
  const dir = scopeDir(account, scope)
  let names = []
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name) } catch { return [] }
  return names
    .map((n) => readSkillDir(path.join(dir, n)))
    .filter((s) => s && s.id)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** By id, within one scope the caller can reach. */
export function getSkillById(account, scope, id) {
  return listSkills(account, scope).find((s) => s.id === id) ?? null
}

/** By name, within one scope the caller can reach. */
export function getSkillByName(account, scope, name) {
  if (!validSkillName(name)) return null
  ensureMigrated()
  const s = readSkillDir(path.join(scopeDir(account, scope), name))
  return s && s.id ? s : null
}

/**
 * Check a set of extra files for a skill: paths, counts and sizes.
 *
 * @param {Record<string, Buffer | string>} files relative path → content
 * @returns {string | null} the error, or null
 */
export function checkSkillFiles(files) {
  const entries = Object.entries(files ?? {})
  if (entries.length > MAX_SKILL_FILES) return `a skill holds at most ${MAX_SKILL_FILES} files besides SKILL.md`
  let total = 0
  for (const [rel, content] of entries) {
    if (!validSkillFilePath(rel)) return `"${String(rel).slice(0, 80)}" is not a path a skill may hold (relative, forward slashes, no "..", no dot-files)`
    const size = Buffer.byteLength(content)
    if (size > MAX_SKILL_FILE_BYTES) return `${rel} is over ${MAX_SKILL_FILE_BYTES / 1024} KB`
    total += size
  }
  if (total > MAX_SKILL_TOTAL_BYTES) return `a skill's files are at most ${MAX_SKILL_TOTAL_BYTES / 1024 / 1024} MB together`
  return null
}

/**
 * Write a skill's SKILL.md (and, when given, replace its other files). With
 * `id`, the existing skill with that id is updated and renamed if its name
 * changed; without, a new one is made. Authorization is the caller's.
 *
 * @param {any} account
 * @param {'personal'|'org'} scope
 * @param {{ skill: { name: string, description: string, license?: string, metadata?: Record<string, string>, body: string }, files?: Record<string, Buffer | string> }} input
 * @param {{ id?: string, now?: number, by?: string | null, cap?: number }} [opts]
 * @returns {{ ok: true, skill: object } | { ok: false, error: string, code?: string }}
 */
export function writeSkill(account, scope, { skill, files }, { id, now = Date.now(), by = null, cap = Infinity } = {}) {
  if (!validSkillName(skill.name)) return { ok: false, error: 'not a valid skill name' }
  if (files) {
    const err = checkSkillFiles(files)
    if (err) return { ok: false, error: err }
  }
  const dir = scopeDir(account, scope)
  const existing = listSkills(account, scope)
  const current = id ? existing.find((s) => s.id === id) : null
  if (id && !current) return { ok: false, error: 'not found', code: 'not_found' }
  if (!id && existing.length >= cap) return { ok: false, error: `the ${scope} limit of ${cap} is reached; delete one first` }
  const target = path.join(dir, skill.name)
  // Taken by another skill, or by a folder that is not a readable skill: a
  // conflict either way, never an overwrite.
  if (target !== current?.dir && fs.existsSync(target)) {
    return { ok: false, error: `a ${scope} skill named "${skill.name}" already exists`, code: 'conflict' }
  }

  if (current && current.dir !== target) fs.renameSync(current.dir, target)
  if (files) {
    // Replace: everything but SKILL.md and the metadata goes, then the new set.
    for (const rel of current ? listFiles(target) : []) fs.rmSync(path.join(target, ...rel.split('/')), { force: true })
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(target, ...rel.split('/'))
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content)
    }
  }
  writeTextAtomic(path.join(target, 'SKILL.md'), serializeSkillMd(skill))
  const meta = current
    ? { id: current.id, createdAt: current.createdAt, updatedAt: now, createdBy: current.createdBy, updatedBy: by }
    : { id: crypto.randomUUID(), createdAt: now, updatedAt: now, createdBy: by, updatedBy: null }
  writeJsonAtomic(path.join(target, META_FILE), meta)
  return { ok: true, skill: readSkillDir(target) }
}

export function deleteSkill(account, scope, id) {
  const s = getSkillById(account, scope, id)
  if (!s) return false
  fs.rmSync(s.dir, { recursive: true, force: true })
  return true
}

/**
 * One of a skill's own files, or null. The path is checked against the
 * skill's folder after resolving, as well as by its shape.
 *
 * @returns {Buffer | null}
 */
export function readSkillFile(skill, rel) {
  if (!skill?.dir || !validSkillFilePath(rel)) return null
  const file = path.resolve(skill.dir, ...rel.split('/'))
  if (!file.startsWith(path.resolve(skill.dir) + path.sep)) return null
  try { return fs.readFileSync(file) } catch { return null }
}

/** Every file of a skill, SKILL.md included, for an export. */
export function skillExportFiles(skill) {
  /** @type {Record<string, Buffer>} */
  const out = { 'SKILL.md': Buffer.from(serializeSkillMd(skill)) }
  for (const rel of skill.files ?? []) {
    const b = readSkillFile(skill, rel)
    if (b) out[rel] = b
  }
  return out
}
