// =============================================================================
// Agent bench — one task file, loaded and checked
// =============================================================================
// A task is one JSON file (agent-runtime plan §3, 0.2):
//
//   {
//     "id": "csv-summary",
//     "group": "compute",                       optional, for the results table
//     "phase": 1,                               optional: the phase expected to make it pass
//     "prompt": "Summarise sales.csv ...",
//     "fixtures": [{ "path": "sales.csv", "from": "fixtures/sales.csv" },
//                  { "path": "notes.txt", "content": "..." }],
//     "approve": "all" | "reads" | ["tool_a", "tool_b"],
//     "answers": { "<question substring>": "<answer>" },   used from Phase 1
//     "limits": { "maxTurns": 8, "maxSeconds": 300 },
//     "check": "checks/csv.mjs#summaryHasTotals",
//     "expectTools": ["run_python"],             optional: a right first tool
//     "notes": "why the task is built this way"   optional, for people only
//   }
//
// A check is (finalText, workspaceFiles, events, ctx) => { pass, reason }:
// workspaceFiles maps workspace-relative paths to text; ctx.createdFiles maps
// documents-relative paths to text for files the run made outside its
// workspace (create_document writes to the documents root).
//
// Fixtures are attached the way chat-ui attaches files: uploaded to the
// workspace, and the prompt gets chat-ui's "[Attached files saved to the
// Python workspace ...]" note listing them.
//
// `from` and the check module resolve against the task file's folder. A
// fixture path is relative to the conversation workspace and may not climb
// out of it. Everything is validated before any run starts, so a typo fails
// the whole invocation at once rather than after an hour of model time.
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ALWAYS_PINNED_TOOL_NAMES } from '../../../daemon/tool-filter.mjs'

// 30 turns since 2026-11-11 (it was 10): the owner's call, 10 cut off runs that
// were still making progress. Rows in agent-bench-results.md before that date
// ran at 10, so their "hit limit" counts are not comparable with later ones.
export const DEFAULT_LIMITS = Object.freeze({ maxTurns: 30, maxSeconds: 600 })

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/

function fail(file, message) {
  throw new Error(`${file}: ${message}`)
}

/** A workspace-relative fixture path: forward slashes, no `..`, not absolute. */
function checkFixturePath(file, p) {
  if (typeof p !== 'string' || !p) fail(file, 'fixture path must be a non-empty string')
  if (p.includes('\\') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) fail(file, `fixture path ${p} must be relative, with forward slashes`)
  if (p.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) fail(file, `fixture path ${p} must not contain empty, . or .. segments`)
}

/**
 * Load and validate one task, resolving its fixtures to content and its check
 * to a function.
 *
 * @param {string} file absolute path of the task JSON
 */
export async function loadTask(file) {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    fail(file, `not valid JSON (${err.message})`)
  }
  const dir = path.dirname(file)

  if (!ID_RE.test(raw.id ?? '')) fail(file, 'id must match [A-Za-z0-9_-]{1,40}')
  if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) fail(file, 'prompt is required')

  const fixtures = []
  for (const fx of raw.fixtures ?? []) {
    checkFixturePath(file, fx?.path)
    if (typeof fx.content === 'string' === (typeof fx.from === 'string')) {
      fail(file, `fixture ${fx.path} needs exactly one of content or from`)
    }
    const content = typeof fx.content === 'string'
      ? Buffer.from(fx.content, 'utf8')
      : fs.readFileSync(path.resolve(dir, fx.from))
    // Where it goes: the conversation's workspace (the default, as an
    // attachment), or the account's File System folder, for a task about the
    // File System tools (p2-delete-confirmed). A files-space fixture is not
    // an attachment: the prompt names it.
    const space = fx.space ?? 'workspace'
    if (space !== 'workspace' && space !== 'files') fail(file, `fixture ${fx.path}: space must be "workspace" or "files"`)
    fixtures.push({ path: fx.path, content, space })
  }

  const approve = raw.approve ?? 'reads'
  if (!(approve === 'all' || approve === 'reads' ||
        (Array.isArray(approve) && approve.every((n) => typeof n === 'string')))) {
    fail(file, 'approve must be "all", "reads" or an array of tool names')
  }

  const answers = raw.answers ?? {}
  if (typeof answers !== 'object' || Array.isArray(answers) ||
      !Object.values(answers).every((v) => typeof v === 'string')) {
    fail(file, 'answers must map question substrings to answer strings')
  }

  const limits = { ...DEFAULT_LIMITS, ...(raw.limits ?? {}) }
  for (const k of ['maxTurns', 'maxSeconds']) {
    if (!Number.isInteger(limits[k]) || limits[k] < 1) fail(file, `limits.${k} must be a positive integer`)
  }

  // Tools the task cannot pass without, so run.mjs can say when Nest does not
  // offer them (delete_file needs File System deletes allowed) rather than
  // reporting a model failure.
  const requires = raw.requires ?? []
  if (!Array.isArray(requires) || !requires.every((n) => typeof n === 'string')) fail(file, 'requires must be an array of tool names')

  // The tools a sensible first call would use (tool retrieval second pass,
  // 0.2). Never a pass criterion: the metrics report whether the model's
  // first call (ask_user and update_plan aside) was one of them, which is how
  // "the File System tools came first on attachment tasks" is counted.
  // null: the task does not say, so it is left out of that count.
  const expectTools = raw.expectTools ?? null
  if (expectTools !== null && (!Array.isArray(expectTools) || expectTools.length === 0 ||
      !expectTools.every((n) => typeof n === 'string' && n))) {
    fail(file, 'expectTools must be a non-empty array of tool names')
  }

  // Tools retrieval leaves out of the selection on purpose (benchmarks H2,
  // the p5 tasks), sent as redstart_retrieval_withhold. The gateway never
  // withholds an always-pinned tool, so naming one here is refused: the task
  // would claim to test something it does not. A withholding task needs
  // expectTools, or there is nothing for "discovered" to be judged on.
  const withhold = raw.withhold ?? []
  if (!Array.isArray(withhold) || !withhold.every((n) => typeof n === 'string' && n)) fail(file, 'withhold must be an array of tool names')
  const pinnedWithheld = withhold.filter((n) => ALWAYS_PINNED_TOOL_NAMES.includes(n))
  if (pinnedWithheld.length) fail(file, `withhold names always-pinned tools, which are never withheld: ${pinnedWithheld.join(', ')}`)

  // Later user messages (benchmarks H4): each is sent after the model's
  // final reply to the one before, in the same conversation, so a task's
  // topic can move (B4's drift tasks). A string, or { prompt, expectTools }:
  // the tools that follow-up should bring in, which "discovered" counts with
  // the task's own. The one check judges the end of the whole conversation.
  const rawFollowUps = raw.followUps ?? []
  if (!Array.isArray(rawFollowUps)) fail(file, 'followUps must be an array')
  const followUps = rawFollowUps.map((f, i) => {
    const fu = typeof f === 'string' ? { prompt: f } : f
    if (!fu || typeof fu.prompt !== 'string' || !fu.prompt.trim()) fail(file, `followUps[${i}] needs a prompt`)
    const fuExpect = fu.expectTools ?? null
    if (fuExpect !== null && (!Array.isArray(fuExpect) || !fuExpect.every((n) => typeof n === 'string' && n))) {
      fail(file, `followUps[${i}].expectTools must be an array of tool names`)
    }
    return { prompt: fu.prompt, expectTools: fuExpect }
  })
  if (withhold.length && !expectTools && !followUps.some((f) => f.expectTools)) {
    fail(file, 'a task that withholds tools needs expectTools (its own or a follow-up\'s), the tools it has to find')
  }

  if (typeof raw.check !== 'string' || !raw.check.includes('#')) fail(file, 'check must be "<module>#<export>"')
  const [modPath, exportName] = raw.check.split('#')
  const mod = await import(pathToFileURL(path.resolve(dir, modPath)).href)
  const check = mod[exportName]
  if (typeof check !== 'function') fail(file, `check ${raw.check} does not name an exported function`)

  return {
    id: raw.id,
    group: typeof raw.group === 'string' ? raw.group : 'ungrouped',
    phase: Number.isInteger(raw.phase) ? raw.phase : 0,
    prompt: raw.prompt,
    fixtures,
    approve,
    answers,
    requires,
    expectTools,
    withhold,
    followUps,
    limits,
    checkName: raw.check,
    check,
    file,
  }
}

/**
 * Task files matching a pattern: a file, a folder (every *.json in it), or a
 * folder plus a `*` glob on the file name (`tasks/compute-*.json`).
 *
 * @param {string} pattern
 * @returns {string[]} absolute paths, sorted
 */
export function findTaskFiles(pattern) {
  const abs = path.resolve(pattern)
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return [abs]
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    return fs.readdirSync(abs).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(abs, f))
  }
  const dir = path.dirname(abs)
  const glob = path.basename(abs)
  if (!fs.existsSync(dir)) return []
  const re = new RegExp(`^${glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
  return fs.readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => path.join(dir, f))
}
