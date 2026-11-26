# Architecture

*[← back to the README](../README.md) · [docs index](README.md)*

What the pieces are, how they talk to each other, and which ports they hold.

---

## The ecosystem

Redstart is an **ecosystem of applications** around one idea: a model you own, running on hardware you own, reachable from every tool you work in. It is built on [llama.cpp](https://github.com/ggml-org/llama.cpp), with its KV cache quantized so a consumer GPU holds a usable context (a [TurboQuant+](https://github.com/TheTom/llama-cpp-turboquant) binary can be swapped in for its smaller cache types) — because your existing PC probably has a GPU capable of running a decent LLM already.

**Redstart Nest hosts the model. Everything else is a client** that finds it on the network, signs in with a Redstart account, and gets the same tools and policy the admin configured once.

| App | Platform | Role | Status |
|---|---|---|---|
| **Redstart Nest** | Windows and macOS (Tauri shell, daemon on Node 26); the daemon also runs headless | Server manager — runs the model, hosts the tools, accounts and policy, and broadcasts itself on the LAN | In this repo |
| **Redstart Twig** | Windows and macOS (Tauri shell, `twigd` on Node 26); Android paused | Lightweight chat client; finds Nest automatically, no configuration | In this repo |
| **[Redstart Blueprints](https://github.com/ImDeadWeight/redstart-blueprints)** | Windows (Electron) | A local-first SQL data workbench with optional AI assistance — register flat files, query them with DuckDB, build notebooks with charts and dashboards. The workbench works fully without a model; the assistant is a dockable panel you summon | Separate repo |
| **[Redstart Yellowscript](https://github.com/ImDeadWeight/redstart-yellowscript)** | VS Code extension | A coding agent that talks to a local Nest instead of a cloud — zero-config discovery, Redstart login, and workspace-aware tools | Separate repo |
| **[Redstart Greenhouse](https://github.com/ImDeadWeight/redstart-greenhouse)** | Windows (Electron), planned | Project management, built the way Blueprints is built — the tool works fully on its own and the model is an optional assistant. Where Blueprints is the analytics application, Greenhouse is the planning one | Separate repo, not yet started |

Nest, Twig and Blueprints share the same [SvelteKit](https://kit.svelte.dev/) frontend, a modified fork of the upstream llama.cpp web UI. It is its own app at the top of the repo (`chat-ui/`); Nest and Twig ship its build output and never import its source (see [Which app owns what](development.md#which-app-owns-what)). The chat UI is also reachable directly in any browser — no client app required.

**What makes it an ecosystem rather than a pile of apps** is that the integration points are contracts, not conventions. Every client authenticates with a per-connector key that carries its own *surface* (`nest-chat`, `twig`, `blueprints`, `yellowscript`, `greenhouse`), so the server knows which app is calling from the credential rather than a header it could fake. Client-supplied tools carry an app prefix (`fs_`/`twig_`, `bp_`, `ys_`, `gh_`) so an admin's tool bans stay targetable, and a test fails the build if two apps ever collide. See [`connector-contract.md`](connector-contract.md) and [`tool-namespacing.md`](tool-namespacing.md).

---

## How it works

```
[ GPU PC ]                              [ Phone / Laptop / VS Code / Browser ]
  Redstart Nest                            Redstart Twig  /  Kilo Code
  ├─ Gateway     :19080 (LAN in network mode) ├─ Scans LAN on port 8765
  │   └─ Injects Redstart context      ├─ Finds Redstart Nest automatically
  ├─ llama-server :19081 (localhost)   └─ Connects to http://IP:19080
  ├─ MCP server   :19082 (web, Documents, Python, Image generation, document search, Memory, File System, SQLite, Postgres, Vault, Git, Scholar, plugins)
  ├─ Admin plane :19083 (the launcher UI in a browser — owner only, loopback by default)
  └─ Beacon      :8765
```

Starting the server launches three services alongside the model — the gateway (`:19080`), llama-server (`:19081`, localhost-only) and the MCP server (`:19082`). The admin listener (`:19083`) and the beacon (`:8765`) are already up before any of that: they belong to the app, not to the model. See [Ports used](#ports-used).

**The gateway is the only thing clients talk to.** It intercepts every `POST /v1/chat/completions`, prepends the server-composed system prompt, strips banned tools, and pipes the request and response straight through — streaming included. Everything else is a transparent passthrough to llama-server. llama-server itself never accepts a LAN connection; see [Security](security.md#the-llama-server-boundary).

**Image generation pauses the model.** A 12 GB card cannot hold a chat model and an image model at once, so `generate_image` takes the GPU for its job: new requests to the model are held at the gateway, replies already streaming finish, llama-server alone is stopped (the gateway, MCP server and file-system provider stay up), one stable-diffusion.cpp process makes the picture and exits, and llama-server is started again with the same settings. Held requests are answered then. One image job runs at a time; the rest queue. See [Security → Image generation](security.md#image-generation).

**Discovery:** Redstart Nest broadcasts a JSON beacon on port 8765. Redstart Twig (both Android and Windows) scans the local subnet on startup and connects automatically if a running server is found — the beacon scan needs no hostname. (mDNS/`redstart.local` was retired: Android's resolver never answered `.local` lookups for browser navigation, and Twig never depended on it either — see [Known limitations](roadmap.md#known-limitations).)

The port-80 clean URL starts with the **app**, not with a model launch — a box that has never started a model still gets it once put in network mode, which is the state an unconfigured machine is in and the one where being findable matters most. Whether it runs is `networkMode` alone (the data plane); it no longer follows the control plane's own exposure.

**Reaching the server from a browser:** no single address reaches every client, so the launcher's **Network & access** panel lists both and lets you pick whichever works, with the direct IP as a QR code:

| Address | Reaches | Cost |
|---|---|---|
| `http://<LAN-IP>:19080` | **everything, including Android** | none — no name resolution at all |
| `http://<dashed-ip>.sslip.io:19080` | everything, including Android | needs internet DNS; blocked by routers with DNS-rebind protection |

The QR code encodes the **direct IP URL** — pointing a phone camera at it opens the chat UI in the browser with no resolver involved, which is the only approach that works universally. It is not the old `redstart://connect` deep link (removed in the 2026-07-20 launcher cleanup); it does not require Redstart Twig to be installed.

Prefer the IP and give the host a DHCP reservation on your router. The sslip name is a convenience layered on top, and it fails on routers with DNS-rebind protection — see [Known limitations](roadmap.md#known-limitations).

**OpenAI-compatible API:** llama-server exposes `/v1/chat/completions` and related endpoints, so any tool that accepts a custom OpenAI base URL can use Redstart Nest as its backend — including coding agents, scripts, and API clients.

**Browser access:** When Redstart Nest is running, the chat UI is also accessible directly in any browser at `http://127.0.0.1:19080` (or `http://<LAN-IP>:19080` in network mode). No app required. If login is enabled, the browser shows the login screen first (see [Accounts & login](security.md#accounts--login)).

**HTTPS (opt-in):** With Network & access → Secure address on, LAN devices use `https://<name>` with a real Let's Encrypt certificate: an Automatic name (`<id>.nest.redstartdevelopment.com`, from Redstart's name service) or your own DuckDNS/deSEC name. Nest's bundled Caddy terminates TLS on :443, the gateway and MCP server move to loopback, and certificates are issued by DNS-01, so nothing on the internet ever connects in. With it Off (the default) the LAN connection is plain HTTP and the chat UI says so. Every LAN listener is IPv4-only. See [Security](security.md).

---

## The daemon and the control plane

**The daemon is the product; the window is one client of it.** `daemon/` is
a server that runs on Node, started by `bin/nestd.mjs` in one of two ways: under
the desktop shell (`nestd --shell-pipe`), or headless (no window, no desktop
session). Both start the *same* daemon. What differs is what is injected into
two fail-closed seams: `platform-paths.mjs` (where state lives) and
`secrets.mjs` (what encrypts a credential). Under the shell, the paths and the
secrets key come from the shell. Headless, they come from a directory and an
AES-256-GCM key file.

**The desktop app is a small native shell around the daemon.** Redstart Nest's
window, tray, notifications, login item, updater and recycle-bin access are a
Tauri app (`redstart-nest/shell/`, Rust). The daemon is a separate process: the
shell starts `nestd --shell-pipe` on a Node 26 bundled in the install (pinned
by version and SHA-256 in `tooling/stage-node.mjs`). They talk in JSON lines
over the child's stdin and stdout (`shared/shell-pipe.mjs` here,
`shell/src/pipe.rs` there):

- the shell sends `hello` with the paths and the unwrapped secrets key, and
  the daemon answers `ready` with its port;
- after that, the daemon asks the shell for what only a desktop session can do
  (trash a file, set the login item, check for an update);
- the shell asks the daemon to stop the model or shut down.

**The shell owns the daemon's lifetime.** Quitting waits for the daemon to
stop, and the daemon stops llama-server first. If the shell dies, the daemon
sees end-of-file on stdin and stops itself. On Windows it also runs inside a
Job Object, so even a wedged daemon goes down with the shell. A daemon that
exits on its own only raises a notification; nothing restarts it.

**The secrets key never leaves the shell wrapped.** On Windows the shell
unwraps it with DPAPI (`secrets-key.json`, carried over once from Electron's
`Local State`). On macOS it reads the Keychain password Electron's
safeStorage created. Either way the daemon gets the key in `hello` and
decrypts with the same OSCrypt format Electron used (`daemon/secrets-dpapi.mjs`),
so nothing stored before the move was re-encrypted.

**Updates are signed.** The shell asks the daemon which GitHub release is the
update (`update-feed.mjs`), then Tauri's updater downloads that release's
installer and checks its signature against a public key compiled into the
shell. It installs only on a deliberate quit, after the daemon and its
children are gone.

**Twig is built the same way.** Redstart Twig, the desktop chat client, is a
Tauri shell (`redstart-twig/desktop/shell/`) around `twigd`, its own Node
half on the same bundled Node 26 and the same shell pipe. twigd does what the
page needs on the user's machine: the granted folder's `fs_*` tools, local
stdio MCP servers, the LAN scan for a Nest. The shell serves the chat UI from
its own `twig` protocol (`http://twig.localhost/`, a fixed origin, so the
UI's local storage survives restarts) and rebuilds Electron's
`window.redstartTwigAPI` as an injected script over Tauri IPC. It forwards
an allowlist of methods to twigd. Granting a folder is not on that list: it
happens only through the shell's own folder dialog. Twig's updater is Nest's,
reading `twig-latest.json` and signed with the same key, and installs when
Twig is closed.

**The launcher is a web page.** There is no preload script and no
`contextBridge`. The React launcher talks to the daemon over HTTP —
`POST /admin/api/<namespace>/<method>` on the control plane, so the desktop
window and a browser on a different machine are the same client over the same
transport, with no second UI to maintain. `src/launcher/api/redstart.ts` declares the
surface; `src/launcher/api/http.ts` derives every route from it;
`scripts/test-admin-api.mjs` fails the build if a declared method has no route or
a route is not gated.

**Why the control plane is a separate listener** rather than an `/admin` prefix
on the gateway: lifetime. The gateway exists because a model is running and stops
with it, and a plane whose lifetime is tied to the thing it controls cannot be
used to start that thing. `:19083` binds when the daemon starts. Three further
differences are deliberate:

- **Authentication is mandatory and separate.** The listener never reads
  `authRequired` — turning login off for the chat UI has no effect here. It
  accepts only a session minted by its own login route, never an API key (those
  sit in tool-client config files) and never a session the gateway issued. An
  owner signed in to the chat UI does not thereby hold process control.
- **No CORS.** It serves its own UI from its own origin and answers no preflight
  unless a deployment explicitly configures an allowlist.
- **The static layer is an enumerated allowlist**, built from what is actually on
  disk at start and looked up by exact match — so path traversal is structurally
  impossible rather than filtered.

**Exposure is an address, not a boolean.** `adminBindHost` defaults to
`127.0.0.1`; setting it to a LAN address, a VPN interface or `0.0.0.0` is one
setting that covers every case, and hostnames are refused rather than resolved,
because "bind to whatever this name resolves to right now" is not a stable
exposure decision. Moving it never weakens authentication.

**Closing the window stops nothing.** The daemon outlives it — the model stays
available to everyone else on the network, and reopening reconnects to what was
already running. Stopping is deliberate: **Shut down** in the launcher, **Quit**
in the tray, a signal to `nestd`, or `npm run daemon:stop`.

See [The control plane](security.md#the-control-plane) for the security contract.

---

## The MCP server is provider-driven

Each capability is a self-contained module declaring its own tools and handling its own calls, and the server merges tool lists and routes to the right provider. Adding a capability means adding a provider, not touching the transport.

Providers need not run in-process. File System is spawned as a stdio child and wrapped in a provider speaking the same `toolDefs`/`callTool` interface. Its supervisor (`shared/mcp-stdio-process.mjs`) is shared with Twig, which uses it for local stdio MCP servers. This is the sanctioned path for third-party tools: out-of-process, with their own trust boundary, and the permission gate still governs every call. **Plugins** are exactly this pattern generalized — an admin-installed third-party MCP server gets its own provider adapter (`plugin-provider.mjs`), spawned lazily on first call, namespaced (`<plugin-id>__<tool-name>`), and folded into the same `resolveProviders()` list the built-ins come from, resolved fresh on every request rather than cached, so an install or an uninstall takes effect without restarting Nest. See [Plugins](capabilities.md#plugins) and [Plugins (security)](security.md#plugins).

Every provider must pass the same invariant battery — `scripts/test-provider-conformance.mjs` drives each one over a real MCP connection and asserts that a disabled provider advertises nothing, refuses a direct `tools/call` anyway, and turns malformed input into an error result rather than a crash. Adding a provider to that registry gives it those guarantees for free.

The agent loop runs the full cycle — model emits a tool call, the tool runs, the result feeds the next turn — with streaming preserved throughout. The loop itself is host-agnostic code in `shared/agent-core/` (plain ESM, no DOM, no Node built-ins). Each host supplies ports for the model stream, the tool executors, the permission prompt, the turn-limit prompt and steering, so the chat-ui, the Node benchmark and the daemon all run the same loop rather than copies of it.

**Chats run on the server by default.** With *Run chats on the server* on (Settings → General, the default), a plain Send starts a job in the daemon (`job-runner.mjs`) and the page follows it over an event stream: live tokens, then the stored message. A refresh, a closed tab or a sleeping phone no longer ends the reply. Tools that only the client can run (Twig's `fs_*` tools, its local MCP servers) are registered with the run, and the daemon sends each such call back to exactly one connected client, which shows the approval card, runs it and posts the result. A run with nobody connected to answer waits (`waiting_client`). Messages with images, and edit, regenerate and branch, still use the browser loop for now, as does a Nest that cannot start a job. `/job` is the same machinery with no page following it.

### Where a tool server lives

MCP says how a tool is called, not where it runs, so Redstart has tool hosts on both sides, and the rule for choosing one is about what the tool acts on.

- **On Nest** when it works on data Nest holds, must work from a phone or a plain browser, must be callable by a background job, or should serve every account from one install. Built-in capabilities and admin-installed [plugins](capabilities.md#plugins) are here. They are managed in one place: add or remove one once, and every client picks it up on its next load, with the same policy for all of them.
- **On the client** when it acts on the user's own machine: their files, their desktop, a secret that should not leave their PC. Twig's granted-folder `fs_*` tools are here, and so are the stdio MCP servers in Twig's own registry (`twig-mcp.json`), which twigd spawns on the user's PC and which is never synced from Nest. These are absent on phones and in background jobs, and Nest's policy reaches them only by a ban on their names (see [`tool-namespacing.md`](tool-namespacing.md)).

---

## Ports used

| Port | Purpose |
|---|---|
| 19080 | Gateway — all clients connect here (default, configurable in Redstart Nest). Bound to `127.0.0.1` unless network mode is on |
| 19081 | llama-server — internal only, bound to `127.0.0.1` in both modes; never reachable from LAN |
| 19082 | MCP server — built-in tool endpoint (web_fetch, web_search, Documents, run_python, search_documents, Memory, Artifacts, File System, SQLite, Postgres, Vault, Git, Scholar, skills) plus any installed [plugins](capabilities.md#plugins). Bound to `127.0.0.1` unless network mode is on |
| 19083 | Admin listener — the control plane. Fixed, not configurable, and up whenever Redstart Nest is, whether or not a model is running. Bound to `127.0.0.1` unless `adminBindHost` says otherwise. See [The control plane](security.md#the-control-plane) |
| 19084 | Embedding server — a second, small llama-server used for tool and document search ranking. Bound to `127.0.0.1` only |
| 19085 | Artifact content listener — serves sandboxed artifact pages by view token only, on an origin of its own so their scripts can never reach the chat app's login. Fixed, up whenever Nest is, and bound wherever the gateway is (loopback while Caddy fronts Nest). See [Artifacts](security.md#artifacts) |
| 80 / 443 | The bundled Caddy, **only while HTTPS is on**: 443 serves `https://<name>` (the chat UI and MCP server), 80 redirects to it. With HTTPS off, Windows uses 80 for the clean-URL proxy instead |
| 8443 | The bundled Caddy serving the control plane over HTTPS, only while HTTPS is on **and** the admin panel is reachable on the network. An Automatic name also gets it on :443 as `admin.<name>` |
| 8444 | The bundled Caddy serving artifact content over HTTPS, while HTTPS is on. An Automatic name also gets it on :443 as `art.<name>` once the name service publishes that name |
| 8765 | Beacon — Redstart Nest identity broadcast, always bound to `0.0.0.0` for LAN discovery |

**Two planes, two lifecycles.** 19080/19081/19082 are the *data* plane: they exist
because a model is running and go away when it stops. 19083 is the *control*
plane, and it binds at app start regardless — a plane whose lifetime is tied to
the thing it controls cannot be used to start that thing. The beacon has always
worked this way and is the precedent.

**19080 is configurable and 19083 is not**, which is why `config.port` is
validated: the data plane claims three consecutive ports, so 19081 as a
configured port would put the MCP server on the control plane's socket. A launch
with a colliding port is refused with a message naming the collision rather than
failing somewhere downstream (`serverPortRejection()` in `ipc/validate.mjs`).

**Network mode is a bind, not a firewall rule.** With it off, the gateway and the MCP server listen on `127.0.0.1` only — a device on the LAN gets connection-refused, not a login screen, and that holds regardless of what the host's firewall is or isn't doing. Turning it on binds both to `0.0.0.0` and adds the Windows Firewall inbound rules (plus TCP 80 when the clean-URL proxy starts). Under the desktop app, the daemon asks the app's own program to add the missing rules: it starts itself elevated, so there is one UAC prompt for every rule a launch needs, and it names Redstart Nest rather than Windows' "Network Shell". The elevated side accepts only Nest's own rule names and fixes the direction, action and LAN-only scope itself (`shell/src/firewall.rs`). Caddy's rule, which admits `caddy.exe` only, is added just *before* Caddy first starts, so Windows never raises its own "allow access?" alert for it. A headless `nestd` falls back to the bundled `elevate.exe` running `netsh`, one prompt per rule; with neither (a plain dev daemon), rule creation is skipped with a warning. Each rule is prompted for once and never again. Rules are not removed when you turn network mode back off — deleting one needs elevation again, and a leftover rule is inert once nothing is listening on the wildcard.

Port 19081 is localhost-only in both modes, enforced at the socket *and* at the launch arguments (`--host` is hardwired and stripped from the advanced-args field). The gateway and its two internal services shift together if you change the configured port — llama-server is always `configured-port + 1`, and the MCP server is always `configured-port + 2`. `scripts/test-network-binding.mjs` proves the boundary by binding each server and attempting a real TCP connection from this host's own LAN address.

**The beacon is deliberately always on `0.0.0.0`.** It starts at app launch, before network mode is known, and its payload is minimal by design — `{ app, running, port }`, plus `origin` (`https://<name>`) while HTTPS is serving, nothing about version, auth state, or configuration. With HTTPS on, `port` is 80 (the bundled Caddy), because the gateway itself is on loopback then. Being discoverable is the whole function of a discovery service, and discovery answers "where might a Redstart server be?", never "this server is trustworthy". A discovered server still has to authenticate you.
