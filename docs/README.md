# Redstart documentation

*[← back to the project README](../README.md)*

The [project README](../README.md) covers what Redstart is, how to install it, and what it needs. Everything else lives here.

| Document | What's in it |
|---|---|
| [Mission & Origin](mission.md) | Why the project exists, who it is for, where the name came from |
| [Architecture](architecture.md) | The apps, the gateway/llama-server/MCP topology, the control plane, the provider model, discovery, ports |
| [Security & Trust Boundaries](security.md) | Accounts, roles and grants, the control plane, HTTPS, path containment, approvals, run_python's sandbox, memory, workflows and projects, tool bans, SSRF, plugins, the system prompt, egress, the test suite, known gaps |
| [Tools & Capabilities](capabilities.md) | The ten local capabilities, source groups, external MCP servers, plugins, configuring it all |
| [Configuration](configuration.md) | The two state directories, every file Nest keeps, HTTPS settings, what a profile is, the `tools.json` schema |
| [Development](development.md) | Repo layout, dev loops, tests, building the binary and installers |
| [Models tested](model-testing.md) | Ornith 1.5 9B, Qwen3-4B and Qwen3.6-35B on the agent and memory benches: results, what they changed, how to run them |
| [Roadmap & Known Limitations](roadmap.md) | What works, what doesn't, and what's planned |
| [Deployment](../deploy/README.md) | Running Nest as an appliance: systemd, the Windows SCM, your own TLS proxy. Written from the design, **not yet run on real hardware** |
| [Name service](../infra/name-service/README.md) | The service behind Automatic HTTPS names: what it stores and what trusting it means |

## Contracts

Precise specifications that code and tests are held to:

| Document | Contract |
|---|---|
| [System prompt spec](system-prompt-spec.md) | The block contract, precedence, egress reporting, surface identity and modes. Code across `daemon` and the chat-ui cites its sections as "spec §N" |
| [Connector contract](connector-contract.md) | How a client app authenticates and how its surface is derived |
| [Tool namespacing](tool-namespacing.md) | Prefix rules that keep admin tool bans targetable across apps |

Everything a reader or a contributor needs is on this page. Working notes — plans, audits, backlogs — are deliberately not tracked: they go stale the moment the work lands, and the documents above are the ones held to be current.
