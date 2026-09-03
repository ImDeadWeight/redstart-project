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
| `profiles.json` | Per profile: model path, context/batch/threads, GPU layers, port, network mode, and web source config. Also the per-profile `tools` block — whether tools are on, the whitelist and active sources/groups, activated capabilities (`activeToolIds`) and banned tools (`disabledToolIds`). |
| `tools.json` | User-defined tools, groups, external MCP servers, and global capability config (schema below). |
| `accounts.json` | Accounts, when login is enabled. Passwords and API keys are stored only as hashes. Each account carries a `tier` (`owner`/`admin`/`user`) and a `roleId` (`null` = Full Access). |
| `roles.json` | Admin-defined capability roles. Built-in roles live in code and are merged in at read time, so this file holds only the ones you create. Absent until you create one. |
| `conversations.json` | Server-side conversation history, scoped per account. |
| `sessions.json` | Live login sessions, stored as SHA-256 hashes of the token — the file cannot be replayed as a credential. Written on sign-in, sign-out and revocation; sliding-expiry updates are batched rather than written per request. |
| `bootstrap-token.txt` | The setup code for this machine, in plain text. Generated once, on first run. It is the only thing that can create or reset the Owner account over the network — see [Security → The control plane](security.md#the-control-plane). Anyone who can read this directory can read it, which is the same access that could rewrite `accounts.json` directly. |
| `settings.json` | Launcher-level settings that are not per profile: the llama-server binary override, the models folder, `adminBindHost` (where the control plane listens, default `127.0.0.1`), `startAtLogin`, and `discovery` (the network settings of the last launch, so the app can announce itself at start-up before anything is running). |
| `mcp.json` | External MCP servers, with any API key stored as ciphertext (`apiKeyEnc`) and never returned to a client in plaintext. |
| `plugins.json` | Installed MCP plugins — the registry snapshot taken at install-review time, each tool's permission class, and the per-plugin enable switch. |
| `prompt-blocks.json` | Admin-authored system-prompt blocks. Absent until you edit one. |
| `secret.key` | The daemon-owned AES-256-GCM key, **headless deployments only**. The desktop build encrypts through Electron's `safeStorage` (DPAPI) and writes no key file. Whoever can read this file can read every stored credential. |
| `nestd.pid` | The running daemon's own pid, so `npm run daemon:stop` and a service manager can find it without probing a port. Written *after* the control plane binds, so a second daemon that loses the port race cannot overwrite a live entry. |
| `llama-server.pid` | The pid of the model process Nest launched, so a hard-killed Nest can reap exactly its own child at the next start — never by image name. |

Conversations are stored per account (per device ID when login is off) and auto-delete after 30 days of inactivity.

---

## What a profile is

A **profile** bundles three things that are convenient to switch together but are not the same kind of thing:

1. **Model configuration** — model path, context/batch/threads, GPU layers, KV-cache preset, port.
2. **Deployment configuration** — network mode.
3. **Security policy** — which capabilities are active, which web sources are approved, and which tools are banned.

Two consequences worth being explicit about:

- **A profile is global server state.** One profile is active at a time, and it applies to every account the server serves. A tool ban is not a per-account setting; per-account grants are [planned work](roadmap.md), not a current capability.
- **Profile changes take effect without a restart for tool policy** — capability config changes are pushed to the running gateway and MCP server — but **network mode is read at server start**, so changing it requires stopping and starting the server.

---

## `tools.json` schema

```json
{
  "tools": [ { "id": "...", "name": "...", "baseUrl": "...", "description": "..." } ],
  "groups": [ { "id": "...", "name": "...", "description": "...", "toolIds": ["..."] } ],
  "externalServers": [ { "id": "...", "name": "...", "url": "...", "enabled": true } ],
  "capabilities": {
    "postgres":    { "enabled": false, "connectionStringEnc": "...", "maxRows": 200 },
    "documents":   { "enabled": false, "outputDir": "..." },
    "sqlite":      { "enabled": false, "rootDir": "...", "maxRows": 200, "maxFileBytes": 209715200 },
    "vault":       { "enabled": false, "rootDir": "..." },
    "git":         { "enabled": false, "rootDir": "..." },
    "file_system": { "enabled": false, "rootDir": "...", "allowWrite": true, "allowDestructive": false },
    "scholar":     { "enabled": false, "venueFilter": null }
  }
}
```

`allowDestructive` is the switch that permits `delete_file` — off by default, meaning the tool is neither advertised nor executable. The Postgres connection string is the one secret in the file, and it is encrypted through whichever provider the entrypoint wired up: Electron's `safeStorage` (DPAPI) on the desktop, an AES-256-GCM key file on a headless box. Stored values are tagged `v1.<provider>.<payload>` so a file records what wrote it, and a re-key driver re-encrypts an existing tree when the provider changes. Encryption being unavailable is a refusal to store, never a silent fallback to plaintext. Profiles are managed (save, load, delete) in the Redstart Nest UI.

---

## Upgrading from Beaver

On first launch Redstart Nest migrates `profiles.json` / `accounts.json` / `tools.json` from `%APPDATA%\beaver\` (one-time, idempotent, never overwriting files already in the new location). Keys created under the old build keep their `bvr_` prefix and keep working.
