'use strict'

// =============================================================================
// Redstart Nest — tool-text arms, an A/B/C experiment (2026-11-18)
// =============================================================================
// Small models fall back on how they were trained instead of using the tools
// for what they are for. Mined from 327 Ornith runs on 2026-11-18: 52 runs
// asked the user in reply text against 28 ask_user calls; 23 memory_search and
// 7 web calls hunted for facts only the user knew; use_skill was called with a
// tool's name; update_plan was called 6 times in 327 runs. Three wordings are
// measured against each other on the 33-task bench:
//
//   a  today's text (the default; nothing here applies)
//   b  the user's proposed ask_user rewrite: long, requirement-gathering
//      framing, plus its line for the main prompt
//   c  short, habit-naming descriptions ("a question in your reply is not an
//      ask") plus a routing map in the main prompt: which tool for which kind
//      of fact or file
//
// Chosen per profile (`toolTextArm`, no UI: set in profiles.json), carried in
// the gateway config, applied in mcp-server.mjs activeToolCatalog (one place
// every tool list passes) and system-prompt.mjs buildToolPolicy. When the
// bench has picked one, fold its text into the tool modules and delete this
// file and the field.
// =============================================================================

export const TOOL_TEXT_ARMS = Object.freeze(['a', 'b', 'c'])

/** The arm a profile asks for: 'b' or 'c' when it says so, else 'a'. */
export function toolTextArmOf(value) {
  return value === 'b' || value === 'c' ? value : 'a'
}

/** The arm in force for a gateway config. */
export function toolTextArm(cfg) {
  return toolTextArmOf(cfg?.toolTextArm)
}

// ---------------------------------------------------------------------------
// Arm B: the user's rewrite, verbatim (only straight quotes made JS-safe)
// ---------------------------------------------------------------------------

const ARM_B_ASK_USER =
  'Ask the user a question and WAIT for their answer before continuing. This tool is an important part of completing tasks accurately. You are encouraged to ask for clarification, additional requirements, preferences, constraints, or guidance whenever the user\'s input would help you produce a better or more accurate result.\n\n' +
  'DO NOT assume you have all the information you need just because the user has provided an initial request. Complex tasks often require additional information that only becomes apparent during planning or execution. You may ask questions BEFORE starting a task or PARTWAY THROUGH a task when you discover missing information.\n\n' +
  'USE THIS TOOL when:\n' +
  '- The request is ambiguous and different interpretations would produce meaningfully different results.\n' +
  '- Important requirements, specifications, constraints, or preferences are missing.\n' +
  '- You need the user to choose between approaches, designs, formats, scope, or implementation decisions that could substantially affect the result.\n' +
  '- You are unsure whether your planned approach matches what the user actually wants.\n' +
  '- You discover a question during execution that needs the user\'s input before you can proceed accurately.\n' +
  '- Asking a question would prevent a significant mistake, unnecessary work, or an unwanted result.\n' +
  '- The user explicitly asks you to ask questions or gather requirements.\n\n' +
  'IMPORTANT: Do not silently guess when a missing answer could substantially change the result. Asking for clarification is often better than proceeding with an incorrect assumption. You do not need to resolve every minor uncertainty; use reasonable defaults when the answer has little impact on the outcome.\n\n' +
  'Ask through this tool, not in your reply. A question in your normal reply ends your turn without collecting an answer. When you call this tool, WAIT for the user\'s response and incorporate their answers before continuing. In background tasks, this tool allows you to pause execution and obtain user guidance rather than abandoning the task.\n\n' +
  'Not for permission to perform actions, and not for information already available in the conversation or through another tool.\n\n' +
  'When answers are predictable, offer 2 to 4 short options. The user can always provide a custom answer. If you need several pieces of information, ask them together in one call using "questions" (up to 4, each with a short "header") rather than making repeated calls. For example: {"questions": [{"header": "Audience", "question": "Who will read the report?", "options": ["Executives", "Engineers"]}, {"header": "Length", "question": "How long should it be?"}]}.\n\n' +
  'Keep questions focused, concise, and directly relevant to producing the requested result.'

/** Arm B's line for the main prompt, after the ask_user line. */
export const ARM_B_PROMPT_LINE =
  'You are not expected to solve every uncertainty independently. The user is an available source of information and guidance throughout task execution. When clarification, missing requirements, or user preferences could materially affect the quality or accuracy of your work, use the ask_user tool to obtain that information. You may pause and ask questions at any point during a task, not just at the beginning.'

// ---------------------------------------------------------------------------
// Arm C: short, naming the trained habit each tool replaces
// ---------------------------------------------------------------------------

const ARM_C_ASK_USER =
  'The only way to ask the user something and get the answer. A question written in your reply is not an ask: your turn ends with no answer, and a background task ends. ' +
  'Ask when only the user knows and it changes the result: a fact about them or their work (a name, a rate, a reference number), a choice between outcomes (which items, what order, what format), or when they asked you to ask. Ask at the start or partway through, as soon as you find the gap. Memory and the web do not hold these facts: ask instead of searching. ' +
  'Not for permission, not to confirm a plan you can carry out, not for what a file or tool in front of you says. A small doubt with a safe default: use the default and say so. ' +
  'Several things go in one call: {"questions": [{"header": "Audience", "question": "Who will read the report?", "options": ["Executives", "Engineers"]}, {"header": "Length", "question": "How long should it be?"}]}.'

const ARM_C_UPDATE_PLAN =
  'Your checklist for a task with three or more steps or deliverables; the user watches it. Call it before the first step with every step "pending", then after each step with that step "done" (or "skipped", with a note why), sending the whole list every time. Not for a single question. ' +
  'Example: {"steps": [{"text": "Read the survey file", "status": "in_progress"}, {"text": "Count the answers", "status": "pending"}, {"text": "Write the summary", "status": "pending"}]}'

const ARM_C_MEMORY_SEARCH =
  'Look up what you saved about this user in earlier conversations: their tools, preferences, role. The newest memories are already in your instructions. Not where to find a fact for this task that the user has not told you: ask them with ask_user. Example: {"query": "database"}.'

/** Added to a tool's own description in arm C (kept where it is dynamic). */
const ARM_C_APPEND = {
  web_search: ' Public information only: never for facts about the user, their business or their files.',
  web_fetch: ' Public http(s) pages only: not for files in this conversation or on this computer, and not to download programs.',
  use_skill: ' Only a name from the skill list in your instructions; tools such as ask_user or run_python are not skills, call them directly.',
}

const ARM_REPLACE = {
  b: { ask_user: ARM_B_ASK_USER },
  c: { ask_user: ARM_C_ASK_USER, update_plan: ARM_C_UPDATE_PLAN, memory_search: ARM_C_MEMORY_SEARCH },
}

/**
 * A tool definition with the arm's description, or the same object for arm a
 * and for tools the arm does not touch.
 *
 * @param {{ name: string, description?: string }} tool
 * @param {'a' | 'b' | 'c'} arm
 */
export function withArmText(tool, arm) {
  if (arm === 'a' || !tool?.name) return tool
  const replaced = ARM_REPLACE[arm]?.[tool.name]
  if (replaced) return { ...tool, description: replaced }
  if (arm === 'c' && ARM_C_APPEND[tool.name]) return { ...tool, description: `${tool.description ?? ''}${ARM_C_APPEND[tool.name]}` }
  return tool
}

/** Arm C's ask_user line for the main prompt (replaces "try the tool first"). */
export const ARM_C_ASK_PROMPT_LINE =
  'Call ask_user when only the user knows the answer and it changes the result: a fact about them or their work, a choice between outcomes, or when they asked you to ask. Put everything you need into one call, at the start or as soon as you find the gap. Do not ask permission or to confirm a plan you can carry out, and do not ask what a file or tool in front of you can tell you. A fact only the user knows is not in memory or on the web: ask.'

/**
 * Arm C's routing map: which tool for which kind of fact or file. One line per
 * tool the request carries, so it never names one the model cannot call
 * (system-prompt.mjs's substantiation rule).
 *
 * @param {(name: string) => boolean} has the request carries this tool
 * @param {boolean} fileSystemReachable File System tools are in the list or the catalog
 * @returns {string | null}
 */
export function armCRoutingMap(has, fileSystemReachable) {
  const lines = []
  if (has('ask_user')) lines.push('- A fact only the user knows (their name, rates, reference numbers, which items or what order they want): ask_user.')
  if (has('run_python') || has('read_document')) lines.push(`- Files attached to this chat, and files you make with code: ${[has('run_python') && 'run_python (its working folder)', has('read_document') && 'read_document'].filter(Boolean).join(' and ')}.`)
  if (has('create_document')) lines.push('- A finished file for the user to download: create_document, with filename when they named the file.')
  if (fileSystemReachable) lines.push(`- Files in the File System folder: the File System tools${has('search_tools') ? ', found with search_tools and called with call_tool' : ''}.`)
  if (has('run_python')) lines.push('- Arithmetic, counting, dates and data: run_python, never in your head.')
  if (has('web_search')) lines.push('- Public facts: web_search, then web_fetch to read a result.')
  if (has('memory_search')) lines.push('- What the user told you in an earlier chat: memory_search.')
  return lines.length >= 2 ? `Which tool for what:\n${lines.join('\n')}` : null
}
