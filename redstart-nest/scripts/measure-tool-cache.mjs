#!/usr/bin/env node
// =============================================================================
// Does the tool list break the prompt cache? (tool retrieval second pass, 0.3)
// =============================================================================
// Retrieval adds tools to a conversation as its query drifts (tool-filter.mjs,
// monotonic per conversation). The tools block is rendered ahead of the whole
// chat, so each change to it makes llama-server prefill the entire
// conversation again (P2). On a hybrid model (Ornith) that is a full prefill
// with nothing reused.
//
// This measures it on the loaded model, through the REAL gateway, so bans,
// retrieval, the composed prompt and the account's memories all apply exactly
// as for chat-ui. One conversation whose topic drifts across Nest's tool
// areas (documents, Python, search, web, memory, File System, git), sent
// turn by turn, twice:
//   server  retrieval as Nest is configured
//   off     the request opts out (redstart_retrieval: false): every post-ban
//           tool on every turn, the reference for "nothing changes"
// For each turn it prints the tools the gateway reports it sent
// (redstart_retrieval_report), whether the set changed, and llama-server's
// own counts: tokens taken from the cache (cache_n) and tokens prefilled
// (prompt_n), with the prefill time.
//
// The replies are fixed text, not the model's (max_tokens 1), so both
// variants see the same chat. One slot (id_slot 0) so the cache seen is one
// cache. Nothing is stored: no conversation is created and no tool runs. Run
// by hand with a model loaded, never in CI (its plumbing is tested against
// the agent bench's fake Nest, test-agent-bench.mjs).
//
//   node scripts/measure-tool-cache.mjs [--gateway http://127.0.0.1:19080]
//     [--mcp <gateway port + 2>] [--turns 10] [--variants server,off]
//
// Login on: the API key in REDSTART_BENCH_API_KEY (or --api-key), as for the
// agent bench. Use the bench account: the tools measured are that account's.
// =============================================================================

import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectNest } from './agent-bench/lib/nest-client.mjs'
import { toLlmTools, toolsSentReport } from './agent-bench/lib/bench.mjs'
import { CACHE_MISS_FRACTION } from './agent-bench/lib/metrics.mjs'

/** The drifting conversation: one user message per turn. */
export const CONVERSATION = [
  'Can you look at the notes I saved about the Lisbon trip and summarise them?',
  'Now work out the total cost from the budget figures in there, with Python.',
  'Search my documents for anything else that mentions flights.',
  'Fetch the airline baggage page and tell me the cabin bag limit.',
  'Write all of that up as a new document called lisbon-plan.md.',
  'Remember that I prefer aisle seats.',
  'What is in my File System folder under travel?',
  'Check the git status of the trip-planner repo.',
  'Convert the euro amounts to dollars at 1.08.',
  'Thanks. Is there anything I have forgotten?',
]

export const VARIANTS = ['server', 'off']

const filler = (seed, words) => {
  const vocab = ['the', 'trip', 'costs', 'a', 'total', 'when', 'each', 'flight', 'is', 'checked', 'against', 'budget', 'and', 'noted', 'before', 'booking', 'with', 'care', 'so', 'that', 'you', 'see', 'one', 'clear', 'plan']
  const out = []
  for (let i = 0; i < words; i++) out.push(vocab[(seed * 7 + i * 13) % vocab.length])
  return out.join(' ')
}

export function parseArgs(argv) {
  const opts = { gateway: 'http://127.0.0.1:19080', turns: CONVERSATION.length, variants: [...VARIANTS] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const v = argv[++i]
    if (v === undefined) throw new Error(`${a} needs a value`)
    if (a === '--gateway') opts.gateway = v
    else if (a === '--mcp') opts.mcp = v
    else if (a === '--api-key') opts.apiKey = v
    else if (a === '--turns') opts.turns = Number(v)
    else if (a === '--variants') opts.variants = v.split(',').map((s) => s.trim()).filter(Boolean)
    else throw new Error(`unknown argument ${a}`)
  }
  if (!Number.isInteger(opts.turns) || opts.turns < 2) throw new Error('--turns must be an integer of at least 2')
  if (opts.variants.length === 0 || opts.variants.some((x) => !VARIANTS.includes(x))) throw new Error(`--variants must be from ${VARIANTS.join(', ')}`)
  if (!opts.mcp) {
    // The MCP server listens on the gateway port + 2 (mcp-server.mjs).
    const u = new URL(opts.gateway)
    u.port = String(Number(u.port || 80) + 2)
    opts.mcp = u.origin
  }
  opts.apiKey = opts.apiKey ?? process.env.REDSTART_BENCH_API_KEY ?? null
  return opts
}

/**
 * Turns 2 onward: what they prefilled, and how many lost their prefix.
 *
 * @param {Array<{ cached: number | null, prefilled: number | null, ms: number }>} rows
 */
export function summarizeRows(rows) {
  let misses = 0
  let prefilled = 0
  let ms = 0
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1]
    const lastTotal = (prev.cached ?? 0) + (prev.prefilled ?? 0)
    if (rows[i].cached !== null && rows[i].cached < CACHE_MISS_FRACTION * lastTotal) misses++
    prefilled += rows[i].prefilled ?? 0
    ms += rows[i].ms
  }
  return { misses, prefilled, ms }
}

/**
 * @param {string[]} argv
 * @param {{ log?: (s: string) => void, conversation?: string[] }} [io]
 *   `conversation` replaces CONVERSATION (the test's fake model reads a marker in it)
 */
export async function main(argv, io = {}) {
  const log = io.log ?? ((s) => console.log(s))
  const opts = parseArgs(argv)
  const conversation = io.conversation ?? CONVERSATION
  const turns = Math.min(opts.turns, conversation.length)

  // hostTools: none. No ask_user or update_plan: this measures the tools Nest
  // serves, and nothing here would answer them.
  const nest = await connectNest({ gateway: opts.gateway, mcp: opts.mcp, apiKey: opts.apiKey, hostTools: [] })
  const tools = toLlmTools(await nest.listTools())
  const model = await nest.modelInfo()
  log(`model ${model?.modelFile ?? 'unknown'} · ${tools.length} tools offered to this account · ${turns} turns`)

  async function send(messages, variant) {
    const res = await nest.completion({
      messages, tools: tools.length > 0 ? tools : undefined,
      max_tokens: 1, temperature: 0, stream: false,
      cache_prompt: true, id_slot: 0,
      chat_template_kwargs: { enable_thinking: false },
      redstart_retrieval_report: true,
      ...(variant === 'off' ? { redstart_retrieval: false } : {}),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const report = toolsSentReport(res.headers)
    const t = (await res.json()).timings ?? {}
    return {
      names: report?.names ?? null,
      retrieval: report?.retrieval ?? null,
      cached: typeof t.cache_n === 'number' ? t.cache_n : null,
      prefilled: typeof t.prompt_n === 'number' ? t.prompt_n : null,
      ms: Math.round(t.prompt_ms ?? 0),
    }
  }

  const results = []
  for (const variant of opts.variants) {
    // A throwaway request first, so the run does not start from whatever the
    // slot held (the other variant's conversation included).
    await send([{ role: 'user', content: `reset the slot before the ${variant} run` }], 'off')
    const msgs = []
    const rows = []
    let lastSet = null
    for (let k = 0; k < turns; k++) {
      msgs.push({ role: 'user', content: conversation[k] })
      const r = await send([...msgs], variant)
      const set = r.names ? [...r.names].sort().join('\n') : null
      rows.push({ turn: k + 1, setChanged: lastSet !== null && set !== lastSet, ...r })
      lastSet = set
      // The reply the next turn carries (fixed, so both variants see the same chat).
      msgs.push({ role: 'assistant', content: `Reply ${k}. ${filler(k + 500, 120)}.` })
    }
    results.push({ variant, rows, ...summarizeRows(rows) })
  }

  for (const { variant, rows, misses, prefilled, ms } of results) {
    log(`\n## --variants ${variant} (gateway reported retrieval ${[...new Set(rows.map((r) => r.retrieval ?? 'not reported'))].join(', ')})`)
    log('| turn | tools sent | set changed | cached tokens | prefilled tokens | prefill ms |')
    log('|---|---|---|---|---|---|')
    for (const r of rows) {
      log(`| ${r.turn} | ${r.names ? r.names.length : '?'} | ${r.turn === 1 ? '(first)' : r.setChanged ? 'yes' : 'no'} | ${r.cached ?? '?'} | ${r.prefilled ?? '?'} | ${r.ms} |`)
    }
    log(`turns 2-${rows.length}: ${misses} cache miss(es), prefilled ${prefilled} tokens in ${ms} ms`)
  }
  return results
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`measure-tool-cache: ${err.message}`)
    process.exit(1)
  })
}
