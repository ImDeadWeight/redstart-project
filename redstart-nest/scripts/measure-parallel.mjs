#!/usr/bin/env node
// =============================================================================
// Two generations at once: what llama-server's slots actually give (Phase 3.11)
// =============================================================================
// Agent-runtime D29: the task runner generates one task at a time, and a
// chat goes first. Whether that is too cautious depends on two facts about
// the loaded model that nobody has measured, so this script measures them
// against the running llama-server (Nest started, a model loaded):
//
//   1. Throughput. One generation alone, then two at once. If two at once
//      each run near the solo speed, parallel slots are nearly free; if each
//      runs at half, nothing is gained and a chat waits behind a task.
//   2. Context per slot. llama-server divides n_ctx between its slots unless
//      the KV cache is unified, so with 4 slots a prompt that fits alone may
//      not fit beside another. Two prompts of ~60% of n_ctx each, at once,
//      show which: both succeed, or one fails with a context error.
//
// Read-only and generic: no Nest module, no task, nothing stored. Run by
// hand, never in CI (it needs a real model).
//
//   node scripts/measure-parallel.mjs [--port 19081] [--tokens 200]
//
// --port is llama-server's own port: Nest's gateway port + 1 (default 19081).
// Paste the printed block into docs/notes/agent-runtime-implementation.md.
// =============================================================================

const args = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : dflt
}
const port = Number(flag('--port', 19081))
const tokens = Number(flag('--tokens', 200))
const base = `http://127.0.0.1:${port}`

async function props() {
  const r = await fetch(`${base}/props`)
  if (!r.ok) throw new Error(`/props: HTTP ${r.status}`)
  return r.json()
}

/** One non-streamed generation; its own timings from llama-server. */
async function generate(prompt, maxTokens) {
  const started = Date.now()
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0,
      stream: false,
      // A thinking model would spend the budget thinking; the number wanted is raw speed.
      chat_template_kwargs: { enable_thinking: false },
    }),
  })
  const ms = Date.now() - started
  const text = await r.text()
  if (!r.ok) return { ok: false, ms, error: `HTTP ${r.status}: ${text.slice(0, 200)}` }
  let data
  try { data = JSON.parse(text) } catch { return { ok: false, ms, error: 'not JSON' } }
  const t = data.timings ?? {}
  return {
    ok: true,
    ms,
    predicted: t.predicted_n ?? data.usage?.completion_tokens ?? null,
    promptTokens: t.prompt_n ?? data.usage?.prompt_tokens ?? null,
    tps: t.predicted_per_second ?? null,
  }
}

const COUNT = 'Count upward from 1, one number per line, and do not stop until told.'
/** About `n` tokens of filler (llama tokenizers average ~4 characters a token for this). */
const filler = (n) => `${'The quick brown fox jumps over the lazy dog. '.repeat(Math.ceil((n * 4) / 45))}\nIn one word: what animal jumps?`

const fmt = (x, d = 1) => (typeof x === 'number' ? x.toFixed(d) : '?')
const line = (label, r) => r.ok
  ? `${label}: ${r.predicted ?? '?'} tokens in ${(r.ms / 1000).toFixed(1)} s, ${fmt(r.tps)} tok/s`
  : `${label}: FAILED (${r.error})`

const p = await props().catch((err) => {
  console.error(`Cannot reach llama-server at ${base} (${err.message}). Start Nest with a model loaded; --port is the gateway port + 1.`)
  process.exit(1)
})
const nCtx = p.default_generation_settings?.n_ctx ?? null
const slots = p.total_slots ?? null
const model = String(p.model_path ?? '?').split(/[\\/]/).pop()

console.log(`model ${model} · n_ctx ${nCtx ?? '?'} · slots ${slots ?? '?'}`)

// Warm-up: the first request after a load pays for allocation.
await generate('Say OK.', 4)

const solo = await generate(COUNT, tokens)
console.log(line('alone      ', solo))
const pair = await Promise.all([generate(COUNT, tokens), generate(COUNT, tokens)])
console.log(line('pair, first ', pair[0]))
console.log(line('pair, second', pair[1]))
const pairWall = Math.max(pair[0].ms, pair[1].ms)
const pairTokens = (pair[0].predicted ?? 0) + (pair[1].predicted ?? 0)
const aggregate = pairTokens / (pairWall / 1000)
const soloRate = solo.ok && solo.predicted ? solo.predicted / (solo.ms / 1000) : null
console.log(`aggregate with two at once: ${fmt(aggregate)} tok/s (alone: ${fmt(soloRate)}), ` +
  `each at ${soloRate ? fmt((100 * ((pair[0].tps ?? 0) + (pair[1].tps ?? 0))) / 2 / (solo.tps ?? soloRate), 0) : '?'}% of solo speed`)

if (nCtx) {
  const big = Math.floor(nCtx * 0.6)
  const one = await generate(filler(big), 8)
  console.log(line(`one ~${big}-token prompt alone   `, one) + (one.ok ? ` (prompt ${one.promptTokens})` : ''))
  const two = await Promise.all([generate(filler(big), 8), generate(filler(big), 8)])
  console.log(line(`two ~${big}-token prompts at once`, two[0]) + (two[0].ok ? ` (prompt ${two[0].promptTokens})` : ''))
  console.log(line(`                                `, two[1]) + (two[1].ok ? ` (prompt ${two[1].promptTokens})` : ''))
  const verdict = two.every((r) => r.ok)
    ? 'both fit: the context is not split per slot for this load (or n_ctx is large enough)'
    : 'a context failure with two at once: n_ctx is split between slots; a task beside a chat can overflow'
  console.log(`context: ${verdict}`)
} else {
  console.log('context: n_ctx unknown (/props did not say), not measured')
}
