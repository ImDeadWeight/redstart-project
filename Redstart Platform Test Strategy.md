# Redstart Platform Test Strategy & Coverage Roadmap

## Purpose

This document describes how Redstart's testing protects its most important
architectural guarantees as the project grows from a single application into a
**multi-application ecosystem** built on a shared Core.

The goal is not to maximize test count.

The goal is to keep Redstart's load-bearing guarantees true as Core evolves and
as new applications (Chat, IDE extension, mobile, future domain products) are
built on top of it.

---

# Philosophy

The most valuable tests are not feature tests. They are **invariant tests** —
rules that must never become false regardless of future development.

Example:

```text
llama-server must remain localhost-only
```

In the ecosystem Redstart is heading toward (see *Redstart Multi-Application
Ecosystem Architecture*), an invariant and a **service contract are the same
thing**. "Every authenticated access passes through the gateway" is both a
security rule and the promise every downstream app is built on. That is why the
tests worth writing now are the ones that pin behavior **at the boundary Core
exposes to its consumers** — because those same tests become the guardrails that
let Core change without breaking every app that depends on it.

Two principles follow from this:

1. **Test the boundary, black-box.** Prefer tests that drive Core the way a real
   application does — over the gateway HTTP API and the MCP JSON-RPC transport —
   rather than importing Core internals. A test that reaches into a module's
   private functions stops reflecting reality the moment Core is extracted into
   its own service.

2. **Own the test infrastructure the way Core owns product infrastructure.**
   Where many components must uphold the same contract (every provider, every
   authenticated route), write the invariant once and run it against all of
   them, rather than re-proving it per component.

---

# Current State of Coverage

This is an **expansion**, not a green field. Redstart already ships a real,
deliberate security suite wired into `npm run test:security`:

| Suite | Style | Boundary |
|---|---|---|
| `scripts/test-path-scope.mjs` | plain Node, pure unit | internal (`path-scope.mjs`) |
| `scripts/test-auth.mjs` | plain Node, **real gateway + MCP over HTTP** | boundary ✅ |
| `scripts/test-mcp-capabilities.mjs` | plain Node, **real MCP over JSON-RPC** | boundary ✅ |
| `src/chat-ui/tests/unit/security.test.ts` | vitest, ~72 cases | internal imports ⚠️ |

Honest inventory against the priorities below: **P1–P6 are already well
covered.** A naive "implement the strategy" pass would largely duplicate
existing tests. The value of this effort is in (a) the genuine gaps, (b) an audit
of what exists, and (c) infrastructure that makes future coverage cheap.

Coverage summary:

| Priority | Status |
|---|---|
| P1 Authentication & Authorization | **Deep** — login success/fail, no username enumeration, sessions, role hierarchy, API-key-as-bearer, scrypt + timing-safe verify, hash-only storage, owner bootstrap |
| P2 Filesystem Security | **Deep** — `../`, `..\`, absolute, Windows drive-letter, symlink escape, read-only + delete-disabled policy enforced server-side |
| P3 Gateway Security | **Good** — auth enforcement, role gating, malformed JSON, missing fields |
| P4 Tool Permission Model | **Good** — read-only can't write/delete, write/delete gated server-side even on direct call |
| P5 MCP Security | **Good** — unknown/disabled tool → `isError` not crash, capability gating, per-tool traversal |
| P6 Web Fetch (SSRF) | **Partial** — LAN/private/reserved blocked, non-http schemes blocked; **redirect chain untested** |
| P7 Discovery & Networking | **Partial** — beacon payload asserted to leak no secrets; **malformed traffic untested** |
| P8 Conversation & Data Storage | **GAP** — isolation is `accountId`-keyed in code but **not tested** |
| P9 Architecture Invariants | **Partial** — mostly restates P1–P6; **llama localhost-only not asserted by a test** |
| P10 Regression | Process, ongoing |

---

# The Service-Boundary Principle

Redstart Core will expose stable services (Model, Conversation, Provider,
Device). Applications are thin clients that consume those services. Testing
strategy tracks that shape:

* **Core service contract → test at the boundary (HTTP / MCP).** These tests are
  what any future app depends on.
* **Application UI/domain logic → out of scope here.** Chat UI internals (e.g.
  `chat.svelte.ts`) will churn and belong to the application, not Core. They get
  their own functional tests, separately from this security/contract effort.

**Forward rule:** any *new* test covering infrastructure a future application
would consume is written black-box against the gateway/MCP boundary from day
one. This costs nothing extra and stops new coupling from accumulating.

**Extraction stance — direction, not imminent.** The HTTP/MCP boundary already
exists and is already black-box tested (`test-auth`, `test-mcp-capabilities`).
Existing internally-coupled tests (`security.test.ts` importing
`electron/main/*.mjs`) are **not** force-migrated now — doing so buys no new
coverage and guesses at a boundary that hasn't physically moved. The audit flags
them; the migration trigger is the day Core is physically extracted and the deep
import breaks, at which point the test is rewritten against the *real* new
boundary. New work follows the forward rule above so the problem stops growing.

---

# Priority Reference Map

The original priorities are retained below as the invariant catalogue. Each is
tagged with its current status so this doc doubles as a coverage map rather than
a to-do list that ignores what exists.

## Priority 1 — Authentication & Authorization — **COVERED**

* Session auth: valid login creates session + token; invalid password / unknown
  user / malformed request rejected; expired vs. active enforced; sessions
  revoked on logout and on account delete.
* API key auth: authorized + account resolution; invalid rejected; cannot
  impersonate; **keys stored as hashes only, plaintext never on disk**.
* Owner bootstrap: local path succeeds; **remote/gateway owner creation
  impossible**.

> Note: "sessions disappear after Nest restart / sessions memory-only" is treated
> as an implementation detail, not a tested invariant. The meaningful guarantee —
> sessions are revoked on logout/delete — is already covered.

## Priority 2 — Filesystem Security — **COVERED**

* Path traversal (`../`, `..\`, mixed) denied; containment maintained.
* Symlink escape blocked via realpath validation.
* Windows mixed separators, drive-letter, case-insensitive containment.
* Read-only mode blocks writes; delete-disabled blocks deletion; toggles
  enforced server-side.

*(Unicode path handling — low-priority residual check, see Gaps.)*

## Priority 3 — Gateway Security — **COVERED**

* Protected routes require auth; unauthenticated rejected (no localhost bypass).
* Role restrictions enforced consistently.
* Invalid payloads / malformed JSON / missing fields rejected.
* Gateway required; protected services not reachable directly.

## Priority 4 — Tool Permission Model — **MOSTLY COVERED**

* Read-only tools cannot write/modify/delete.
* Write and delete require appropriate permission, enforced server-side even on
  a direct call.
* **Gap:** explicit permission-escalation / self-promotion attempt (a tool
  claiming a capability it was not granted).

## Priority 5 — MCP Security — **MOSTLY COVERED**

* Invalid/unknown tool calls → JSON-RPC error, not crash.
* Execution limited to declared, enabled capabilities.
* **Gap:** cross-tool isolation (one tool inheriting/impersonating another) and
  external-MCP constraint are not explicitly asserted.

## Priority 6 — Web Fetch Security — **PARTIAL**

* SSRF: localhost / 127.0.0.1 / private LAN / reserved ranges blocked. ✅
* Protocol: `file://`, `ftp://`, custom schemes rejected. ✅
* **Gap:** redirect chain re-validation (allowed URL → redirect → blocked
  destination). Code implements per-hop manual re-validation
  (`web-fetch-tool.mjs`) but **no test guards it.**

## Priority 7 — Discovery & Networking — **PARTIAL**

* Beacon advertises only the app identity marker + running/port — **no version,
  auth, or server URLs.** ✅
* **Gap:** malformed discovery packets → rejected safely, no crash.

## Priority 8 — Conversation & Data Storage — **GAP**

* `conversations-storage.mjs` is `accountId`-scoped, but nothing asserts a user
  cannot read/update/delete another user's conversation. In a multi-app,
  multi-user Core this is **load-bearing** and must be a tested invariant.

## Priority 9 — Platform Architecture Invariants — **PARTIAL**

* Gateway enforcement, tool permissions server-side, owner local-only, API-key
  hash-only — all effectively covered by P1–P4.
* **Gap:** **llama-server localhost-only** — enforced by config
  (`--host 127.0.0.1`, `index.mjs`) but asserted by no test. This is P9's
  headline invariant and deserves a direct guard.

## Priority 10 — Regression Testing — **PROCESS**

Every discovered security bug becomes a permanent regression test:
reproduce → failing test → fix → commit the test. Unchanged.

---

# The Plan

Sequenced **B → A → C → D**: immediate security value first, then the audit that
informs extraction, then the harness once invariants are proven, then
shape-locking.

## Track B — Fill the real gaps *(boundary-level, contract-shaped)*

1. **Web-fetch redirect chain** — public/allowed URL redirecting to a LAN/blocked
   destination is rejected; each hop re-validated. *(untested; code exists)*
2. **Conversation isolation** — user A cannot read/update/delete user B's
   conversation.
3. **Account / session isolation** — a session/token issued for one account
   cannot reach another account's data across the boundary.
4. **Malformed discovery traffic** — garbage packet → rejected safely, no crash.
5. **Permission / capability escalation** — a tool/provider cannot claim a
   capability it was not granted.
6. **llama-server localhost-only invariant** — assert the bind contract directly.
7. *(residual)* Unicode path containment edge check.

## Track A — Audit the existing ~150 tests

* Flag tests coupled to Core internals via deep relative imports
  (`security.test.ts`) and mark them "migrate on extraction" — do **not** rewrite
  now.
* Verify the highest-value tests (auth gate, path containment, read-only/delete
  policy) assert **behavior at the boundary**, not implementation detail.
* Output: a short findings list; no bulk rewrites.

## Track C — Provider conformance harness *(strategic investment)*

The ecosystem doc requires providers to "expose a common interface regardless of
which application consumes them." Make that a **tested** guarantee: one invariant
battery, parameterized over every provider (web-fetch, documents, sqlite, git,
vault, scholar, postgres, fs), run over the MCP boundary:

* disabled capability → not advertised in `tools/list` **and** refused if called
  directly;
* path/traversal arguments rejected;
* bad input → `isError`, never a crash;
* write/delete gated server-side by policy.

Every **future** provider then inherits its security tests for free.

## Track D — Contract / shape snapshots *(replaces Phase 3 perf/stress)*

Lock the shapes future apps consume so a Core change that would break a consumer
fails loudly:

* `tools/list` output shape, `auth/config` shape, beacon payload (extend the
  existing "only these fields" assertion), core service response shapes.
* Small **fuzzers** on boundary parsers only: path, JSON payloads, discovery
  packets.

> **Dropped from the original Phase 3:** load / stress / performance testing —
> low ROI for a local host. Fuzzing is kept but narrowed to boundary parsers.

---

# Recommended Coverage Order

1. **Track B** — close the real security gaps (highest immediate value).
2. **Track A** — audit; informs the extraction boundary.
3. **Track C** — provider conformance harness; compounds over every future provider.
4. **Track D** — contract snapshots + boundary fuzzers.

---

# Success Criteria

The platform should be able to answer, for any consuming application:

> "How do you know this security property — and this service contract — still
> holds?"

with:

> "Because it is protected by automated tests that run at the boundary on every
> commit, and every provider and route must pass the same shared invariants."

That confidence is what lets new applications be built on Redstart Core without
rebuilding — or re-verifying — its foundations.
