# Tools & Capabilities

*[← back to the README](../README.md) · [docs index](README.md)*

What the model can reach, how sources are grouped, and how it is all configured. The enforcement side of this — whitelisting, SSRF, tool bans, destructive operations — lives in [Security](security.md).

---

## Overview

Redstart Nest includes a built-in [Model Context Protocol](https://spec.modelcontextprotocol.io/) (MCP) server that gives the model access to live web content from approved sources — Wikipedia, GitHub, AP News, legal references, arXiv, PubMed, and others — plus local capabilities for file system access, read-only SQL (Postgres and SQLite), document generation, Obsidian-style vault search, git repository context, and academic literature search. All capabilities are off by default and configured per profile.

Writes are per-account: each account gets its own storage inside the configured folders, and can neither see nor reach another's. Reads of shared reference material (notes, repositories, databases) are shared by design. Deletion is off by default, and recoverable when enabled.

The server-side architecture — the provider model, the stdio child process, centralized MCP management — is described in [Architecture](architecture.md#the-mcp-server-is-provider-driven).

---

## Local capabilities

Seven local capabilities ship with the built-in MCP server. All are local I/O with no network egress except Scholar, which queries open academic indexes.

| Capability | Access | Notes |
|---|---|---|
| **Postgres** | Read-only SQL | Every query runs inside `BEGIN TRANSACTION READ ONLY`, so the database itself rejects writes and DDL — not string-sniffing. Use a read-only role too. |
| **SQLite** | Read-only SQL | Same enforcement, against `.db` files in a configured folder. Verifies the SQLite file header rather than trusting the extension. |
| **Vault** | Read-only | Search, read and tag-browse a folder of markdown notes (Obsidian or otherwise). |
| **Git** | Read-only | `git_status`, `git_log`, `git_diff` over local repositories in a configured folder. |
| **Documents** | Read + create | Creates `.docx`/`.pdf`/`.md` from markdown; pipe tables render as real Word/PDF tables with repeating headers. Reads `.pdf`/`.docx`/`.txt`/`.md`/`.xlsx`/`.csv`. Filenames are derived server-side — a model-supplied path is never honored. Created files appear in chat as an authenticated download. |
| **File System** | Read/write | Served by the official [`@modelcontextprotocol/server-filesystem`](https://github.com/modelcontextprotocol/servers) as a stdio child, using ecosystem-standard tool names (`read_text_file`, `write_file`, `edit_file`, …) that local models call far more reliably than a bespoke schema. Every path argument is independently re-validated through Redstart's symlink-aware `resolveWithinRoot()` before reaching the child, so containment survives an upstream regression. |
| **Scholar** | Read-only, outbound | OpenAlex, arXiv and PubMed search; open-access PDFs save into Documents. Optional venue whitelist. The one capability that makes outbound requests. |

The upstream filesystem server ships no delete tool, so `delete_file` is Redstart-owned and is the system's only **destructive-class** tool — off by default, refused at both `tools/list` and `tools/call`. See [Destructive operations](security.md#destructive-operations).

Each capability is configured once globally, then activated per profile — both halves are required. An account's [role](security.md#roles) can then withhold any of them from that account specifically; a role only ever narrows what the profile has already enabled.

Files the model and users create live under the configured capability roots, one folder per account — see [Per-account file storage](security.md#per-account-file-storage).

---

## Source groups

Tools are organized into **source groups** — named collections of web sources that can be activated together. The built-in groups are:

| Group | Sources |
|---|---|
| General Knowledge | Wikipedia, AP News |
| Developer | GitHub, MDN Web Docs, Stack Overflow |
| News | AP News, BBC, Reuters |
| Legal (US) | Cornell LII, Congress.gov, Wikipedia |
| Research | arXiv, PubMed, Wikipedia |

`web_search` is available alongside `web_fetch` for sources that expose a first-party search API (Wikipedia OpenSearch, arXiv, PubMed, MDN, Stack Exchange). No third-party search engine is ever involved — the query goes only to the site being searched.

These are proof-of-concept defaults — organizations define their own from sources they trust. Custom groups can be created in the UI and exported to other Redstart installations, and combine freely: their tool lists merge when several are active.

---

## External MCP servers

Redstart Nest can also treat an MCP SSE endpoint on **another device** (e.g. `http://10.0.0.5:9000/sse`) as an additional tool source — useful for a dedicated MCP appliance with different network policies, one shared tool server across several Nest installations, or a specialized set like a legal practice's document management system.

Clients fetch the full list from Redstart Nest directly, so every device on the LAN discovers built-in and external tools alike.

An external server is a distinct trust boundary — read [External MCP servers](security.md#external-mcp-servers) before registering one.

**Why no hosted "tool" MCP servers?** Third-party services that package docs or code search behind a hosted MCP endpoint were considered and passed over. They are proprietary indexes with no self-hosted option, so a "built-in" tool would phone out on every use — a different risk category from the whitelisted web sources, which are an explicit, admin-controlled exception. That conflicts with the premise this project is built on, so it stays off the table unless a local alternative appears.

---

## Configuring in Redstart Nest

The **Tools** card in the main configuration panel has four sections: **Web Sources** (source groups, individual sources, custom sources, and the per-fetch token budget — default 2000), **Local Capabilities**, **Banned Tools** (see [Tool bans](security.md#tool-bans)), and **External MCP Servers**.

Capabilities are configured with a native folder picker, except Postgres, which takes a connection string — encrypted at rest via the OS secret store (DPAPI on Windows) and never re-displayed. File System carries two policy toggles: **Allow writes** (on) and **Allow destructive operations** (off).

A capability produces tools only when it is configured and enabled globally **and** activated for the running profile. Selecting one for a profile without configuring it is flagged inline, since that combination otherwise yields no tools and no error. All settings save with the active profile.

Tool and capability configuration lives in `tools.json`; built-in sources, groups and capabilities are hardcoded and can be toggled off per profile but not deleted. See [Configuration](configuration.md) for the files and schema.

---

## Performance

Each tool call adds 2–5 seconds of latency. The model's response appears after all fetches complete. Context sizes below 8192 tokens are flagged with a warning since fetched content competes with conversation history. Redstart Nest shows a red warning below 4096 tokens where tool use is likely to break the context entirely.

Every active tool's JSON schema rides along in the prompt of every completion request, so the tool set is a per-request standing cost. The Tools UI surfaces an estimate of that cost, which is why "turn everything on" is a bad default.
