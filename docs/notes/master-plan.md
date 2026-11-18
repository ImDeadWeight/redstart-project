# Redstart — the plan, in order

Written 2026-11-17, from an architecture review the user asked for ("we have
some technical debt and have maybe built some idiosyncratic structures that
might work against the way other modern systems are running"). It replaces
the first draft of this review (same day) and puts every open piece of work in one
order. **This file says what comes next and why. The detail stays in each
phase's own plan**, named under "Detail". Where this file and an older plan
disagree, this file wins, and the older plan's section is marked superseded
when the phase starts.

**Status: final, 2026-11-17.** Every decision it raised is settled (see
"Decisions", at the end). New questions found while building go in the
phase's own plan, the way they always have.

Tracked in git (re-included in `.gitignore`), like the agent-runtime plan.
Pull before editing.

**Separate, not a phase:** `testing-checklist.md`, the things already built
that a person still has to use. It runs alongside every phase. A phase that
changes a feature updates its items there.

Ground rules: one phase at a time; re-plan a phase to module level when it
is reached, against the code as it is then. **Verification (changed by the
user 2026-11-17, during Phase 3: the full chain on every commit cost too
much time):**
- Every commit runs `npm run typecheck && npm run check:mjs`, plus the suites
  that cover what it touched, and their callers' suites when an interface
  changes. chat-ui's `check` and vitest run only when chat-ui changed.
- A change to a boundary (auth, approvals, bans, path scope, the gateway's
  rewrite) also runs the suites that guard that boundary.
- The full `npm run test:security` runs once at the end of each phase, and
  before any push.

A new or removed suite changes both `package.json` and
`ci.yml`; gaps go in the phase's implementation doc, and in `docs/security.md`
→ Known gaps when a user could be affected.

---

## The direction, in one sentence

> **Nest is the shared AI server for a household or office: models, people,
> policy, shared data and background work. Clients are where your own machine
> is. There is one agent loop, and over time it lives on the server.**

A feature that does not clearly fit one side of that is the signal to stop and
ask. D45 (agent-runtime plan §11) is the tool-placement half of it.

---

## Summary

| # | Phase | Size | Detail | Waits on |
|---|---|---|---|---|
| 1 | Retrieval only on Redstart's own surfaces | S | this file | — |
| 2 | Remove the Nest terminal | S | agent-runtime plan §11, U11 revised | — |
| 3 | Fewer tools, a fixed set, a deferred catalog | M | this file; tool-retrieval-fixes docs | a model loaded for the runs |
| 4 | Split the long host functions | M | this file | 3 (the gateway half) |
| 5 | Skills and AGENTS.md | M | this file; workflows-plan, projects-plan | — |
| 6 | Resource grants, then shared document search | L | resource-grants-plan, rag-plan, chat-tooling 5b | — |
| 7 | The loop moves to the server | L | this file; agent-runtime §6 Phase 7 | — |
| 8 | Twig terminal, sandboxed | L | agent-runtime §11 Phase 9 | 7's step 3 (U14) |
| 9 | Deployment validation on real hardware | M | deployment-validation-plan | a Linux box and a second Windows box |
| 10 | A container runner on headless Linux Nest | L | this file | 9 |
| — | Later and parked | | "Later and parked" below | |

Phase 9 is hardware-gated, not order-gated: it runs whenever the hardware is
there.

---

## Phase 1 — Tool retrieval only on Redstart's own surfaces

The gateway applies retrieval to any client that does not send
`redstart_retrieval: false`, which Kilo Code and Continue never send. A coding
agent's own tool list must not be rewritten under it. Retrieval (and whatever
of it survives Phase 3) runs only for `nest-chat` and `twig` surfaces, as the
credential says. Bans still apply to every client. A correctness fix, so it
goes first.

**Detail:** this section. Touches `tools-gateway.mjs` (`prepareCompletion`)
and `test-gateway-routes.mjs`.

**Built 2026-11-17.** `retrievalSurface()` in `tools-gateway.mjs`; the test
is "retrieval runs only on Redstart's own surfaces" in
`test-gateway-routes.mjs`. *Deviation:* "as the credential says" alone was
not enough. With login off there is no credential, and the agent bench uses
an account-wide key, which names no surface, so neither could have retrieval
at all. A request can therefore also ask with the literal
`redstart_retrieval: true`. That is as safe as opting out, because retrieval
only narrows the post-ban list. chat-ui, the task runner and the bench
(`--retrieval server`, and its probe) send it. `false` still wins on any
surface. *Behaviour change:* a Blueprints or Yellowscript key, or any
account-wide key, no longer gets retrieval unless it asks for it (connector
contract §2). *Gap:* none open. A human check of the Kilo/Continue case is in
`testing-checklist.md`.

## Phase 2 — Remove the Nest terminal

Decided 2026-11-17 by the user. About 2,400 lines across 50 files for one job
(an owner's background task running a program on the host) that nothing has
needed, and the most dangerous surface Nest has, with no sandbox (D20).

**Detail:** agent-runtime plan §11, "U11 — REVISED": the removal list, and
what Phase 8 keeps (`shared/command-exec.mjs`, the `execute` class, and
chat-ui's per-command card, since U12 is (c)). The Phase 4 items in
`testing-checklist.md` are already dropped.

**Built 2026-11-17**, in three commits: `ac15116` (server side), `9bbf4a2`
(chat-ui and the shared scope helpers), and the bench/leftovers commit (p4
tasks now measure workarounds, `changedFiles`' `skipDirs` dropped). Kept:
`shared/command-exec.mjs`, the `execute` class. *Deviation, decided by the
user while building:* chat-ui's per-command card went too. It turned out to
be a cache of Nest's server-side run_command grants, not a client rule, so
it had nothing to give Phase 8's (c). *Gaps:* none new. The executor's
macOS kill path and `isolation: 'none'` carry to Phase 8 (implementation
doc, "Phase 4", top).

## Phase 3 — Fewer tools, a fixed set, a deferred catalog

### Why

B0 (Ornith-1.5-9B, 2026-11-14, 41 tools): retrieval on passed 81% against
76% off, inside the noise of two identical runs, at 30 cache-miss turns
against 1 and 33.0 s per task against 29.3 s. The real gain was the first
tool chosen (87/95 against 65/94), and the results doc names its cause: "most
of P3 is caused by the File System tools being in the list at all." On
llama.cpp the tool list is at the front of the prompt, so any change to the
set is a full prefill (no partial reuse at all on a hybrid model like
Ornith).

Current agent systems keep a small, stable set in the prompt, put the long
tail in a catalog the model searches, and call what it finds through a
dispatcher. Discovered tools then arrive in a tool result at the tail, and
the prefix never changes. Phase 5's skills do the same for instructions.

### 3.1 Consolidate

- **File System: 13 upstream tools → 5, deferred.** Offer `read_text_file`,
  `list_directory`, `search_files`, `write_file`, `edit_file`; the provider
  filters the rest, fail-closed (as the dependency refresh already filters
  new upstream tools).
- **Core, fixed for the conversation (about 14):** `ask_user`, `update_plan`,
  `memory_save`, `memory_search`, `memory_forget`, `list_documents`,
  `read_document`, `create_document`, `search_documents`, `run_python`,
  `web_search` and `web_fetch` (when web is on), `search_tools`, `call_tool`.
  Capabilities and roles still decide membership; bans still strip.
- **Deferred (catalog only):** File System, Git, SQLite, Postgres, Vault,
  Scholar, every plugin tool. A provider declares `deferred` in its metadata;
  the admin can flip it per capability in the Tools tab. (This is the first
  field of the provider manifest `PLUGIN-SYSTEM-PLAN.md` proposes; build it
  there if that plan is picked up at the same time.)
- `describe_tool` folds into `search_tools`' result, unless arm C (3.2)
  shows Ornith's `call_tool` arguments get worse without it.
- `FILE_SYSTEM_TOOLS` moves out of `shared/agent-core/attachment-note.mjs`:
  the provider exports its own list and the host passes it in.

### 3.1 at module level (re-planned 2026-11-17, against the code after Phase 2)

Five commits, in this order. Each passes the checks, and none deletes
retrieval: 3.3 does that after 3.2.

1. **File System 13 → 5.** `FILESYSTEM_TOOL_NAMES` in
   `filesystem-mcp-provider.mjs` becomes the five, so the provider's
   existing fail-closed filter drops the other eight.
   `BUILTIN_CAPABILITY_TOOL_NAMES.file_system` and `tool-metadata.mjs`
   follow. `delete_file` (Redstart's own, `fs-delete-tool.mjs`) is
   unchanged, still behind `allowDestructive`.
2. **`FILE_SYSTEM_TOOLS` out of `attachment-note.mjs`.** `attachmentNote`
   takes `fileSystemTools` from its host. chat-ui passes the names whose
   tools/list `_meta['redstart/capability']` is `file_system`; the bench
   passes the provider's list.
3. **`deferred`, per capability.** A default on each `BUILTIN_CAPABILITIES`
   entry (true for file_system, git, sqlite, postgres, vault, scholar) and
   true for every plugin. An admin override is stored with the capability's
   settings (`capabilities[id].deferred`; a plugin's in its registry
   record), set over IPC and flipped in the launcher's Tools tab. tools/list
   stamps `_meta['redstart/deferred']`, and chat-ui leaves a deferred tool
   out of the attachment note's "offered".
4. **The catalog mode: `tools.retrieval.mode: 'catalog'`** (the existing
   selection is `'select'`, still the default until 3.2 decides). On a
   Redstart surface (the Phase 1 rule), the gateway strips deferred tools
   after bans, with no embedder and no per-turn state. `search_tools` and
   `call_tool` are advertised, with no `callTool` flag needed in this mode.
   `describe_tool` is not advertised: a search row carries the tool's
   `inputSchema`, and the reply says to call it through `call_tool`. The
   prompt's narrowing disclosure names the catalog. `retrievalConfigSummary`
   records `mode=catalog`, so a bench row says which arm ran.
5. **`call_tool` carries approval (U-S6, decided by the user 2026-11-17).**
   Through `call_tool`, every inner tool whose rule is not `none` is enforced
   by Nest through the existing handshake (`approvalGate` on the inner name
   and arguments; the approval id is passed through). That is stricter than
   a direct call, so no client can write through it without a decision or a
   grant. chat-ui's gate and card treat `call_tool` as its inner tool (name,
   arguments, destructive or not, "Always allow" keyed on the inner tool's
   permission key). **This is an exception to U-S1's freeze on the browser
   loop host, recorded as one:** without it, arm C cannot write a file in
   chat. The task runner's gate unwraps `call_tool` the same way. The bench
   answers the server's approval by its task policy.

**Arm A runs on `a48d130`** (tagged `phase3-arm-a`): it is "today", and
commit 1 changes the File System set it measured. Arms B and C run on the
tip after commit 5. B: `--retrieval off`. C: `mode: 'catalog'`.

**3.1 built 2026-11-17:** `4608b02`, `3890b16`, `6a5a296`, `6fcb71c` and
the call_tool commit. *Deviations:*
- File System serves **six**: `create_directory` stays, because upstream's
  `write_file` fails under a missing folder.
- The deferral override is **one map** in `tools.json` (`deferral`, keyed by
  capability or plugin id), not a field on each capability record and
  plugin record.
- The retrieval eval was refrozen twice against a local bge sidecar: 88/92,
  against 90/93 before. The new miss is `s-config`; `u-fs-move` went, since
  no tool can rename now.
- `search_tools` in the catalog mode also answers an **exact tool name**
  with that one row, which is how its no-schema category fallback leads to
  a schema.

*Gaps:*
- Nothing in 3.1 has been used in the running app. `testing-checklist.md`
  has the items: the catalog card through `call_tool` in chat, the Tools
  tab's two new controls, and a background task's held approval.
- The browser host was changed under U-S6, an exception to U-S1:
  `agentic-tool-exec.ts` `gateToolName`. Phase 7 moves it to the server
  with the rest.

### 3.2 Measure, before deleting anything

The 32-task set ×3 on Ornith, plus `measure-tool-cache.mjs`:

| Arm | In the prefix | Discovery |
|---|---|---|
| A (today) | retrieval on, `growth: scored` | search_tools pins |
| B | the 3.1 set, retrieval off | none |
| C | the 3.1 core only, fixed | search_tools + call_tool; prefix never changes |

**Before arm A, check the Ornith profile's `growth` setting.** Since the B4
set-up on 2026-11-14 it has been `pins-only` (`profiles.json`; the backup
from before the change is `profiles.backup-2026-11-14-before-B4.json`).
Set it back to `scored` for arm A so the run matches B0, or run it as is and
label the row `pins-only`. Change only that field: restoring the backup
would undo every other profile change made since.

**How to run the three arms** (written 2026-11-17, after 3.1). Ornith
loaded, the bench account's key in `REDSTART_BENCH_API_KEY`, and the bench
and measure scripts always run **from the tip checkout**. They only talk
HTTP. The tip's scripts ask for retrieval (`redstart_retrieval: true`),
which an account-wide key needs since Phase 1. `phase3-arm-a`'s own
`measure-tool-cache.mjs` does not, so its "server" variant would quietly
measure "off".

| Arm | Nest runs from | Nest → Tools → Tool retrieval | Commands, from `redstart-nest/` at the tip |
|---|---|---|---|
| A | a worktree at `phase3-arm-a` | on; profile `growth` set back to `scored` (above) | `node scripts/agent-bench/run.mjs --model-label "Ornith-1.5-9B arm A" --repeat 3 --expect-retrieval scorer=fused,growth=scored`, then `node scripts/measure-tool-cache.mjs` |
| B | the tip | on, How: per conversation (it is bypassed) | `... --model-label "Ornith-1.5-9B arm B" --repeat 3 --retrieval off`, then `node scripts/measure-tool-cache.mjs` (read its `off` rows) |
| C | the tip | on, How: "Fixed list, the rest in a catalog"; Catalog-only tools as the defaults | `... --model-label "Ornith-1.5-9B arm C" --repeat 3 --expect-retrieval mode=catalog`, then `node scripts/measure-tool-cache.mjs` (read its `server` rows) |

For the worktree, remove its `node_modules` junctions with `rmdir` before
`git worktree remove`: that removal once wiped chat-ui's dependencies.
Arm C's runs also log `innerArgsProblem` for every `call_tool` call
(benchmarks H3). That count decides whether `describe_tool` comes back (3.1).

**Bar (U-S3, DECIDED 2026-11-17, as proposed):** B or C within noise of A
(≥ 76%) with ≤ 2 cache-miss turns per run. C over B on a tie, because C
keeps working when an admin installs ten plugins. **If neither passes:**
keep the turn-1 selection, freeze it for the conversation (no growth; new
tools only through `call_tool`), and still do 3.3's scrap list except the
scorer and `selectTools`' budget, which the turn-1 selection needs.

**3.2 measured 2026-11-18 (run by the user; numbers in
`agent-bench-results.md`, "Master plan 3.2"):** A 80.2%, B 81.3%, C 76.0%,
cache-miss turns 23 / 0 / 0. Both pass; a tie, so **C, the catalog mode,
wins.** *Deviations:* arm A ran on the tip's Nest, not the tag (per-turn
selection over the 3.1 set); the bar is B0's 76% floor, so it does not
change the call. C's p2-delete-confirmed check counted only direct
`delete_file` calls; fixed, two runs rescored (74% → 76.0%). `describe_tool`
stays folded (0 bad `call_tool` arguments). *Gap:* the 32-task set reaches
the catalog 8 times, all File System; no task finds a plugin tool through
it.

### 3.3 Keep and scrap (once 3.2 passes)

Keep: `search_tools`, `call_tool` and the catalog, with one scorer (`fused`,
fixed; the bge sidecar stays for `search_documents`); bans and
`enforceToolAllowList`; the conversation-start decision and D40's "no change
mid-conversation"; the `x-redstart-retrieval-config` header (H1) so bench
rows still record what ran.

Scrap: per-turn re-selection and the `growth` modes; the scorer switch and
`textVersion: 2`; `selectTools`' budget, floors, margin, `minTools` and family
expansion; `createSelectionMemory`; the attachment prior (fixes 3.3);
`redstart_retrieval_withhold` once arm C has run; their settings, IPC
validators, Tools-tab controls and tests. `tool-retrieval.mjs` should go from
~930 lines to ~250.

### 3.3 at module level (planned 2026-11-18, after 3.2 chose C)

"On" now means the catalog; there is no mode. `tools.retrieval.enabled` is
the only field read (on by default since 2026-11-18; only `false` turns it off); the profile's old fields
(`mode`, `scorer`, `growth`, `textVersion`, floors, `minTools`, `callTool`)
are ignored where they lie. The attachment prior was never built (held in
the fixes plan), so nothing goes for it. Three commits:

1. **The consumers stop asking for selection.** Bench: `withhold` goes
   (task-file refuses it with a pointer here), so do the eight p5 tasks
   built on it and their checks (B3, replaced by arm C); the origins and
   would-add headers are no longer read; `--expect-retrieval` keys shrink to
   `mode`. `measure-tool-cache.mjs` drops its "came in" and "would add"
   columns. The retrieval eval keeps its ranking cases (`searchTools`, which
   `search_tools` runs) and drops the selection cases and the scorer, text
   and floor flags.
2. **The server.** Gateway: the catalog branch is the only one;
   `redstart_conversation_id` and `redstart_retrieval_withhold` are still
   consumed (chat-ui and older benches send them) and ignored. Headers
   `x-redstart-tools-origin` and `-would-add` go; `-retrieval-config` reads
   `mode=catalog`. `tool-filter.mjs` keeps the vector store, the fused
   ranking (fixed, with fused's floors as constants), `searchTools`,
   `rankForSearch`, `keywordSearch` and the wire cost.
   `tool-retrieval.mjs` keeps the tool text, hashes, the store, cosine,
   BM25 and RRF. `search-tools-provider.mjs` serves only `search_tools`
   (with schemas) and `call_tool`; `describe_tool` goes (3.2: no bad
   `call_tool` arguments). `mcp-server.mjs` stamps deferred whenever
   retrieval is on. The prompt keeps the catalog wording and the
   "no way to search" fallback.
3. **The launcher.** The Tools tab's "How" select goes; the deferral card
   shows whenever retrieval is on. `types.ts` follows.

**3.3 built 2026-11-18:** `d767beb`, `0abbcbf`, `4b346cd`. `tool-retrieval.mjs`
932 → 465 lines, `tool-filter.mjs` 594 → 252, `search-tools-provider.mjs`
378 → 248, `test-tool-retrieval.mjs` 1823 → 1083. *Deviations:*
- `tool-retrieval.mjs` is 465 lines, not ~250: BM25 and the RRF stay,
  because `search_tools` ranks with them (keep list: "one scorer, fused").
- Four p5 tasks stay, none with `withhold`: `p5-vague-config`
  (read_text_file is deferred, so it is a catalog task; a test holds that)
  and the three drift tasks. Seven went, six for withholding a core tool and one a
  duplicate of p2-delete-confirmed.
- The retrieval eval is search cases only (32). The 28 selection cases and
  the bench tasks loaded as them went: nothing in production ranks a
  conversation now. Refrozen against Nest's bge sidecar: the same 28.
- `stripAttachmentNote` went from shared/agent-core (only the text
  version 2 query used it).
- The Tools tab's status no longer says "every tool is still being sent"
  while the search model loads: the catalog needs no embedder, and
  search_tools matches by keyword until it is ready.

*Gaps:*
- ~~Retrieval is still off by default (D8).~~ **Decided 2026-11-18 by the
  user: on by default**, unless the benchmarks say otherwise (3.2's catalog
  arm passed the bar). Only an explicit `enabled: false` turns a profile off.
- The launcher changes have not been clicked (`testing-checklist.md`,
  "Tool retrieval: the catalog").
- No task finds a plugin tool through the catalog (3.2's gap, unchanged).
- A profile keeps its old retrieval fields in `profiles.json`; they are
  ignored, not removed.

**Detail and what this supersedes:**
- `tool-retrieval-fixes-benchmarks.md`: B1, B2, B4, B5 are not run (they tune
  what 3.3 deletes); B3 is replaced by arm C; H6 and H7 are not built; B0's
  rows stay as arm A's baseline.
- `tool-retrieval-fixes-implementation.md`: its "Held" rows are decided by
  3.2, not by B1 to B7.
- `tool-retrieval-plan.md` / `-implementation.md` (first pass): D8 (off by
  default) stands until 3.2 says what "on" means.
- `context-budget-implementation.md` item 3 (the retrieval tool budget) is
  moot once the set is fixed. That branch is shelved; when it is picked up,
  drop item 3.

## Phase 4 — Split the long host functions

Reviewed 2026-11-17. **Agent-core itself is in good shape:** thirteen files,
none over 380 lines, each one concern, no Svelte/DOM/Node. The weight is in
two long functions inside it and in the hosts.

| Where | Problem | Change |
|---|---|---|
| `daemon/task-runner.mjs` `runOnce` | ~380 lines, one function: wire messages, every port, callbacks, resuming dangling calls | `task-ports.mjs` (one builder per port, testable alone), `task-resume.mjs` (closing and re-running what a crash left open); `runOnce` becomes assembly plus the loop call |
| `shared/agent-core/loop.mjs` `runAgentLoop` | ~225 lines; six exit paths each repeat "save the turn, then `onFlowComplete`" | One `finishFlow` helper for every exit; `recoverNarratedCalls` and `planNudgeFor` as named functions. Same file |
| `shared/agent-core/tool-calls.mjs` `runToolCalls` | ~175 lines; "abort → onFlowComplete → 'stopped'" written five times; ask_user and update_plan inline | `host-tools.mjs` (`runAskUser`, `runUpdatePlan`); `answerRemaining(calls, from, text)` for the limit and steering paths; one `stopped()` helper |
| `daemon/tools-gateway.mjs` `prepareCompletion` | ~175 lines: mode, project, bans, retrieval, memory, prompt | After Phase 3 shrinks it: prompt composition into `completion-prompt.mjs` |
| `daemon/tools-gateway.mjs` `startGateway` | ~230 lines of inline routing | The completions branch becomes `gateway/completion-route.mjs`, like the other `gateway/*-routes.mjs` |
| chat-ui `stores/agentic.svelte.ts` | 413 lines | Not split: Phase 7 deletes this host |

Behaviour-preserving: `tests/unit/agentic-loop.test.ts`,
`test-agent-core.mjs` and the task-runner suites pass unchanged. Order:
task runner, then agent-core, then the gateway.

**Related:** `comment-density-plan.md` Passes 2 to 5 (unstarted) are the
other readability debt; do Pass 2's files that this phase touches in the same
commits, and leave the rest of that plan as it is. The "oversized modules:
new responsibility → new module" rule in `ACTION-ITEMS.md` is this phase's
rule.

### 4.2 Repository layout

Checked 2026-11-17 against the user's proposed tree:

```
redstart/
  redstart-nest/   daemon/  src/ (launcher + chat-ui/)  shell/  scripts/  bin/
  redstart-twig/   windows/ (shell/, daemon/)
  shared/          agent-core/, command-exec, mcp-stdio-process, shell-pipe, update-feed
```

That is what the tree already is, and the top-level split is right: Nest,
Twig, and `shared/` for code both load. Three things in it do not match what
they hold, and are fixed in this phase (each one commit, every path in CI,
`release.yml`, scripts and docs updated with it):

- **`redstart-twig/windows/` → `redstart-twig/desktop/`.** The macOS Twig
  is built from the same folder (`release.yml`, "Twig — macOS"), so the
  name is wrong.
- **`redstart-nest/electron/`** holds one leftover file (`assets/redstart.svg`)
  since the Tauri move: move it to `assets/` and delete the folder.
- **`redstart-nest/src/` holds two apps:** the React launcher at its root
  (`App.tsx`, `tabs/`, `panels/`, `components/`, `hooks/`, `api/`) and the
  Svelte chat UI in `chat-ui/`. Move the launcher into `src/launcher/`, so
  each app has its own folder.

Not moved now, with the reason:
- **chat-ui stays under `redstart-nest/src/`** though Twig serves it too.
  Twig takes the built bundle (`stage-shell-bundle.mjs`), so it does not
  need the source anywhere else. And chat-ui still imports daemon modules
  (`lib/constants/mcp.ts`; the `security`, `documents-*` unit tests). Phase 7
  rewrites chat-ui into a viewer: move it to a top-level `chat-ui/` then, if
  at all, once that coupling is gone. Moving ~800 files now would collide
  with that rewrite and with the Blueprints fork's syncs.
- **Android Twig lives in `src/chat-ui/android/`** (54 files). Paused; it
  moves to `redstart-twig/android/` or is deleted when "Settle Android" is
  decided (parked table).

### Phase 4 built 2026-11-18

`e88b262` task runner, `2b12b46` loop, `0169dd1` tool calls, `68c903b`
gateway; 4.2: `68f88cb`, `a2b77fe` + `6445e46`, `ccf021a`. Each split was
behaviour-preserving: the named suites (and chat-ui's `agentic-loop.test.ts`)
passed unchanged, and the full chain passes at the end.

| File | Before | After |
|---|---|---|
| `task-runner.mjs` (`runOnce` ~385 → ~25 lines) | 987 | 535, + `task-ports.mjs` 565, `task-resume.mjs` 64 |
| `loop.mjs` (`runAgentLoop` 227 → ~170) | 282 | 283 (the helpers took the space) |
| `tool-calls.mjs` (`runToolCalls` 176 → ~120) | 341 | 319, + `host-tools.mjs` 67 |
| `tools-gateway.mjs` | 946 | 577, + `completion-prompt.mjs` 117, `gateway/completion-route.mjs` 115, `gateway/upstream.mjs` 205 |

*Deviations:*
- The helpers both the runner and the ports use (`TaskEnded`, `sleep`,
  `parseArgs`, the model chain, the constants) live in `task-ports.mjs`;
  in the runner they would have been an import cycle. The runner
  re-exports the constants, so importers are unchanged.
- `gateway/upstream.mjs` is new (forwarding, passthrough, the CORS fix,
  the context-error note): the completions route and the catch-all both
  need it. `prepareCompletion` is handed to the route, not imported, for
  the same cycle reason. `tools-gateway.mjs` re-exports all it exported.
- comment-density Pass 2: none of its eight files was touched here.

*Gaps:*
- No installer was built after the two folder moves: the Twig and Nest
  release builds (`release.yml`) are the first to use the new paths.
- `startGateway` is still ~210 lines of route table; only the completions
  branch left, as planned.

## Phase 5 — Skills and AGENTS.md

- **Workflows become Agent Skills (`SKILL.md`).** A skill is a folder whose
  `SKILL.md` has YAML front matter (`name`, `description`) and a Markdown
  body. The model sees only name and description; the body is loaded when the
  skill applies or the user invokes it. Workflows today are MCP prompts, run
  only by the user through `/`. Change: store a workflow as a skill, import
  and export `SKILL.md` folders, keep `/`, and let the model load one itself
  (name and description in the prompt, the body through the Phase 3 catalog).
  An instruction then costs one line until it is used. **U-S2, DECIDED
  2026-11-17:** a skill's bundled `.py` files may run, through `run_python`
  only (its sandbox: no network, the conversation folder). Every other file
  in a skill folder is reference text the model can read, never something
  that runs, and never through a shell or the Twig terminal.
- **Project instructions ↔ `AGENTS.md`**, imported and exported, so a project
  moves between Redstart, Yellowscript and other agents.
- **Not changed:** the approvals ledger, connector surfaces, `GET /egress`,
  the composed system prompt. No standard covers them; they are Redstart's.

### 5.1 at module level (planned 2026-11-18)

Calls made here, none of them the user's to make (each is a default with
an obvious fallback):

- **A skill is a folder on disk:** `<config>/skills/personal/<scope key>/<name>/`
  and `<config>/skills/org/<name>/`, each with `SKILL.md` and up to 20 more
  files (200 KB each, 1 MB a skill). The scope key and the org rule are
  workflows.json's.
- **`SKILL.md` as the Agent Skills format has it:** front matter with `name`
  (lowercase, digits, hyphens, at most 64) and `description` (at most 1024),
  then the body. Redstart's extras go in `metadata` (string values, as the
  format allows): `redstart-title`, `redstart-inputs` (the `/` inputs, as
  JSON) and `redstart-example` (JSON). A workflow's instructions are the
  body; the example stays in metadata so chat-ui's editor, which edits the
  two apart, is unchanged, and `/` and `use_skill` both append it. The id,
  timestamps and authorship are a `.redstart.json` beside `SKILL.md`, never
  exported. No YAML library: the parser reads exactly that subset
  (scalars, quoted strings, one level of `metadata`) and refuses the rest.
- **Migration:** on first read, every workflow in `workflows.json` is written
  as a skill folder; `workflows.json` is left in place, untouched, and a
  marker file says the migration ran. The `/workflows` routes, the MCP
  prompts and chat-ui's Workflows page keep their shapes.
- **The model loads a skill itself** through one core tool, `use_skill`
  (`{ name, file? }`): no file returns the body and the file list; a file
  returns that file's text. Loading copies the skill's `.py` files into the
  conversation folder under `skills/<name>/`, which is what `run_python`
  mounts (U-S2: they run there and nowhere else). The prompt lists the
  skills the caller can reach, name and description, at most 40, in a block
  that changes only when a skill does. *Deviation:* `use_skill` is a core
  tool rather than a catalog entry; it is one small tool, and the catalog's
  search is for tools, not for text.
- **Import and export:** a `.zip` of the folder, or a bare `SKILL.md`. The zip
  reader and writer are a small module on Node's own zlib (no dependency).
- **Projects ↔ `AGENTS.md`:** export a project's instructions as an
  `AGENTS.md` file, and import one into a project's instructions.

Commits: (1) `skill-format.mjs` (parse, serialize, validate, workflow ↔
skill); (2) `skills-storage.mjs` with the migration, behind
`workflows-storage.mjs`'s existing API; (3) `use_skill` and the prompt
block; (4) `zip.mjs` and the import/export routes, and the Workflows page's
two buttons; (5) the AGENTS.md routes and the project page's two buttons.

**Phase 5 built 2026-11-18:** `a5980e9` format, `fd1dcf2` store and
migration, `75aa982` use_skill and the prompt block, `faa0ab3` import and
export, `13d31a4` AGENTS.md. New suite `test-skills.mjs` (15); `test-projects`
gains one; `test-workflows` passed unchanged throughout. *Deviations:*
- A workflow with no description reads back with its title (or name) as
  one: the format requires a description, and it is what the model reads.
- New workflow names may not contain `--` (the skill name rule); the
  migration collapses an old one. The description and instructions limits
  are the skill format's (1024, 20,000).
- An import with any odd path (a `..`, an author's dot-file) is refused
  whole; only OS junk is dropped.
- An imported `AGENTS.md` on the project page goes into the draft, not
  straight to the server; the PUT route does replace (for API clients).
- The retrieval eval was refrozen against a bge-small server started by
  hand on 19184 (`use_skill` joined the catalog): the same 28 of 32.

*Gaps:*
- Nothing in Phase 5 has been used in the running app: a model choosing
  `use_skill` in a chat, the Workflows page's Import and Export, the
  project page's AGENTS.md buttons, and a real `workflows.json` migrating.
  Items for `testing-checklist.md`.
- `use_skill` is offered to every account, skills or not: `toolDefs` has
  no account to check.
- `listSkills` reads every SKILL.md on each completion (for the prompt
  block). Fine at tens of skills; a cache keyed on folder mtimes if it is
  ever hundreds.
- workflows-plan's later phases (mode and tool pinning, `json_schema`
  output, Twig quick-capture, folder runs) are still to re-plan on skills.

**Detail and cross-references:** `workflows-plan.md` D1 (MCP prompts) is
superseded for storage, kept for `/` delivery; its later phases (mode and
tool pinning, `json_schema` output, Twig quick-capture, folder runs) are
re-planned on top of skills. `projects-plan.md` D7 (sharing, deferred) is
unchanged and is the natural home for shared skills.

## Phase 6 — Resource grants, then shared document search

The roadmap's next Small-Office item ("Folder access grants"), unchanged in
substance and the oldest unfinished plan: per-account access to the shared
Vault, Git, SQLite and Postgres folders, plus the decision log (Phase 2 of
agent-runtime already shares its `policy.jsonl` design). After it, shared
RAG: chat-tooling 5b, on the store 5a already built (it carries `grant_id`).

**Detail:** `resource-grants-plan.md` (design record, nothing built),
`rag-plan.md` (superseded in part by chat-tooling D2), `chat-tooling-plan.md`
5b. Re-plan grants to module level against today's code first: approvals,
roles and projects have all landed since it was written 2026-09-05.

### 6.1 at module level (planned 2026-11-18)

Against today's code. **Already built** (agent-runtime Phase 2): the decision
log itself, `logPolicy` / `readPolicyLog` and `policy.jsonl`, its closed
allowlist, and an IPC reader for the launcher. So grants plan §7's steps 5
and 7 are mostly done; what is left is two event kinds.

Calls made here (the grants plan's open questions, §10):
- **A grant is a folder path relative to the capability's root**, not a
  labelled resource: less machinery, and the role editor shows the root's
  top-level folders to pick from. The decision log records the capability,
  never the folder name (§7).
- **Git:** with grants set, the root itself is not a repo the role can use;
  a granted folder is a repo, or holds repos one level down.
- **Disclosure:** the prompt says "shared, partly" (§5); the file explorer's
  read-only shared space comes with Shared Documents (6.2).

**Shared Documents (U, decided 2026-11-18 by the user):** a new shared
folder for 5b, not the Vault. One admin-chosen folder (`documentSearch.
sharedRootDir`, set on the Document search card), read-only, narrowed per
role by grants like the others (`grants.shared_documents`).

Commits:
1. `grant-scope.mjs` (`validGrantPath`, `grantedRoots`, `resolveGrantedPath`,
   `grantedPrefixes`) and `permissions.grants` in `narrowConfig`: per
   capability, absent inherits, `[]` narrows to nothing, a list narrows to
   those folders; composition is intersection, so idempotence holds. Role
   saves validate grants (relative, no `..`, at most 32 a capability).
   New suite `test-grants.mjs`; `test-roles.mjs` gains the empty-array case.
2. SQLite, Git and Vault: resolution through grants, enumeration that walks
   the granted roots only, and a denial logged (`access.denied`, the
   capability and the role, no path). `role.saved` / `role.deleted` join the
   log's events.
3. The prompt's stores block: three-valued (private, shared, shared partly).
4. The Roles tab: per grantable capability, "Limit folders" with the root's
   top-level folders to tick (from `GET /auth/roles`, for role editors only).

### 6.2 at module level (planned 2026-11-18)

5. The shared root: `documentSearch.sharedRootDir` in the capability config,
   the Document search card's folder picker, and `grants.shared_documents`.
6. The index: the shared root's files indexed once, `scope = '_shared'`,
   `grant_id = 'shared'`, paths relative to the root; a query takes the
   caller's own chunks plus the shared chunks under their granted prefixes.
   A revoked grant stops matching with no re-index (rag-plan §1).
   `search_documents` cites a shared hit as "Shared: <path>".
7. The file explorer's read-only `shared` space, showing the granted
   folders only; nothing in it accepts an account.
8. The stores block names shared documents (shared, or shared partly).

## Phase 7 — The loop moves to the server

**U-S1, DECIDED 2026-11-17: yes.** Step 1 below is in force from today:
nothing new is built into chat-ui's browser loop host; a feature that needs
the loop goes into agent-core and the daemon host.

**What the split costs now:** a refresh, closed tab or sleeping phone ends a
chat run, while a task survives a daemon restart; compaction, steering, the
question and approval cards and the bench each exist twice (the duplicated
task question fixed in e1e44b7 came from this); Twig's tools exist only in
the browser loop, so tasks cannot use them; the browser reaches external MCP
servers without passing Nest's chokepoint (only bans by name apply); every
loop feature is wired and tested twice.

**What moving costs:** client-tool delegation; token streaming from tasks;
the chat UI becoming a viewer of run events (send, edit, regenerate and
branch go through the server); several users' runs visibly queuing on one
llama-server (the GPU cost is the same as today's browser loops).
Third-party clients are unaffected.

**Steps:**
1. Declare it; no new features in the browser host.
2. Stream tokens from a task over its event stream.
3. A client-executor port on the daemon host: a connected client registers
   the tools it can run; calls reach it over the run's event channel and the
   result returns by POST; approval for a client tool stays on the client's
   card (D48). With no client connected, the tool is unavailable and the
   model is told so.
4. Send starts a run on the server (a task with a live viewer); the browser
   host stays behind a flag for one release.
5. Delete chat-ui's loop host (~1,200 lines in `stores/agentic*`) and the
   bench's hosted mode.

**Detail and cross-references:** this is the first half of agent-runtime
Phase 7 ("delegation", §6, a sketch); its second half (parallel task
contexts) stays a sketch. It closes these Phase 3 gaps in
`agent-runtime-implementation.md`: a task's reply arrives per turn; the
send-time "Run in the background" button; U-c (hand a running chat to a
task).

## Phase 8 — Twig terminal, sandboxed

Agent-runtime Phase 9, planned at decision level in §11 (D46 to D50, plus
D51 and D52 added from this review). All of its decisions are settled:

- **U12, DECIDED 2026-11-17: (c).** The model sends one PowerShell line.
  "Always allow" rules match only a line that is one plain command whose
  words start with the rule's words; anything compound (`|`, `;`, `&&`,
  `||`, redirection, `$(…)`, backticks, script blocks, `&`) or anything the
  tokenizer cannot classify asks every time. The tokenizer's failure mode is
  "ask", never "allow". The card shows a classification Twig computes from
  the line itself ("reads", "changes files", "deletes", "uses the network",
  "can't tell"), never text the model wrote.
- **Off by default, an "advanced" switch in Twig.** The audience includes
  people who cannot read PowerShell. For them the purpose-built tools
  (`fs_*` with the Recycle Bin, `run_python`'s sandbox) are the default.
- **U-S5, DECIDED 2026-11-17: the Windows sandbox is part of this phase**
  (D51 in agent-runtime §11). Commands run confined: writes only inside the
  granted folder, no network unless allowed for that command. It is a second
  layer under the card, not a replacement for it: Phase 8 does not relax
  (c)'s approval rules because a sandbox exists. **Built first, as a spike
  (8.0), with a decided fallback** (D51).
- **Network (D52):** off inside the sandbox by default. A line classified
  "uses the network" gets an "Allow network for this command" choice on the
  card, once, with no standing network grant.
- **U14, DECIDED 2026-11-17: after Phase 7 step 3.** Built once, as a
  delegated client tool, so it works in background tasks while Twig is
  connected.
- **U13 (macOS), settled with this plan:** the same design with zsh: a zsh
  tokenizer for (c), and Apple's Seatbelt (`sandbox-exec` profile) for the
  confinement, as Claude Code and Codex CLI do. Built only after a Mac Twig
  has been run on a real Mac (`testing-checklist.md` §4); until then Twig's
  terminal is Windows only.

Why the sandbox, from where the industry is going: away from approving each
command, toward **confining the command and asking only when it would leave
the confinement**. Claude Code added an OS sandbox for its shell tool on
macOS and Linux (writes confined to the working folder, network through an
allowlist) to cut approval prompts. Codex CLI runs commands sandboxed by
default and asks to escalate. Cloud agents run in disposable containers and
review the result (a diff, a pull request) instead of each command. Approval
fatigue, people clicking "yes" to everything, is the known failure of
approve-every-command, and the sandbox is what limits the damage when it
happens.

## Phase 9 — Deployment validation on real hardware

Everything in `deploy/` (systemd unit, Windows SCM procedure, Caddyfile,
runbook) has never been run. **Detail:** `deployment-validation-plan.md`,
including the seven unlanded commits from the deleted `feat/tool-retrieval`
branch listed under its "Gaps carried forward". Covers the roadmap's
"auto-restart on crash" item. Hardware-gated: run it whenever a Linux box
(or VM) and a Windows box that is not the dev machine are available.

## Phase 10 — A container runner on headless Linux Nest

**U-S4, DECIDED 2026-11-17:** "when we make a headless linux client we will
build a container." Read here as the headless Linux Nest (the Redstart Box,
`nestd` under systemd), which is what Phase 9 validates. The Windows desktop
Nest stays without a shell.

**What a container would buy** that Nest cannot offer today:
- A terminal for **every account**, not only the owner, because each run is
  confined to its own filesystem and cannot read other accounts' files or
  the secrets key.
- Model-written code with real packages: arbitrary `pip`/`npm` installs,
  native wheels, compilers, beyond Pyodide's set.
- Server-side coding tasks while nobody watches: clone, build, test, return
  a diff (what cloud coding agents do).
- Network egress decided per run, which fits `GET /egress`.
- Document tools with real binaries (LibreOffice, pandoc, tesseract OCR,
  ffmpeg) without installing them on the host.
- Disposable runs: damage does not persist, so fewer approvals are needed.

**Why not now:** hardware is not the constraint. A container costs tens to
hundreds of MB of RAM and the GPU stays with llama-server. The platform is:
on the Windows desktop install it means WSL2 or Docker Desktop
(virtualization in the BIOS, an elevated install, one more moving part for a
non-technical owner), and Windows Sandbox is not available on Home. On Linux,
which is the Redstart Box, rootless containers (podman) or bubblewrap are
cheap and well understood.

**So:** an isolated backend behind D20's seam (`isolation: 'none'` today),
Linux only, after Phase 9 proves the headless Linux deployment. It brings
back a `run_command` on Nest, for every account, each run in its own
container over that conversation's workspace, with no network unless an
admin allows it, and recorded in `GET /egress`. Phase 2 removes today's
terminal; this is a new tool built on the container, not the old one
restored (`shared/command-exec.mjs` stays as the spawn and limits layer).
The runtime (rootless podman or bubblewrap) is chosen by a spike when the
phase is re-planned to module level: that is an engineering choice, not a
product one. Until Phase 10, if offices ask for conversion or OCR, those ship
as purpose-built Nest tools, not a shell.

---

## Later and parked (cross-referenced, not scheduled)

| Item | Plan | State | Note |
|---|---|---|---|
| Browser automation | agent-runtime §6 Phase 5 | sketch | Plugin trial first (a Playwright MCP server from npm); now a deferred catalog tool after Phase 3 |
| Integrations, per-account credentials | agent-runtime §6 Phase 6 | sketch | Needs Phase 6's grants model for credentials |
| Parallel task contexts | agent-runtime §6 Phase 7 (second half) | sketch | Not before Phase 7 is reliable |
| Plugin & external MCP moderation | plugin-moderation-plan / -implementation | nothing built | Its Phase 3 (external MCP servers) gets simpler after Phase 7: the browser no longer holds those connections |
| Provider manifest | `PLUGIN-SYSTEM-PLAN.md` | proposal | Phase 3 adds its first field (`deferred`) |
| MCP OAuth | mcp-streamable-http-migration Phase 5 | not started | Delete that file when this is dropped or done |
| Model lifecycle (browse → load → switch) | roadmap Phase 3 | not planned | Last of the old next-phase sequence |
| Fit calculator | fit-calculator-plan | planned, not started | Independent; pairs with guided onboarding |
| Guided onboarding | roadmap Phase 2 | not planned | Pairs with Phase 8's "advanced" switch idea: plain language for non-technical staff |
| Context budget fixes | context-budget-implementation | shelved branch, unpushed | Drop item 3 after Phase 3 |
| Comment density Passes 2-5 | comment-density-plan | unstarted | Partly folded into Phase 4 |
| Dependency prevention | dependency-refresh-2026-11 | not started | Dependabot plus a CI `npm audit --omit=dev` / `cargo audit` gate; replace exceljs |
| Yellowscript approval handshake | agent-runtime-implementation, Phase 2 | deferred by the user | Until then Nest refuses its destructive calls |
| Signed installers, macOS support | roadmap Phase 2 | not started / built, never run | macOS items are in `testing-checklist.md` |
| Android Twig | ACTION-ITEMS "Settle Android" | paused | The phone browser is the supported path; its code moves out of `src/chat-ui/android/` or is deleted then (4.2) |
| chat-ui as a top-level folder | this file, 4.2 | after Phase 7 | Only once chat-ui no longer imports daemon modules |
| npm workspaces at the repo root | — | idea | One install for Nest, Twig, chat-ui and `shared/`; would end the node_modules junctions worktrees need today. Check the Tauri bundle staging and the three lockfiles first |
| Sandboxed lines without a card | — | idea | Once Phase 8's sandbox has real use: let a simple line that stays inside the sandbox run without asking, as Claude Code and Codex do. Needs its own decision then |

---

## Decisions (all settled 2026-11-17)

| | Decision | Phase |
|---|---|---|
| U11 (revised) | The Nest terminal is removed | 2 |
| U-S3 | The 3.2 bar as proposed; if it fails, freeze the turn-1 selection | 3 |
| U-S6 | `call_tool` carries approval: Nest enforces the inner tool; chat-ui's card shows it (an exception to U-S1), decided while re-planning 3.1 | 3 |
| U-S2 | Skill scripts run through `run_python` only | 5 |
| U-S1 | The loop moves to the server; nothing new in the browser host from today | 7 |
| U12 | (c): the line, prefix rules for plain lines only, a computed classification on the card | 8 |
| U-S5 | A Windows sandbox is part of the Twig terminal, spike first, fallback decided (D51) | 8 |
| U14 | The Twig terminal comes after Phase 7 step 3 | 8 |
| U13 | macOS: zsh + Seatbelt, after a Mac Twig has run on a Mac | 8 |
| U-S4 | A container runner on the headless Linux Nest | 10 |

U13 was settled from the other answers rather than asked; change it here if
that reading is wrong.
