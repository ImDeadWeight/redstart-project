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
- **First run.** On Windows the Owner account is created in the Redstart Nest launcher itself, exactly as before. From a browser it is created through the control plane's setup screen, which asks for the machine's **setup code** first — there is no anonymous route to ownership on either path. Since login is on by default, do this before expecting any device (including a browser on the host PC) to sign in.

This is a newer subsystem — treat the account-management surface as still stabilizing.

---

## The control plane

Configuring Redstart Nest and using it are two different things, and from the
2026-09 pass they are two different listeners with different rules.

| | Data plane | Control plane |
|---|---|---|
| What | Gateway `19080`, MCP `19082`, mDNS, port-80 proxy | Admin listener `19083` |
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

- Why it must exist: creating the first Owner is safe over IPC because IPC means
  physical access. Over HTTP it is not, and "no Owner exists" is reachable by a
  corrupt `accounts.json` as well as by a new install — so without a code, the
  first stranger to find the port would own the machine.
- Why it is plain text: the launcher reads it and submits it for you, so Windows
  setup is unchanged and you never see it. Hashing it would cost that and buy
  nothing — anyone who can read the file can rewrite `accounts.json`, which is
  ownership by a shorter route.
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
The document is served with a Content-Security-Policy stricter than the Electron
window's — no inline script at all, and `connect-src 'self'`.

**No CORS, and therefore no CSRF machinery.** The listener sends no
`Access-Control-Allow-Origin` header and answers no preflight; it serves its own
origin. The credential is a bearer token the page attaches itself rather than a
cookie, so a cross-site request carries no authority in the first place.

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
├── session token(s)          in-memory, 30-day sliding, revoked on delete/reset
├── general API key           rst_… — one per account, hash stored
└── connector key(s)          rst_… — each bound to ONE surface
    └── surface               nest-chat | twig | blueprints | yellowscript | greenhouse
```

There is exactly one resolution path from an incoming request to an account: `authenticate(req)` in `electron/main/auth.mjs`. Both the gateway and the MCP server call it; neither touches account storage directly.

**Passwords** go through scrypt with a per-record 16-byte salt and are compared with `timingSafeEqual`. **API keys and connector keys** are 24 CSPRNG bytes (192 bits) stored as a SHA-256 hash — see [Static analysis](#static-analysis) for why a slow KDF is deliberately not used there.

**The surface comes from the credential, never from a header.** A connector key resolves to `{ account, surface, clientKeyId }`, and the gateway passes that surface into the prompt composer. An `X-Redstart-Surface` header is accepted and inert; the connector contract suite asserts that a header cannot forge a surface the credential did not grant. Connector keys are independently revocable, and revocation takes effect on the next request.

**Session revocation is centralized.** Deleting an account or resetting its password calls `revokeSessionsForAccount()`, so there is no path that removes an account while leaving a live token behind. Sessions are in-memory only, so a server restart signs everyone out — see [Known limitations](roadmap.md#known-limitations).

**Owner bootstrap has no HTTP route at all.** `createOwner()` is reachable only over Electron IPC from the launcher window, which requires physical access to the host. It is deliberately a separate function from `createAccount()` rather than an "allow owner" branch inside it, so the owner-creation path cannot be reached any other way.

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
| **Administration** | For admin-tier accounts: `manageAccounts`, `manageRoles`, `managePromptBlocks` individually. Tier remains the ceiling — no role can make a User an admin. |

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

**Discovery is not authentication.** The beacon and mDNS answer "where might a Redstart server be?" — never "this server is trustworthy". The beacon payload is minimal by design (`{ app, running, port }`) and discloses no version, auth state, configuration or URLs. A discovered server still has to authenticate the client.

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

**Tool class is decided server-side from a static map**, never read from the tool's own annotations. MCP annotations are advisory and, on a normal connection, attacker-controlled; the spec is explicit that clients must not make trust decisions from them. Redstart publishes them for third-party clients but its own gate classifies from `TOOL_CLASSES`.

---

## Logging

`electron/main/logger.mjs` writes one JSON object per line to `redstart.log` in userData: the operationally interesting events (auth, tool execution, server lifecycle, discovery, MCP registration) plus a concise console line. The contract is to log the *shape* of what happened, never the content.

There are two mechanisms, and they answer different questions — this is the distinction to reach for when the question is specifically "what does Redstart audit?":

- **`logEvent()` — the operational trail, blocklist plus scalars-only.** This is where account-affecting actions show up: `login_ok` / `login_failed` (username + role, never the password), `client_key_issued` / `client_key_revoked`, and `role_saved` / `role_deleted` / `role_assigned`, alongside tool calls (`tool.called` / `tool.denied`), server lifecycle, and IPC rejections. Callers are expected to pass only safe scalar fields (tool name, class, decision, duration, port, username, role). As defense in depth, the logger also drops any field whose key names sensitive data — tool args/results, message/conversation content, SQL, file paths, URLs, secrets — case-insensitively, and drops any object or array value outright regardless of its key. The second rule is the one that matters most: it protects against a future field name nobody thought to blocklist, not just the known list.
- **`logAudit()` — a closed allowlist, the one documented exception to "never the content".** Destructive-class tool calls (currently only `delete_file`) record what was deleted, because a deletion nobody can name is a deletion nobody can undo. Only `AUDIT_FIELDS` (`tool`, `path`, `scope`, `kind`, `recoverable`) survive; string values are truncated at 512 characters; file contents are never logged by anything. Nothing else in the codebase may call it, and its two call sites (`files-api.mjs`, `fs-delete-tool.mjs`) are checked by name.

Both halves — the blocklist/scalars-only rule and the allowlist — are proven against the actual bytes written to disk by `test-logging`, not against mocked internals. See [The test suite](#the-test-suite).

**Access and retention.** `redstart.log` is a plain file in userData; there is no in-app log viewer and no HTTP route that serves it, so reading it means reading it off the host disk. It rotates at 5MB, keeping exactly one previous generation (`redstart.log.1`) — there is no long-term archive, so an incident older than roughly two rotations' worth of activity is gone unless something outside Redstart copied the file first.

**What this is not.** `logEvent()` gives an operational trail, not a durable per-account audit log: entries are one-line JSON, not queryable per-account history, and — see the gap below — account lifecycle changes aren't in it at all. Anyone asking "does Redstart have audit logging" should get that qualified answer, not a flat yes.

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

`web_search` never involves a third-party search engine: endpoints are hardcoded per source, and the model picks a source and a query, never a URL, so it cannot redirect a search elsewhere.

---

## External MCP servers

Redstart Nest can treat an MCP SSE endpoint on another device as an additional tool source. This is a **separate trust boundary** from the built-in providers and is worth stating precisely:

- **Registration requires physical access to the host.** External servers are added over Electron IPC from the launcher window. There is no HTTP route, so no LAN client — authenticated or not, admin or not — can register one.
- **The URL is validated where it is written.** The IPC handler is the only path into the registry, so validation lives there rather than in the renderer, where it would be advisory. Refused outright: non-http(s) schemes, malformed input, and any URL aimed at Nest's own gateway, llama-server or MCP port — that last one would make Nest its own tool source, with an auth boundary in the middle of the loop. Everything else is accepted with warnings surfaced in the UI: plaintext to a remote host, egress implications, and a path that does not look like an SSE endpoint. The refuse/warn split is deliberate — an admin at the console is *allowed* to point Nest at a plaintext LAN appliance, and a validator that blocked it would block the documented use case.
- **Their tools are executed by clients, not by Nest's MCP server.** So the completions-proxy ban applies to them, but the MCP-side chokepoint does not. "Enforced at both chokepoints" is a statement about built-in tools.
- **An external server is trusted to describe its own tools.** Redstart does not validate the tool definitions it returns, and their descriptions reach the model.
- **A remote external server is network egress** and is reported as such at `GET /egress` and in the system prompt's data-handling block.
- **An optional API key is encrypted at rest**, the same OS-level secret store (`electron/main/secrets.mjs`, DPAPI on Windows) used for the Postgres connection string. It never round-trips back to the renderer once saved — the registry only reports whether a key is set, never the key — and it is sent as `Authorization: Bearer <key>` to that server alone. **OAuth-protected servers are not supported** — there is no authorization-code flow, so a server that requires one cannot be registered.

Point one at a host you control, on a network you trust.

---

## Plugins

Redstart Nest can install a **third-party stdio MCP server** — a real child process, spawned and supervised on this machine, its tools folded into Nest's own MCP server alongside the built-ins. This is a **different trust boundary from [External MCP servers](#external-mcp-servers)** above: an external server runs on someone else's host and Nest only talks to it over the network; a plugin runs *here*, with the same OS permissions Nest itself has. There is no sandbox. **The trust boundary is the admin's decision to install a given package — install what you would run yourself.**

**Two independent switches, both required.** A plugin's registry entry carries an `enabled` flag — the install-level, server-wide master switch, set on the **Plugins** tab — and it is also subject to the same per-profile `activeToolIds` activation every built-in capability uses, set on the **Tools** tab. Both must be true or the plugin's tools do not reach `tools/list` at all, for any client, on either side of the check: `tools/list` and a direct `tools/call` are both gated, matching every other capability's defense-in-depth posture.

**Fail-closed classification.** A built-in capability's tools were written and classified by Redstart. A plugin's were not — they are third-party code nobody here has read. So every tool a fresh install discovers is classified `destructive` — refused everywhere, exactly like [`delete_file`](#destructive-operations) — until an admin has actually read its description and promoted it individually (or in bulk, for a plugin with dozens of tools). This is deliberately **not** inferred from what the plugin claims about itself: an MCP server can self-report a tool as read-only (`readOnlyHint: true`) and that claim is never trusted for policy, since a third party can misdeclare a tool by accident or design. Per-plugin `allowWrite`/`allowDestructive` policy flags — both off by default — then gate `write`/`destructive`-classified tools exactly the way File System's own flags do, generalizing the same policy gate rather than adding a second one.

**Credentials.** A plugin may hold an API key for a third-party service (a search or image-generation API, for example) — a stdio server is just a local process, and nothing stops it opening outbound HTTPS, so "runs locally" and "sends nothing off this machine" are not the same claim. Any configured key is encrypted at rest the same way as the Postgres connection string and External MCP's API key (`electron/main/secrets.mjs`), decrypted only at the moment the plugin's child is spawned, and never returned over IPC — the Plugins tab reports whether a key is set, never its value. **A plugin holding a credential is reported as network egress**, at `GET /egress` and in the system prompt's data-handling block, in the same shape an external MCP server already is — this was shipped together with credential support in the same change, specifically so it could not ship separately: a plugin with a key and no corresponding disclosure would leave Nest telling users their data stays local while their queries left for a third party.

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
| Scholar (OpenAlex, arXiv, PubMed) | the Scholar capability is enabled |
| An external MCP server on another host | one is registered and enabled, and its URL is not local |
| A plugin holding a credential | it is enabled and configured with a key — see [Plugins](#plugins) |

Nothing else transmits. There is no telemetry, no update check, and no third-party search engine.

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

GitHub code scanning (CodeQL, default setup) runs on this repository. Two alerts are dismissed deliberately; both are recorded here because a dismissal without a written reason is indistinguishable from an ignored finding.

| Rule | Location | Status | Why |
|---|---|---|---|
| `js/incomplete-url-substring-sanitization` | `scripts/test-system-prompt.mjs` | **False positive** | The flagged line asserts that the composed *prompt text* names an approved domain. It is a string search over prose, and nothing is authorised by it. Host allow-listing lives in `isAllowed()` (`web-fetch-tool.mjs`), which parses with `new URL()` and compares hostname exactly or as a dot-prefixed suffix. |
| `js/insufficient-password-hash` | `auth.mjs` — `hashApiKey()` | **Won't fix** | API keys are 24 CSPRNG bytes (192 bits), not passwords. Brute-forcing SHA-256 over that space is infeasible, so a slow KDF adds nothing; and the hash must stay deterministic and salt-free to resolve a presented key without running scrypt against every stored account on every request. Passwords — the actual low-entropy secret — *do* use scrypt with a per-record salt. Storing high-entropy tokens under a fast hash is standard practice. |

The second one carries a trap worth naming: "fixing" it by switching to scrypt would satisfy the scanner while introducing a denial-of-service vector, to protect a secret that has no brute-force exposure. A cleaner dashboard is not worth a worse system.

The available real upgrade there is HMAC-SHA256 under a DPAPI-protected pepper, which keeps determinism and lookup cost but makes a stolen `accounts.json` useless on its own. It would not silence the alert either, since HMAC-SHA256 is still a fast hash — so it is worth doing on its own merits or not at all.

---

## Known gaps

Stated plainly, because a security document that lists only strengths is not one.

- **HTTP only, including the control plane, and this is a settled decision rather than an omission.** Redstart Nest does not do TLS at any layer: it binds loopback by default and speaks plain HTTP, and a reverse proxy in front (Caddy, nginx, Traefik) is the documented way to expose it — the same answer Home Assistant, Jellyfin, Grafana and Proxmox give. Self-signed TLS inside Nest was tried and abandoned (Android WebView rejects it without manual cert trust), and building certificate handling here would be a worse version of what a proxy already does properly. The consequence to be clear about: on an unproxied LAN, passwords, session tokens, the setup code, and every secret on its way to be encrypted at rest all travel in the clear.
- **The control plane has no audit trail of *what* an administrator did.** Sign-in, sign-out, bootstrap and setup-code rotation are logged; the individual administrative calls behind them are not. With Owner-only access there is also only one account to attribute anything to, so two people sharing a box share one identity in the log.
- **Rate limiting is keyed on the remote address**, which is weak in both directions: an attacker on the LAN can change source address, and behind the reverse proxy that is the documented deployment, every request arrives from loopback and all callers share one bucket. `X-Forwarded-For` is deliberately not trusted — a header the client controls is not an identity, and with no proxy in front it would be a way to get a fresh bucket per request. Treat the limit as a brake on automated guessing rather than as an access control.
- **A remote administrator sees no live output.** Server log lines, tokens/minute and model-download progress are pushed to the Electron window and have no HTTP equivalent yet, so over a browser those operations run but report only when they finish. A shared event broker is the planned fix.
- **A remote administrator can browse folders, but not files, on the server.** A server-side directory browser (`browse:roots`/`browse:list`/`browse:mkdir`) replaced the native pickers for capability folders, the models folder and the llama-server binary, but the listing is directories-only by design — it never returns file contents. Picking a *file* (the model, the binary) remotely means navigating to the right folder and typing the filename, not clicking it from a list. "Reveal in Explorer" is the one action that stays a `501`: it opens a window on whichever machine is asked, which cannot be done on someone else's, so the UI shows a copy-path button there instead.
- **Closing the launcher still stops the model.** The control plane is separated, but the daemon is not: quitting Redstart Nest quits everything. Running it as a background service is a later phase.
- **Shared capabilities are all-or-nothing.** Vault, Git, SQLite and Postgres are shared across every account with no per-account grants yet.
- **Twig's local MCP servers are unmoderated.** Twig can run local stdio MCP servers from a file on the user's own machine — arbitrary command execution by design, with the local disk as the trust boundary. Tool bans can strip their tools by name, but the server never sees them registered.
- **The filesystem containment check is not atomic with the operation.** The File System capability re-validates every path argument through `resolveWithinRoot()` before handing the call to the upstream stdio child, but the child is a separate process, so a check-then-operate window exists in principle. The upstream server re-validates independently, which makes this degraded defense-in-depth rather than a hole.
- **`path-scope.mjs` is duplicated** between Nest and Twig, kept in sync by hand. The two copies are byte-identical in logic and both say so in their headers; the apps have separate build boundaries and grant folders on different machines under different trust models.
- **DNS rebinding is not closed.** The SSRF guard resolves a hostname and checks the answers, but the record can change between that lookup and the socket. See [Whitelist & SSRF enforcement](#whitelist--ssrf-enforcement) for why the whitelist is the primary control.
- **Plugin data and any credential are shared server-wide**, like every other capability — there is no per-account plugin access and no per-plugin, per-account credential. See [Plugins](#plugins).
- **State files carry no schema version.** Writes are atomic (`json-store.mjs`), and an unparseable file is preserved as `.corrupt` rather than silently replaced — but there is no versioning to branch a future migration on.
- **A sliding session expiry can lose up to an hour on a hard kill.** Expiry updates are batched rather than written on every request, so a power loss can roll a session's clock back by at most that much. It shortens a session and never extends one, which is the safe direction, but it means "12 hours since last use" is a ceiling rather than a guarantee.
- **Account lifecycle isn't in the audit trail.** `logEvent()` records login attempts, key issuance/revocation, and role changes (see [Logging](#logging)), but `createAccount()`, `createOwner()`, `deleteAccount()`, and `resetPassword()` in `auth.mjs` don't call it — creating, deleting, or resetting the password on an account leaves no line in `redstart.log`. An admin/owner who did it and `accounts.json`'s current state are the only record. Closing this means adding `logEvent()` calls at those four call sites, which is a small, well-scoped fix rather than an open design question — it just hasn't been done yet.
- **The log has no viewer, no export, and thin retention.** `redstart.log` is read by opening the file on the host; there's no in-app viewer and nothing serves it over HTTP. It rotates at 5MB keeping one previous generation, so there's no long-term archive — see [Logging](#logging).
