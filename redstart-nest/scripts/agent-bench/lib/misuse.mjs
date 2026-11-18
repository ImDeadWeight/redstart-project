// =============================================================================
// Agent bench — the trained habits a run fell back on (2026-11-18)
// =============================================================================
// A small model in a tool environment often does what a chat model was trained
// to do instead of what the tools are for. Mined from 327 Ornith runs on
// 2026-11-18: 52 runs asked the user in reply text against 28 ask_user calls;
// 23 memory_search and 7 web calls hunted for facts only the user knew; 55
// run_python calls tried to start another program; 103 read_document calls
// hit an unsupported text type; use_skill was called with a tool's name.
//
// Counted per run from the event log alone, so the hosted bench and --runtime
// both give it, and an old runs.jsonl re-summarizes. Counts, not verdicts: a
// web search is not wrong in itself, but no bench task needs one, so across
// arms the number says how often a model reached for it anyway.
// =============================================================================

/** The last non-empty line of a reply, markdown emphasis removed. */
function lastLine(text) {
  const lines = String(text ?? '').replace(/[*_`]/g, '').split('\n').map((l) => l.trim()).filter(Boolean)
  return lines.at(-1) ?? ''
}

function argsOf(e) {
  if (e.arguments && typeof e.arguments === 'object') return e.arguments
  try { return JSON.parse(e.arguments ?? '{}') } catch { return {} }
}

/**
 * @param {Array<{ type: string, [k: string]: any }>} events one run's log
 * @returns {{ proseAsk: boolean, lookups: number, subprocess: number, unsupportedRead: number, skillAsTool: number }}
 *   proseAsk: the run's last reply ends in a question and ask_user was never called
 *   lookups: memory_search, web_search and web_fetch calls
 *   subprocess: run_python results refused because a program cannot be started
 *   unsupportedRead: read_document refusals of the file's type
 *   skillAsTool: use_skill called with the name of a tool the run was sent
 */
export function misuseOf(events) {
  const sent = new Set()
  let asked = false
  let lookups = 0
  let subprocess = 0
  let unsupportedRead = 0
  let skillAsTool = 0
  let finalText = ''
  for (const e of events ?? []) {
    if (e.type === 'tools_sent' && Array.isArray(e.names)) for (const n of e.names) sent.add(n)
    if (e.type === 'tool_call') {
      let name = e.name
      if (name === 'call_tool') name = argsOf(e).name ?? name
      if (name === 'ask_user') asked = true
      if (name === 'memory_search' || name === 'web_search' || name === 'web_fetch') lookups++
      if (name === 'use_skill') {
        const skill = argsOf(e).name
        if (typeof skill === 'string' && sent.has(skill)) skillAsTool++
      }
    }
    if (e.type === 'tool_result' && e.isError) {
      const text = String(e.text ?? '')
      if (e.name === 'run_python' && /does not support processes|Exec format error|subprocess|os\.system/i.test(text)) subprocess++
      if (e.name === 'read_document' && /Unsupported file type/i.test(text)) unsupportedRead++
    }
    if (e.type === 'end' && typeof e.finalText === 'string') finalText = e.finalText
  }
  return { proseAsk: !asked && /\?\s*$/.test(lastLine(finalText)), lookups, subprocess, unsupportedRead, skillAsTool }
}

/** Totals over runs' metrics (each carrying `misuse`); older rows count as 0. */
export function misuseSummary(metrics) {
  const m = (metrics ?? []).map((x) => x.misuse).filter(Boolean)
  const sum = (k) => m.reduce((a, x) => a + (x[k] ?? 0), 0)
  return {
    proseAskRuns: m.filter((x) => x.proseAsk).length,
    lookups: sum('lookups'),
    subprocess: sum('subprocess'),
    unsupportedRead: sum('unsupportedRead'),
    skillAsTool: sum('skillAsTool'),
  }
}
