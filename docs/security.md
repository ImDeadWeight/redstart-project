# Security & Trust Boundaries

*[← back to the README](../README.md) · [docs index](README.md)*

This document collects every trust boundary in Redstart in one place: who authenticates, what each credential grants, where a path can and cannot resolve, what the model is allowed to be told, and what leaves the machine.

Redstart is a LAN appliance, not an internet-facing service. **Do not expose the gateway port to the public internet**, regardless of whether login is on.

---

## Contents

- [Accounts & login](#accounts--login)
- [The identity model](#the-identity-model)
- [Roles](#roles)
- [The llama-server boundary](#the-llama-server-boundary)
- [Network exposure](#network-exposure)
- [Per-account file storage](#per-account-file-storage)
- [Your files (web UI)](#your-files-web-ui)
- [Destructive operations](#destructive-operations)
- [Tool bans](#tool-bans)
- [Whitelist & SSRF enforcement](#whitelist--ssrf-enforcement)
- [External MCP servers](#external-mcp-servers)
- [The server-composed system prompt](#the-server-composed-system-prompt)
- [What actually leaves the machine](#what-actually-leaves-the-machine)
- [The test suite](#the-test-suite)
- [Static analysis](#static-analysis)
- [Known gaps](#known-gaps)

---

## Accounts & login

Redstart Nest has an optional account system, gated behind a global **Require login** toggle in the server settings. It's **on by default** — every client on the network, including the host machine's own browser, must authenticate before accessing the chat UI or API. With it off, anyone on your network can use the server with no login and no API key, exactly like a plain llama.cpp setup. Turn it on and the picture changes:

- **Login gate.** When accounts are required, the chat UI is not reachable until you sign in — a device that isn't logged in gets the login screen, not the chat. This holds for browsers on other devices too, not just the app.
- **Three-tier roles.** A single **Owner** creates and removes **Admin** accounts; Admins manage regular **Users** day-to-day; Users just log in and chat. Sessions are token-based and persist across app launches (they're held in memory server-side, so restarting Redstart Nest signs everyone out — clients handle that by returning to the login screen rather than erroring).
- **Profile page.** A **Profile** entry in the sidebar (and in the collapsed icon rail) opens a full-page account view rather than a dropdown. Its **Account** tab shows role, account-created / last-login timestamps and API key management; its **Files** tab browses your own storage on the server (see [Your files](#your-files-web-ui)). A regenerated key is shown once and stays on the page until dismissed — the previous dropdown put it in a modal that a stray click could dismiss, and the server keeps only a hash, so a key lost that way is gone for good.
- **API keys.** Each account has a long-lived API key (prefixed `rst_`) for OpenAI-compatible clients like Kilo Code. Only a hash is stored server-side, so an existing key is only ever shown as its prefix — regenerate to get a fresh full key. Admins can also manage keys for the accounts they oversee.
- **Per-connector keys.** An account can also issue keys bound to a specific *surface* (`nest-chat`, `twig`, `blueprints`, `yellowscript`, `greenhouse`), managed under Settings → Connectors. The surface travels with the credential, so the server derives which app is calling from the key itself rather than believing a header.
- **First run.** The Owner account is created in the Redstart Nest launcher itself — deliberately, there is no HTTP route for bootstrap, so creating the first account requires physical access to the host machine. Since login is on by default, do this before expecting any device (including a browser on the host PC) to sign in.

This is a newer subsystem — treat the account-management surface as still stabilizing.

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
| `test-llama-args` | the localhost-only invariant survives spoofed config and injected `--host` |
| `test-tool-policy` / `test-tool-namespacing` | classification, ban expansion, prefix collisions fail the build |
| `test-mcp-capabilities` / `test-provider-conformance` | every provider refuses direct calls when disabled and errors rather than crashing on malformed input |
| `test-system-prompt` | capability claims gated on the request; privacy claims derived; admin policy outranks client prose; unknown mode IDs dropped |
| `test-discovery-robustness` / `test-net-interfaces` | beacon payload minimalism; virtual adapters excluded from advertised addresses |
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

- **Sessions are in-memory**, so a server restart invalidates every token. Persisting them means writing credentials to disk; that decision is deliberately open.
- **HTTP only on the LAN.** Self-signed TLS was tried and abandoned — Android WebView rejects it without manual cert trust. Transport security is on the roadmap and matters more as the project moves toward office use.
- **Shared capabilities are all-or-nothing.** Vault, Git, SQLite and Postgres are shared across every account with no per-account grants yet.
- **Twig's local MCP servers are unmoderated.** Twig can run local stdio MCP servers from a file on the user's own machine — arbitrary command execution by design, with the local disk as the trust boundary. Tool bans can strip their tools by name, but the server never sees them registered.
- **The filesystem containment check is not atomic with the operation.** The File System capability re-validates every path argument through `resolveWithinRoot()` before handing the call to the upstream stdio child, but the child is a separate process, so a check-then-operate window exists in principle. The upstream server re-validates independently, which makes this degraded defense-in-depth rather than a hole.
- **`path-scope.mjs` is duplicated** between Nest and Twig, kept in sync by hand. The two copies are byte-identical in logic and both say so in their headers; the apps have separate build boundaries and grant folders on different machines under different trust models.
- **DNS rebinding is not closed.** The SSRF guard resolves a hostname and checks the answers, but the record can change between that lookup and the socket. See [Whitelist & SSRF enforcement](#whitelist--ssrf-enforcement) for why the whitelist is the primary control.
- **State files carry no schema version.** Writes are atomic (`json-store.mjs`), and an unparseable file is preserved as `.corrupt` rather than silently replaced — but there is no versioning to branch a future migration on.
