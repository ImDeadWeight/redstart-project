#!/usr/bin/env node
// =============================================================================
// Agent bench — run tasks against a running Nest with a loaded model
// =============================================================================
// Agent-runtime plan Phase 0.2. Run by hand, not in CI (CI tests the harness
// with a scripted fake model: scripts/test-agent-bench.mjs).
//
//   node scripts/agent-bench/run.mjs --model-label "qwen3-8b Q4_K_M" \
//     [--tasks scripts/agent-bench/tasks] [--repeat 3] [--out <dir>]
//     [--gateway http://127.0.0.1:19080] [--mcp http://127.0.0.1:19082]
//     [--thinking] [--temperature 0.2] [--model <id>] [--keep]
//
// Login on: put the bench account's API key in REDSTART_BENCH_API_KEY (or
// pass --api-key, which then sits in your shell history). Use a dedicated
// account: each run creates and deletes a conversation in it. Login off: no
// key; runs land in the shared anonymous scope.
//
// Writes to --out (default scripts/agent-bench/results/<stamp>-<label>/):
//   runs.jsonl    one line per run: verdict, metrics, final text, events
//   summary.json  totals and per-task pass rates
//   summary.md    the same as tables, plus the row for
//                 docs/notes/agent-bench-results.md
// =============================================================================

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectNest } from './lib/nest-client.mjs'
import { findTaskFiles, loadTask } from './lib/task-file.mjs'
import { runTask } from './lib/bench.mjs'
import { summarize } from './lib/metrics.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

const FLAGS = {
  '--model-label': 'modelLabel', '--tasks': 'tasks', '--repeat': 'repeat', '--out': 'out',
  '--gateway': 'gateway', '--mcp': 'mcp', '--api-key': 'apiKey', '--temperature': 'temperature',
  '--model': 'model',
}
const SWITCHES = { '--thinking': 'thinking', '--keep': 'keep', '--quiet': 'quiet' }

export function parseArgs(argv) {
  const opts = { tasks: path.join(here, 'tasks'), repeat: 1, gateway: 'http://127.0.0.1:19080' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (SWITCHES[a]) { opts[SWITCHES[a]] = true; continue }
    if (!FLAGS[a]) throw new Error(`unknown argument ${a}`)
    const v = argv[++i]
    if (v === undefined) throw new Error(`${a} needs a value`)
    opts[FLAGS[a]] = v
  }
  if (!opts.modelLabel) throw new Error('--model-label is required (it is the row label in the results table)')
  opts.repeat = Number(opts.repeat)
  if (!Number.isInteger(opts.repeat) || opts.repeat < 1) throw new Error('--repeat must be a positive integer')
  if (opts.temperature !== undefined) {
    opts.temperature = Number(opts.temperature)
    if (!Number.isFinite(opts.temperature)) throw new Error('--temperature must be a number')
  }
  if (!opts.mcp) {
    // The MCP server listens on the gateway port + 2 (mcp-server.mjs).
    const u = new URL(opts.gateway)
    u.port = String(Number(u.port || 80) + 2)
    opts.mcp = u.origin
  }
  opts.apiKey = opts.apiKey ?? process.env.REDSTART_BENCH_API_KEY ?? null
  return opts
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

/**
 * The two ways a first run usually fails, said in words that point at the
 * fix: nothing listening (Nest not running, or no model loaded: the gateway
 * and MCP server only exist while a model runs), and a rejected key.
 */
export function explainConnectError(err, opts) {
  const msg = String(err?.message ?? err)
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(msg) || /fetch failed/i.test(String(err?.cause?.message ?? ''))) {
    return `could not reach Nest at ${opts.mcp} (MCP) / ${opts.gateway} (gateway). Is Redstart running with a model loaded? The gateway and MCP server only run while a model does.`
  }
  if (/HTTP 401/.test(msg)) {
    return opts.apiKey
      ? 'Nest rejected the API key (HTTP 401). Use the bench account\'s real key: an admin sees it once when creating the account (chat Settings → Accounts), or the account can make one under Profile → Account → Generate key. Put it in REDSTART_BENCH_API_KEY.'
      : 'Nest requires a login (HTTP 401) and no API key was given. Set REDSTART_BENCH_API_KEY to the bench account\'s key (chat Settings → Accounts, or Profile → Account → Generate key).'
  }
  return msg
}

/**
 * A warning when the label does not name the loaded model file, or null.
 * Both 2026-11-11 4B rows were labelled Q4_K_M; the file was UD-Q4_K_XL.
 *
 * @param {string} label
 * @param {string | null | undefined} modelFile
 */
export function labelWarning(label, modelFile) {
  if (!modelFile) return null
  const norm = (s) => s.toLowerCase().replace(/\.gguf$/, '').replace(/[^a-z0-9]+/g, '')
  if (norm(label).includes(norm(modelFile))) return null
  return `warning: the label "${label}" does not name the loaded model file, ${modelFile}. The results row will carry the label; check it.`
}

// Above this share of recovered calls, the model and its chat template most
// likely disagree on the tool-call format. 0% for both models on their own
// templates, 69% for the 4B under the 35B's (2026-11-11).
export const FALLBACK_WARN_RATE = 0.2

/** @param {{ fallbackRate: number | null }} summary */
export function fallbackWarning(summary) {
  if (summary.fallbackRate == null || summary.fallbackRate <= FALLBACK_WARN_RATE) return null
  return `warning: ${(summary.fallbackRate * 100).toFixed(0)}% of tool calls were recovered by the fallback parser, not parsed by llama-server. ` +
    'The chat template probably does not fit this model; check the "[redstart] chat template" line in the server log before reading these numbers.'
}

const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(0)}%`)
const num = (x, d = 1) => (x == null ? '—' : x.toFixed(d))

export function summaryMarkdown(meta, summary) {
  const lines = [
    `# Agent bench — ${meta.modelLabel}`,
    '',
    `${meta.date} · commit ${meta.commit} · ${summary.runs} runs (${meta.taskCount} tasks × ${meta.repeat}) · ${meta.toolCount} tools offered · thinking ${meta.thinking ? 'on' : 'off'}`,
    '',
    `Model file: ${meta.model?.modelFile ?? 'unknown'} · chat template sha256 ${meta.model?.chatTemplateSha ?? 'unknown'}`,
    '',
    ...meta.warnings.flatMap((w) => [`> ${w}`, '']),
    '| pass | tool success | invalid args | fallback | retries/task | turns/task | tokens/task | s/task | hit a limit |',
    '|---|---|---|---|---|---|---|---|---|',
    `| ${pct(summary.passRate)} | ${pct(summary.toolSuccessRate)} | ${pct(summary.invalidArgRate)} | ${pct(summary.fallbackRate)} | ${num(summary.retriesPerTask)} | ${num(summary.turnsPerTask)} | ${num(summary.predictedTokensPerTask, 0)} | ${num(summary.wallMsPerTask == null ? null : summary.wallMsPerTask / 1000)} | ${summary.hitLimitRuns} |`,
    '',
    '| task | group | passes |',
    '|---|---|---|',
    ...summary.tasks.map((t) => `| ${t.taskId} | ${t.group} | ${t.passes}/${t.runs} |`),
    '',
    'Row for docs/notes/agent-bench-results.md:',
    '',
    `| ${meta.date} | ${meta.modelLabel} | ${meta.commit} | ${meta.taskCount}×${meta.repeat} | ${pct(summary.passRate)} | ${pct(summary.toolSuccessRate)} | ${pct(summary.invalidArgRate)} | ${pct(summary.fallbackRate)} | ${num(summary.retriesPerTask)} | ${num(summary.turnsPerTask)} | ${summary.hitLimitRuns} |`,
    '',
  ]
  return lines.join('\n')
}

/**
 * @param {string[]} argv
 * @param {{ log?: (s: string) => void }} [io]
 */
export async function main(argv, io = {}) {
  const log = io.log ?? ((s) => console.log(s))
  const opts = parseArgs(argv)

  const files = findTaskFiles(opts.tasks)
  if (files.length === 0) throw new Error(`no task files match ${opts.tasks}`)
  const tasks = []
  for (const f of files) tasks.push(await loadTask(f))

  let nest
  let mcpTools
  try {
    nest = await connectNest({ gateway: opts.gateway, mcp: opts.mcp, apiKey: opts.apiKey })
    mcpTools = await nest.listTools()
  } catch (err) {
    throw new Error(explainConnectError(err, opts))
  }
  if (mcpTools.length === 0) log('warning: Nest offers this account no tools; every tool task will fail')
  const model = await nest.modelInfo()
  const warnings = []
  const lw = labelWarning(opts.modelLabel, model?.modelFile)
  if (lw) { warnings.push(lw); log(lw) }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outDir = path.resolve(opts.out ?? path.join(here, 'results', `${stamp}-${opts.modelLabel.replace(/[^A-Za-z0-9_.-]+/g, '_')}`))
  fs.mkdirSync(outDir, { recursive: true })
  const runsFile = path.join(outDir, 'runs.jsonl')
  fs.writeFileSync(runsFile, '')

  log(`agent-bench: ${tasks.length} task(s) × ${opts.repeat}, ${mcpTools.length} tools, model "${opts.modelLabel}"`)
  const runs = []
  for (let r = 0; r < opts.repeat; r++) {
    for (const task of tasks) {
      const result = await runTask(nest, task, {
        mcpTools, thinking: opts.thinking, temperature: opts.temperature, model: opts.model,
        keep: opts.keep, runIndex: r,
      })
      runs.push(result)
      fs.appendFileSync(runsFile, `${JSON.stringify(result)}\n`)
      if (!opts.quiet) {
        const m = result.metrics
        log(`  ${result.verdict.pass ? 'pass' : 'FAIL'}  ${task.id} [${r + 1}/${opts.repeat}]  ${m.turns} turns, ${m.toolCalls} calls${m.hitLimit ? `, hit ${m.hitLimit} limit` : ''}${result.error ? `, error: ${result.error}` : ''}  — ${result.verdict.reason ?? ''}`)
      }
    }
  }

  const summary = summarize(runs)
  const fw = fallbackWarning(summary)
  if (fw) warnings.push(fw)
  const meta = {
    modelLabel: opts.modelLabel,
    date: new Date().toISOString().slice(0, 10),
    commit: commitInfo(),
    repeat: opts.repeat,
    taskCount: tasks.length,
    toolCount: mcpTools.length,
    tools: mcpTools.map((t) => t.name),
    thinking: !!opts.thinking,
    temperature: opts.temperature ?? null,
    gateway: opts.gateway,
    // From llama-server's /props, not from the label. null when unavailable.
    model,
    warnings,
  }
  fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify({ meta, summary }, null, 2)}\n`)
  const md = summaryMarkdown(meta, summary)
  fs.writeFileSync(path.join(outDir, 'summary.md'), md)
  log(`\n${md}`)
  log(`results: ${outDir}`)
  return { outDir, summary, runs }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`agent-bench: ${err.message}`)
    process.exit(1)
  })
}
