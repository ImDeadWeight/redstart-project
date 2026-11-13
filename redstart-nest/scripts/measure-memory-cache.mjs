#!/usr/bin/env node
// =============================================================================
// Does the memory block break the prompt cache? (agent-runtime D40, before 8.4)
// =============================================================================
// selectForPrompt orders memories by the words they share with the LATEST
// user message, so block 12 of the system prompt can differ from one turn to
// the next. The block sits in the system prompt, ahead of the whole chat, so a
// change there would make llama-server prefill the entire conversation again
// on every turn, rather than only the new messages.
//
// This measures it on the loaded model. One long chat, its last few turns
// sent twice:
//   per-message  the system prompt composed per turn with that turn's query,
//                as the gateway did before D40
//   pinned       the selection made by the chat's first user message, as the
//                gateway does since (tools-gateway.mjs firstUserText)
//
// Result on Ornith 9B, 2026-11-13, an 8k-token chat: per-message reused 0
// tokens on every turn (5.5 s of prefill each); pinned reused ~7700 (0.2 s).
// For each turn it prints llama-server's own counts: tokens taken from the
// cache (cache_n) and tokens prefilled (prompt_n), with the prefill time.
//
// Uses the daemon's real composer and selection; sends straight to
// llama-server, not through Nest, so no account, key or memory is touched and
// nothing is stored. One slot (id_slot 0) so the cache seen is one cache. Run
// by hand with a model loaded, never in CI.
//
//   node scripts/measure-memory-cache.mjs [--port 19081] [--exchanges 24] [--turns 5]
//
// --port is llama-server's own port: Nest's gateway port + 1 (default 19081).
// =============================================================================

import { composePrompt } from '../daemon/system-prompt.mjs'
import { selectForPrompt } from '../daemon/memory-storage.mjs'

const args = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : dflt
}
const port = Number(flag('--port', 19081))
const exchanges = Number(flag('--exchanges', 24))
const measuredTurns = Number(flag('--turns', 5))
const base = `http://127.0.0.1:${port}`

// Newest first, as listMemories returns them. Varied enough that different
// questions pull different memories to the front, and over the 1200-char
// budget, so the selection (not only the order) can change.
const MEMORIES = [
  'Prefers metric units in every answer',
  'Works on the billing service, written in TypeScript',
  'Deploys to production on Fridays only, never on Mondays',
  'Uses Postgres 16 for the main database and SQLite for local tests',
  'Has a dog named Biscuit who needs a walk at noon',
  'Is learning Rust in the evenings, on chapter 8 of the book',
  'Runs the test suite from E:\\ because the drive letter matters for vitest',
  'Prefers short answers with the command first, explanation after',
  'Team lead is called Priya; the weekly sync is on Tuesdays',
  'Keeps project notes in Markdown files in a vault folder',
  'Allergic to shellfish; asks for recipes without it',
  'Uses Windows 11 at home and a Linux laptop at work',
  'The quarterly report is due on the last Thursday of the quarter',
  'Plays the cello in a community orchestra on Wednesday nights',
  'Wants invoices exported as CSV, never as xlsx',
  'Is planning a trip to Lisbon in March with two friends',
].map((text, i) => ({ id: `m${String(i).padStart(7, '0')}`, text }))

const TOPICS = [
  'the billing service invoices', 'Postgres indexes', 'the Friday deploy', 'Rust ownership',
  'the vitest run', 'the quarterly report', 'the Lisbon trip', 'CSV exports',
]
const filler = (seed, words) => {
  const vocab = ['the', 'service', 'returns', 'a', 'value', 'when', 'each', 'request', 'is', 'checked', 'against', 'schema', 'and', 'logged', 'before', 'retry', 'with', 'backoff', 'so', 'that', 'callers', 'see', 'one', 'error', 'message']
  const out = []
  for (let i = 0; i < words; i++) out.push(vocab[(seed * 7 + i * 13) % vocab.length])
  return out.join(' ')
}

// The chat before the measured turns, then one user message per measured turn.
const history = []
for (let i = 0; i < exchanges; i++) {
  history.push({ role: 'user', content: `Question ${i} about ${TOPICS[i % TOPICS.length]}: ${filler(i, 40)}?` })
  history.push({ role: 'assistant', content: `Answer ${i}. ${filler(i + 100, 220)}.` })
}
const LAST_QUESTIONS = [
  'How do I add an index to the invoices table in Postgres?',
  'Can we still deploy on Friday if the tests are red?',
  'What should I pack for Lisbon in March?',
  'Why does vitest load the files twice?',
  'Give me the metric conversion for the cello case dimensions.',
  'Draft the Tuesday sync agenda for Priya.',
  'Export the invoices as CSV please.',
]

const NOW = new Date('2026-11-13T12:00:00Z')
const CONFIG = { memory: { enabled: true, promptBudgetChars: 1200 } }

function systemPrompt(query) {
  const { chosen, omitted } = selectForPrompt(MEMORIES, CONFIG.memory.promptBudgetChars, { query })
  return composePrompt({ config: CONFIG, hasTools: false, account: { username: 'bench' }, now: NOW, timeZone: 'UTC', memories: chosen, memoriesOmitted: omitted }).prompt
}

async function send(messages) {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages, max_tokens: 1, temperature: 0, stream: false,
      cache_prompt: true, id_slot: 0,
      enable_thinking: false, chat_template_kwargs: { enable_thinking: false },
    }),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const t = (await r.json()).timings ?? {}
  return { cached: t.cache_n ?? null, prefilled: t.prompt_n ?? null, ms: Math.round(t.prompt_ms ?? 0) }
}

/** The measured turns; `pinnedQuery` set means the selection is made once. */
async function run(label, pinnedQuery) {
  const msgs = [...history]
  const rows = []
  let lastSystem = null
  for (let k = 0; k < measuredTurns; k++) {
    const q = LAST_QUESTIONS[k % LAST_QUESTIONS.length]
    msgs.push({ role: 'user', content: q })
    const sys = systemPrompt(pinnedQuery ?? q)
    const r = await send([{ role: 'system', content: sys }, ...msgs])
    rows.push({ turn: k + 1, systemChanged: lastSystem !== null && sys !== lastSystem, ...r })
    lastSystem = sys
    // The reply the next turn carries (fixed, so both runs see the same chat).
    msgs.push({ role: 'assistant', content: `Reply ${k}. ${filler(k + 500, 60)}.` })
  }
  return { label, rows }
}

const props = await (await fetch(`${base}/props`)).json()
console.log(`model ${String(props.model_path ?? '?').split(/[\\/]/).pop()} · n_ctx ${props.default_generation_settings?.n_ctx} · slots ${props.total_slots}`)
console.log(`chat: ${exchanges} exchanges before the measured turns; ${MEMORIES.length} memories, budget ${CONFIG.memory.promptBudgetChars} chars\n`)

// A throwaway request first, so the per-message run does not start from
// whatever the slot held.
await send([{ role: 'user', content: 'warm up' }])
const results = [await run('per-message (the gateway before D40)', null)]
await send([{ role: 'user', content: 'reset the slot between runs' }])
// What the gateway does since D40 (tools-gateway.mjs firstUserText).
results.push(await run('pinned to the first user message (the gateway since D40)', history[0].content))

for (const { label, rows } of results) {
  console.log(`## ${label}`)
  console.log('| turn | system prompt changed | cached tokens | prefilled tokens | prefill ms |')
  console.log('|---|---|---|---|---|')
  for (const r of rows) console.log(`| ${r.turn} | ${r.turn === 1 ? '(first)' : r.systemChanged ? 'yes' : 'no'} | ${r.cached} | ${r.prefilled} | ${r.ms} |`)
  const later = rows.slice(1)
  const sum = (f) => later.reduce((n, r) => n + (r[f] ?? 0), 0)
  console.log(`turns 2-${rows.length}: prefilled ${sum('prefilled')} tokens in ${sum('ms')} ms\n`)
}
