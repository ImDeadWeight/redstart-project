# Tool retrieval (embeddings) + search_tools escape hatch — plan

**Created:** 2026-09-02
**Status: design record. The implementation plan is
`tool-retrieval-implementation.md`, written 2026-09-04 — read its §0 first:
six statements below are wrong or stale against the shipped tree, one of them
(§0 here, on the order of `enforceToolAllowList` vs `injectSystemContext`)
describes the opposite of what the code does and is a live bug. Its §1 also
reverses two recommendations below — §3's query side and §6's process shape —
and its D3 replaces §6's new sidecar with a second llama-server on the bundled
binary. §7's open questions are answered there or explicitly carried as gaps.**
**Origin:** a "test" prompt (fresh, short conversation) sent 59,649 tokens against a
32,768 `n_ctx` window and was rejected by llama-server. Root cause traced to an
enabled MCP plugin carrying ~40 tools, all sent as full schemas on every request
regardless of relevance. Not a crash or data-loss bug — a usability wall with no
diagnosis path (the rejection only appears in the raw llama-server console log).

---

## 0. What exists today

- Every tool schema (name, description, JSON param schema) is serialized into
  `parsed.tools[]` on every completions request — no per-turn filtering exists.
- Plugins default to `enabled: false` on install
  (`electron/main/ipc/plugins.mjs:361`), so nothing auto-enables a large tool
  set on you.
- `tools:estimate-context` (`electron/main/mcp-server.mjs:484`,
  `≈ JSON.stringify(tools).length / 4`) already estimates the token cost of the
  active tool set and is surfaced in the Tools tab
  (`src/tabs/ToolsTab.tsx:520-525`), turning amber past 25% of `ctxSize`. It is
  a **color hint only** — no gate stops enabling past 100% of context, and the
  resulting llama-server rejection is never translated into a UI message.
- `electron/main/tools-gateway.mjs` already runs one filter over
  `parsed.tools` before the request goes out —
  `enforceToolAllowList()` (`:132`), which strips server-banned tool names.
  This is the natural second hook point for a relevance filter: it runs
  **before** `injectSystemContext()` (`:89`) composes the system prompt, which
  matters because the prompt's capability claims must describe what the model
  actually received this turn, not the full enabled set.
- Tool sources are heterogeneous and dynamic, not a fixed catalog: Nest's own
  capabilities, installed plugins (`<plugin-id>__<tool-name>`, any of which can
  be installed/removed at runtime), and client-app tools (Twig `fs_*`,
  Yellowscript `ys_*`, Blueprints `bp_*`, Greenhouse `gh_*` — see
  `docs/tool-namespacing.md`). Any retrieval design must key off whatever is
  actually present in `parsed.tools` on a given request, never a hardcoded list.

---

## 1. The shape

```
[ Nest daemon ]
  ├─ Admin listener   :19083
  ├─ Gateway          :19080   ← retrieval filter lands here, in tools-gateway.mjs
  ├─ llama-server      :19081   (the chat model — untouched)
  ├─ MCP               :19082
  └─ Embed sidecar     :19084 (new) — tiny embedding model, CPU by default
```

Per request, in `tools-gateway.mjs`, after `enforceToolAllowList()` and before
`injectSystemContext()`:

1. Diff `parsed.tools[]` against the embedding cache (§2). Embed anything new.
2. Embed the current turn's relevance signal (§3).
3. Score every tool by cosine similarity, keep the top-k (§4) plus anything
   pinned (§4).
4. Always include one extra tool: `search_tools(query)` (§5), so the model has
   a way to reach anything that didn't make the cut.
5. Pass the trimmed `parsed.tools[]` on to `injectSystemContext()`, so the
   prompt's capability claims match what was actually sent.

---

## 2. The embedding cache — must be modular, not a static catalog

Tool sets differ per request (which plugins are enabled, which client sent the
request, what that client's own tool list contains this session) and change at
runtime (install/uninstall, enable/disable, a client that starts/stops sending
a tool). The cache cannot be seeded once from a fixed list.

- **Key:** a content hash of `(name + description + JSON schema)`, not the
  tool's id or source. Any tool with unchanged content reuses its embedding
  forever; changing a description or schema is itself a cache miss, which is
  correct — the text that changed is exactly what the embedding represents.
- **Population:** lazy. On each request, hash every tool in `parsed.tools[]`;
  anything not already cached gets embedded once (a single batched call to the
  sidecar for all misses that request) and stored. A freshly installed plugin
  or a client sending a tool Nest has never seen costs one embedding call the
  first time it appears and nothing after.
- **Storage:** in-memory `Map<hash, Float32Array>` is enough at this scale —
  even a few hundred tools is a trivial brute-force cosine-similarity scan,
  no vector index needed. Persisting it to disk (survive a restart) is a cheap
  add-on, not a requirement for Phase 1.
- **No source-specific logic.** The cache never asks "is this a plugin tool or
  a client tool" — it only ever sees `(name, description, schema)` triples.
  That is what makes new tool sources (a future client app, a new plugin type)
  work with zero code change here.

---

## 3. What gets embedded as the "query" side

Candidates, cheapest to most complete:

- **Last user message only.** Simplest, cheapest, matches the common case.
  Risk: loses context in a multi-step task where the relevant tool was implied
  several turns ago and isn't restated.
- **Last user message + the assistant's most recent tool calls this
  conversation** (names, not full results) — folds in "what has this
  conversation already been doing" without re-embedding the whole history
  every turn.
- **A sliding window of the last N messages**, concatenated. Better recall,
  proportionally more embedding-sidecar calls (still cheap — the sidecar is
  small and this runs once per turn, not per tool).

**Recommendation for Phase 1:** last user message + names of tools called in
the last 2 assistant turns. Revisit if retrieval turns out to miss tools a
real multi-step task needed.

---

## 4. Scoring: top-k, threshold, and pinning

- **Top-k with a floor, not a fixed count.** A hardcoded k=10 either wastes
  budget when few tools are relevant or starves a task that genuinely needs
  more. Use a similarity threshold first (keep everything above it), and only
  fall back to a fixed k as a cap so a pathological query (nothing scores well)
  doesn't send zero tools or the entire registry.
- **Pinned tools bypass scoring entirely.** Anything the admin's profile
  marks required (a tool always meant to be present regardless of relevance)
  and anything already invoked earlier in this conversation stays in every
  turn — dropping a tool the model already started using mid-task would be a
  worse failure than sending a few extra tokens.
- **The token budget still governs the cap.** Reuse `tools:estimate-context`'s
  cost model: keep adding tools by score until the running total would cross
  the same threshold that currently only turns the Tools-tab text amber (e.g.
  25-40% of `ctxSize`, leaving room for the conversation itself), not a bare
  tool count.

---

## 5. The `search_tools` escape hatch

One additional tool, always present regardless of scoring, cheap to describe:

```
search_tools(query: string) -> { name, description }[]
```

- Runs the same embedding + cosine-similarity path as the per-turn filter, but
  against the *full* registry (everything currently enabled, not just what was
  already included), and returns short summaries — not full schemas — so a
  broad query doesn't reintroduce the original problem one call later.
- When the model picks a result, the gateway needs a way to add that tool's
  full schema into the *next* turn. Simplest mechanism: the tool's result
  includes its name, and the model's next `tool_calls` entry naming it is
  honored by the gateway checking "was this tool returned by a recent
  `search_tools` call in this conversation" as an additional pinning rule
  (§4) — no new protocol needed, just one more source of "pinned" alongside
  admin-required and already-invoked.
- This is what makes top-k safe to be aggressive about: a wrong guess at
  relevance is recoverable in the same conversation instead of silently
  stranding a task.

---

## 6. The embedding model and sidecar

- **Model:** a small dedicated embedding model — `bge-small-en-v1.5` (33M) or
  `all-MiniLM-L6-v2` (22M) are the two obvious GGUF-available candidates.
  Tens of MB on disk, no meaningful VRAM cost even if GPU-hosted.
- **Where it runs: CPU by default.** At this size, CPU inference is
  single-digit milliseconds per embed, and it never competes with the chat
  model for the GPU's VRAM/compute during generation — a real concern on a
  single-GPU box already carrying a large model. Offer a GPU toggle as an
  option, never the default.
- **Process shape:** managed the same way the gateway/MCP sidecars already
  are — spawned by the daemon, its own port, own lifecycle tied to the daemon
  (not to whether a chat model is running, so `search_tools` and the retrieval
  filter work even if no model is currently launched... though in practice
  there is nothing to send a completions request to in that state anyway, so
  this mostly matters for warm-starting the cache before the first launch).
- **Bundling/download:** follows whatever pattern `models.mjs`'s existing
  model-download flow already uses — this is a small, fixed, Nest-chosen file
  (not a user-picked model), so it can likely be fetched once at first boot
  rather than requiring a picker.

---

## 7. Open questions — need an answer before Phase 1

1. **Exact model file + quantization.** Needs a quick empirical check: does
   `bge-small` or `MiniLM` do better at distinguishing tool descriptions in
   this domain (short, jargon-heavy, often multi-action strings per
   `TruncatedText`'s own comment about "documenting every `action` value")?
2. **Persisting the embedding cache across restarts.** Worth it once tool
   registries grow large, skippable for Phase 1 (cache rebuilds from the first
   request after a restart, which costs one batch of embedding calls, not a
   correctness issue).
3. **Interaction with `disabledTools`/role narrowing.** Retrieval must run
   strictly after `enforceToolAllowList()`, never before — a banned tool must
   never be embeddable-back-in via `search_tools` either. `search_tools`'s
   full-registry search needs to search the *already-filtered* registry, not
   the raw one.
4. **Failure mode of the sidecar itself.** If the embedding process is down or
   errors, does the gateway fail the request, or fall back to sending the
   full (unfiltered) tool list — i.e. today's behavior, byte-identical? Fall
   back to today's behavior is the safer default: retrieval is an optimization,
   not a security boundary, and a hard failure here would take down every
   tool-using request over an unrelated process crash.

---

## 8. Suggested order

**Phase 1 — sidecar + cache, no filtering yet.** Stand up the embedding
process, the content-hashed cache, and the diff/embed-on-miss logic. Verify
against `tools:estimate-context`'s existing numbers (embed the same tool sets
that currently light up the amber warning) before anything gates real
requests.

**Phase 2 — the gateway filter.** Wire scoring + top-k/threshold + pinning
into `tools-gateway.mjs`, gated behind a setting so it can be turned off
per-profile while it's new. Verify the system-prompt ordering point from §0
holds (prompt claims match what's actually sent).

**Phase 3 — `search_tools`.** The meta-tool, the full-registry search path,
and the "recently returned by search_tools" pinning rule.

**Phase 4 — turn the existing amber warning into a real number the admin can
reason about** (e.g. show what % of turns are actually filtered, or how often
`search_tools` gets called) rather than leaving it as a static estimate.

Independent of all of this and worth doing regardless of whether retrieval
ships: **translate the llama-server context-exceeded rejection into a legible
in-chat message.** Cheap, fixes the immediate confusion on its own, and is the
fallback message for whenever retrieval's cap estimate is wrong.
