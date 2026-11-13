# Agent capability and runtime — implementation record

The design and its reasons are in `agent-runtime-plan.md`. This file records
what was built, phase by phase: deviations from the plan, and gaps carried
forward. Branch: `feat/agent-core`, from main @ 224d121 (alpha.12, PR #38
merged).

## Where we left off (2026-11-13: Phase 8: 8.0, 8.1, the v1 baseline and 8.2 done; next: the v2 bench runs)

Phase 3 → "Acceptance" has the closing record; "What landed" the per-module
notes and the gaps carried out. Phase 2 closed, pushed at bc78774.

**Phase 8 (memory that learns from the work) was planned 2026-11-12**, plan
section 9. Not started. Its slot is decision U7 (recommended: after Phase 3
closes, before Phase 4). 8.0, the memory bench, needs no decision. This file
and the plan are now tracked in git (the only two in `docs/notes/`; see
`.gitignore`), so both can be edited away from the main machine.

**State.** Phases 0.1 to 0.4 and Phase 1 (ask_user, update_plan) are built
and pushed to `origin/feat/agent-core`. No PR yet. Phase 1's two measurement
steps are half done: the `--plan off` rows exist (4B T21-53-45 62%, 35B
T22-14-31 86%; both scored before the a6f864f check fixes, so rerun or
rescore before comparing). Details in Phase 1 below: "What landed",
"Deviations", "The first Phase 1 runs", "Gaps carried forward".

**How to run things** (the user's machine):
- `npm run dev` in `redstart-nest/` runs this checkout's daemon against the
  real data folders. Quit the installed Nest first. The chat page is the
  BUILT copy: run `npm run build:chat` after chat-ui changes, then hard
  refresh (dev-shell warns when it is stale).
- Bench: `node scripts/agent-bench/run.mjs --model-label "<model> <plan mode>" --plan off|tool|full`
  with `REDSTART_BENCH_API_KEY` set. Put the plan mode in the label (the
  results row does not carry it).
- Probe: `node scripts/agent-bench/probe-ask.mjs [--n 5] [--think]` against
  whatever model is loaded.

**The Phase 1 task group was revised (2026-11-11, after the first runs):**
p1-ambiguous-units, p1-which-draft, p1-assume-on-skip and p1-plan-per-city
were removed (a model could pass or fail them for the wrong reason; the
reasons are in `scripts/agent-bench/tasks/README.md`). Added: p1-sign-off-name
and p1-standard-discount (the fact is in no file, so passing means asking),
p1-skip-no-invent (a skipped question must not become an invented name),
p1-resolved-in-file (a guard: the file settles it), p1-plan-eight-deliverables
and p1-plan-missing-input. 31 tasks, 11 in Phase 1. The earlier `--plan off`
rows do not cover the new tasks: they are the baseline nobody has yet.
`--text-asks answer` now exists (default `end`, unchanged): the bench answers
a question asked in reply text and counts it; the summary reports tool and
text asks separately. That settles the open question by measuring both
instead of choosing.

**The first runs of the revised set (2026-11-12, at 72314bd) found bench
faults, fixed the same day; their Phase 1 numbers do not count.** Four
`--plan off` runs: Ornith-1.5-9B Q6_K (71%; text-asks 68%), Qwen3-4B (52%;
text-asks 68%), Qwen3.6-35B (77%; its text-asks run was not done). What the
logs showed:
- **Every question got the task's one answer.** The 35B called ask_user on
  p1-sign-off-name and got "Priya Natarajan", then asked "vault or
  documents folder?" three times and got the name each time. Answers are now
  keyed by topic (only p1-stop-and-report keeps a catch-all).
- **The two note tasks had no fixture**, so no attachment note told the model
  where files go: the 35B and Ornith spent 30 turns on web_search and
  search_tools looking for somewhere to save thanks.md. Both now attach a
  volunteer list.
- **"Sign it with my name" was guessable:** the account is called bench, and
  the 35B signed "bench". Now "my full name".
- **memory_save leaked across runs:** p1-skip-no-invent's memory_search found
  an earlier run's "Wrote thank-you note to school bake sale volunteers".
  Each run now deletes the memories it saved (logged as `memories_saved`);
  the run warns when the account already holds some. **The bench account has
  at least one such memory now: delete it in chat Settings → Memory.**
- **A stopped bench's conversation stays searchable** (search_documents found
  a leftover chats/bench-compute-chart-…/sales.csv). Leftover `bench-*`
  conversations are deleted at the start of a run.
- **Checks refused right answers:** docs-missing-file and p1-plan-missing-input
  read only the last message (now every assistant message, as a chat shows
  them); "There is **no `x.xlsx`**" (bold) and "isn't attached" missed; "I
  still need returns.csv ... once you provide it" missed; the manifest had to
  list run_python's auto-saved fig-1.png, which a manifest written in the
  same cell cannot know about.
- **Real model results, kept:** p1-pick-vendors failed on all three (none
  asked; all did the three contracts). The 35B's p1-stop-and-report wrote
  inventory.csv with write_file, to the File System folder, after read_file
  had said that folder is not the workspace (the check now names it). The
  35B and Ornith did ask on p1-answer-steers; the 35B on
  p1-standard-discount. Repeated ask_user after a dismissal (up to 30 turns
  on p1-skip-no-invent) was mostly the save-location confusion; if it
  persists after the fixes, it is a runtime question (a guard that answers a
  repeated, dismissed question at once), not a bench one.

**Phase 1 acceptance, revised 2026-11-12 (agreed with the user).** The
plan's wording named four tasks since replaced and a noise number never
measured, and the Phase 1 failures that persist are model judgement (not
asking, asking in text, an invented name), which the runtime cannot force.
Phase 1 closes when:
1. **The mechanism works end to end:** the unit tests, and one model asking
   through the tool and passing. Met: the 35B passes sign-off-name,
   standard-discount and answer-steers through ask_user.
2. **The guards hold on every model:** resolved-in-file and
   simple-stays-simple. Met on the 35B, 4B and Ornith.
3. **No regression on the 20 non-Phase-1 tasks** against the pre-Phase-1
   rows, with the noise from one `--repeat 3` run (the 4B: owed since 0.3).
4. **update_plan does not lower the 4B's pass rate** (`--plan off|tool|full`
   on the Phase 1 group); if it does, a per-profile switch, as the plan says.
Model judgement is recorded per model in agent-bench-results.md as a
capability profile, not gated. `--text-asks answer` is the score compared
(a chat user sees a text question); tool asks are the second number.
Candidates found on the way, not gated: create_document takes a filename
(Ornith named the note from its title and said it saved thanks.md); a
missing-fact line for ask_user (pick-vendors fails on every model).

**PHASE 1 CLOSED (2026-11-12, at 31741da).** All four acceptance items
above are met:
1. Mechanism: the 35B passes sign-off-name, standard-discount and
   answer-steers through ask_user.
2. Guards: resolved-in-file and simple-stays-simple pass on the 35B, the 4B
   (9/9 plan off, 3/3 plan full) and Ornith.
3. No regression: the 4B's 20 non-Phase-1 tasks 43/60 (72%), three repeats
   at `--plan full`, against 40/60 (67%) over its three pre-Phase-1 rows;
   no task down beyond the noise (two identical plan-off runs: the same
   total, single tasks swinging two in three).
4. update_plan: on the 4B's three planning tasks, off 8/18, tool alone 3/9,
   full 7/9. The tail note helps and the tool alone hurt, so `--plan full`
   (what chat-ui ships) stays for every model, with no per-profile switch.
   Cost: turns per Phase 1 task about double (3.3 to 6.5), and five-steps
   can still run to the 30-turn limit.
Numbers and per-run notes: agent-bench-results.md, 2026-11-12.

**Carried out of Phase 1, not gated:**
- **The chat UI with a real model:** the question card and the plan
  checklist have never been clicked (the earlier chat test ran a stale
  dist). Do it before the PR.
- **Model judgement, per model:** pick-vendors fails on all three (nobody
  asks which contracts "I care about"); the 4B almost never asks (1 ask_user
  call in 66 plan-off runs); Ornith asks in text and invented a name
  ("Jamie Chen"); the 35B and 4B write workspace files with the File System
  tools. Two candidate fixes, each to be measured with probe-ask.mjs and the
  Phase 1 group before shipping: a missing-fact line for ask_user, and a
  line saying where a new file goes when nothing is attached.
- **create_document takes no filename:** a model told "save it as thanks.md"
  that titles the note "Thank-you note" makes thank-you-note.md (every 4B
  and Ornith run). Give it an optional filename.
- **A skipped question invites an assumption:** "say what you assumed" led
  the 35B and the 4B to make net.csv with returns assumed zero. Consider
  "do not make up data a missing file would have given".
- **A repeated, dismissed question:** none since the bench fixes; a runtime
  guard only if it comes back.
- The 4B through probe-ask.mjs was not run; the bench rows answer the same
  question.

**PHASE 2 CLOSED (2026-11-12, pushed at bc78774).** The user confirmed the
remaining checks ("this all works"): the approval exchange live for
delete_file and memory_forget (approve, deny, a third delete after a deny),
"Always allow" from the card and across browsers, the Activity tab, and the
bench task. Acceptance (plan section 5's tests): the digest binding, expiry,
single use, cross-account refusal, auth-off scope, role narrowing before an
approval, and the import are all in test-approvals.mjs; the client half in
chat-ui approvals.test.ts; the bench handshake in test-agent-bench.mjs.

Built in Phase 2 (all on origin/feat/agent-core):
- f3054d4 rule, ledger, grants; be40442 decision log + owner methods;
  4d1d950 enforcement, routes, chat-ui and bench handshakes, security.md.
- From the live tests: 2d492e2 diagnostics and refusal text; d22e365
  unknown MCP session is a 404; a9e4bf2/d8e224b card denials logged and a
  clearer denial text; f44aedb memory tools kept together by retrieval;
  ce7d548 no completion nudge on a question; 54690fd code blocks scroll;
  8181684 the prompt stops telling the model to confirm in chat; 9afbcfa an
  unchanged update_plan says so and the plan note stops asking for updates;
  bc78774 Always allow works for read tools.
- 0b11ca8 the launcher Activity tab; 63a283d p2-delete-confirmed.

Carried out of Phase 2, not gated:
- Yellowscript's handshake (deferred by the user; security.md Known gaps).
- Grant scope stays null until run_command (Phase 4).
- An approval is bound to the arguments, not the disk state (security.md).
- Model behaviour seen live: Ornith said it had removed files it had not
  (documents created by mistake), and invented a user message; the 35B and
  Ornith sometimes reach for create_document when asked for the File System
  folder. Recorded, not fixed.
- Memory saves are deduplicated only on exact text.

**Next:** Phase 3 is planned to module level below ("Phase 3 — the daemon-side task runtime"); decisions U-a/U-b/U-c taken (approval for writes, in-chat UI, hand-off later). Build it, slice 1 first (the two extractions). Was: re-plan Phase 3 (the daemon-side task runtime, plan section 5) to
module level below Phase 2, then build it.

The Phase 2 history, kept for reference:
**Phase 2 in progress (2026-11-12), pushed to origin/feat/agent-core at 54690fd:**
- f3054d4: the approval rule, the ledger, standing grants, the shared wire
  names (2.1-2.3, 2.7).
- be40442: the decision log (logPolicy, policy.jsonl) and the owner's
  control-plane methods audit:list, approvals:list-grants,
  approvals:revoke-grant (2.6).
- 4d1d950: enforcement at tools/call, the gateway routes, chat-ui's
  handshake and server-side "Always allow" with the one-time import, the
  bench's handshake, security.md (2.4, 2.5, 2.8-2.10). Chat page rebuilt.

**Still to do for Phase 2:**
1. **DONE 2026-11-12: tried in the running app** (results in 4b-4d; delete_file and memory_forget approved through the card, Deny kept the file). Still unchecked: "Always allow" set on a card (prompt C was pre-empted by the import) and seen from a second browser; the third delete after a Deny with the new DENIED_RESULT. Original item: enable File System deletes for
   an account, ask the model to delete a file, approve the card, check the
   file is in the recycle bin; deny one and check it stays. Also check
   Settings → Tools "Always allow" for a write tool survives a different
   browser. Restart Nest on this build first.
2. **BUILT 63a283d (local): p2-delete-confirmed.** Not run on a real model yet: needs Tools -> File System -> Allow destructive operations on (run.mjs warns otherwise); run with `--tasks "scripts/agent-bench/tasks/p2-*.json"`. Original item: a bench task that needs a confirmed delete (p2-delete-confirmed),
   once the bench account can be given allowDestructive; the harness test
   already covers the handshake against the fake Nest.
3. **Yellowscript's handshake: DEFERRED by the user (2026-11-12), not part
   of Phase 2.** Until then Nest refuses its destructive calls (security.md,
   Known gaps). When picked up: its loop's approval gate answers Nest's
   pending approval (shared/agent-core/approval.mjs has the wire names).
4. **BUILT 0b11ca8 (local; the user chose to keep it in Phase 2): the launcher Activity tab** (decision log with paging; one account's standing grants with Revoke). Not opened in the running launcher yet. Original item: a launcher panel for the decision log (the route exists).
4a. **Card denials are not in the decision log** (found in the live test,
   2026-11-12): chat-ui's gate stops a denied call, so it never reaches Nest.
   Fix: on a Deny for an enforced Nest tool, chat-ui posts it (a small
   `POST /approvals/denied { tool }` that only logs). security.md says so
   in Known gaps until then.
4b. **Live test results (2026-11-12, Ornith-1.5):** the handshake works
   (approval_needed, decided once, delete to the Recycle Bin, test-b kept on
   Deny), and the one-time import ran. Found and fixed: 2d492e2 (diagnostics,
   and the refusal text no longer invites ask_user), d22e365 (unknown MCP
   session is a 404, so an open page reconnects after a Nest restart).
   Model: after a Deny, Ornith skipped the third delete and said test-b was
   "recoverable from the Recycle Bin"; DENIED_RESULT ("denied by the user")
   says nothing about the rest of the task.
4c. **Live tests B-D (2026-11-12, Ornith-1.5):**
   - D (plan + ask + approve): worked end to end. Plan made and closed,
     ask_user twice, a confirming ask before a two-file delete, the approved
     delete of test-c.txt went to the Recycle Bin (decided once, audit line).
     One wrinkle: the model asked the rule in reply TEXT first; the
     completion nudge then fired on a reply that was waiting for the user
     (it recovered by calling ask_user). Candidate: no completion nudge when
     the reply ends in a question.
   - B (memory): memory_forget was not offered. Tool retrieval sent 21 of 51
     tools and dropped it; the model said there was "no explicit memory
     delete tool", then told the user it had "dropped" the codename while the
     memory stayed saved. Not a Phase 2 fault (it predates enforcement), but
     it means memory_forget's approval path is untested live. Candidates:
     pin the memory tools together in retrieval (or pin memory_forget when
     the user says forget), and a prompt line that a memory is removed only
     by memory_forget.
   - C (always allow): no card at all, because the one-time import had
     already turned create_document (and seven other write tools from the
     old localStorage list) into server grants. To test the card's Always
     allow: revoke create_document in Settings, then rerun.
4d. **Fixes from tests B-D (2026-11-12):** f44aedb memory tools kept
   together by retrieval (families in selectTools); ce7d548 no completion
   nudge on a reply ending in a question (endsInQuestion moved into the
   core); d8e224b card denials logged (POST /approvals/denied, enforced
   tools only) and DENIED_RESULT says carry on with the rest and say what
   was not done; 54690fd code blocks scroll inside their box (the update_plan
   arguments ran over the Result). The card-denial gap (4a) is closed.
   Next live checks: rerun prompt B (memory_forget's approval, now that the
   tool is offered) and prompt A (the third delete after a Deny).
4e. **8181684 (pushed):** the system prompt no longer tells the model to
   confirm destructive calls in chat ("the app asks them on each call, so do
   not ask in the chat as well"). Pushed through 8181684.
4f. **To close Phase 2:** the user's two app checks (prompt C after
   revoking create_document: Always allow from the card, then seen in a
   second browser; prompt A: the third delete after a Deny), a look at the
   Activity tab, and one bench run of p2-delete-confirmed on the 35B.
5. Close Phase 2 (acceptance: plan section 5's tests, all present), then
   re-plan Phase 3 (the daemon-side task runtime) to module level.

**Not done and known:** a stale plan keeps steering a chat until cleared (in
security.md); forks drop the plan; the daemon runtime has no ask/plan ports
(Phase 3).

---

## Phase 0.1 — extract the core (landed 2026-11-10)

### What was built

- `shared/agent-core/`
  - `loop.mjs`: `runAgentLoop({ messages, maxTurns, ports, callbacks, signal })`,
    the `while` loop that was `executeAgenticLoop`, and `createTurnAccumulator`.
  - `tool-calls.mjs`: `runToolCalls` (the body of chat-ui's old
    `AgenticToolExec.runToolCalls`) with the `'done' | 'stopped'` sentinel
    contract and its header, `normalizeToolCalls`, `isAbortError`, and the
    denied / interrupted result strings.
  - `timings.mjs`: `buildFinalTimings` (moved), plus `createAgenticTimings`,
    `createTurnStats`, `foldTurnTimings`.
  - `types.d.ts`: messages, timings, `AgentPorts<A>`, `AgentStoreCallbacks<A>`,
    `AgentLoopParams<A>`. Structural, so chat-ui's own types pass through with
    no casts (svelte-check confirms: the store passes `AgenticFlowCallbacks`
    straight in).
  - `host-globals.d.ts`: the only globals the core may use (`setTimeout`,
    `performance.now`, `AbortSignal.aborted`, `DOMException`).
- chat-ui is the first host:
  - `src/lib/agent-core.ts` re-exports the core, so the long relative path
    (`../../../../../shared/agent-core/…`) lives in one place.
  - `stores/agentic.svelte.ts`: `executeAgenticLoop` keeps its name and
    parameters (the vitest file drives it by name) and now only builds ports
    and calls `runAgentLoop`.
  - `stores/agentic/agentic-tool-exec.ts`: now the `gate` and `tools` ports
    (`ports(conversationId, effectiveModel)`): permission card, the four
    executors, base64 attachment extraction, vision parts.
  - `stores/agentic/agentic-turn.ts`: the `model` port; fills the core's
    accumulator. The timings fold moved out into the core.
  - `stores/agentic/agentic-timings.ts`: re-exports the core's
    `buildFinalTimings` with chat-ui's types.
  - `vite.config.ts`: the repo's `shared/` added to `server.fs.allow`.
- Nest side:
  - `scripts/test-agent-core.mjs` (25 tests): every exit path the vitest file
    pins, plus deny, tool error, tool AbortError, `isError` results, steering
    mid-tools, call order, timings, the turn limit both ways, attachments,
    progress, normalisation, and a static check that the core imports only
    `./` files and touches no `window` / `document` / `localStorage` /
    `process`. In `test:security` and `ci.yml`.
  - `tsconfig.agent-core.json`, run by `npm run typecheck`: `checkJs` +
    `strict` over the core with `lib: ES2022`, `types: []`. chat-ui has
    `checkJs` off, so this is the only check of the core's bodies.
  - `check-mjs.mjs` covers `../shared/agent-core`.
  - `test-packaging.mjs`: pins that `shared/` is staged recursively.
- `docs/architecture.md`: one sentence on where the loop lives.

### Verification

- chat-ui unit suite (`npm --prefix src/chat-ui run test:unit -- --run`):
  762/762, with `agentic-loop`, `agentic-pure`, `agentic-sections` and
  `agentic-strip` **unchanged**. A planted mutant in `shared/agent-core/loop.mjs`
  (dropping `capturedTimings = acc.captured`) failed "carries timings captured
  in an earlier turn" through the browser host, so the vitest file really
  exercises the shared core.
- `test-agent-core.mjs`: three planted mutants (no steering skip, gate
  ignored, `'stopped'` sentinel ignored) each fail it.
- svelte-check 0 errors (`check:baseline` matches); `npm run build:chat`
  bundles the core; `typecheck`, `check:mjs`, `test:security` all pass.
- `vite dev`: the core is served at `/@fs/…/shared/agent-core/loop.mjs` with
  200; with the new `fs.allow` entry removed the same request is 403. The
  plan's prediction was right.

### Deviations from the plan

- **Ports differ from the D1 table in shape, not in intent.**
  - `tools.execute` returns `{ text, isError }`, not `{ text, parts,
    attachments, isError }`. Attachment extraction and vision parts are two
    optional hooks (`tools.extractAttachments`, `tools.extraParts`) called by
    the core at the points the old code did them: extraction after the
    timings and the post-call abort check, the vision fetch after the result
    message is stored. Folding them into `execute` would have counted the
    image fetch in the tool's duration and run it before the abort check.
  - Added `limit.askContinue` (the turn-limit prompt; the D1 table has no
    row for it), `steering.pending`, and optional `progress`, `now`, `yield`,
    `log`. There is no `clock` object: `now` and `yield` are the two things
    the loop needed.
  - `gate.approve` returns a boolean. The decision enum (once / always /
    always-server) stays in chat-ui, because recording "always" is
    `permissionsStore`'s job. Phase 2 reshapes the gate anyway.
  - The attachment type is a generic parameter `A`; the core never looks
    inside one.
- **The timings fold moved into the core** (`foldTurnTimings`) instead of
  staying in `agentic-turn.ts`, so the bench and the daemon get turn stats
  without reimplementing it. It now runs after the fallback parser instead of
  before it; the two touch different fields.
- **Nest's `stage-shell-bundle.mjs` needed no change.** Its `copyDir` keeps
  every directory and filters only files, so `shared/agent-core/*.mjs` was
  already staged. Pinned with a test instead of edited.
- `toAgenticMessages` (stored messages → loop messages) stays in the browser
  host; it is input conversion, not loop behaviour.

### Gaps carried forward

- ~~Closes in 0.2: the fallback tool-call parser stays in chat-ui~~ **Closed
  in 0.2a:** moved into the core (it defaults to on in chat-ui, so a bench
  without it would measure something no user runs).
- **Closes in Phase 3 (D32):** context compaction is still a chat-ui service.
- ~~Needs a human: a tool-calling chat in the running app~~ **Done
  2026-11-10 by the user:** eleven hand prompts (plain answer, allow, deny,
  two tool turns, inline chart, Stop mid-tool, steering, turn limit both
  ways, a narrated call, create/read a document, an attachment). All passed
  except one steering run, which failed once with "Parent message not found"
  and passed on retry. Cause: a pre-existing lost-update race in
  `DatabaseService` (whole-conversation read-modify-write, with un-awaited
  saves at flow end), not the extraction. Fixed in a91d12b with a write
  queue and `tests/unit/database-write-order.test.ts`. The user also saw
  "small weirdness" in the chat UI, to look at later; not yet described.
- **Phase 3 (D25), or sooner if seen:** the write queue covers one tab. Two
  tabs or two devices writing the same conversation can still erase each
  other's messages, because `PUT /conversations/:id` takes whole records.
- ~~Tooling, pre-existing on main: single-file vitest runs fail~~ **Not a
  gap; corrected in 0.2.** The "Cannot read properties of undefined (reading
  'config')" / "Vitest failed to find the runner" failures came from running
  vitest with a lowercase drive letter in the working directory (`e:\…`, which
  Git Bash's `/e/…` produces). Node then loads vitest twice, once per
  spelling. From `E:\…` single-file runs and extra reporters work. Run chat-ui
  vitest from an uppercase-drive shell (PowerShell, or `cd E:/…`).

---

## Phase 0.2a — what the bench needs from the core (landed 2026-11-10)

The bench must hand the model exactly what the browser does, so three more
pieces of chat-ui moved into `shared/agent-core/`, each re-exported by its old
chat-ui module so every chat-ui test passed unchanged (762/762):

- `tool-call-parser.mjs`: the fallback parser, ported from TS to JSDoc ESM.
  **The loop now applies it** (D2: recovering a narrated call is loop
  behaviour), through a new optional port `fallbackParser()` that returns the
  host's settings or null. chat-ui's store builds it from `config()` and
  `toolsStore.allTools`, as `agentic-turn.ts` used to. It still runs inside
  the turn's `try`, where it ran before.
- `tool-result.mjs`: `formatMcpToolResult` (was `MCPService.formatToolResult`)
  and the `[file: …]` line helpers (`sizeLabel`, `linkPath`,
  `resourceLinkText`, were in `utils/resource-links.ts`).
- `chat-stream.mjs`: `mergeToolCallDeltas` (chat-ui's `chat-stream.ts` now
  re-exports it) and a new `readChatStream(response, acc)` that fills the
  loop's accumulator from an SSE completion, following chat-ui's
  `handleStreamResponse` rule for rule, including the tool-call batch rule.

`test-agent-core.mjs` grew to 33 tests (the parser as the loop applies it,
MCP results as text, the stream reader and the batch rule).
`host-globals.d.ts` gained `URLSearchParams`, `TextDecoder` and a slice of
`Response`.

### Deviations

- chat-ui's `handleStreamResponse` keeps its own read loop (it reports model,
  completion id and prompt progress through ten callbacks). Only the merge is
  shared. Two readers that must agree: see Gaps.

### Gaps carried forward

- **Phase 3 or sooner:** chat-ui's `handleStreamResponse` and the core's
  `readChatStream` are two implementations of the same read loop. Port
  chat-ui onto `readChatStream` when the daemon runtime makes it the third
  user.
- **Found, not fixed (behaviour kept on purpose):** the parser's `braces`
  pattern captures the text *inside* the braces, so `tool{"a": 1}` yields the
  non-JSON arguments `"a": 1`, which fail at dispatch. chat-ui's
  `tool-call-parser.test.ts` pins this ("the regex captures between the outer
  braces"). Whether it should re-wrap is a separate fix with its own test.

## Phase 0.2b — benchmark harness (landed 2026-11-10)

### What was built

- `scripts/agent-bench/run.mjs`: the CLI (`--model-label` required,
  `--tasks`, `--repeat`, `--out`, `--gateway`, `--mcp` defaulting to gateway
  port + 2, `--thinking`, `--temperature`, `--model`, `--keep`). API key from
  `REDSTART_BENCH_API_KEY` (or `--api-key`). Writes `runs.jsonl` (verdict,
  metrics, final text and the full event log per run), `summary.json`,
  `summary.md` with the row for `docs/notes/agent-bench-results.md`.
  `results/` is gitignored.
- `lib/bench.mjs`: the Node host of the core. Ports as chat-ui builds them:
  completions through the gateway (so the composed prompt, bans and
  retrieval are the real ones) read by the core's `readChatStream`; thinking
  off and reasoning sent back (chat-ui's defaults); MCP `tools/call` with the
  run's conversation id in `_meta`, results formatted by the core; argument
  errors thrown with chat-ui's exact messages; `approve` policy as the gate
  (`reads` = tools whose `redstart/class` is `read`); the turn limit answers
  "no" and is logged; `maxSeconds` aborts the flow and is logged; the
  fallback parser on with chat-ui's default patterns.
- `lib/nest-client.mjs`: client routes only (no daemon import): a
  conversation per run (`bench-<task>-<hex>`), fixtures uploaded into
  `chats/<id>/` of the documents space, the workspace read back recursively
  (files over 1 MB listed as null), the conversation deleted after unless
  `--keep`.
- `lib/task-file.mjs`: the plan's task format, validated before any run;
  `from` and the check module resolve against the task file; fixture paths
  may not climb out of the workspace. Adds optional `group` and `phase`.
- `lib/metrics.mjs`: the plan's metrics from the event log; a shallow schema
  check for invalid arguments (required keys, top-level types, unknown keys
  under `additionalProperties: false`).
- `scripts/test-agent-bench.mjs` (22 tests), in `test:security` and CI: an
  in-process fake Nest (gateway routes, a scripted model picked by a
  `[script:…]` marker, MCP on port + 2) and seven fixture tasks in
  `scripts/fixtures/agent-bench/`. Four planted mutants (no conversation id
  in `_meta`, no fallback parser, gate ignored, conversation not deleted)
  each fail it.
- `scripts/lib/mcp-test-client.mjs`: optional `timeoutMs` (default 8000 as
  before); the bench uses 300 s.
- `docs/notes/agent-bench-results.md`: header only.

### Deviations from the plan

- The plan named `fake-mcp-server.mjs` for the CI test. It speaks stdio; the
  bench speaks HTTP to `:19082`. The suite uses an in-process HTTP fake
  instead, which also tests the bench's real HTTP clients.
- Task files gained `group` and `phase` (for the results table and for
  "expected to fail until Phase N").

### Gaps carried forward

- ~~Closes in 0.3: never run against a real Nest~~ **First real run
  2026-11-11 by the user** (commit 096d939): `compute-arithmetic` passed in
  2 turns, 1 call, 13.4 s, with 49 tools offered. The harness works end to
  end against a real Nest; the baseline (all 24, two models) is still to do.
- **Known difference from a chat user, by design for now:** the bench offers
  only the tools Nest serves over MCP. chat-ui also offers llama-server
  built-ins, the in-page JS sandbox, Twig's `fs_*` tools and any external MCP
  server the browser holds. Bench results describe Nest's tools.
- chat-ui's per-user settings are not mirrored: sampling parameters, the
  user's own system message, custom JSON. The bench uses the server profile's
  defaults plus `--temperature`.
- chat-ui runs `normalizeSchemaProperties` (infers a missing `type` from a
  `default`) on MCP schemas; the bench sends schemas as listed. Nest's own
  schemas declare their types, so this should not differ; not verified tool
  by tool.
- The gateway does not tell a client whether retrieval narrowed the tool
  list, so results record the tools *offered*, not the tools the model saw.
- `answers` is loaded and validated but unused until Phase 1's ask port.
- Needs the user: a dedicated bench account with an API key when login is
  on (each run creates and deletes a conversation in it).

## Phase 0.3 — task set and baseline

### The task set (written 2026-11-10)

Committed as fcff678. `scripts/agent-bench/tasks/`: 24 tasks in the plan's
five groups (compute 6, documents 5, multi 5, phase1 4, phase4 4), listed
with what a pass means in `tasks/README.md`. Checks in `tasks/checks/`
(shared helpers in `lib.mjs`) compute their expected answers from the
fixtures at check time. Fixtures in `tasks/fixtures/`, byte-stable
(`* -text`); the data files came from a seeded generator (not committed: the
files are the record), the git bundle from a repo with fixed authors and
dates.

`scripts/test-agent-bench-tasks.mjs` (28 tests, in `test:security` and CI):
every task loads; groups and phases are as planned; and every check passes
a correct outcome and fails a plausible wrong one (an estimate, an
off-by-one, the wrong file, a skipped step, a guessed price, a changed test).
The correct values were computed independently in Python, not by the checks.

Harness changes found while writing them (committed separately, a66fef0):
chat-ui's attachment note is added to the prompt, and files a run makes
outside its workspace (create_document) reach the check as
`ctx.createdFiles` and are deleted after.

### Deviations

- Every task uses `approve: "all"`. The gate is not what these tasks
  measure, and run_python is class `write`, so `reads` would deny most of
  them. Approval policy gets its own tasks in Phase 2.
- `p1-five-steps` and `p1-stop-and-report` are solvable today, and
  `p4-fix-test` can pass without a terminal. The plan wrote them as
  "needs Phase N"; they are kept there because that phase should make them
  pass more often, and the README says they can pass early.
- `multi-find-tool` (the plan's "needs search_tools") only exercises
  search_tools when tool retrieval is on and defers list_documents. Its check
  scores the outcome and the tool used, not whether search_tools ran.

### Gaps carried forward

- **Needs the user:** the baseline. Two models (one small, one mid), with
  python, documents and document search enabled for the bench account, and
  then three repeats of one model to measure noise (the phase's acceptance).
  Not run: no Nest was running here.
- **Calibrate on the first real run:** the text checks are regexes over
  free prose ("says it was not found", "names the top region"). Read the
  failing reasons by hand once, and loosen or tighten where a check judged
  phrasing rather than substance. Record any change here.
- A brief saved as .docx or .pdf fails docs-two-sources: the check reads text
  only, and its reason says so. The prompt asks for markdown.
- A task whose capability is off for the bench account fails like a wrong
  answer. summary.json lists the tools offered; check it before reading the
  pass rate.

### Baseline status (2026-11-11)

Rows in `agent-bench-results.md`: Qwen3.6-35B-A3B 17/24; Qwen3-4B 12/24 on
its own template. The first two 4B rows are void (wrong template, see 0.4).
The three-repeat noise measurement is still to do; it is run after 0.4, so
it measures the fixed setup.

---

## Phase 0.4 — fixes found by the baseline (planned 2026-11-11)

Not in the plan's original Phase 0. The baseline found four problems that
would distort every later phase's numbers, so they are fixed before Phase 1.
Measured as before/after rows on both models.

### What the baseline found

1. **The 4B ran under the 35B's chat template.** The live profile had
   `chatTemplateFile` = `qwen3.6-tools.jinja` (the Qwen 3.5/3.6 XML tool
   format). Picking a different model keeps the profile's override, and
   nothing checks that the template fits the model. Under it the 4B wrote a
   half-XML call format, llama-server parsed 34 of 109 calls, and the
   fallback parser got the rest with arguments that could not parse (61%
   invalid). On its embedded template: 0 fallback calls, 0% invalid, pass
   rate 25% to 50%. Nothing in the bench output or the server log showed
   which template was in use; it was found by reading `example_format` in
   the llama-server log.
2. **The bench cannot see this kind of failure.** It does not count native
   versus fallback calls, and it records the `--model-label` it is given,
   not the model file that was loaded (both 4B runs were labelled Q4_K_M,
   but the file was UD-Q4_K_XL).
3. **The attachment note leads models to the wrong tools.** It says the files
   are in "the Python workspace". Both models then try the File System tools
   (a different root that never holds attachments) or `read_document` with a
   bare name (it needs `chats/<id>/<name>`). About 45 of the 35B's 57 tool
   errors, and the 4B's docs-rename and multi-chain failures.
4. **run_python misses packages used indirectly.** The sandbox loads
   packages from the code's own imports (`find_imports`), so pandas
   `.plot()` without `import matplotlib` fails with "matplotlib is required
   for plotting" (4B, multi-three-deliverables).

These map onto the user's architecture doc ("Model Tool-Calling
Compatibility Architecture", 2026-11-11): 1 is its §2 (bind template
choice to model metadata, not the profile), 2 is its §8 (native vs fallback
rate, template source in diagnostics). The rest of that doc (our own
template adapter, a normalizer layer) is not needed yet: with the right
template, llama.cpp's `--jinja` parser handled every call from both models.
Revisit when a second model family needs an override.

### Module plan, in commit order

- **0.4a Template guard.** `daemon/gguf-meta.mjs` reads `general.*` keys
  from a GGUF header (bounded read, no tensor data).
  `chat-templates/manifest.json` lists each bundled override with the
  `general.architecture` values it is for (`qwen3.6-tools.jinja`:
  `qwen35`, `qwen35moe`; the local 4B reports `qwen3`).
  `daemon/chat-template-choice.mjs` decides: no override → embedded; a
  bundled override whose architectures exclude the model → skipped, embedded
  used, with a warning; a bundled override that matches → used; a file not
  in the manifest → used as a user override, logged as unchecked. Applied in
  `ipc/server.mjs` before `buildArgs`, for the launch AND the command
  preview, so both agree. The run's log gets two `[redstart]` lines: the
  template decision and the full argument list. Test:
  `scripts/test-chat-template-choice.mjs` (a synthesized GGUF header, every
  branch of the decision, the preview/launch agreement).
- **0.4b Bench diagnostics.** `metrics.mjs` counts native and fallback
  calls (fallback ids start `fallback_tool_`, from `createApiToolCalls`);
  the summary gains a fallback-rate column. `run.mjs` reads the gateway's
  `/props` once and records the model file and a hash of the chat template
  in `summary.json`. It warns when the label does not name the file. The
  results table gains a "fallback" column.
- **0.4c Attachment note.** One builder in `shared/agent-core/` used by
  chat-ui's `workspace-upload.ts` and the bench, so they cannot drift. It
  says where each offered tool family finds the files: run_python by bare
  name, read_document as `chats/<id>/<name>`, and that the File System tools
  cannot see them. Only names tools that are offered.
- **0.4d run_python implied packages.** When pandas is loaded and the code
  calls a pandas plotting entry point, also load matplotlib. Test in the
  existing python suite.

### What landed (2026-11-11)

| piece | commit | tests |
|---|---|---|
| 0.4a template guard | 7b4901b | `test-chat-template-choice.mjs` (new, 15; in test:security + ci.yml); mutant "always apply" fails 3 |
| 0.4b bench diagnostics | 3160196 | `test-agent-bench.mjs` 29; mutant "never count" fails 2 |
| 0.4c attachment note | 98d0aa6 | `test-agent-core.mjs` 37 (3 new), bench pin updated, chat-ui 766/766, svelte-check 0 |
| 0.4d pandas plotting | 01b4c69 | `test-python-sandbox.mjs` 44 (real Pyodide); without the fix it fails with the bench's exact ImportError |

`gguf-meta.mjs` was checked against the five real model files: qwen3 (4B),
qwen35moe (3.6-35B), qwen35 (both 3.8-27B), bert (bge-small). Fallback
rates backfilled from the saved runs: 35B 0%, void 4B rows 42% and 69%, 4B
on its own template 0%. So the bench's 20% warning threshold has room on
both sides.

### Deviations

- The plan put the template manifest in `chat-templates/manifest.json`. It
  is a constant, `BUNDLED_TEMPLATES` in `chat-template-choice.mjs`, so
  packaging cannot ship one without the other. A test fails if a `.jinja`
  in the folder has no entry.
- An unreadable model header keeps the old behaviour (override applied,
  with a warning), not fail-closed. A wrong template degrades tool calling;
  it is not a security boundary, and refusing would change what a working
  profile does.
- The note tells the model to rename/move/delete attachments with
  run_python. That was not in the plan; it is there because the documents
  tools cannot, so for docs-rename it is the only working tool.
- The admin status gains `chatTemplate` (source, architecture, warning; no
  path).

### Gaps carried forward

- **Needs the user (0.4 acceptance):** restart Nest so the daemon runs the
  new code, then rerun both models. Check the run log for the
  `[redstart] chat template:` line. With "Productivity 2" and the 4B picked,
  it should say `override skipped`.
- **Not run against a real llama-server or Nest:** the template choice at
  launch, the two `[redstart]` log lines, and the bench's `/props` read
  through the gateway. All are tested against fakes and synthesized headers.
- **No UI shows the template decision.** It is in the run log and
  `GET /admin/status` only. The Nest UI's server panel should show a
  skipped override. Phase 3 at the latest, since admins will need it.
- **The attachment note's File System list is hard-coded** (the reference
  filesystem server's names). Twig's `fs_*` tools in chat-ui (the device's
  own files) cannot see the workspace either, and the note does not say so.
  Add them if the bench or a user shows a model reaching for them.
- **Unchanged difference:** chat-ui adds the note only when run_python is
  served; the bench adds it to every task with fixtures. Pre-existing.
- **The pandas-plotting match is a regex** over the code. It covers what
  the bench saw. A plot through a helper the regex does not know still
  needs `import matplotlib`, and the error says so.
- The broader architecture doc (adapter, normalizer, registry with
  compatibility status) stays unbuilt until a second model family needs an
  override. Only §2's metadata check and §8's fallback rate were needed.

### The 0.4 rerun (2026-11-11, by the user) and what it found

Runs: 4B `results/2026-11-11T18-04-32-*` (50%), 35B `...T18-13-47-*` (79%,
up from 71%). Also three partial 4B runs the user stopped (wrong label; one
"hung on test 2"): `T17-55-34` (10 runs, ended `fetch failed` when Nest was
restarted), `T18-00-37`, `T18-01-04` (1 run each).

**Acceptance, item by item.**
- Template guard: **met, on the real server.** The run log said
  `override skipped ... this model is qwen3` for the 4B and `override ...
  (model architecture: qwen35moe)` for the 35B. Fallback 0% on both.
- Attachment-path errors: **met on the 35B, mixed on the 4B.** 35B: errors
  57 to 29, File System calls 55 to 30, read_document by bare name 8 to 2.
  4B: bare-name 11 to 4, File System calls 19 to 14, but total errors 17 to
  26 and a NEW confusion: it passes `chats/<id>/name` (the note's
  read_document example, and what list_documents prints) to run_python,
  which already runs in that folder (3 times; docs-rename spent all 10 turns
  on it). The 4B's run is also contaminated (below), so its numbers are not
  clean.
- Noise measurement: not done yet.

**Bugs found, not fixed yet** (each needs its own commit and test):

1. **The gateway never cancels an abandoned generation.** In
   `tools-gateway.mjs` `forwardModified`, a client that disconnects ends
   the completion count but not the upstream request, so llama-server
   (which cancels only when ITS connection closes) generates on to the end.
   The two stopped runs left their compute-chart turns generating for 8
   minutes, 12k and 10k tokens (the 4B fell into a loop). They filled the
   shared KV cache (4 slots, `kv_unified`, 32768 cells): 77 "failed to find
   a memory slot" warnings, generation for everyone else fell from ~76 to
   ~25 t/s, and at 18:08:44 llama-server failed all three requests with
   "Context size has been exceeded", including the live bench turn. The same
   path runs for chat-ui's Stop button and the bench's own time limit, so a
   chat user pressing Stop leaves the model generating in the background.
   Fix: destroy `proxyReq` when `res` closes before finishing. Test with a
   fake upstream that counts aborted requests.
2. **No cap on one reply's length.** The 4B's runaway reached 12k tokens.
   Neither chat-ui (max_tokens -1 by default) nor the bench sets one. A
   per-turn cap in the bench (and a server-side default in the profile)
   bounds the damage of a loop. Decide the number from the bench's
   largest real reply.
3. **A server error inside the stream is swallowed.** llama-server sends
   `data: {"error": ...}` mid-stream. Both readers ignore it: the core's
   `readChatStream` and chat-ui's `handleStreamResponse`. The bench scored
   docs-two-sources as an empty answer (a false FAIL) with no error
   recorded; a chat user sees an empty reply. `docs/security.md` already
   lists "context exhaustion during a reply is not explained"; this is its
   cause. Fix in the core reader (throw with the message), and in chat-ui's.
4. **Bench runs leak into the account's File System folder.** Files a model
   writes with the File System tools are not cleaned up (the bench only
   cleans the conversation workspace and documents-space `[FILE: ...]`
   paths). `Workspace/user_files/admin-e187d37e/` now holds an
   `inventory.csv` (17:18 UTC, 4B run) and a `supplier-email.txt` the 35B
   invented (18:19). The 35B's p1-stop-and-report found the stale
   inventory.csv with `read_file`, invented the email, and spent its turns
   reconciling the two. Fix: snapshot the File System folder before a run
   and delete what is new after; record it as a check input.
   **The two files are the user's to delete;** they were not touched.
5. **The bench runs as the admin account,** not a dedicated bench account
   (the plan's assumption): `user_files/admin-*`. Every leak in 4 lands in
   the owner's real files. Make a bench account (needs the user).
6. **run_python does not accept the path list_documents shows.** See the
   4B's new confusion above. Cheapest fix: when a FileNotFoundError names
   `chats/<this conversation>/...`, run_python's result adds "run_python
   already runs in that folder; use the bare name". Or reword the note so
   the `chats/` path is not shown next to run_python.

**All six fixed 2026-11-11** (each its own commit, full loop green, chat-ui
768/768, a planted mutant failing each new test):

| bug | commit | how |
|---|---|---|
| 1 abandoned generations | c8ba6b0 | `cancelUpstreamOnHangUp` destroys the upstream request on an early close (completions and passthrough); security.md gap from bcb636e removed |
| 3 swallowed stream errors | 3b02bae | core `streamErrorMessage`; `readChatStream` throws, chat-ui's reader reports through onError; security.md "context exhaustion during a reply" narrowed |
| 2 reply length | 189e2ed | bench `max_tokens` 4096 (16384 with --thinking), `--max-tokens`; a capped reply logs a `reply-length` limit. Bench only, by decision: a chat user's own setting governs, and Stop now works |
| 6 chats/ path in run_python | 197f814 | `workspacePrefixHint` on the FileNotFoundError; the note says `not open("chats/<id>/x")` |
| 4 File System leaks | 0477173 | snapshot the `files` space per task; new files to trash, changed ones reported |
| 5 admin account | 0477173 | run.mjs warns on an owner/admin key; `meta.account` recorded |

Still open from this list: **the user must make a bench account** (role
user) and use its key, and delete the two files already left in
`Workspace/user_files/admin-e187d37e/` (inventory.csv, supplier-email.txt),
which predate the snapshot. Not run against a real Nest yet: the cancel,
the stream error in the UI, and the `files` snapshot are tested against
fakes; the next 4B rerun is their first real exercise.

**Tool discovery** findings (retrieval offers the File System family for
attachment prompts; the set swings 2 to 35 tools; nobody can see the sent
set; search_tools almost unused) are recorded for that work in
`tool-retrieval-implementation.md`, "Found by the agent bench, 2026-11-11".

**Turn limits.** Turn-limit hits: 4B 3 (docs-rename: bug 6;
multi-chain; p1-which-draft), 35B 5 (multi-chain; p1-stop-and-report:
bug 4; p1-which-draft; p4-fix-test, which passed anyway; p4-git-log).
multi-chain is designed to need more than 10 single reads, so it passes
only if the model walks the chain inside one run_python call; neither did.
p1-which-draft and p4-git-log fail by design until Phases 1 and 4. So no
turn-limit hit traced to retrieval adding turns. The retrieval-off run
(tool-retrieval notes) is the test of that.

### The clean 4B run (2026-11-11, `results/2026-11-11T19-21-26-*`) and what it found

14/24 (58%), commit 0477173, fresh server, 49 tools, still the owner's key
(the admin warning printed; no bench account yet). 0% invalid arguments, 0
fallback calls. 25 tool errors in 64 calls.

**The ten failures, each read against its event log.**

| task | expected? | what happened |
|---|---|---|
| p1-ambiguous-units | yes (Phase 1) | assumed Celsius, converted, never asked |
| p1-which-draft | yes (Phase 1) | but for the wrong reason: `read_document("draft_a.md")` was "File not found" twice and it told the user the drafts were never attached. It never reached the choice the task is about |
| p4-exit-code, p4-run-tests | yes (Phase 4) | said it has no way to run Node. No tool call |
| p4-git-log | yes (Phase 4) | subprocess in Pyodide, then `os.system` until the 30 s timeout |
| p4-fix-test | yes (Phase 4; can pass early) | stopped early for a tool reason: `read_document` by bare name failed, and `list_documents` does not list `.mjs`, so it concluded the files were missing |
| docs-two-sources | **no** | `read_text_file("meeting-notes.txt")` → bare ENOENT → "the files may not be attached". One turn of work |
| multi-chain | **no** | same: `read_text_file("start.txt")` → ENOENT → gave up |
| docs-rename | **no** | `move_file` ×3 (ENOENT), found the folder with list_documents, then `write_file("chats/<id>/…")` (ENOENT) and the 10-turn limit |
| multi-recover | **no** | correct pandas code with the value as the last line of a `try:` block. "(no output …)" seven times, never added `print`, turn limit |

None was a check misjudging. All four unexpected ones are the model stopping
or looping on a tool error that did not say what to do. The attachment note
names the right tools; the 4B does not act on it. So the fixes are in what the
tools answer, not in the note.

**Worse than a failure: the bench deleted one of the owner's documents.**
`search_documents` puts a `[file: …]` line under every passage it cites. The
bench read every file line in a result as "a file this run created", and its
cleanup moved `sum-of-odds-py.py` (the owner's, cited in p1-ambiguous-units)
to the Recycle Bin. Later tasks saw a documents folder without it.

**Fixed 2026-11-11** (each its own commit and test; full loop green, chat-ui
768/768):

| what | commit | how |
|---|---|---|
| bench deletes cited documents | e649ae4 | snapshot the documents space (not `chats/`) before each task; only a path that was not there is "created"; no snapshot, no deletion |
| read_document by bare name | e4bf187 | falls back to the conversation's workspace when the documents folder has no such path; the note now gives the bare name |
| bare ENOENT from File System tools | 02b0091 | `attachmentHint`: a "no such file" whose path is in the conversation's workspace (or uses its `chats/<id>/` prefix) says so and names read_document / run_python |
| "(no output …)" | a81e0b6 | `NO_OUTPUT_TEXT` says a value inside try/if/for is not returned and to use `print(...)` |
| 10-turn limit | 14ffa9e | 30 by default (the owner's call). multi-chain can now be walked a file per turn; earlier "hit limit" counts are not comparable |
| server path in an error | edb1b50 | the upstream server's `chdir '<daemon cwd>' -> …` error told the model where Nest is installed; other absolute paths in a File System ERROR are now redacted |

**First real exercise of the six earlier fixes.** File System cleanup: worked
(docs-rename's `2026-01-report.txt` was trashed, `file_system_writes` logged,
the folder holds only the two stale files). Admin-key warning: printed.
Reply cap: sent, never reached (longest reply 627 tokens). **Not exercised:**
the gateway cancel and the mid-stream error, because nothing was stopped and
nothing errored. They are still tested against fakes only.

**Gaps carried forward from this run.**

- **Needs the user:** restore `sum-of-odds-py.py` from the Recycle Bin (it
  belongs in `Redstart\user_files\admin-e187d37e\`). Still open from before:
  the bench account, and deleting `inventory.csv` and `supplier-email.txt`
  from `Workspace\user_files\admin-e187d37e\`. Two workspaces from the runs
  stopped earlier are also still there: `chats\bench-compute-chart-bb525c01`
  and `-e2d6031a`.
- **Needs the user:** restart Nest (the three daemon fixes are not live until
  then) and rerun the 4B. Then the three-repeat noise run, still not done.
- **Not run against a real Nest:** all six fixes above. The read_document
  fallback and the hint depend on `ctx.conversationId` reaching the two
  providers through `mcp-server.mjs`; the suites call the providers directly.
  The rerun shows it: `read_document` by bare name should stop erroring.
- **`read_document` and `list_documents` do not know `.mjs`** (or `.ts`,
  `.jsx`, `.sh`, …): `READABLE_EXTENSIONS` in `documents-tool.mjs`. An
  attached script of those types is invisible to list_documents and refused
  by read_document; run_python `open()` is the only way in. p4-fix-test ran
  into it. Left for Phase 4, which is where code files become a real case.
- **The hint cannot see bans.** `attachmentHint` names read_document when
  Documents is enabled and run_python when Python is, not whether this
  account is allowed them. A banned tool would be named.
- **`read_multiple_files` reports a missing file inside a successful
  result,** so it gets no hint. Not seen in a run yet.
- **The path redaction is a pattern,** `'<absolute path>'` as Node quotes it.
  An upstream error that prints a path unquoted would pass. The real fix is
  the child not running in the daemon's working directory; not done.
- **multi-chain no longer forces a loop.** With 30 turns a model can pass it
  one read per turn. If the task should keep measuring "does it write the
  loop", give it its own `limits.maxTurns: 10`.
- **The 4B ignores the attachment note** on about a third of attachment
  tasks. The tools now recover it; the cause (a note at the end of the user
  message, competing with 49 tool descriptions) is untouched. The retrieval
  findings in `tool-retrieval-implementation.md` are the likelier lever.

### The rerun at 30 turns (2026-11-11, `results/2026-11-11T19-49-58-*`)

14/24 again (58%), commit 827933f, **as the bench account** (role user, no
warnings), Nest restarted. Tool success 61% to 75%; 2% invalid arguments and
1% fallback (one call each, the first non-zero on this template).

**Same score, different tasks.** multi-chain now passes (15 turns, one
`read_document` per file by bare name). compute-join now fails: the model
answered "C003", the customer id, where every earlier run gave the name.
Nothing in its tools changed; that is the model, and it is why the noise run
matters before any row is compared.

**The earlier fixes, on the real server.** `read_document` by bare name: 0
"File not found" on an attachment (9 last run). The ENOENT hint fired 8
times; p1-ambiguous-units and p1-which-draft both recovered on the next call
and now fail for the reason they were written for (converted without asking;
fixed both drafts). The new "No output" text was shown. The bench cleaned up
40 stray documents and left the account's folder empty.

| task | what happened | answered by |
|---|---|---|
| multi-recover | **one reply with 58 tool calls**: 40 `create_document` with "[INSERT_RESULT_HERE]" bodies, sqlite on a made-up database, a `delete_file`. All ran. The reply-length cap ended the text; nothing bounded the calls | 04e090b: the core runs the first 10 of a reply and answers the rest |
| docs-rename | `search_files("*.txt")` → "No matches found" (a success, so no hint) → "the reports could not be found" | 862ba5f: an empty search or listing names the conversation's attachments |
| docs-two-sources | read both files, then computed the total as sum(quantity) × sum(unit_cost) = 63,021 | nothing: a wrong formula is the model |
| compute-join | answered the id, not the name | nothing: the model |
| p4-fix-test | `read_document` refuses `.mjs` | gap already listed (Phase 4) |

**Also found:** `create_document` ended its result with the file's absolute
path, so a role-user account's model was shown
`C:\Users\<owner>\OneDrive\...\user_files\bench-1d74d50c\`. Removed in
284f718.

**Gaps carried forward from this run.**

- **Needs the user:** restart Nest again (04e090b is in the core the bench
  imports, so it is live for the bench at once; 284f718 and 862ba5f are
  daemon code) and rerun. Then `--repeat 3`.
- **The cap of 10 is a constant in the core.** No setting, and chat-ui shows
  nothing special when it applies: the skipped calls appear as tool results
  reading "Not run. …". A user who really wants 11 calls in one reply cannot
  have them. Revisit if a larger model ever legitimately batches more.
- **A capped reply is not stopped early.** The model still generated all 58
  calls (4,096 tokens) before the loop saw any. Stopping generation at the
  tenth call needs the stream reader to abort mid-reply; not done.
- **The empty-search hint only fires on an empty result.** An account whose
  File System folder has files gets a normal listing and no hint; the model
  then has to try a read (which does get one). Not seen yet: the bench
  account's folder is empty.
- **The run_python result still says `read_document opens them as
  "chats/<id>/<name>"`** for files it wrote. True, and longer than needed
  now that the bare name works.
- **compute-join and docs-two-sources are single-sample model failures.** Do
  not tune anything for them before the noise run says how often they happen.

### The before-rows for Phase 1 (2026-11-11, commit 862ba5f, bench account)

Three runs. `T20-08-45` and `T20-14-08` are **both the 4B**: the second was
labelled 35B, but the 4B was still loaded, and the bench's label warning said
so (row corrected in agent-bench-results.md). `T20-24-08` is the real 35B.

| run | pass | fails |
|---|---|---|
| 4B sample 1 | 15/24 (63%) | 6 by design; docs-two-sources; compute-convert, compute-dates |
| 4B sample 2 | 16/24 (67%) | 6 by design; docs-two-sources; p1-stop-and-report |
| 35B | 21/24 (88%) | 2 by design (ask_user); docs-missing-file (a check bug) |

**First noise number.** The two 4B samples disagree on 3 of 24 tasks
(compute-convert, compute-dates, p1-stop-and-report), with nothing changed
between them. So a one- or two-task difference between single 4B runs is
not a result. Still not the 3-repeat measurement the phase acceptance names.

**The 35B passed all four Phase 4 tasks early** (exit code, fix-test, git-log,
run-tests) by working around the missing terminal: reading the bundle and the
test file in Python. The 4B passed none.

**Unexpected fails, and what was done.**

| task | run | cause | done |
|---|---|---|---|
| docs-missing-file | 35B | right answer, "there is no `quarterly-forecast.xlsx` on this server": the check's window stopped at the dot in the file name | 04ea444, check fixed; replayed over every saved run, only this one changes |
| p4-fix-test | 4B | 11 run_python calls with the code escaped twice (`\\n`), all SyntaxError | 1eb2047, `escapedNewlineHint` |
| compute-dates | 4B s1 | value on a middle line not shown; model invented 1031 days | 1eb2047, `unshownValuesHint` |
| docs-two-sources | 4B both | total computed in its head, wrong (no run_python call). Then `read_document("x")` with a bare string ×3 | nothing: the model. See gaps |
| compute-convert | 4B s1 | `write_file` content with literal `\n` (escaped twice); also went to the File System folder, not the workspace | nothing: the model |
| p1-stop-and-report | 4B s2 | hint worked (edit_file → run_python), then removed the SKU-9 row | nothing: the model |

**Tool retrieval (the user's question, 2026-11-11).** Retrieval is not what
holds pass rates down now: the 35B is at 88% with only by-design fails, and
every unexpected 4B fail above is the model or answered by a tool. It does
cost turns. On attachment tasks a File System tool was the FIRST call on 8
of 22 (35B) and 4 of 22 (4B); the hints turned most of those into a correct
next call (35B 16 of 21, 4B 9 of 12, counting calls after a hint). Turning
retrieval off would not remove those tools (all 49 are offered then), so
the off-run measures turns and cache reuse, not this detour. What would
remove it is the retrieval pass's own idea: down-rank the File System family
when the message carries an attachment note. Recorded for that pass, not done
here.

**Gaps carried forward.**

- **Needs the user:** one 4B run with tool retrieval off, the comparison
  `tool-retrieval-implementation.md` asks for. Then the 3-repeat noise run.
- **Bare-string arguments.** `read_document("x")` gets "Tool arguments must
  be an object, got string" and the 4B repeats it. The message cannot name
  the parameter: `parseToolArguments` (chat-ui `mcp-schema.ts`, and its copy in
  the bench) has no schema. Repair (wrap a string as the one required param)
  is the old "argument repair for small models" proposal, not decided.
- **A model can still do arithmetic in its head.** docs-two-sources fails
  that way on the 4B every time. Nothing tool-side can see it; a
  verification step (Phase 1.2's completion check, D8) is where it could be
  caught.
- **`unshownValuesHint` is a heuristic** over the source (brackets and
  triple quotes tracked roughly). It can miss a value; it should never name
  one wrongly in the cases tested.

### Acceptance

Both models rerun after 0.4: the 4B's fallback rate stays 0 under its
profile; a launch with the Qwen3.6 override and the 4B selected logs
"skipped" and uses the embedded template; the attachment-path errors drop on
both models; no task that passed before fails beyond the noise measured
after the rerun.

---

## Phase 8 — memory that learns from the work (started 2026-11-12)

Plan section 9, D33 to D42. Decided before the first commit (2026-11-12):
U7 (Phase 8 now, before Phase 4), U8 (guidance memories are FOLLOWED, as
user-tier text like project instructions), U9 (the reviewer sees tool names
and status only, never tool-result bodies). U10 (thinking for the review)
is decided by the bench.

### What landed

- **8.0 The memory bench.** `scripts/memory-bench/`: `run.mjs` (flags as the
  plan says, plus `--port`, llama-server's own port, default 19081),
  `lib/v1.mjs` (the pre-Phase-8 reviewer, a verbatim copy of
  `memory-review.mjs`'s pure half; test-memory-bench.mjs proves it builds the
  same request and filter result as the daemon's, a check that retires
  itself once 8.2 adds `branchForReview`), `lib/case-file.mjs` (format,
  validation, the stored-conversation branch), `lib/score.mjs`, README.
  32 cases in the plan's eight groups, each with a right and a wrong answer
  the harness test scores. `test-memory-bench.mjs` (16 cases) in
  test:security and ci.yml. Results table: agent-bench-results.md,
  "Memory bench".
- **Deviations.** Kind is checked only on an op that carries one, so v1
  (which has no kinds) is judged on content and the run counts
  "kind unchecked"; otherwise every v1 correction would fail by
  construction and the baseline would say nothing. retr-state-finished
  expects a `forget` (the plan allowed forget or update; one expectation
  cannot hold an OR). `--variant v2` refuses until 8.2 lands.
- **The first v1 baseline (the user, 2026-11-13, at 0629444): superseded,
  the cases changed after it.** Filtered pass, think off / on: 35B 28/32
  (88%) / 26 (81%); Ornith 9B 19 (59%) / 21 (66%); 4B 14 (44%) / 13 (41%).
  Injection, secrets and nothing 10/10 on every run (expected for v1: it
  never sees assistant or tool text). Retractions capped at 1/3 (v1 has no
  forget). Raw = filtered everywhere. What it showed: (1) the 4B and the 9B
  mostly answer nothing at all, the 4B 0/5 on plain facts: v1's "none is
  the usual answer" at work, which D39 removes; (2) thinking cost the 35B 2
  cases and 13 extra ops, helped the 9B by 2, did nothing for the 4B (U10's
  first data); (3) **two case faults, fixed before the baseline counts:**
  corr-no-tables refused "prefers plain lists over formatted content" (a
  right answer; terms widened), and the corrections were too easy for v1:
  most user replies carried their own meaning ("Metric please, every
  time"), so the 35B already passed 5/6 and v2 could show nothing. Four
  cases now depend on the assistant turn, as the plan intends (D34):
  corr-run-from-e (the path is only in the assistant's command),
  corr-units (only the assistant said "miles"), corr-show-test-command, and
  conf-one-pr ("that was exactly right" names nothing).
- **8.1 (dd4a648).** `kind`, `why`, `asOf` on a memory (D35): storage,
  routes, and `memory_save` (fact | state; guidance refused per D37, with
  the plan's message). Old records read as fact, never rewritten. Deviation:
  storage does not require a why on guidance (a user writing their own need
  not give one); the reviewer (8.2) drops a proposed guidance without one.
  The client half of `/remember guidance: … because …` moves to 8.6 with
  the chips. Found on the way, fixed in 12de950: test-contracts.mjs
  intermittently aborted Node on Windows at exit (libuv
  UV_HANDLE_CLOSING) after every test passed.
- **The v1 baseline (the user, 2026-11-13, cases at e61b652): the "before"
  row Phase 8 is measured against.** Filtered, think off / on: 35B 28/32 /
  26; Ornith 9B 20 / 20; 4B 14 / 14. Rows and notes in agent-bench-results.md,
  "Memory bench". The referent-dependent cases (corr-run-from-e,
  conf-one-pr) now fail on every model, as they should for v1. Thinking
  helped no model (U10's evidence so far: off).
- **Acceptance problem found by the baseline (for the user to decide).** The
  plan's first criterion, "corrections, confirmations and state each rise
  from the baseline, and together reach at least half their cases on the
  35B", cannot be met as written: the 35B is already at 12/14 together and
  5/5 on state under v1, so state cannot rise. And v2 rows are stricter
  than v1 rows (a v2 op carries a kind, so a wrong kind fails; v1's are
  judged on content only). Proposed reading: the rise is required on the
  9B and the 4B (8/14 and 3/14 together now), and on the 35B those groups
  must not fall beyond one case. **Amended by the user, 2026-11-13** (plan
  section 9, Acceptance).
- **8.2 The v2 reviewer.** `memory-review.mjs` rewritten per D34, D36 to D39:
  `branchForReview` (user text 2000, assistant text 600 head and tail, one
  status line per tool call with only an error's first 150 chars, 16000 in
  all with user text kept first; only unreviewed user turns are new),
  `REVIEW_SCHEMA` v2 (add | update | forget, kind, why, replaces, quote
  required), instructions by kind (no "none is the usual answer"),
  `filterOps` with the citation check (`citedQuote`, `normalizeForQuote`),
  forget and replaces validation, guidance without why dropped. The pass:
  a forget is always a suggestion; after a web call in the chat every op is.
  `applyOp` does forget and merges and returns what Undo needs (removed
  memories whole, previousKind and previousWhy). Suggestions store kind,
  why, quote, replaces; a forget has its own dismissal key. `max_tokens`
  900 (why and quote on three ops). The bench's v2 variant now loads.
  Tests: test-memory-review.mjs 24 (v1-specific ones rewritten to v2's
  rules, with the reason in each), test-memory-bench.mjs 18 (every case's
  right answer survives the real v2 filter; every injection case's planted
  op is stopped by it).
  **Deviation:** a forget's quote need not share a word with the memory
  (D36 asked for it). The harness found it: "it is all done now, nothing
  left to do on it" retires "Preparing slides for the March conference
  talk" without repeating a word. A forget is only ever a suggestion, so the
  shared-word rule's protection is not needed there; the quote must still be
  a real user span.
  **Gaps for 8.6:** chat-ui shows a forget suggestion like an add (no
  "Forget:" label), and Undo of a merge does not yet restore the removed
  memories, nor an update's previous kind and why (the server returns all
  three).
- **Next: the v2 bench runs (the user's machine)**, same models:
  `--variant v2 --think off`, and `--think on` for U10.

---

## Phase 3 — the daemon-side task runtime (planned to module level 2026-11-12)

Plan section 5, D22 to D32, checked against the code at bc78774. Nothing
built yet.

### What exists (verified)

- **The completion path** (`tools-gateway.mjs`, the POST /v1/chat/completions
  branch, ~150 lines inline in the request handler): reads redstart_mode,
  redstart_project, redstart_retrieval and the time-zone header, then bans
  (`enforceToolAllowList`), then retrieval (`filterRequestTools`, budgeted
  against a pins-only prompt), then the prompt (`injectSystemContext`), then
  `recordWireCost`, then `forwardModified` (which counts the completion in
  `completion-activity.mjs` and pipes llama-server's stream). D26's
  extraction is a lift of that block; nothing in it depends on `res` until
  `forwardModified`.
- **The tools/call path** (`mcp-server.mjs` handleRpc): evaluateToolPolicy,
  then the Phase 2 approval gate (`approvalGate`, already a function), then
  `verifiedConversationId`, then provider dispatch and logging. D27's
  `callToolAs` is that branch without the JSON-RPC wrapping.
- **Conversations** (`conversations-storage.mjs`): one `conversations.json`
  for every account (976 KB on the user's machine), rewritten whole on every
  write. chat-ui writes a message by PUTting the conversation's ENTIRE
  message array (`database.service.ts`, every add, edit and delete). So D25
  is not optional: a client holding an older array would overwrite messages
  the runtime appended. The fix has to be on the server.
- **Model activity**: `completionsInFlight()` counts gateway completions;
  `llama-args.mjs` passes no `-np` (4 auto slots, D29, unmeasured).
- **The core's ports** are all a Node host needs (Phase 0-2): model, tools,
  gate, ask, plan, limit.askContinue, steering, store callbacks.
- **Compaction** is a 528-line chat-ui service (`context-compaction.service.ts`);
  its summary prompt and trimming are pure, its I/O is not.
- **Approvals** (Phase 2): the ledger, `approvalGate`, `POST /approvals/:id`
  are exactly what a parked task needs; nothing new is invented for D5's "a
  gate that a task running with no client attached cannot pass".

### Modules

**3.1 `prepareCompletion`** (`tools-gateway.mjs`, D26). `prepareCompletion(parsed,
{ account, surface, effectiveConfig, accountId, timeZone })` → `{ parsed,
wire }`: the redstart_* fields, bans, retrieval, prompt, wire cost. The
gateway handler becomes read body → prepareCompletion → forwardModified.
Behaviour-preserving: `test-gateway-routes.mjs` unchanged.

**3.2 `callToolAs`** (`mcp-server.mjs`, D27). `callToolAs(account, name, args,
{ conversationId, approvalId, surface })` → MCP result: policy, approval
gate, provider dispatch, logging. tools/call becomes a wrapper. Also
`toolCatalogFor(account, { serverOnly })` from the tools/list branch.

**3.3 The task store** (new `task-store.mjs`, D22-D24).
`<config>/tasks/<id>/task.json` (`{ id, accountKey, conversationId, surface,
status, waiting, limits, createdAt, updatedAt }`) and `events.jsonl`
(append-only, each event numbered for SSE replay). `createTask`, `getTask`,
`listTasks(accountKey)`, `setStatus`, `appendEvent`, `readEvents(afterSeq)`.
States per D23: queued, running, waiting_user, waiting_approval,
waiting_model, done, failed, cancelled; `waiting` says what for (a question,
a pending approval, a continue prompt).

**3.4 Server-owned conversation writes** (`conversations-storage.mjs`,
`conversation-routes.mjs`, D25). `appendMessages(accountId, convId, messages,
currNode)` for the runtime, and a protected `activeTaskId` on the record.
While it is set, a PUT carrying `messages` or `currNode` gets 409 (title,
project, pinned still accepted). chat-ui: on 409, reload the conversation
instead of failing. Measure the whole-file rewrite per turn on the user's
976 KB file; if it is slow, per-conversation files become an earlier slice.

**3.5 The runner** (new `task-runner.mjs`). Hosts `runAgentLoop` with Node
ports, daemon lifetime, one task generating at a time (D29: a queue, and
between turns it waits while `completionsInFlight() > 0`).
- model: prepareCompletion, then a streamed request to llama-server through
  the shared SSE reader (`chat-stream.mjs`), counted as a completion. No
  model or a profile change → `waiting_model`.
- tools: `toolCatalogFor(account, { serverOnly: true })` (D28: no Twig, no
  in-page sandbox, no browser-held MCP); the start event names what was left
  out. execute: `callToolAs`.
- gate: rule none → run; prompt with a standing grant → run; otherwise park
  in `waiting_approval` with a ledger pending approval (see U-a), resumed when
  `POST /approvals/:id` decides it (the ledger gains an on-decided hook).
- ask: `waiting_user`; `POST /tasks/:id/answer`. plan: the conversation's
  `plan` field. limit.askContinue: `waiting_user` with the continue
  question (D30). steering: `POST /tasks/:id/steer`.
- store callbacks: events, and `appendMessages` at each turn boundary.
- config re-resolved every turn (D22): a ban, role change or disabled
  account lands mid-task; a disabled account fails the task.

**3.6 Routes** (new `gateway/task-routes.mjs`, D31). POST /tasks
`{ conversationId, content }`, GET /tasks, GET /tasks/:id, GET
/tasks/:id/events (SSE, `Last-Event-ID` replay from the log), POST
/tasks/:id/steer | answer | cancel. Owner on the control plane:
`tasks:list`, `tasks:cancel`, and the Activity tab gains a Tasks section.

**3.7 Restart recovery.** At daemon start: `running` tasks rebuild their
messages from the conversation and log, a tool call in flight is closed with
"Interrupted by a restart. Its effect is unknown: check before repeating
it.", and the loop re-enters at a turn boundary. Waiting tasks stay waiting.

**3.8 Compaction in the core** (D32). The pure part of the compaction
service (summary prompt, what to keep) moves to
`shared/agent-core/compaction.mjs`; chat-ui and the runner both use it.

**3.9 chat-ui as a client** (see U-b). "Run in the background" at send time
and a `/task` command; a conversation with an active task shows a status
bar (state, Cancel) and renders the task's question and approval cards from
the task's state; messages arrive through the conversation (SSE nudge,
reload). The browser loop is untouched for ordinary chats.

**3.9 as built (planned 2026-11-12 against ea473f9).** No server change: the
routes, `status` events carrying `waiting`, and `activeTaskId` on the GET
conversation are enough.
- `services/task.service.ts`: the routes, with the conversation routes'
  headers (auth, device id: the auth-off scope); `readTaskEvents` parses the
  SSE frames from fetch (`parseSseFrames`, pure, tested).
- `stores/tasks.svelte.ts`: follows the active chat's task. On a chat load,
  `activeTaskId` (or GET /tasks?conversationId) → follow its events from the
  last seq; a `status` event updates the record; `message`/`plan`/`turn`
  nudges a throttled reload of the conversation; reconnect with backoff while
  not ended; a final reload at the end. Actions: start, steer, answer,
  cancel, decide (POST /approvals/:id).
- `ChatScreenTaskBar.svelte` above the composer: state and Cancel; the
  existing Question / PermissionRequest / ContinueRequest cards rendered from
  `waiting` (question → answer, approval → /approvals once|always|deny,
  continue → answer {continue}); `model` → "waiting for a model".
- Sending while a task holds the chat steers it (files refused with a toast).
- `/task <text>` starts one (a new chat is made first when none is open).
  Generation from `getApiOptions()`, plus `excludeReasoning` and
  `contextCompaction` mapped to the runner's names.
- 409 `task_active` from a conversation write: `TaskActiveError`, a toast,
  and the conversation reloaded (the deferred half of 3.4).
- **Gaps:** no send-time "Run in the background" button (the composer has no
  send menu; `/task` is the way in); `/task` sends text only (no
  attachments); a task's reply appears per turn, not streamed token by token.

**3.10 Bench `--runtime`.** Posts each task to /tasks instead of hosting the
core; answers questions and approvals from the task file through the routes.

**3.11 Measurements before defaults** (D29): two generations at once on the
4 auto slots (throughput, and what happens past the context buffer);
consider `-np` explicitly.

### What landed

- **3.1 (7d97917, 2026-11-12).** `prepareCompletion(parsed, { account,
  surface, effectiveConfig, accountId, timeZone })` → `{ parsed, wire }`,
  exported from `tools-gateway.mjs`. `wire` is the object handed to
  `recordWireCost`. The time-zone header is still read by the handler.
- **3.2 (10b3766, 2026-11-12).** `callToolAs(account, name, args, {
  conversationId, approvalId, session })` → MCP result, or null for an
  unknown tool (the wrapper sends -32601 as before). `toolCatalogFor(account,
  { hostTools })`, and tools/list now goes through it. Shared role narrowing
  is `configFor(account)`.
- No test edited for either; the whole verification loop passed.
- **3.3 (14f7ec0).** `task-store.mjs`; suite `test-task-runtime.mjs` (in
  test:security + ci.yml). Torn last event line closed on first append.
- **3.4 (d6819b9).** appendMessage / patchMessage / setActiveTask;
  `activeTaskId` protected; PUT with messages/currNode → 409 `task_active`.
  Rewrite measured: 12.9 ms median on 1.3 MB, so no per-conversation files.
  chat-ui's 409 handling deferred to 3.9.
- **3.5 (328539c).** `task-runner.mjs`. Ledger `holder` approvals (30 days,
  never evicted), `onDecided`, `withdraw`. `effectiveConfigFor` (gateway),
  `accountForTask` (auth). `shared/agent-core/stored-messages.mjs` = chat-ui's
  DB→API transform, pinned by chat-ui `stored-messages-parity.test.ts`.
  Sampling settings from the client, whitelisted (GENERATION_KEYS).
- **3.6 (3978714).** `gateway/task-routes.mjs` (SSE via fetch; Last-Event-ID
  in CORS; `?after=`), `ipc/tasks.mjs` tasks:list/tasks:cancel, launcher
  Activity tab "Background tasks".
- **3.7 (ab95a9e).** resumeTasks at start, suspendAllTasks at stop. Fixed:
  inFlight cleared only when the result is stored (else a restart re-runs a
  write); stale `waiting` cleared on resume; re-asking needs no model. Tested
  by SIGKILLing a child process (`scripts/lib/task-restart-child.mjs`).
  **Gap:** not against real nestd: its gateway needs a real llama-server.
- **3.8 (ea473f9).** `shared/agent-core/compaction.mjs`: `planCompaction` /
  `finishCompaction` / `planManualCompaction` plus the helpers; chat-ui's
  service is I/O only. The runner builds each request from the stored
  branch, compacts with `/tokenize` + a non-streamed summarizer through
  prepareCompletion, stores `contextSummary`, logs `compacted`.
  `contextCompaction` rides in the generation settings. Algorithm pinned in
  test-agent-core.mjs. Correction to the commit message: chat-ui DID test
  it, `tests/unit/context-compaction.test.ts` (16 tests through the service,
  mocked I/O), and those passed unchanged: the behaviour-preserving check.
- **3.9 (cd42f5d).** As planned above ("3.9 as built"); 14 tests in
  `tests/unit/background-tasks.test.ts`. **Needs the user's click test:**
  `npm run dev`, `/task <request>` in a chat with a model loaded; check the
  bar, a question card, an approval card (a write tool), Cancel, closing
  and reopening the page mid-task, and a 409 (edit a message while it runs).
  **Clicked by the user 2026-11-12: works.** One bug: a task's question
  showed in the bar AND in the message, and the message copy did nothing
  (it answered a browser loop that is not running). Fixed in e1e44b7: every
  question card (chat or task) is now with the composer
  (`ChatFormQuestion.svelte`, `pickQuestionSource`), redesigned as a choice
  list (radio rows / checkbox rows, pick then Send). Seen by the user in
  the vite test render: approved.
- **3.10 (3634ad7).** `run.mjs --runtime` (`lib/runtime.mjs`): each run is
  POSTed to /tasks; the bench answers questions (task answers), approvals
  (task policy), the turn limit (no), cancels at the time limit, and does
  text asks as a second task. The run log is rebuilt from the stored
  conversation plus the stream (turns, plan_nudge, errors, dismissals), in
  bench.mjs's shapes, so checks and metrics are unchanged. The runner gained
  a `plan_nudge` event. Refuses `--plan tool|off` and `--model`. Tested over
  HTTP against the real routes + runner with a scripted model.
  **Gaps:** the time-limit path untested (the fake model ignores aborts);
  never run against a real Nest; a task compacts and the hosted bench does
  not (differs only on long runs).
- **The acceptance runs (the user, 2026-11-12, Ornith-1.5-9B-Q6_K at
  3634ad7):** hosted T18-14-10 and `--runtime` T18-30-49, both 26/32 (81%).
  Six tasks differ, three each way, every one traced to the model (details
  and the rows in agent-bench-results.md). Within the noise. This was also
  `--runtime`'s first run against a real Nest: it worked as designed.
- **Survival against the real daemon (ddb34a5).** `test-task-survival.mjs`
  runs nestd with a fake llama-server it launches itself (settings
  `serverBinPath` → a shim: shell script on POSIX, a csc-compiled .exe on
  Windows → `scripts/lib/fake-llama-server.mjs`). Client disconnect, model
  stop and start, and SIGKILL of nestd mid-turn: all three finish with one
  reply. 3/3 on the first run and again, no process left behind; in
  test:security and CI. Closes 3.7's gap.
- **3.11, first run (the user, 2026-11-12, Ornith-1.5-9B-Q6_K, RTX 3060,
  n_ctx 32768, 4 auto slots).** Throughput: alone 40.8 tok/s; two at once
  36.0 and 35.8 (88% each), 1.75x in total. A second generation is nearly
  free. Context: the script said "both fit", which was WRONG. The second
  "at once" request reused the prefix the "alone" run cached (prompt 4
  tokens, not 17,501), so only one long prompt was really processed. The
  server log shows the real answer: `n_parallel = 4 and kv_unified = true`,
  meaning the slots share ONE pool of 32,768 tokens. When the second
  17.5k prompt passed ~15k, llama-server logged "failed to find a memory
  slot" and purged slot 0's 17,502 cached tokens to make room. Slot 0 had
  finished, so nothing broke, but two live long contexts cannot both fit.
  The script now tags every prompt (no cache reuse), says "both fit" only
  when both processed their whole prompt, and points at the log lines.
- **3.11, second run (the corrected script, same machine).** Throughput
  repeated: 40.2 alone, 35.4 and 35.7 at once (88%). Both long prompts were
  processed in full (17,515 and 17,513), but NOT side by side: the server
  ran slot 1's prefill to the end (12.5 s), then slot 3's (the pair took
  13.0 s and 26.2 s). At ~15k into slot 3 the log again shows "failed to
  find a memory slot" and "purging slot 1 with 17516 tokens": the second
  fit only because the first had finished and could be evicted. And while
  one slot prefills a long prompt, the other slot's generation drops to
  ~5 tok/s (4.86 here, 4.72 in run 1) from ~40.
- **3.11 CLOSED: D29's answer.** (1) Two short generations at once cost
  little: 88% each, 1.75x total. (2) Long contexts do not run in parallel
  on this setup: the slots share one KV pool of n_ctx tokens (kv_unified),
  an overflow evicts another slot's cache (a reprocess on its next turn),
  and a long prefill starves the other slot's generation eightfold. So the
  runner's default stays: one task generating at a time, a chat first
  between turns. **Gaps carried:** a task turn already prefilling when a
  chat message arrives still slows that chat's reply for the prefill's
  length (the runner yields only between turns); allowing two at once when
  both contexts are known to be short is a later optimisation, not Phase 3.
  The script's verdict now says "serialized" for a pair run one after the
  other.
- **3.11, third run (the user raised n_ctx to 131072, same model and GPU).**
  Throughput the same (92% each). Two ~70k prompts: no "memory slot" or
  purge messages this time (the bigger pool held them), but still
  serialized: 60.7 s and 145.2 s against 60.4 s alone, and the first's last
  tokens ran at 3.5 tok/s during the second's prefill. A larger n_ctx removes
  the overflow risk for ordinary chat-plus-task sizes; it does not remove
  the stall. The default stands. Worth knowing for profiles: this 9B fits
  131k context on a 12 GB RTX 3060.
- **Gaps carried out of Phase 3:** compaction in a task never run against
  a real model, and the per-turn /tokenize cost on long tasks unmeasured
  (chat-ui pays the same per send); the bench's `--runtime` time-limit
  path untested; the send-time "Run in the background" button (only
  `/task` starts one); `/task` takes text only; a task's reply arrives per
  turn, not streamed; U-c (hand a running chat to a task) is a later slice.

**Deviations.** `toolCatalogFor` takes `{ hostTools }`, not `{ serverOnly }`:
D28's exclusions (Twig, in-page sandbox, browser-held MCP) are never on this
server, so there is nothing to switch off; the only per-client part is which
host-resolved tools the caller answers, and the runner (3.5) passes its own
(ask_user, update_plan). `callToolAs` takes no `surface`: nothing on the path
reads it. **Gap for 3.5:** the runner needs the effective config for an
account outside a request; the gateway's `activeConfig` is module-private, so
3.5 needs an exported getter (or `configFor` shared) — not added yet, since
nothing uses it.

### Commit order

1. 3.1 and 3.2, behaviour-preserving, each with the existing suites
   unchanged. **Done (7d97917, 10b3766).**
2. 3.3 the store, with tests.
3. 3.4 server-owned writes, with chat-ui's 409 handling, and the rewrite
   measured.
4. 3.5 the runner against a fake model and fake tools, then 3.6 the routes.
5. 3.7 restart recovery, tested against the real daemon (smoke-style).
6. 3.8 compaction moved.
7. 3.9 chat-ui.
8. 3.10 the bench mode, then the acceptance runs.

### Acceptance (plan section 5)

Bench pass rates in `--runtime` mode match the browser-equivalent mode within
noise; a task survives a client disconnect, a model stop and start, and a
daemon restart, each as a test against the real daemon.

**PHASE 3 CLOSED (2026-11-12, at ddb34a5).** Both halves are met:
1. Pass rates: 26/32 hosted and 26/32 `--runtime` on Ornith-1.5-9B, the
   differing tasks traced to the model (three each way, inside the noise).
   One model, one run each: a second model or `--repeat 3` would tighten
   it, not gate it.
2. Survival: `test-task-survival.mjs`, against the real nestd, 3/3.
3.11 (D29's measurement) is carried as owed, with its script ready; it
informs a later default, not this acceptance.

### Decisions for the user

- **U-a (DECIDED 2026-11-12: wait for approval).** A write in a background task with no standing grant: park it for
  approval like a delete (recommended: nobody is watching, and Phase 2's
  exchange already exists), or run it because the user started the task.
- **U-b (DECIDED 2026-11-12: in the chat itself, 3.9).** The first chat-ui cut: the minimal one in 3.9 (recommended), or a
  separate task view.
- **U-c (DECIDED 2026-11-12: a later slice, not Phase 3).** "Keep going in the background", moving a running chat to a task at
  a turn boundary: in Phase 3, or a later slice (recommended: later; it needs
  the browser loop to hand over mid-flow).

---

## Phase 2 — approvals and standing grants (planned, built and closed 2026-11-12)

Plan section 5, D10 to D14, checked against the code at 31741da. Nothing
built yet.

### What exists (verified)

- **Classes:** `TOOL_CLASSES` in `daemon/tools-definitions.mjs` (read, write,
  destructive, network). Destructive today: `delete_file`, `fs_delete_file`,
  `memory_forget`, and every plugin tool until an admin promotes it
  (`plugin-install.mjs`, fail closed).
- **The server gate:** `evaluateToolPolicy` (`mcp-server.mjs`) refuses a call
  by admin bans, File System `allowWrite`/`allowDestructive`, and the plugin's
  own policy. It decides whether a call may happen at all; nothing on the
  server asks the user. `annotateTool` stamps `_meta['redstart/class']` and
  the MCP hints on every advertised tool.
- **The client gate:** `AgenticToolExec.requestPermission`
  (`chat-ui/.../agentic-tool-exec.ts`) shows the permission card unless
  `permissionsStore` holds the tool's key. The store is a `localStorage` set
  of keys `source:name` or `mcp:<serverId>:<name>`. Destructive tools always
  prompt and are kept out of "always" and "always for this server".
- **The core:** `ports.gate.approve(call, signal) → boolean`, called before
  `tools.execute` for every call except the host-resolved ones
  (`shared/agent-core/tool-calls.mjs`). The bench's gate is the task's
  `approve` policy.
- **One process:** the gateway (19080) and the MCP server (19082) are started
  by the same daemon (`ipc/server.mjs`), so an approval decided on the
  gateway can be checked by the MCP server in memory.
- **Scope keys:** `memoryKey(account)` in `memory-storage.mjs` (account id, or
  the anonymous key with auth off). Standing grants use the same keying.
- **The decision log does not exist:** `logger.mjs` has only `logAudit()`
  (five closed fields, deletions only). No `logPolicy`, no `/admin/audit`.
  Resource grants have not landed, so per D14 the log is built here.
- **Who calls destructive tools without asking (D11's check):** Yellowscript
  (`E:\redstart-yellowscript`, `src/extension.ts`) hands every Nest tool to
  its model and prompts only for its own local writes and commands. Today a
  Yellowscript model can call `memory_forget`, or `delete_file` where an
  admin enabled it, with nobody asked. Blueprints runs its own MCP server and
  calls no Nest tools. The bench approves by policy.

### Decisions this plan takes (the user's call where marked)

- **P2-a. What is enforced in Phase 2: destructive-class tools only** (D11).
  Write tools keep the client's prompt; only their standing grants move to the
  server. New tools from Phase 4 on (run_command first) are enforced from the
  start.
- **P2-b (decided by the user 2026-11-12: enforce for everyone). Yellowscript loses destructive Nest tools** until
  it speaks the handshake: its call returns "needs the user's approval" and
  the model is told so. Recommended: this is exactly the gap D5 describes, and
  the handshake is small to add to Yellowscript later (its loop already has
  an approval gate for its own writes). The alternative, exempting API-key
  callers, would leave the server enforcing nothing.
- **P2-c. Plugin tools that are destructive by default are enforced too.**
  For chat-ui nothing changes (it already prompts for every destructive call,
  one card); for an API-key client they need the handshake. An admin who
  promotes a plugin tool to write takes it out of enforcement.
- **P2-d. The card comes first, then the server.** chat-ui keeps showing its
  card in `gate.approve`; the executor turns the decision into a server
  approval (below). The server's pending approval therefore lives seconds,
  not minutes: 60 s.
- **P2-e. Standing grants for client-side tools stay client-side** (D3): the
  local File System of Twig, llama-server built-ins, frontend and custom
  tools keep their `localStorage` keys. Only Nest's MCP tools move.

### Modules

**2.1 The approval rule** (`tools-definitions.mjs`, `mcp-server.mjs`).
`approvalRule(toolName)`: `'none'` for read and network, `'prompt'` for
write, `'always'` for destructive; host-resolved tools `'none'`. A table of
exceptions beside `TOOL_CLASSES` for the day one is needed (none yet).
`isApprovalEnforced(toolName)`: rule `'always'`, or a name in `ENFORCED_TOOLS` (empty
until Phase 4). `annotateTool` adds `_meta['redstart/approval']` (the rule)
and `_meta['redstart/enforced']` (bool), so a client can tell before it calls.
**Landed f3054d4** with 2.2, 2.3 and 2.7's wire names. The keys as built:
`redstart/approvalRule` and `redstart/approvalEnforced` on a tool,
`redstart/approval` on a result, `redstart/approvalId` on the repeated call
(the plan's `redstart/approval` on the tool would have meant two things).

**2.2 The ledger** (new `daemon/approval-ledger.mjs`, pure apart from the
clock). Pending approvals in memory: `requestApproval({ accountKey, tool,
args, summary })` → `{ id, tool, summary, argsDigest, expiresAt }`;
`decide(id, accountKey, decision)`; `consume(id, accountKey, tool, args)` →
true once, for the same account, tool and digest, unexpired. `argsDigest` is
sha256 over canonical JSON (keys sorted, recursively). Bounded: at most 20
pending per account, expired ones swept on each call. Nothing persisted: a
restart drops pending approvals, which only costs a repeat.

**2.3 Standing grants** (new `daemon/approval-grants.mjs`).
`<config>/approvals.json`, `{ accounts: { [memoryKey]: Grant[] } }`, atomic
write as `memory-storage.mjs` does. `Grant = { id, tool, scope: null,
createdAt, source: 'card' | 'import' }`; `scope` stays null until run_command
(D13). `listGrants`, `addGrant` (refuses a tool whose rule is `'always'`),
`revokeGrant(accountKey, id)`, `revokeAnyGrant(id)` for an admin,
`covers(accountKey, tool)`.

**2.4 Enforcement at tools/call** (`mcp-server.mjs`). After
`evaluateToolPolicy` (an approval never beats a ban, a policy or role
narrowing: those run first and refuse first) and before the providers: if
`isEnforced(tool)`, pass when the rule is `'prompt'` and a grant covers it, or
when `params._meta['redstart/approval-id']` consumes; otherwise create a
pending approval and answer `isError` with
`_meta['redstart/approval'] = { id, tool, summary, argsDigest, expiresAt }`
and the text "This call needs the user's approval. Nothing was done." (the
model reads that if a client cannot do the handshake). `summary` is the tool
name and its arguments cut to 200 characters, for a client's card.

**2.5 Gateway routes** (new `gateway/approval-routes.mjs`, wired in
`tools-gateway.mjs` like `memory-routes.mjs`). `POST /approvals/:id
{ decision: 'once' | 'always' | 'deny' }` (account-checked; `'always'` on a
`'prompt'` tool also adds a grant, on an `'always'` tool counts as once);
`GET /approvals/grants`; `DELETE /approvals/grants/:id`; `POST
/approvals/grants/import { tools: string[] }` (2.8). Admin, on the control
plane beside the account routes: `GET /admin/approvals/grants?account=` and
`DELETE /admin/approvals/grants/:id`.

**2.6 The decision log** (`logger.mjs`, per resource-grants-plan section 7).
`logPolicy(event, fields)` with its own closed allowlist (`account`, `tool`,
`decision`, `grantId`, `capability`, `role`, `by`), the module header updated
to name the second exception. Events now: `approval.decided` for deny,
`approval.refused` (no approval on an enforced call), `grant.added`,
`grant.revoked`. Never arguments, paths or summaries. `GET /admin/audit`,
owner-only, paged, newest first, on the control plane. The launcher panel is
a later item (gap below).

**2.7 Shared handshake helpers** (new `shared/agent-core/approval.mjs`).
`APPROVAL_META_KEY`, `APPROVAL_ID_META_KEY`, `approvalRequired(mcpResult)` →
the pending object or null. Used by chat-ui and the bench, and by the Phase 3
runtime. The loop itself does not change (D2): the handshake is the host's
executor turning a gate decision into a server approval.

**2.8 chat-ui.**
- `mcp-tool-ops.ts executeTool`: if the result is `approvalRequired` and the
  card already approved this call (the gate's decision, kept on the session
  by tool-call id), POST the decision and repeat the call once with the
  approval id. A deny never reaches the server as a call (the core stops at
  the gate), so it is posted only when the server asked.
- `permissionsStore`: for keys of Nest's MCP server, `hasTool` reads a cache
  of `GET /approvals/grants` (loaded with the tool list, refreshed after a
  decision or a revoke); `allowTool` and `revokeTool` call the routes. Other
  keys stay in `localStorage`. With auth off the anonymous scope is shared,
  as memories are, and the settings say so.
- One-time import: Nest MCP keys found in `localStorage` go to
  `/approvals/grants/import`, which drops anything not `'prompt'`; a flag in
  `localStorage` stops it repeating; the keys leave `localStorage` on success.
- `SettingsChatToolsTab.svelte`: unchanged UI, now per account.

**2.9 The bench.** `nest-client.callTool` answers a `approvalRequired` result
when the task's `approve` policy allows the tool: POST `once`, repeat. A
policy that refuses never posts. So the bench exercises the handshake on
every destructive call.

**2.10 Docs.** `security.md`: what the ledger protects (D5, said plainly: the
user from the model, not the server from the user), the enforced set, the
Yellowscript consequence, auth-off scope. `tool-namespacing.md` or the MCP
notes: the two `_meta` keys.

### Commit order

1. 2.1 + 2.2 + 2.3 with unit tests, nothing calling them.
2. 2.6 `logPolicy` and `/admin/audit` (standalone, per the grants plan).
3. 2.4 + 2.5 + 2.7: enforcement on, with the routes. chat-ui breaks for
   destructive tools until commit 4, so 3 and 4 land together.
4. 2.8 chat-ui handshake, store and import.
5. 2.9 bench handshake, then a bench run (the destructive tasks: docs-rename
   uses run_python, so a new task is needed, see Tests).
6. 2.10 docs, and the Yellowscript note in its repo's backlog.

### Tests

- The ledger: an approval for one argument set refuses another (digest
  binding), expiry, single use, another account's id refused, the bound.
- Grants: per account, auth-off anonymous key, `addGrant` refuses an
  `'always'` tool, admin revoke, atomic write survives a torn file.
- Enforcement (`scripts/test-*.mjs` against the real MCP handler): an
  enforced call with no approval does nothing and returns the payload; with
  a consumed approval it runs; a second use is refused; a ban or
  `allowDestructive: false` refuses first, even with an approval; a grant
  covers a `'prompt'` tool and never an `'always'` one; tools/list carries the
  two `_meta` keys.
- logPolicy: only allowlisted fields reach the file; arguments never do.
- chat-ui: the executor posts and repeats once; a deny does not call; the
  store reads server grants for Nest keys and `localStorage` for the rest;
  the import drops a destructive key and runs once.
- Bench: a fake Nest that demands approval; a new task (p2-delete-confirmed:
  delete one named file with `delete_file` where the account allows it), and
  the harness test that a refusing policy never posts.

### Gaps carried in (to notate as they land)

- The launcher panel for `/admin/audit` (route first).
- Yellowscript's handshake (its repo).
- Grant scope stays null until run_command (Phase 4).
- An approval is bound to the arguments, not to the file's state: a file can
  change between the card and the call. Say so in security.md.

---

## Phase 1 — asking and planning (built 2026-11-11, measured and closed 2026-11-12)

The plan's §4 is already at module level. This section records what was
checked against the code on 2026-11-11 (head 827933f) so the phase can start
without re-reading it, the commit order, and what has to be true first.

### Before the first commit

1. **A clean "before" row at 30 turns.** The user restarts Nest (three daemon
   fixes are not live until then) and reruns the 4B, then the 35B. Phase 1's
   acceptance is a comparison, and every row so far ran at 10 turns or before
   the tool-error fixes. Without this, a Phase 1 gain cannot be told from
   the gain of e4bf187/02b0091/a81e0b6.
2. **The noise run** (3 repeats, one model: `--repeat 3`). Still not done
   since 0.3. "No task regresses beyond the noise" has no number until it is.
3. Not blocking: the bench account. The run works on the owner's key; the
   bench no longer deletes anything it did not create.

### Touch points, verified

| plan item | where it is today |
|---|---|
| core routes a host-resolved tool like `gate.approve` | `shared/agent-core/tool-calls.mjs:171` (the gate call, with signal, then `yieldToHost`). `AgentPorts` in `types.d.ts:138`; a new optional `ask` port goes beside `gate` |
| provider with definitions only | `BUILTIN_PROVIDERS`, `daemon/mcp-server.mjs:58`. New `daemon/interaction-tools.mjs`; `tools-definitions.mjs` and the namespacing contract (`test-tool-namespacing.mjs`) need the names |
| pinned in retrieval | `daemon/tool-retrieval.mjs:263` (`pins`), fed from `tools-gateway.mjs` near 671 |
| system prompt line | `daemon/system-prompt.mjs`, the section list near 787 |
| `pendingQuestions` beside `pendingPermissions` | `src/chat-ui/src/lib/stores/agentic/agentic-session.svelte.ts:42`; set and cleared in `agentic-tool-exec.ts:93-131` |
| reload resumes an unanswered question | `chat-message-ops.svelte.ts:260` (`continueAsNextAgenticTurn`), reached from `continueAssistantMessage` at 303 |
| plan stored on the conversation | `daemon/gateway/conversation-routes.mjs:84` (the PUT and its validation) |
| bench answers a question | `task.answers` is already loaded and validated (`task-file.mjs:93`); three p1 tasks carry it. The bench has no `ask` port yet |
| checks | `tasks/checks/lib.mjs:92`: `asked()` is true when the event log has a `tool_call` named `ask_user`. The bench's ask port must log one |

### Commit order

1. **1.1a core:** the `ask` port and the routing in `tool-calls.mjs` (answer,
   dismiss, abort, steering-as-answer). `test-agent-core.mjs`. No host uses
   it yet; existing suites unchanged.
2. **1.1b Nest:** `interaction-tools.mjs`, definitions, namespacing, the
   pin, the prompt line. Provider conformance. From here every chat request
   carries the tool, so chat-ui must answer it in the same PR, not later.
3. **1.1c bench:** the ask port from `task.answers` (substring match on the
   question; `""` matches any; no match is the dismissal text). Logs the
   `tool_call`/`tool_result` pair. Fixture task in `test-agent-bench.mjs`.
4. **1.1d chat-ui:** `pendingQuestions`, the card, the reload-resume path.
   Unit tests for the card and the resume.
5. **Measure 1.1** on both models before any plan work: p1-ambiguous-units
   and p1-which-draft should move; nothing else should.
6. **1.2a core:** `update_plan` handling, the tail block, the single
   completion check. **1.2b** storage + validation. **1.2c** checklist UI.
   **1.2d** bench: the plan lives in the run, no storage.
7. **Measure 1.2 as U5 asks:** three variants (no plan, tool only, tool plus
   completion check), which needs a bench flag to turn each off.

### Things the plan does not say, found while preparing

- **`ask_user` is one more tool a 4B can misuse.** Today's run shows it
  stopping to ask the user in prose after one tool error ("could you confirm
  the path?"). With `ask_user` offered it may ask instead of retrying. The
  prompt line must say "not for things a tool can find out", and the measure
  step should count ask_user calls on the 20 tasks that should never ask.
  Add that count to the summary in 1.1c.
- **p1-which-draft could not be reached before today.** The 4B never opened
  the drafts (read_document by bare name). After e4bf187 it will, and the
  task then measures what it was written for. Its "before" result on the
  rerun is the honest baseline, not today's.
- **A dismissed question in the bench.** A task with no `answers` gets the
  dismissal text. That is the right behaviour for the 20 non-asking tasks
  and makes an unnecessary question cost a turn, visibly.

### What landed

| piece | commit | tests |
|---|---|---|
| 1.1a core `ask` port | 33f0fdb | `test-agent-core.mjs` 47 (7 new); routing removed fails 5; chat-ui 768/768 unchanged |
| 1.1b Nest serves ask_user | 810790c | conformance `interaction` provider (session gate removed fails 2), namespacing, retrieval pin, prompt line |
| 1.1c bench answers it | 401b3e8 | `test-agent-bench.mjs` 37 (fixture `asks`: choice, dismissal, malformed), core `invalid` hook |
| 1.1d chat-ui card + resume | adb658e | `ask-user.test.ts`, 4 loop tests (port removed fails 3), browser card test; chat-ui 780/780, client 52/52 |
| 1.2a core update_plan + Nest serves it | 1381985 | `test-agent-core.mjs` 57 (10 new; no nudge fails 2, no tail note fails 3), conformance, prompt line |
| 1.2b plan on the conversation | 689111a | `test-projects.mjs`: normalised, stamped, refused whole, cleared by null |
| 1.2d bench plan + `--plan` | 6e858ca | `test-agent-bench.mjs` 39 (fixture `plans`: note, one nudge; `--plan tool`, `--plan off`) |
| 1.2c chat-ui plan port + checklist | e64a919 | loop test (save, tail, one nudge), `planProgress`, browser checklist test |
| docs (security.md, namespacing, prompt spec) | 5851604 | — |
| fix: tool results kept on the path after a reload | f4658ca | `tool-result-chain.test.ts` 8 (repair removed fails 4) |
| bench: 5 more Phase 1 tasks (29 total) | 5206b5f | `test-agent-bench-tasks.mjs` 35 (right/wrong per task + 8 edges) |
| bench: request deadline, two checks fixed, `probe-ask.mjs` | a6f864f | `test-agent-bench.mjs` 40 (hung upload; deadline removed hangs) |
| dev: warn on a stale chat-ui build | 457b73a | — |

1.1a: `ask_user` skips the gate (asking needs no approval), and the
person's answering time is not counted as tool time.

### Deviations (Phase 1)

- **Host-resolved tools are offered per MCP session, not to every client**
  (1.1b). The plan had Nest serve ask_user to everyone and asked that chat-ui
  answer it in the same PR. That still left Yellowscript, Twig's own loop and
  third-party MCP clients holding a tool that can only fail. A client now
  declares at initialize which ones it answers
  (`capabilities.experimental['redstart/hostTools'].names`), mcp-server keeps
  it on the session, and tools/list offers only those. It also removed the
  "land 1.1b-d together" constraint: with no client declaring, nothing
  changed. search_tools and the Tools tab estimate never see these tools.
- **The plan note and the nudge are a separate user-role message at the end
  of the request**, marked "[Automatic note, not from the user]". The plan
  says "a short Current plan: block after the last message". A trailing
  system message breaks some chat templates (Qwen's expect the system message
  first); appending to the last message's text would make it look like the
  user or a tool said it. Sent with that request only, never in `messages`,
  so the history and the cached prefix are untouched.
- **The completion check saves the early answer as its own assistant turn.**
  In chat-ui that is two assistant messages in a row in the stored chat (the
  nudge is not stored). The plan does not say how the nudge is persisted;
  storing a message the user did not write seemed worse.
- **Two additive core port hooks the plan did not have:** `ask.user` and
  `plan.save` receive the call, and `ask.invalid` / `plan.invalid` fire for a
  malformed call the loop answered without the host. The bench needs both to
  log every call.
- **A message typed while a question is open answers it, unless it carries
  attachments**, which cannot be a tool result: then it is queued as steering
  as before and the question is dismissed.

### The first Phase 1 runs (2026-11-11, by the user, `--plan off`)

4B (results T21-53-45): 62%, 0 ask_user calls. 35B (T22-14-31): 86%, 1
ask_user call (p1-answer-steers, with four sensible options; passed). The
35B's first attempt (T22-00-58) hung for five minutes in a task's setup
with every slot idle, then died with a bare "fetch failed".

**Why ask_user is rarely called: measured, not guessed.**
`scripts/agent-bench/probe-ask.mjs` replays each must-ask task at the
moment its files have been read, straight to llama-server, with Nest's own
tool definitions and composed prompt, 5 samples a cell, varying only the
wording. 35B, thinking off:

| decision point | V0 now | V1 no prompt line | V2 positive wording | V3 user invites questions | V4 positive + invite |
|---|---|---|---|---|---|
| order ("I have an order in mind") | 5/5 tool | 3/5 tool | 3/5 tool | 4/5 asks in text | 4/5 in text |
| units | 0 | 0 | 0 | 5/5 tool | 1 tool, 1 text |
| which draft | 0 | 0 | 0 | 1 in text | 3 in text |
| which vendors | 0 | 0 | 0 | 0 | 1 in text |

What it says:
1. **Delivery is not the problem in the bench.** The model has the tool and
   uses it when it sees a gap (order, and units once the user invites
   questions).
2. **Our wording is not the lever.** Dropping the prompt line (V1) or
   rewriting both in positive terms (V2) leaves the three silent tasks at 0.
   The cautionary line was suspected; it is not what stops it.
3. **It is the model's judgement of ambiguity.** On units, drafts and
   vendors it decides for itself (Celsius from the value range, "fix both",
   "all three") and goes to work. That is a disposition from training, not
   something the tool schema controls.
4. **A conversational cue gets a conversational question.** Once the user
   says "ask me if anything is unclear", the 35B asks far more, but mostly
   in its reply text, not through the tool. In chat that is answered the
   same way; in the bench and the Phase 3 runtime it ends the run.

**In chat-ui the tool really was missing.** The user's test chat ("please
use the ask_user tool" → "I don't have access to an ask_user tool") ran the
page llama-server serves, `src/chat-ui/dist`, built 09:46, before adb658e.
That build never declared redstart/hostTools, so Nest never offered the tool
and the model was right. `npm run dev` hot-reloads the admin window only.
Fixed by `npm run build:chat`; dev-shell.mjs now warns when dist is older
than its source.

Also fixed from these runs: the bench gives every setup/read-back call a
deadline (default 180 s, `--request-timeout`) and a stuck call fails only
that task, naming the call; p1-stop-and-report accepts "not updated" and now
requires the email's three prices in the workspace file (the 35B wrote its
update to the File System root, which could have passed on wording alone);
p1-assume-on-skip reads every assistant turn and accepts stated reasoning
("consistent with Celsius"), but still fails a guess stated as fact.

### Gaps carried forward (Phase 1)

- **ask_user under-use is a model judgement, unsolved.** Thinking on does
  not help (35B, 3 samples, V0: units/drafts/vendors 0/3; order 1/3 tool,
  1/3 in text, against 5/5 tool with thinking off). Not yet tried: the 4B
  through the probe (`node scripts/agent-bench/probe-ask.mjs` with it loaded),
  and treating a reply that ends in a question as an ask (the bench would
  answer it from `answers`; Phase 3 would park on it). The last changes what
  Phase 1 measures, so it waits for the user's call.

- **Measure 1.1 and 1.2: not done. Needs the user's machine** (a model
  loaded, Nest restarted on this build, the bench account key). Order, from
  the commit-order list above: both models with `--plan off` first (that is
  the 1.1 measure: p1-ambiguous-units and p1-which-draft should move, nothing
  else should, and the `ask_user:` summary line counts unneeded questions as
  "unanswered"); then U5's three variants on the 4B, `--plan off`, `--plan
  tool`, `--plan full`, then the 35B on full. run.mjs warns if Nest did not
  offer ask_user (an un-restarted Nest). The results-table row does not carry
  the plan mode; put it in `--model-label` (summary.md's header has it).
- **U5 is still open.** If `update_plan` lowers the 4B's pass rate, the plan
  says to gate it per profile. No such setting exists yet; it would decide
  whether chat-ui declares `update_plan`.
- **Nothing tried in the running app.** No chat has shown the question card or
  the checklist with a real model; the browser tests only mount them.
- **A stale plan keeps steering.** While steps are open every request carries
  them and each flow's first answer gets one nudge, including on a new topic.
  The checklist's × clears it; steps never expire. In security.md Known gaps.
- **Fixed 2026-11-11 (after Phase 1): tool results after a reload.**
  chat-send made every result a child of the assistant message (siblings), and
  filterByLeafNodeId follows parents only, so a reloaded reply with several
  calls kept only its last result and the next request carried calls with no
  result. Now chat-send chains them (utils/branching createToolResultChain),
  and filterByLeafNodeId restores sibling results of chats stored before:
  only tool-role children of an assistant on the path, answering one of its
  calls, one per call id. `tests/unit/tool-result-chain.test.ts`. Tool
  messages have no branch controls, so the navigation UI is unaffected.
- **Five Phase 1 bench tasks added 2026-11-11** (29 tasks): p1-answer-steers,
  p1-pick-vendors, p1-assume-on-skip, p1-plan-per-city, and
  p1-simple-stays-simple, a guard that fails if either tool is used on a
  one-number question. Before-rows for the 24 do not cover them; their first
  `--plan off` run is their baseline.
- **A forked conversation does not carry its plan** (POST /conversations
  ignores the field).
- **The daemon runtime (Phase 3) has no ask or plan port yet**; the plan says
  it will park a task on a question.

