'use strict'

// =============================================================================
// Redstart Nest — the SKILL.md format (master plan Phase 5)
// =============================================================================
// A skill is a folder whose SKILL.md is YAML front matter and a Markdown body,
// as the Agent Skills format has it:
//
//   ---
//   name: weekly-report
//   description: "Turns shorthand notes into the weekly report format."
//   metadata:
//     redstart-title: "Weekly report"
//     redstart-inputs: "[{\"name\":\"notes\",\"description\":\"\",\"required\":true}]"
//     redstart-example: "{\"input\":\"…\",\"output\":\"…\"}"
//   ---
//   The instructions, with {{notes}} placeholders.
//
// `name` and `description` are the format's; the model sees only these until
// it loads the skill. Redstart's own fields ride in `metadata`, whose values
// the format keeps as strings, so they are JSON text there.
//
// NO YAML LIBRARY. This reads the subset SKILL.md files use and nothing more:
// top-level `key: value` with plain, 'single' or "double" quoted scalars, `|`
// and `>` block scalars, one level of indented `key: value` under a mapping
// key (metadata), and indented `- item` lists (read, then dropped: Redstart
// has no use for allowed-tools). Anchors, flow collections, multi-document
// files and anything else are refused with the line they are on, rather than
// guessed at. Serialization writes every string double-quoted with JSON's
// escapes, which YAML reads as the same string.
//
// Pure: no I/O. skills-storage.mjs does the disk.
// =============================================================================

export const MAX_SKILL_NAME_CHARS = 64
export const MAX_SKILL_DESCRIPTION_CHARS = 1024
export const MAX_SKILL_BODY_CHARS = 20000

// The Agent Skills name rule: lowercase letters, digits and single inner
// hyphens. Workflow slugs (workflows-storage.mjs SLUG) are a subset of it.
const SKILL_NAME = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9]))*$/

const TOP_KEYS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'])

/** @param {string} name */
export function validSkillName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= MAX_SKILL_NAME_CHARS && SKILL_NAME.test(name)
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function unquoteDouble(s, lineNo) {
  try {
    // JSON's string grammar is YAML's double-quoted scalar minus a few
    // escapes SKILL.md files do not use (\x, \e, line folding).
    return JSON.parse(s)
  } catch {
    throw new Error(`line ${lineNo}: a double-quoted value this reader cannot parse`)
  }
}

function scalar(raw, lineNo) {
  const v = raw.trim()
  if (v === '') return ''
  if (v.startsWith('"')) {
    if (!v.endsWith('"') || v.length < 2) throw new Error(`line ${lineNo}: an unclosed double quote`)
    return unquoteDouble(v, lineNo)
  }
  if (v.startsWith("'")) {
    if (!v.endsWith("'") || v.length < 2) throw new Error(`line ${lineNo}: an unclosed single quote`)
    return v.slice(1, -1).replace(/''/g, "'")
  }
  if (/^[&*!{[]/.test(v)) throw new Error(`line ${lineNo}: anchors, tags and flow collections are not read here`)
  // A plain scalar ends at " #" (a comment).
  const hash = v.search(/\s#/)
  return (hash >= 0 ? v.slice(0, hash) : v).trim()
}

function blockScalar(lines, start, style, lineNo) {
  const out = []
  let i = start
  let indent = null
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') { out.push(''); continue }
    const lead = line.length - line.trimStart().length
    if (indent === null) indent = lead
    if (lead < indent || lead === 0) break
    out.push(line.slice(indent))
  }
  if (indent === null) throw new Error(`line ${lineNo}: a block scalar with no text`)
  while (out.length && out[out.length - 1] === '') out.pop()
  const text = style === '|'
    ? out.join('\n')
    : out.reduce((acc, l) => (l === '' ? `${acc}\n` : acc === '' || acc.endsWith('\n') ? acc + l : `${acc} ${l}`), '')
  return { text, next: i }
}

/**
 * The front matter, as a plain object. Throws with a line number on anything
 * outside the subset.
 *
 * @param {string} yaml
 * @returns {Record<string, any>}
 */
export function parseFrontMatter(yaml) {
  const lines = yaml.split('\n')
  /** @type {Record<string, any>} */
  const out = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const lineNo = i + 2 // the opening --- is line 1
    if (line.trim() === '' || line.trimStart().startsWith('#')) { i++; continue }
    if (/^\s/.test(line)) throw new Error(`line ${lineNo}: an indented line with no key above it`)
    const m = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/.exec(line)
    if (!m) throw new Error(`line ${lineNo}: expected "key: value"`)
    const [, key, rest] = m
    if (Object.prototype.hasOwnProperty.call(out, key)) throw new Error(`line ${lineNo}: "${key}" is given twice`)
    const v = rest.trim()
    if (v === '|' || v === '>' || v === '|-' || v === '>-') {
      const b = blockScalar(lines, i + 1, v[0], lineNo)
      out[key] = b.text
      i = b.next
      continue
    }
    if (v !== '') {
      out[key] = scalar(v, lineNo)
      i++
      continue
    }
    // An empty value: a nested mapping, a list, or nothing.
    i++
    const map = {}
    const list = []
    while (i < lines.length && (lines[i].trim() === '' || /^\s/.test(lines[i]))) {
      const inner = lines[i]
      const innerNo = i + 2
      i++
      if (inner.trim() === '' || inner.trimStart().startsWith('#')) continue
      const t = inner.trim()
      if (t.startsWith('- ') || t === '-') {
        list.push(scalar(t.slice(1), innerNo))
        continue
      }
      const mm = /^([A-Za-z0-9_.-]+):(.*)$/.exec(t)
      if (!mm) throw new Error(`line ${innerNo}: expected "key: value" under "${key}"`)
      if (mm[2].trim() === '' || /^[|>]/.test(mm[2].trim())) throw new Error(`line ${innerNo}: only one level of nesting is read, with a value on the line`)
      map[mm[1]] = scalar(mm[2], innerNo)
    }
    if (list.length && Object.keys(map).length) throw new Error(`"${key}" mixes a list and a mapping`)
    out[key] = list.length ? list : Object.keys(map).length ? map : ''
  }
  return out
}

/**
 * Parse a SKILL.md file.
 *
 * @param {string} text
 * @returns {{ ok: true, skill: { name: string, description: string, license: string, metadata: Record<string, string>, body: string } } | { ok: false, error: string }}
 */
export function parseSkillMd(text) {
  if (typeof text !== 'string') return { ok: false, error: 'SKILL.md must be text' }
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  if (!src.startsWith('---\n')) return { ok: false, error: 'SKILL.md must start with "---" and its front matter' }
  const end = src.indexOf('\n---', 3)
  if (end < 0) return { ok: false, error: 'the front matter is never closed with "---"' }
  const closeLineEnd = src.indexOf('\n', end + 4)
  const afterClose = closeLineEnd < 0 ? src.length : closeLineEnd
  if (src.slice(end + 4, afterClose).trim() !== '') return { ok: false, error: 'the closing "---" must be on a line of its own' }

  let fm
  try {
    fm = parseFrontMatter(src.slice(4, end))
  } catch (err) {
    return { ok: false, error: `front matter: ${err.message}` }
  }
  const unknown = Object.keys(fm).filter((k) => !TOP_KEYS.has(k))
  if (unknown.length) return { ok: false, error: `front matter: unknown field(s) ${unknown.join(', ')}` }

  const name = typeof fm.name === 'string' ? fm.name.trim() : ''
  if (!validSkillName(name)) {
    return { ok: false, error: `name must be lowercase letters, digits and inner hyphens, at most ${MAX_SKILL_NAME_CHARS} characters` }
  }
  const description = typeof fm.description === 'string' ? fm.description.trim() : ''
  if (!description) return { ok: false, error: 'description is required: it is what the model reads to decide when to use the skill' }
  if (description.length > MAX_SKILL_DESCRIPTION_CHARS) {
    return { ok: false, error: `description is at most ${MAX_SKILL_DESCRIPTION_CHARS} characters; this is ${description.length}` }
  }
  const metadata = {}
  if (fm.metadata !== undefined && fm.metadata !== '') {
    if (typeof fm.metadata !== 'object' || Array.isArray(fm.metadata)) return { ok: false, error: 'metadata must be a mapping of strings' }
    for (const [k, v] of Object.entries(fm.metadata)) metadata[k] = String(v)
  }
  const body = src.slice(afterClose + 1).replace(/^\n+/, '').replace(/\s+$/, '')
  if (body.length > MAX_SKILL_BODY_CHARS) return { ok: false, error: `the body is at most ${MAX_SKILL_BODY_CHARS} characters; this is ${body.length}` }
  return {
    ok: true,
    skill: { name, description, license: typeof fm.license === 'string' ? fm.license : '', metadata, body },
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

const q = (s) => JSON.stringify(String(s))

/**
 * @param {{ name: string, description: string, license?: string, metadata?: Record<string, string>, body: string }} skill
 * @returns {string}
 */
export function serializeSkillMd(skill) {
  const lines = ['---', `name: ${skill.name}`, `description: ${q(skill.description)}`]
  if (skill.license) lines.push(`license: ${q(skill.license)}`)
  const meta = Object.entries(skill.metadata ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '')
  if (meta.length) {
    lines.push('metadata:')
    for (const [k, v] of meta) lines.push(`  ${k}: ${q(v)}`)
  }
  lines.push('---', '', skill.body.replace(/\s+$/, ''), '')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Workflow ↔ skill
// ---------------------------------------------------------------------------

/**
 * A workflow's validated fields (workflows-storage.mjs validateWorkflow) as
 * a skill. A workflow with no description gets its title or name as one:
 * the format requires it, and it is what the model reads.
 *
 * @param {{ name: string, title?: string, description?: string, instructions: string, inputs?: any[], example?: { input: string, output: string } | null }} w
 */
export function workflowToSkill(w) {
  /** @type {Record<string, string>} */
  const metadata = {}
  if (w.title) metadata['redstart-title'] = w.title
  if (w.inputs?.length) metadata['redstart-inputs'] = JSON.stringify(w.inputs)
  if (w.example) metadata['redstart-example'] = JSON.stringify(w.example)
  return {
    name: w.name,
    description: (w.description || w.title || w.name).slice(0, MAX_SKILL_DESCRIPTION_CHARS),
    metadata,
    body: w.instructions,
  }
}

function jsonField(text, fallback) {
  if (typeof text !== 'string' || !text) return fallback
  try { return JSON.parse(text) } catch { return fallback }
}

/**
 * A skill as the workflow fields the routes, the MCP prompts and chat-ui
 * read. Inputs and the example that do not parse are dropped (an imported
 * skill from another agent has neither), not refused.
 *
 * @param {{ name: string, description: string, metadata?: Record<string, string>, body: string }} s
 */
export function skillToWorkflowFields(s) {
  const inputs = jsonField(s.metadata?.['redstart-inputs'], [])
  const example = jsonField(s.metadata?.['redstart-example'], null)
  return {
    name: s.name,
    title: s.metadata?.['redstart-title'] ?? '',
    description: s.description,
    instructions: s.body,
    inputs: Array.isArray(inputs) ? inputs : [],
    example: example && typeof example.input === 'string' && typeof example.output === 'string' ? example : null,
  }
}
