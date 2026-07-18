# Diagnosis: chat-ui send is broken (Redstart project)

> RESOLVED 2026-07-18. Root cause was **server-side CORS**, confirmed from the
> live Twig console. Not the client, not the agentic/tools code.

## ROOT CAUSE #0 (confirmed live) — DatabaseService sends no auth token

After the crypto fix landed (bundle CQKgHHG5), on `http://localhost:19080` while
logged in as the owner, every `/conversations` call returned **401**
(migration, loadConversations, createConversation → send). The request reaches
the gateway and is rejected as unauthenticated. Cause: `DatabaseService` has its
own `apiFetch` wrapper that sent only `Content-Type` + `X-Redstart-Device-Id` —
never the `Authorization: Bearer <token>` header. Completions/tools use
`getJsonHeaders()` (which includes auth), so only the conversation routes broke,
and only once auth became required (secure-by-default).

### Fix (database.service.ts)
Added `getAuthHeader()` — reads the session token straight from localStorage
(where the auth store persists it, JSON-stringified; direct read avoids the
store circular dep this file is built around) and attaches
`Authorization: Bearer <token>` to every request. Rebuild chat-ui; reload.

## ROOT CAUSE #1 (confirmed, most universal) — `crypto.randomUUID` in an insecure context

Console (Chrome, on the server machine AND a separate laptop — NOT phone-specific):

```
TypeError: crypto.randomUUID is not a function
    at createConversation (database.service.ts) -> sendMessage
```

`crypto.randomUUID()` is only defined in a **secure context**: HTTPS, or
`localhost`/`127.0.0.1`. Over plain HTTP to `redstart.local` or a LAN IP it is
`undefined` — on **every** device (the server's own Chrome via the hostname, a
laptop, a phone). Only the server machine via `http://localhost` works. It
throws synchronously inside `DatabaseService.createConversation()` *before* any
network call, so send aborts and the gateway never logs a request — the exact
symptom, on all multi-device HTTP access.

### Fix (src/chat-ui/src/lib/services/database.service.ts)
Replaced the two direct `crypto.randomUUID()` calls (device id + conversation
id) with the existing `uuid()` helper, which is
`globalThis.crypto?.randomUUID?.() ?? <fallback>` — safe in insecure contexts.
Requires rebuilding the chat-ui (`npm run build` in src/chat-ui) and serving the
fresh `dist`.

## ROOT CAUSE #2 (confirmed) — malformed CORS from the gateway

The browser console showed:

```
Access to fetch at 'http://127.0.0.1:19080/props' from origin
'http://127.0.0.1:53592' blocked by CORS policy: The
'Access-Control-Allow-Origin' header contains multiple values
'*, http://127.0.0.1:53592', but only one is allowed.
```

The gateway proxies `/props`, `/v1/chat/completions`, etc. to llama-server.
llama-server reflects the request Origin into its own `access-control-allow-origin`
header. The gateway's `passthrough`/`forwardModified` did
`res.writeHead(status, { ...proxyRes.headers, 'Access-Control-Allow-Origin': '*' })`
— the spread key is lowercase (`access-control-allow-origin`) and the added key
is capitalized, so BOTH were emitted → two values → every cross-origin call from
a UI served on a different origin (Twig's file server, the web dev server) was
blocked. The `POST /v1/chat/completions` preflight failing is why the server
terminal never logged the request.

Second, related bug: the CORS preflight `Access-Control-Allow-Headers` listed only
`Content-Type, Authorization` but the chat-ui's `DatabaseService` sends
`X-Redstart-Device-Id` on every `/conversations` call — so those were blocked too.

### Fix (electron/main/tools-gateway.mjs)
- Added `withoutUpstreamCors()` to strip any upstream `access-control-allow-origin`
  before the gateway sets its single `'*'`. Applied in `forwardModified` and
  `passthrough`.
- Added `X-Redstart-Device-Id` to the preflight `Access-Control-Allow-Headers`.

Requires restarting the Redstart Nest app (main-process code).

---

> Earlier reproduction notes (still valid background) below.

## TL;DR (corrected)

**The chat-ui client code is NOT broken, and neither is the port-80 proxy.**
When the chat-ui is pointed at a server that answers all of its endpoints, a
message sends end-to-end with every current uncommitted change in place
(agentic fallback parser, `LOCAL_FS` tools, tools reorder, connection gate,
loading screen, port-80 proxy).

The "send does nothing / gateway never logs `/v1/chat/completions`" symptom is
caused by **an upstream API/init request failing before the completions call is
ever made** — most often the conversation/DB endpoints or the model not being
ready. `sendMessage` creates the conversation + user/assistant messages
(`/conversations` GET/POST/PUT) *before* it streams the completion; if any of
those fail, it aborts before reaching `/v1/chat/completions`.

## How this was proven (live reproduction)

A mock server served the **built `dist`** and mocked the Nest API
(`/props`, `/auth/config`, `/tools`, `/v1/models`, `/conversations` document
store, and a streaming `/v1/chat/completions`). Driven headlessly:

- Full healthy mock  → textarea enabled → `POST /v1/chat/completions` fires →
  streamed reply renders. **Send works.**
- Same, but routed through the exact **port-80 proxy** forwarding logic → send
  still works. **Proxy is fine.**
- Mock with the `/conversations` endpoints **removed** → textarea enabled, send
  does nothing, **no completions call**, console shows
  `Failed to initialize conversations: Unexpected token '<'`. **This is the
  user's exact symptom** — and it is an upstream endpoint failure, not client
  logic.

## What is NOT the cause (ruled out)

- The agentic flow / `getEnabledToolsForLLM` / `LOCAL_FS` reorder — the fallback
  parser and `LOCAL_FS` branch both run *after* the turn's HTTP call; on web
  there are zero `LOCAL_FS` tools anyway. Send fires regardless.
- The port-80 proxy — forwards POST bodies and SSE streams correctly.
- `chat.svelte.ts` — only a blank line changed vs. the baseline. Its ~9
  type-check errors are pre-existing and runtime-irrelevant.
- Server endpoint handling — `/conversations`, `/props`, `/tools`,
  `/v1/chat/completions` are unchanged from the working baseline `903a51d`.

## Real root cause — where to look in the live app

`ChatScreen.onSend -> chatStore.sendMessage` (chat.svelte.ts:539). Before it ever
streams a completion it does:

1. `conversationsStore.createConversation()` -> `POST /conversations`
2. `DatabaseService.createRootMessage` / `addMessage` -> `GET`/`PUT
   /conversations/:id`
3. only then `streamChatCompletion` -> `runAgenticFlow` or
   `ChatService.sendMessage` -> `POST /v1/chat/completions`

If step 1 or 2 fails (server error, wrong shape, auth/device-id rejection,
corrupt `conversations.json`), send aborts before step 3 — no completions call.

Two silent-return guards can also make it "do nothing" with no dialog if a flag
is stuck from a prior failed turn:
- `sendMessage` returns early if `agenticStore.isRunning(convId)` (injects a
  steering message), or
- if `isChatLoadingInternal(convId)` (injects a pending message).

## The decisive 30-second diagnostic

Open the real app, DevTools → **Network** tab, click send, and read the first
**failed (red)** request:

- Failing `/conversations*` (4xx/5xx or HTML body) → the DB/conversation path,
  or an auth/device-id/account mismatch. Fix that endpoint / auth.
- Failing `/props` or a red gate (loading screen, not chat) → server/model not
  actually up.
- `/v1/chat/completions` fires but errors → model not loaded on llama-server.
- **No request at all on send** → a stuck `isRunning`/`isChatLoading` flag;
  reload the page and it should send (then find what left the flag stuck).

Report that request's URL + status and the fix is targeted from there.
