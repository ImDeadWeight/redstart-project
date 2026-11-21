# Configuration

*[← back to the README](../README.md) · [docs index](README.md)*

Where Redstart Nest keeps its state, and what each file holds.

---

## Two directories, never one

Redstart keeps its own state and your content in **separate subtrees**, and refuses
to start if they overlap:

| Directory | Holds | Desktop (Windows) | Headless daemon |
|---|---|---|---|
| **config** | Nest's own state — accounts, roles, tools, plugins, profiles, settings, logs, the secret key | `%APPDATA%\redstart\` | `<nest dir>/config` |
| **capability base** | User content for the five folder-scoped capabilities (Documents, SQLite, Vault, Git, File System) | `Documents\Redstart\` | `<nest dir>/data` |

The split is not tidiness. A last-resort reset — stop the daemon, delete
`accounts.json`, re-bootstrap — operates on the config tree, and it must never be
able to wander into someone's documents. A backup also has to be able to treat
"my settings" (small, always wanted) and "my files" (potentially enormous,
optional) as different questions. `platform-paths.mjs` rejects an overlapping pair
at startup rather than letting it collapse quietly later.

For the headless daemon, `<nest dir>` is `--dir`, else `$REDSTART_DIR`, else
`~/.redstart`. Nothing is guessed per-platform: a service install passes the
directory it wants explicitly.

---

## Files in the config directory

| File | Holds |
|---|---|
| `profiles.json` | Per profile: model path, context/batch/threads, GPU layers, port, network mode, and web source config. Also the per-profile `tools` block — whether tools are on, the whitelist and active sources/groups, the general web search engine (`webSearchEngine`: `none`, `searxng` or `brave`), activated capabilities (`activeToolIds`) and banned tools (`disabledToolIds`). |
| `tools.json` | User-defined tools, groups, external MCP servers, and global capability config (schema below). |
| `accounts.json` | Accounts, when login is enabled. Passwords and API keys are stored only as hashes. Each account carries a `tier` (`owner`/`admin`/`user`) and a `roleId` (`null` = Full Access). |
| `roles.json` | Admin-defined capability roles, including any folder grants that narrow a shared capability (Vault, Git, SQLite, Shared Documents) to some of its folders. Built-in roles live in code and are merged in at read time, so this file holds only the ones you create. Absent until you create one. |
| `conversations.json` | Server-side conversation history, scoped per account. |
| `projects.json` | Projects: their names, instructions and which chats belong to them, per account. |
| `memories.json` | Saved memories (facts, guidance, state), keyed by account. |
| `memory-review.json` | The automatic memory review's own bookkeeping: which chats it has reviewed and the suggestions waiting for an answer. Kept apart from `memories.json` because that file is the user's data. |
| `approvals.json` | Standing "Always allow" grants, per account and tool. Deletion is never granted this way. |
| `skills/` | Workflows, stored as Agent Skill folders (`SKILL.md` plus any files): `skills/personal/<account>/` and `skills/org/`. Migrated once from the old `workflows.json`, which is left in place. |
| `tasks/` | One folder per background task or server-run chat: `task.json` (its state) and `events.jsonl` (everything it did, in order), so a run survives a restart. |
| `document-index.sqlite` | The document search index: extracted text and embedding vectors for every account's files, each passage stored under its account. Rebuildable from *Profile → Files → Rebuild search index*. |
| `runtimes/` | Downloaded runtimes: `pyodide-<version>/` for `run_python`, checked file by file against pinned hashes, and `sd-<release>-<build>/` for `generate_image` (stable-diffusion.cpp, each release zip checked against a pinned SHA-256 before it is unpacked). |
| `gpu-lease.json` | Present only while an image is being made (the chat model is paused). Left behind by a crash, it makes the next start reload the model that was paused. |
| `image-jobs/` | One folder per image job while it runs; the pictures are moved into the chat's workspace and the folder removed. |
| `redstart.log`, `policy.jsonl` | The daemon's log, and the policy decision log (approvals, refusals, deletions) the launcher's Activity page reads. |
| `sessions.json` | Live login sessions, stored as SHA-256 hashes of the token — the file cannot be replayed as a credential. Written on sign-in, sign-out and revocation; sliding-expiry updates are batched rather than written per request. |
| `bootstrap-token.txt` | The setup code for this machine, in plain text. Generated once, on first run. It is the only thing that can create or reset the Owner account over the network — see [Security → The control plane](security.md#the-control-plane). Anyone who can read this directory can read it, which is the same access that could rewrite `accounts.json` directly. |
| `settings.json` | Launcher-level settings that are not per profile: the llama-server binary override, the models folder, `adminBindHost` (where the control plane listens, default `127.0.0.1`), `startAtLogin`, `autoUpdate` (desktop only, Windows and macOS, set from Overview → Updates; absent means on, `false` stops the automatic checks but not *Check now*, read before every check so no restart is needed), `discovery` (the network settings of the last launch, so the app can announce itself at start-up before anything is running), and `tls` (HTTPS on the LAN, below). |
| `plugins.json` | Installed MCP plugins — the registry snapshot taken at install-review time, each tool's permission class, and the per-plugin enable switch. |
| `prompt-blocks.json` | Admin-authored system-prompt blocks. Absent until you edit one. |
| `secret.key` | The daemon-owned AES-256-GCM key, **headless deployments only**. The desktop build writes no such file. Whoever can read this file can read every stored credential. |
| `secrets-key.json` | **Windows desktop only.** The key that encrypts stored credentials, **wrapped with DPAPI** for your Windows account, so this file is useless on another account or machine. The first time the daemon split ran on an existing install, it was copied from Electron's `Local State`, so existing secrets read back unchanged. The desktop shell unwraps it and hands it to the daemon at startup. Do not delete it: without it (and without `Local State`), stored secrets cannot be decrypted and must be re-entered. On macOS there is no such file: the key comes from the `redstart Safe Storage` item in your login Keychain. |
| `shell/` | **Desktop only.** The desktop shell's own files: `redstart.log` (its log, apart from the daemon's), `shell-state.json` (whether the close-window notice has been shown) and `update/` (a downloaded, signature-checked update waiting for a deliberate quit). |
| `nestd.pid` | The running daemon's own pid, so `npm run daemon:stop` and a service manager can find it without probing a port. Written *after* the control plane binds, so a second daemon that loses the port race cannot overwrite a live entry. |
| `caddy/` | **HTTPS on (`tls.mode: "own"`) only.** `caddy.json` is the bundled Caddy's generated configuration: no secrets in it, since the DNS token reaches Caddy by environment. `storage/` holds the certificate and its private key, plus the ACME account key. **Leave `caddy/` out of any backup or copy.** Everything in it regenerates: a restored install gets a new certificate by DNS-01 in about a minute, so the private key never has to leave the machine. |
| `caddy.pid` | The bundled Caddy's pid, for the same reaping as `llama-server.pid`. |
| `llama-server.pid` | The pid of the model process Nest launched, so a hard-killed Nest can reap exactly its own child at the next start — never by image name. |

Conversations are stored per account (per device ID when login is off) and auto-delete after 30 days of inactivity.

### `tls` in `settings.json`

HTTPS for LAN clients through the bundled Caddy. It is set from the launcher (Network & access → Secure address) or the control plane's `tls:set`, never by hand: the token has to be encrypted by Nest.

```json
"tls": {
  "mode": "own",
  "own": { "provider": "duckdns", "name": "myhouse.duckdns.org", "tokenEnc": "…" },
  "requireHttps": false,
  "acmeStaging": false
}
```

| Key | Meaning |
|---|---|
| `mode` | `off` (the default): LAN clients use plain HTTP, as before. `redstart` (Automatic): a name `<id>.nest.redstartdevelopment.com` from Redstart's name service. `own`: your own DuckDNS or deSEC name. In both HTTPS modes Caddy serves `https://<name>` and the gateway and MCP server go back to loopback. |
| `redstart` | Automatic's registration: `{ id, credentialEnc, registeredAt }`. Written by Nest the first time HTTPS starts with network mode on, never when the choice is made. The credential is encrypted and never returned to a client; the name is derived from `id`. Removed (and the name given back) when HTTPS is turned off, or once a replacement own name is serving. |
| `consentAsked` | The one-time "secure address?" question has been answered. Set by any choice, including *Not now*. |
| `own.provider` | `duckdns` or `desec`, the service that holds your name and proves it to Let's Encrypt (DNS-01). |
| `own.name` | Your name at that provider (`yourname.duckdns.org`, `yourname.dedyn.io`). Nest points it at this computer's LAN address and keeps it there. Only private addresses are ever published. |
| `own.tokenEnc` | The provider's token, encrypted. Never returned to a client. Changing the provider drops it. |
| `requireHttps` | `false`: while HTTPS isn't working yet, LAN clients still get the chat UI over plain HTTP, labelled. `true`: they get a page saying HTTPS isn't working, and nothing in the clear. |
| `acmeStaging` | Use Let's Encrypt's staging CA, for testing. Browsers will not trust its certificates. |

While HTTPS is on (`mode` is `redstart` or `own`), ports 80, 443 and 8443 belong to Caddy, so a profile port that would land the gateway, llama-server or the MCP server on any of them is refused.

---

## What a profile is

A **profile** bundles three things that are convenient to switch together but are not the same kind of thing:

1. **Model configuration** — model path, context/batch/threads, GPU layers, KV-cache preset, port, and vision (below).
2. **Deployment configuration** — network mode.
3. **Security policy** — which capabilities are active, which web sources are approved, and which tools are banned.

**Vision.** A vision model in GGUF form comes with a projector file (`mmproj-*.gguf`), which llama-server loads with `--mmproj`. Only then can it read images. A model downloaded from Model → Hugging Face brings its repo's projector with it: saved as `<owner>_<repo>.<file>` (every repo calls its own `mmproj-F16.gguf`), and paired with the model in `projectors.json` in the models folder, which the model listing and the launch both read. Two optional profile fields override that: `mmprojPath` (a projector to use instead, for a model from elsewhere) and `vision: false` (launch without one). A missing projector file is logged and skipped, never passed. The server log says which projector a launch got, and the admin status (`admin:get-status`) reports it as `vision`.

Two consequences worth being explicit about:

- **A profile is global server state.** One profile is active at a time, and it applies to every account the server serves. A tool ban applies to everyone. Narrowing it per account is the job of [roles](security.md#roles): a role can withhold capabilities from an account and narrow a shared folder to some of its subfolders, but it can only take away from what the profile enables, never add to it.
- **Profile changes take effect without a restart for tool policy** — capability config changes are pushed to the running gateway and MCP server — but **network mode is read at server start**, so changing it requires stopping and starting the server.

---

## `tools.json` schema

```json
{
  "tools": [ { "id": "...", "name": "...", "baseUrl": "...", "description": "..." } ],
  "groups": [ { "id": "...", "name": "...", "description": "...", "toolIds": ["..."] } ],
  "externalServers": [ { "id": "...", "name": "...", "url": "...", "enabled": true, "apiKeyEnc": null } ],
  "capabilities": {
    "postgres":    { "enabled": false, "connectionStringEnc": "...", "maxRows": 200 },
    "documents":   { "enabled": false, "outputDir": "..." },
    "sqlite":      { "enabled": false, "rootDir": "...", "maxRows": 200, "maxFileBytes": 209715200 },
    "vault":       { "enabled": false, "rootDir": "..." },
    "git":         { "enabled": false, "rootDir": "..." },
    "file_system": { "enabled": false, "rootDir": "...", "allowWrite": true, "allowDestructive": false },
    "scholar":     { "enabled": false, "venueFilter": null },
    "python":      { "enabled": false, "maxKernels": 2, "timeoutS": 30, "workspaceCapMb": 200, "accountCapMb": 2048 },
    "memory":      { "enabled": false, "promptBudgetChars": 1200 },
    "document_search": { "enabled": false, "sharedRootDir": null },
    "web_search":  { "searxngUrl": null, "braveApiKeyEnc": null }
  },
  "deferral": { "git": false }
}
```

`deferral` overrides which capabilities are catalog-only: a deferred capability's tools are left out of the model's tool list and reached through `search_tools` and `call_tool` instead. It is keyed by capability or plugin id; an absent id takes the default, which is deferred for File System, Git, SQLite, Postgres, Vault, Scholar and every plugin. It takes effect only when the profile's `tools.retrieval.mode` is `catalog`. Set it in the Tools page (Catalog-only tools).

`memory.promptBudgetChars` is how much of each request the newest memories may take (1200 characters ≈ 300 tokens). The memories themselves are in `memories.json` beside `conversations.json`, keyed by account. `python` holds run_python's limits: warm kernels (each ≈ 457 MB of RAM), the default wall-clock timeout (a call can ask for up to 120 s), and the per-conversation and per-account workspace caps. Its runtime lives in `<config>/runtimes/pyodide-<version>/` and is checked file by file against hashes pinned in `daemon/python-runtime.mjs`; nothing in `tools.json` records whether it is installed. `allowDestructive` is the switch that permits `delete_file` — off by default, meaning the tool is neither advertised nor executable. `web_search` is not a capability: it says where each general web search engine lives (a SearXNG base URL, a Brave Search API key). Which engine a profile uses, if any, is that profile's `tools.webSearchEngine` (`none` when absent). See [the general web search engine](security.md#the-general-web-search-engine-opt-in). `image_generation` holds `model` (a file name in `<models>/image/`, null until one is chosen), `backend` (`auto`, `cuda`, `vulkan` or `metal`) and `timeoutS` (30 to 280; the chat UI gives a tool 300 s). Image models live in `<models>/image/` as `<owner>_<repo>.<file>`, listed in `image-models.json` there with the repo, the pinned revision and the family; a family's shared files (FLUX's text encoders and VAE) sit beside them, pinned by hash in `daemon/image-models.mjs`. `document_search.sharedRootDir` is the optional Shared Documents folder: `search_documents` and the file explorer also read it, read-only, as far as a role's grants allow. The Postgres connection string, the Brave key and any external server's API key (`apiKeyEnc`) are the secrets in the file. They are encrypted through whichever provider the entrypoint wired up: on the desktop, the key the shell unwraps (DPAPI on Windows, the Keychain on macOS) in the same format Electron's `safeStorage` wrote; on a headless box, an AES-256-GCM key file. Stored values are tagged `v1.<provider>.<payload>` so a file records what wrote it, and a re-key driver re-encrypts an existing tree when the provider changes. Encryption being unavailable is a refusal to store, never a silent fallback to plaintext. Profiles are managed (save, load, delete) in the Redstart Nest UI.

---

## Upgrading from Beaver

On first launch Redstart Nest migrates `profiles.json` / `accounts.json` / `tools.json` from `%APPDATA%\beaver\` (one-time, idempotent, never overwriting files already in the new location). Keys created under the old build keep their `bvr_` prefix and keep working.
