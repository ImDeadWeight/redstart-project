# Architecture

*[← back to the README](../README.md) · [docs index](README.md)*

What the pieces are, how they talk to each other, and which ports they hold.

---

## The ecosystem

Redstart is an **ecosystem of applications** around one idea: a model you own, running on hardware you own, reachable from every tool you work in. It is built on [TurboQuant+](https://github.com/TheTom/llama-cpp-turboquant), a production-grade fork of [llama.cpp](https://github.com/ggerganov/llama.cpp) that adds advanced weight and KV-cache quantization — because your existing PC probably has a GPU capable of running a decent LLM already.

**Redstart Nest hosts the model. Everything else is a client** that finds it on the network, signs in with a Redstart account, and gets the same tools and policy the admin configured once.

| App | Platform | Role | Status |
|---|---|---|---|
| **Redstart Nest** | Windows (Electron) | Server manager — runs the model, hosts the tools, accounts and policy, and broadcasts itself on the LAN | In this repo |
| **Redstart Twig** | Android & Windows | Lightweight chat client; finds Nest automatically, no configuration | In this repo |
| **[Redstart Blueprints](https://github.com/ImDeadWeight/redstart-blueprints)** | Windows (Electron) | A local-first SQL data workbench with optional AI assistance — register flat files, query them with DuckDB, build notebooks with charts and dashboards. The workbench works fully without a model; the assistant is a dockable panel you summon | Separate repo |
| **[Redstart Yellowscript](https://github.com/ImDeadWeight/redstart-yellowscript)** | VS Code extension | A coding agent that talks to a local Nest instead of a cloud — zero-config discovery, Redstart login, and workspace-aware tools | Separate repo |
| **[Redstart Greenhouse](https://github.com/ImDeadWeight/redstart-greenhouse)** | Windows (Electron), planned | Project management, built the way Blueprints is built — the tool works fully on its own and the model is an optional assistant. Where Blueprints is the analytics application, Greenhouse is the planning one | Separate repo, not yet started |

Nest, Twig and Blueprints share the same [SvelteKit](https://kit.svelte.dev/) frontend, a modified fork of the upstream llama.cpp web UI. The chat UI is also reachable directly in any browser — no client app required.

**What makes it an ecosystem rather than a pile of apps** is that the integration points are contracts, not conventions. Every client authenticates with a per-connector key that carries its own *surface* (`nest-chat`, `twig`, `blueprints`, `yellowscript`, `greenhouse`), so the server knows which app is calling from the credential rather than a header it could fake. Client-supplied tools carry an app prefix (`fs_`/`twig_`, `bp_`, `ys_`, `gh_`) so an admin's tool bans stay targetable, and a test fails the build if two apps ever collide. See [`connector-contract.md`](connector-contract.md) and [`tool-namespacing.md`](tool-namespacing.md).

---

## How it works

```
[ GPU PC ]                              [ Phone / Laptop / VS Code / Browser ]
  Redstart Nest                            Redstart Twig  /  Kilo Code
  ├─ Gateway     :19080 (LAN in network mode) ├─ Scans LAN on port 8765
  │   └─ Injects Redstart context      ├─ Finds Redstart Nest automatically
  ├─ llama-server :19081 (localhost)   └─ Connects to http://IP:19080
  ├─ MCP server   :19082 (web_fetch, web_search, Postgres, Documents, SQLite, Vault, Git, File System, Scholar)
  ├─ Beacon      :8765
  └─ mDNS        redstart.local (advertises the server on the local network)
```

Starting the server launches three services alongside the model — the gateway (`:19080`), llama-server (`:19081`, localhost-only) and the MCP server (`:19082`). See [Ports used](#ports-used).

**The gateway is the only thing clients talk to.** It intercepts every `POST /v1/chat/completions`, prepends the server-composed system prompt, strips banned tools, and pipes the request and response straight through — streaming included. Everything else is a transparent passthrough to llama-server. llama-server itself never accepts a LAN connection; see [Security](security.md#the-llama-server-boundary).

**Discovery:** Redstart Nest broadcasts a JSON beacon on port 8765 and advertises itself via mDNS as `redstart.local` by default (configurable). Redstart Twig (both Android and Windows) scans the local subnet on startup and connects automatically if a running server is found — the beacon scan needs no hostname, so Twig never depends on mDNS.

**Reaching the server from a browser:** no single address reaches every client, so the launcher's **Configuration → Network** panel lists three and lets you pick whichever works, with the direct IP as a QR code:

| Address | Reaches | Cost |
|---|---|---|
| `http://<LAN-IP>:19080` | **everything, including Android** | none — no name resolution at all |
| `http://redstart.local:19080` | iOS, macOS, Windows 10 1703+, Linux with avahi + `nss-mdns` | **not Android** |
| `http://<dashed-ip>.sslip.io:19080` | everything, including Android | needs internet DNS; blocked by routers with DNS-rebind protection |

The QR code encodes the **direct IP URL** — pointing a phone camera at it opens the chat UI in the browser with no resolver involved, which is the only approach that works universally. It is not the old `redstart://connect` deep link (removed in the 2026-07-20 launcher cleanup); it does not require Redstart Twig to be installed.

Prefer the IP and give the host a DHCP reservation on your router. The hostnames are conveniences layered on top, and each one fails somewhere — see [Known limitations](roadmap.md#known-limitations).

**OpenAI-compatible API:** llama-server exposes `/v1/chat/completions` and related endpoints, so any tool that accepts a custom OpenAI base URL can use Redstart Nest as its backend — including coding agents, scripts, and API clients.

**Browser access:** When Redstart Nest is running, the chat UI is also accessible directly in any browser at `http://127.0.0.1:19080` (or `http://<LAN-IP>:19080` in network mode). No app required. If login is enabled, the browser shows the login screen first (see [Accounts & login](security.md#accounts--login)).

**HTTP only:** The LAN connection uses plain HTTP. HTTPS with self-signed certificates was tried and abandoned — Android WebView rejects them without manual cert trust, which is too much friction for a home tool. Proper transport security is on the roadmap, likely via a lightweight CA or certificate pinning approach, and becomes more important as the project moves toward small business use.

---

## The MCP server is provider-driven

Each capability is a self-contained module declaring its own tools and handling its own calls, and the server merges tool lists and routes to the right provider. Adding a capability means adding a provider, not touching the transport.

Providers need not run in-process. File System is spawned as a stdio child and wrapped in a provider speaking the same `toolDefs`/`callTool` interface. Its supervisor (`shared/mcp-stdio-process.mjs`) is shared with Twig, which uses it for local stdio MCP servers. This is the sanctioned path for third-party tools: out-of-process, with their own trust boundary, and the permission gate still governs every call.

Every provider must pass the same invariant battery — `scripts/test-provider-conformance.mjs` drives each one over a real MCP connection and asserts that a disabled provider advertises nothing, refuses a direct `tools/call` anyway, and turns malformed input into an error result rather than a crash. Adding a provider to that registry gives it those guarantees for free.

The chat-ui's agentic loop runs the full cycle — model emits a tool call, the chat-ui executes it through the MCP server, the result feeds the next turn — with streaming preserved throughout.

### Centralized MCP management

MCP servers are managed in **one place — Redstart Nest** — not per device. Clients carry no MCP configuration UI; they fetch the active server list on startup and configure themselves. Add or remove a tool server once, and every client picks it up on its next load.

---

## Ports used

| Port | Purpose |
|---|---|
| 19080 | Gateway — all clients connect here (default, configurable in Redstart Nest). Bound to `127.0.0.1` unless network mode is on |
| 19081 | llama-server — internal only, bound to `127.0.0.1` in both modes; never reachable from LAN |
| 19082 | MCP server — built-in tool endpoint (web_fetch, web_search, Postgres, Documents, SQLite, Vault, Git, File System, Scholar). Bound to `127.0.0.1` unless network mode is on |
| 8765 | Beacon — Redstart Nest identity broadcast, always bound to `0.0.0.0` for LAN discovery |

**Network mode is a bind, not a firewall rule.** With it off, the gateway and the MCP server listen on `127.0.0.1` only — a device on the LAN gets connection-refused, not a login screen, and that holds regardless of what the host's firewall is or isn't doing. Turning it on binds both to `0.0.0.0` and adds the Windows Firewall inbound rules (plus UDP 5353 for mDNS, and TCP 80 when the clean-URL proxy starts). Rules go in via the bundled `elevate.exe`, so UAC prompts at most once per rule and never again; in an unpackaged dev checkout `elevate.exe` is absent and rule creation is skipped with a warning. Rules are not removed when you turn network mode back off — deleting one needs elevation again, and a leftover rule is inert once nothing is listening on the wildcard.

Port 19081 is localhost-only in both modes, enforced at the socket *and* at the launch arguments (`--host` is hardwired and stripped from the advanced-args field). The gateway and its two internal services shift together if you change the configured port — llama-server is always `configured-port + 1`, and the MCP server is always `configured-port + 2`. `scripts/test-network-binding.mjs` proves the boundary by binding each server and attempting a real TCP connection from this host's own LAN address.

**The beacon is deliberately always on `0.0.0.0`.** It starts at app launch, before network mode is known, and its payload is minimal by design — `{ app, running, port }`, nothing about version, auth state, or configuration. Being discoverable is the whole function of a discovery service, and discovery answers "where might a Redstart server be?", never "this server is trustworthy". A discovered server still has to authenticate you.
