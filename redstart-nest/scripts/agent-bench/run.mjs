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
//     [--max-tokens 4096]   (per reply; default 4096, 16384 with --thinking)
//     [--plan full|tool|off]  (update_plan with its completion check, the
//                              tool alone, or none; default full; plan U5)
//     [--text-asks end|answer] (a reply ending in a question: ends the run,
//                              the default, or is answered from the task's
//                              answers and the run goes on)
//     [--request-timeout 180]  (seconds Nest gets for a setup or read-back
//                              call; a stuck one fails that task, named)
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
import { connectNest, FILES_SNAPSHOT_LIMIT } from './lib/nest-client.mjs'
import { findTaskFiles, loadTask } from './lib/task-file.mjs'
import { runTask, maxReplyTokens } from './lib/bench.mjs'
import { summarize } from './lib/metrics.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

const FLAGS = {
  '--model-label': 'modelLabel', '--tasks': 'tasks', '--repeat': 'repeat', '--out': 'out',
  '--gateway': 'gateway', '--mcp': 'mcp', '--api-key': 'apiKey', '--temperature': 'temperature',
  '--model': 'model', '--max-tokens': 'maxTokens', '--plan': 'plan',
  '--request-timeout': 'requestTimeout', '--text-asks': 'textAsks',
}
export const PLAN_MODES = ['full', 'tool', 'off']
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
  if (opts.maxTokens !== undefined) {
    opts.maxTokens = Number(opts.maxTokens)
    if (!Number.isInteger(opts.maxTokens) || opts.maxTokens < 1) throw new Error('--max-tokens must be a positive integer')
  }
  // The plan variants plan U5 compares: full = update_plan plus the one
  // completion check; tool = update_plan alone; off = no update_plan.
  // Seconds Nest gets to answer a setup or read-back call (not the model's
  // reply, which has the task's time limit). Default 180.
  if (opts.requestTimeout !== undefined) {
    opts.requestTimeout = Number(opts.requestTimeout)
    if (!(opts.requestTimeout > 0)) throw new Error('--request-timeout must be a positive number of seconds')
  }
  // What a reply that ends in a question gets: end (the run ends there, as
  // in every run before 2026-11-11) or answer (answered from the task's
  // answers, like a chat user would; counted as a text ask).
  opts.textAsks = opts.textAsks ?? 'end'
  if (!['end', 'answer'].includes(opts.textAsks)) throw new Error('--text-asks must be end or answer')
  opts.plan = opts.plan ?? 'full'
  if (!PLAN_MODES.includes(opts.plan)) throw new Error(`--plan must be one of ${PLAN_MODES.join(', ')}`)
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

/**
 * A warning when the API key belongs to an owner or admin account, or null.
 * The bench ran as the owner on 2026-11-11, so files a model wrote with the
 * File System tools landed in the owner's real folder.
 *
 * @param {{ user?: { username?: string, role?: string } | null } | null} who /auth/me
 */
export function accountWarning(who) {
  const role = who?.user?.role
  if (role !== 'owner' && role !== 'admin') return null
  return `warning: the API key belongs to the ${role} account "${who.user.username}". Runs use that account's real files and tools; ` +
    'the bench removes what they create, but cannot undo a change to a file that was already there. Make a dedicated bench account (role user) and use its key.'
}

/**
 * The account already holds memories. Every run is shown them, so a run's
 * outcome depends on what is there (2026-11-12: an earlier run's memory_save
 * of "Wrote thank-you note to school bake sale volunteers" was found by
 * p1-skip-no-invent). The bench deletes what its own runs save; these came
 * from before that, or from someone using the account. Not deleted: they may
 * be someone's.
 *
 * @param {Array<{ id: string, text: string }> | null} memories
 */
export function memoryWarning(memories) {
  if (!memories?.length) return null
  const shown = memories.slice(0, 3).map((m) => `"${String(m.text).slice(0, 80)}"`).join(', ')
  return `warning: the bench account has ${memories.length} saved memor${memories.length === 1 ? 'y' : 'ies'} (${shown}${memories.length > 3 ? ', …' : ''}), which every run is shown. ` +
    'Delete them (chat Settings → Memory, signed in as the bench account) so runs start alike; runs from 2026-11-12 on remove what they save.'
}

/**
 * Tasks that need a tool Nest did not offer this account (a task's
 * `requires`). p2-delete-confirmed needs delete_file, which Nest offers only
 * where File System deletes are allowed; without it the task measures
 * nothing, and the row would read as the model failing.
 *
 * @param {Array<{ id: string, requires?: string[] }>} tasks
 * @param {Array<{ name: string }>} mcpTools
 */
export function requiresWarning(tasks, mcpTools) {
  const offered = new Set(mcpTools.map((t) => t.name))
  const missing = tasks
    .map((t) => ({ id: t.id, absent: (t.requires ?? []).filter((n) => !offered.has(n)) }))
    .filter((t) => t.absent.length > 0)
  if (missing.length === 0) return null
  return `warning: Nest does not offer this account ${[...new Set(missing.flatMap((m) => m.absent))].join(', ')}, so ${missing.map((m) => m.id).join(', ')} cannot pass. ` +
    'For delete_file: turn on Nest → Tools → File System → Allow destructive operations (server-wide).'
}

/** Conversations an earlier bench left behind: it was stopped mid-task. */
export const LEFTOVER_CONVERSATION = /^bench-[a-z0-9-]+-[0-9a-f]{8}$/

/**
 * A task expects to be asked, but Nest did not offer ask_user: a Nest from
 * before Phase 1 (not restarted), or an admin ban on the name. Those tasks
 * then measure nothing, and the row would read as the model not asking.
 *
 * @param {Array<{ answers: Record<string, string> }>} tasks
 * @param {Array<{ name: string }>} mcpTools
 */
export function askWarning(tasks, mcpTools) {
  const expectsAsking = tasks.filter((t) => Object.keys(t.answers ?? {}).length > 0).length
  if (expectsAsking === 0 || mcpTools.some((t) => t.name === 'ask_user')) return null
  return `warning: Nest did not offer ask_user, so the ${expectsAsking} task(s) with answers cannot ask. Restart Nest on a Phase 1 build, and check ask_user is not banned.`
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
    `${meta.date} · commit ${meta.commit} · ${summary.runs} runs (${meta.taskCount} tasks × ${meta.repeat}) · ${meta.toolCount} tools offered · thinking ${meta.thinking ? 'on' : 'off'} · plan ${meta.plan ?? 'full'} · text asks ${meta.textAsks ?? 'end'}`,
    '',
    `Model file: ${meta.model?.modelFile ?? 'unknown'} · chat template sha256 ${meta.model?.chatTemplateSha ?? 'unknown'}`,
    '',
    ...meta.warnings.flatMap((w) => [`> ${w}`, '']),
    '| pass | tool success | invalid args | fallback | retries/task | turns/task | tokens/task | s/task | hit a limit |',
    '|---|---|---|---|---|---|---|---|---|',
    `| ${pct(summary.passRate)} | ${pct(summary.toolSuccessRate)} | ${pct(summary.invalidArgRate)} | ${pct(summary.fallbackRate)} | ${num(summary.retriesPerTask)} | ${num(summary.turnsPerTask)} | ${num(summary.predictedTokensPerTask, 0)} | ${num(summary.wallMsPerTask == null ? null : summary.wallMsPerTask / 1000)} | ${summary.hitLimitRuns} |`,
    '',
    // Phase 1: a dismissed question is one the task had no answer for, so on
    // the tasks that should never ask it is an unneeded one.
    `ask_user: ${summary.askCalls ?? 0} call(s) in ${summary.runsThatAsked ?? 0} run(s), ${summary.dismissedAsks ?? 0} unanswered (the task had no answer for it)`,
    '',
    `update_plan (--plan ${meta.plan ?? 'full'}): ${summary.planCalls ?? 0} call(s) in ${summary.runsThatPlanned ?? 0} run(s), ${summary.planNudges ?? 0} completion nudge(s), ${summary.plansLeftOpen ?? 0} plan(s) left with open steps`,
    '',
    `questions in reply text (--text-asks ${meta.textAsks ?? 'end'}): ${summary.textAsks ?? 0} answered in ${summary.runsThatAskedInText ?? 0} run(s)`,
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
    nest = await connectNest({
      gateway: opts.gateway, mcp: opts.mcp, apiKey: opts.apiKey,
      ...(opts.requestTimeout ? { requestTimeoutMs: opts.requestTimeout * 1000 } : {}),
      hostTools: opts.plan === 'off' ? ['ask_user'] : ['ask_user', 'update_plan'],
    })
    mcpTools = await nest.listTools()
  } catch (err) {
    throw new Error(explainConnectError(err, opts))
  }
  if (mcpTools.length === 0) log('warning: Nest offers this account no tools; every tool task will fail')
  const model = await nest.modelInfo()
  const warnings = []
  const lw = labelWarning(opts.modelLabel, model?.modelFile)
  if (lw) { warnings.push(lw); log(lw) }
  const asw = askWarning(tasks, mcpTools)
  if (asw) { warnings.push(asw); log(asw) }
  const rqw = requiresWarning(tasks, mcpTools)
  if (rqw) { warnings.push(rqw); log(rqw) }
  const who = await nest.whoami()
  const aw = accountWarning(who)
  if (aw) { warnings.push(aw); log(aw) }
  const mw = memoryWarning(await nest.listMemories().catch(() => null))
  if (mw) { warnings.push(mw); log(mw) }
  // A bench stopped mid-task (Ctrl+C, or the 2026-11-11 hang) never deleted
  // its conversation, and the workspace files stay searchable: a later
  // p1-plan-missing-input's search_documents found a leftover sales.csv in
  // chats/bench-compute-chart-…/. Deleting the conversation moves its
  // workspace to the trash (recoverable).
  if (!opts.keep) {
    const leftovers = (await nest.listConversationIds().catch(() => [])).filter((id) => LEFTOVER_CONVERSATION.test(id))
    for (const id of leftovers) await nest.deleteConversation(id).catch(() => {})
    if (leftovers.length) log(`removed ${leftovers.length} conversation(s) an earlier bench left behind (to the trash): ${leftovers.join(', ')}`)
  }
  // One probe of the File System folder: too big to snapshot before every
  // task means no cleanup there, said once.
  let fileSystemSnapshot = true
  if ((await nest.snapshotFiles('files').catch(() => null)) === false) {
    fileSystemSnapshot = false
    const w = `warning: this account's File System folder holds more than ${FILES_SNAPSHOT_LIMIT} entries, so files a model writes there will not be cleaned up after each task. Use a dedicated bench account.`
    warnings.push(w)
    log(w)
  }

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
        mcpTools, thinking: opts.thinking, temperature: opts.temperature, model: opts.model, maxTokens: opts.maxTokens, fileSystemSnapshot, plan: opts.plan, textAsks: opts.textAsks,
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
  const changed = [...new Set(runs.flatMap((r) => r.fileSystemWrites?.modified ?? []))].sort()
  if (changed.length) {
    warnings.push(`warning: runs changed ${changed.length} file(s) that were already in the account's File System folder, which cannot be undone: ${changed.join(', ')}`)
  }
  const broken = runs.filter((r) => r.events.some((e) => e.type === 'bench_error'))
  if (broken.length) {
    warnings.push(`warning: ${broken.length} run(s) failed because Nest did not answer a setup or read-back call, not because of the model: ${broken.map((r) => `${r.taskId} (${r.events.find((e) => e.type === 'bench_error').message})`).join('; ')}. Do not compare this row.`)
  }
  const unchecked = runs.filter((r) => r.events.some((e) => e.type === 'documents_not_checked')).map((r) => r.taskId)
  if (unchecked.length) {
    warnings.push(`warning: the account's documents folder could not be listed (over ${FILES_SNAPSHOT_LIMIT} entries, or the listing failed), so documents these runs may have created were neither given to their checks nor removed: ${[...new Set(unchecked)].join(', ')}. Use a dedicated bench account.`)
  }
  const meta = {
    modelLabel: opts.modelLabel,
    date: new Date().toISOString().slice(0, 10),
    commit: commitInfo(),
    repeat: opts.repeat,
    taskCount: tasks.length,
    toolCount: mcpTools.length,
    tools: mcpTools.map((t) => t.name),
    thinking: !!opts.thinking,
    plan: opts.plan,
    textAsks: opts.textAsks,
    temperature: opts.temperature ?? null,
    maxTokens: maxReplyTokens(opts),
    gateway: opts.gateway,
    // From llama-server's /props, not from the label. null when unavailable.
    model,
    account: who?.user ? { username: who.user.username ?? null, role: who.user.role ?? null } : null,
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
