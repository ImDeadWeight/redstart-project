'use strict'

// =============================================================================
// Redstart Nest — workflows: saved instructions for one recurring task
// =============================================================================
// A workflow is a named instruction ("turn my shorthand notes into the weekly
// report format") the user runs from the chat composer by typing `/`. Two
// scopes:
//
//   personal — one account's own. Anyone may create them, always (plan D5).
//   org      — visible to every account. Writing one takes the admin
//              permission manageOrgWorkflows (permissions.mjs, plan D4).
//
//   <config>/workflows.json
//   { personal: { "<scope key>": [workflow] }, org: [workflow] }
//
// The scope key is the account id, or '_local' with auth off — the same rule
// and the same shared-with-auth-off posture as memories (memory-storage.mjs).
//
// THE TEXT STAYS HERE. The client names a workflow and supplies argument
// values; composeWorkflowMessage below builds what the model reads. That is the
// modes rule (system-prompt.mjs §9): a client cannot inject a workflow by
// naming one that does not exist. Delivery is the MCP prompts primitive
// (mcp-server.mjs), and what it produces is a USER message — workflow text is
// user-tier content, below the admin's prompt blocks, and never touches the
// system prompt (plan D3).
// =============================================================================

import * as crypto from 'crypto'
import * as path from 'path'
import { configDir } from './platform-paths.mjs'
import { readJsonOr, writeJsonAtomic } from './json-store.mjs'
import { memoryKey } from './memory-storage.mjs'

export const MAX_NAME_CHARS = 48
export const MAX_TITLE_CHARS = 80
export const MAX_DESCRIPTION_CHARS = 300
export const MAX_INSTRUCTIONS_CHARS = 6000
export const MAX_EXAMPLE_CHARS = 3000
export const MAX_INPUTS = 8
export const MAX_INPUT_DESCRIPTION_CHARS = 200
export const MAX_PERSONAL_PER_ACCOUNT = 100
export const MAX_ORG = 200

// Org entries are listed under this prefix so a personal and an org workflow
// with the same slug never share an MCP prompt name (plan D7). A personal slug
// may not itself start with it, or the two namespaces would overlap again.
export const ORG_PREFIX = 'org-'

const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const INPUT_NAME = /^[a-z][a-z0-9_]{0,31}$/
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]{0,31})\s*\}\}/g

function file() { return path.join(configDir(), 'workflows.json') }
function read() {
  const data = readJsonOr(file(), { personal: {}, org: [] })
  if (!data.personal || typeof data.personal !== 'object') data.personal = {}
  if (!Array.isArray(data.org)) data.org = []
  return data
}
function write(data) { writeJsonAtomic(file(), data) }

// ---------------------------------------------------------------------------
// Validation — pure
// ---------------------------------------------------------------------------

function optionalString(value, field, max) {
  if (value === undefined || value === null) return { value: '' }
  if (typeof value !== 'string') return { error: `${field} must be a string` }
  const v = value.trim()
  if (v.length > max) return { error: `${field} is at most ${max} characters; this is ${v.length}` }
  return { value: v }
}

/**
 * Validate and normalise a workflow body from a client. Never trusts ids,
 * timestamps or authorship from the body — those are the store's.
 *
 * @param {any} body
 * @param {{ scope: 'personal'|'org' }} opts
 * @returns {{ ok: true, fields: object } | { ok: false, error: string }}
 */
export function validateWorkflow(body, { scope }) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be an object' }

  const name = typeof body.name === 'string' ? body.name.trim().toLowerCase() : ''
  if (!name) return { ok: false, error: 'name is required — it is the /command that runs the workflow' }
  if (name.length > MAX_NAME_CHARS) return { ok: false, error: `name is at most ${MAX_NAME_CHARS} characters` }
  if (!SLUG.test(name)) return { ok: false, error: 'name may use lowercase letters, digits and inner hyphens only (e.g. "weekly-report")' }
  if (scope === 'personal' && name.startsWith(ORG_PREFIX)) {
    return { ok: false, error: `a personal workflow name may not start with "${ORG_PREFIX}" — that prefix marks organization workflows` }
  }

  const title = optionalString(body.title, 'title', MAX_TITLE_CHARS)
  if (title.error) return { ok: false, error: title.error }
  const description = optionalString(body.description, 'description', MAX_DESCRIPTION_CHARS)
  if (description.error) return { ok: false, error: description.error }

  if (typeof body.instructions !== 'string' || !body.instructions.trim()) {
    return { ok: false, error: 'instructions are required — what should the assistant do with the input?' }
  }
  const instructions = body.instructions.trim()
  if (instructions.length > MAX_INSTRUCTIONS_CHARS) {
    return { ok: false, error: `instructions are at most ${MAX_INSTRUCTIONS_CHARS} characters; these are ${instructions.length}` }
  }

  const rawInputs = body.inputs ?? []
  if (!Array.isArray(rawInputs)) return { ok: false, error: 'inputs must be a list' }
  if (rawInputs.length > MAX_INPUTS) return { ok: false, error: `a workflow takes at most ${MAX_INPUTS} inputs` }
  const inputs = []
  const seen = new Set()
  for (const raw of rawInputs) {
    const inputName = typeof raw?.name === 'string' ? raw.name.trim().toLowerCase() : ''
    if (!INPUT_NAME.test(inputName)) {
      return { ok: false, error: `input name "${raw?.name ?? ''}" must start with a letter and use lowercase letters, digits and underscores (≤ 32)` }
    }
    if (seen.has(inputName)) return { ok: false, error: `input "${inputName}" is listed twice` }
    seen.add(inputName)
    const desc = optionalString(raw.description, `input "${inputName}" description`, MAX_INPUT_DESCRIPTION_CHARS)
    if (desc.error) return { ok: false, error: desc.error }
    inputs.push({ name: inputName, description: desc.value, required: raw.required !== false })
  }

  // A placeholder with no matching input would reach the model as literal
  // braces. Refused here, where the author can fix it, rather than at run time.
  for (const [, ref] of instructions.matchAll(PLACEHOLDER)) {
    if (!seen.has(ref)) return { ok: false, error: `instructions use {{${ref}}}, but there is no input named "${ref}"` }
  }

  let example = null
  if (body.example !== undefined && body.example !== null) {
    if (typeof body.example !== 'object') return { ok: false, error: 'example must be { input, output }' }
    const exIn = optionalString(body.example.input, 'example input', MAX_EXAMPLE_CHARS)
    if (exIn.error) return { ok: false, error: exIn.error }
    const exOut = optionalString(body.example.output, 'example output', MAX_EXAMPLE_CHARS)
    if (exOut.error) return { ok: false, error: exOut.error }
    // Half an example teaches the wrong thing: an output with no input shows a
    // format but not the transformation, which is the part a small model needs.
    if (exIn.value && exOut.value) example = { input: exIn.value, output: exOut.value }
    else if (exIn.value || exOut.value) return { ok: false, error: 'an example needs both an input and the output it should become' }
  }

  return {
    ok: true,
    fields: { name, title: title.value, description: description.value, instructions, inputs, example },
  }
}

// ---------------------------------------------------------------------------
// Composition — pure. What the model actually reads.
// ---------------------------------------------------------------------------

/**
 * Build the user message a workflow run sends.
 *
 * Placeholders are substituted in a single pass over the AUTHORED text, so a
 * value that itself contains "{{other}}" is never expanded — input is data and
 * is not re-read as template. Inputs the instructions do not reference are
 * appended as labelled sections, so a one-input workflow with no placeholder
 * still carries its input.
 *
 * @param {object} workflow  a stored workflow
 * @param {Record<string, unknown>} args  argument values from the client
 * @returns {{ ok: true, text: string } | { ok: false, error: string }}
 */
export function composeWorkflowMessage(workflow, args = {}) {
  const values = {}
  for (const input of workflow.inputs || []) {
    const raw = args?.[input.name]
    const v = typeof raw === 'string' ? raw.trim() : ''
    if (!v && input.required) return { ok: false, error: `the "${input.name}" input is required` }
    values[input.name] = v
  }

  const referenced = new Set()
  const body = workflow.instructions.replace(PLACEHOLDER, (_m, ref) => {
    referenced.add(ref)
    return Object.prototype.hasOwnProperty.call(values, ref) ? values[ref] : ''
  })

  const parts = [`Workflow: ${workflow.title || workflow.name}`, '', body]
  if (workflow.example) {
    parts.push('', 'Example input:', workflow.example.input, '', 'Example output:', workflow.example.output)
  }
  for (const input of workflow.inputs || []) {
    if (referenced.has(input.name) || !values[input.name]) continue
    parts.push('', `${input.name}:`, values[input.name])
  }
  return { ok: true, text: parts.join('\n') }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Newest-updated first, for display. */
function byUpdated(list) {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function listPersonal(account) {
  return byUpdated(read().personal[memoryKey(account)] || [])
}

export function listOrg() {
  return byUpdated(read().org)
}

/** Look up by id within the caller's reach: their own personal ones, then org. */
export function getWorkflow(account, scope, id) {
  const data = read()
  const list = scope === 'org' ? data.org : (data.personal[memoryKey(account)] || [])
  return list.find((w) => w.id === id) || null
}

function listFor(data, account, scope) {
  if (scope === 'org') return data.org
  const key = memoryKey(account)
  if (!data.personal[key]) data.personal[key] = []
  return data.personal[key]
}

/**
 * Create a workflow. Authorization (who may write org) is the ROUTE's job —
 * this module knows scopes, not permissions.
 *
 * @returns {{ ok: true, workflow: object } | { ok: false, error: string, code?: string }}
 */
export function createWorkflow(account, scope, body, { now = Date.now() } = {}) {
  const v = validateWorkflow(body, { scope })
  if (!v.ok) return v
  const data = read()
  const list = listFor(data, account, scope)
  const cap = scope === 'org' ? MAX_ORG : MAX_PERSONAL_PER_ACCOUNT
  if (list.length >= cap) return { ok: false, error: `the ${scope} limit of ${cap} workflows is reached; delete one first` }
  if (list.some((w) => w.name === v.fields.name)) {
    return { ok: false, error: `a ${scope} workflow named "${v.fields.name}" already exists`, code: 'conflict' }
  }
  const workflow = {
    id: crypto.randomUUID(),
    ...v.fields,
    createdAt: now,
    updatedAt: now,
    createdBy: account?.username ?? null,
  }
  list.push(workflow)
  write(data)
  return { ok: true, workflow }
}

export function updateWorkflow(account, scope, id, body, { now = Date.now() } = {}) {
  const v = validateWorkflow(body, { scope })
  if (!v.ok) return v
  const data = read()
  const list = listFor(data, account, scope)
  const idx = list.findIndex((w) => w.id === id)
  if (idx === -1) return { ok: false, error: 'not found', code: 'not_found' }
  if (list.some((w, i) => i !== idx && w.name === v.fields.name)) {
    return { ok: false, error: `a ${scope} workflow named "${v.fields.name}" already exists`, code: 'conflict' }
  }
  list[idx] = { ...list[idx], ...v.fields, updatedAt: now, updatedBy: account?.username ?? null }
  write(data)
  return { ok: true, workflow: list[idx] }
}

export function deleteWorkflow(account, scope, id) {
  const data = read()
  const list = listFor(data, account, scope)
  const next = list.filter((w) => w.id !== id)
  if (next.length === list.length) return false
  if (scope === 'org') data.org = next
  else data.personal[memoryKey(account)] = next
  write(data)
  return true
}

// ---------------------------------------------------------------------------
// The MCP view (plan D1, D7)
// ---------------------------------------------------------------------------

function toPrompt(workflow, scope) {
  const title = workflow.title || workflow.name
  return {
    name: scope === 'org' ? `${ORG_PREFIX}${workflow.name}` : workflow.name,
    title: scope === 'org' ? `${title} (organization)` : title,
    description: workflow.description || undefined,
    arguments: (workflow.inputs || []).map((i) => ({
      name: i.name,
      description: i.description || undefined,
      required: i.required,
    })),
  }
}

/** prompts/list for one caller: their personal workflows, then org ones. */
export function promptsFor(account) {
  return [
    ...listPersonal(account).map((w) => toPrompt(w, 'personal')),
    ...listOrg().map((w) => toPrompt(w, 'org')),
  ]
}

/**
 * prompts/get: resolve an MCP prompt name to a workflow the caller can reach
 * and compose it. An org name is resolved ONLY against org; a plain name ONLY
 * against the caller's own personal list — never another account's.
 *
 * @returns {{ ok: true, result: object } | { ok: false, error: string, code: 'not_found'|'invalid' }}
 */
export function getPromptFor(account, promptName, args) {
  if (typeof promptName !== 'string') return { ok: false, error: 'prompt name is required', code: 'invalid' }
  const isOrg = promptName.startsWith(ORG_PREFIX)
  const slug = isOrg ? promptName.slice(ORG_PREFIX.length) : promptName
  const list = isOrg ? listOrg() : listPersonal(account)
  const workflow = list.find((w) => w.name === slug)
  if (!workflow) return { ok: false, error: `no workflow named "${promptName}"`, code: 'not_found' }
  const composed = composeWorkflowMessage(workflow, args)
  if (!composed.ok) return { ok: false, error: composed.error, code: 'invalid' }
  return {
    ok: true,
    result: {
      description: workflow.description || workflow.title || workflow.name,
      messages: [{ role: 'user', content: { type: 'text', text: composed.text } }],
    },
  }
}
