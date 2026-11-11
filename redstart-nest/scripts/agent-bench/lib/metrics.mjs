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
//   retries         a call to a tool whose previous call errored
//   turns, promptTokens, predictedTokens, wallMs
//   hitLimit        'turns' | 'seconds' | null
//
// The schema check is deliberately shallow: an object, every `required` key
// present, each present key's top-level JSON type matching the schema's
// `type`, and no unknown key when additionalProperties is false. That catches
// what small models get wrong (missing keys, a string for a number, invented
// keys) without a validator dependency.
// =============================================================================

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
 */
export function computeMetrics(events, verdict) {
  let toolCalls = 0
  let toolErrors = 0
  let invalidArgs = 0
  let retries = 0
  let turns = 0
  let promptTokens = 0
  let predictedTokens = 0
  let hitLimit = null
  const lastErroredByTool = new Map()

  for (const e of events) {
    if (e.type === 'turn') turns++
    if (e.type === 'assistant' && e.timings) {
      promptTokens += e.timings.prompt_n || 0
      predictedTokens += e.timings.predicted_n || 0
    }
    if (e.type === 'tool_call') {
      toolCalls++
      if (e.argsProblem) invalidArgs++
      if (lastErroredByTool.get(e.name)) retries++
    }
    if (e.type === 'tool_result') {
      if (e.isError) toolErrors++
      lastErroredByTool.set(e.name, !!e.isError)
    }
    if (e.type === 'limit') hitLimit = e.which
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
    retries,
    turns,
    promptTokens,
    predictedTokens,
    wallMs: start != null && end != null ? end - start : null,
    hitLimit,
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
  }))

  const all = runs.map((r) => r.metrics)
  const withCalls = all.filter((m) => m.toolCalls > 0)
  const totalCalls = all.reduce((a, m) => a + m.toolCalls, 0)
  return {
    runs: all.length,
    passRate: all.length ? all.filter((m) => m.pass).length / all.length : null,
    toolSuccessRate: totalCalls ? all.reduce((a, m) => a + (m.toolCalls - m.toolErrors), 0) / totalCalls : null,
    invalidArgRate: totalCalls ? all.reduce((a, m) => a + m.invalidArgs, 0) / totalCalls : null,
    retriesPerTask: mean(all.map((m) => m.retries)),
    turnsPerTask: mean(all.map((m) => m.turns)),
    predictedTokensPerTask: mean(all.map((m) => m.predictedTokens)),
    wallMsPerTask: mean(all.map((m) => m.wallMs).filter((x) => x != null)),
    hitLimitRuns: all.filter((m) => m.hitLimit).length,
    runsWithToolCalls: withCalls.length,
    tasks,
  }
}
