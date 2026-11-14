# Tool retrieval, second pass — implementation plan

Written 2026-11-13, after PR #40 (feat/agent-core, alpha.14) merged. This
pass covers two things:

1. **The known faults** the agent runtime work found in retrieval: memory tools
   dropped, the prompt cache broken, the wrong store for attachments, no
   record of what was sent.
2. **The architecture agreed on 2026-11-11.** Retrieval becomes something the
   agent keeps doing during a task, not one step before inference. There are
   two problems to solve. **A, selection:** the model gets the right starting
   set without a lot of irrelevant tools. **B, discovery:** it can find, look
   up and use the tools it was not given. B is the one that matters most
   long-term. What the agent can do must not be limited by what fitted into
   its first tool list.

The first pass (`tool-retrieval-plan.md`, `tool-retrieval-implementation.md`,
D1 to D8) still stands unless this file says otherwise.
`agent-runtime-plan.md` row "2G tool discovery: Already built" is out of date.
This file is the plan for 2G now.

Branch: `feat/tool-retrieval-fixes`, from main @ 49941fa (alpha.14). Agent
runtime Phase 4 comes after it.

## Where we left off (2026-11-13, second session)

Phases 0 to 6.2 are in code, one commit per piece, each through the
verification loop: typecheck, check:mjs and test:security, 70 suites. Two
suites fail **only in the cloud container this was done in**, both before
and after these changes:
- `test-python-sandbox` needs Node 25 or newer, and the container had 22.
- `test-browse-routes` checks unreadable directories, which do not exist
  when everything runs as root.

The container could not reach Hugging Face either. So every number below
comes from the **frozen bge vectors** (frozen.json holds one for every case
query and every tool), and anything that changes the embedded text is
unmeasured and stays off.

| Step | Commit | What |
|---|---|---|
| 1.1 | 46a4a25 | The memory tools are always pinned when carried (`ALWAYS_PINNED_TOOL_NAMES`) |
| 1.2 | b3dbf4f | `stripAttachmentNote`, `conversationQueryText({ dropAttachmentNote })`. Behind a new setting, `textVersion` (default 1). Version 2 changes the embedded text |
| 2.1-2.3 | c577894 | `daemon/tool-metadata.mjs`: category, store, tags and useWhen for every built-in tool. Plugins can declare them under `_meta['redstart/retrieval']`. One builder for the views (`toolEmbeddingText` versioned, `toolSearchDocument`, `toolSearchResult`). The lint is `test-tool-metadata.mjs` (in test:security and CI) |
| 3.1, 3.2 | 9317385 | BM25 plus RRF (`rescore`), with a scorer setting (`cosine`, `bm25` or `fused`), each with its own floors. **Fused is the default**; refrozen |
| 4.1-4.3 | 75fe54a | `growth: 'scored' \| 'pins-only'` (default `'scored'`), `would_add`, `minTools` (default 0), and `redstart_conversation_id` (chat-ui and the task runner send it) |
| 5.1-5.4 | ee63f60 | search_tools widening (close, nearest, keyword, categories); `describe_tool`; `call_tool` (off unless `tools.retrieval.callTool`); an example call in block 6b; discovery tools never scored. **Fix:** search pins now resolve through `tool_call_id` |
| 6.1, 6.2 | 75c386d | `x-redstart-tools-origin` and `x-redstart-tools-would-add` in the report; the bench reads them; the Tools tab shows would-add |

### Measured (offline, frozen vectors, text version 1, 93 cases)

| scorer | MRR | R@1 | R@3 | R@10 | sel. recall | sel. size |
|---|---|---|---|---|---|---|
| cosine, before this session | 0.706 | 55.9% | 76.9% | 96.2% | 93.4% | 12.5 |
| cosine, now (pins: memory, discovery) | 0.713 | 57.0% | 76.9% | 98.9% | 98.4% | 17.4 |
| bm25 | 0.796 | 68.8% | 86.6% | 94.6% | 95.9% | 12.3 |
| **fused (default)** | **0.816** | **67.7%** | **91.9%** | **97.8%** | **100%** | **15.2** |

- Small-model search R@3 went from 88.2% to 100%.
- Fused misses only the three git-bundle transcripts (run_python at rank
  8 to 14), and cosine misses those too. The freeze holds 90 of 93 cases
  (it held 83).
- **The fused relative floor stays 0.85.** At 0.8, 16.2 tools are sent for
  the same recall; at 0.9, two cases are lost.
- **P3 proxy:** on attachment prompts, a File System tool ranks above every
  right tool in 2 of 36 cases (cosine: 6 of 36). The real P3 number is the
  bench's first-call count, which is still owed.
- **minTools:** 8 adds about one tool (15.2 to 16.2) for no change in
  recall. Its case is a frozen conversation's later turns, which only the
  bench shows.
- The selection size went up because the pins are always sent: three memory
  tools, search_tools and describe_tool.

### Held: needs a model, a real embedder or a decision

**The benchmarks for every row below are designed in
`tool-retrieval-fixes-benchmarks.md`** (B0 to B7, plus the harness work H1
to H7 that has to land first). That file holds the run order and the
proposed bars.

| What | Why held | To do |
|---|---|---|
| 0.6 baseline | Model | As before: the bench on the 4B and Ornith, with `--retrieval server` and `off`; `measure-tool-cache.mjs` on Ornith |
| `textVersion: 2` (1.2 + 2.2's metadata in the embedding) | Needs real embeddings; the frozen vectors only cover version 1 | `run.mjs --text-version 2` against version 1. If it wins: set the default to 2, then `run.mjs --freeze` |
| 3.3 attachment prior | Fused may already fix P3 (2 of 36 above) | Bench: "File System first on attachment tasks" (it was 35B 8/22, 4B 4/22). Build the prior only if it is still high |
| U1 / U5: `growth: 'pins-only'` default | Discovery rate | Bench with `growth: 'pins-only'`; cache numbers from `measure-tool-cache.mjs` |
| U2: `minTools` | Decision | See the numbers above |
| U4: pin (a), call_tool (b) or both | Decision, after 5.5 | Bench `multi-find-tool` plus new p5 tasks, with `callTool` off and on |
| 5.4 wording | Must be measured before the next wording change | The 4B's "said unavailable without searching" count, before and after |
| 6.3, 6.4 (D8 default) | Data | After the above |

### Test cases to run once a model is loaded

Live, in chat-ui, with retrieval on:
1. "Remember that my codename is Kestrel" on a turn about something else.
   memory_save is called. Then "forget it": memory_forget goes through the
   approval card (1.1). This also closes agent-runtime Phase 2's "approval
   path untested live".
2. Attach a CSV, then "average the second column". The first call is
   run_python or read_document, never a File System tool (P3). Compare
   `textVersion` 1 and 2.
3. Ask for something whose tool was not selected, e.g. "what tags are in my
   notes" when the vault tools are left out. The model calls search_tools,
   and the next turn's `x-redstart-tools-origin` shows `vault_tags=N:search`.
   This is the pin fix: before it, this never worked from chat-ui.
4. The same with describe_tool: `...=N:describe`.
5. With `tools.retrieval.callTool: true`: a read tool through call_tool
   answers in the same turn. A write tool through call_tool is refused and
   the model retries it directly the next turn. Check that the approval
   card appears for that direct call.
6. With `growth: 'pins-only'`: a long conversation that drifts topic keeps
   `x-redstart-tools-sent` byte-identical except on search/describe turns,
   and `would-add` goes above 0. Ornith's `cache_n` stays high (P2).
7. A conversation long enough to compact: `x-redstart-tools-origin` keeps
   the turn-1 entries after compaction (4.3).
8. Embedder stopped mid-chat: completions keep every tool, and search_tools
   answers `"match": "keyword"` or `"categories"`.

Bench runs (they feed the held rows above):
- The 4B and Ornith with `scorer: cosine` and `scorer: fused`: the first-tool
  hit rate, and "File System first" on attachment tasks.
- `growth: 'pins-only'` against `'scored'`: prefill ms, cache-miss turns,
  task completion.
- p5 tasks (to write): the needed tool deliberately left out of the first
  selection. Discovery rate with `callTool` off and on; invalid-argument
  calls through call_tool.

---

## The seven components: what exists (checked at 49941fa) and what is missing

| Component (2026-11-11) | Today | Missing |
|---|---|---|
| 1 Permission-aware filtering | Done. `enforceToolAllowList` runs before retrieval (D4); search_tools searches only the post-ban set (D5); a banned tool cannot come back as a pin | Nothing. Keep the tests |
| 2 Hybrid retrieval | Embeddings only (bge-small, cosine) | Keyword/BM25 search and a fused score |
| 3 Relevance ranking | Cosine score against the whole conversation; a relative floor (0.85 × best) | Context signals (where the data is: P3), past usefulness, tool metadata |
| 4 Token-budget-aware selection | Done. A quarter of `ctxSize`, measured on the wire, budgeted against a prompt built from the pins only | A minimum count for the first selection |
| 5 Stable tool retention | Monotonic per conversation (D1): pins from tool_calls and search_tools hits; an LRU of 200 by first-message hash | It grows on every turn (P2, breaks the cache); the memory tools can be dropped (P1); `previous` is lost on restart or eviction |
| 6 Dynamic discovery | `search_tools` returns `{ name, description }`; hits become pins on the next turn | `describe_tool` (the full schema); searching client tools |
| 7 Progressive fallback | When nothing matches, the reply says it searched only this server's tools | Widening the search step by step before giving up |
| Canonical metadata registry | Each provider has its own `tools-definitions.mjs` entries, plugin manifests and MCP-listed tools; the embedded text is name + description | Category, store, tags and "use when" fields that every tool shares, plus a lint |
| Retrieval diagnostics | `tools_filtered` counts and ms; the wire-cost readout; bge recall@1/@3/MRR measured once on 21 tools | The tools sent (P4); a standing labelled eval set; discovery rate; selection accuracy; the cache cost |

## The known faults

| # | Fault | Found in | Fixed in |
|---|---|---|---|
| P1 | Memory tools dropped on ordinary turns, so "remember this" cannot save; an offered memory_save without memory_forget leads the model to say it forgot | agent-runtime impl: Phase 2 test B (2026-11-12; f44aedb fixed half of it), Phase 8 click test (2026-11-13) | Phase 1 |
| P2 | Every time the tool list grows, the prompt changes ahead of the chat. On a hybrid model (Ornith) that means a full prefill: the D40 check measured 0 tokens reused, 5.5 s a turn at 8k context, over a minute at 100k | agent-runtime impl 8.4 "Gap"; tool-retrieval bench findings (the set swings from 2 to 35 tools) | Phase 4 |
| P3 | On attachment prompts the File System tools come first; they were the first call on 8 of 22 attachment tasks (35B) and 4 of 22 (4B). Part of the cause: chat-ui's attachment note sits inside the query and even names those tools | both docs, 2026-11-11 | Phases 1, 2 and 3 |
| P4 | Nobody can see which tools were sent, and the bench does not record whether retrieval was on | tool-retrieval bench findings; agent-runtime 0.3 | Phase 0 |
| P5 | search_tools is barely used (4B: 0 calls, 35B: 2) | tool-retrieval bench findings | Phase 5 |
| P6 | "Retrieval that fails open discloses nothing" fails sometimes, probably because it uses the real embedding port | tool-retrieval, "Found 2026-10-26" | Phase 0 |

## Two points that shape the design

**Who the small model leaves out.** Selection scores the user's words, not
the model's understanding, so a small model is no worse at selection. It falls
behind in two places. It writes poor search_tools queries ("config" when it
needs `read_text_file`). And it says "I can't" without searching. So keyword
search and widening the search on a miss (components 2 and 7) matter most in
**discovery**, where the query is the model's. Phase 5 is judged on the 4B for
that reason.

**Discovery against the cache.** Each discovered tool that joins `tools`
changes the prompt ahead of the chat, so it costs one full prefill on Ornith.
Discovery once in a while is fine. Discovery every few turns would bring P2
back. Phase 5 therefore measures a second option, which needs no change to the
tool list: `describe_tool` returns the schema in its result, and the model
calls the tool through `call_tool(name, arguments)`. That call goes through
`callToolAs` (agent-runtime 3.2), so policy, approvals and logging stay the
same. Whether small models can use a proxy call is not known. Phase 5 measures
it before anything depends on it (U4).

## Ground rules

The same as the earlier phases:
- One commit per coherent piece.
- Each commit passes `npm run typecheck && npm run check:mjs && npm run test:security`
  in `redstart-nest/`, and chat-ui vitest when chat-ui changes (run it from `E:\`).
- New suites go in `test:security` and in `ci.yml`.
- Gaps go in this file, and in `docs/security.md` → Known gaps when users can
  see them.

For this pass:
- **Measure before and after.** Each phase names the number it has to move.
- **Keep D1 to D8.** Bans first, fail open, the log stays counts-only, and
  retrieval off sends exactly the same bytes as before. The tests that check
  these must pass unchanged.
- **The order from 2026-11-11 stands:** registry → hybrid → budget and
  retention → discovery → diagnostics. One change: the measuring tools go
  first (Phase 0), because each later phase needs a before-number. The full
  diagnostics component, with reports, discovery rate and the D8 decision,
  stays last as Phase 6.

---

## Phase 0 — measurement first (P4, P6)

**0.1 A header with the tools sent, opt-in.** Body field
`redstart_retrieval_report: true`, removed before forwarding. Response headers
`x-redstart-tools-sent` (the names) and `x-redstart-tools-filtered: 0|1`.
- They go to the caller only, who already sent those tools. The support log
  stays counts-only.
- Where: `prepareCompletion` puts the names in `wire`, and `forwardModified`
  sets the headers.
- Tests (`test-gateway-routes.mjs`):
  - With the flag, the header lists exactly the forwarded tools.
  - Without the flag, there is no header.
  - The field never reaches llama-server.
  - A banned tool is never in the header.

**0.2 The bench records it.** For each turn, the agent bench stores:
- the names sent,
- `timings.cache_n`, `prompt_n` and `prompt_ms`,
- the first tool the model called, and whether the task's `expectTools` lists
  it (a new optional field in the task files).

Per task, the summary records:
- `retrieval: on|off`, plus a `--retrieval off` switch,
- the distinct tool sets seen,
- the turns with a cache miss,
- the total prefill ms.

Tests: `test-agent-bench.mjs` against the fake Nest.

**0.3 `scripts/measure-tool-cache.mjs`.** The same method as
`measure-memory-cache.mjs`: replay one multi-turn conversation through the
real gateway and record `cache_n`/`prompt_n` and the tool-set size per turn.

**0.4 The eval set: `scripts/retrieval-eval/`.** Labelled cases
`{ conversation, expected: [tool names], kind: 'selection' | 'search' }` over
the real catalog (all built-in tools enabled):
- the bge measurement's 21 queries,
- the bench tasks' first user messages, with `expectTools`,
- attachment cases,
- **search queries written the way a small model writes them** ("config file",
  "look at the repo"), taken from real 4B transcripts where they exist.

It reports recall@K, precision@K, MRR and latency per variant, and runs
against the real embedding sidecar. A small frozen subset with stored vectors
runs in CI (`test-retrieval-eval.mjs`), so a ranking change that drops a known
case fails the build.

**0.5 The flaky test (P6).** Point it at a port known to be closed, or inject
`embed`.

**0.6 Baseline (needs a loaded model).**
- The bench on the 4B and on Ornith, with retrieval on and with it off. This
  is the retrieval-off run owed since 2026-11-11.
- `measure-tool-cache.mjs` on Ornith.
- The eval set on the current scorer.
- Rows go in `agent-bench-results.md` under "Tool retrieval, second pass".

## Phase 1 — quick fixes (P1, half of P3)

They do not depend on the baseline. They ship first if the user wants them out.

**1.1 Memory tools are pins when the request carries them,** the same way
`HOST_RESOLVED_TOOL_NAMES` are. A pin never adds a tool the request did not
carry.
- Block 12's "you cannot save" line (236e74a) stays as the fallback.
- Tests:
  - On a turn whose query scores memory low, all three memory tools are kept.
  - A request with no memory tools gets none.
  - A banned memory_forget stays out.
- Live check: "remember that my codename is Kestrel", then "forget it" through
  the approval card. That also closes the agent-runtime Phase 2 item "the
  approval path is untested live".

**1.2 The attachment note is left out of the query.** `conversationQueryText`
drops it. `attachment-note.mjs` exports its opening marker, so the two cannot
drift apart.
- Test: a message with a note gives the same query text as the message
  without it.

## Phase 2 — the canonical metadata registry

**2.1 One shape for every tool's retrieval metadata:**
- `category` (documents, files, code, data, web, memory, git, …),
- `store` (where it acts: "the File System folder", "this chat's workspace",
  "the documents library", "a database"),
- `tags` (synonyms a user or a small model would use: "config", "settings",
  "spreadsheet"),
- `useWhen` (one line).

Built-in tools declare it next to their definition. Plugin manifests get
optional fields. MCP tools that declare nothing get a category from their
server name and no tags.

**2.2 One function builds every view of a tool:** `toolEmbeddingText`, the
BM25 document (Phase 3) and the search_tools result. The wire description
stays as it is unless a tool's own description is wrong.

**2.3 A lint (`test-tool-metadata.mjs`):** every built-in tool has a category
and a store, the tags have no duplicates, and the categories come from one
list.

**Measure:** the eval set before and after. The store field alone should
separate the File System tools from the workspace tools on the attachment
cases (P3). The content hashes change, so every tool is embedded again once.

## Phase 3 — hybrid retrieval and ranking

**3.1 BM25** in `tool-retrieval.mjs`. It is pure: an index over the 2.2
documents, rebuilt when the catalog's content hash changes. The tokenizer
lowercases and splits on `_` and `-`, so `read_text_file` matches "text file".

**3.2 Fusion:** reciprocal rank fusion of the cosine and BM25 rankings (rank
based, so the narrow bge band of 0.57 to 0.82 does not matter). The floors
then apply to the fused score.
- `relativeFloor` has to be measured again, because it was tuned for cosine.
- The variant is set per call, so the eval set can compare cosine-only,
  BM25-only and fused.

**3.3 Context priors,** small additive terms, each tested on its own:
- An attachment in the conversation: the workspace tools go up, and the File
  System family goes down (the rest of P3, if Phases 1.2 and 2 did not already
  fix it).
- Earlier successful calls by this account: **deferred** until the eval shows
  a need. It needs a stored per-account record, which is a privacy question
  for the user (counts only, local).

**Measure:** on the eval set, the fused variant has to beat cosine-only on
recall@K for the small-model search queries without losing on the selection
cases. On the bench, the "File System first on attachment tasks" count (35B
8/22, 4B 4/22) has to fall.

## Phase 4 — budget and stable retention (P2)

**4.1 Freeze after the first selection.** A new `selectTools` option,
`growth: 'pins-only' | 'scored'`. With `previous` and `'pins-only'`, the
result is `previous` ∪ the pins the request carries, filtered to the tools the
request carries. Removing a tool that has since been banned or dropped by the
client is correct.
- Scoring still runs and logs `would_add: <count>`, so the cost of freezing
  stays visible.
- **Lands with `'scored'` as the default.** It flips to `'pins-only'` in Phase
  5, once discovery can bring back what freezing leaves out.
- Tests:
  - A frozen set stays byte-identical while the query drifts.
  - A search hit is added.
  - A tool the request no longer carries is removed.

**4.2 A minimum for the first selection.** `minTools` (U2, proposed 8, inside
the budget, by fused score), so a frozen set does not start at 2 to 5 tools,
the size the bench saw on 21 requests.

**4.3 Keep `previous` stable.** Check whether compaction or an edit to the
first message changes the first user message the gateway sees. If it does, key
on a conversation id when completions carry one, and fall back to the hash. A
restart selects again once (accepted: the llama-server cache is usually cold
then anyway).

**Measure:** `measure-tool-cache.mjs` on Ornith with `'pins-only'`. After the
first turn, `cache_n` stays within a few hundred tokens of retrieval-off,
except on a turn where a discovered tool is added.

## Phase 5 — dynamic discovery and progressive fallback (P5)

This is the main phase (problem B).

**5.1 search_tools uses the hybrid scorer** and returns
`{ name, category, store, description }`. It still searches only the post-ban
set (D5).

**5.2 `describe_tool(name)`** returns the full schema of a post-ban tool, and
the tool becomes a pin. For a banned or unknown name it returns the same "not
found" text, so a ban does not leak.

**5.3 Widening the search (component 7).** search_tools steps down until
something matches:
1. the hybrid search with the floors,
2. no floors, top results,
3. BM25 alone on the name and tags,
4. the list of categories, each with its tool names.

The reply says which step answered it. Only when step 4 shows nothing that
fits does the reply say there is no such tool on this server, and it names the
client-tool gap below.

**5.4 Prompt block 6b:** "this list is a selection; search before you say
something is unavailable", with one example call. One wording change at a
time, measured.

**5.5 Measure the two ways to add a tool (U4).**
- (a) The discovered tool joins `tools` on the next turn (pins, today's
  mechanism). Costs one prefill.
- (b) `call_tool(name, arguments)` through `callToolAs`, with the schema from
  describe_tool. No cost to the cache.

Bench tasks: `multi-find-tool` plus new p5 tasks where the needed tool is
deliberately left out of the first selection. Measure the discovery rate (the
task found and used the tool), the turns, the prefill ms, and invalid-argument
calls through (b), on the 4B and Ornith. The user picks (a), (b) or both.

**5.6 Flip 4.1 to `'pins-only'`** once the discovery rate is acceptable (U5:
the user sets the bar after the baseline).

**Measure:** discovery rate, and the 4B's "said unavailable without searching"
count, from the Phase 0 traces.

## Phase 6 — diagnostics and evaluation

**6.1 A per-conversation retrieval record,** only for the caller (the 0.1
header, extended): which turn each tool came in, and why (first selection,
pin, search, describe).

**6.2 The Tools tab readout** adds the last request's sent count against the
offered count, `would_add`, and the cache cost. The log stays counts-only.

**6.3 The full metrics roll-up**, one table in `agent-bench-results.md` per
model:
- recall@K and precision@K (eval set),
- discovery rate and selection accuracy (bench),
- latency (`ms`),
- context overhead (`sentTokens`),
- task completion with retrieval on and off.

**6.4 The D8 decision (U3).** With 6.3 in hand, the user decides whether
`tools.retrieval.enabled` defaults to on. If it does, the rollout control is
removed in its own commit, along with updates to `docs/configuration.md` and
`docs/security.md`.

---

## Order of commits

1. 0.5 the flaky test
2. 0.1 the header
3. 0.2 the bench records
4. 0.3 the cache script
5. 0.4 the eval set
6. **The user runs the 0.6 baseline**
7. 1.1, 1.2 (these can also go before step 6)
8. 2.1 to 2.3, then measure
9. 3.1, 3.2, then measure, then 3.3
10. 4.1 to 4.3 (growth stays `'scored'`), then measure the cache with
    `'pins-only'`
11. 5.1 to 5.4, then 5.5 measured, then 5.6
12. Phase 6

## Decisions the user owns

- **U1** (taken in principle on 2026-11-11: retrieval keeps running during the
  task): freezing plus discovery (Phase 4 to 5) instead of growing by score.
  To confirm before 4.1.
- **U2:** `minTools`.
- **U3:** the default for D8.
- **U4:** how a discovered tool gets added: a pin (a), `call_tool` (b), or both.
- **U5:** the discovery-rate bar for freezing.
- **U6:** whether per-account usage history is used for ranking (3.3).

## Deviations from the design

- The measuring tools come before the registry, against the 2026-11-11 order
  (see the ground rules). Diagnostics as a component stays last.
- **0.1 has a third header, `x-redstart-retrieval: on|off`** (added in 0.2).
  `filtered: 0` cannot tell "retrieval kept everything" (or failed open) from
  "retrieval off", and the bench summary needs on/off. Taken from
  `wire.filtered`, which the gateway already computed.
- **0.2's bench switch is `--retrieval server|off`**, not just `off`: `server`
  is "as Nest is configured". What happened is read back from the report,
  never assumed from the flag.
- **0.4's "the bge measurement's 21 queries" no longer exist.** The first pass
  committed only the results (embed-model.mjs), so the user-phrasing cases are
  new.
- **0.4's frozen.json holds every case's query vector** (292 KB), not only the
  frozen subset's, so a phase can see which misses it fixed without a model.
- **The eval budgets selection at a 32k window and reserves the messages plus
  a fixed 2,000 tokens for the system prompt** (lib.mjs). The gateway reserves
  a composed pins-only prompt, which the eval has no composer for.

- **1.2 and the embedding half of 2.2 ship behind `textVersion`**, default 1,
  because they change the embedded text and could not be measured here.
- **2.1's metadata lives in one name-keyed table** (`tool-metadata.mjs`), not
  beside each definition. The gateway only ever sees the client's OpenAI tool
  list, so a lookup has to go by name anyway, and the File System tools come
  from a server Redstart does not write.
- **The discovery tools are never embedded or scored** (5.x). They are always
  pinned, and their scores only moved the relative floor. This also lets
  describe_tool and call_tool land without a refreeze.
- **search_tools is always pinned** (in 3.2, ahead of Phase 5): fused dropped
  it in the gateway test.
- **Fused with an embedder that scores nothing above 0 fails open**, as cosine
  does. Keywords alone are the `bm25` scorer, chosen explicitly.
- **search_tools' reply is now an object** (`{ match, note?, tools }` or
  `{ match: 'categories', categories }`). pinsFromMessages reads `tools`; a
  categories reply pins nothing.
- **call_tool refuses any tool that needs approval**, not only the
  destructive ones. Chat-ui asks the user by the name it sees, which would be
  call_tool.
- **6.2 shows no cache cost**: the gateway never sees timings.

## Gaps carried forward

- **Already open, more important now:** search_tools and describe_tool cannot
  see a client app's own tools (Twig's `fs_*`). With a frozen set, a client
  tool left out of the first selection can never come back. Possible fix: pin
  every request tool that is not in Nest's catalog (the product trade the
  first pass recorded and did not take). Ask the user before 5.6.
- **Accepted (4.3):** a Nest restart selects each conversation again once.
- **Phase 0, open:** `measure-tool-cache.mjs` has never run on a model; only
  its plumbing is tested (against the bench's fake Nest). The first Ornith run
  is the first real check.
- **Phase 0, open:** the bench's retrieval metrics are null under `--runtime`
  (the daemon makes the completions requests, so there is no report), and
  `--retrieval off` is refused there. Closing it means the task runner
  recording `wire` per turn into its events.
- **Phase 0, open:** "first tool as expected" judges the first call only. A
  run that starts with a File System call and recovers still counts as wrong,
  which is the P3 count, but it says nothing about recovery.
- **Every later phase:** rerun `retrieval-eval/run.mjs --freeze` when it moves
  cases into passing, or changes catalog.json or the embedded text (Phase 2
  does), and say so in the commit.
- **Not in this pass:** mid-generation context exhaustion, and persisting the
  embedding cache (both open from the first pass).
- **Found 2026-11-13, fixed in ee63f60:** search_tools pins never fired from
  chat-ui or the task runner, because their tool messages carry no `name`.
  Every earlier bench number on search_tools (P5: the 4B made 0 calls, the 35B
  made 2) was measured without the pin. Read them with that in mind.
- **Open:** a Twig `fs_*` tool still cannot be found again by search or
  describe (the client-tool gap above). Ask before 5.6.
- **Open:** plugin retrieval metadata is read from plugins.json on each lookup,
  as pluginCapabilities is. That is fine at today's plugin counts; cache it if
  that changes.
