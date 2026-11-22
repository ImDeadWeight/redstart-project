'use strict'

// =============================================================================
// Redstart Nest — use_skill: the model loads a saved skill itself (Phase 5)
// =============================================================================
// The prompt lists the skills the caller can reach, name and description
// (system-prompt.mjs buildSkills, from skillsForPrompt below), so a saved
// instruction costs one line until it is used. When one fits, the model calls
// use_skill:
//
//   use_skill({})                          every skill it can reach, listed
//   use_skill({ name })                    the body (and the /-example), and
//                                          the files the skill holds
//   use_skill({ name, file })              one of those files, as text
//
// Names are the MCP prompts' (workflows-storage.mjs): a personal skill by its
// name, an organization one as "org-<name>". Another account's personal
// skills are never reachable: the scope comes from the caller.
//
// SCRIPTS RUN ONLY THROUGH run_python (U-S2, decided 2026-11-17). Loading a
// skill copies its .py files into the conversation's workspace, under
// skills/<name>/, which is the one folder run_python mounts; the model runs
// them there, in that sandbox (no network). Nothing here executes anything,
// and no other file type is ever copied to where code runs.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import { listSkills, getSkillByName, readSkillFile } from './skills-storage.mjs'
import { ORG_PREFIX } from './workflows-storage.mjs'
import { TOOL_CLASSES, HOST_RESOLVED_TOOL_NAMES, capabilityForTool } from './tools-definitions.mjs'
import { workspaceDir, workspaceRelative, checkCaps } from './conversation-workspace.mjs'

export const TOOL_NAME = 'use_skill'
export const TOOL_NAMES = [TOOL_NAME]

/** How many skills the prompt lists by name; the rest are one use_skill({}) away. */
export const PROMPT_SKILL_LIMIT = 40
/** A description in the prompt is cut to this, on one line. */
export const PROMPT_DESCRIPTION_CHARS = 200
const MAX_FILE_TEXT_CHARS = 50_000

export function toolDefs() {
  return [{
    name: TOOL_NAME,
    description:
      'Load one of the saved skills listed in your instructions: step-by-step instructions the user or their organization wrote for a recurring task. ' +
      'Call it with the skill\'s name when the task fits its description, then follow what it says. ' +
      'With no name it lists every skill you can load. With a file, it returns that file from the skill (reference text, or a script). ' +
      'A skill\'s Python scripts are copied into this conversation\'s workspace under skills/<name>/ when you load it: run them with run_python, nowhere else.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The skill\'s name, as listed (an organization skill starts with "org-")' },
        file: { type: 'string', description: 'One of the files the skill lists, e.g. "reference/format.md"' },
      },
    },
  }]
}

/** The skills one caller can reach, personal first, each with the name use_skill takes. */
function reachable(account) {
  return [
    ...listSkills(account, 'personal').map((s) => ({ skill: s, as: s.name, scope: 'personal' })),
    ...listSkills(null, 'org').map((s) => ({ skill: s, as: `${ORG_PREFIX}${s.name}`, scope: 'org' })),
  ]
}

function resolve(account, name) {
  if (typeof name !== 'string' || !name.trim()) return null
  const n = name.trim()
  if (n.startsWith(ORG_PREFIX)) return getSkillByName(null, 'org', n.slice(ORG_PREFIX.length))
  return getSkillByName(account, 'personal', n)
}

const oneLine = (s, max) => {
  const t = String(s).replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/**
 * The prompt's list: name and a one-line description, sorted by name within
 * each scope so the block changes only when a skill does (the prompt prefix
 * stays cached), at most PROMPT_SKILL_LIMIT.
 *
 * @returns {{ skills: { name: string, description: string }[], skillsOmitted: number }}
 */
export function skillsForPrompt(account) {
  let all
  try { all = reachable(account) } catch { return { skills: [], skillsOmitted: 0 } }
  const sorted = [
    ...all.filter((e) => e.scope === 'personal').sort((a, b) => (a.as < b.as ? -1 : 1)),
    ...all.filter((e) => e.scope === 'org').sort((a, b) => (a.as < b.as ? -1 : 1)),
  ]
  const shown = sorted.slice(0, PROMPT_SKILL_LIMIT)
  return {
    skills: shown.map((e) => ({ name: e.as, description: oneLine(e.skill.description, PROMPT_DESCRIPTION_CHARS) })),
    skillsOmitted: sorted.length - shown.length,
  }
}

const text = (t) => ({ content: [{ type: 'text', text: t }] })
const fail = (t) => ({ isError: true, content: [{ type: 'text', text: t }] })

/**
 * Copy a skill's .py files into the conversation's workspace, under
 * skills/<name>/. Returns what to tell the model, or null when there are none.
 */
function stageScripts(skill, as, cfg, ctx) {
  const scripts = (skill.files ?? []).filter((f) => f.endsWith('.py'))
  if (scripts.length === 0) return null
  const py = cfg?.python
  if (!py?.enabled) return `This skill has Python scripts (${scripts.join(', ')}), but run_python is not available here, so they can be read with use_skill but not run.`
  const account = ctx?.account ?? null
  const conversationId = ctx?.conversationId ?? null
  let ws
  try {
    ws = workspaceDir(py.documentsRoot, account, conversationId, { create: true })
  } catch (err) {
    return `This skill's scripts could not be copied: ${err.message}`
  }
  const caps = checkCaps(py.documentsRoot, account, conversationId, { workspaceCapBytes: py.workspaceCapBytes, accountCapBytes: py.accountCapBytes })
  if (!caps.ok) return `This skill's scripts were not copied: ${caps.reason}`
  const base = path.join(ws, 'skills', as)
  for (const rel of scripts) {
    const content = readSkillFile(skill, rel)
    if (!content) continue
    const dest = path.join(base, ...rel.split('/'))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, content)
  }
  return `Its Python scripts are copied into this conversation's workspace (${workspaceRelative(conversationId)}/skills/${as}/): run them with run_python, e.g. exec(open('skills/${as}/${scripts[0]}').read()). Nowhere else.`
}

/** How many skill names a "no such skill" answer lists. */
const NAMES_LISTED = 12

/**
 * The answer for a skill name that matches nothing, in the teaching pattern
 * (shared/agent-core/teaching.mjs). The bench saw use_skill called with a
 * TOOL's name (ask_user, run_python), a habit from harnesses where skills and
 * tools share one namespace. That gets its own line. Either way the real
 * names come along, so the next call needs no listing call first.
 * Exported for the suite.
 *
 * @param {string} name @param {any} account
 */
export function noSkillText(name, account) {
  const shown = name.trim().slice(0, 80)
  const isTool = !!(TOOL_CLASSES[shown] || HOST_RESOLVED_TOOL_NAMES.includes(shown) || capabilityForTool(shown))
  const head = isTool
    ? `"${shown}" is a tool, not a skill, so nothing was loaded. Call ${shown} itself, with its own arguments, not through use_skill.`
    : `No skill named "${shown}", so nothing was loaded.`
  let names = []
  try { names = reachable(account).map((e) => e.as) } catch { names = [] }
  if (names.length === 0) return `${head} There are no saved skills.`
  const listed = names.slice(0, NAMES_LISTED).join(', ')
  return `${head} The skills: ${listed}${names.length > NAMES_LISTED ? ' (use_skill with no name lists them all)' : ''}.`
}

export async function callTool(name, args, cfg, ctx) {
  if (name !== TOOL_NAME) return null
  const account = ctx?.account ?? null

  if (args?.name === undefined || args?.name === null || args?.name === '') {
    const all = reachable(account)
    if (all.length === 0) return text('There are no saved skills. The user can add them on the Workflows page.')
    return text(JSON.stringify({ skills: all.map((e) => ({ name: e.as, description: e.skill.description })) }))
  }

  const skill = resolve(account, args.name)
  if (!skill) return fail(noSkillText(String(args.name), account))
  const as = String(args.name).trim().startsWith(ORG_PREFIX) ? `${ORG_PREFIX}${skill.name}` : skill.name

  if (args.file !== undefined && args.file !== null && args.file !== '') {
    const content = readSkillFile(skill, String(args.file))
    if (!content) return fail(`"${String(args.file).slice(0, 120)}" is not one of this skill's files. Its files: ${skill.files.join(', ') || 'none'}.`)
    if (content.includes(0)) return fail(`${args.file} is a binary file; use_skill returns text only.`)
    const t = content.toString('utf8')
    return text(t.length > MAX_FILE_TEXT_CHARS ? `${t.slice(0, MAX_FILE_TEXT_CHARS)}\n[cut at ${MAX_FILE_TEXT_CHARS} characters]` : t)
  }

  const parts = [`Skill: ${as}`, '', skill.body]
  let example = null
  try { example = skill.metadata?.['redstart-example'] ? JSON.parse(skill.metadata['redstart-example']) : null } catch { example = null }
  if (example && typeof example.input === 'string' && typeof example.output === 'string') {
    parts.push('', 'Example input:', example.input, '', 'Example output:', example.output)
  }
  const others = skill.files.filter((f) => !f.endsWith('.py'))
  if (others.length) parts.push('', `Files in this skill (read one with use_skill({"name": "${as}", "file": "<path>"})): ${others.join(', ')}`)
  const staged = stageScripts(skill, as, cfg, ctx)
  if (staged) parts.push('', staged)
  return text(parts.join('\n'))
}
