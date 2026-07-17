# Redstart Nest — Auth Gate & Account UI Plan

This is a handoff document for an implementing agent with no memory of the
conversation that produced it. Read this whole file before touching any code.
File paths and line numbers were correct at time of writing — **re-read each
file immediately before editing it**, since line numbers drift.

## Background — what's broken and why

Redstart Nest runs a small Node `http.Server` "gateway" in front of
llama-server (`electron/main/tools-gateway.mjs`). It listens on the
LAN-facing port and is meant to require login when the "accounts" toggle
(`authRequired`) is on.

**The bug:** the gateway's auth check runs on *every* request that isn't
`/auth/*` — including the request for the chat-ui's own HTML/JS/CSS. So when
a second device (not the host machine) requests the page itself, the gateway
returns `401 {"error":"Unauthorized"}` as the page body, and the browser shows
raw JSON on a black page instead of ever loading the app. This only "works"
on the host machine because `authenticate()` exempts localhost
(`electron/main/auth.mjs`, `isLocalhost()`), which is why the bug only shows
up on remote devices.

A browser also cannot attach the bearer token to a plain page/asset
navigation (the token lives in localStorage and only rides on `fetch()`
calls), so static assets must always be served openly — auth has to happen
at the API-call layer, not the page layer.

**Desired end state:**
1. Visiting the chat-ui on any device shows a loading screen, then either the
   login form (if accounts are required and you're not logged in) or the
   chat app (if you are, or if accounts aren't required). The chat/settings
   UI itself must never be visible or reachable before login when accounts
   are required.
2. When the "accounts" toggle is **off**, none of this applies — no login,
   no API key, fully open, exactly like today. Do not break this path.
3. A top-level user menu (avatar/username, outside Settings) with profile
   info and a Log out button.
4. Users can see and regenerate their own API key (self-service, not just
   admin-managed).
5. New API keys use an `rst_` prefix instead of the old `bvr_` (leftover
   branding from before this project was renamed from "Beaver" to
   "Redstart"). Existing `bvr_` keys must keep working — do not force
   rotation.

## Ground rules for whoever implements this

- Work through the workstreams **in order** (1 → 2 → 3 → 4). Each is
  independently testable. Don't start the next until the current one
  builds/typechecks and behaves as described in its own verification step.
- After editing any file in `redstart-nest/src/chat-ui`, rebuild before
  testing: `cd redstart-nest && npm run build:chat` (this regenerates
  `src/chat-ui/dist`, which is gitignored and not auto-rebuilt).
- After editing chat-ui TypeScript/Svelte, run
  `cd redstart-nest/src/chat-ui && npm run check` and fix any new errors your
  change introduced. (There is one pre-existing unrelated error in
  `ChatMessageUser.svelte` about a `renderMarkdown` prop — ignore that one,
  it predates this work.)
- Do not rename or restructure things beyond what's specified here. Small,
  verifiable diffs.
- Security-sensitive change: Workstream 1 changes what is and isn't
  auth-gated on a network-facing server. Prefer an explicit **allow-list**
  of public static-asset patterns over a deny-list of protected ones — if a
  new API route is added later and someone forgets to add it to a deny-list,
  it should default to *protected*, not *public*.

---

## Workstream 1 — Gateway: serve the app shell publicly, gate the API (fix the actual bug)

**File:** `redstart-project/redstart-nest/electron/main/tools-gateway.mjs`

Current relevant code (inside `startGateway`'s `http.createServer` callback,
after the `/auth/` branch around line 251-265):

```js
      const urlPath = req.url.split('?')[0]
      if (urlPath.startsWith('/auth/')) {
        return await handleAuthRoute(req, res, urlPath)
      }

      // Everything else requires a valid session/API key when auth is
      // required — localhost is always exempt (see auth.mjs isLocalhost).
      const authResult = authenticate(req)
      if (!authResult.ok) {
        res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: { message: 'Unauthorized', type: 'auth_error' } }))
        return
      }
```

**Change:** insert a check *before* the `authenticate(req)` call that lets
static-asset / app-shell requests through unauthenticated. Something like:

```js
      const urlPath = req.url.split('?')[0]
      if (urlPath.startsWith('/auth/')) {
        return await handleAuthRoute(req, res, urlPath)
      }

      // The app shell itself (HTML/JS/CSS/icons/PWA manifest) must always be
      // servable so the login screen can even load — a browser can't attach
      // the bearer token to a page/asset navigation anyway (it only rides on
      // fetch() calls), so gating this layer is both impossible to do
      // correctly and unnecessary. Only the API surface below is gated.
      // Fail-closed: only things that clearly look like static assets are
      // public; everything unrecognized falls through to the auth check.
      const STATIC_ASSET_PATTERN = /^\/($|_app\/|redstart\.svg|favicon|manifest\.webmanifest|sw\.js|workbox-|apple-|robots\.txt|[^/]+\.(js|mjs|css|svg|png|ico|webp|woff2?|json)$)/
      if (req.method === 'GET' && STATIC_ASSET_PATTERN.test(urlPath)) {
        return passthrough(req, res, internalPort === undefined ? publicPort + 1 : internalPort)
      }

      // Everything else requires a valid session/API key when auth is
      // required — localhost is always exempt (see auth.mjs isLocalhost).
      const authResult = authenticate(req)
      if (!authResult.ok) {
        res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: { message: 'Unauthorized', type: 'auth_error' } }))
        return
      }
```

Important details to get right:
- This gateway does **not** serve files from disk itself — it proxies
  everything to llama-server (the `passthrough(req, res, internalPort)` call
  at the bottom of the handler, and llama-server serves the chat-ui's built
  `dist/` folder via its own `--path` flag; see
  `buildArgs()`/`--path` in `electron/main/index.mjs` around line 1362).
  So "serve it publicly" here just means: **skip the auth check and fall
  through to the same `passthrough(...)` call that already exists at the
  bottom of the handler** — do not write a second file-serving code path.
  Read the full handler function before writing this change so the
  static-asset branch calls the *same* passthrough function with the same
  arguments the final `// Everything else → passthrough to llama-server`
  line already uses.
- `internalPort` is already computed once near the top of `startGateway` as
  `const internalPort = publicPort + 1` — reuse that variable, don't
  recompute it. (The snippet above shows a fallback expression only because
  the exact variable name wasn't double-checked against the file; use the
  real variable.)
- The regex must match `/` (the root document), everything under `/_app/`
  (SvelteKit's built JS/CSS chunks), the PWA manifest, service worker,
  favicons, and the `redstart.svg` logo. Check
  `redstart-nest/src/chat-ui/dist/` after a build to see the actual file/path
  shapes being served and adjust the pattern to match reality — don't guess
  blind, inspect the real dist output.
- Do **not** add `/v1/`, `/props`, `/models`, `/tools`, `/slots`,
  `/cors-proxy`, `/completion`, `/tokenize`, `/embedding`, or
  `/redstart/mcp-servers` to the public pattern. Those must stay behind
  `authenticate(req)`. `/completion`, `/tokenize`, `/embedding` in particular
  are real llama-server endpoints that were **not** in the old
  `LLAMA_API_PREFIXES` list in `index.mjs` — make sure this new gateway
  check does not accidentally expose them either.

**Verification for this workstream:**
1. `cd redstart-nest && npm run build:chat`
2. Launch Redstart Nest, turn accounts ON, create/confirm a user account.
3. From a second device on the LAN, open `http://<host-ip>:<port>/` in a
   browser. Expect: loading screen, then a login form — **not** a JSON error
   on a black page.
4. Log in from that second device. Expect: chat UI loads normally.
5. From that same second device (or curl), confirm `GET /props` without a
   token still returns 401.
6. Turn accounts OFF. Confirm the second device can load and use the chat UI
   with no login prompt at all (regression check for the "toggle off" path).

---

## Workstream 2 — SPA: make the login gate airtight

**File:** `redstart-project/redstart-nest/src/chat-ui/src/routes/+layout.svelte`

The gate itself already exists and is basically correct:

```svelte
{#if authStore.authRequired && !authStore.user}
	<LoginForm />
{:else}
	<Sidebar.Provider ...> ... chat/settings UI ... </Sidebar.Provider>
{/if}
```

This is fine as-is architecturally. The problems are around *when* this
condition is trustworthy:

1. **Loading screen must stay up until auth state is actually known.** Look
   at `initApp()` (around lines 201-274) and the `appReady` flag that
   controls the loading screen. Confirm `appReady` is only set `true` after
   `authStore.init()` has resolved (it already calls `authStore.init()`
   before setting `appReady = true` — verify this ordering hasn't
   regressed, and that there's no code path where `appReady` can flip true
   before `authStore.checked` is true). If you find a path where the main UI
   can render before `authStore.checked`, add a check so the loading screen
   condition is `!appReady || !authStore.checked` instead of just
   `!appReady`.

2. **Mid-session 401s must drop back to the login screen, not show an error
   banner.** Search the chat-ui codebase (`src/chat-ui/src`) for places that
   call `apiFetch` and handle a caught error by showing a toast/banner for a
   401 specifically. Wherever a 401 comes back from an *authenticated* call
   (not the initial `/auth/me` check, which already handles this in
   `auth.svelte.ts`'s `init()`), call `authStore.handleUnauthorized()`
   instead of just displaying a generic error. `handleUnauthorized()` already
   exists in `src/lib/stores/auth.svelte.ts` and clears the token/user so the
   reactive gate above flips back to `<LoginForm />` automatically — you do
   not need to write new gating logic, just make sure this function actually
   gets called on 401s from places other than `/auth/me`. Check especially:
   `server.svelte.ts`'s `fetch()` (server props) and any tool/model list
   fetches that run automatically after login.

3. **Do not build a second/parallel gate.** There should be exactly one place
   that decides "show login vs. show app" — the block in `+layout.svelte`
   shown above. Don't add per-route guards elsewhere; if a route needs to be
   reachable without login (there currently isn't one that should be), that's
   a design question to flag to the human, not something to solve locally.

**Verification for this workstream:**
1. With accounts ON and logged out, confirm you cannot see any chat/sidebar
   content, not even for a flash, at any point during page load (reload the
   page ~10 times, hard-refresh, and watch closely, including on a slow
   network throttle if your browser devtools support it).
2. While logged in, restart Redstart Nest (which invalidates the in-memory
   session — see the comment in `auth.svelte.ts` about sessions not
   surviving a restart) and then trigger any authenticated action in the
   already-open tab (e.g. send a chat message). Expect: it drops back to the
   login screen, not an error toast.

---

## Workstream 3 — Top-level user menu + self-service account/profile

### 3a. Backend: extend what `/auth/me` returns, add self-service key regen

**File:** `redstart-project/redstart-nest/electron/main/auth.mjs`

`toPublicAccount()` currently returns `{ id, username, role }`. Extend it to
also include `apiKeyPrefix`, `createdAt`, and `lastLoginAt` from the account
record:

```js
function toPublicAccount(record) {
  if (!record) return null
  return {
    id: record.id,
    username: record.username,
    role: record.role,
    apiKeyPrefix: record.apiKeyPrefix,
    createdAt: record.createdAt,
    lastLoginAt: record.lastLoginAt,
  }
}
```

Double-check `accounts-storage.mjs` to confirm these field names match what's
actually persisted (they should, based on `createAccount`/`createOwner` in
this same file, but verify).

Add a new exported function, self-scoped (a user regenerating **their own**
key, no `canManage()` role check needed since they're only ever touching
their own account):

```js
export function regenerateOwnApiKey(actor) {
  if (!actor) return { ok: false, error: 'Not authenticated' }
  const apiKey = generateApiKey()
  const account = accounts.updateAccount(actor.id, {
    apiKeyHash: hashApiKey(apiKey),
    apiKeyPrefix: apiKey.slice(0, 8),
  })
  return { ok: true, account, apiKey }
}
```

**File:** `redstart-project/redstart-nest/electron/main/tools-gateway.mjs`

In `handleAuthRoute`, add a new route, placed with the other authenticated
(but not admin-only) routes — i.e. **before** the `hasAdminAccess` check that
gates the account-management routes, since this is a self-service action any
logged-in user can take on their own account:

```js
  if (req.method === 'POST' && urlPath === '/auth/me/regenerate-key') {
    const authResult = authenticate(req)
    if (!authResult.ok) return sendJson(res, 401, { error: 'Unauthorized' })
    const result = regenerateOwnApiKey(authResult.account)
    if (!result.ok) return sendJson(res, 400, { error: result.error })
    return sendJson(res, 200, { account: result.account, apiKey: result.apiKey })
  }
```

Add `regenerateOwnApiKey` to the import line at the top of
`tools-gateway.mjs` (it currently imports `authenticate, login, logout,
listAccounts, getAuthRequired, createAccount, deleteAccount, resetPassword,
regenerateApiKey, hasAdminAccess` from `./auth.mjs` — add
`regenerateOwnApiKey` to that list).

Place this new route **before** the existing `GET /auth/me` handler check,
not inside it, and make sure it does not fall through into the
`hasAdminAccess` gate that follows further down for the `/auth/accounts/*`
routes.

### 3b. Frontend: user menu + profile panel

**File:** `redstart-project/redstart-nest/src/chat-ui/src/lib/stores/auth.svelte.ts`

Update the `AuthUser` type to match the extended `/auth/me` response:

```ts
export type AuthUser = {
  id: string;
  username: string;
  role: 'owner' | 'admin' | 'user';
  apiKeyPrefix?: string;
  createdAt?: string;
  lastLoginAt?: string | null;
};
```

Add a method for regenerating the current user's own key:

```ts
async regenerateOwnApiKey(): Promise<string> {
  const result = await apiPost<{ account: AuthUser; apiKey: string }>(
    '/auth/me/regenerate-key',
    {},
    { authOnly: true }
  );
  this.user = result.account;
  return result.apiKey;
}
```

(Check the exact signature of `apiPost` in `$lib/utils` before using it —
match however the existing `login()`/`logout()` methods in this same file
already call it.)

**New component:** a user menu in the sidebar header, next to where
`SidebarNavigation.svelte` currently renders `{APP_NAME}` (see
`redstart-project/redstart-nest/src/chat-ui/src/lib/components/app/navigation/SidebarNavigation/SidebarNavigation.svelte`,
around line 184-188). Only show this menu when `authStore.user` is set (if
accounts are off, `user` is always null, so the menu naturally disappears —
no separate visibility check needed).

Menu contents (a dropdown or popover, look at how other dropdowns in this
codebase are built, e.g.
`ChatFormActionAddDropdown.svelte`, for the pattern/components to reuse —
this project uses a `DropdownMenu` component family already):
- Username + role badge (owner/admin/user)
- "Account created" and "Last login" timestamps (from `authStore.user`)
- API key: show `{authStore.user.apiKeyPrefix}…` with a "Regenerate" button.
  Regenerating calls `authStore.regenerateOwnApiKey()`, then show the
  **full** new key in a one-time dialog with a copy-to-clipboard button and
  a clear "this won't be shown again" warning (look at
  `ActionIconCopyToClipboard.svelte` for the existing copy-button pattern).
- A "Log out" button that calls `authStore.logout()`.

Once this menu exists, remove the old buried logout button in
`SettingsChat.svelte` (around lines 193-202, the `{#if authStore.user}...
Log out` block) so there's exactly one place to log out, not two.

**Verification for this workstream:**
1. Log in as a regular (non-admin) user. Confirm the user menu is visible,
   shows correct username/role/timestamps/key prefix.
2. Click regenerate. Confirm a new full key is shown once, the prefix in the
   menu updates afterward, and the old key stops authenticating (test with
   the old key against a protected endpoint via curl/Postman — should now
   401).
3. Click Log out. Confirm it returns to the login screen (or to anonymous
   mode if accounts are off).
4. Confirm the old Settings → General logout button is gone and nothing else
   references it.

---

## Workstream 4 — API key prefix: `bvr_` → `rst_`

**File:** `redstart-project/redstart-nest/electron/main/auth.mjs`

One-line change:

```js
function generateApiKey() {
  return 'rst_' + crypto.randomBytes(24).toString('hex')
}
```

That's the only functional change needed — `apiKeyPrefix` is always derived
from the freshly generated key (`apiKey.slice(0, 8)`), so every place that
displays a prefix (the Accounts tab, the new user menu from Workstream 3)
picks this up automatically with no further changes.

Do **not** touch any already-stored `apiKeyHash`/`apiKeyPrefix` values for
existing accounts — those keep working as-is (auth matches against a hash of
whatever the client presents; there is no prefix check in the auth path)
until a user or admin regenerates, at which point they naturally get an
`rst_` key.

**Verification:** create a new account or regenerate an existing key, confirm
the returned key starts with `rst_`, and confirm the account's displayed
prefix (Accounts tab and/or new user menu) matches.

---

## Suggested order / standalone-ness

Each workstream can be done and verified independently, in this order:

1. **Workstream 4 first** — it's a one-line, zero-risk change. Good warm-up.
2. **Workstream 1 second** — this is the actual reported bug (remote login
   broken) and the highest-value fix. Review this diff carefully: it's the
   one piece of this plan that changes what's publicly reachable on a
   network-facing server.
3. **Workstream 2 third** — depends on nothing from 3, tightens the same
   login gate that 1 makes reachable.
4. **Workstream 3 last** — the most UI-heavy piece, and the one most likely
   to need iteration on layout/styling.

If time runs short, stopping after Workstream 1 + 2 already fixes the
reported problem (remote users get properly locked out/in). Workstream 3 and
4 are quality-of-life and cosmetic, respectively.
