# Tool retrieval — implementation plan

Companion to `tool-retrieval-plan.md`, which is the design record: the origin
incident, the shape, and the reasoning behind embedding-based selection. This
file is the *what* and the *order* — module-level steps, file by file, with the
tests that pin each one.

Written 2026-09-04 by re-reading the shipped tree rather than the design doc.
**Six of the design doc's statements are wrong or stale** and are corrected in
§0; one of them (§0.1) is a live bug in `tools-gateway.mjs` that exists today,
independent of retrieval, and becomes Phase 0. Read §0 before §2.

§1 is the cost/benefit analysis that settled the engagement question, and it
reverses two of the design doc's recommendations.

---

## How to use this

Same convention as `headless-admin-plane-implementation.md` and
`plugin-moderation-implementation.md`: detail is front-loaded for the phase
being reached, and later phases are re-planned to module level only when they
start. Phases 0, 1 and 2 below are at module level. Phases 3, 4 and 5 are at
step level and are explicitly marked to be re-planned on arrival — the code
they touch will have moved by then.

Two running records live at the foot of this file and are updated as each phase
lands: **Deviations from the design**, and **Gaps carried forward**. Anything
knowingly left undone goes in the second one at the moment it is left, and the
user-facing subset is mirrored into `docs/security.md` → Known gaps, which is
the copy that ships.

### Ground rules — these apply to every step

1. **No native dependencies.** The embedding model runs on the llama-server
   binary the tree already bundles (D3). The hashing uses `node:crypto`. The
   vector math is `Float32Array` and a loop. Nothing here adds a build step.
2. **Retrieval is an optimization, never a boundary.** Every failure — sidecar
   down, model missing, embed call timing out, cache cold — falls back to
   today's behaviour: the full post-ban tool list, byte-identical. A crashed
   embedding process must never fail a completion (D7).
3. **Retrieval runs strictly after the ban filter and can never widen it.**
   `enforceToolAllowList()` is the boundary; retrieval only ever removes from
   what survives it. `search_tools` searches the post-ban set only (D5).
4. **Every invariant gets a test.** New suites go in `package.json`'s
   `test:security` chain *and* `.github/workflows/ci.yml` —
   `scripts/test-ci-parity.mjs` fails the build if only one of them is updated.
5. **New pure modules import nothing from `electron`,** so they run under plain
   `node` the way `permissions.mjs` and `external-mcp-url.mjs` do, and so the
   headless daemon (`bin/nestd.mjs`) keeps working. Phase 1's module satisfies
   this by construction; Phase 2's process manager takes its paths and its
   binary resolver as arguments rather than reaching for `app.getPath`.
6. **The embedding server is localhost-only, hardwired.** Same invariant as
   `llama-args.mjs`'s `--host 127.0.0.1`, for the same reason and with its own
   test. It is an internal component, never a network service.

### Verification loop

```
cd redstart-nest
npm run typecheck
npm run check:mjs
npm run test:security
```

One commit per coherent piece, each independently passing all three.

### Baseline, measured 2026-09-04

`npm run test:security` — **exit 0, 45 node suites, 930 checks**, plus the
chat-ui vitest project (49 tests). The count never goes down.

**Phase 0 landed 2026-09-04**, two commits, taking it to **937 checks**.

---

## 0. Corrections to the design doc

Established by reading the tree on 2026-09-04. §1 (the shape), §2 (the cache
design), §4 (scoring) and §6 (the model) hold as written. Six things do not.

### 0.1 — The ordering claim is backwards, and today's order is a bug

The design doc's §0 says `enforceToolAllowList()` "runs **before**
`injectSystemContext()`". It does not. That is definition order, not call order:

```
tools-gateway.mjs:441   const requestHasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0
tools-gateway.mjs:455   parsed.messages = injectSystemContext(..., requestHasTools, ..., clientToolNamesIn(parsed))
tools-gateway.mjs:456   parsed = enforceToolAllowList(parsed, effectiveConfig)
```

The prompt is composed from the **pre-ban** tool set. Two consequences exist in
the shipped code, both narrow but both real, and neither has anything to do
with retrieval:

- An org-wide ban of a client app (`disabledToolIds` naming `'twig'`, which
  `CLIENT_APPS` expands to its eight `fs_*` names) strips those tools from the
  payload *after* `clientToolNamesIn()` has already put them in the prompt. The
  model is told it can reach the user's files and is handed no tool to do it.
- If bans strip **every** tool, `enforceToolAllowList` deletes `parsed.tools`
  entirely (`:145`) while `requestHasTools` — computed at `:441` — is still
  `true`. The whole capability section is claimed against an empty payload,
  which is precisely the substantiation rule `system-prompt.mjs` exists to
  enforce.

Swapping the two fixes both, and is a prerequisite for retrieval anyway: the
design doc's reason for wanting this order ("the prompt's capability claims
must describe what the model actually received this turn") is correct — it just
does not describe the code. **Phase 0.1.**

### 0.2 — `tools:estimate-context` is not where the doc says

Not `mcp-server.mjs:484`. The handler is `ipc/tools.mjs:78`, the body is
`estimateToolsContext` (`ipc/tools.mjs:66`), and the estimator itself is
`estimateActiveToolTokens` (`mcp-server.mjs:473`). The
`JSON.stringify(tools).length / 4` heuristic is as described, and the amber
threshold is `ToolsTab.tsx:520-527`.

### 0.3 — The amber estimate and the thing that blew the context are different sets

This is the important one. `estimateActiveToolTokens` walks
`resolveProviders()` — `BUILTIN_PROVIDERS` plus `pluginProviders()` — and
filters by `evaluateToolPolicy`. It describes **what Nest would serve over
MCP**. It never sees what the client actually puts on the wire.

`parsed.tools` is composed entirely client-side: `tools.svelte.ts` merges live
MCP connection tools, health-check tools and Twig's local `fs_*` definitions,
and `chat.service.ts:210` sends the result. The two sets overlap heavily —
which is why the amber warning was in the right ballpark for the origin
incident — but they are not the same number, and the estimate additionally
excludes the injected system prompt, which the gateway adds after the client
has done its own accounting.

**Consequence for Phase 3:** the budget gate measures the serialized
`parsed.tools` on the wire, plus the composed prompt, at request time. It does
not call the existing estimator. The estimator stays what it is — a
configuration-time hint on the Tools tab — and Phase 5 is where the two are
reconciled into one honest number.

### 0.4 — The rejection is already legible in the chat-ui; re-scope that item

The design doc's closing paragraph says the context-exceeded rejection "only
appears in the raw llama-server console log". In the chat-ui it does not:
`services/chat/chat-errors.ts:25` lifts `n_prompt_tokens` and `n_ctx` out of a
400 body into `error.contextInfo`, `chat-send.svelte.ts:135` carries it, and
`DialogChatError.svelte:57-70` renders both numbers. `forwardModified()` pipes
the upstream status and body through unchanged, so nothing in the gateway is
swallowing it.

What is actually unknown, and what Phase 0.2 establishes by reproducing the
failure rather than by reading:

- whether llama-server's rejection for *this* failure carries those two fields
  in that shape, or only a prose `message` (in which case the dialog renders a
  bare string, and the original report is accurate for a different reason);
- whether the rejection arrives as a 400 at all, or as a stream that dies;
- what Twig and any other non-chat-ui client do with it — they have no
  equivalent path, and the gateway is the only component every client shares.

Do not build the "cheap legibility fix" until this is reproduced. It may be one
line in a Svelte file, or it may belong in the gateway; the evidence decides.

### 0.5 — There is no spare fixed port to take

The design doc puts the sidecar on 19084 without comment. `ports.mjs` is
explicit that ports come in two kinds, and that a `config.port` the user picks
claims a family of three (`serverPortFamily`: `+0` gateway, `+1` llama-server,
`+2` MCP). `serverPortRejection()` (`ipc/validate.mjs:124`) refuses a base whose
family collides with anything in `FIXED_PORTS`.

An embedding server on a fixed 19084 is therefore a change to `ports.mjs`, not
just a spawn: `EMBED_PORT` must join `FIXED_PORTS` with its own label, which is
what makes `config.port` of 19082, 19083 and 19084 all rejected with a message
naming the right owner. Skipping that step means a user who sets
`config.port = 19082` puts their MCP server on top of the embedding server,
silently.

### 0.6 — No conversation identity reaches the gateway

`chat.service.ts` takes a `conversationId` parameter and does not put it in the
request body — the payload is messages, tools and sampling parameters. The
gateway's available identity is `authResult.account` and, with auth off, the
client-chosen `X-Redstart-Device-Id` header, which today is consulted only by
the conversation routes.

Everything the design doc scopes "per conversation" (§4's already-invoked
pinning, §5's recently-searched pinning, and §1.3's monotonic application
below) must therefore derive from the `messages` array itself, which arrives in
full on every request. That turns out to be a feature rather than a workaround
— see D6 — but it is a constraint, not a choice.

---

## 1. Cost/benefit: what always-on actually costs

The engagement question was settled as **always on**: every tool-carrying
request goes through the scorer. The reasoning below is why that is right, and
why it does *not* mean the tool list may change every turn.

### 1.1 — The embedding model's own cost is not the interesting number

Per turn, with a 33M-parameter embedding model on CPU:

| | cost |
|---|---|
| one embed of the query side | single-digit to low-tens of ms |
| cosine over a few hundred 384-dim vectors | tens of µs — a brute-force loop |
| the cache itself | ~300 KB for 200 tools (384 floats × 4 bytes) |
| resident, idle | a few hundred MB RSS, **zero VRAM** (CPU by default, §6) |
| embedding a tool | once per content hash, ever |

Against a local chat turn whose time-to-first-token is measured in hundreds of
milliseconds to seconds, a per-turn embed is a rounding error. The "run it only
when we need it" instinct optimizes the axis that is already cheap, and it buys
that saving by introducing a threshold — a point where behaviour changes
without anyone asking, in the middle of a conversation, which is exactly the
class of invisible state change this codebase has repeatedly decided against
(see D2 in `plugin-moderation-plan.md` for the same call in a different
context). Always-on is one code path, exercised on every request, so its bugs
surface in ordinary use rather than only for the users already in trouble and
least able to diagnose it.

### 1.2 — The expensive thing is the prompt prefix, and it is worth protecting

The tools block is serialized into the prompt **ahead of every message**
(`--jinja`, `llama-args.mjs:64`). Any change to it invalidates the KV cache for
the entire conversation, so the next turn re-prefills the whole context instead
of just the new tokens. On a multi-thousand-token conversation that is seconds
of added latency before the first token — two to three orders of magnitude more
than the embed call it was computed to save.

This matters *because* prefix reuse works today: the injected system prompt is
stable within a day. `buildSession()` (`system-prompt.mjs:371`) emits
`Current date: YYYY-MM-DD` with no clock time, and every other block is derived
from config. A per-turn filter that reshuffled the tool list would be the first
thing in the request to churn, and it would take the cache with it.

### 1.3 — The resolution: score every turn, apply monotonically

**Scoring** runs on every tool-carrying request — always on, always logged,
never conditional. **Application** is conservative: within a conversation the
applied tool set never shrinks, and it grows only when a pin appears or a score
clears a hysteresis margin over the weakest included tool.

The asymmetry is deliberate and follows straight from §1.2. A tool wrongly
*added* costs one re-prefill, once. A filter that lets tools churn in and out
costs a re-prefill every turn, forever, and the user experiences it as the model
getting slower for no reason they can see. Dropping a tool mid-task is worse
still — the design doc already says so in §4 — and monotonicity makes that
structural rather than a rule someone has to remember.

### 1.4 — Two design-doc recommendations this reverses

- **§3's query side.** The doc recommends "last user message + names of tools
  called in the last 2 assistant turns", ranked cheapest-first. Cheapest is the
  wrong axis (§1.1), and a query built from the most recent turn is the most
  volatile input available — it maximises exactly the churn §1.2 says to avoid.
  **Use the whole conversation** (all user messages, plus the names of every
  tool called in it, concatenated). It costs one embed either way, it changes
  slowly by construction, and its slow drift is what makes monotonic
  application nearly free rather than a constant fight against the scorer.
- **§6's process shape.** "Its own lifecycle tied to the daemon (not to whether
  a chat model is running)" is right, but the doc's parenthetical then talks
  itself out of the benefit. Keep the daemon-tied lifetime and take the benefit
  seriously: it is what lets the cache warm before the first completion and what
  keeps `search_tools` answerable, and it is the reason Phase 2 lands before
  Phase 3 rather than alongside it.

---

## 2. Decisions

**D1 — Score every request; apply monotonically per conversation.** §1.3. The
applied set is a function of the conversation, not of the turn.

**D2 — The query is the whole conversation.** §1.4. One embed per turn
regardless, so the extra text is free, and it is the stable choice.

**D3 — The embedding model runs on the bundled llama-server binary.** A second
process: `--embeddings`, a small GGUF, `-ngl 0`, `--host 127.0.0.1`, on a fixed
port. This reuses `resolveBinary()`'s candidate search, the settings override
and its rejection path, `process-supervision.mjs`'s PID-file reaping,
`model-download.mjs`'s hash-verified fetch, and both packaging paths — none of
which a new runtime would get for free, and all of which are already tested. It
keeps ground rule 1 trivially true and works on the headless Linux daemon with
no extra work.

**D4 — Retrieval runs after `enforceToolAllowList()` and before
`injectSystemContext()`.** Requires Phase 0.1's swap. Bans are a boundary;
retrieval is a selection over what survives one.

**D5 — `search_tools` searches the post-ban set only.** A banned tool must not
be reachable by describing it. Same registry the filter scored, not the raw one.

**D6 — Pins are derived from the request, not from server state.** Every tool
the model has already called appears in `messages` as an assistant `tool_calls`
entry, and every `search_tools` result appears as a `tool`-role message. Both
pin sources are therefore a pure function of the payload, with no session table
to grow, expire or leak across accounts. Admin-required pins come from
`effectiveConfig`, which is already resolved per request and already
role-narrowed.

**D7 — Fail open, always.** Sidecar down, model absent, embed timeout, JSON
malformed: log once, send the full post-ban list, serve the request. There is no
second scoring implementation to fall back to — a lexical scorer that disagrees
with the embedding one is two behaviours to reason about on a path that should
be rare.

**D8 — Off until it is proven, then on.** The filter ships behind a per-profile
setting defaulting to **off** in Phase 3, and flips to on by default only once
Phase 5's telemetry shows what it is actually doing on real tool sets. This is
not the engagement question from §1 — when it runs, it runs on every request —
it is a rollout control, and it is removed once the default flips.

---

## 3. Phase 0 — the two things worth doing whether or not retrieval ships — **LANDED 2026-09-04**

No embeddings, no new process. Both items stand on their own.

### 0.1 — Swap the injection and ban-filter order — **landed**

Landed as written. Three tests in `test-gateway-routes.mjs`; the first two were
confirmed to fail against the old order before the fix was kept.

`tools-gateway.mjs:455-456`. Move `enforceToolAllowList` above
`injectSystemContext`, and compute `requestHasTools` and `clientToolNamesIn()`
from the **post-ban** payload.

Watch the argument-evaluation detail: `clientToolNamesIn(parsed)` is evaluated
in the argument list at `:455`, so moving the statement is not enough on its own
— `requestHasTools` at `:441` must move too, or it silently keeps reading the
pre-ban array.

*Tests* — extend `scripts/test-tool-policy.mjs`, which already owns the ban
semantics:

- a request whose every tool is banned composes a prompt making **no**
  capability claim;
- an org-wide ban naming a client app (`'twig'`) removes those tools from the
  prompt's local-file claim as well as from the payload;
- a request with no bans composes a byte-identical prompt to today's — the
  regression guard that says the swap changed nothing else.

*Commit:* `fix(gateway): the system prompt described tools the ban filter then
removed`.

### 0.2 — Diagnose the context-exceeded rejection — **landed, re-scoped**

The plan said reproduce first. There is no chat model on this machine, so the
answer came from the fork's own source in `llama-cpp-turboquant/tools/server/`,
which is authoritative for the wire format in a way a single repro would not
have been:

- `format_error_response()` (`server-common.cpp:47`) maps
  `ERROR_TYPE_EXCEED_CONTEXT_SIZE` to HTTP **400** and
  `type: 'exceed_context_size_error'`;
- `server_task_result_error::to_json()` (`server-task.cpp:1878`) adds
  `n_prompt_tokens` and `n_ctx` **for that error type only**;
- `res->error()` (`server-context.cpp:3861`) nests it under `error` and takes
  the HTTP status from `code`;
- and it survives streaming: `server-context.cpp:4048` returns an error that is
  the *first* result as a non-stream response ("to match the OAI API
  behavior"), which a prompt too large to process always is.

So §0.4's suspicion was right — the chat-ui path works end to end, and the
design doc's "only appears in the raw console log" was wrong. **The real gap is
different and better:** the rejection cannot say *what spent the window*,
because llama-server never saw a tool list, only a rendered prompt. That
explanation exists in exactly one place that every client shares.

What landed is therefore an annotation in `forwardModified()`: a 400 carrying
that exact error type has the forwarded tool count and its approximate token
cost appended to `message`. Post-ban today, post-retrieval later, so the number
quoted is the one really spent. Anything else — a different error type, an
unparseable body, a request with no tools — is returned byte-identical, and the
streaming path is untouched because only a 400 is ever buffered.

*Still open:* mid-generation context exhaustion
(`server-context.cpp:3431`, "Context size has been exceeded.") arrives as an SSE
frame mid-stream, not as a 400, so neither the chat-ui's dialog nor this
annotation sees it. Different failure, different fix; recorded in **Gaps**.

---

## 4. Phase 1 — the scorer, pure, wired to nothing — **LANDED 2026-09-04**

One new module, `electron/main/tool-retrieval.mjs`, importing only
`node:crypto`. No process, no network, no gateway change. Everything in this
phase is testable with hand-written vectors.

### 1.1 — `toolContentHash(tool)`

sha256 over a canonical serialization of `name` + `description` +
`inputSchema`/`parameters`, with object keys sorted so two structurally
identical schemas hash alike. Nothing else goes in: not the source, not the
plugin id, not a class. Per design doc §2 this is the cache key, and
`plugin-moderation-implementation.md` §0.3's lesson applies unchanged — a field
that is Redstart's verdict rather than the publisher's text does not belong in a
fingerprint.

*Tests:* key order does not change the hash; a description edit does; two tools
from different sources with identical text collide **on purpose**.

### 1.2 — The vector store

`Map<hash, Float32Array>` behind `get` / `setMany` / `has`, plus
`missingHashes(tools)` returning what a request would need embedded. In-memory
only; design doc §7.2's persistence question stays open and is recorded as a
gap, not built.

*Tests:* a miss list shrinks to empty after `setMany`; a changed description
reappears as a miss; the store does not grow on a repeated identical tool set.

### 1.3 — `cosine(a, b)` and `scoreTools(...)`

Brute force, no index. `scoreTools` returns every tool with its score, sorted
descending, and decides nothing.

*Tests:* orthogonal and identical vectors; a zero vector scores 0 rather than
producing `NaN` — a degenerate embedding must not poison a sort.

### 1.4 — `selectTools({ scored, pins, budgetTokens, previous, floor, margin })`

The whole policy, pure, returning `{ selected, dropped, reason }`. Implements
design doc §4 plus D1's monotonicity:

- everything in `pins` is included first, unconditionally, and is not weighed
  against the budget — a pin is a promise;
- everything in `previous` (the set applied on the last turn of this
  conversation) is included: the set does not shrink;
- remaining tools are added by descending score while above `floor` and while
  the running token estimate stays under `budgetTokens`;
- a tool below `floor` is never added even with budget to spare — a pathological
  query must not drag the whole registry in by default;
- a new tool must beat the weakest currently-included tool by `margin`, so a
  score jittering across the floor does not toggle the set;
- the returned array is ordered stably **by name**, so an unchanged set
  serializes identically byte for byte. This is what actually preserves the KV
  prefix (§1.2), and it is the easiest thing in the phase to lose to an
  innocent-looking sort by score.

*Tests:* pins survive an empty score list; `previous` is always a subset of
`selected`; budget exhaustion drops the lowest scorer, never a pin; hysteresis
suppresses a marginal add; two calls with re-ordered inputs and the same set
produce identical serialization.

### 1.5 — Suite registration

`scripts/test-tool-retrieval.mjs`, added to `package.json`'s `test:security`
**and** `.github/workflows/ci.yml`. `test-ci-parity.mjs` enforces the pair.

---

## 5. Phase 2 — the embedding server — **LANDED 2026-09-04**

Everything about running the model. Still no gateway change.

### 2.1 — `EMBED_PORT` in `ports.mjs`

`export const EMBED_PORT = 19084`, added to `FIXED_PORTS` as `'the embedding
server'`. Pure constants, no new import — the module's own header rule.

*Tests*, beside the existing collision check: `config.port` of 19084, 19083 and
19082 are each rejected, and the message names the right owner for each — 19082's
family hits the admin listener *and* the embedding server, so the message must
not claim only one.

### 2.2 — `buildEmbedArgs(modelPath)` in `llama-args.mjs`

Beside `buildArgs`, sharing its quoting helper. `-m`, `--embeddings`,
`--port EMBED_PORT`, `--host 127.0.0.1` hardwired, `-ngl 0` (CPU by default,
design doc §6), a small `-c`, and no `--path`. Pooling is **not** guessed:
verify against the chosen model's metadata before pinning a `--pooling` flag,
since bge and MiniLM differ and llama.cpp reads a default from the GGUF.

*Tests* in `scripts/test-llama-args.mjs`, which already owns this invariant:
`--host` is always `127.0.0.1` and cannot be overridden; the port is
`EMBED_PORT` and is not derived from `config.port`; this process serves no
chat-ui `--path`.

### 2.3 — `embed-server.mjs` — lifecycle

Start / stop / status for the second child, modelled on `ipc/server.mjs`'s
launch but much smaller: no EMA, no process log, no discovery. Takes
`resolveBinary` as a dependency (ground rule 5) and writes its own PID file via
`process-supervision.mjs` under a **different file name** than
`llama-server.pid`, or `reapStaleProcess()` will reap one process using the
other's record.

Lifetime is tied to the daemon, not to a chat model (§1.4): started after the
admin listener is up, stopped on daemon shutdown alongside the gateway.

*Tests:* a start with no model file present resolves to a clean "unavailable"
status rather than throwing; the PID file path does not collide with
llama-server's; stop is idempotent.

### 2.4 — Model acquisition

The embedding GGUF is a small, fixed, Nest-chosen file, so it does not go
through the model picker. Reuse `model-download.mjs`'s hash-verified,
`.part`-suffixed fetch with a pinned sha256 — that module's whole design is "a
remote artifact must never be mistakable for a complete one", which applies at
40 MB as much as at 18 GB. Fetch on first need, not at install: a user who never
enables retrieval never downloads it.

**Design doc §7.1 is answered here.** `bge-small-en-v1.5` versus
`all-MiniLM-L6-v2`, compared empirically against this tree's own tool
descriptions (short, jargon-heavy, several actions per description) with a
throwaway script. Record the winner and the pinned hash in **Deviations**. Do
not carry the question into Phase 3.

*Tests:* extend `scripts/test-model-download.mjs`'s stub-server coverage to the
fixed-artifact path — a truncated download does not produce a usable file, and a
hash mismatch leaves nothing behind.

### 2.5 — `embedTexts(texts)` — the client

`POST /v1/embeddings` on `EMBED_PORT`, batched, short timeout. Returns `null` on
**any** failure — never throws. D7 lives here, and this one function is what
makes it true for every caller.

*Tests:* a stub server returning a 500, a malformed body, or nothing at all each
yields `null` within the timeout, and the failure is logged exactly once.

---

## 6. Phase 3 — wiring the filter into the gateway — **LANDED 2026-09-04**

**Re-plan to module level on arrival.** Step level for now; `tools-gateway.mjs`
will have moved under Phase 0.1.

- **3.1** Conversation key. Derived from the payload per §0.6 — a hash over the
  first user message plus the account id — used only as the key of a bounded
  in-memory LRU holding the last applied set (D1's `previous`). A miss costs one
  re-prefill, never correctness, so eviction is safe and the map may be dropped
  on restart.
- **3.2** Pin extraction from `messages` (D6): assistant `tool_calls` names,
  `tool`-role results naming a `search_tools` hit, and `effectiveConfig`'s
  admin-required list.
- **3.3** The budget, measured on the wire per §0.3: serialized `parsed.tools`
  plus the composed prompt against `ctxSize`. Note the circularity this creates
  — the prompt is composed from the selected set, and the selection needs the
  prompt's size. Resolve it by budgeting against a prompt composed from the pins
  alone (a lower bound that does not depend on the selection) and record the
  slack.
- **3.4** The call site: after `enforceToolAllowList`, before
  `injectSystemContext` (D4), behind the profile setting (D8), fail-open (D7).
- **3.5** Telemetry: one `logEvent` per filtered request, counts only — never
  tool names, and nothing that touches `logger.mjs`'s `BLOCKED_KEYS` contract.

*Tests:* a filtered request's prompt claims exactly the capabilities of the
tools it carries (the Phase 0.1 invariant, now under a filter); a banned tool
never reappears; the setting off is byte-identical to today; a dead sidecar is
byte-identical to today.

---

## 7. Phase 4 — `search_tools` — **LANDED 2026-09-04**

**Re-plan on arrival.** Design doc §5 stands. The mechanism it proposes — result
names become pins on the next turn — is already satisfied by D6's
payload-derived pinning with no new protocol, which is why this phase is small
and why it comes after Phase 3 rather than with it. Returns
`{ name, description }` only, never schemas.

---

## 8. Phase 5 — make the number honest — **HALF LANDED 2026-09-04**

**Re-plan on arrival.** Design doc §4's last item. Reconcile §0.3's two
different measurements into one an admin can act on: what the Tools tab
estimates, what actually goes on the wire, and what the filter removed. This is
also the phase that decides whether D8's setting flips to on by default and then
disappears.

---

## Deviations from the design

### Landed in Phases 1 and 2 (2026-09-04)

- **`selectTools` grew a second floor.** The plan has one absolute `floor`.
  Phase 2.4's measurement showed bge-small puts every score in a narrow band
  (0.57–0.82 across all 21 built-in tools and all 18 test asks), so an absolute
  cut is either a no-op or an arbitrary guillotine. `relativeFloor` — a fraction
  of the best score this turn — is the load-bearing half; the absolute one stays
  as a hard "matched nothing" cut. A tool must clear both. This is a refinement
  of design doc §4, forced by evidence that did not exist when it was written.
- **`process-supervision.mjs` grew an optional pid-file name.** Plan §2.3 says
  the embedding server must not share `llama-server.pid`; the module hardwired
  that name. All four functions now take `{ name }`, defaulting to the old
  value, so every existing caller and test is untouched.
- **`serverPortRejection()` now names every colliding port, not the first.**
  Not in the plan. Forced by §2.1: 19083 and 19084 are adjacent, so 19082's
  family hits both, and the old message would have sent the user to move their
  port by one — directly onto the other one.
- **The daemon starts the embedding server only if the model is already on
  disk.** The plan's §2.3 says "started after the admin listener is up". Taken
  literally that means downloading 67 MB at every first boot, including for
  users who never enable retrieval. Nothing downloads at boot; a missing model
  is a clean `unavailable` status.
- **`buildEmbedArgs` pins no `--pooling`.** Plan §2.2 said verify against the
  chosen model before pinning it. Verified as unnecessary: bge-small's GGUF
  default was used throughout the Phase 2.4 evaluation and produced the numbers
  recorded there, so there is nothing to override. If a future model needs one,
  it is a one-line change with an existing test beside it.
- **Phase 2.4's model choice, recorded as the plan asks:**
  `bge-small-en-v1.5-f16.gguf`, repo `CompendiumLabs/bge-small-en-v1.5-gguf`,
  revision `d32f8c040ea3b516330eeb75b72bcc2d3a780ab7`, sha256
  `f0b2fef971e8366438bfd2d9aefea1b0115919389448806d290237f638bae999`,
  67,308,128 bytes, 384 dimensions. Beat `all-MiniLM-L6-v2` f16 on recall@1
  (83.3% vs 72.2%), recall@3 (94.4% vs 88.9%) and MRR (0.896 vs 0.817), measured
  on this tree's own tool descriptions with the bundled llama-server. Both cost
  ~200 ms of CPU for all 21 tools, so quality was the only separating axis.

### Found by running it (2026-09-04)

- **The budget was half the window, and a half is enough rope to make the
  filter useless.** On a query where every tool scores alike — "which tools are
  relevant here?" is the pathological case, being *about* tool descriptions —
  the floors admit nearly everything and the budget becomes the only constraint
  left. Retrieval then stops selecting and starts packing: 29 of 76 tools and
  15,494 tokens, a filter that has technically run and saved almost nothing,
  while the model prefills ~15k tokens every turn. Now a QUARTER, matching the
  threshold the Tools tab has always used to turn its estimate amber. Same
  query: 14 tools, 7,480 tokens. A test reads the tab and fails if the two
  numbers ever disagree — two places deciding "too much context spent on tools"
  independently is how a filter comes to report success while sending a request
  the UI would have warned about.
- **`reason: 'budget'` is the diagnostic that mattered, and it was already** 
  **there.** It says the scorer could not tell the tools apart. `ms`,
  `budgetTokens` and `sentTokens` joined it, because the first question asked
  of a filter that runs on every request is "is this what made the model slow?"
  and counts alone cannot answer it. Measured: **6-7 ms warm, ~700 ms once on a
  cold cache** — retrieval is not the latency, the size of what it selects is.


- **D2 and the model's 512-token limit had never met.** §1.4 reverses the design
  doc to make the query the WHOLE conversation; Phase 2.4 then picked a model
  that stops at 512 positions, and `buildEmbedArgs` set `-c 512` to match. Every
  conversation past ~1,500 characters made llama-server answer
  `input (N tokens) is too large to process` with HTTP 500 — which fails the
  ENTIRE batch, so one long conversation cost every tool its vector and the
  request went out unfiltered. Phase 2.4's evaluation used one-sentence
  queries, so the two decisions never met until a real conversation put them
  together. The query is now bounded: tool names are always kept (short, and
  the strongest signal), and the OLDEST user prose is dropped first. That
  reintroduces some of the volatility §1.4 chose the whole conversation to
  avoid, and it is affordable only because application is monotonic — a
  drifting query can add tools, never remove them. `embedTexts` truncates every
  input as a second line of defence, so no caller can reproduce this.
- **The suite silently depended on fixed production ports being free.** Three
  sections assumed nothing was listening on 19083/19084 — one of them tested
  "no embedding server" by relying on connection-refused. A developer running
  Redstart falsified the premise, and the test quietly measured something else.
  They probe and SKIP with a reason now, the bargain `test-daemon-smoke.mjs`
  already made; CI always has the ports.


- **The sidecar was wired against its own decision.** `syncRetrieval` was
  hooked into `applyToolsConfig` *after* its `getGatewayPort` early return, so
  it only ran when a chat model was already loaded. D3 and §1.4 both say the
  sidecar's lifetime is the DAEMON's — that is what lets the cache warm before
  the first completion — and the wiring said the opposite. Symptom: the switch
  sat at "Starting…" forever and nothing was ever downloaded. Now called before
  the gateway check, and the UI calls `tools:sync-retrieval` directly rather
  than riding the live-server tool sync (which also returns early when no model
  is running). Regression-guarded by a test confirmed to fail against the old
  ordering.
- **The download guard was a state string, so retries were swallowed.** Guarding
  on `modelDownload.state === 'downloading'` meant an interrupted or abandoned
  transfer left that string behind forever, and every later attempt returned
  "already downloading". The guard is the in-flight promise now, and the
  continuation re-checks whether retrieval is still wanted before starting a
  server — the switch can go off mid-transfer.
- **"Starting…" was a fallback branch pretending to be a state.** It rendered
  whenever the sidecar was `stopped` with no reason, which is the never-touched
  initial state and is indistinguishable from actually starting. Every branch
  is now read off a fact the daemon reported, including "the running server is
  still using the previously saved settings" — the profile field and the live
  gateway are separate questions and the switch now reports both.

### Landed in Phases 3, 4 and 5 (2026-09-04)

- **The wire-cost record carries THREE tool counts, not two.** Phase 5 as
  written reconciles "what the estimate said" with "what went on the wire".
  Two counts cannot do that honestly: bans and retrieval both shrink the list,
  and an admin needs to know which one did it — a ban is policy they set, a
  retrieval drop is a judgement the scorer made. `toolsOffered`,
  `toolsAfterBans`, `toolsSent`.
- **The two numbers are shown side by side rather than reconciled into one.**
  Phase 5's heading says "one honest number". There isn't one: the estimate
  describes a profile's MCP tool set and the observation describes a request,
  which is a different and larger thing. A single number would have to be wrong
  about one of them, so the Tools tab labels both.
- **`activeToolCatalog()` was extracted in `mcp-server.mjs`.** Not in the plan.
  Phase 4 needed the post-policy tool list and there were already two
  hand-copied walks of it (`tools/list` and `estimateActiveToolTokens`). A
  third copy is how a search comes to offer a tool `tools/list` withholds,
  which is the exact failure D5 exists to prevent.
- **`search_tools` is an MCP provider, not a gateway route.** Implied but not
  stated. A tool call is dispatched by the CLIENT against the MCP server, so a
  gateway-side implementation would be a tool nothing could invoke.

### Established before any code was written


*(Nothing landed yet. Each entry records where the code and
`tool-retrieval-plan.md` disagree, and why.)*

- §0.1, §0.2, §0.4, §0.5 and §0.6 above are corrections to design-doc statements
  that were already wrong on 2026-09-04, before any code was written.
- §1.4 reverses two of the design doc's recommendations: the query side, and the
  framing of the sidecar's lifetime.
- D3 replaces the design doc's new "embed sidecar" with a second llama-server
  process on the bundled binary.
- **Phase 0.2 was re-scoped on landing.** The plan said reproduce the rejection
  first; no chat model exists on this machine, so the wire format was
  established from the fork's server source instead — stronger evidence, but
  *not* a live repro, and that distinction is deliberate. The chat-ui path
  turned out to work, so the fix became an annotation naming the tool cost
  rather than a translation of the error.

## Gaps carried forward

### Opened by the system-prompt pass (2026-09-04)

- **CLOSED 2026-09-04 — a narrowed list is disclosed with or without a remedy.**
  Two wordings now: with `search_tools` present, call it; without it, the model
  is told the list is partial, that there is no way to see the rest from here,
  and to say a capability is "not available in this session" rather than that
  the server cannot do it. The gate also moved off the SETTING and onto the
  FACT — the gateway counts the payload before and after the filter, because
  retrieval fails open and "enabled" is compatible with a request that kept
  everything. Counted rather than compared by identity: `selectTools` returns a
  fresh array even when it drops nothing.
- **(superseded) A client with no `search_tools` still gets a narrowed list, silently.**
  The `retrieval` block is gated on `search_tools` being in the payload,
  which is the honest gate — the advice is "call this tool", and a model that
  does not have it cannot act on it. But an OpenAI-compatible client that
  sends its own tools without connecting to Nest's MCP server (a coding agent,
  say) still goes through `filterRequestTools`, still gets a subset, and is
  told nothing at all. It predates this pass; the gate just makes it explicit.
  Closing it properly means either advertising `search_tools` to clients that
  did not ask for it — which the gateway has no mechanism for, since it does
  not compose the payload — or a differently-worded block for that case, which
  would say "your list is partial and you cannot do anything about it".
  Neither is obviously right, so it is recorded rather than guessed at.
- **CLOSED 2026-09-04 — `data_handling` now says who else can see each store.**
  The stores are grouped rather than listed flat: documents and the file system
  are named as private to the account, Postgres, SQLite, Vault and Git as
  shared. The split comes from one `LOCAL_STORES` table so the audit list and
  the privacy claim cannot drift apart, and it inverts with auth —
  `resolveUserScope(null)` puts every caller in one anonymous folder, so with
  auth off the prompt says all of them are shared rather than staying silent.
  Scholar's PDF saves are also per-account (`scholarCfg.saveDir` through
  `resolveUserRoot`) but Scholar is not in `LOCAL_STORES` at all, so it is
  neither listed nor scoped; that predates this pass and is unchanged by it.
- **CLOSED 2026-09-04 — `precedence.ts` no longer calls the server root shared.**
  Both copies were stale, not one: the module comment and the header of
  `tests/unit/tool-precedence.test.ts`, which had inherited the same sentence.
  Both now say the capability acts on the server inside the caller's own folder
  under an admin-configured root, and the module comment records what the old
  wording confused — the capability root the MCP child is spawned at is indeed
  one folder, but no call ever reaches it directly.

### Opened by this pass (2026-09-04)

- **D8's setting has NOT been flipped, and cannot be from here.** Phase 5's
  second half says the default flips to on "once telemetry shows what it is
  actually doing on real tool sets". That telemetry does not exist yet — the
  `retrieval` log events and the wire-cost readout are what will produce it,
  and they have never run against a real tool set on a real conversation.
  `tools.retrieval.enabled` therefore stays **off by default**, and the
  rollout control stays in the tree. Flipping it on the strength of a passing
  test suite would be exactly the unearned confidence D8 was written to
  prevent.

  **Still open after 2026-09-04's live run, deliberately.** That run is one
  machine, ten hand-written tool descriptions and one conversation. It proves
  the path executes and that the scoring discriminates sensibly; it is not
  telemetry about real tool sets in real conversations, which is what D8 asks
  for. It does retire the "has never run at all" objection, so what is left is
  a question of evidence volume rather than of whether the thing works.
- **CLOSED 2026-09-04 — the shipped path has now been run end to end, and it
  found a bug.** `ensureEmbedModel` -> `startEmbedServer` -> `embedTexts` ->
  `scoreTools`/`selectTools`, no stubs, against the bundled llama-server:

  | step | measured |
  |---|---|
  | download + sha256 verify (67 MB) | 2.0 s, on-disk size matches the pin |
  | spawn -> `/health` 503 | 248 ms |
  | spawn -> `/health` 200 | 789 ms |
  | spawn -> first successful embed | 895 ms |
  | 10 tool descriptions embedded | 134 ms, 384 dims |
  | one conversation embedded | 6 ms |

  Real scores for "what changed in the repository / which files were touched in
  the most recent commit", across ten real tool descriptions: 0.746 `git_log`,
  0.742 `git_diff`, then 0.617 `vault_search` down to 0.478 `postgres_query`.
  The relative floor (0.85 x best = 0.634) kept exactly the two git tools and
  dropped eight. The narrow absolute band `embed-model.mjs` documents is real
  and is why the floor has to be relative.

  **The bug:** `startEmbedServer` reported `running` the instant `spawn()`
  returned, so for ~900 ms the Tools tab showed a working sidecar while every
  embed was refused — the exact reading that switch was built to avoid. Fixed
  with a `starting` state and a background `/health` watch. Nothing was broken
  by it (the filter fails open), which is why only running it could find it.
- **CLOSED 2026-09-04 — there is now a UI switch, and it downloads the model.**
  Tools tab, directly under the two cost readouts. `syncRetrieval()` in
  `ipc/tools.mjs` fetches the model on enable and starts the sidecar, hooked
  into `applyToolsConfig` so it lands without a restart. The switch reports the
  three states separately — setting, model on disk, sidecar running — because a
  switch reading "on" for a server doing no retrieval is worse than one reading
  "off".
- **NARROWED 2026-09-04, not closed — the scope is now stated, the asymmetry remains.**
  The tool's description and its no-match reply both say it indexes this
  server's own tools, so a nil result is no longer readable as proof that a
  capability does not exist. The underlying asymmetry is unchanged.

  **The open decision:** retrieval could pin every tool it cannot recover — a
  client app's tools are eight names for Twig — making the rule "retrieval may
  only remove what search can find again". That is the principled fix and it
  costs part of every Twig user's tool budget on tools the conversation may not
  need. Not taken unilaterally; it is a product trade, not a bug fix.

- **(original wording) `search_tools` searches Nest's own catalog, not the client's payload.**
  D5 says it searches the post-ban set, and it does — but "the post-ban set"
  has two meanings that §0.3 already showed are different. It searches what
  Nest would serve over MCP; a client app's own local tools (Twig's `fs_*`)
  are not in it and cannot be found by describing them. Retrieval can drop
  them from a request, and search cannot get them back — they return only when
  the conversation drifts toward them. Closing this means giving the MCP
  server a view of the completions payload, which it deliberately does not
  have.
- **CLOSED 2026-09-04 — the readout says whose request it is.** It reads "Last
  request from any account" instead of "Last actual request", which was the
  whole gap: the limit was real and deliberate, and the UI did not state it.
  `observedWireCost` and the `ToolContextEstimate` type say the same thing at
  their definitions.

### Found 2026-10-26, not yet addressed

- **The fail-open test is intermittent.** `test-gateway-routes.mjs` "retrieval
  that fails open discloses nothing" failed with "the filter dropped something
  with no embedder: git_status". It failed once in the full chain and once run
  alone, including on a clean worktree at `0453409`, so it predates the
  plugin-constraints commit (`4a860ab`). It then passed on the next full run.
  **Suspected, not verified:** the test *assumes* no embedding server rather
  than ensuring one is absent, and the stub in the next test binds the real
  embedding port. A live Nest, or anything else on that port, would make the
  filter genuinely narrow. Fix by pointing this test at a port known to be
  closed, or by asserting the port is free first, so the test checks the
  fail-open path instead of the machine's state.

### Found by the agent bench, 2026-11-11 (for the next tool-discovery pass)

First real use of retrieval under load: the agent bench (`scripts/agent-bench/`,
agent-runtime plan Phase 0) ran 24 tasks on Qwen3-4B and Qwen3.6-35B with
retrieval on, 49 tools offered. Evidence: `redstart.log` `tools_filtered`
events (18:04 to 18:24 UTC) and the runs' event logs in
`scripts/agent-bench/results/2026-11-11T18-04-32-*` and `...T18-13-47-*`.
Nothing here is fixed yet; this is the list for that pass.

- **Retrieval offers the wrong tool family for attached files.** The query
  is the conversation text, so "read sales.csv" / "rename these files" scores
  the File System tools (`read_file`, `read_text_file`, `edit_file`,
  `write_file`, `move_file`) high on the word "file". Those work on a
  different root that never holds attachments. Both models reached for them
  first in most attachment tasks: 14 File System calls from the 4B, 32 from
  the 35B, nearly all failing or (worse) finding a stale file left by an
  earlier run. Retrieval has no idea where the data lives; relevance by
  description is not enough when two tool families describe the same verbs
  on different stores. Ideas, not decided: down-rank the File System family
  when the message carries an attachment note, or describe each family by
  its store ("the File System folder", "this chat's workspace") so the
  embedding can separate them.
- **The tool set swings from 2 to 35 tools between requests,** and grows
  within a conversation (carried tools plus new matches: 8, 13, 17, 21, 27
  ... in the histogram). Histogram over 94 + 120 requests: 2-5 tools on 21
  requests, 35 on 7. Two suspected costs, neither measured yet:
  (1) every change to the tool list changes the rendered prompt prefix, so
  llama-server re-reads the whole prompt instead of reusing its cache;
  (2) a 2-5 tool selection may drop run_python or the documents tools for a
  task that needs them. Needs per-conversation tracking to confirm.
- **Nobody can see which tools the model was given.** `tools_filtered` logs
  counts only (deliberately, for the support log). The bench records the
  49 tools *offered*, not the ~14 sent, so a failure cannot be traced to a
  dropped tool. Proposal: return the selected tool names to the same caller
  (a response header, opt-in), which tells it nothing it did not already
  send; the bench records them per turn.
- **search_tools is almost never used.** 0 calls from the 4B, 2 from the 35B
  (both in p4-git-log, looking for a capability that does not exist). So the
  safety valve for a dropped tool is not being pulled. With no record of the
  sent set (above), whether it *should* have been is unknown.
- **The bench's numbers depend on the retrieval setting, which the summary
  does not record.** Record `retrieval on/off` and the selection per turn
  (needs the header above), and run each model once with retrieval off as
  the comparison. The user suspects retrieval drives turn counts up. The
  traces so far point at wrong-family first attempts (which retrieval
  encourages, above) and at path confusion, not at extra turns from
  retrieval itself; the retrieval-off run would settle it. 49 tools is about
  5.6k tokens, which fits a 32k window.

### Carried from earlier phases


*(Updated at the moment each gap is created, per the standing rule. The
user-facing subset is mirrored into `docs/security.md` → Known gaps.)*

- **Closed by Phase 2.4:** the embedding model choice (design doc §7.1) is
  unanswered. Nothing before that step may depend on which model is used.
- **Deliberately open:** persisting the embedding cache across restarts (design
  doc §7.2). A cold cache costs one batch of embed calls on the first request
  after a restart. Revisit if a real registry makes that batch slow enough to
  notice.
- **Closed by Phase 5:** the Tools-tab estimate under-counts what actually goes
  on the wire (§0.3). It has been wrong since it was written; retrieval does not
  make it wrong, it makes it matter.
- **Open, no owner yet:** **mid-generation** context exhaustion
  (`server-context.cpp:3431`) is delivered as an SSE frame inside a live stream,
  not as a 400. Phase 0.2's annotation and the chat-ui's error dialog both miss
  it, so that failure still surfaces as a stream that simply stops. Fixing it
  means parsing the SSE body in the gateway, which the streaming path
  deliberately does not do today — a real change in kind, not an extension of
  0.2.
- **CLOSED 2026-09-04 by a real failure, not a test.** Phase 0.2's annotation
  was pinned only against the wire format read from the fork's source. A user
  enabling ~50 extra tools then hit the real thing on a 32,768-token profile,
  and the message came back exactly as designed: *"request (60916 tokens)
  exceeds the available context size (32768 tokens) ... About 58,881 of those
  tokens are the 84 tool definitions sent with this request"*. The error shape,
  the 400, the tool-cost annotation and the chat-ui's rendering of it all work
  end to end.
