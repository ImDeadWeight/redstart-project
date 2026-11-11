#!/usr/bin/env node
// =============================================================================
// Agent bench — why didn't the model call ask_user? (a probe, not a benchmark)
// =============================================================================
// Replays the moment an ambiguous request has been understood (the files
// already read) straight to the loaded model, many times, and counts what the
// model does next: call ask_user, ask in its reply text, call another tool,
// or just answer. Only the wording around ask_user changes between variants,
// so a difference between rows is the wording's doing, not the model's luck.
//
// Built 2026-11-11 to answer "is it the model, or us?" (results in
// docs/notes/agent-runtime-implementation.md, "Why ask_user is rarely
// called"). The tool definitions are Nest's own (loaded from the provider
// modules, so the descriptions are exactly what Nest serves) and the system
// prompt is composePrompt's, as the gateway builds it.
//
//   node scripts/agent-bench/probe-ask.mjs [--n 5] [--only V0_current,V3_invited]
//        [--think] [--llama http://127.0.0.1:19081] [--out probe.json]
//
// It talks to llama-server directly (its own loopback port, no login), not to
// the gateway: what is under test is one decision, so retrieval and the
// rest of the request path are held fixed instead. Uses whatever model is
// loaded. Nothing is written but --out (and a throwaway temp folder).
// =============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const daemon = (m) => pathToFileURL(path.join(here, '..', '..', 'daemon', `${m}.mjs`)).href
const core = (m) => pathToFileURL(path.join(here, '..', '..', '..', 'shared', 'agent-core', `${m}.mjs`)).href
const FX = path.join(here, 'tasks', 'fixtures')

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const N = Number(arg('--n', 5))
const ONLY = arg('--only', null)?.split(',')
const THINK = args.includes('--think')
const LLAMA = arg('--llama', 'http://127.0.0.1:19081')
const OUT = arg('--out', null)

// composePrompt reads the plugin registry: point it at a throwaway folder,
// never the real config.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-ask-'))
fs.mkdirSync(path.join(tmp, 'config'))
fs.mkdirSync(path.join(tmp, 'data'))
;(await import(daemon('platform-paths'))).initPaths({ config: path.join(tmp, 'config'), capabilityBase: path.join(tmp, 'data'), isPackaged: false })
const { composePrompt } = await import(daemon('system-prompt'))
const { attachmentNote } = await import(core('attachment-note'))
const { ASK_USER_DEFINITION } = await import(core('ask-user'))

const cfg = { documents: { enabled: true, outputDir: tmp }, python: { enabled: true }, documentSearch: { enabled: true }, memory: { enabled: true }, toolRetrieval: { enabled: true } }
const defs = []
for (const m of ['documents-tool', 'python-tool', 'document-search-tool', 'memory-tool', 'search-tools-provider']) {
  defs.push(...(await import(daemon(m))).toolDefs(cfg))
}
const toTool = (d) => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.inputSchema } })
const NAMES = [...defs.map((d) => d.name), 'ask_user']

const basePrompt = composePrompt({ config: cfg, hasTools: true, toolNames: NAMES, now: new Date() }).prompt
// The ask_user sentence system-prompt.mjs adds, found rather than copied, so
// the probe keeps working when the wording changes.
const ASK_LINE = /Call ask_user[^\n]*?try the tool first\./.exec(basePrompt)?.[0] ?? null
if (!ASK_LINE) console.warn('note: the composed prompt has no "Call ask_user ... try the tool first." sentence; V1/V2 change nothing there')

const POSITIVE_LINE = "If the request could reasonably mean two different things and guessing wrong would waste the user's work, call ask_user instead of guessing or asking in your reply. Read the files first; ask about what they leave open."
const POSITIVE_DESC = 'Ask the user a question and wait for the answer. Use it whenever the request is ambiguous in a way that changes what you would do — which file, which unit, which items, which order — instead of picking one yourself or writing the question in your reply. Offer 2 to 4 short options when the answers are predictable; the user can always type their own.'

const VARIANTS = {
  V0_current: { desc: ASK_USER_DEFINITION.description, line: 'keep', invite: false },
  V1_no_line: { desc: ASK_USER_DEFINITION.description, line: 'drop', invite: false },
  V2_positive: { desc: POSITIVE_DESC, line: POSITIVE_LINE, invite: false },
  V3_invited: { desc: ASK_USER_DEFINITION.description, line: 'keep', invite: true },
  V4_pos_invited: { desc: POSITIVE_DESC, line: POSITIVE_LINE, invite: true },
}

// The bench's must-ask tasks, cut at the point where the files have been read.
const TASKS = {
  units: { prompt: 'Convert the temperatures in readings.csv to the other unit and save the result as converted.csv.', files: ['readings.csv'] },
  drafts: { prompt: 'Fix the spelling mistakes in the draft.', files: ['draft_a.md', 'draft_b.md'] },
  vendors: { prompt: 'Make a table of the termination notice periods for the vendor contracts I care about, and save it as notice.csv with the columns vendor, notice_days.', files: ['vendor-alder.md', 'vendor-kestrel.md', 'vendor-osprey.md'] },
  order: { prompt: 'Sort the people in people.json and save them as sorted.csv with the columns name, age, city. I have a particular order in mind.', files: ['people.json'] },
}

function messages(task, v) {
  let system = basePrompt
  if (ASK_LINE && v.line === 'drop') system = system.replace(ASK_LINE, '')
  else if (ASK_LINE && v.line !== 'keep') system = system.replace(ASK_LINE, v.line)
  const note = attachmentNote({ saved: task.files, conversationId: 'probe', hasTool: (n) => NAMES.includes(n) })
  const user = `${task.prompt}${v.invite ? ' Ask me if anything is unclear.' : ''}${note ? `\n\n${note}` : ''}`
  const calls = task.files.map((f, i) => ({ id: `r${i}`, type: 'function', function: { name: 'read_document', arguments: JSON.stringify({ path: f }) } }))
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
    { role: 'assistant', content: 'Let me read the files first.', tool_calls: calls },
    ...task.files.map((f, i) => ({ role: 'tool', tool_call_id: `r${i}`, content: fs.readFileSync(path.join(FX, f), 'utf8') })),
  ]
}

async function once(task, v) {
  const tools = [...defs.map(toTool), toTool({ ...ASK_USER_DEFINITION, description: v.desc })]
  const res = await fetch(`${LLAMA}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: messages(task, v), tools, max_tokens: THINK ? 4000 : 500, chat_template_kwargs: { enable_thinking: THINK } }),
  })
  if (!res.ok) throw new Error(`llama-server answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const m = (await res.json()).choices?.[0]?.message ?? {}
  const call = m.tool_calls?.[0]?.function?.name
  if (call === 'ask_user') return { outcome: 'ask_user tool', sample: m.tool_calls[0].function.arguments }
  if (call) return { outcome: `other tool (${call})`, sample: null }
  const text = m.content ?? ''
  return { outcome: /\?\s*($|\n)/.test(text) ? 'asks in its reply' : 'answers', sample: text.slice(0, 300) }
}

const props = await fetch(`${LLAMA}/props`).then((r) => r.json()).catch(() => null)
console.log(`model: ${props?.model_path?.split(/[\\/]/).pop() ?? 'unknown'} · ${N} sample(s) per cell · thinking ${THINK ? 'on' : 'off'}\n`)

const out = { model: props?.model_path ?? null, think: THINK, n: N, cells: {} }
for (const [vn, v] of Object.entries(VARIANTS)) {
  if (ONLY && !ONLY.includes(vn)) continue
  for (const [tn, t] of Object.entries(TASKS)) {
    const tally = {}
    const samples = []
    for (let i = 0; i < N; i++) {
      const r = await once(t, v)
      tally[r.outcome] = (tally[r.outcome] ?? 0) + 1
      if (r.sample) samples.push({ outcome: r.outcome, sample: r.sample })
    }
    out.cells[`${vn} ${tn}`] = { tally, samples }
    console.log(`${vn.padEnd(15)} ${tn.padEnd(8)} ${JSON.stringify(tally)}`)
  }
}
if (OUT) fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`)
fs.rmSync(tmp, { recursive: true, force: true })
