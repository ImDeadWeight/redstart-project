# Tool retrieval, second pass — the benchmarks

Written 2026-11-13, after Phases 0 to 6.2 landed (03b1d1b). Companion to
`tool-retrieval-fixes-implementation.md`. That file's "Held" table lists
every decision still waiting on a number. This file is the plan for getting
those numbers: which benchmark answers which held row, what has to be built
first, the order to run them in, and what a result has to show.

## Status (2026-11-13)

| Piece | Commit | State |
|---|---|---|
| H1 settings header, `--expect-retrieval` | 7856e5c | Built, tested on the fake Nest |
| H3 discovery metrics | b2d17f5 | Built |
| H2 `redstart_retrieval_withhold`, task `withhold` | 49bf410 | Built |
| H4 `followUps` | 3c78dee | Built |
| H5 cache-script discovery and compaction turns | d6669b9 | Built |
| H6 eval harvest | — | Not started: waits for B3's transcripts |
| H7 matrix runner | — | Not started: only if wanted |
| p5 and drift task files | — | Not written yet |
| B0 to B7 | — | Nothing has run on a model |

Deviations from the plan below, found while building:
- **H3:** call_tool's inner arguments are always checked against the catalog
  schema, when the call is logged (`innerArgsProblem`). That schema is what
  describe_tool returns, so the plan's two sources are one. The phrase cases
  for `unavailableWithoutSearch` live in `test-agent-bench.mjs`, not in
  `test-agent-bench-tasks.mjs`.
- **H3:** the "unavailable" phrases cover tools and abilities only. "returns.csv
  is not available" is a right answer on p1-plan-missing-input.
- **H2:** withhold is applied inside `selectTools`, not as a filter in front
  of it. Otherwise family expansion brings a withheld File System tool
  straight back when one of its siblings is selected.
- **H2:** on a fail-open turn (no embedder, an empty selection), every tool is
  sent, the withheld ones included. That follows the fail-open rule. The
  bench reads it correctly: turn 1 had the tool, so `discovered` is null.
- **H4:** one check per task, over the end state. The plan offered a check
  per follow-up. Add that only when a task needs it.
- **H5:** each variant of measure-tool-cache now has its own conversation id.
  Without one, a second run started from the first run's set, because the
  key hashed the same first message. Every earlier run of the script was
  the first, so no recorded number is affected.
- **H5:** the fake Nest has no selection memory, so "compaction keeps the
  set" is checked only live (B6 case 7).

The bars under each benchmark are **proposals**.
U1 to U6 belong to the user. A bar here is a starting point for that
decision, not a substitute for it.

## What each held row needs

| Held row | Decided by | Needs a model |
|---|---|---|
| 0.6 baseline | B0 | yes |
| `textVersion: 2` | B2 (the offline part first) | embedder only, then yes |
| 3.3 attachment prior | B1 | yes |
| U1 / U5 / 5.6: `growth: 'pins-only'` | B4, using B3's discovery rate | yes |
| U2: `minTools` | B5 | yes |
| U4: pin, call_tool or both | B3 | yes |
| 5.4 prompt wording | B3, the wording variant | yes |
| 6.3, 6.4 (D8 default) | B7, a roll-up of B0 to B5 | no (it reads earlier results) |
| Live test cases 1 to 8 | B6 | yes |

## Harness work first (H1 to H7)

The bench and the scripts can measure most of this today. Seven gaps stop
them measuring all of it. Each is small. Each is one commit through the usual
loop (typecheck, check:mjs, test:security; chat-ui vitest only if chat-ui
changes).

**H1. The report says which settings were in effect.** A sixth report
header, `x-redstart-retrieval-config`: for example
`scorer=fused;growth=scored;text=1;min=0;callTool=0`. Most of the variants
below are Nest settings, not request fields, so the operator changes them
between runs. Without this header a row's label is the only record of the
settings, and that is the "assumed from the flag" mistake 0.2 was written to
avoid. The bench stores it per turn. A run whose turns disagree is flagged in
the summary.
- New bench flag: `--expect-retrieval scorer=fused,growth=pins-only`. The
  bench stops before the first task if the first report disagrees. This
  catches a forgotten setting change before it costs an hour of 4B time.
- Tests (`test-gateway-routes.mjs`): the header matches the settings. It is
  present only when the report is asked for. It holds no tool names.

**H2. A way to leave a tool out of the first selection on purpose.** The p5
tasks need it, and so does B4. Without it, "the needed tool was not
selected" depends on how the scorer ranks one prompt, and that changes every
time the scorer changes. The proposed request field is
`redstart_retrieval_withhold: [names]`.
- A withheld tool is taken out of the scored selection **on every turn**. It
  stays in the catalog that search_tools and describe_tool search. It comes
  back through the normal pin paths (a search hit, describe, a tool call),
  and the origin header shows how (`:search`, `:describe`).
- It can only take tools away, so it is as safe to honour from any client as
  `redstart_retrieval: false`. A banned tool is still banned, and a withheld
  tool that is also banned stays out of search.
- It cannot withhold an always-pinned tool (the memory and discovery tools).
  The gateway ignores those names. The task loader refuses them, so a task
  cannot claim to test something it does not test.
- Under retrieval off it means nothing, so the bench refuses `withhold`
  tasks with `--retrieval off`. They are skipped and named in the summary.
- Task field: `"withhold": ["list_documents"]`.
- Tests: a withheld tool is never sent on a scored turn. It is sent the turn
  after a search hit. A withheld memory tool is still sent. A banned and
  withheld tool is not in search_tools' results.

**H3. Discovery metrics** in `computeMetrics`, per run:
- `searchCalls`, `describeCalls`, `callToolCalls`.
- `discovered`: a tool in `expectTools` that was **not** in turn 1's sent
  set was later called, either directly or through call_tool.
- `discoveryPath`: `pin` (called directly once it was sent) or `call_tool`.
- `turnsToDiscovery`: the turn of that call, minus 1.
- `unavailableWithoutSearch`: an assistant message says the thing cannot be
  done ("I don't have a tool", "I can't access", "not available", ...) and
  no search_tools or describe_tool call came before it. Judged by a fixed
  list of phrases. The list and its cases live in
  `test-agent-bench-tasks.mjs`: positive and negative sentences, as the
  checks are tested now.
- `callToolBadArgs`: call_tool calls whose inner arguments fail
  `argumentProblem` against the schema describe_tool returned. If describe
  was never called, the check uses the catalog schema and says so.
- `recovered`: the first tool was not in `expectTools`, but one of them was
  called later. This closes the Phase 0 gap "first tool as expected says
  nothing about recovery".
- `fsFirst`: the first tool came from the File System server, on a task
  with a workspace fixture. This is the P3 count as a named field. Today it
  has to be read out of `firstTool` by hand.

`retrievalSummary` totals all of these. Tests use the fake model in
`test-agent-bench.mjs`: one scripted run per metric.

**H4. Multi-turn tasks.** Task field `followUps: [string]`: user messages
sent after the model's final reply, in order. Each one is checked against
the check of its own turn (`followUps: [{ prompt, check?, expectTools? }]`).
B5 and B4 need a conversation whose topic moves, and every task today is a
single prompt. With `--text-asks answer`, a question still gets its answer
first, and then the next follow-up is sent.

**H5. The cache script learns discovery and compaction.**
`measure-tool-cache.mjs` gets two new scripted turns. They are fixed text,
like the rest of the script, so both variants still see the same chat.
- A **discovery turn**: a fixed assistant `search_tools` call, plus a tool
  result that names a withheld tool (H2). The next turn then pins that tool.
  This measures the one prefill a pin costs, which is U4's price for (a).
- A **compaction turn** (`--compact-at N`): the first user message is
  replaced with a summary, and the conversation id is kept. The tool set
  must not change (4.3, live case 7).
- The output adds `origin` per tool and `would_add` per turn.

**H6. A harvest step for the eval set.** `retrieval-eval/harvest.mjs <runs.jsonl...>`
pulls every search_tools query the models actually wrote, along with the
tool the run went on to use. They come out as **unlabelled** candidate cases
in `cases.candidates.json`. The user, or a session, labels them and moves
them into `cases.json`. 0.4 asked for small-model queries "from real 4B
transcripts where they exist". After B3, they will exist.

**H7. A matrix runner, maybe.** `scripts/agent-bench/matrix.mjs` would read
a list of `{ label, settings, flags }` rows, apply the settings through the
admin API, check H1's header, and run each row. **Build it only if B1 to B5
are run more than once by hand.** Until then, a written run order (below)
with `--expect-retrieval` does the same job, and it adds no code path that
can change Nest's settings.

## The benchmarks

The models are the same as in Phase 0.6: **the 4B** (Qwen3-4B-Instruct-2507
UD-Q4_K_XL) and **Ornith 1.5** (the hybrid one, where P2 costs the most).
The 35B is optional. It is the only model with old P3 numbers (8 of 22), so
one B1 run on it gives a true before and after.

`--repeat 3` unless a benchmark says otherwise. Single runs on the 4B have
swung by a whole task before.

### B0. Baseline (0.6)

**Question:** what retrieval does today, against no retrieval.
- The full task set, with `--retrieval server` and with `--retrieval off`,
  on the 4B and on Ornith. The settings are the current defaults (fused,
  scored, text 1, min 0, callTool off).
- `measure-tool-cache.mjs` on Ornith, variants `server,off`.
- `retrieval-eval/run.mjs` with the real embedder, all three scorers.
  Check this against the frozen numbers. A gap means the frozen vectors have
  drifted from what the sidecar produces.

**Note on "before":** the code from before the fixes is gone from this
branch's head. The closest stand-in is `scorer=cosine`, which is B1's other
arm. For a true before-number, run B0 once at 2fb93b7 (Phase 0 only). Do
that only if the user wants it in the results table. The 2026-11-11 rows
already give an older before.

**Records:** pass rate per group, `firstToolExpected`, `fsFirst`,
`toolSets`, `cacheMissTurns`, prefill ms, sent tokens. Ornith's cache table.

**Bar:** none. This is the reference everything else is compared with.

### B1. Scorer: cosine against fused (3.2 live, decides 3.3)

**Question:** does fused fix P3 in a real run, and not only on the eval's
proxy (2 of 36)?
- Arms: `scorer=cosine` and `scorer=fused`. Everything else at its default.
- Tasks: every task with a workspace fixture (the 22 attachment tasks), plus
  the guards p1-simple-stays-simple and docs-missing-file.
- Models: the 4B and Ornith. The 35B once, if time allows.

**Records:** `fsFirst` out of 22, `firstToolExpected`, `recovered`, pass
rate.

**Proposed bar:** fused has `fsFirst` ≤ 2 of 22 on both models, and the
pass rate does not drop. **If `fsFirst` is still above 2 on either model,
build 3.3's attachment prior and run B1 again with it.** Otherwise, record
3.3 as not needed, with these numbers.

### B2. Embedded text: version 1 against version 2

**Question:** does leaving out the attachment note, and adding the registry
metadata to the embedding, help?
- **Offline first:** `run.mjs --text-version 1` and `--text-version 2` with
  the real embedder, `scorer=fused`. This costs minutes and needs no chat
  model.
- **Live only if the offline run shows version 2 at least ties:** B1's task
  set with `text=2`, fused, on the 4B.

**Records:** offline MRR, R@3, selection recall and size, per source
(attachment cases separately). Live: `fsFirst` and `firstToolExpected`.

**Proposed bar:** version 2 is not worse than version 1 on any source, and
it is better on the attachment cases or on the small-model search cases.
**If it passes:** set the default to 2, run `run.mjs --freeze`, and say so in
the commit.

### B3. Discovery (5.5, decides U4 and the 5.4 wording)

**Question:** when the right tool was not sent, does the model find it and
use it? And by which path?

**New tasks, `p5-*`.** Each one reuses an existing task's prompt, fixtures
and check, and adds `withhold` (H2). The outcome is judged exactly as the
original is, so a p5 result can be compared with the same task un-withheld
in B0.

| task | based on | withholds | what it tests |
|---|---|---|---|
| p5-count-docs | multi-find-tool | list_documents | the plain case: search, find, call |
| p5-search-docs | docs-search | search_documents | an alternative path exists (run_python could grep). Is the right tool found anyway? |
| p5-exact-product | compute-arithmetic | run_python | with no tool, the model guesses. Does it search before it says "I can't" or does mental arithmetic? |
| p5-write-brief | docs-two-sources | create_document | a write tool through discovery |
| p5-vague-config | new, files-space fixture | read_text_file | the model has to search with poor words ("config"). This is where BM25 and widening should matter |
| p5-git-log | p4-git-log | run_command | a tool family the conversation has not touched |
| p5-delete-approval | p2-delete-confirmed | delete_file | call_tool refuses a tool that needs approval. The model must call it directly, and the approval card must appear (live case 5) |
| p5-guard-unneeded | compute-dates | list_documents | the guard: the withheld tool is not needed, so `searchCalls` should be 0. Reported, not a pass criterion |

**Arms** (run them in this order, so that one thing changes at a time):
1. `callTool=0`, the current 6b wording: the (a) path, today's behaviour.
2. `callTool=1`, the same wording: (a) and (b) are both available.
3. Only after 1 and 2: the next 6b wording, with `callTool` at whichever
   setting won. One wording change per run, as 5.4 requires.

**Models:** the 4B (Phase 5 is judged on it) and Ornith.

**Records:** `discovered`, `discoveryPath`, `turnsToDiscovery`,
`unavailableWithoutSearch`, `callToolBadArgs`, pass rate, prefill ms per
task. The guard's `searchCalls`.

**Proposed bar for U4:**
- Take (b), call_tool, only if it raises the discovery rate on the 4B **or**
  cuts Ornith's prefill ms on the p5 tasks, **and** `callToolBadArgs` stays
  under 1 in 10 call_tool calls.
- Otherwise take (a) alone, and leave `callTool` off.
- p5-delete-approval must pass in every arm. The refusal followed by a
  direct call has to work before call_tool can ship turned on.

**Proposed bar for U5** (feeds B4): a discovery rate of at least 70% on the
4B across the seven p5 tasks that need their tool (the guard does not
count), with `unavailableWithoutSearch` at 0 on Ornith. The user sets the
real number.

**After B3:** run H6's harvest on its runs.jsonl. Label the 4B's real
queries, add them to the eval, and refreeze.

### B4. Retention: scored against pins-only (4.1, decides U1, U5, 5.6)

**Question:** does freezing keep the cache warm, and what does it cost in
tools the model then has to find for itself?
- **Cache, scripted:** `measure-tool-cache.mjs` on Ornith with
  `growth=scored` and with `growth=pins-only`. Also run it with the H5
  discovery turn and the compaction turn.
- **Tasks, live:** the full set on Ornith with each growth setting. Then the
  p5 set with `pins-only` on the 4B and Ornith. Under a frozen set,
  discovery is the only way back in.
- **Drift tasks (H4):** three multi-turn tasks whose follow-ups need a tool
  family the first turn did not:
  - `p5-drift-docs-to-python`: read a document, then compute from it.
  - `p5-drift-python-to-memory`: compute, then "remember that result". The
    memory tools are pinned, so this is the control: it must pass under
    both growth settings.
  - `p5-drift-to-git`: summarise a file, then "and who last changed it?".

**Records:** per turn, `cache_n` and `prompt_n` against `off`. Per run,
`cacheMissTurns`, prefill ms, `toolSets`, `would_add`, pass rate,
`discovered`.

**Proposed bar** (this is 4.1's own measure, made exact):
- Under `pins-only`, every turn after the first has `cache_n` within 500
  tokens of the `off` variant, except the turn right after a discovery.
- `toolSets` is 1 on a run with no discovery.
- The pass rate is no lower than under `scored` on Ornith.
- The drift tasks pass at B3's discovery rate or better.

**If it passes, and B3 met U5's bar:** this supports flipping the default
(5.6). Before the flip, the client-tool gap has to be decided. A Twig `fs_*`
tool that misses the frozen first selection can never come back. That is a
product call, already in Gaps carried forward. B4 cannot measure it, because
the bench has no client tools.

### B5. minTools: 0 against 8 (decides U2)

**Question:** under a frozen set, does a larger first selection save
discovery turns?
- Run it under `growth=pins-only` only. Under `scored`, the eval already
  shows that 8 adds about one tool for no change in recall.
- Arms: `min=0` and `min=8`.
- Tasks: the three drift tasks, plus the p5 set without `withhold`. The
  question is whether the first turn's natural selection already covers the
  later turns.

**Records:** `searchCalls`, `turnsToDiscovery`, pass rate, sent tokens on
turn 1 (the price).

**Proposed bar:** take 8 if it cuts search calls on the drift tasks by half
or more, at a turn-1 cost under 1,500 tokens. Otherwise take 0.

### B6. The live checks (the impl doc's cases 1 to 8)

These are pass/fail checks, not rates. Each runs once, in chat-ui, with
retrieval on. Cases 5, 6 and 7 are also covered in a scripted form by B3
(p5-delete-approval), B4 and H5. The live run is the check that chat-ui's
own requests behave as the scripts do.

| # | check | evidence to keep |
|---|---|---|
| 1 | memory_save on an unrelated turn, then memory_forget through the approval card | the origin header shows the memory tools as pinned; a screenshot of the card |
| 2 | a CSV attachment, then "average the second column": the first call is not a File System tool. Run it with text 1 and with text 2 | the first tool, per version |
| 3 | vault_tags found through search_tools | the origin shows `vault_tags=N:search` |
| 4 | the same through describe_tool | the origin shows `:describe` |
| 5 | call_tool: a read tool answers; a write tool is refused, then called directly, and the card appears | the transcript |
| 6 | pins-only: a drifting conversation keeps `x-redstart-tools-sent` byte-identical | the header per turn; Ornith's cache_n |
| 7 | compaction keeps turn 1's origins | the origin header before and after |
| 8 | the embedder is stopped mid-chat: every tool is kept, and search answers `keyword` or `categories` | the headers, and the search reply |

Record each one in the implementation doc as **done, on what date, at what
commit**. Agent-runtime Phase 2's "approval path untested live" closes with
case 1.

### B7. The roll-up and D8 (6.3, 6.4)

This is not a new run. It is one table per model in
`agent-bench-results.md`, under "Tool retrieval, second pass", built from
B0 to B5 at the settings that won:
- From the eval set (B0, B2): recall@K and precision@K.
- From B3 and B4: the discovery rate.
- From B1: selection accuracy (`firstToolExpected`).
- From B0: latency (the eval's ms and the gateway's `tools_filtered` ms),
  context overhead (`sentTokens`), and task completion with retrieval on
  against off.

**D8 is the user's decision (U3).** The inputs it needs:
- Does retrieval-on pass as many tasks as retrieval-off, on both models?
- Is it cheaper in sent tokens and in prefill?
- Under the winning growth setting, does it keep the cache?

If all three are yes, the case for turning it on by default is made. The
rollout control then goes in its own commit, as 6.4 says.

## Run order

Each step needs the one before it.

1. **H1, H3** (the metrics have to exist before any run counts), then
   **H2, H4, H5**. H6 can wait until after B3. H7 only if it is wanted.
2. **B0** (both models, both modes) and **B2 offline**. B2 needs only the
   embedder, so it can run while B0's model is loading.
3. **B1.** Then 3.3 if B1 says so, then B1 again.
4. **B2 live**, if offline says so. Then the default flip and a refreeze.
5. **B3**, arms 1, 2 and then 3. Then H6, and a refreeze.
6. **B4.** Then **B5**.
7. **B6**, at the settings that won.
8. **B7**, and the user's U3 decision.

**Rough time,** at the 2026-11-12 run times (the 4B takes about 25 minutes
for the full set ×1, Ornith about 40):
- B0: about 6 hours over the two models.
- B1: about 2.5 hours.
- B3: about 3 hours.
- B4: about 4 hours.
- B5: about 1 hour.

That is about 17 hours of model time, most of it unattended. B2 offline and
the cache scripts take minutes.

## Gaps this plan leaves

- **Client tools (Twig `fs_*`) are not benchmarked.** The bench offers only
  Nest's MCP tools. A bench for them needs a fake client-tools list in the
  request, and a check that one is never lost under `pins-only`. That waits
  on the product decision in the implementation doc's Gaps carried forward.
- **`--runtime` is still out.** None of B1 to B5 can run as background
  tasks, because the daemon makes the requests and records no `wire` (an
  open Phase 0 gap). The runtime path's retrieval behaviour stays
  unmeasured until the task runner records it.
- **`unavailableWithoutSearch` is a phrase list.** It will miss wordings it
  does not know. Add every miss found while reading transcripts to its test
  cases.
- **Per-account usage history (U6) has no benchmark.** It stays deferred
  until the eval shows a need, as 3.3 says.
