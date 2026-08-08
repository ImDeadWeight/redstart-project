# Redstart Connector Contract

For anyone building an application that talks to **Redstart Nest** — Twig,
Blueprints, Yellowscript, Greenhouse, or anything after them.

Connectors are standalone applications. They do not share code with Nest's
chat-ui and are not expected to track its changes. That makes this HTTP
contract the *only* coordination surface between independently-developed
codebases: anything not settled here gets implemented four different ways.

Conformance is machine-checked by `redstart-nest/scripts/test-connector-contract.mjs`,
which runs in `npm run test:security` and in CI.

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
- unknown extra fields are tolerated and ignored, so a newer connector can
  talk to an older Nest

### What a connector must not rely on

A client-supplied `system` message is **not** authoritative. It is placed after
the admin policy block and after a precedence clause stating that later
instructions may adjust tone, verbosity and formatting only. Treat it as user
preference text, because that is how the model is told to treat it.

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

Surfaces: `nest-chat`, `twig`, `blueprints`, `yellowscript`, `greenhouse`.
A registered surface may have no behavioural text yet — `greenhouse` does not —
in which case it authenticates normally and contributes nothing to the prompt.

---

## 6. Conversations

`GET|POST|PUT|DELETE /conversations[/:id]`, scoped to the authenticated account.
With auth off, scoping falls back to a client-chosen `X-Redstart-Device-Id`
header, which is unauthenticated and acceptable only in that posture. Send one.

---

## 7. Checklist

- [ ] Reads `GET /auth/config`; works with auth on **and** off
- [ ] Sends `Authorization` when it has a token; sends `X-Redstart-Device-Id`
- [ ] Sends no policy, capability, or privacy prose in a system message
- [ ] Sends `redstart_mode` as an ID from `/prompt-modes`, never prose
- [ ] Reads privacy text from `/egress` rather than hardcoding it
- [ ] Tolerates unknown fields in responses (forward compatibility)
- [ ] Does not address llama-server on `port + 1`
