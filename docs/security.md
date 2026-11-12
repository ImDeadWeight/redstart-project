# Security & Trust Boundaries

*[← back to the README](../README.md) · [docs index](README.md)*

This document collects every trust boundary in Redstart in one place: who authenticates, what each credential grants, where a path can and cannot resolve, what the model is allowed to be told, and what leaves the machine.

Redstart is a LAN appliance, not an internet-facing service. **Do not expose the gateway port to the public internet**, regardless of whether login is on.

---

## Contents

- [Accounts & login](#accounts--login)
- [The control plane](#the-control-plane)
- [The identity model](#the-identity-model)
- [Roles](#roles)
- [The llama-server boundary](#the-llama-server-boundary)
- [Network exposure](#network-exposure)
- [Per-account file storage](#per-account-file-storage)
- [Your files (web UI)](#your-files-web-ui)
- [Destructive operations](#destructive-operations)
- [Logging](#logging)
- [Running model-written code (run_python)](#running-model-written-code-run_python)
- [Document search](#document-search)
- [Memory](#memory)
- [Workflows](#workflows)
- [Projects](#projects)
- [Asking and planning](#asking-and-planning)
- [Tool bans](#tool-bans)
- [Whitelist & SSRF enforcement](#whitelist--ssrf-enforcement)
- [External MCP servers](#external-mcp-servers)
- [Plugins](#plugins)
- [The server-composed system prompt](#the-server-composed-system-prompt)
- [What actually leaves the machine](#what-actually-leaves-the-machine)
- [The test suite](#the-test-suite)
- [Static analysis](#static-analysis)
- [Known gaps](#known-gaps)

---

## Accounts & login

Redstart Nest has an optional account system, gated behind a global **Require login** toggle in the server settings. It's **on by default** — every client on the network, including the host machine's own browser, must authenticate before accessing the chat UI or API. With it off, anyone on your network can use the server with no login and no API key, exactly like a plain llama.cpp setup. Turn it on and the picture changes:

- **Login gate.** When accounts are required, the chat UI is not reachable until you sign in — a device that isn't logged in gets the login screen, not the chat. This holds for browsers on other devices too, not just the app.
- **Three-tier roles.** A single **Owner** creates and removes **Admin** accounts; Admins manage regular **Users** day-to-day; Users just log in and chat.
- **Sessions survive a restart.** They are stored in `sessions.json` as SHA-256 hashes of the token, so the file cannot be replayed as a credential by anyone who reads it. Chat sessions slide on a 30-day expiry; control-plane sessions get 12 hours (see [The control plane](#the-control-plane)). Signing out, resetting a password and deleting an account each revoke on disk, not just in memory.
- **Profile page.** A **Profile** entry in the sidebar (and in the collapsed icon rail) opens a full-page account view rather than a dropdown. Its **Account** tab shows role, account-created / last-login timestamps and API key management; its **Files** tab browses your own storage on the server (see [Your files](#your-files-web-ui)). A regenerated key is shown once and stays on the page until dismissed — the previous dropdown put it in a modal that a stray click could dismiss, and the server keeps only a hash, so a key lost that way is gone for good.
- **API keys.** Each account has a long-lived API key (prefixed `rst_`) for OpenAI-compatible clients like Kilo Code. Only a hash is stored server-side, so an existing key is only ever shown as its prefix — regenerate to get a fresh full key. Admins can also manage keys for the accounts they oversee.
- **Per-connector keys.** An account can also issue keys bound to a specific *surface* (`nest-chat`, `twig`, `blueprints`, `yellowscript`, `greenhouse`), managed under Settings → Connectors. The surface travels with the credential, so the server derives which app is calling from the key itself rather than believing a header.
- **First run.** The Owner account is created through the control plane's setup screen, which asks for the machine's **setup code** first — there is no anonymous route to ownership. On Windows the launcher shows that same screen with the code already filled in (it reads the code off the machine itself, the same way it always visually appeared to), so setup looks the same as before even though the launcher is now just another client of the daemon, same as a browser tab. Since login is on by default, do this before expecting any device (including the launcher, or a browser on the host PC) to sign in.

This is a newer subsystem — treat the account-management surface as still stabilizing.

---

## The control plane

Configuring Redstart Nest and using it are two different things, and from the
2026-09 pass they are two different listeners with different rules.

| | Data plane | Control plane |
|---|---|---|
| What | Gateway `19080`, MCP `19082`, port-80 proxy | Admin listener `19083` |
| Serves | Inference and tools to chat clients, Twig, coding agents | Configuration and process lifecycle to administrators |
| Up when | A model is running | Redstart Nest is running |
| Login | Optional — the **Require login** toggle | **Always required.** The toggle does not reach it |
| Who | Any account, narrowed by role | **The Owner, and nobody else** |

**The toggle governs the data plane only.** Turning **Require login** off opens
the chat API to your LAN, exactly as documented above — it does not open the
control plane. Two switches for two planes, rather than one switch whose "off"
position hands out the ability to start processes. Note the other half of that:
with login off the Owner can still sign in to the control plane, because it
never consults the toggle in either direction.

**Owner only, behind one check.** Every control-plane route calls a single
function — `mayAccessControlPlane()` in `permissions.mjs`, whose whole body is
`account?.tier === 'owner'`. Admin-tier accounts are refused. It is deliberately
not a role permission: roles in Redstart may only ever *narrow* a tier, and the
Owner ignores narrowing, so a control-plane permission would be permanently true
and never consulted. It becomes meaningful the day a non-Owner can hold it, and
widening it is then one edit rather than an audit of every route.

**A session opens one plane.** Sessions are bound to their plane when they are
issued: the gateway issues chat sessions, the admin listener issues
control-plane ones, and each accepts only its own. So signing in to the chat UI
as the Owner does *not* give you a credential that can start and stop processes.
API keys are refused outright here — those are pasted into third-party tool
clients, and one of them should not also be an administrative credential. A
password, exchanged for a session at the control plane's own login, is the only
way in.

**The setup code (`bootstrap-token.txt`).** One CSPRNG code per machine,
generated on first run and stored in plain text in the data directory. It is the
only thing that opens `POST /admin/bootstrap`, which both creates the first Owner
and re-keys an existing one — one door, no separate recovery path, and no
anonymous route to ownership. This is the router model: a unique password on a
label, plus a reset that does not wipe the box.

- Why it must exist: creating the first Owner over a LAN-reachable route is not
  physical access, and "no Owner exists" is reachable by a corrupt
  `accounts.json` as well as by a new install — so without a code, the first
  stranger to find the port would own the machine.
- Why it is plain text: the launcher reads it off the machine itself and
  submits it for you, so Windows setup is unchanged and you never see it.
  Hashing it would cost that and buy nothing — anyone who can read the file
  can rewrite `accounts.json`, which is ownership by a shorter route.
- A reset preserves everything but the Owner's credential: accounts, roles,
  connector keys and tool configuration all survive, and the Owner's sessions are
  revoked. That is the whole gain over the last-resort wipe (stop Redstart Nest,
  delete `accounts.json`, start again), which remains the answer when the goal is
  to invalidate everything rather than to get back in.
- It can be rotated, for a machine that moved or a label that was photographed.
- Both anonymous routes — login and bootstrap — are rate limited and log every
  attempt. That is a brake on automated guessing, not an access control; what
  makes the secrets unguessable is their entropy.

**Exposure is a bind address, and it defaults to loopback.** `adminBindHost` in
`settings.json` holds an address rather than an on/off flag, so one setting
covers loopback, a VPN interface, a management VLAN or the whole LAN. It is
*not* network mode — that is data-plane state read at launch, and the control
plane must not depend on it. A change rebinds immediately rather than at next
start, because an administrator changing it may be doing so to recover access.
The Accounts panel has a toggle for the common case (loopback vs. every
interface); it writes the same `adminBindHost` setting a specific VPN or
management-VLAN address would need to be set by hand.

> **If you move it off loopback, do not forward the port through a router.** That
> single act is what turns a low-risk deployment into one being scanned
> continuously, and it is a larger real-world risk than any certificate decision.
> Put a reverse proxy in front of it, or keep it on a VPN or management network.
> Redstart Nest speaks plain HTTP and does not encrypt this traffic itself (see
> [Network exposure](#network-exposure)). The launcher shows a warning whenever
> the bind address is not loopback.

**What the browser gets served.** The admin listener serves the launcher's own
built bundle, from a list of the files Redstart Nest shipped, enumerated off
disk at start-up and matched exactly — a request path that is not in that list is
not a file, so directory traversal is not filtered here, it is impossible. This
is deliberately *not* the mechanism the gateway uses for the chat UI's assets:
that one is a URL-pattern rule deciding what to forward unauthenticated to
llama-server, which is someone else's namespace. The two must not be confused.
The document is served with its own Content-Security-Policy — no inline script
at all, and `connect-src 'self'`, the same one every caller gets, the desktop
window included: it loads this listener's page too rather than carrying a
separate, looser policy of its own. Inside the Tauri shell the page may also
make exactly one kind of native call, window chrome (move, minimise, maximise,
close), granted by `shell/capabilities/window-controls.json` to that window at
this origin only. The window refuses to navigate anywhere else.

**No CORS by default, and therefore no CSRF machinery.** Out of the box the
listener sends no `Access-Control-Allow-Origin` header and answers no preflight;
it serves its own origin. The credential is a bearer token the page attaches
itself rather than a cookie, so a cross-site request carries no authority in the
first place.

A deployment whose admin client is served from somewhere else can set
`adminAllowedOrigins` in `settings.json` to an explicit list of origins. It is
an allowlist and only an allowlist: a wildcard is refused outright, an origin
that is not on the list is never reflected back, and a request from an
unlisted origin is handled exactly as it always was — authenticated on its own
merits, with no CORS headers. There is no UI for this because the only thing
that needs it is a client pointed at a remote daemon.

**Every method, one route, one gate.** The administrative API is one route per
method (`POST /admin/api/<namespace>/<method>`), and authentication and the
Owner check run in the listener *before* dispatch — so a route added later is
gated by default rather than by whoever remembers.
`scripts/test-admin-api.mjs` asserts that every method the launcher can call has
a route, and that every one of them refuses both an anonymous caller and an
admin-tier session. Ten are deliberately excluded and answer `501` even for the
Owner: the native file pickers and "reveal in Explorer", which act on the machine
you are sitting at rather than on the server. A server-side folder browser is the
planned replacement.

---

## The identity model

```
Account  (id, username, role, password hash)
├── role                      owner | admin | user
├── session token(s)          sessions.json, SHA-256 hashed; 30-day sliding on the
│                             data plane, 12-hour on the control plane; revoked on
│                             delete/reset
├── general API key           rst_… — one per account, hash stored
└── connector key(s)          rst_… — each bound to ONE surface
    └── surface               nest-chat | twig | blueprints | yellowscript | greenhouse
```

There is exactly one resolution path from an incoming request to an account: `authenticate(req)` in `daemon/auth.mjs`. Both the gateway and the MCP server call it; neither touches account storage directly.

**Passwords** go through scrypt with a per-record 16-byte salt and are compared with `timingSafeEqual`. **API keys and connector keys** are 24 CSPRNG bytes (192 bits) stored as a SHA-256 hash — see [Static analysis](#static-analysis) for why a slow KDF is deliberately not used there.

**The surface comes from the credential, never from a header.** A connector key resolves to `{ account, surface, clientKeyId }`, and the gateway passes that surface into the prompt composer. An `X-Redstart-Surface` header is accepted and inert; the connector contract suite asserts that a header cannot forge a surface the credential did not grant. Connector keys are independently revocable, and revocation takes effect on the next request.

**Session revocation is centralized.** Deleting an account or resetting its password calls `revokeSessionsForAccount()`, so there is no path that removes an account while leaving a live token behind. Revocation reaches disk, not just memory: sessions are persisted (see [Sessions survive a restart](#accounts--login) above), so a signed-out token stays signed out across a restart rather than being cleared by one.

**Owner bootstrap has exactly one door.** `createOwner()` is reachable only through `POST /admin/bootstrap`, gated on the machine's setup code (above) — there is no second, anonymous or IPC path onto it. It is deliberately a separate function from `createAccount()` rather than an "allow owner" branch inside it, so the owner-creation path cannot be reached any other way.

---

## Roles

A **tier** (Owner / Admin / User) decides who may *administer* whom. A **role** decides what an account may *reach*. They are separate axes on purpose: the moment an admin can invent a tier called "Legal Team", every management check in the system needs an opinion about where it sits in a hierarchy that no longer exists.

Roles are created and assigned under **Settings → Roles**, beside Accounts. Each account holds exactly one; an account with none gets **Full Access**.

**A role can only restrict.** Effective access is

```
(configured globally AND activated by the running profile)  ∩  role
```

so a role can never switch on a capability the server has turned off, widen the URL whitelist, or raise a fetch budget. This is a property of the code rather than of review: every rule in `permissions.mjs` narrows, and `scripts/test-roles.mjs` asserts over 2000 randomised config × role pairs that nothing coming out is more permissive than what went in, on any field. Adding a rule that widens fails the build with a reproducible counterexample.

A role can withhold:

| | |
|---|---|
| **Local capabilities** | Which of Postgres, Documents, SQLite, Vault, Git, File System, Scholar the account may use. A withheld capability is disabled *and* its tool names are banned — two independent mechanisms, so neither is a single point of failure. |
| **Web sources** | Which approved sources the account may fetch, its per-fetch token budget, and whether it may fetch off-whitelist. Naming sources also forces the whitelist on, since otherwise `web_fetch` still takes any URL and the narrowed list would govern nothing. |
| **File-system policy** | `Allow writes` / `Allow destructive` withdrawn per account. Applies to Redstart's own file tools *and* the web file explorer. |
| **Client surfaces** | Which apps the account may connect from. |
| **Administration** | For admin-tier accounts: `manageAccounts`, `manageRoles`, `managePromptBlocks`, `manageOrgWorkflows` individually. Tier remains the ceiling — no role can make a User an admin. |

Enforcement is per request at both chokepoints (the completions proxy and the MCP server's `tools/list` + `tools/call`), so a role edit takes effect on the next call rather than at next login.

**Two things a role deliberately does not do.**

*It does not reach client-app tools.* Roles govern what Redstart Nest itself serves. Twig's `fs_*` tools act on the user's own PC, and writing files there is the entire point of Twig — restricting what an account may do to the *server* must not disable the user's local editor. Banning a client app stays an org-wide decision (see [Tool bans](#tool-bans)).

*It does not restrict the Owner, and it does not apply when login is off.* Both are unrestricted by design: the Owner exemption is the anti-lockout guarantee, and the auth-off case keeps the **Require login** toggle meaning exactly what it says. Note the third null case is treated as a bug rather than a posture — if login is on but a request reaches the tool dispatcher with no identity attached, it is narrowed to nothing rather than served the full set.

**Surfaces are a hard control only for connector keys.** A per-connector key binds its surface at issue time, so the server derives the calling app from the credential. A session obtained with a username and password is tagged `nest-chat` because the chat UI is what logs in that way — but any client that posts credentials gets one too. An account-wide API key names no app at all, so an account whose role restricts surfaces cannot hold one: issuing is refused in both the admin and self-service paths rather than left as a documented caveat.

---

## The llama-server boundary

llama-server speaks the raw OpenAI API with no authentication of its own. It must never be reachable from the LAN, and that is enforced in two independent places:

1. **The launch arguments.** `--host` is hardwired to `127.0.0.1` in `llama-args.mjs` and is never derived from any config field.
2. **The advanced-args field.** `additionalArgs` is free text appended to the launch command, and llama.cpp honours the *last* `--host` it sees — so a hand-typed `--host 0.0.0.0` would silently defeat the invariant. Both the `--host X` and `--host=X` forms are stripped. The stripping is visible in the launcher's command preview, which uses the same builder.

The gateway is the only way in, and it authenticates first. `scripts/test-llama-args.mjs` asserts the invariant across spoofed config fields and injection strings.

---

## Network exposure

**Network mode is a socket bind, not a firewall rule.** With it off, the gateway and MCP server listen on `127.0.0.1` only, so a LAN device gets connection-refused rather than a login screen — and that holds whatever the host's firewall is doing. Turning it on binds both to `0.0.0.0` and adds Windows Firewall inbound rules.

Both servers default to loopback in code: LAN exposure is something a caller must explicitly ask for, so the failure mode of a missed configuration is *closed*. `scripts/test-network-binding.mjs` proves this by binding each server and attempting a real TCP connection from the host's own LAN address — a test that read a config variable would prove only that a variable holds a string.

**The control plane binds separately, and also defaults to loopback.** Network
mode does not move it; `adminBindHost` does. See [The control plane](#the-control-plane).

Full detail, including why firewall rules are not removed on toggle-off, is in [Architecture → Ports used](architecture.md#ports-used).

**Discovery is not authentication.** The beacon answers "where might a Redstart server be?" — never "this server is trustworthy". The beacon payload is minimal by design (`{ app, running, port }`) and discloses no version, auth state, configuration or URLs. A discovered server still has to authenticate the client. (mDNS was retired — see [Known limitations](roadmap.md#known-limitations) — the beacon was always the mechanism that mattered; Twig never depended on the `.local` name.)

---

## Per-account file storage

The capabilities that **write** — Documents, File System, and Scholar's saved PDFs — give each account its own folder inside the configured root:

```
<configured root>/user_files/<username>-<account-id>/
```

Everything an account creates lands there, and everything it reads comes from there. This is enforced structurally rather than by an ownership check: another account's filename resolves inside *your* folder, finds nothing, and 404s. There is no "is this mine?" comparison to forget on one of the several code paths that reach the same bytes — the MCP tools, the download endpoint, and the file explorer all resolve the same way.

Containment is two applications of one audited primitive, `resolveWithinRoot()` in `path-scope.mjs`:

| Layer | Check |
|---|---|
| 1 | the user root must resolve inside the capability root |
| 2 | the model-supplied path must resolve inside the user root |

That function resolves symlinks on the deepest existing ancestor before comparing, so a symlink planted inside the root cannot point out of it; it rejects NUL bytes, and it compares case-insensitively on win32 because the filesystem does. A plain `resolve()` + `startsWith()` would catch `..`, absolute and drive-qualified paths but not the symlink case, which is why containment is checked against the real path rather than the lexical one.

Folders are keyed on the account **id**, not the username. Usernames are validated for uniqueness only, so a username like `../../etc` or a Windows reserved name (`CON`, `PRN`) would otherwise be a path-traversal or create-failure primitive the moment it became a directory name. The username still appears, slugified, so an admin browsing the disk can tell whose folder is whose — but the id is what makes the name unique, and the `<slug>-<id>` shape is structurally incapable of colliding with a reserved device name.

Folders are created **lazily**, on first use — a tool call or opening the Files tab. An account that has never touched a file has no folder, which is normal rather than a fault. When login is disabled there is one defined `_local/` scope; a request with no identity never falls through to the capability root.

The **read-only reference capabilities are deliberately not per-account.** Vault, Git, SQLite and Postgres are shared: a per-user vault would be empty and useless, and shared repositories are the whole point. Today that sharing is all-or-nothing — see [Known limitations](roadmap.md#known-limitations).

> **If you are upgrading:** files already sitting in a configured root are left exactly where they are, but are no longer served to anyone, because serving them to every account is the exposure this change closes. Move them into a specific account's folder to make them reachable again.

---

## Your files (web UI)

The chat UI's **Profile → Files** tab is a browser for your own storage on the server: navigate folders, preview `.pdf`/`.docx`/`.xlsx`/`.csv` (extracted on-device by the same code `read_document` uses — nothing leaves the machine), download, rename, create folders, and delete. Drag to move, with multi-select; drag files in from your desktop to upload. Deletions go to the recycle bin, same as the model's.

Uploading is the one place a person can put arbitrary bytes on the server, so it has its own limits rather than the model-facing ones: a size cap enforced against the bytes actually received (not the declared `Content-Length`), an extension denylist for anything a double-click would execute, a filename that must be a bare name rather than a path, and no silent overwrite.

Scoping is server-side from the authenticated session throughout — the client never sends a user id, so it cannot ask for someone else's files even by trying.

---

## Destructive operations

Destructive-class tools (currently only `delete_file`) are governed twice, on purpose.

**Server side**, `allowDestructive` is off by default and enforced at the MCP chokepoint, so a client that skips the advertised tool list is still refused. The gate applies at both `tools/list` (the model is never offered the tool) and `tools/call` (a client that calls it anyway is refused).

**Client side**, a destructive tool can never be granted "always allow": the prompt hides the option, the agentic loop refuses to honour a persisted grant, and "allow all from this server" filters destructive tools out before saving. Otherwise one click on a menu item that never mentions deletion would make every future deletion silent — and recoverability only helps if someone notices in time.

Twig needs its own version, since its local file tools never travel over MCP and no server-side policy reaches them. It reports each tool's class over its own bridge; `fs_delete_file` is likewise never remembered.

Deletions go to the OS recycle bin, falling back to a `.trash/` folder in the caller's own storage. Nothing in Redstart permanently destroys data — a delete that cannot be made recoverable fails and leaves the file alone. It refuses the storage root, refuses non-empty directories (there is deliberately no `recursive` option), and deletes a symlink as a link rather than following it.

---

## Approvals

Each tool has an approval rule that follows from its class: reads and web fetches need none, writes ask unless you've chosen **Always allow**, and destructive tools (`delete_file`, `memory_forget`, and any plugin tool an admin hasn't reclassified) ask on every call.

- **Nest refuses an unapproved destructive call, from any client.** A call with no approval does nothing and comes back as "needs the user's approval", with a pending approval for the client to decide. The chat app shows its card, sends your decision to Nest, and repeats the call. This applies to every client, including Yellowscript and anything on an API key: a client that doesn't do this exchange can't delete or forget anything through Nest.
- **An approval is for one exact call.** It's tied to your account, the tool, and the exact arguments, works once, and expires after 60 seconds. An approval for deleting one file can't be used to delete another, by another account, or twice.
- **What this protects, said plainly:** it protects you from the model, not the server from you. A client holding your account's key is your account, and could approve its own calls. What it adds is that the decision is bound to the call, it's on the server rather than in one browser, and it's recorded.
- **Always allow is per account and kept on the server** for Nest's tools. It follows you to every browser and client, and you can revoke it from the chat settings. A destructive tool can never be always allowed: Nest refuses the grant, and a grant written before a tool became destructive stops counting. Tools that live in the client (Twig's local files, llama-server's built-ins, the in-page sandbox, other MCP servers) keep their always-allow in the browser, as before. Your old browser list was imported once, with anything destructive dropped.
- **With login off, everyone shares one set of standing grants**, as they share memories and files.
- **The decision log.** A denial (on the chat app's card or sent by a client), an approval presented for the wrong call, and every standing grant added or revoked are written to `policy.jsonl` beside the main log, and the owner reads them on the launcher's **Activity** tab. It records the account, the tool and the decision, never arguments or paths. The same tab lists any account's standing grants, and the owner can revoke them.

**Tool class is decided server-side from a static map**, never read from the tool's own annotations. MCP annotations are advisory and, on a normal connection, attacker-controlled; the spec is explicit that clients must not make trust decisions from them. Redstart publishes them for third-party clients but its own gate classifies from `TOOL_CLASSES`.

---

## Logging

`daemon/logger.mjs` writes one JSON object per line to `redstart.log` in userData: the operationally interesting events (auth, tool execution, server lifecycle, discovery, MCP registration) plus a concise console line. The contract is to log the *shape* of what happened, never the content.

There are two mechanisms, and they answer different questions — this is the distinction to reach for when the question is specifically "what does Redstart audit?":

- **`logEvent()` — the operational trail, blocklist plus scalars-only.** This is where account-affecting actions show up: `login_ok` / `login_failed` (username + role, never the password), `client_key_issued` / `client_key_revoked`, and `role_saved` / `role_deleted` / `role_assigned`, alongside tool calls (`tool.called` / `tool.denied`), server lifecycle, and IPC rejections. Callers are expected to pass only safe scalar fields (tool name, class, decision, duration, port, username, role). As defense in depth, the logger also drops any field whose key names sensitive data — tool args/results, message/conversation content, SQL, file paths, URLs, secrets — case-insensitively, and drops any object or array value outright regardless of its key. The second rule is the one that matters most: it protects against a future field name nobody thought to blocklist, not just the known list.
- **`logAudit()` — a closed allowlist, the one documented exception to "never the content".** Destructive-class tool calls (currently only `delete_file`) record what was deleted, because a deletion nobody can name is a deletion nobody can undo. Only `AUDIT_FIELDS` (`tool`, `path`, `scope`, `kind`, `recoverable`) survive; string values are truncated at 512 characters; file contents are never logged by anything. Nothing else in the codebase may call it, and its two call sites (`files-api.mjs`, `fs-delete-tool.mjs`) are checked by name.

Both halves — the blocklist/scalars-only rule and the allowlist — are proven against the actual bytes written to disk by `test-logging`, not against mocked internals. See [The test suite](#the-test-suite).

**Access and retention.** `redstart.log` is a plain file in userData; there is no in-app log viewer and no HTTP route that serves it, so reading it means reading it off the host disk. It rotates at 5MB, keeping exactly one previous generation (`redstart.log.1`) — there is no long-term archive, so an incident older than roughly two rotations' worth of activity is gone unless something outside Redstart copied the file first.

**What this is not.** `logEvent()` gives an operational trail, not a durable per-account audit log: entries are one-line JSON, not queryable per-account history, and — see the gap below — account lifecycle changes aren't in it at all. Anyone asking "does Redstart have audit logging" should get that qualified answer, not a flat yes.

---

## Running model-written code (run_python)

The Python capability lets the model write code and run it. Model-written code is **attacker-influenced code**: a fetched page or an uploaded file can prompt-inject the model into writing whatever the attacker wants. So the design question was never "is the model trustworthy" but "what can this code reach". Native CPython was rejected for that reason: on Windows there's no cheap process sandbox, and it would be arbitrary code execution as the Nest user.

What runs instead is **Pyodide** (CPython compiled to WebAssembly) in a separate child process, one per active conversation. What contains it, strongest first:

1. **WebAssembly.** The interpreter has no system calls of its own. Its whole reach is the JavaScript objects the host exposes.
2. **Node's permission model.** The child runs with `--permission` and nothing else granted except reading the pinned runtime and its own script, and reading and writing the conversation's workspace. No network, no child processes, no workers, no native addons, so the runtime refuses those from any code path, Pyodide's own internals included. Node only has a network permission from version 25. The desktop app runs its server on the bundled Node 26, so this is always available there. On a server running an older Node, **run_python is unavailable** and the Tools tab says why. It never falls back to a weaker sandbox.
3. **No code generation from strings, and fewer handles.** `eval`/`Function` are off for the child. `require`, `fetch`, `WebSocket`, `process.getBuiltinModule` and `dlopen` are removed, `process.binding` answers one question, and package loading accepts only the pinned, installed set (no pip, no URLs).
4. **Links are refused.** Creating a symlink fails, and so does following one already in the workspace, because the permission model follows links out of an allowed folder.
5. **Nothing of the host's environment.** The child starts with an empty environment, and clears what Windows adds back before any code runs.

`scripts/test-python-sandbox.mjs` runs every escape attempt from the design measurements against the real runtime: mounts outside the workspace, links, `..`, every removed handle, `eval` and dynamic `import()`, sockets through Python, through `urllib` and through Pyodide's own socket layer, and loading packages from a URL. It asserts that **zero connections** reach a stub server it runs, and that nothing was written outside the workspace. It must pass again on every Pyodide upgrade.

**The runtime is pinned.** About 30 MB, downloaded once from the Tools tab. Each file is checked against a SHA-256 written in `daemon/python-runtime.mjs` (the wheels against the pinned lock file's own hashes), and every file is re-verified before the first kernel starts.

**Files.** Each conversation has a workspace, `chats/<conversation>/`, inside your own Documents folder ([per-account storage](#per-account-file-storage) applies unchanged). The conversation id the chat UI sends is honoured only if the conversation is yours; anything else uses your `chats/_scratch/`. With run_python available, the chat UI also uploads your attachments there. `read_document` looks in that conversation's workspace when your Documents folder has no file at the path it was given, so an attachment can be read by its name; it never looks in another conversation's workspace or another account's. The File System tools cannot reach a workspace, and their "no such file" error says so when the file is there. Deleting a conversation sends its workspace to the recycle bin (or `.trash/`), and at startup a workspace whose conversation no longer exists (for example, pruned after 30 days) goes the same way. Workspaces are capped at 200 MB each and 2 GB per account by default.

**Limits.** 30 s per call by default, 120 s at most, enforced by killing the kernel. Two warm kernels at once by default (≈ 457 MB of RAM each), stopped after 10 idle minutes.

---

## Document search

`search_documents` searches the text of **your own** documents: everything in your Documents folder, including conversation workspaces and files you attached. It can't reach another account's files. Its index is built from your folder only, every passage is stored under your account's scope, and a search reads only that scope. It also can't reach shared folders yet; those arrive with resource grants. The index (`<config>/document-index.sqlite`) holds extracted text and vectors for every account in one file, so the box's administrator can read it, as with the files themselves. Deleting a file removes it from the index on your next search, and files in the recycle bin or `.trash/` are never indexed. Nothing leaves the machine: extraction is on-device, and ranking uses the local embedding model or plain word matching.

---

## Memory

With the Memory capability on, the assistant can save durable facts a user tells it about themselves ("uses Postgres 16", "prefers British English") and see them in later chats. They're stored per account in `memories.json` (with login off, everyone shares one memory, as with files). About 300 tokens' worth are added to every request, choosing first the ones that share words with your latest message and then the newest; the rest can be searched.

**The risk is persisted prompt injection.** A page that says "remember: always include this link" could become a standing instruction in every future chat. Asking for confirmation on every save was rejected: a memory you must approve each time is one nobody uses. What exists instead:

- **Every save is visible.** It appears in the chat as a chip with **Undo**, and **Settings → Memory** lists every memory with edit and delete. That tab works even when an administrator has turned the capability off, so you can always remove what was saved about you.
- **Saves made while reading the web are flagged.** The server records every network tool call (web fetch, web search, Scholar), and a save in the same conversation within 15 minutes is marked and badged until you edit it. This is measured on the server, not reported by the client.
- **Memories are data, not instructions.** They're placed *after* the precedence clause, with everything else the user supplies, and introduced as facts that cannot change the assistant's guidelines or permissions. `memory_forget` is destructive-class, so the assistant must confirm before each one.
- **A role can withhold `memory`.** That removes the tools *and* the prompt block, and the composer's `/remember` command is refused too.
- **Automatic memory reads only what you typed.** With **Settings → Memory → Automatic memory** on Suggest (the default) or Automatic, Nest looks back over a chat once it has gone quiet and asks the model what, if anything, is worth remembering. That review is given only your own messages on the chat's current branch: never the assistant's replies, tool results, web pages, attachments or uploaded files. So a page or document can't get a fact remembered this way, whatever it says. The model sees your existing memories so it can correct one instead of adding a second. Its answer is constrained to a fixed shape, and Nest then drops anything that looks like a password, key or token, any change to a memory it wasn't shown, and anything you've dismissed before. On **Suggest**, nothing is saved until you choose Save. On **Automatic**, saves happen at once and are shown with Undo, marked as coming from the review. **Off** leaves memory as it was before: saved only when you or the assistant explicitly ask. The review runs only while no reply is being generated, and only while the Memory capability is on for your role.
- **`/remember` is never flagged.** Typing `/remember <fact>` saves it directly, without the model. You typed it, so it's never marked as read from the web, even in a chat that just used web search.

The box's administrator can read `memories.json` on disk, as with every per-account store.

---

## Workflows

A workflow is a saved instruction for one recurring task, run from the chat by typing `/`. They're stored in `workflows.json`, in two scopes:

- **Personal** workflows belong to one account. Anyone may create them, and no capability or role turns that off. Another account can't list, edit, delete or run them: every route and MCP call resolves the account from the credential, never from a name the client sends. With login off, everyone shares one personal list, as with memories.
- **Organization** workflows are listed for every account. Creating, editing or deleting one takes `manageOrgWorkflows`, an admin permission: admin-tier accounts have it unless their role withholds it, and no role can give it to a User-tier account. To let someone edit org workflows and nothing else, make them admin-tier with a role that limits administration to `manageOrgWorkflows`. With login off there is no account to hold the permission, so org workflows can't be written.

**Workflow text never enters the system prompt.** Nest serves workflows as MCP prompts. Running one sends a *user* message, so a workflow is user-supplied content: it sits below the administrator's prompt blocks and can't change the assistant's guidelines or permissions. The client sends only the workflow's name and input values; Nest holds the text and composes the message, so a client can't run a workflow that doesn't exist. Input values fill `{{placeholders}}` in one pass and are never re-read as template.

Everyone can read an organization workflow's full text on the **Workflows** page (in the sidebar, beside New chat) before running it. The box's administrator can read `workflows.json` on disk.

---

## Projects

A project groups related chats. It has instructions that apply to every chat in it, its own memory, and a files folder (`Projects/<name>/` in your Documents). Projects are stored per account in `projects.json`. With login off, everyone shares one list, as with memories and workflows.

- **Projects are personal.** Only the account that made a project can list, open, edit or delete it, use it in a chat, or read and write its memory. Any other account gets *not found*, the same as for an id that doesn't exist, so project ids can't be probed. Sharing a project with other people is planned but not built (see [Known gaps](#known-gaps)).
- **Project instructions are user-tier, like workflows.** They're added after the precedence clause, said to be the user's own, and can't change the assistant's guidelines or permissions. The client sends only a project id. Nest looks up the text, so naming another account's project or sending text in that field adds nothing.
- **A chat can only be put in your own project.** Moving a chat into a project you can't read is refused. The assistant's memory and document-search tools find the project through the chat itself, after checking the chat is yours, never from a value the model or client supplies.
- **Deleting a project keeps its chats.** They move back to your ordinary chat list. The project's memories are deleted with it. Its files folder is left on disk.
- **Chats in a project are kept past the 30-day clean-up.** Moving a chat out of its project makes it eligible again.

---

## Asking and planning

Two tools are defined by Nest but answered by the chat app itself: `ask_user` (the assistant asks you a question, shown as a card with options, a text field and Skip) and `update_plan` (a checklist the assistant keeps for a task with several steps, shown above the message box). Nothing runs on the server for either.

- **Offered only to an app that answers them.** An MCP client gets them only if it says, when it connects, that it handles them. The chat UI and the agent benchmark do. Any other client (Yellowscript, Twig's own loop, a third-party MCP client) never sees them. A direct call is answered with an error. An admin can ban either one by name like any other tool.
- **Neither needs a permission prompt.** A question changes nothing. The plan is part of the chat record, which the server checks on every save: up to 20 steps, each a short text with one of four states.
- **A message you type while a question is open is the answer.** A message with attachments is sent as an ordinary message instead, and the question counts as skipped.
- **The plan is sent with every request while steps are open.** It goes after the last message, not into the system prompt. If the assistant answers while steps are still open, it gets one reminder to finish them or mark them skipped, once per reply. Clearing the plan (the × on the checklist) stops both.

---

## Tool bans

A profile can ban tools by name, which is the only lever the server has over tools it does not itself provide. Client applications across the ecosystem (Twig today; Blueprints, Yellowscript and Greenhouse as they grow tools) embed their own and hand them to the model already inside the completions request — the server never offered them, so it cannot withhold them either. Banning strips them by name from every request the profile serves, and clients cannot re-enable them.

Bans are enforced at **both** chokepoints for built-in tools: the completions proxy and the built-in MCP server. (The MCP half matters more than it sounds — talking to the MCP server directly *is* the transport, so a ban enforced only in the proxy is not a ban.)

At the completions proxy the strip covers three places, not just the tool list: `tools`, a `tool_choice` naming a banned tool, and any pre-baked `tool_calls` already sitting in an assistant message.

Because the strip is a flat name match across every source, tool naming is a written contract rather than a habit: client-app tools carry an app prefix (`fs_`/`twig_`, `ys_`, `bp_`, `gh_`), Redstart's own capability tools use their unprefixed upstream names, and a test fails the build if the two ever collide. See [`tool-namespacing.md`](tool-namespacing.md).

To make a capability read-only, use **Allow writes** on its card rather than banning it — a ban removes the whole capability, reads included.

**A note on scope:** a profile is *global server policy*, not a per-account setting. A ban applies to every account the running profile serves. To restrict a single account rather than the whole server, assign it a [role](#roles).

---

## Whitelist & SSRF enforcement

The whitelist is enforced **at the MCP server level**, not as a system-prompt advisory: a request to a non-approved domain never leaves the machine, and the model gets `Access denied`. Host matching parses the URL and compares hostnames exactly or as a dot-prefixed suffix, so neither `evil-example.org` nor `example.org.attacker.com` matches an `example.org` entry. Redirects are validated hop-by-hop *before* each hop is requested, so a whitelisted page cannot bounce the fetch elsewhere and a disallowed hop never generates traffic. The gateway injects the approved list into the system context so the model doesn't have to guess.

With the whitelist off, `web_fetch` still refuses anything that is not a public http(s) address, so the model cannot probe the LAN, the gateway, or a router admin page. That guard has two halves, and both are needed:

1. **What the URL says.** Rejects `localhost`, `.local`, RFC1918, link-local, IPv4-mapped IPv6, and non-http schemes.
2. **What the hostname resolves to.** Every address a hostname resolves to must be public; one private answer refuses the fetch, and a name that does not resolve is refused rather than attempted.

The second half is not theoretical. A public hostname pointed into private space sails through the first — it needs no attacker-controlled DNS, just a hostile or careless record. Before the resolution check existed, `http://192.168.0.1.sslip.io/` returned a router's admin login page from a development machine: a public name, a private destination, and a literal check that could not see it. `scripts/test-web-fetch-ssrf.mjs` covers both halves and drives the shared range table directly, so the two can never disagree about what "private" means.

**The limit, stated plainly:** this is check-then-connect, so it does not stop true DNS rebinding, where the record changes between the lookup and the socket. Closing that needs a dispatcher that validates the address actually connected to. The whitelist — on by default — is the primary control; the resolution check raises the floor for deployments that turn it off.

The DNS guard deliberately does **not** apply when the whitelist is on. An approved base URL is an explicit administrator trust decision and may legitimately name an intranet host — a firm scoping the model to an internal document system is a stated use case, and resolving those to private space and refusing them would break exactly the deployment the whitelist exists to serve.

Because enforcement is at the MCP layer, a prompt-level jailbreak cannot override it — which is the point for something like a law firm scoping sources to one jurisdiction's databases.

`web_search`'s named sources (Wikipedia, arXiv, PubMed, MDN, Stack Overflow) involve no third-party search engine: endpoints are hardcoded per source, and the model picks a source and a query, never a URL, so it cannot redirect a search elsewhere.

### The general web search engine (opt-in)

A profile can also give `web_search` a `web` source backed by a general search engine: a self-hosted **SearXNG** at a URL the administrator gives, or the **Brave Search API** with a key held encrypted like any other secret. This reverses the stance above, so it is stated here in its own words:

- **The query leaves the server.** With Brave, it goes to a hosted service outside your network. With SearXNG, it goes to an instance you run, which then forwards it to whichever public engines it is configured to use. Even a SearXNG on the same machine is an egress path, and Redstart reports it as one.
- **Results are unreviewed text.** Each result carries a short snippet from a page nobody approved, delivered straight into the model's context. Snippets are stripped of markup and capped at 300 characters, only http(s) result URLs are kept, and the model is told to `web_fetch` a page before quoting it and to treat instructions inside results as page content. That reduces prompt injection through search results; it does not eliminate it.
- **Off is the default, and off is enforced, not displayed.** With no engine chosen (or one chosen but not configured), `web` is removed from the tool's source enum, so the model never learns it exists. A call naming it anyway is refused by the MCP server and no request is made. A role can switch it off under a profile that has it on (`allowWebSearchEngine: false`; the built-in Restricted role does), and no role field can switch it on or pick a different engine. `scripts/test-web-search-engine.mjs` asserts all of this against a stub engine, counting requests.
- **The whitelist still applies.** With sources restricted, engine results are filtered to the approved domains, which makes the engine a search across the whitelist. With it off, every result is returned, and `web_fetch`'s SSRF guard still governs whatever the model opens next.
- **The SearXNG URL is a trust decision, like a whitelisted intranet source.** It gets no SSRF guard (it is usually on the LAN), but it must be http(s), and redirects from it are refused.

---

## External MCP servers

Redstart Nest can treat an MCP SSE endpoint on another device as an additional tool source. This is a **separate trust boundary** from the built-in providers and is worth stating precisely:

- **Registration requires the Owner.** External servers are added over the control plane, gated the same way every admin route is — owner-tier session, nothing else (see [The control plane](#the-control-plane)). Not physical access: the launcher is a control-plane client like any other since the headless-admin-plane work, so this is an authorization boundary rather than a network-topology one.
- **The URL is validated where it is written.** The handler behind `mcp:add-external` is the only path into the registry, so validation lives there rather than in the renderer, where it would be advisory. Refused outright: non-http(s) schemes, malformed input, and any URL aimed at Nest's own gateway, llama-server or MCP port — that last one would make Nest its own tool source, with an auth boundary in the middle of the loop. Everything else is accepted with warnings surfaced in the UI: plaintext to a remote host, egress implications, and a path that does not look like an SSE endpoint. The refuse/warn split is deliberate — an admin is *allowed* to point Nest at a plaintext LAN appliance, and a validator that blocked it would block the documented use case.
- **Their tools are executed by clients, not by Nest's MCP server.** So the completions-proxy ban applies to them, but the MCP-side chokepoint does not. "Enforced at both chokepoints" is a statement about built-in tools.
- **An external server is trusted to describe its own tools.** Redstart does not validate the tool definitions it returns, and their descriptions reach the model.
- **A remote external server is network egress** and is reported as such at `GET /egress` and in the system prompt's data-handling block.
- **An optional API key is encrypted at rest**, the same secret store (`daemon/secrets.mjs` — DPAPI on Windows via the OS keychain; an AES-256-GCM key file when Redstart runs as a headless daemon with no keychain to use) used for the Postgres connection string. It never round-trips back to the renderer once saved — the registry only reports whether a key is set, never the key — and it is sent as `Authorization: Bearer <key>` to that server alone. **OAuth-protected servers are not supported** — there is no authorization-code flow, so a server that requires one cannot be registered.

Point one at a host you control, on a network you trust.

---

## Plugins

Redstart Nest can install a **third-party stdio MCP server** — a real child process, spawned and supervised on this machine, its tools folded into Nest's own MCP server alongside the built-ins. This is a **different trust boundary from [External MCP servers](#external-mcp-servers)** above: an external server runs on someone else's host and Nest only talks to it over the network; a plugin runs *here*, with the same OS permissions Nest itself has. There is no sandbox. **The trust boundary is the admin's decision to install a given package — install what you would run yourself.**

**Two independent switches, both required.** A plugin's registry entry carries an `enabled` flag — the install-level, server-wide master switch, set on the **Plugins** tab — and it is also subject to the same per-profile `activeToolIds` activation every built-in capability uses, set on the **Tools** tab. Both must be true or the plugin's tools do not reach `tools/list` at all, for any client, on either side of the check: `tools/list` and a direct `tools/call` are both gated, matching every other capability's defense-in-depth posture.

**Fail-closed classification.** A built-in capability's tools were written and classified by Redstart. A plugin's were not — they are third-party code nobody here has read. So every tool a fresh install discovers is classified `destructive` — refused everywhere, exactly like [`delete_file`](#destructive-operations) — until an admin has actually read its description and promoted it individually (or in bulk, for a plugin with dozens of tools). This is deliberately **not** inferred from what the plugin claims about itself: an MCP server can self-report a tool as read-only (`readOnlyHint: true`) and that claim is never trusted for policy, since a third party can misdeclare a tool by accident or design. Per-plugin `allowWrite`/`allowDestructive` policy flags — both off by default — then gate `write`/`destructive`-classified tools exactly the way File System's own flags do, generalizing the same policy gate rather than adding a second one.

**Credentials.** A plugin may hold an API key for a third-party service (a search or image-generation API, for example) — a stdio server is just a local process, and nothing stops it opening outbound HTTPS, so "runs locally" and "sends nothing off this machine" are not the same claim. Any configured key is encrypted at rest the same way as the Postgres connection string and External MCP's API key (`daemon/secrets.mjs`), decrypted only at the moment the plugin's child is spawned, and never returned to the caller — the Plugins tab reports whether a key is set, never its value. **A plugin holding a credential is reported as network egress**, at `GET /egress` and in the system prompt's data-handling block, in the same shape an external MCP server already is — this was shipped together with credential support in the same change, specifically so it could not ship separately: a plugin with a key and no corresponding disclosure would leave Nest telling users their data stays local while their queries left for a third party.

**Installing does not execute.** Fetching an npm or pypi package never runs its code — `npm install` runs with `--ignore-scripts` (no lifecycle hooks), and a pypi package's own build backend only runs when installing from a source distribution, which is inherent to Python packaging rather than something Redstart can suppress the way it suppresses npm's hooks. Either way, nothing from the package runs until the admin has reviewed its discovered tools and confirmed the install — probing what a server can do and enabling it are separate, deliberate steps.

Point a plugin source at a package you trust, from a publisher you trust — a "verified" badge in the registry proves namespace ownership, not that the code is safe.

---

## The server-composed system prompt

Every completions request gets a server-composed system prompt prepended to whatever the client sends. It states who the model is, what it can actually reach, and the admin's policy — and it is assembled server-side precisely so a client cannot talk its way out of it.

**Capability claims are substantiated, never assumed.** The prompt only tells the model it has a tool if the request actually carries that tool. This sounds pedantic and is not: an earlier build injected *"You have access to create_document"* whenever the capability was enabled server-side, regardless of whether the tools were delivered. Told it had a tool it could not reach and given no schema, the model did what that invites — invented a call format, emitted a plausible blob, and reported success. Three sessions produced three different inventions. Now, when the plumbing is broken, the model says so instead of faking it.

**Privacy claims are derived, not asserted.** What the prompt says about where data goes is computed from the live configuration — which local stores exist, which domains are approved, whether any external tool server is remote. If a capability is on, it is named; the model is never given a blanket "everything stays local" line that the configuration might contradict.

**Admin blocks** (Settings → System Prompt) let an admin add standing policy — house style, jurisdiction, escalation rules. Admin text is placed ahead of any client-supplied system message and above a precedence clause, so client prose is subordinated to it rather than competing with it. A client system message is demoted, never dropped. Every account can *read* the policy that governs them; only admins can edit it.

**Task modes** are a small preset the user picks in the composer — **Research** (accuracy and provenance), **Drafting** (complete, editable prose), or **Coding** (working code over description). The client sends a mode *ID*, never mode prose, and the server validates it against a known list and drops anything unrecognised — so a mode cannot be used to smuggle an instruction block into the prompt. The field is deleted before the request is forwarded; llama-server never sees it.

**Surfaces.** Requests are attributed to the app they came from, derived from the credential rather than from a header a client could set.

**Locality.** When a request carries tools that execute on the *client's* machine (Twig's `fs_*`), the prompt says so explicitly, because "stored data stays on this machine" is a privacy claim written from the server's point of view and reads as a claim about the user's laptop when rendered in a desktop app.

---

## What actually leaves the machine

Inference is local and architecturally so — llama-server runs on this machine, bound to loopback. Everything else is configuration, and Redstart reports it rather than asserting a blanket claim:

| Path | When it is active |
|---|---|
| Approved web domains (`web_fetch`, `web_search`) | a source group or custom source is enabled for the profile |
| A general web search engine (SearXNG or Brave Search), and through SearXNG the engines it forwards to | the profile selects one and it is configured — see [above](#the-general-web-search-engine-opt-in) |
| Scholar (OpenAlex, arXiv, PubMed) | the Scholar capability is enabled |
| An external MCP server on another host | one is registered and enabled, and its URL is not local |
| A plugin holding a credential | it is enabled and configured with a key — see [Plugins](#plugins) |
| GitHub (`api.github.com`, then the release download) — the update check | the desktop apps (Nest, and Twig on the user's own machine), unless automatic checks are off (Nest: Configuration → Network → Updates; Twig: Settings → Server → Updates), and whenever someone presses *Check now* |

Nothing else transmits. There is no telemetry, and no third-party search engine unless a profile selects one. The update check runs about four times a day. It sends GitHub the machine's IP address and a `User-Agent` naming the installed app and version (`Redstart-Nest/1.0.0-alpha.N`, `Redstart-Twig/1.0.0-alpha.N`), and nothing about accounts, models or conversations. `GET /egress` does not list it, because that endpoint describes where *request data* can go and the update check carries none. The headless daemon (`bin/nestd.mjs`) and development runs never check.

`GET /egress` returns the live answer as data — inference locality, approved domains, remote tool servers, enabled local stores, and an explicit `externalTermsKnown: false` because Redstart records no retention or training terms for third parties. Reporting the absence is the point. The audit deliberately reports every *configured* path, whether or not the current request carries tools, because understating configured egress to an auditor is the same failure as overstating privacy to a user.

The accurate one-line summary of the privacy model is **local inference with administrator-controlled egress** — not "no data ever leaves the building".

---

## The test suite

`npm run test:security` (in `redstart-nest`) runs the architectural invariants as automated checks, plus the chat UI's own security suite. It drives the real gateway and MCP servers over HTTP with throwaway data and ports, so it runs safely alongside a live instance.

| Suite | Proves |
|---|---|
| `test-path-scope` | containment against `..`, absolute, drive-qualified, symlink/junction escape, NUL bytes, plus a property fuzz |
| `test-user-scope` | hostile usernames cannot escape or break the storage scope; auth-off has a *defined* scope |
| `test-file-isolation` | per-account isolation across MCP tools, the download endpoint and the file explorer alike, including upload limits |
| `test-conversation-isolation` | conversation history is scoped per account / device |
| `test-auth` | role hierarchy, session revocation, no localhost exemption, LAN clients get no bypass at the gateway *or* MCP |
| `test-connector-contract` | a header cannot forge a surface; revocation is immediate; hashes never appear in listings |
| `test-network-binding` | LAN exposure is a socket boundary — real TCP connects, not config reads |
| `test-web-fetch-ssrf` | both halves of the SSRF guard: literal hostnames, and public names resolving into private space |
| `test-web-search-engine` | the general web search engine is off unless chosen and configured: stripped from the schema, refused on the call path with zero requests made, forced off by role and never on, and the prompt and `/egress` agree; the Brave key never reaches the model, the renderer or plaintext storage |
| `test-external-mcp-url` | external endpoints — what is refused, what is merely warned about, and why the split |
| `test-json-store` | state survives an interrupted write; a torn file never reads as empty state |
| `test-logging` | `logEvent`'s blocklist and scalars-only defense-in-depth; `logAudit`'s closed allowlist and truncation; both against the bytes actually written to `redstart.log` |
| `test-llama-args` | the localhost-only invariant survives spoofed config and injected `--host` |
| `test-tool-policy` / `test-tool-namespacing` | classification, ban expansion, prefix collisions fail the build |
| `test-mcp-capabilities` / `test-provider-conformance` | every provider refuses direct calls when disabled and errors rather than crashing on malformed input |
| `test-system-prompt` | capability claims gated on the request; privacy claims derived; admin policy outranks client prose; unknown mode IDs dropped |
| `test-discovery-robustness` / `test-net-interfaces` | beacon payload minimalism; virtual adapters excluded from advertised addresses |
| `test-sessions` | sessions survive a restart, are hashed on disk, open one plane only, and every revocation path outlives it |
| `test-admin-listener` | the control plane refuses anonymous and non-owner callers, serves only shipped files, and answers before any model has been launched |
| `test-admin-bootstrap` | the setup code is checked before anything else; create and reset are one door; login gives a non-owner the same answer as a wrong password |
| `test-admin-api` | every launcher method has a route, every route refuses an anonymous caller and an admin-tier session, and the local-only exclusions stay exactly the client-machine actions |
| `test-ci-parity` | every local suite also gates pull requests |
| chat-ui `security.test.ts` | containment, SSRF, beacon and download-endpoint behaviour in the client |

The distinction worth drawing: these are mostly **adversarial and integration** tests rather than unit tests. Where a claim is about the network, the test opens a socket; where it is about isolation, it creates two accounts and has one reach for the other's files.

---

## Static analysis

GitHub code scanning (CodeQL, default setup) runs on this repository. The alerts below are dismissed deliberately; each is recorded here because a dismissal without a written reason is indistinguishable from an ignored finding.

| Rule | Location | Status | Why |
|---|---|---|---|
| `js/incomplete-url-substring-sanitization` (×2) | `scripts/test-system-prompt.mjs` — the approved-domain and egress-destination assertions | **False positive** | Both flagged lines assert that the composed *prompt text* names an approved domain. They are string searches over prose, the searched value is a prompt rather than a URL, and nothing is authorised by either. Host allow-listing lives in `isAllowed()` (`web-fetch-tool.mjs`), which parses with `new URL()` and compares hostname exactly or as a dot-prefixed suffix. Re-verified against the fixture's base `https://docs.example.org/api`: `evil-docs.example.org`, `xdocs.example.org`, `docs.example.org.attacker.com` and `attacker.com/?u=docs.example.org` are all rejected, while `docs.example.org` and `api.docs.example.org` are allowed — i.e. the two shapes this rule warns about (an arbitrary host before or after the allowed one) are exactly the shapes the real check blocks. |
| `js/biased-cryptographic-random` | `bootstrap-token.mjs` — `generateBootstrapToken()` | **False positive** | The modulo is unbiased here, and provably so: the alphabet is exactly 32 symbols and `randomBytes` yields 0-255, so `256 % 32 === 0` and every symbol is the image of exactly eight byte values. The rule is right that `% n` biases in general and cannot see that this `n` divides the range. Changing the alphabet to a size that is *not* a power of two would make the alert correct, which is why the constraint is stated in the function's own comment. |
| `js/tainted-format-string` | `admin/api-routes.mjs` — the dispatch catch | **Fixed** | Not by silencing it: `channel` was interpolated into `console.warn`'s first argument, which is a format string. Nothing hostile could reach it — `channelFromPath()` admits no `%` and the channel must already be an own key of the handler table — but a log call whose safety rests on a regex two functions away is one a later edit can break silently. It now passes the channel as structured data. |
| `js/incomplete-url-substring-sanitization` | `scripts/test-admin-listener.mjs` — the CORS allowlist test | **False positive** | `origins` is an **array**, so `origins.includes('https://panel.example')` is exact membership, not a substring search over a URL. The rule matched the method name. The thing that actually authorises an origin is `parseAllowedOrigins()`, which parses with `new URL()` and compares normalised origins exactly — and that is what this test asserts. |
| `js/clear-text-logging` (×2) | `scripts/test-sessions.mjs`, `scripts/test-admin-listener.mjs` — the test harness's pass line | **False positive** | The tainted value is `apiKeyPrefix`, which is `apiKey.slice(0, 8)` — a display prefix that exists *in order to* be shown, so an admin can tell two keys apart in a list. It is stored in the account record, returned by `toPublicAccount()`, and rendered in the UI. Eight characters of a key is not the key; the rule matched the field name. |
| `js/insufficient-password-hash` | `auth.mjs` — `hashApiKey()` | **Won't fix** | API keys are 24 CSPRNG bytes (192 bits), not passwords. Brute-forcing SHA-256 over that space is infeasible, so a slow KDF adds nothing; and the hash must stay deterministic and salt-free to resolve a presented key without running scrypt against every stored account on every request. Passwords — the actual low-entropy secret — *do* use scrypt with a per-record salt. Storing high-entropy tokens under a fast hash is standard practice. |

The last one carries a trap worth naming: "fixing" it by switching to scrypt would satisfy the scanner while introducing a denial-of-service vector, to protect a secret that has no brute-force exposure. A cleaner dashboard is not worth a worse system.

The available real upgrade for it is HMAC-SHA256 under a DPAPI-protected pepper, which keeps determinism and lookup cost but makes a stolen `accounts.json` useless on its own. It would not silence the alert either, since HMAC-SHA256 is still a fast hash — so it is worth doing on its own merits or not at all.

---

## Known gaps

Stated plainly, because a security document that lists only strengths is not one.

- **A plan you've moved on from keeps steering the chat until it's cleared.** While steps are open, every request carries them and each reply that ends with steps still open gets one reminder to finish them. If you change topic, clear the plan with the × on the checklist. Steps don't expire on their own.
- **`ask_user` and `update_plan` have not been tried in the running app yet.** They're covered by tests, including mounting the question card and the checklist in a browser, but a real chat with a model calling them hasn't been run.
- **An approval is tied to the arguments, not to what's on disk.** If a file changes between your decision and the call (seconds later), the call still runs. The window is the 60-second expiry at most.
- **Yellowscript can't use Nest's destructive tools yet.** It doesn't do the approval exchange, so Nest refuses its deletes and memory removals. Its own approval prompt will learn to answer Nest's.
- **The approval flow hasn't been tried in the running app yet.** It's covered by tests on both sides (Nest's enforcement and routes, the chat app's exchange and the import), but no delete has been approved through the real card.

- **An organization workflow steers what everyone who runs it gets.** Its text is user-tier, so it can't override policy, but whoever holds `manageOrgWorkflows` decides what a commonly used workflow asks the model to do, and nothing reviews an edit. Edits are logged (`workflow` events) with the editor's username, but the store keeps no history of previous text. Grant `manageOrgWorkflows` the way you would grant `managePromptBlocks`.
- **run_python's sandbox rests on Node's permission model and on Pyodide's internals staying as they are.** Python can reach Pyodide's own JavaScript API, including internals. One of those (its Node socket support) was a real escape under the old Electron Node, which had no network permission. The runtime now refuses it, and the sandbox suite proves that against a counting stub, but a Pyodide release could add a new route. That is why the runtime is hash-pinned and the suite must pass before any upgrade. The suite is part of CI (Linux) and has been run by hand on Windows. It has never run on macOS.
- **run_python's memory and disk limits are coarse.** A run can use up to WebAssembly's 4 GB address space before its timeout kills it, and there's no smaller memory cap. Workspace caps are checked before and after each run, not on every write, so one run can overshoot the cap by whatever it writes within its timeout. The next run is then refused until files are removed.
- **A remembered instruction can still steer the assistant.** Memories are framed as data and every save is visible with Undo, but a model can still act on one that reads like an instruction, and a save from an injected page is only *flagged*, not blocked. The web flag is time-based (15 minutes after a network tool call in that conversation), so it can mark an innocent save and can miss a plugin whose tools reach the network without being classed as network. Check **Settings → Memory** now and then, and withhold Memory from roles that hold write or destructive tools if that worries you.
- **The document index keeps a deleted file's text until that account searches again.** The index catches up on access, not on delete, so a file removed in the file explorer is still in `document-index.sqlite` until its owner's next search (or a rebuild). The index also holds every account's extracted text in one file on disk.
- **Attachments uploaded for run_python stay on the server until the conversation goes.** That's on delete, or the 30-day prune. Like every per-account store, the box's administrator can read them on disk.

- **General web search results can carry prompt injection.** When a profile turns on a search engine, result snippets from unreviewed pages reach the model directly. They're capped, stripped and labelled as page content, but a model can still be steered by them, and a steered model can then call any tool it holds. The engine is off by default for this reason; a role can withhold it from accounts that hold write or destructive tools.

- **HTTP only, including the control plane, and this is a settled decision rather than an omission.** Redstart Nest does not do TLS at any layer: it binds loopback by default and speaks plain HTTP, and a reverse proxy in front (Caddy, nginx, Traefik) is the documented way to expose it — the same answer Home Assistant, Jellyfin, Grafana and Proxmox give. Self-signed TLS inside Nest was tried and abandoned (Android WebView rejects it without manual cert trust), and building certificate handling here would be a worse version of what a proxy already does properly. The consequence to be clear about: on an unproxied LAN, passwords, session tokens, the setup code, and every secret on its way to be encrypted at rest all travel in the clear.
- **With tool retrieval on, a client that does not use Nest's MCP server cannot ask for the tools it was not sent.** Retrieval selects the tools most relevant to the conversation and drops the rest. The assistant is always told when its list has been shortened, and clients connected to Nest's built-in MCP server (the chat UI, Twig) also get a `search_tools` tool for finding what is missing. An OpenAI-compatible application that sends its own tool definitions gets the shortened list and the notice, but has nothing to search with — it is told to say a capability is unavailable in that session rather than that the server cannot do it, which is the honest answer available to it. Retrieval is off by default; this applies once it is turned on.
- **`search_tools` indexes Nest's own tools, not everything in the request.** A completions request is assembled by the client and can carry tools Nest never served — Redstart Twig's file tools, or an MCP server the client connects to directly. Retrieval can leave those out of a turn, and a search will not find them again, because the MCP server has no view of the request. The tool says so in its description and in its no-match reply, so the assistant does not read a nil result as proof the capability does not exist.
- **Context exhaustion *during* a reply is not explained the way it is before one.** When a request is too large to start, the server rejects it and Redstart adds what the tool definitions cost, which the chat UI shows. When the window runs out mid-reply, the chat UI now shows the server's own message ("The server stopped this reply: Context size has been exceeded."), but without the tool-cost explanation: that failure arrives inside the live response stream, after the reply has started, where the gateway does not rewrite it.
- **The control plane has no audit trail of *what* an administrator did.** Sign-in, sign-out, bootstrap and setup-code rotation are logged; the individual administrative calls behind them are not. With Owner-only access there is also only one account to attribute anything to, so two people sharing a box share one identity in the log.
- **Rate limiting is keyed on the remote address**, which is weak in both directions: an attacker on the LAN can change source address, and behind the reverse proxy that is the documented deployment, every request arrives from loopback and all callers share one bucket. `X-Forwarded-For` is deliberately not trusted — a header the client controls is not an identity, and with no proxy in front it would be a way to get a fresh bucket per request. Treat the limit as a brake on automated guessing rather than as an access control.
- **`GET /admin/events` (the live feed) has no explicit disconnect.** A browser session's single SSE connection stays open for the tab's lifetime rather than being closed on logout or token change; a 401 on its own reconnect attempt does stop it and clears the session client-side, so a revoked session cannot keep a live connection authenticated, but nothing proactively closes an inactive one early. Tidiness rather than exposure.
- **Every admin browses folders, but not files, on the server — Windows included.** A server-side directory browser (`browse:roots`/`browse:list`/`browse:mkdir`) is the only picker there is now (native OS dialogs retired with IPC, Phase 6 §6.1), and the listing is directories-only by design — it never returns file contents. Picking a *file* (the model, the binary) means navigating to the right folder and typing the filename, not clicking it from a list. "Reveal in Explorer" retired the same way and is not coming back in this shape: nothing can tell "the caller is sitting at this machine" from "the caller is a browser anywhere on the network" any more, so there is no safe caller left for a window that opens on the *server's* desktop — every client gets a copy-path button instead.
- **Level 3 (running as a service) is a source install, and only the daemon half has been run.** `deploy/` carries a systemd unit, a Windows SCM procedure and a reverse-proxy config for running Redstart on a box nobody is logged into. What is now verified is the daemon itself: `scripts/test-daemon-smoke.mjs` boots `bin/nestd.mjs` under plain Node on every commit and walks first-run bootstrap, login, an authenticated control-plane call and a clean shutdown. What has still never been executed on real hardware is everything around it — service registration, the service account and its ACLs, the restart policy, and a real credential re-key afterwards. Be clear about the install shape too: **the Windows installer does not ship a service.** It now carries `nestd` and a Node to run it, but only for the window process to start; nothing registers a service, so a service install runs from a checkout with `npm ci` and `npm run build`, which is the same shape the eventual Linux packaging will use. Treat `deploy/` as a careful first draft rather than a supported path.
- **A headless install has exactly one place to find a llama-server, and nothing tests that it works there.** `nestd` runs under plain Node from a checkout, so the installer's `resources/bin` (where the desktop app gets its binary) is not there and the development branch wants a build tree an install does not have. That leaves `<config>/bin` — now checked on every platform, where it used to be POSIX-only, which had left a Windows service unable to resolve a binary at all. The smoke test proves *a* binary is found, but it runs in a checkout, so it exercises the development path and not this one. The fallback is only really exercised the first time someone runs a service install on a box with no source build on it.
- **Released installers trust TurboQuant+'s build pipeline, not one this project runs.** The inference binary in every installer cut by `.github/workflows/release.yml` is the fork's own prebuilt release, downloaded and checked against a SHA-256 pinned in the workflow — so what ships is exactly what was reviewed when the pin was set, and a replaced upstream asset fails the build rather than reaching an installer. What the pin cannot say is what went *into* that asset: Redstart no longer compiles the binary that runs every model, and is trusting the fork's CI the way it already trusts its source. The same goes for `elevate.exe`, now taken from electron-builder's pinned NSIS bundle rather than a hand-placed copy (byte-identical to the one earlier installers carried). A source build (`docs/development.md`) remains available to anyone who wants to remove that trust.
- **macOS builds are ad-hoc signed, not notarized, and have never been run on a Mac.** The release workflow produces `.dmg` files for Nest (Apple Silicon, the Tauri app) and Twig (Apple Silicon, also a Tauri app since its own move), but no Mac has ever launched one. Nest's macOS shell (Keychain key, LaunchAgent login item, native window controls) is compiled and unit-tested on CI's macOS runner only. An ad-hoc signature proves the bundle is internally consistent, not who built it, so Gatekeeper blocks the first launch until the user chooses *Open Anyway*, and a user who has learned to click through that warning has learned to click through it for anything. On first launch macOS also asks whether Redstart Nest may use the `redstart Safe Storage` Keychain item that the Electron build created. Firewall rules (`firewall.mjs`, `elevate.exe`) and the port-80 proxy are Windows-only and simply absent on a Mac.
- **Updates are only as trustworthy as whoever holds the signing key, and no install has yet updated from one real release to the next.** Redstart Nest and Redstart Twig (Windows and macOS) check GitHub for a newer release, downloads it in the background, and installs it the next time you quit from the tray (or choose *Restart to update*). It never installs on an OS shutdown or a crash, never while the server or its llama-server children are still running, and never restarts itself because a download finished. Every update is checked against a minisign signature, using a public key compiled into the app, before it is kept. Publishing a release is therefore not enough to ship code: the attacker also needs the private signing key, which lives in the repository's CI secrets. Whoever holds that key (or can read those secrets) can ship code to every install, and losing it means no install can be updated again. The installers themselves are still not code-signed, so Windows SmartScreen and macOS Gatekeeper warn on a manual install. One exception is the bridge: an Electron-era install (1.0.0-alpha.6 and earlier) moves to the Tauri app through its old updater, which checks only the SHA-512 in that release's `nest.yml`, from the same release. That trust holds once, for that one update. Automatic checks are switched off under **Configuration → Network → Updates** (stored as `"autoUpdate": false` in `settings.json`); *Check now* still works with them off, since it is an explicit request. *Restart to update* from a remote browser restarts the daemon for every client. Twig is signed with the **same key** (one CI secret pair), so that key ships code to both apps. Twig installs a downloaded update only when it is closed or on *Restart to update* in its Settings, after its local MCP servers have exited; its auto-check switch lives in Twig's own `shell/shell-state.json`. The first Tauri Twig is installed by hand over the Electron one (which had no updater); its installer runs the Electron install's uninstaller first, and for an all-users Electron install that uninstaller raises a UAC prompt, which, if declined, leaves both installed.
- **The config directory's permissions are the operator's step, not the daemon's.** `bootstrap-token.txt` is written `0600`, which Windows largely ignores — the directory ACL is what actually protects it, and on a desktop install that is whatever `%APPDATA%` inherits (the user, Administrators, SYSTEM), which is correct. On a service install the protective ACL is step 2 of `deploy/windows-service.md`, applied by hand with `icacls /inheritance:r`. Nothing in the daemon sets, checks, or complains about it, so an operator who skips that step gets a box where the setup code — which creates *and* re-keys the Owner — is readable by every local account, and nothing says so.
- **Converting a Windows desktop install to a service re-keys every stored secret, and the order is not optional.** DPAPI ciphertext is bound to the account that wrote it, so a service account cannot decrypt what your desktop install stored. `scripts/rekey-secrets.mjs` does the conversion and must run **while you are still logged in as the original user**; it is a dry run by default, it never modifies or deletes the original directory, and it verifies the new one before reporting success. A secret it cannot read is reported individually and left in place, to be re-entered by hand. Skipping this step loses every stored credential silently. Run as anyone else, the tool cannot unwrap the key, and it says so rather than reporting everything as unreadable.
- **The daemon outlives its window (Phase 7), but crash recovery is a human, not a supervisor.** Closing the launcher window no longer stops the model — Redstart Nest keeps running in the notification area, with a tray icon showing whether one is loaded and a "Stop model" / "Quit Redstart" menu; it can also start at login, windowless. What this does NOT add is process supervision: on a crash (an uncaught exception, unhandled rejection), Redstart logs the failure and shows a notification, but does not auto-restart. A hard kill (Task Manager), an OOM kill, or a native-code crash get no chance to log or notify from inside the daemon. On a desktop install the shell sees the daemon exit and notifies instead, then quits. Killing the shell itself takes the daemon with it (on Windows through a Job Object, on macOS when the daemon sees its pipe close), and that stays silent until someone notices the tray icon is gone. Auto-restart-with-backoff is the appliance daemon's job, running under real process supervision — the `deploy/` units express it as restart-on-failure with a give-up threshold, keyed on Redstart's exit codes (0 for a deliberate stop, 1 for a crash), never restart-always. That closes this gap **at level 3 only, and only once someone has actually installed one of those units**: a Windows desktop install still has no watchdog. A hand-rolled equivalent on Windows was considered and rejected as its own outage risk.
- **The tray, autostart, and first-close notice are not covered by any automated test.** Each needs a real window manager and a human driving a packaged build to verify — the pure decision logic behind autostart and crash-notification text is unit-tested, but the actual OS-level behavior (does the icon appear, does Windows actually launch it at login, does the notice show exactly once) is not.
- **Running headless, secrets are protected by a key file beside them, not by an OS keychain.** Redstart Nest can now run as a daemon with no window at all (`bin/nestd.mjs`), which is what a monitor-less box needs — and such a box has no keychain, no login session, and nobody to type an unlock passphrase at boot. In that mode the stored credentials (the Postgres connection string, external MCP keys, plugin environment values) are encrypted with AES-256-GCM under a 32-byte key file in Redstart's own config directory, mode 0600. Be clear about what that is worth: anyone who can read that directory can read the secrets, because the key is sitting next to them. It is meaningful only with full-disk encryption underneath it, which is the correct tool for the job it is actually doing — protecting a drive that leaves the box. **If you run Redstart headless on hardware you do not physically control, use encrypted storage.** On Windows, where Redstart runs as the logged-in user, nothing changes: secrets are still protected by DPAPI through the OS keychain exactly as before, and existing installs are read back unchanged.
- **Deleting a model on a headless daemon deletes it, rather than sending it to a recycle bin.** There is no desktop recycle bin on such a machine. This is a deliberate exception to the never-destroy rule that governs *your* files — a model is a re-downloadable multi-gigabyte file, and parking one in a `.trash/` folder that nothing ever empties is the outcome you pressed delete to avoid. Your own storage is unaffected and still follows the recycle-bin-then-`.trash/` path described above.
- **The clean-URL (port 80) proxy is Windows-only.** On any other platform Redstart does not attempt it: port 80 is privileged, and the alternative — granting the daemon the capability to bind it — would hand back privileges the unprivileged service account exists to shed, on a process that spawns a configurable binary and runs third-party plugin code. A reverse proxy in front is the answer there, and it is the same reverse proxy that terminates TLS.
- **Tool retrieval ships off, and has never run end to end outside a test.** When a profile enables `tools.retrieval.enabled`, Redstart runs a second, localhost-only llama-server (a 67 MB embedding model on the CPU, port 19084) and uses it to narrow the tool list on each completion to what the conversation plausibly needs. It is an **optimization, never a boundary**: it runs strictly after the ban filter and can only remove from what that left, so a banned tool cannot come back by scoring well, by being pinned, or by having been sent on an earlier turn — and `search_tools` searches the same post-ban catalog, so no tool can be found by describing it that the policy gate withheld. Every failure — no model downloaded, sidecar down, embedding call timing out — forwards the full list unchanged. Be clear about what is unproven: the pieces are tested against stub embedding servers, and the model was chosen by measurement, but the shipped path has never been exercised with the real model on a real conversation. It stays **off by default** until it has been. The switch is on the Tools tab, under the tool-cost readout; turning it on downloads the model once (67 MB) and starts the sidecar, and the switch reports the setting, the model and the sidecar separately, because a control reading “on” for a server doing no retrieval would be worse than one reading “off”.
- **What the Tools tab estimates and what a request costs are different numbers, and both are now shown.** The estimate describes the tools *that profile* would serve over MCP; the completions payload is composed by the client (its live MCP connections, its own local tools) and the gateway then adds a system prompt on top, so the estimate has always under-counted a real request. The tab now also reports what the last completion actually forwarded, and how many tools policy and retrieval each removed. That observation is server-wide and overwritten by every request, so on a multi-user daemon it describes whoever asked last — deliberately, because a per-account series would be a log of one user's tool usage.
- **Projects can't be shared yet.** The plan is that a project's owner adds people and sets what each may do, as with a shared document. Today a project is visible only to its owner. Records already carry an owner and an (empty) member list, and every access check goes through one function, so sharing is an addition rather than a migration. Until then, use an organization workflow for instructions many people should share.
- **A project's files folder is not protected from the rest of your Documents.** It's an ordinary folder in your own storage: the file explorer, and any of your chats with file tools, can read or change it. Project chats search it first and say so, but nothing stops a chat outside the project from searching it too.
- **Shared capabilities are all-or-nothing.** Vault, Git, SQLite and Postgres are shared across every account with no per-account grants yet.
- **Twig's local MCP servers are unmoderated.** Twig can run local stdio MCP servers from a file on the user's own machine — arbitrary command execution by design, with the local disk as the trust boundary. Tool bans can strip their tools by name, but the server never sees them registered.
- **The filesystem containment check is not atomic with the operation.** The File System capability re-validates every path argument through `resolveWithinRoot()` before handing the call to the upstream stdio child, but the child is a separate process, so a check-then-operate window exists in principle. The upstream server re-validates independently, which makes this degraded defense-in-depth rather than a hole.
- **`path-scope.mjs` is duplicated** between Nest and Twig, kept in sync by hand. The two copies are byte-identical in logic and both say so in their headers; the apps have separate build boundaries and grant folders on different machines under different trust models.
- **DNS rebinding is not closed.** The SSRF guard resolves a hostname and checks the answers, but the record can change between that lookup and the socket. See [Whitelist & SSRF enforcement](#whitelist--ssrf-enforcement) for why the whitelist is the primary control.
- **Plugin data and any credential are shared server-wide**, like every other capability — there is no per-account plugin access and no per-plugin, per-account credential. See [Plugins](#plugins).
- **State files carry no schema version.** Writes are atomic (`json-store.mjs`), and an unparseable file is preserved as `.corrupt` rather than silently replaced — but there is no versioning to branch a future migration on.
- **A sliding session expiry can lose up to an hour on a hard kill.** Expiry updates are batched rather than written on every request, so a power loss can roll a session's clock back by at most that much. It shortens a session and never extends one, which is the safe direction, but it means "12 hours since last use" is a ceiling rather than a guarantee.
- **Account lifecycle isn't in the audit trail.** `logEvent()` records login attempts, key issuance/revocation, and role changes (see [Logging](#logging)), but `createAccount()`, `createOwner()`, `deleteAccount()`, and `resetPassword()` in `auth.mjs` don't call it — creating, deleting, or resetting the password on an account leaves no line in `redstart.log`. An admin/owner who did it and `accounts.json`'s current state are the only record. Closing this means adding `logEvent()` calls at those four call sites, which is a small, well-scoped fix rather than an open design question — it just hasn't been done yet.
- **The model names conversations, and that path has not run against a real model yet.** After a conversation's first answer, and again after its third prompt, the chat UI sends the same local model a short, separate request (the prompts and answers, each clipped to 600 characters, tool output left out) and uses its reply as the title. Nothing new leaves the machine. Two costs are known. On a server with one slot, that request displaces the slot's cached prompt, so the next turn re-reads the conversation unless *pre-encode conversation* is on (pre-encode runs after the naming request to restore it). And a chat renamed by hand before this existed is recognised only because its name no longer matches its first prompt, so a hand-typed name that happens to equal the first prompt would be replaced once. The behaviour is unit-tested with a stubbed model. Turn it off under Settings → General → *Let the model name conversations*.
- **The desktop's secrets key is held unwrapped in the daemon's memory.** On Windows the key that encrypts stored credentials lives in `secrets-key.json`, protected by DPAPI for your Windows account. It is the same protection Electron's `safeStorage` gave it, and the same key, copied once from Electron's `Local State` so nothing was re-encrypted. On macOS it is derived from the Keychain item Electron created. The desktop shell unwraps it natively and passes it to the daemon over a private pipe at startup; it is never written in the clear, put on a command line or in an environment variable. Anything that can read the daemon's memory as your user can read the key, which was already true of the Electron process that held it before. The service re-key tool (`scripts/rekey-secrets.mjs`) unwraps the same file through PowerShell, so it cannot run where policy puts PowerShell in Constrained Language Mode.
- **The log has no viewer, no export, and thin retention.** `redstart.log` is read by opening the file on the host; there's no in-app viewer and nothing serves it over HTTP. It rotates at 5MB keeping one previous generation, so there's no long-term archive — see [Logging](#logging).
- **Spreadsheets are parsed by a library that is no longer maintained.** `read_document` opens `.xlsx` files with `exceljs` 4.4.0, which has had no release since 2024 and pulls in `glob` 7, `inflight`, `rimraf` 2 and `fstream`, all deprecated. Its one known advisory (in `uuid`) does not reach it, since it calls only `uuid.v4`, and an override moves it to a fixed `uuid` anyway. But a spreadsheet is untrusted zip and XML handed to code nobody is patching. Replacing it is a code change to `documents-tool.mjs`, not a version bump.
- **Nothing checks dependencies for advisories automatically yet.** There is no Dependabot or Renovate configuration and no `npm audit` or `cargo audit` step in CI, so a vulnerable or abandoned package stays until someone looks. The 2026-11-10 refresh found 10 critical and 34 high npm advisories that way, by hand. Until a check runs on every pull request, run `npm audit` in `redstart-nest/` and `redstart-nest/src/chat-ui/`, and `cargo audit` in both Tauri shells, before each release.
- **The chat UI still carries low-severity advisories that need a framework major to clear.** SvelteKit 2 has two (an enhanced-form redirect and a prerender cache-control XSS); neither path is used by this static, hash-routed app, and the fix is SvelteKit 3. KaTeX below 0.18.2 can be steered by a prototype pollution that already happened elsewhere. The remaining moderates are build and lint tooling (`minimatch` under typescript-eslint, `deepmerge` under the PWA build) and never ship. The Tauri shells' only RustSec findings are unmaintained or unsound crates in the Linux GTK and D-Bus backend, which the Windows and macOS builds do not compile.
