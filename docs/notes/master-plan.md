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

Ground rules are unchanged: one phase at a time; re-plan a phase to module
level when it is reached, against the code as it is then; every commit passes
`npm run typecheck && npm run check:mjs && npm run test:security` in
`redstart-nest/`; a new or removed suite changes both `package.json` and
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

**Bar (U-S3, DECIDED 2026-11-17, as proposed):** B or C within noise of A
(≥ 76%) with ≤ 2 cache-miss turns per run. C over B on a tie, because C
keeps working when an admin installs ten plugins. **If neither passes:**
keep the turn-1 selection, freeze it for the conversation (no growth; new
tools only through `call_tool`), and still do 3.3's scrap list except the
scorer and `selectTools`' budget, which the turn-1 selection needs.

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
| U-S2 | Skill scripts run through `run_python` only | 5 |
| U-S1 | The loop moves to the server; nothing new in the browser host from today | 7 |
| U12 | (c): the line, prefix rules for plain lines only, a computed classification on the card | 8 |
| U-S5 | A Windows sandbox is part of the Twig terminal, spike first, fallback decided (D51) | 8 |
| U14 | The Twig terminal comes after Phase 7 step 3 | 8 |
| U13 | macOS: zsh + Seatbelt, after a Mac Twig has run on a Mac | 8 |
| U-S4 | A container runner on the headless Linux Nest | 10 |

U13 was settled from the other answers rather than asked; change it here if
that reading is wrong.
