// =============================================================================
// Agent bench — metrics from one run's event log
// =============================================================================
// The brainstorm's list (agent-runtime plan §3, 0.2), computed from events
// only, so a rerun of the scorer over a saved log gives the same numbers:
//
//   pass            the task's check (outcome, never call counts: plan D8)
//   toolCalls       calls the model made (denied ones included)
//   toolErrors      results that came back isError (denials included)
//   toolSuccessRate (toolCalls - toolErrors) / toolCalls, null with no calls
//   invalidArgs     arguments that fail JSON.parse or the tool's schema
//   fallbackCalls   calls recovered from text by the fallback parser rather
//                   than parsed by llama-server. Near 0 on a model whose chat
//                   template fits; 69% for Qwen3-4B under the Qwen3.6
//                   template (2026-11-11), which is what it is here to catch
//   retries         a call to a tool whose previous call errored
//   turns, promptTokens, predictedTokens, wallMs
//   hitLimit        'turns' | 'seconds' | null
//   askCalls        ask_user calls (Phase 1), malformed ones included
//   dismissedAsks   questions the task had no answer for: on a task that
//                   should never ask, every one is an unneeded question
//   planCalls       update_plan calls (Phase 1.2), malformed ones included
//   planNudges      turns the core's completion check added (0 or 1)
//   textAsks        replies that ended in a question the bench answered
//                   (only with --text-asks answer; asking without the tool)
//   planLeftOpen    the run ended with plan steps still open (true/false;
//                   null without a plan)
//
// Tool retrieval (second pass, 0.2), from the gateway's report headers
// (tools_sent events) and llama-server's timings. Null where the run has no
// such data: an older Nest, or a --runtime run (the daemon makes the calls).
//
//   retrieval         'on' if retrieval ran on any turn, else 'off'
//   toolSets          distinct tool sets sent over the run's turns (1 means
//                     the prompt ahead of the chat never changed)
//   toolsSentFirst    how many tools the first turn was sent
//   cacheMissTurns    turns after the first whose reused prefix (cache_n) is
//                     under CACHE_MISS_FRACTION of the previous turn's whole
//                     prompt: the prefix was thrown away and prefilled again
//   prefillMs         sum of the turns' prompt_ms
//   firstTool         the first tool the model called, ask_user and
//                     update_plan aside (they are always offered, and are no
//                     choice of retrieval's)
//   firstToolExpected whether the task's expectTools lists firstTool; null
//                     when the task names none or nothing was called
//
// The schema check is deliberately shallow: an object, every `required` key
// present, each present key's top-level JSON type matching the schema's
// `type`, and no unknown key when additionalProperties is false. That catches
// what small models get wrong (missing keys, a string for a number, invented
// keys) without a validator dependency.
// =============================================================================

import { FALLBACK_ID_PREFIX } from '../../../../shared/agent-core/tool-call-parser.mjs'

/**
 * Below this share of the previous turn's prompt, a turn's reused prefix
 * counts as a cache miss. A turn normally reuses everything before it (cache_n
 * close to the last prompt's size); a change to the tool list, ahead of the
 * chat, drops it to roughly the system prompt or to 0 (P2). Half sits far from
 * both.
 */
export const CACHE_MISS_FRACTION = 0.5

/** Host-resolved tools: offered on every turn, so not a first choice. */
const HOST_TOOLS = new Set(['ask_user', 'update_plan'])

/** @param {unknown} v */
function jsonType(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (Number.isInteger(v)) return 'integer'
  return typeof v
}

/** @param {string} want @param {unknown} v */
function typeMatches(want, v) {
  const got = jsonType(v)
  if (want === 'number') return got === 'number' || got === 'integer'
  return want === got
}

/**
 * Why these arguments are invalid for this schema, or null when they are fine.
 *
 * @param {string} argumentsText the raw string the model produced
 * @param {any} schema the tool's inputSchema (absent: anything that parses)
 * @returns {string | null}
 */
export function argumentProblem(argumentsText, schema) {
  let args
  const text = (argumentsText ?? '').trim()
  if (text === '') {
    args = {}
  } else {
    try {
      args = JSON.parse(text)
    } catch {
      return 'arguments are not valid JSON'
    }
  }
  if (!schema || typeof schema !== 'object') return null
  if (jsonType(args) !== 'object') return 'arguments are not an object'
  for (const key of Array.isArray(schema.required) ? schema.required : []) {
    if (!(key in args)) return `missing required "${key}"`
  }
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {}
  for (const [key, value] of Object.entries(args)) {
    const prop = props[key]
    if (!prop) {
      if (schema.additionalProperties === false) return `unknown key "${key}"`
      continue
    }
    const want = prop.type
    if (typeof want === 'string' && !typeMatches(want, value)) return `"${key}" should be ${want}, got ${jsonType(value)}`
    if (Array.isArray(want) && !want.some((w) => typeMatches(w, value))) return `"${key}" should be ${want.join('|')}, got ${jsonType(value)}`
  }
  return null
}

/**
 * @param {any[]} events one run's log
 * @param {{ pass: boolean }} verdict
 * @param {{ expectTools?: string[] | null }} [task]
 */
export function computeMetrics(events, verdict, task = {}) {
  let toolCalls = 0
  let toolErrors = 0
  let invalidArgs = 0
  let fallbackCalls = 0
  let retries = 0
  let turns = 0
  let promptTokens = 0
  let predictedTokens = 0
  let hitLimit = null
  let askCalls = 0
  let dismissedAsks = 0
  let planCalls = 0
  let planNudges = 0
  let textAsks = 0
  let planLeftOpen = null
  const lastErroredByTool = new Map()
  /** @type {'on' | 'off' | null} */
  let retrieval = null
  const toolSetKeys = new Set()
  let toolsSentFirst = null
  let cacheMissTurns = null
  let prefillMs = null
  let firstTool = null
  /** the previous assistant turn's whole prompt (cache_n + prompt_n) */
  let lastPromptTotal = null

  for (const e of events) {
    if (e.type === 'turn') turns++
    if (e.type === 'assistant' && e.timings) {
      promptTokens += e.timings.prompt_n || 0
      predictedTokens += e.timings.predicted_n || 0
      if (typeof e.timings.prompt_ms === 'number') prefillMs = (prefillMs ?? 0) + e.timings.prompt_ms
      if (typeof e.timings.cache_n === 'number') {
        cacheMissTurns ??= 0
        if (lastPromptTotal !== null && e.timings.cache_n < CACHE_MISS_FRACTION * lastPromptTotal) cacheMissTurns++
        lastPromptTotal = e.timings.cache_n + (e.timings.prompt_n || 0)
      }
    }
    if (e.type === 'tools_sent') {
      if (e.retrieval === 'on') retrieval = 'on'
      else if (e.retrieval === 'off' && retrieval === null) retrieval = 'off'
      if (Array.isArray(e.names)) {
        toolSetKeys.add([...e.names].sort().join('\n'))
        toolsSentFirst ??= e.names.length
      }
    }
    if (e.type === 'tool_call') {
      toolCalls++
      if (e.argsProblem) invalidArgs++
      if (typeof e.id === 'string' && e.id.startsWith(FALLBACK_ID_PREFIX)) fallbackCalls++
      if (lastErroredByTool.get(e.name)) retries++
      if (e.name === 'ask_user') askCalls++
      if (e.name === 'update_plan') planCalls++
      if (firstTool === null && !HOST_TOOLS.has(e.name)) firstTool = e.name
    }
    if (e.type === 'tool_result') {
      if (e.isError) toolErrors++
      if (e.name === 'ask_user' && e.dismissed) dismissedAsks++
      lastErroredByTool.set(e.name, !!e.isError)
    }
    if (e.type === 'limit') hitLimit = e.which
    if (e.type === 'plan_nudge') planNudges++
    if (e.type === 'text_ask') textAsks++
    if (e.type === 'plan_final') planLeftOpen = e.open > 0
  }

  const start = events.find((e) => e.type === 'start')?.t
  const end = events.findLast((e) => e.type === 'end')?.t

  return {
    pass: !!verdict.pass,
    toolCalls,
    toolErrors,
    toolSuccessRate: toolCalls ? (toolCalls - toolErrors) / toolCalls : null,
    invalidArgs,
    invalidArgRate: toolCalls ? invalidArgs / toolCalls : null,
    fallbackCalls,
    retries,
    turns,
    promptTokens,
    predictedTokens,
    wallMs: start != null && end != null ? end - start : null,
    hitLimit,
    askCalls,
    dismissedAsks,
    planCalls,
    planNudges,
    textAsks,
    planLeftOpen,
    retrieval,
    toolSets: toolSetKeys.size || null,
    toolsSentFirst,
    cacheMissTurns,
    prefillMs,
    firstTool,
    firstToolExpected: firstTool !== null && Array.isArray(task.expectTools) ? task.expectTools.includes(firstTool) : null,
  }
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

/**
 * Totals over many runs, overall and per task.
 *
 * @param {Array<{ taskId: string, group: string, metrics: ReturnType<typeof computeMetrics> }>} runs
 */
export function summarize(runs) {
  const byTask = new Map()
  for (const r of runs) {
    if (!byTask.has(r.taskId)) byTask.set(r.taskId, { taskId: r.taskId, group: r.group, runs: [] })
    byTask.get(r.taskId).runs.push(r.metrics)
  }
  const tasks = [...byTask.values()].map((t) => ({
    taskId: t.taskId,
    group: t.group,
    runs: t.runs.length,
    passes: t.runs.filter((m) => m.pass).length,
    passRate: t.runs.filter((m) => m.pass).length / t.runs.length,
    ...retrievalSummary(t.runs),
  }))

  const all = runs.map((r) => r.metrics)
  const withCalls = all.filter((m) => m.toolCalls > 0)
  const totalCalls = all.reduce((a, m) => a + m.toolCalls, 0)
  return {
    runs: all.length,
    passRate: all.length ? all.filter((m) => m.pass).length / all.length : null,
    toolSuccessRate: totalCalls ? all.reduce((a, m) => a + (m.toolCalls - m.toolErrors), 0) / totalCalls : null,
    invalidArgRate: totalCalls ? all.reduce((a, m) => a + m.invalidArgs, 0) / totalCalls : null,
    // `?? 0`: a runs.jsonl written before fallbackCalls existed re-summarizes as 0.
    fallbackRate: totalCalls ? all.reduce((a, m) => a + (m.fallbackCalls ?? 0), 0) / totalCalls : null,
    retriesPerTask: mean(all.map((m) => m.retries)),
    turnsPerTask: mean(all.map((m) => m.turns)),
    predictedTokensPerTask: mean(all.map((m) => m.predictedTokens)),
    wallMsPerTask: mean(all.map((m) => m.wallMs).filter((x) => x != null)),
    hitLimitRuns: all.filter((m) => m.hitLimit).length,
    runsWithToolCalls: withCalls.length,
    // `?? 0`: runs saved before Phase 1 re-summarize as 0.
    askCalls: all.reduce((a, m) => a + (m.askCalls ?? 0), 0),
    dismissedAsks: all.reduce((a, m) => a + (m.dismissedAsks ?? 0), 0),
    runsThatAsked: all.filter((m) => (m.askCalls ?? 0) > 0).length,
    planCalls: all.reduce((a, m) => a + (m.planCalls ?? 0), 0),
    runsThatPlanned: all.filter((m) => (m.planCalls ?? 0) > 0).length,
    planNudges: all.reduce((a, m) => a + (m.planNudges ?? 0), 0),
    textAsks: all.reduce((a, m) => a + (m.textAsks ?? 0), 0),
    runsThatAskedInText: all.filter((m) => (m.textAsks ?? 0) > 0).length,
    plansLeftOpen: all.filter((m) => m.planLeftOpen === true).length,
    ...retrievalSummary(all),
    tasks,
  }
}

const sum = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) : null)

/**
 * The retrieval numbers over some runs (all of them, or one task's). Runs
 * with no data for a number are left out of it rather than counted as 0.
 *
 * @param {Array<ReturnType<typeof computeMetrics>>} runs
 */
export function retrievalSummary(runs) {
  const known = (k) => runs.map((m) => m[k]).filter((x) => x != null)
  const expected = known('firstToolExpected')
  return {
    // e.g. 'on' or 'on, off': which states the runs saw, sorted.
    retrieval: [...new Set(known('retrieval'))].sort().join(', ') || null,
    toolSetsPerRun: mean(known('toolSets')),
    toolsSentFirst: mean(known('toolsSentFirst')),
    cacheMissTurns: sum(known('cacheMissTurns')),
    prefillMsPerRun: mean(known('prefillMs')),
    firstToolExpected: expected.filter(Boolean).length,
    firstToolJudged: expected.length,
  }
}
