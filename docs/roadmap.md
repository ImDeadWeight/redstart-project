# Roadmap & Known Limitations

*[← back to the README](../README.md) · [docs index](README.md)*

This is an honest work-in-progress. The project started as a personal home tool and is evolving toward a private AI solution for small organizations. The roadmap reflects that shift in priority.

---

## Known limitations

- **Unsigned installers** — both installers will trigger Windows Defender SmartScreen. This is expected for unsigned binaries distributed outside the Microsoft Store. A code signing certificate would resolve this.
- **Twig for Android is currently out of date and not working** — the Android client has not been rebuilt against recent server and client changes, and the published APK should not be relied on. This is paused rather than abandoned: bringing it back into line is planned work, but it is not in progress right now. The practical substitute is a phone browser pointed at the chat UI (`http://<nest-ip>:19080`, or the QR code in **Configuration → Network**), which needs no app installed. Redstart Twig for Windows is unaffected.
- **Android sideload required** — the app is not on the Play Store. Installation requires enabling "unknown sources."
- **Accounts are on by default** — Redstart Nest supports a three-tier account model (Owner → Admin → User), session tokens, and `rst_` API keys behind a global "Require login" toggle, with a login gate, an account/profile menu, and self-service key regeneration (see [Accounts & login](security.md#accounts--login)). The account/role logic has an automated HTTP-level test suite and remote-browser login has been verified. With login on (the default), every client on the LAN must authenticate. Do not expose the gateway port to the public internet.
- **Single profile active at a time** — Redstart Nest manages one running model at a time, and the active profile is global server state that applies to every account.
- **Windows is the only supported server platform** — and the qualifier matters more than it used to. The *daemon* no longer needs Electron (`bin/nestd.mjs` boots it under plain Node), binary resolution and the paths seam are both cross-platform, and `deploy/` carries a systemd unit. What is still Windows-only: the packaged desktop installer, the bundled llama.cpp binary, and the port-80 clean-URL proxy. So a Linux appliance is *reachable* rather than *supported* — none of the deployment artifacts has been run on real hardware, and they say so at the top of `deploy/README.md`.
- **Tokens/min display is unreliable** — the tok/min counter shown in the Redstart Nest header is a known bug. The number it displays is not accurate. This is a known issue and will be fixed in a future update.
- **mDNS discovery (`redstart.local`) has been retired** — Android's resolver never answered `.local` lookups for browser navigation, so the name failed on the one platform most clients are, and mDNS is multicast, which also dies against Wi-Fi client isolation and IGMP snooping on the platforms where it did work. The direct IP (and its QR code) is the universal route, and Redstart Twig's beacon scan never depended on the name either. Anyone who wants a memorable name sets one up their own way — a hosts file, a router DNS entry, or the `sslip.io` URL the Network panel offers.
- **Shared capabilities are all-or-nothing** — Vault, Git, SQLite and Postgres are shared across every account by design, but there is no way to grant one account access and withhold it from another. "This analyst gets the databases folder but not the repositories" is not expressible today; a capability is either active for a profile or not. Per-account grants over shared folders are the next planned piece of work.
- **Plugin installs need an ambient runtime on the host** — installing from npm needs Node/npm on the machine's `PATH`; installing from pypi needs [`uv`](https://docs.astral.sh/uv/). Neither ships bundled with Redstart Nest. A missing runtime is reported by name rather than a generic failure, but the admin still has to install it first. A local-path or raw-command install sidesteps this entirely — see [Plugins](capabilities.md#plugins).
- **No migration for pre-existing files** — when per-account storage arrived, files already sitting in a configured capability root stayed on disk but stopped being served to anyone. Making them reachable means moving them into an account's folder by hand; there is no tooling for it.
- **Twig's local MCP servers are unmoderated** — Redstart Twig can run local stdio MCP servers from a file on the user's own machine. That is arbitrary command execution by design (the trust boundary is the local disk), and nothing on the server side governs what those servers expose. Tool bans can strip their tools by name from requests, but the server never sees them registered.
- **The chat UI is served from a built bundle** — Nest and Twig both serve `redstart-nest/src/chat-ui/dist`. Editing chat-ui source without running `npm run build:chat` leaves the running app on the old bundle, and nothing warns you. For UI work, `npm --prefix src/chat-ui run dev:redstart` is the faster loop.

[Security](security.md#known-gaps) carries the security-specific gaps, including the containment race and the DNS-resolution limit in the SSRF guard.

---

## Working now

- [x] Start/stop llama.cpp model from a GUI
- [x] LAN network mode with automatic port binding
- [x] Beacon-based zero-configuration device discovery
- [x] Android app with automatic LAN scan on launch — *built, but the Android client is currently out of date and not working; see [Known limitations](#known-limitations)*
- [x] QR code in the Network panel — encodes the direct-IP chat URL, so any phone camera opens the chat UI with no name resolution and no app install
- [x] Windows desktop client (Redstart Twig)
- [x] Shared SvelteKit chat UI across all clients
- [x] Server log displayed in Redstart Nest UI (piped mode)
- [x] OpenAI-compatible API for use with coding agents (Kilo Code, Continue, etc.)
- [x] Direct browser access to chat UI at `http://127.0.0.1:19080`
- [x] Built-in MCP server — provider-driven, in-process or supervised stdio children, whitelist enforced at the server level
- [x] Centralized MCP management — configured once in Nest, auto-discovered by every client; per-device config removed
- [x] Source groups, custom sources, and external MCP servers on other devices
- [x] Seven local capabilities — Postgres, SQLite, Vault, Git, Documents, File System, Scholar
- [x] MCP plugin system — install a third-party stdio MCP server (npm, pypi via `uv`, local path, or a raw command) and its tools appear namespaced alongside the built-ins, under the same fail-closed classification and per-plugin write/destructive policy every capability already uses; bulk-classify and an official-registry browser make the install/review workflow practical on a plugin with dozens of tools
- [x] `web_search` over first-party APIs — no third-party search engine involved
- [x] Three-tier accounts with login gate — Owner/Admin/User, session tokens, `rst_` API keys; on by default, localhost bypass removed
- [x] Per-account file storage — structurally enforced across the MCP tools, download endpoint and file explorer alike
- [x] File explorer — Profile → Files: navigate, preview, download, rename, drag-to-move, upload
- [x] Recoverable deletion — the one destructive-class tool, off by default, deletes to the recycle bin, and always prompts
- [x] Tool bans + a tested namespacing contract, enforced at both the completions proxy and the MCP server
- [x] Server-composed system prompt — capability claims substantiated, privacy claims derived from live config, admin policy above client prose
- [x] Security hardening — minimal beacon payload, SSRF guard, hop-by-hop redirect validation, shared path containment
- [x] LAN exposure as a socket boundary — network mode binds the gateway and MCP server rather than relying on firewall rules
- [x] Dark-only UI — the light and system themes are gone; see the changelog for why they were broken
- [x] **A control plane that outlives the window** — the admin listener (`:19083`) binds when the daemon starts and stays up whether or not a model is running. Closing the launcher window no longer stops anything; the tray keeps it alive and there is one deliberate **Shut down** action
- [x] **Browser-based administration** — the launcher UI is served by the control plane and reachable from another device, owner-only, over a session the chat UI cannot mint. Exposure is a bind address (default loopback), not a boolean
- [x] **Headless daemon** — `bin/nestd.mjs` boots the whole server under plain Node with no Electron, behind seams for paths and secrets; `npm run daemon` / `daemon:stop` / `daemon:status`
- [x] **Per-box setup code** — a printed-on-the-chassis recovery credential is the only door onto owner creation *and* owner reset, replacing the anonymous first-admin path that was safe only while IPC was its sole caller
- [x] **Config and user content are separate subtrees**, refused at startup if they overlap, so a config reset cannot wander into someone's documents and a backup can treat the two as different questions

---

## Phase 2 — Small Office Ready

Making Redstart usable in a small workplace rather than just on one person's home network.

- [x] Per-user conversation history — conversations are stored server-side in `conversations.json`, scoped to the logged-in account (or device ID when auth is off), and sync across all devices on the network; unused conversations auto-delete after 30 days
- [x] ~~mDNS discovery~~ — shipped, then retired: a convenience layer only, and Android could never resolve `.local` at all; see [Known limitations](#known-limitations)
- [x] Universal browser access — the Configuration tab offers the direct IP (as a QR code) and an `sslip.io` DNS name, so every client has at least one address that works
- [ ] **Folder access grants** — per-account access to the shared "company" folders (Vault, Git, SQLite), so an admin can give a data analyst the databases folder without also handing over the code repositories. Personal `user_files` stay private; admins reach everything by role. Read-only by default, since two accounts writing one folder re-creates exactly what per-account storage removed. Must surface in both the file explorer and the system prompt — a granted folder the model cannot enumerate is, from the model's side, indistinguishable from one it was never given
- [ ] Guided onboarding & in-app instruction — first-run walkthrough (create the Owner account, pick a model, launch), contextual help on the tools/capabilities panels, and plain-language explanations aimed at non-technical staff in a small office
- [x] Admin interface accessible from any device on the network — **shipped.** The control plane serves the launcher UI over HTTP on `:19083`, owner-only and authenticated independently of the chat UI. Off-machine access is opt-in per bind address; see [The control plane](security.md#the-control-plane)
- [ ] Auto-restart on crash — if the model dies at 9am Monday, it recovers without manual intervention
- [ ] Signed installers — removes the Windows Defender SmartScreen warning, looks professional in a workplace setting
- [ ] macOS support — many non-profits and small agencies run Macs

---

## Phase 3 — The Redstart Box (Office Appliance)

The long-term goal: a purpose-built machine that sits in the office and runs the model headlessly. No monitor, no babysitting — staff connect to it the way they'd connect to a printer, from any device on the network.

- [x] Headless / service mode — **shipped.** `bin/nestd.mjs` runs the daemon under plain Node with no Electron and no window. `deploy/` carries a systemd unit, the Windows SCM procedure, and a Caddyfile that terminates TLS in front of it — **none of which has been run on real hardware yet**, and they say so
- [x] Web-based admin UI — **shipped**, as the same React launcher served over the control plane rather than a second UI written twice
- [~] Linux support — the daemon, the paths seam, the secret store and binary resolution are all cross-platform now; what is not is the packaged installer, the bundled llama.cpp binary and the port-80 proxy. Reachable, not yet supported
- [x] Auto-start on boot — start-at-login on the desktop, and the service units in `deploy/` for a box nobody logs into
- [ ] Document querying (RAG) — staff can upload policy manuals, templates, and reference documents and query against them
- [ ] iOS client (Redstart Twig for iPhone)
- [ ] Model library management — browse, download, and switch models from any client device

---

## Honest shortcoming

The reliability bar for a small business is materially higher than for a personal home project. If this is running in a social work office and the server crashes mid-day, staff need it to recover on its own — not wait for someone technical to fix it. That kind of robustness requires systems and operations experience that is currently a gap in this project. It is acknowledged here openly rather than papered over. Contributions from developers with reliability or infrastructure background are particularly welcome.
