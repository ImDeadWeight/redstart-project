# Redstart Connector Contract

For anyone building an application that talks to **Redstart Nest** — Twig,
Blueprints, Yellowscript, Greenhouse, or anything after them.

Connectors are standalone applications. They do not share code with Nest's
chat-ui and are not expected to track its changes. That makes this HTTP
contract the *only* coordination surface between independently-developed
codebases: anything not settled here gets implemented four different ways.

Conformance is machine-checked by `redstart-nest/scripts/test-connector-contract.mjs`,
which runs in `npm run test:security` and in CI.

**Licensing.** Nest is licensed under AGPL-3.0, but a connector is a separate
program, and the AGPL doesn't apply to it. You can release a connector under any
license, including a proprietary one. That holds as long as it talks to Nest
through this contract (HTTP), MCP or another interface, rather than copying
Nest's source into itself. See the [README's License section](../README.md#license).
The name "Redstart" is a trademark: a connector can say it works *with*
Redstart, but it can't present itself *as* Redstart
([TRADEMARKS.md](../TRADEMARKS.md)).

---

## 0. The one rule

**Send structured facts. Never send prose that is meant to steer the model.**

The system prompt is composed server-side, on every request, from admin-owned
blocks and facts derived from live configuration. A connector contributes to it
by sending *identifiers and data*, never sentences.

This is not stylistic. Four independently-released clients mean the server is
always talking to some old build; a versioned identifier can be normalised
server-side, shipped prose cannot. And the deployment's data-handling
disclosure (see §4) is only trustworthy if no client can assert a privacy
posture the server has not substantiated.

---

## 1. Base URL, auth, CORS

Everything is served by the Redstart gateway on the deployment's public port.
llama-server itself is bound to `127.0.0.1` on `port + 1` and is **not**
reachable; do not attempt to address it.

**When the deployment serves HTTPS** (Network & access → Secure address), the gateway
moves to loopback and the LAN reaches it only through `https://<name>` on
port 443, served by Nest's bundled Caddy with a real certificate. The beacon
(HTTP on port 8765) then carries `origin: "https://<name>"`; a connector that
discovers Nest by beacon should prefer that origin over `http://<ip>:<port>`,
and verify the certificate as normal (Twig does). A plain-HTTP address may
still answer while HTTPS is coming up, unless the admin set Require HTTPS.

| | |
|---|---|
| Auth | `Authorization: Bearer <token-or-api-key>` |
| Token | from `POST /auth/login`, or a long-lived account API key |
| Auth off | if the deployment sets `authRequired: false`, requests without a token succeed |
| Preflight | `Content-Type`, `Authorization`, `X-Redstart-Device-Id` are allowed |

`GET /auth/config` is public and tells you whether auth is required. Call it
before showing a login screen.

**Do not require auth to be on.** `authRequired: false` is a supported
deployment posture. A connector that refuses to work without a token breaks
single-user installs.

---

## 2. Chat completions

`POST /v1/chat/completions` — OpenAI-compatible, streaming (SSE) or not.

The gateway rewrites the request before forwarding:

- it **prepends** the composed system prompt to `messages`
- it **strips** any tool the deployment has banned, from `tools`,
  `tool_choice`, and pre-baked `tool_calls` in history
- it **consumes** Redstart-specific fields (§3) so llama-server never sees them

### What a connector may send

- `messages`, `stream`, `tools`, and the usual sampling parameters
- `redstart_mode` — a task mode **ID** (§3)
- `redstart_retrieval` — whether tool retrieval may narrow this request's
  `tools`. **By default it runs only on Redstart's own surfaces, as the
  credential names them**: a chat-UI login session (`nest-chat`) and a Twig
  client key (`twig`). Any other caller — an account-wide API key, another
  client key, login switched off — has its `tools` forwarded as sent, minus
  bans. `true` asks for retrieval anyway (Redstart's own clients send it, for
  installs with login off); `false` opts out on any surface, for a connector
  with its own short, curated list and no `search_tools` to recover a dropped
  tool. Bans apply either way. Only the literal booleans count; the field is
  consumed and never forwarded
- `redstart_conversation_id` — your id for this conversation (a printable
  ASCII string of at most 128 characters; anything else is ignored). Tool
  retrieval keys the tool set it chose for the conversation on it, under your
  account, so the set survives your client compacting or trimming the opening
  message. Without it the key is a hash of the first user message. Consumed and
  never forwarded
- `redstart_retrieval_report: true` — report which tools were actually
  forwarded, after bans and retrieval. The response carries
  `x-redstart-tools-sent` (the tool names, comma-separated, each one
  percent-encoded), `x-redstart-tools-filtered` (`1` when retrieval removed
  any tool, otherwise `0`) and `x-redstart-retrieval` (`on` when retrieval ran
  on this request, even if it kept every tool; `off` when it is disabled, the
  request opted out, or the request neither asked nor came from a Redstart
  surface), `x-redstart-tools-origin` (for each tool sent, when it
  came into this conversation and why, as `name=turn:why` comma-separated;
  `turn` counts user messages, `why` is `first`, `scored`, `called`,
  `search`, `describe`, `always` or `family`; empty when retrieval did not
  select), `x-redstart-tools-would-add` (how many tools a frozen tool set
  left out this turn) and `x-redstart-retrieval-config` (the retrieval
  settings the request ran with, as fixed-order `key=value` pairs separated
  by `;`: `mode` (`select` or `catalog`), `scorer`, `growth`, `text`, `min`,
  `callTool`, `floor`, `rel`, `margin`; `off` when retrieval did not run); all six are listed in
  `Access-Control-Expose-Headers`. Only the literal `true` asks; the field is
  consumed and never forwarded. The names go to the caller only, never to the
  log
- `redstart_retrieval_withhold` — an array of up to 64 tool names that
  retrieval leaves out of its selection. For testing discovery (the agent
  bench uses it): a withheld tool is still found by `search_tools` and
  `describe_tool`, and once one of them (or a call) brings it in, it stays.
  The memory, discovery and host-resolved tools are never withheld. It can
  only narrow the list, so bans are unaffected; anything but an array of
  names is ignored. Consumed and never forwarded
- `redstart_project` — the **id** of one of the caller's own projects (from
  `GET /projects`). Nest adds that project's instructions and memories to the
  prompt. An id the caller can't read adds nothing; the field is consumed and
  never forwarded
- unknown extra fields are tolerated and ignored, so a newer connector can
  talk to an older Nest

### What a connector must not rely on

A client-supplied `system` message is **not** authoritative. It is placed after
the admin policy block and after a precedence clause stating that later
instructions may adjust tone, verbosity and formatting, and may explain how to
use the app's own tools. Treat it as user preference text plus usage notes for
the tools you send, because that is how the model is told to treat it.

Do not put deployment policy, capability claims, or privacy statements in it.
They will be outranked, and in the privacy case they will be *wrong* — the
server already states the truth derived from live config.

---

## 3. Task modes

`GET /prompt-modes` → `{ modes: [{ id, label, summary }] }`

Send the chosen `id` as `redstart_mode` on the completion request. The server
resolves it to preset text.

An unrecognised ID is **dropped silently** — it does not error, and it does not
become prompt text. Sending prose in this field achieves nothing by design.

`label` and `summary` are for your picker only. The instruction text the model
actually receives is deliberately **not** exposed: it is server-owned, and a
connector that rendered it would eventually be tempted to edit it.

---

## 4. Prompt blocks and the egress audit

| Route | Method | Who |
|---|---|---|
| `/prompt-blocks` | `GET` | any authenticated user |
| `/prompt-blocks` | `PUT` | admin or owner only (`403` otherwise) |
| `/prompt-modes` | `GET` | any authenticated user |
| `/egress` | `GET` | any authenticated user |

`GET /prompt-blocks` returns the admin blocks, the limits, `canEdit`, and a
`composed` preview (`tokens`, `overBudget`, `blocks`, `prompt`). Read is open
to everyone deliberately: the policy block governs how the assistant treats
that user, and a rule someone is subject to should not be hidden from them.

`GET /egress` returns where data actually goes — whether inference is local,
which web domains tools can reach, which tool servers run off-machine, and
`externalTermsKnown` (currently always `false`).

`infrastructure` is a separate list, `[{ host, purpose }]`, of traffic that is
**not conversation data**: while Nest serves HTTPS on the LAN, its name provider
(the LAN address, when it changes) and Let's Encrypt (a verification record,
about every 60 days). It is empty otherwise, it never changes `hasEgress`, and
it is not part of the system prompt. Show it next to the conversation facts,
not inside them.

**A connector displaying privacy information must read it from `/egress`.**
Do not hardcode a privacy claim in your UI. Blueprints' README currently says
"no data leaving the building"; that is a property of a *configuration*, not of
Redstart, and a deployment with web tools or a remote MCP server has already
outgrown it.

If `hasEgress` is true and `externalTermsKnown` is false, say so plainly.
Silence about a third party's data handling reads as reassurance.

---

## 5. Surface identity

**Surface comes from the credential, never from a header.**

A user issues a per-connector key for their own account:

| Route | Method | Notes |
|---|---|---|
| `/auth/me/client-keys` | `GET` | lists your keys (no hashes) + valid surfaces |
| `/auth/me/client-keys` | `POST` | `{ surface, label }` → `{ apiKey, clientKey }` |
| `/auth/me/client-keys/:id` | `DELETE` | revokes immediately |

The raw key is returned **once** and only its hash is stored. Present it as a
normal bearer token; the server resolves both the account and the surface from
it. An unknown surface is refused at issue time.

Self-service only. There is no route to issue a key for another account — that
would be an impersonation primitive.

`X-Redstart-Surface` is still accepted and still **inert**: it cannot grant a
surface the credential did not. Both properties are asserted by the conformance
suite. Do not gate capability on the header.

`X-Redstart-Timezone` (optional, on `/v1/chat/completions`) is the user's IANA
zone, e.g. `America/Chicago`. Send it: the session block then states the
user's **local** date and labels the zone as theirs. Without it, or with a
value the server cannot format, the date is the server's, labelled as such.
Only the date is composed, never the time of day (a changing prompt prefix
defeats llama-server's prompt cache). chat-ui sends it on every completions
call.

Surfaces: `nest-chat`, `twig`, `blueprints`, `yellowscript`, `greenhouse`.
A registered surface may have no behavioural text yet — `greenhouse` does not —
in which case it authenticates normally and contributes nothing to the prompt.

---

## 6. Conversations

`GET|POST|PUT|DELETE /conversations[/:id]`, scoped to the authenticated account.
With auth off, scoping falls back to a client-chosen `X-Redstart-Device-Id`
header, which is unauthenticated and acceptable only in that posture. Send one.

---

## 7. Tasks

The tasks people give each other, which a planning client (Greenhouse) builds
on. Nest keeps the only copy: a client reads and writes them here and stores
none of its own. They live under `/work-items`. The assistant's background jobs are `/jobs`
(formerly `/tasks`, still accepted as an alias), and `/tasks` is never reused
for these.

| Route | Body or query | Answers |
| --- | --- | --- |
| `GET /work-items/mine` | `?include=done` `?today=YYYY-MM-DD` | `{ items, counts: { open, overdue }, limits }` |
| `GET /work-items/count` | `?today=` | `{ open, overdue }` |
| `GET /work-items/created` | `?include=done` | tasks the caller made that are in no project |
| `GET /work-items/assignees` | `?projectId=` | `{ accounts, groups }` a task can be given to |
| `GET /work-items` | `?projectId=` (required) `?include=deleted` | `{ items, limits }` |
| `POST /work-items` | `{ title, notes?, status?, dueDate?, projectId?, assignee? }` | the task, `201` |
| `GET /work-items/:id` | | the task with `history` |
| `PATCH /work-items/:id` | any of `title, notes, status, dueDate, assignee, projectId` | the task |
| `DELETE /work-items/:id` | | `{ deleted: true }`; restorable for 30 days |
| `POST /work-items/:id/claim` | | the task, now the caller's |
| `POST /work-items/:id/release` | | the task, back with its group |
| `POST /work-items/:id/restore` | | the task |

- `assignee` is `{ type: "account" | "group", id }` or `null`. `status` is
  `open`, `in_progress`, `blocked` or `done`. `dueDate` is a calendar date with
  no time or zone; send `today` from the user's own calendar so "overdue" is
  theirs.
- Every task carries `can` (`edit`, `status`, `assign`, `claim`, `release`,
  `delete`, `move`). Show what it allows; do not work the rules out yourself.
- A task the caller may not see is `404`; one they may see but not change is
  `403`. A `PATCH` with one field the caller may not change is refused whole.
- `startDate`, `estimate`, `blockedBy`, `milestoneId` and an assistant
  assignee are reserved for later phases and refused (`400`) until then.

---

## 8. Checklist

- [ ] Reads `GET /auth/config`; works with auth on **and** off
- [ ] Sends `Authorization` when it has a token; sends `X-Redstart-Device-Id`
- [ ] Sends no policy, capability, or privacy prose in a system message
- [ ] Sends `redstart_mode` as an ID from `/prompt-modes`, never prose
- [ ] Reads privacy text from `/egress` rather than hardcoding it
- [ ] Tolerates unknown fields in responses (forward compatibility)
- [ ] Does not address llama-server on `port + 1`
