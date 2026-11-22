# Models tested

*[← back to the documentation index](README.md)*

Which models Redstart has been run on, how well each did, and what it took to get there. Most of the agent runtime (asking, planning, approvals, background tasks, the tool catalog, memory review) was tuned against two small models, **Ornith 1.5 9B** and **Qwen3-4B**, with the larger Qwen3.6-35B-A3B as the reference. A lot of the behaviour in the code (the comments that say "Ornith did…" or "the 4B did…") traces back to these runs.

All numbers below are from one machine: AMD Ryzen 7 7700X, NVIDIA RTX 3060 12 GB, 32 GB DDR5, Windows, llama-server (TurboQuant+ build). They are a record of what was measured, not a promise for other hardware.

## The models

| Model | File | Context used | Notes |
|---|---|---|---|
| **Ornith 1.5 9B** | `Ornith-1.5-9B-Q6_K` | 32k, then 128k (131,072) | The main test model from 2026-11-12 on. A hybrid architecture, so llama-server cannot reuse part of a cached prompt: any change near the front is a full prefill. Fits 128k of context on a 12 GB card. ~40 tokens/s alone. |
| **Qwen3-4B** | [`Qwen3-4B-Instruct-2507-UD-Q4_K_XL`](https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF) | default | The "small model" floor. Must run on its own embedded chat template (see below). |
| **Qwen3.6-35B-A3B** | [`Qwen3.6-35B-A3B-UD-Q3_K_XL`](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF) | default | The reference; the README's [tested configuration](../README.md#tested-configuration). |

## How they were tested

Three benchmarks, all in `redstart-nest/scripts/`, run against a real Nest with the model loaded:

- **The agent bench** (`agent-bench/run.mjs`): 33 tasks in six groups (compute, documents, multi-step, asking and planning, approvals, workarounds), each scored on the outcome (a file, a number, a refusal), never on how many calls it took. Tasks and what a pass means: [`agent-bench/tasks/README.md`](../redstart-nest/scripts/agent-bench/tasks/README.md). `scripts/test-agent-bench-tasks.mjs` (in CI) checks every task's check against a right and a plausible wrong answer.
- **The memory bench** (`memory-bench/`): 32 cases for the memory reviewer: facts, corrections, confirmations, state changes, and the ones that must produce nothing (injection, secrets).
- **The cache and throughput scripts** (`measure-tool-cache.mjs`, `measure-memory-cache.mjs`, `measure-parallel.mjs`): prompt-cache reuse per turn, and what two requests at once cost.

The task set grew over time (24 tasks on 2026-11-11, 32 from 2026-11-12, 33 from 2026-11-18), so compare rows on the same set only. Single runs swing: on the 4B one task has moved by a whole pass between identical runs, so the rows that decide anything are `--repeat 3` or more. `agent-bench/sets/signal.json` lists the tasks whose result moved across nine identical Ornith runs; use it with `--repeat 5` to compare two variants.

## Results

### Agent bench

| Date | Model | What was measured | Result |
|---|---|---|---|
| 2026-11-11 | Qwen3-4B | First baseline, 24 tasks, on its own template | 12/24 |
| 2026-11-11 | Qwen3-4B | After the baseline fixes (attachment note, sandbox imports) | 14/24 (58%), twice |
| 2026-11-11 | Qwen3-4B | Before-rows for asking and planning | 15/24, 16/24 |
| 2026-11-12 | Qwen3-4B | Asking and planning shipped: the 20 other tasks, ×3 | 43/60 (72%), against 40/60 (67%) before |
| 2026-11-12 | Qwen3-4B | `update_plan` on the three planning tasks | off 8/18, tool alone 3/9, tool plus completion note 7/9 |
| 2026-11-12 | Ornith 1.5 9B | Background tasks: browser loop against the server runtime, 32 tasks | 26/32 (81%) both |
| 2026-11-14 | Ornith 1.5 9B | Tool retrieval on against off, ×3 | on 81%, off 76%; right first tool 87/95 against 65/94 |
| 2026-11-18 | Ornith 1.5 9B | Three ways of offering tools, ×3 | per-turn selection 80.2%, everything 81.3%, fixed list plus a catalog 76.0% |
| 2026-11-18 | Ornith 1.5 9B | Guidance memories on the bench account | 75%, against 76.0% without |
| 2026-11-18 | Ornith 1.5 9B | Approval-gated delete (`p2-delete-confirmed`), ×3 | 3/3, found through the catalog |
| 2026-11-18 | Ornith 1.5 9B | Two facts to ask for at once (`p1-two-unknowns`), ×3 | 1/3; asked for both together but never through the question list, and never guessed |

The three ways of offering tools scored within noise of each other, and the fixed list with a catalog became the default: like sending everything, it never changes the prompt's tool list (0 cache-miss turns, against 23 for per-turn selection), and the list is 15 tools instead of 41.

### Memory bench (32 cases, thinking off)

| Model | Before the reviewer rewrite | After |
|---|---|---|
| Qwen3-4B | 14 | 28 |
| Ornith 1.5 9B | 20 | 27 (thinking on: 28, 31, 30) |
| Qwen3.6-35B-A3B | 28 | — |

Thinking helped Ornith and did nothing for the 4B, which is why the memory reviewer's thinking switch is per profile and off by default. On a 3060, Ornith took up to 83 s for one 3,100-token thinking answer, so the review runs in the background after a chat goes quiet.

### Two things at once (Ornith 1.5 9B)

- Two short generations: 88 to 92% of the single-request speed each, 1.75x in total.
- Two long prompts do not run side by side. The slots share one cache pool of the context size, and while one slot prefills a long prompt, the other's generation drops from ~40 to ~5 tokens/s. So Nest runs one background task at a time, with chats first between turns.

## What the testing changed

The fixes the runs forced, so it is clear why the code is the way it is:

- **A chat template has to fit the model.** The first 4B rows ran under the 35B's template, kept from the profile: llama-server parsed 34 of 109 tool calls, and 61% had arguments that could not be read. On its own template: all of them, 0% invalid. Nest now checks a profile's template against the model's architecture in the GGUF header and falls back to the embedded one when they differ (`daemon/chat-template-choice.mjs`); the bench records the file actually loaded, not just the label it was given.
- **One malformed call no longer ends the chat.** llama-server refuses a whole request when one stored call does not parse, so a single bad 4B call killed every later turn (15 of 24 runs died on turn 2). Calls are now repaired where the request is built (`shared/agent-core/tool-calls.mjs`).
- **Small-model argument habits are absorbed, not punished.** The 4B sometimes escapes JSON arguments twice and copies path prefixes from the attachment note into code; `run_python` and the File System tools accept both (`python-tool.mjs`, `filesystem-mcp-provider.mjs`).
- **A loop inside one reply is cut off.** The 4B once answered with 58 calls in a single reply, all written before it had seen one result (40 documents with placeholder bodies among them). A reply now runs at most 10; the rest are answered, not run. Across every other saved run, no reply made more than 4.
- **A fixed tool list.** On a hybrid model like Ornith, any change to the tool list is a full prefill. A stable list with a searchable catalog keeps the prompt cache warm (0 miss turns).
- **Wording that small models read literally.** Ornith read several instructions too literally (asking for a rule in text, listing a folder twice and missing the file), and the system prompt, `ask_user` and `update_plan` descriptions were rewritten around those runs; each change cites the run in a comment.
- **Code and data files are text.** 103 "unsupported file type" errors on a small Node project in Ornith's runs led to code, config and data files being read as text.

## Known gaps

- `p1-two-unknowns` has not been run on the 4B, and no model has used `ask_user`'s several-question list yet.
- A background task that compacts its context has not been run against a real model (the compaction profile, "Ornith 9B · 12k", exists for it).
- `p4-git-log` and `p4-exit-code` are expected to fail on every model: Nest has no terminal. Their transcripts are read for whether the model says so or invents a result.
- None of this has been run on macOS or Linux, or on an AMD or Apple GPU.

## Running it yourself

From `redstart-nest/`, with Nest running and a model loaded:

```
node scripts/agent-bench/run.mjs --model-label "<model> <quant>" --repeat 3
```

The header of `scripts/agent-bench/run.mjs` lists every flag (`--plan`, `--retrieval`, `--runtime`, `--text-asks`, `--tasks`). Each run writes `runs.jsonl` and a summary under `scripts/agent-bench/results/`. Check that the account's capabilities are on before reading a pass rate: a task whose tool is off fails like a wrong answer.
