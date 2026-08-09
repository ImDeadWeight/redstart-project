# Redstart documentation

*[← back to the project README](../README.md)*

The [project README](../README.md) covers what Redstart is, how to install it, and what it needs. Everything else lives here.

| Document | What's in it |
|---|---|
| [Mission & Origin](mission.md) | Why the project exists, who it is for, where the name came from |
| [Architecture](architecture.md) | The apps, the gateway/llama-server/MCP topology, the provider model, discovery, ports |
| [Security & Trust Boundaries](security.md) | Accounts, keys and surfaces, path containment, tool bans, destructive operations, SSRF, the system prompt, egress, the test suite |
| [Tools & Capabilities](capabilities.md) | The seven local capabilities, source groups, external MCP servers, configuring it all |
| [Configuration](configuration.md) | State files, what a profile is, `tools.json` schema |
| [Development](development.md) | Repo layout, dev loops, tests, building the binary and installers |
| [Roadmap & Known Limitations](roadmap.md) | What works, what doesn't, and what's planned |

## Contracts

Precise specifications that code and tests are held to:

| Document | Contract |
|---|---|
| [System prompt spec](system-prompt-spec.md) | The block contract, precedence, egress reporting, surface identity and modes. Code across `electron/main` and the chat-ui cites its sections as "spec §N" |
| [Connector contract](connector-contract.md) | How a client app authenticates and how its surface is derived |
| [Tool namespacing](tool-namespacing.md) | Prefix rules that keep admin tool bans targetable across apps |

Everything a reader or a contributor needs is on this page. Working notes — plans, audits, backlogs — are deliberately not tracked: they go stale the moment the work lands, and the documents above are the ones held to be current.
