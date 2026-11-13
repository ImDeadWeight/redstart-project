#!/usr/bin/env node
// =============================================================================
// Memory bench — how well the reviewer proposes memories (Phase 8.0, D33)
// =============================================================================
// Runs each case in cases/ through a reviewer variant against the loaded
// model, and scores what it proposes. Run by hand with Nest started and a
// model loaded; CI tests the harness with a scripted model
// (scripts/test-memory-bench.mjs).
//
//   node scripts/memory-bench/run.mjs --model-label "<model file>" \
//     [--variant v1|v2] [--think off|on] [--think-budget n] [--cases <dir or glob>]
//     [--repeat n] [--port 19081] [--out <dir>]
//
// --think-budget (with --think on) sets max_tokens, reasoning included, in
// place of the 4096 the daemon ships (8.3: the 35B ran past 4096).
//
// --port is llama-server's own port (Nest's gateway port + 1), the one the
// daemon's reviewer calls (memory-review.mjs callUpstream). Nothing is saved
// in Nest: no conversation, no memory, no suggestion.
//
// For each case: the variant builds the request exactly as the reviewer
// would (v1: the frozen pre-Phase-8 reviewer, lib/v1.mjs; v2: the daemon's
// memory-review.mjs once 8.2 lands), the model answers, the variant's
// filterOps keeps what may be acted on. Both the raw and the filtered ops are
// scored (lib/score.mjs), so a miss can be pinned on the model or the filter.
//
// Writes to --out (default scripts/memory-bench/results/<stamp>-<label>/):
//   runs.jsonl, summary.json, summary.md (with the row for
//   docs/notes/agent-bench-results.md, "Memory bench").
// =============================================================================

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findCaseFiles, loadCase, caseWorld, GROUPS, CASE_NOW } from './lib/case-file.mjs'
import { opsFromRaw, opsFromFiltered, scoreCase } from './lib/score.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
/** Reasoning plus the answer: the review's 600 is for the answer alone. */
export const THINK_MAX_TOKENS = 4096
const MODEL_TIMEOUT_MS = 180_000

const FLAGS = { '--model-label': 'modelLabel', '--variant': 'variant', '--think': 'think', '--think-budget': 'thinkBudget', '--cases': 'cases', '--repeat': 'repeat', '--port': 'port', '--out': 'out' }

export function parseArgs(argv) {
  const opts = { variant: 'v1', think: 'off', thinkBudget: null, cases: path.join(here, 'cases'), repeat: 1, port: 19081 }
  for (let i = 0; i < argv.length; i++) {
    const key = FLAGS[argv[i]]
    if (!key) throw new Error(`unknown argument ${argv[i]}`)
    const v = argv[++i]
    if (v === undefined) throw new Error(`${argv[i - 1]} needs a value`)
    opts[key] = v
  }
  if (!opts.modelLabel) throw new Error('--model-label is required (the row label in the results)')
  if (!['v1', 'v2'].includes(opts.variant)) throw new Error('--variant must be v1 or v2')
  if (!['off', 'on'].includes(opts.think)) throw new Error('--think must be off or on')
  opts.repeat = Number(opts.repeat)
  if (!Number.isInteger(opts.repeat) || opts.repeat < 1) throw new Error('--repeat must be a positive integer')
  opts.port = Number(opts.port)
  if (opts.thinkBudget !== null) {
    opts.thinkBudget = Number(opts.thinkBudget)
    if (opts.think !== 'on') throw new Error('--think-budget needs --think on')
    if (!Number.isInteger(opts.thinkBudget) || opts.thinkBudget < 1500) throw new Error('--think-budget must be an integer of at least 1500 (the answer alone)')
  }
  return opts
}

/** The reviewer variant: what builds the request and what filters the answer. */
export async function loadVariant(name) {
  if (name === 'v1') return (await import('./lib/v1.mjs')).variant
  const mod = await import(pathToFileURL(path.join(here, '..', '..', 'daemon', 'memory-review.mjs')).href)
  if (typeof mod.branchForReview !== 'function') {
    throw new Error('--variant v2 needs the Phase 8.2 reviewer (memory-review.mjs has no branchForReview yet)')
  }
  return {
    name: 'v2',
    turnsFor: (conversation) => mod.branchForReview(conversation, new Set()).turns,
    buildReviewRequest: mod.buildReviewRequest,
    filterOps: mod.filterOps,
    // The daemon's own ask-filter-repair round (the context rule's repair),
    // so the bench scores what a review really keeps.
    runReview: mod.runReview,
  }
}

/**
 * The request with thinking switched on or off, as a reviewer setting would.
 * v2 already built it with the daemon's own `think` (8.3), so this changes
 * nothing there unless `budget` (--think-budget) asks for a larger max_tokens;
 * v1 has no setting and gets it added here.
 */
export function withThinking(body, think, budget = null) {
  if (think !== 'on') return body
  return { ...body, enable_thinking: true, chat_template_kwargs: { ...(body.chat_template_kwargs ?? {}), enable_thinking: true }, max_tokens: budget ?? Math.max(body.max_tokens ?? 0, THINK_MAX_TOKENS) }
}

/** callUpstream, as memory-review.mjs makes it: the parsed JSON answer. */
export function upstreamCaller(port, timeoutMs = MODEL_TIMEOUT_MS) {
  return async (body) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`the model server answered ${res.status}`)
    const json = await res.json()
    const content = json?.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new Error('the model returned no content')
    const tokens = json?.usage?.completion_tokens ?? json?.timings?.predicted_n ?? null
    try {
      return { answer: JSON.parse(content), tokens }
    } catch (err) {
      // Keep enough to tell a token-cap truncation from a malformed answer.
      const finish = json?.choices?.[0]?.finish_reason ?? '?'
      throw new Error(`${err.message} (finish_reason ${finish}, ${tokens ?? '?'} tokens, ${content.length} chars; ends: ${JSON.stringify(content.slice(-160))})`)
    }
  }
}

/** One case, once. */
export async function runCase(variant, c, callModel, { think = 'off', thinkBudget = null, runIndex = 0 } = {}) {
  const world = caseWorld(c)
  const turns = variant.turnsFor(world.conversation)
  const built = variant.buildReviewRequest({ turns, userMemories: world.userMemories, projectMemories: world.projectMemories, project: world.project, now: CASE_NOW, think: think === 'on' })
  const body = withThinking(built, think, thinkBudget)
  const started = Date.now()
  let answer = null
  let error = null
  let tokens = null
  // The turns the reviewer was shown are what a quote may cite (v2, D36); v1 ignores them.
  const filterCtx = { userMemories: world.userMemories, projectMemories: world.projectMemories, project: world.project, turns }
  let filtered = []
  let repaired = 0
  if (variant.runReview) {
    // v2: every model answer (the first, and a repair's) counts as raw.
    const answers = []
    try {
      const r = await variant.runReview(async (b) => {
        const one = await callModel(b)
        tokens = (tokens ?? 0) + (one.tokens ?? 0)
        answers.push(one.answer)
        return one.answer
      }, body, filterCtx)
      filtered = r.ops
      repaired = r.repaired
    } catch (err) {
      error = err.message
    }
    answer = { ops: answers.flatMap((a) => (Array.isArray(a?.ops) ? a.ops : [])) }
  } else {
    try {
      const r = await callModel(body)
      answer = r.answer
      tokens = r.tokens ?? null
    } catch (err) {
      error = err.message
    }
    filtered = variant.filterOps(answer, filterCtx)
  }
  const rawOps = opsFromRaw(answer)
  const keptOps = opsFromFiltered(filtered)
  return {
    caseId: c.id, group: c.group, run: runIndex, error, ms: Date.now() - started, tokens, repaired,
    raw: scoreCase(c, rawOps), filtered: scoreCase(c, keptOps),
    rawOps, keptOps,
  }
}

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '–')

export function summarize(runs) {
  const groups = {}
  for (const g of GROUPS) groups[g] = { runs: 0, rawPass: 0, filteredPass: 0, rawForbid: 0, filteredForbid: 0 }
  let extra = 0, kindUnchecked = 0, errors = 0
  for (const r of runs) {
    const g = groups[r.group]
    g.runs++
    if (r.raw.pass) g.rawPass++
    if (r.filtered.pass) g.filteredPass++
    g.rawForbid += r.raw.forbidHits
    g.filteredForbid += r.filtered.forbidHits
    extra += r.filtered.extra
    kindUnchecked += r.filtered.kindUnchecked
    if (r.error) errors++
  }
  const total = runs.length
  return {
    runs: total,
    rawPass: runs.filter((r) => r.raw.pass).length,
    filteredPass: runs.filter((r) => r.filtered.pass).length,
    extraOps: extra,
    kindUnchecked,
    errors,
    injectionFilteredForbid: groups.injection.filteredForbid,
    groups,
  }
}

export function summaryMarkdown(summary, meta) {
  const lines = [
    `# Memory bench — ${meta.modelLabel}`,
    '',
    `${meta.date} · commit ${meta.commit} · variant ${meta.variant} · think ${meta.think} · ${summary.runs} runs (${meta.caseCount} cases × ${meta.repeat})${meta.modelFile ? ` · model file ${meta.modelFile}` : ''}`,
    '',
    '| group | filtered pass | raw pass | forbid hits (filtered / raw) |',
    '|---|---|---|---|',
    ...GROUPS.map((g) => {
      const s = summary.groups[g]
      return `| ${g} | ${s.filteredPass}/${s.runs} | ${s.rawPass}/${s.runs} | ${s.filteredForbid} / ${s.rawForbid} |`
    }),
    `| **all** | **${summary.filteredPass}/${summary.runs} (${pct(summary.filteredPass, summary.runs)})** | ${summary.rawPass}/${summary.runs} | ${summary.groups.injection.filteredForbid} / ${summary.groups.injection.rawForbid} in injection |`,
    '',
    `Extra ops (proposed, matching no expectation): ${summary.extraOps}. Model errors: ${summary.errors}.` +
      (summary.kindUnchecked ? ` Kind not checked (the op carried none, as v1's never do): ${summary.kindUnchecked}.` : ''),
    '',
    'Row for docs/notes/agent-bench-results.md, "Memory bench":',
    '',
    `| ${meta.date} | ${meta.modelLabel} | ${meta.variant} | think ${meta.think} | ${meta.commit} | ${GROUPS.map((g) => `${summary.groups[g].filteredPass}/${summary.groups[g].runs}`).join(' | ')} | ${summary.filteredPass}/${summary.runs} | ${summary.rawPass}/${summary.runs} | ${summary.extraOps} |`,
  ]
  return lines.join('\n') + '\n'
}

function commitInfo() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: here, encoding: 'utf8' }).trim() !== ''
    return dirty ? `${sha}+dirty` : sha
  } catch {
    return 'unknown'
  }
}

async function modelFile(port) {
  try {
    const p = await (await fetch(`http://127.0.0.1:${port}/props`)).json()
    return String(p.model_path ?? '').split(/[\\/]/).pop() || null
  } catch {
    return null
  }
}

export async function main(argv, { callModel, log = console.log, now = new Date() } = {}) {
  const opts = parseArgs(argv)
  const variant = await loadVariant(opts.variant)
  const cases = findCaseFiles(opts.cases).map(loadCase)
  if (cases.length === 0) throw new Error(`no cases in ${opts.cases}`)
  // A larger think budget needs a longer wait: about 60 ms a token covers the
  // 35B partly on the CPU.
  const call = callModel ?? upstreamCaller(opts.port, Math.max(MODEL_TIMEOUT_MS, (opts.thinkBudget ?? 0) * 60))
  const file = callModel ? null : await modelFile(opts.port)
  if (!callModel && !file) throw new Error(`cannot reach llama-server on port ${opts.port}: start Nest with a model loaded (--port is the gateway port + 1)`)

  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  // The results row carries the budget when it is not the shipped one.
  const thinkLabel = opts.thinkBudget ? `${opts.think}, budget ${opts.thinkBudget}` : opts.think
  const outDir = path.resolve(opts.out ?? path.join(here, 'results', `${stamp}-${opts.modelLabel.replace(/[^A-Za-z0-9_.-]+/g, '_')}-${opts.variant}-think-${opts.think}${opts.thinkBudget ? `-${opts.thinkBudget}` : ''}`))
  fs.mkdirSync(outDir, { recursive: true })
  log(`memory-bench: ${cases.length} case(s) × ${opts.repeat}, variant ${opts.variant}, think ${thinkLabel}, model "${opts.modelLabel}"`)

  const runs = []
  for (let rep = 0; rep < opts.repeat; rep++) {
    for (const c of cases) {
      const r = await runCase(variant, c, call, { think: opts.think, thinkBudget: opts.thinkBudget, runIndex: rep })
      runs.push(r)
      fs.appendFileSync(path.join(outDir, 'runs.jsonl'), JSON.stringify(r) + '\n')
      log(`  ${r.filtered.pass ? 'pass' : 'FAIL'}  ${c.group.padEnd(13)} ${c.id}${r.filtered.pass ? '' : `  (${r.error ?? r.filtered.reason})`}`)
    }
  }
  const summary = summarize(runs)
  const meta = { date: now.toISOString().slice(0, 10), modelLabel: opts.modelLabel, modelFile: file, variant: opts.variant, think: thinkLabel, commit: commitInfo(), caseCount: cases.length, repeat: opts.repeat }
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ meta, summary }, null, 2))
  const md = summaryMarkdown(summary, meta)
  fs.writeFileSync(path.join(outDir, 'summary.md'), md)
  log(`\n${md}`)
  log(`Written to ${outDir}`)
  return { summary, outDir }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`memory-bench: ${err.message}`)
    process.exit(1)
  })
}
