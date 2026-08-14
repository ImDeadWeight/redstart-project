# Configuration

*[← back to the README](../README.md) · [docs index](README.md)*

Where Redstart Nest keeps its state, and what each file holds.

---

## Files

Everything lives in `C:\Users\<you>\AppData\Roaming\redstart\`:

| File | Holds |
|---|---|
| `profiles.json` | Per profile: model path, context/batch/threads, GPU layers, port, network mode, and web source config. Also the per-profile `tools` block — whether tools are on, the whitelist and active sources/groups, activated capabilities (`activeToolIds`) and banned tools (`disabledToolIds`). |
| `tools.json` | User-defined tools, groups, external MCP servers, and global capability config (schema below). |
| `accounts.json` | Accounts, when login is enabled. Passwords and API keys are stored only as hashes. Each account carries a `tier` (`owner`/`admin`/`user`) and a `roleId` (`null` = Full Access). |
| `roles.json` | Admin-defined capability roles. Built-in roles live in code and are merged in at read time, so this file holds only the ones you create. Absent until you create one. |
| `conversations.json` | Server-side conversation history, scoped per account. |

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

`allowDestructive` is the switch that permits `delete_file` — off by default, meaning the tool is neither advertised nor executable. The Postgres connection string is the one secret in the file, encrypted with Electron's `safeStorage`. Profiles are managed (save, load, delete) in the Redstart Nest UI.

---

## Upgrading from Beaver

On first launch Redstart Nest migrates `profiles.json` / `accounts.json` / `tools.json` from `%APPDATA%\beaver\` (one-time, idempotent, never overwriting files already in the new location). Keys created under the old build keep their `bvr_` prefix and keep working.
