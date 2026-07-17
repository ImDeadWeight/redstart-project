# Tool Ecosystem — Implementation Status, Testing Checklist & Remaining Plan

> Working doc for the MCP tool build-out (July 2026). Companion to the original
> "Redstart Tool Ecosystem Recommendations" planning doc. Update as items land.

---

## 1. What's built (all automated tests green)

| Layer | Delivered | Where |
|---|---|---|
| **Phase 0 — Foundation** | Shared symlink-aware path containment (`resolveWithinRoot`), registry-driven capability config, tool-name collision guard | `electron/main/path-scope.mjs`, `tools-storage.mjs`, `mcp-server.mjs` |
| **Phase 1a — SQLite** | `sqlite_query` / `sqlite_list_tables` / `sqlite_describe_table`; read-only via sql.js in-memory copy + `PRAGMA query_only`; 200 MB file cap | `electron/main/sqlite-tool.mjs` |
| **Phase 1b — Document reader** | `read_document` (.pdf/.docx/.txt/.md/.xlsx/.csv — pdf-parse v2, mammoth, ExcelJS; spreadsheets render one text table per sheet with formula results, 1000-row/sheet cap; 8k-char paginated) + `list_documents`; Documents folder is now read/write | `electron/main/documents-tool.mjs` |
| **Context layer** | Proactive summary-buffer compaction in the shared chat-ui (trigger 85% of usable ctx, keep 50%, progressive summary persisted per-conversation, branch-aware, fail-open); once a summary exists it shrinks EVERY send; context-usage indicator in the message bar (colored bar + %, click = manual compact via `compactNow`); tool-schema token accounting in the Tools card | `context-compaction.service.ts`, `ChatFormActionContext.svelte`, `estimateActiveToolTokens` in `mcp-server.mjs` |
| **Phase 2 — Vault** | `vault_search` / `vault_get` / `vault_tags` over any markdown folder (Obsidian/Logseq compatible; inline #tags + YAML frontmatter) | `electron/main/vault-tool.mjs` |
| **Phase 3 — Git** | `git_status` / `git_log` / `git_diff`; read-only by construction (execFile, fixed subcommands, `--` before file args) | `electron/main/git-tool.mjs` |
| **KV cache presets** | TurboQuant `-ctk`/`-ctv` preset dropdown (Off / Conservative / Balanced / Aggressive) wired through buildArgs + profiles | `electron/main/index.mjs`, `src/App.tsx` |
| **Default folder provisioning** | At startup, `<Documents>\Redstart\{Documents,Databases,Notes,Repos}` are created and set as default paths for Documents/SQLite/Vault/Git — one-click enable; never overrides user-chosen paths; capabilities stay disabled | `ensureDefaultCapabilityFolders` in `tools-storage.mjs`, called from `index.mjs` startup |
| **web_fetch overhaul** | Mozilla Readability article extraction (reader-mode text, not nav soup); `web_search` via first-party APIs (Wikipedia, arXiv, PubMed, MDN, Stack Overflow — query only goes to the searched site); per-profile whitelist toggle (off = any public site, SSRF guard always blocks LAN/private/loopback/non-http) | `electron/main/web-fetch-tool.mjs` |
| **Scholar capability** | `scholar_search` (OpenAlex/arXiv/PubMed), `scholar_get` (abstract+metadata by doi:/arxiv:/pmid:), `scholar_save_pdf` (server-resolved open-access PDF → Documents folder → readable via `read_document`); optional venue whitelist (journal ISSNs + arXiv categories) compiled into upstream queries and re-checked on get/save | `electron/main/scholar-tool.mjs` |

**Test suites:** `scripts/test-path-scope.mjs` (20), `scripts/test-mcp-capabilities.mjs` (48, Postgres section skips without a DB), `scripts/test-auth.mjs` (39), chat-ui `vitest --project=unit` (245, incl. 8 compaction tests).

**Live smoke test (done, headless):** real llama-server + Qwen3.6-35B on the RTX 3060 —
model loads at 16k ctx with the balanced preset; `/props` + `/tokenize` serve the compaction
inputs; the exact summarizer call produces a high-quality progressive summary; a live 4-hop
model→SQLite tool round trip (list → describe → 2 correct queries → correct answer).

### ⚠️ Finding from the live A/B (needs a decision)

`f16` vs `q8_0/turbo3` on **Qwen3.6-35B-A3B, 16k ctx, short prompts**: f16 was slightly
faster (44.7 vs 43.1 t/s gen; **74 vs 49 t/s prompt**) at identical VRAM. Qwen3.6 is a
hybrid Gated DeltaNet model — most layers keep a small constant state, not a growing KV
cache, so there is little KV to compress and turbo dequant costs prompt speed. KV quant
presets still matter for standard-attention dense models; they buy little on this one.

- [ ] **Decide:** flip default profiles from `kvCache: 'balanced'` back to `'off'`
      (keep the dropdown; note in the UI caption that hybrid-attention models may not benefit)
- [ ] Re-run the A/B with a long prompt (10k+ tokens in KV) before treating the short-prompt
      result as the final word

---

## 2. Testing checklist — what still needs verification

### A. In-app (GUI) smoke test — highest priority, nothing below the UI is untested
- [ ] `npm run dev` → Tools card shows SQLite / Vault / Git rows; folder pickers save; enable/disable toggles persist to `tools.json`
- [ ] Activate capabilities in a profile (Individual Sources list) → launch → chat-ui `tools/list` shows the expected set
- [ ] Token-cost line appears under "Max tokens per fetch" and updates when toggling tools; goes amber past 25% of ctx
- [ ] KV Cache dropdown renders, command preview shows `-ctk/-ctv` for each preset, `Off` omits them; saved profiles round-trip the value
- [ ] From the chat UI, exercise one tool from each provider end-to-end (create + read a document, query a fixture .db, search a notes folder, git status on a repo)
- [ ] **Compaction live:** long conversation at a small ctx (e.g. 4096) → verify compaction fires (`[ContextCompaction]` in console), no error dialog, summary persisted, model still answers with summarized context; toggle the setting off → old 400-dialog returns
- [ ] Settings toggle "Automatic context compaction" appears in chat settings (General)

### B. Packaged build
- [ ] `npm run build` → installed app: sql.js loads its `.wasm` from inside asar (open a .db via chat)
- [ ] pdf-parse + mammoth work in the packaged main process (read a .pdf and .docx)
- [ ] git provider works when the packaged app runs without a dev shell PATH

### C. Cross-client
- [ ] Twig Android + Twig Windows pick up the new tools via centralized MCP discovery (no per-device config)
- [ ] Compaction works from a remote browser client (it runs in the shared chat-ui, so it should — verify once)

### D. Known gaps / accepted risks (documented, not bugs)
- "Continue generation" path bypasses compaction (deliberate: compacting mid-continue risks breaking `continue_final_message`); can still 400 on overflow
- Postgres test section needs a reachable DB (`REDSTART_TEST_PG_URL`) to run — currently always skipped locally
- Compaction rewrites the prompt prefix → full KV reprocess on the turn after compaction (expected pause; by design, mitigated by hysteresis)
- Vault/document search is lexical (substring), not semantic; scanned/image PDFs yield no text (no OCR)
- Pre-existing unrelated svelte-check error in `ChatMessageUser.svelte` (`renderMarkdown` prop) — not from this work

---

## 3. Remaining implementation plan

### Phase 4 — Scoped filesystem manager (first write-capable tool; slow down here)
Tools: `fs_list`, `fs_move`, `fs_rename` inside one sandbox root.
- Containment via `resolveWithinRoot` on **both** source and destination of every operation
- No delete, no write-content, no chmod — move/rename/list only, at least initially
- Off by default, explicit per-profile opt-in, its own root (not shared with Documents)
- Consider dry-run/confirmation semantics for move/rename
- Tests must include: cross-root move rejection (src inside / dst outside and vice versa), overwrite-existing behavior, symlink-in-path rejection on both ends

### Phase 5 — MBOX email reader (read-only)
Tools: `search_emails`, `get_email` over local `.mbox` exports / Thunderbird folders.
- Read-only, no send, no server connections
- Needs an mbox parser (pure-JS, same test-harness-compatible bar as sql.js/pdf-parse)
- Lowest urgency; parsing complexity is the main cost

### Deferred (unchanged)
- **Autocomplete engine** — second small model, separate infrastructure project
- **Clipboard** — high-risk OS surface; revisit only after Phase 4 proves the write-scoping model

### Follow-ups (small, non-phase)
- [ ] KV default decision + UI caption tweak (see §1 finding)
- [ ] README: update Tools & MCP section for SQLite/Vault/Git/document-reading, compaction, KV presets, and correct the tested-configuration notes (Q4 model, measured numbers)
- [ ] Consider extracting the five near-identical capability rows in `App.tsx` into one component when the next capability lands
- [ ] Optional: per-fetch/per-read char caps configurable in the Tools card instead of constants

---

## 4. Working agreements (carried from the build)

- Every new capability = provider module (`toolDefs`/`callTool`) + one entry each in
  `PROVIDERS`, `BUILTIN_CAPABILITIES`, `DEFAULT_CAPABILITIES` + `buildGatewayConfig`
  block + IPC/preload pair + Tools-card row + test section. No transport changes.
- Tool names are namespaced (`sqlite_*`, `vault_*`, `git_*`); the MCP server warns and
  drops duplicates.
- Read-only is enforced by engines/construction, never by string-sniffing model input.
- All model-supplied paths go through `resolveWithinRoot`. One containment implementation,
  one audit surface.
- Activation is two-key (admin global + per-profile). No global "all tools on" switch —
  the token accounting exists to make the cost of big tool sets visible instead.
